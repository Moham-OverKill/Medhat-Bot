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
 * Detect image file extension from binary magic bytes.
 * Ensures WebP, JPEG, GIF, and PNG files are not mislabeled as PNG,
 * which causes Discord to fall back to generic file card icons.
 *
 * @param {Buffer} buffer
 * @returns {'png'|'jpg'|'gif'|'webp'|'avif'|null}
 */
export function detectImageExtension(buffer) {
  if (!buffer || buffer.length < 8) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4E &&
    buffer[3] === 0x47
  ) {
    return 'png';
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return 'jpg';
  }

  // GIF: 47 49 46 (GIF87a or GIF89a)
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return 'gif';
  }

  // WEBP: RIFF at 0..3 and WEBP at 8..11
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return 'webp';
  }

  // AVIF: ftyp box at 4..7
  if (buffer.length >= 16) {
    const boxType = buffer.subarray(4, 8).toString('latin1');
    if (boxType === 'ftyp') {
      const brand = buffer.subarray(8, 12).toString('latin1');
      if (brand === 'avif' || brand === 'avis') {
        return 'avif';
      }
    }
  }

  return null;
}

/**
 * Download an image buffer safely with custom headers, timeout, and automatic 429 backoff retry.
 *
 * @param {string} url
 * @param {number} [maxRetries=3]
 * @returns {Promise<{buffer: Buffer, extension: string}>}
 */
async function fetchImageBuffer(url, maxRetries = 3) {
  const cleanUrl = url.trim();

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);

    try {
      const res = await fetch(cleanUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 DiscordBot/1.0',
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
        }
      });

      if (res.status === 429) {
        // Rate limited by Discord CDN or origin server
        const retryAfterHeader = res.headers.get('retry-after');
        const waitSec = retryAfterHeader ? parseFloat(retryAfterHeader) : (attempt * 4);
        const waitMs = Math.min(Math.max(waitSec * 1000, 3000), 15000);
        sysWarn(`Rate limited (429) downloading asset, waiting ${waitMs}ms (attempt ${attempt}/${maxRetries})...`, { url: cleanUrl });
        await sleep(waitMs);
        continue;
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      const contentType = res.headers.get('content-type') || '';
      const arrayBuffer = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      if (buffer.length === 0) {
        throw new Error('Downloaded image buffer is 0 bytes');
      }

      // Determine extension: prioritize binary magic bytes first so Discord renders inline preview
      let ext = detectImageExtension(buffer);

      if (!ext) {
        if (contentType.includes('jpeg') || contentType.includes('jpg')) {
          ext = 'jpg';
        } else if (contentType.includes('gif')) {
          ext = 'gif';
        } else if (contentType.includes('webp')) {
          ext = 'webp';
        } else if (contentType.includes('png')) {
          ext = 'png';
        }
      }

      if (!ext) {
        const rawPath = cleanUrl.split('?')[0];
        const dotExt = rawPath.split('.').pop()?.toLowerCase();
        if (dotExt && ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(dotExt)) {
          ext = dotExt;
        }
      }

      if (!ext) {
        ext = 'png';
      }

      return { buffer, extension: ext };
    } catch (err) {
      if (attempt < maxRetries && (err.name === 'AbortError' || err.message?.includes('429'))) {
        await sleep(attempt * 2500);
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error('Maximum download retries exceeded');
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
          // Check if failure was permanent (e.g. 404). If temporary (429/timeout), allow retry
          const reason = row.error_reason || '';
          const isPerm = reason.includes('404') || reason.includes('410') || reason.includes('400');
          if (isPerm) {
            return { status: 'failed', error: 'Previously recorded as unrecoverable (404/410)' };
          }
        }
      }
    } catch (checkErr) {
      sysWarn('migrated_assets cache check warning', checkErr);
    }
  }

  // 4. Download source image buffer with automatic retry
  let downloadResult;
  try {
    downloadResult = await fetchImageBuffer(rawUrl);
  } catch (downloadErr) {
    const errMessage = downloadErr.message || 'Download failed';
    const isPermanent = errMessage.includes('404') || errMessage.includes('410') || errMessage.includes('400');

    sysWarn(`Legacy asset download failed for ${label}`, {
      sourceUrl: rawUrl.slice(0, 100),
      error: errMessage,
      permanent: isPermanent
    });

    // Only record permanent errors in DB to prevent locking out transient rate limits
    if (pool && isPermanent) {
      await pool.query(`
        INSERT INTO migrated_assets (source_url_clean, source_url_raw, category, status, error_reason, migrated_at)
        VALUES ($1, $2, $3, 'failed', $4, NOW())
        ON CONFLICT (source_url_clean) DO UPDATE
        SET status = 'failed', error_reason = EXCLUDED.error_reason, migrated_at = NOW()
      `, [cleanKey, rawUrl, category, errMessage]).catch(() => {});
    }

    return { status: 'failed', error: errMessage };
  }

  // 5. Upload buffer to the server's dedicated forum thread with retry
  let uploadResult;
  let uploadAttempts = 0;
  while (uploadAttempts < 3) {
    uploadAttempts++;
    try {
      const targetGuild = client.guilds.cache.get(guildId) || { id: guildId, name: `Server ${guildId}` };
      const filename = `${category}_migrated_${Date.now()}.${downloadResult.extension}`;

      uploadResult = await uploadHostAsset(client, category, targetGuild, downloadResult.buffer, {
        filename,
        label: `🔄 **Migrated Asset:** ${label}`
      });

      // Pacing delay (1500ms) to respect Discord REST rate limits safely
      await sleep(1500);
      break;
    } catch (uploadErr) {
      const isRateLimit = uploadErr.message?.includes('429') || uploadErr.code === 429 || uploadErr.status === 429;
      if (isRateLimit && uploadAttempts < 3) {
        const waitMs = uploadAttempts * 4000;
        sysWarn(`Discord rate limit encountered during upload for ${label}, waiting ${waitMs}ms before retry...`);
        await sleep(waitMs);
        continue;
      }

      const errMessage = uploadErr.message || 'Upload failed';
      sysError(`Failed to upload migrated asset to host server for ${label}`, uploadErr, {
        guild: guildId,
        category
      });

      return { status: 'failed', error: errMessage };
    }
  }

  if (!uploadResult) {
    return { status: 'failed', error: 'Upload failed after retries' };
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

    // Unblock any previously failed transient records (rate limits / network aborts) so they are retried
    await pool.query(`
      DELETE FROM migrated_assets
      WHERE status = 'failed'
        AND (error_reason LIKE '%429%' OR error_reason LIKE '%rate%' OR error_reason LIKE '%timeout%' OR error_reason LIKE '%abort%' OR error_reason LIKE '%0 bytes%' OR error_reason IS NULL)
    `).catch(() => {});

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

    // 7. Format Self-Healing: Check for any previously migrated assets whose binary magic bytes
    // did not match .png (e.g., WebP or JPEG), and re-upload with the correct extension so Discord displays inline image cards.
    try {
      await healMismatchedExtensionAssets(client);
    } catch (healErr) {
      sysWarn('Mismatched extension healing pass encountered error', healErr);
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
 * Heal any previously migrated assets whose binary magic bytes do not match .png (e.g. WebP or JPEG).
 * When Discord receives a WebP image with a .png filename, its thumbnail decoder fails and displays
 * a generic file download card. This healing function inspects existing records, and for any with
 * mismatched extensions, uploads them with their true extension so Discord renders an inline preview.
 *
 * @param {import('discord.js').Client} client
 */
export async function healMismatchedExtensionAssets(client) {
  const pool = getPool();
  if (!pool) return;

  try {
    const res = await pool.query(`
      SELECT source_url_clean, target_url, category
      FROM migrated_assets
      WHERE status = 'completed' AND target_url LIKE '%.png%'
    `);

    for (const row of res.rows) {
      if (!row.target_url) continue;

      try {
        const headRes = await fetch(row.target_url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 DiscordBot/1.0'
          }
        });
        if (!headRes.ok) continue;

        const buf = Buffer.from(await headRes.arrayBuffer());
        const trueExt = detectImageExtension(buf);

        // If the binary format is NOT a real PNG (e.g., WebP or JPEG)
        if (trueExt && trueExt !== 'png') {
          sysLog(`Repairing mismatched asset format (${trueExt} previously stored as .png)`, {
            category: row.category,
            source: row.source_url_clean.slice(0, 80)
          });

          // Determine guild context from thread ID in the URL
          const match = row.target_url.match(/cdn\.discordapp\.com\/attachments\/(\d+)\//i);
          const threadId = match?.[1];
          let targetGuild = null;

          if (threadId) {
            const threadCheck = await pool.query('SELECT guild_id FROM image_host_threads WHERE thread_id = $1 LIMIT 1', [threadId]).catch(() => ({ rows: [] }));
            if (threadCheck.rows.length > 0) {
              targetGuild = threadCheck.rows[0].guild_id;
            }
          }

          if (!targetGuild) {
            targetGuild = client.guilds.cache.first()?.id || IMAGE_HOST_GUILD_ID;
          }

          const filename = `${row.category}_migrated_${Date.now()}.${trueExt}`;
          const newUpload = await uploadHostAsset(client, row.category, targetGuild, buf, {
            filename,
            label: `🔄 **Format Repaired (${trueExt.toUpperCase()}):** Inline Preview Restored`
          });

          await sleep(500);

          const newUrl = newUpload.url;
          const oldUrl = row.target_url;

          // Update migrated_assets
          await pool.query('UPDATE migrated_assets SET target_url = $1, migrated_at = NOW() WHERE source_url_clean = $2', [newUrl, row.source_url_clean]);

          // Update references in all relevant tables
          await pool.query('UPDATE shop_items SET default_image_url = $1 WHERE default_image_url = $2', [newUrl, oldUrl]);
          await pool.query('UPDATE shop_posts SET custom_image_url = $1 WHERE custom_image_url = $2', [newUrl, oldUrl]);
          await pool.query('UPDATE loot_boxes SET image_url = $1 WHERE image_url = $2', [newUrl, oldUrl]);
          await pool.query('UPDATE loot_boxes SET opened_image_url = $1 WHERE opened_image_url = $2', [newUrl, oldUrl]);
          await pool.query('UPDATE server_embeds SET image_url = $1 WHERE image_url = $2', [newUrl, oldUrl]);
          await pool.query('UPDATE server_embeds SET thumbnail_url = $1 WHERE thumbnail_url = $2', [newUrl, oldUrl]);
          await pool.query('UPDATE server_embeds SET author_icon_url = $1 WHERE author_icon_url = $2', [newUrl, oldUrl]);
          await pool.query('UPDATE server_embeds SET footer_icon_url = $1 WHERE footer_icon_url = $2', [newUrl, oldUrl]);
          await pool.query('UPDATE server_embed_groups SET image_url = $1 WHERE image_url = $2', [newUrl, oldUrl]);
          await pool.query('UPDATE server_embed_groups SET thumbnail_url = $1 WHERE thumbnail_url = $2', [newUrl, oldUrl]);
          await pool.query('UPDATE server_embed_groups SET author_icon_url = $1 WHERE author_icon_url = $2', [newUrl, oldUrl]);
          await pool.query('UPDATE server_embed_groups SET footer_icon_url = $1 WHERE footer_icon_url = $2', [newUrl, oldUrl]);
        }
      } catch (itemRepairErr) {
        sysWarn('Single asset format repair warning', itemRepairErr);
      }
    }
  } catch (healErr) {
    sysWarn('healMismatchedExtensionAssets sweep error', healErr);
  }
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
