import { getPool } from '../storage/postgres.js';
import { sysLog, sysWarn, sysError } from './logger.js';
import {
  uploadHostAsset,
  IMAGE_HOST_GUILD_ID,
  IMAGE_HOST_CHANNELS
} from './image-host.js';
import { configCache } from '../storage/config.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Concurrency guard to prevent parallel migration sweeps
let isSweepRunning = false;

// Last execution stats
let lastSweepStats = {
  startedAt: null,
  finishedAt: null,
  totalScanned: 0,
  migrated: 0,
  reused: 0,
  skipped: 0,
  failed: 0,
  errors: []
};

/**
 * Ensure the migrated_assets table exists.
 */
export async function ensureMigratedAssetsTable() {
  const pool = getPool();
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS migrated_assets (
      source_url_clean TEXT PRIMARY KEY,
      source_url_raw TEXT,
      target_url TEXT,
      category VARCHAR(32) NOT NULL,
      status VARCHAR(20) NOT NULL,
      error_reason TEXT,
      migrated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_migrated_assets_status ON migrated_assets(status);
  `).catch(err => {
    sysError('Failed to ensure migrated_assets table', err);
  });
}

/**
 * Normalize a URL for cache keying by stripping query tokens (ex=..., is=..., hm=...).
 *
 * @param {string} url
 * @returns {string}
 */
export function cleanUrlKey(url) {
  if (!url || typeof url !== 'string') return '';
  return url.trim().split('?')[0].toLowerCase();
}

/**
 * Check if a URL is already hosted in the dedicated asset host forum threads.
 *
 * @param {string} url
 * @param {Set<string>} knownHostIds Set of host channel IDs and forum thread IDs
 * @returns {boolean}
 */
export function isAlreadyHostedUrl(url, knownHostIds) {
  if (!url || typeof url !== 'string') return false;

  const trimmed = url.trim();
  // Discord attachment URL pattern: https://cdn.discordapp.com/attachments/<channel_or_thread_id>/<attachment_id>/<filename>
  const match = trimmed.match(/cdn\.discordapp\.com\/attachments\/(\d+)\//i);
  if (match && match[1]) {
    const channelOrThreadId = match[1];
    if (knownHostIds.has(channelOrThreadId)) {
      return true;
    }
  }

  return false;
}

/**
 * Download an image buffer safely with custom headers and timeout.
 *
 * @param {string} url
 * @returns {Promise<{buffer: Buffer, extension: string}>}
 */
async function fetchImageBuffer(url) {
  const cleanUrl = url.trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(cleanUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 DiscordBot/1.0',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
      }
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    const contentType = res.headers.get('content-type') || '';
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (buffer.length === 0) {
      throw new Error('Downloaded image buffer is 0 bytes');
    }

    // Determine extension
    let ext = 'png';
    const rawPath = cleanUrl.split('?')[0];
    const dotExt = rawPath.split('.').pop()?.toLowerCase();
    if (dotExt && ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(dotExt)) {
      ext = dotExt;
    } else if (contentType.includes('jpeg') || contentType.includes('jpg')) {
      ext = 'jpg';
    } else if (contentType.includes('gif')) {
      ext = 'gif';
    } else if (contentType.includes('webp')) {
      ext = 'webp';
    }

    return { buffer, extension: ext };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Process and migrate a single image URL.
 * Handles deduplication, download, re-upload to the host server thread, and database recording.
 *
 * @param {import('discord.js').Client} client
 * @param {'items'|'avatars'|'boxes'|'embeds'} category
 * @param {string} guildId
 * @param {string} sourceUrl
 * @param {string} label
 * @param {Set<string>} knownHostIds
 * @param {Map<string, string>} inMemoryCache
 * @returns {Promise<{status: 'migrated'|'reused'|'skipped'|'failed', newUrl?: string, error?: string}>}
 */
async function processAssetMigration(client, category, guildId, sourceUrl, label, knownHostIds, inMemoryCache) {
  if (!sourceUrl || typeof sourceUrl !== 'string' || !sourceUrl.trim().startsWith('http')) {
    return { status: 'skipped' };
  }

  const rawUrl = sourceUrl.trim();
  const cleanKey = cleanUrlKey(rawUrl);

  // 1. Check if URL is already hosted on the asset host server
  if (isAlreadyHostedUrl(rawUrl, knownHostIds)) {
    return { status: 'skipped', newUrl: rawUrl };
  }

  // 2. Check in-memory session cache (deduplication)
  if (inMemoryCache.has(cleanKey)) {
    const existingTarget = inMemoryCache.get(cleanKey);
    return { status: 'reused', newUrl: existingTarget };
  }

  const pool = getPool();

  // 3. Check persistent migrated_assets table
  if (pool) {
    try {
      const dbCheck = await pool.query(
        'SELECT target_url, status FROM migrated_assets WHERE source_url_clean = $1 LIMIT 1',
        [cleanKey]
      );
      if (dbCheck.rows.length > 0) {
        const row = dbCheck.rows[0];
        if (row.status === 'completed' && row.target_url) {
          inMemoryCache.set(cleanKey, row.target_url);
          return { status: 'reused', newUrl: row.target_url };
        } else if (row.status === 'failed') {
          // Previously failed; return skipped to avoid repeatedly failing on dead URLs
          return { status: 'failed', error: 'Previously recorded as unrecoverable' };
        }
      }
    } catch (checkErr) {
      sysWarn('migrated_assets cache check warning', checkErr);
    }
  }

  // 4. Download source image buffer
  let downloadResult;
  try {
    downloadResult = await fetchImageBuffer(rawUrl);
  } catch (downloadErr) {
    const errMessage = downloadErr.message || 'Download failed';
    sysWarn(`Legacy asset download failed for ${label}`, {
      sourceUrl: rawUrl.slice(0, 100),
      error: errMessage
    });

    if (pool) {
      await pool.query(`
        INSERT INTO migrated_assets (source_url_clean, source_url_raw, category, status, error_reason, migrated_at)
        VALUES ($1, $2, $3, 'failed', $4, NOW())
        ON CONFLICT (source_url_clean) DO UPDATE
        SET status = 'failed', error_reason = EXCLUDED.error_reason, migrated_at = NOW()
      `, [cleanKey, rawUrl, category, errMessage]).catch(() => {});
    }

    return { status: 'failed', error: errMessage };
  }

  // 5. Upload buffer to the server's dedicated forum thread
  let uploadResult;
  try {
    const targetGuild = client.guilds.cache.get(guildId) || { id: guildId, name: `Server ${guildId}` };
    const filename = `${category}_migrated_${Date.now()}.${downloadResult.extension}`;

    uploadResult = await uploadHostAsset(client, category, targetGuild, downloadResult.buffer, {
      filename,
      label: `🔄 **Migrated Asset:** ${label}`
    });

    // Pacing delay (500ms) to respect Discord REST rate limits
    await sleep(500);
  } catch (uploadErr) {
    const errMessage = uploadErr.message || 'Upload failed';
    sysError(`Failed to upload migrated asset to host server for ${label}`, uploadErr, {
      guild: guildId,
      category
    });

    return { status: 'failed', error: errMessage };
  }

  const newUrl = uploadResult.url;
  inMemoryCache.set(cleanKey, newUrl);

  // 6. Record success in migrated_assets table
  if (pool) {
    await pool.query(`
      INSERT INTO migrated_assets (source_url_clean, source_url_raw, target_url, category, status, error_reason, migrated_at)
      VALUES ($1, $2, $3, $4, 'completed', NULL, NOW())
      ON CONFLICT (source_url_clean) DO UPDATE
      SET target_url = EXCLUDED.target_url, status = 'completed', error_reason = NULL, migrated_at = NOW()
    `, [cleanKey, rawUrl, newUrl, category]).catch(dbErr => {
      sysWarn('Failed to persist migrated asset record', dbErr);
    });
  }

  return { status: 'migrated', newUrl };
}

/**
 * Execute the full legacy asset self-healing sweep across all database tables.
 *
 * @param {import('discord.js').Client} client
 * @param {object} [options]
 * @param {boolean} [options.force=false]
 * @returns {Promise<typeof lastSweepStats>}
 */
export async function runLegacyAssetSelfHealingSweep(client, options = {}) {
  if (isSweepRunning) {
    sysLog('Asset Migration Sweep Already In Progress', { detail: 'Skipping duplicate invocation' });
    return lastSweepStats;
  }

  const pool = getPool();
  if (!pool) {
    sysWarn('Cannot run asset migration sweep: PostgreSQL pool not available');
    return lastSweepStats;
  }

  isSweepRunning = true;
  const startedAt = new Date();
  sysLog('Legacy Asset Migration Sweep Started', {
    startedAt: startedAt.toISOString(),
    hostGuild: IMAGE_HOST_GUILD_ID
  });

  const stats = {
    startedAt,
    finishedAt: null,
    totalScanned: 0,
    migrated: 0,
    reused: 0,
    skipped: 0,
    failed: 0,
    errors: []
  };

  try {
    await ensureMigratedAssetsTable();

    // Collect all known host channel IDs and active/recorded forum thread IDs
    const knownHostIds = new Set(Object.values(IMAGE_HOST_CHANNELS));
    try {
      const threadsRes = await pool.query('SELECT thread_id FROM image_host_threads');
      for (const row of threadsRes.rows) {
        if (row.thread_id) knownHostIds.add(row.thread_id);
      }
    } catch (threadsErr) {
      sysWarn('Failed to fetch image_host_threads for ID set', threadsErr);
    }

    const inMemoryCache = new Map();

    // =========================================================================
    // 1. SHOP ITEMS (default_image_url) -> Category: items
    // =========================================================================
    try {
      const itemsRes = await pool.query(`
        SELECT id, guild_id, name, default_image_url
        FROM shop_items
        WHERE default_image_url IS NOT NULL AND TRIM(default_image_url) != ''
        ORDER BY id ASC
      `);

      for (const item of itemsRes.rows) {
        stats.totalScanned++;
        const res = await processAssetMigration(
          client,
          'items',
          item.guild_id,
          item.default_image_url,
          `Shop Item #${item.id} (${item.name})`,
          knownHostIds,
          inMemoryCache
        );

        if (res.status === 'migrated') {
          stats.migrated++;
          await pool.query('UPDATE shop_items SET default_image_url = $1, updated_at = NOW() WHERE id = $2', [res.newUrl, item.id]);
          sysLog(`[MIGRATION] [${stats.totalScanned}] Shop Item #${item.id} '${item.name}' migrated`, { newUrl: res.newUrl });
        } else if (res.status === 'reused') {
          stats.reused++;
          await pool.query('UPDATE shop_items SET default_image_url = $1, updated_at = NOW() WHERE id = $2', [res.newUrl, item.id]);
        } else if (res.status === 'skipped') {
          stats.skipped++;
        } else if (res.status === 'failed') {
          stats.failed++;
          stats.errors.push(`Shop Item #${item.id}: ${res.error}`);
        }
      }
    } catch (itemsErr) {
      sysError('Error migrating shop_items', itemsErr);
    }

    // =========================================================================
    // 2. SHOP POSTS (custom_image_url) -> Category: items
    // =========================================================================
    try {
      const postsRes = await pool.query(`
        SELECT message_id, guild_id, custom_image_url
        FROM shop_posts
        WHERE custom_image_url IS NOT NULL AND TRIM(custom_image_url) != ''
      `);

      for (const post of postsRes.rows) {
        stats.totalScanned++;
        const res = await processAssetMigration(
          client,
          'items',
          post.guild_id,
          post.custom_image_url,
          `Shop Post #${post.message_id}`,
          knownHostIds,
          inMemoryCache
        );

        if (res.status === 'migrated' || res.status === 'reused') {
          if (res.status === 'migrated') stats.migrated++;
          if (res.status === 'reused') stats.reused++;
          await pool.query('UPDATE shop_posts SET custom_image_url = $1 WHERE message_id = $2', [res.newUrl, post.message_id]);
        } else if (res.status === 'skipped') {
          stats.skipped++;
        } else if (res.status === 'failed') {
          stats.failed++;
        }
      }
    } catch (postsErr) {
      sysError('Error migrating shop_posts', postsErr);
    }

    // =========================================================================
    // 3. LOOT BOXES (image_url, opened_image_url) -> Category: boxes
    // =========================================================================
    try {
      const boxesRes = await pool.query(`
        SELECT id, guild_id, name, image_url, opened_image_url
        FROM loot_boxes
        WHERE (image_url IS NOT NULL AND TRIM(image_url) != '')
           OR (opened_image_url IS NOT NULL AND TRIM(opened_image_url) != '')
        ORDER BY id ASC
      `);

      for (const box of boxesRes.rows) {
        let updatedImageUrl = box.image_url;
        let updatedOpenedUrl = box.opened_image_url;
        let needsUpdate = false;

        if (box.image_url) {
          stats.totalScanned++;
          const res = await processAssetMigration(
            client,
            'boxes',
            box.guild_id,
            box.image_url,
            `Loot Box #${box.id} (${box.name}) Closed`,
            knownHostIds,
            inMemoryCache
          );
          if (res.status === 'migrated' || res.status === 'reused') {
            if (res.status === 'migrated') stats.migrated++;
            if (res.status === 'reused') stats.reused++;
            updatedImageUrl = res.newUrl;
            needsUpdate = true;
          } else if (res.status === 'skipped') {
            stats.skipped++;
          } else if (res.status === 'failed') {
            stats.failed++;
          }
        }

        if (box.opened_image_url) {
          stats.totalScanned++;
          const res = await processAssetMigration(
            client,
            'boxes',
            box.guild_id,
            box.opened_image_url,
            `Loot Box #${box.id} (${box.name}) Opened`,
            knownHostIds,
            inMemoryCache
          );
          if (res.status === 'migrated' || res.status === 'reused') {
            if (res.status === 'migrated') stats.migrated++;
            if (res.status === 'reused') stats.reused++;
            updatedOpenedUrl = res.newUrl;
            needsUpdate = true;
          } else if (res.status === 'skipped') {
            stats.skipped++;
          } else if (res.status === 'failed') {
            stats.failed++;
          }
        }

        if (needsUpdate) {
          await pool.query(
            'UPDATE loot_boxes SET image_url = $1, opened_image_url = $2, updated_at = NOW() WHERE id = $3',
            [updatedImageUrl, updatedOpenedUrl, box.id]
          );
        }
      }
    } catch (boxesErr) {
      sysError('Error migrating loot_boxes', boxesErr);
    }

    // =========================================================================
    // 4. SERVER EMBEDS (image_url, thumbnail_url, author_icon_url, footer_icon_url) -> Category: embeds
    // =========================================================================
    try {
      const embedsRes = await pool.query(`
        SELECT id, guild_id, title, image_url, thumbnail_url, author_icon_url, footer_icon_url
        FROM server_embeds
        WHERE (image_url IS NOT NULL AND TRIM(image_url) != '')
           OR (thumbnail_url IS NOT NULL AND TRIM(thumbnail_url) != '')
           OR (author_icon_url IS NOT NULL AND TRIM(author_icon_url) != '')
           OR (footer_icon_url IS NOT NULL AND TRIM(footer_icon_url) != '')
        ORDER BY id ASC
      `);

      for (const embed of embedsRes.rows) {
        let imgUrl = embed.image_url;
        let thumbUrl = embed.thumbnail_url;
        let authUrl = embed.author_icon_url;
        let footUrl = embed.footer_icon_url;
        let needsUpdate = false;

        const fields = [
          { val: embed.image_url, setter: (v) => { imgUrl = v; }, label: 'Image' },
          { val: embed.thumbnail_url, setter: (v) => { thumbUrl = v; }, label: 'Thumbnail' },
          { val: embed.author_icon_url, setter: (v) => { authUrl = v; }, label: 'Author Icon' },
          { val: embed.footer_icon_url, setter: (v) => { footUrl = v; }, label: 'Footer Icon' }
        ];

        for (const f of fields) {
          if (!f.val) continue;
          stats.totalScanned++;
          const res = await processAssetMigration(
            client,
            'embeds',
            embed.guild_id,
            f.val,
            `Embed #${embed.id} ${f.label}`,
            knownHostIds,
            inMemoryCache
          );
          if (res.status === 'migrated' || res.status === 'reused') {
            if (res.status === 'migrated') stats.migrated++;
            if (res.status === 'reused') stats.reused++;
            f.setter(res.newUrl);
            needsUpdate = true;
          } else if (res.status === 'skipped') {
            stats.skipped++;
          } else if (res.status === 'failed') {
            stats.failed++;
          }
        }

        if (needsUpdate) {
          await pool.query(
            'UPDATE server_embeds SET image_url = $1, thumbnail_url = $2, author_icon_url = $3, footer_icon_url = $4, updated_at = NOW() WHERE id = $5',
            [imgUrl, thumbUrl, authUrl, footUrl, embed.id]
          );
        }
      }
    } catch (embedsErr) {
      sysError('Error migrating server_embeds', embedsErr);
    }

    // =========================================================================
    // 5. SERVER EMBED GROUPS -> Category: embeds
    // =========================================================================
    try {
      const groupsRes = await pool.query(`
        SELECT id, guild_id, name, image_url, thumbnail_url, author_icon_url, footer_icon_url
        FROM server_embed_groups
        WHERE (image_url IS NOT NULL AND TRIM(image_url) != '')
           OR (thumbnail_url IS NOT NULL AND TRIM(thumbnail_url) != '')
           OR (author_icon_url IS NOT NULL AND TRIM(author_icon_url) != '')
           OR (footer_icon_url IS NOT NULL AND TRIM(footer_icon_url) != '')
        ORDER BY id ASC
      `);

      for (const group of groupsRes.rows) {
        let imgUrl = group.image_url;
        let thumbUrl = group.thumbnail_url;
        let authUrl = group.author_icon_url;
        let footUrl = group.footer_icon_url;
        let needsUpdate = false;

        const fields = [
          { val: group.image_url, setter: (v) => { imgUrl = v; }, label: 'Group Image' },
          { val: group.thumbnail_url, setter: (v) => { thumbUrl = v; }, label: 'Group Thumbnail' },
          { val: group.author_icon_url, setter: (v) => { authUrl = v; }, label: 'Group Author Icon' },
          { val: group.footer_icon_url, setter: (v) => { footUrl = v; }, label: 'Group Footer Icon' }
        ];

        for (const f of fields) {
          if (!f.val) continue;
          stats.totalScanned++;
          const res = await processAssetMigration(
            client,
            'embeds',
            group.guild_id,
            f.val,
            `Embed Group #${group.id} (${group.name}) ${f.label}`,
            knownHostIds,
            inMemoryCache
          );
          if (res.status === 'migrated' || res.status === 'reused') {
            if (res.status === 'migrated') stats.migrated++;
            if (res.status === 'reused') stats.reused++;
            f.setter(res.newUrl);
            needsUpdate = true;
          } else if (res.status === 'skipped') {
            stats.skipped++;
          } else if (res.status === 'failed') {
            stats.failed++;
          }
        }

        if (needsUpdate) {
          await pool.query(
            'UPDATE server_embed_groups SET image_url = $1, thumbnail_url = $2, author_icon_url = $3, footer_icon_url = $4, updated_at = NOW() WHERE id = $5',
            [imgUrl, thumbUrl, authUrl, footUrl, group.id]
          );
        }
      }
    } catch (groupsErr) {
      sysError('Error migrating server_embed_groups', groupsErr);
    }

    // =========================================================================
    // 6. GUILD CONFIGS (config->>'bot_avatar') -> Category: avatars
    // =========================================================================
    try {
      const configsRes = await pool.query(`
        SELECT guild_id, (config->>'bot_avatar') as bot_avatar
        FROM guild_configs
        WHERE config ? 'bot_avatar' AND (config->>'bot_avatar') IS NOT NULL AND TRIM(config->>'bot_avatar') != ''
      `);

      for (const row of configsRes.rows) {
        stats.totalScanned++;
        const res = await processAssetMigration(
          client,
          'avatars',
          row.guild_id,
          row.bot_avatar,
          `Server Avatar (${row.guild_id})`,
          knownHostIds,
          inMemoryCache
        );

        if (res.status === 'migrated' || res.status === 'reused') {
          if (res.status === 'migrated') stats.migrated++;
          if (res.status === 'reused') stats.reused++;
          await pool.query(`
            UPDATE guild_configs
            SET config = jsonb_set(config, '{bot_avatar}', to_jsonb($1::text)), updated_at = NOW()
            WHERE guild_id = $2
          `, [res.newUrl, row.guild_id]);

          // Update in-memory config cache if active
          const cached = configCache?.get(row.guild_id);
          if (cached) {
            cached.bot_avatar = res.newUrl;
          }
        } else if (res.status === 'skipped') {
          stats.skipped++;
        } else if (res.status === 'failed') {
          stats.failed++;
        }
      }
    } catch (configsErr) {
      sysError('Error migrating guild_configs bot_avatar', configsErr);
    }

    // Record migration pass in bot_migrations
    await pool.query(`
      INSERT INTO bot_migrations (migration_name, executed_at, details)
      VALUES ('legacy_asset_url_self_healing_v1', NOW(), $1)
      ON CONFLICT (migration_name) DO UPDATE
      SET executed_at = NOW(), details = EXCLUDED.details
    `, [JSON.stringify(stats)]).catch(() => {});

  } catch (sweepErr) {
    sysError('Legacy asset migration sweep encountered an unhandled error', sweepErr);
  } finally {
    stats.finishedAt = new Date();
    lastSweepStats = stats;
    isSweepRunning = false;

    sysLog('Legacy Asset Migration Sweep Completed', {
      totalScanned: stats.totalScanned,
      migrated: stats.migrated,
      reused: stats.reused,
      skipped: stats.skipped,
      failed: stats.failed,
      durationMs: stats.finishedAt.getTime() - stats.startedAt.getTime()
    });
  }

  return lastSweepStats;
}

/**
 * Get status of the migration system.
 *
 * @returns {Promise<{isSweepRunning: boolean, stats: typeof lastSweepStats, dbCounts: object}>}
 */
export async function getMigrationStatus() {
  const pool = getPool();
  let dbCounts = { completed: 0, failed: 0, total: 0 };

  if (pool) {
    try {
      const res = await pool.query(`
        SELECT status, COUNT(*)::int as cnt
        FROM migrated_assets
        GROUP BY status
      `);
      for (const row of res.rows) {
        dbCounts[row.status] = row.cnt;
        dbCounts.total += row.cnt;
      }
    } catch {
      // Table may not exist yet
    }
  }

  return {
    isSweepRunning,
    stats: lastSweepStats,
    dbCounts
  };
}
