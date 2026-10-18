import { AttachmentBuilder } from 'discord.js';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { getPool } from '../storage/postgres.js';
import { sysLog, sysWarn, sysError } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fontsDir = path.resolve(__dirname, '../assets/fonts');

// Register bundled fonts for clean card rendering
try {
  const boldPath = path.join(fontsDir, 'Roboto-Bold.ttf');
  const regularPath = path.join(fontsDir, 'Roboto-Regular.ttf');
  const cairoPath = path.join(fontsDir, 'Cairo.ttf');
  const arabicPath = path.join(fontsDir, 'NotoSansArabic.ttf');
  const emojiPath = path.join(fontsDir, 'seguiemj.ttf');
  if (fs.existsSync(boldPath)) GlobalFonts.registerFromPath(boldPath, 'Roboto-Bold');
  if (fs.existsSync(regularPath)) GlobalFonts.registerFromPath(regularPath, 'Roboto');
  if (fs.existsSync(cairoPath)) GlobalFonts.registerFromPath(cairoPath, 'Cairo');
  if (fs.existsSync(arabicPath)) GlobalFonts.registerFromPath(arabicPath, 'NotoSansArabic');
  if (fs.existsSync(emojiPath)) GlobalFonts.registerFromPath(emojiPath, 'Segoe UI Emoji');
} catch {
  // Ignore font re-registration
}

export const IMAGE_HOST_GUILD_ID = process.env.IMAGE_HOST_GUILD_ID || '1561304256428904488';

export const IMAGE_HOST_CHANNELS = {
  items: process.env.IMAGE_HOST_ITEMS_CHANNEL_ID || '1561304537208463462',
  avatars: process.env.IMAGE_HOST_AVATARS_CHANNEL_ID || '1561304768410943498',
  boxes: process.env.IMAGE_HOST_BOXES_CHANNEL_ID || '1561304601347498046',
  embeds: process.env.IMAGE_HOST_EMBEDS_CHANNEL_ID || '1561304911793225801'
};

export const CATEGORY_THEMES = {
  items: { name: 'Items', color: '#5865F2', hexNumber: 0x5865F2 },
  avatars: { name: 'Avatars', color: '#57F287', hexNumber: 0x57F287 },
  boxes: { name: 'Loot Boxes', color: '#FEE75C', hexNumber: 0xFEE75C },
  embeds: { name: 'Embeds', color: '#EB459E', hexNumber: 0xEB459E }
};

// In-memory cache for fast thread lookup: `${guildId}:${category}` => threadId
const threadCache = new Map();

/**
 * Ensure image_host_threads table exists in PostgreSQL.
 */
export async function ensureImageHostTable() {
  const pool = getPool();
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS image_host_threads (
      guild_id VARCHAR(32) NOT NULL,
      category VARCHAR(32) NOT NULL,
      thread_id VARCHAR(32) NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      PRIMARY KEY (guild_id, category)
    );
    CREATE INDEX IF NOT EXISTS idx_image_host_threads_guild ON image_host_threads(guild_id);
  `).catch(err => {
    sysError('Failed to ensure image_host_threads table', err);
  });
}

/**
 * Retrieve or create a dedicated thread in the asset host forum channel for a server.
 *
 * @param {import('discord.js').Client} client
 * @param {'items'|'avatars'|'boxes'|'embeds'} category
 * @param {import('discord.js').Guild|{id: string, name?: string}} guild
 * @returns {Promise<import('discord.js').ThreadChannel>}
 */
export async function getOrCreateGuildThread(client, category, guild) {
  const channelId = IMAGE_HOST_CHANNELS[category];
  if (!channelId) {
    throw new Error(`Invalid asset category '${category}'. Valid categories: ${Object.keys(IMAGE_HOST_CHANNELS).join(', ')}`);
  }

  const guildId = typeof guild === 'string' ? guild : guild.id;
  const guildName = (typeof guild === 'object' && guild.name)
    ? guild.name
    : client.guilds.cache.get(guildId)?.name || `Server ${guildId}`;

  const cacheKey = `${guildId}:${category}`;

  // 1. Check in-memory cache
  let threadId = threadCache.get(cacheKey);

  // 2. Check database if not in cache
  if (!threadId) {
    const pool = getPool();
    if (pool) {
      try {
        const res = await pool.query(
          'SELECT thread_id FROM image_host_threads WHERE guild_id = $1 AND category = $2 LIMIT 1',
          [guildId, category]
        );
        if (res.rows.length > 0) {
          threadId = res.rows[0].thread_id;
        }
      } catch (dbErr) {
        sysWarn('Database thread lookup error, falling back to Discord lookup', dbErr);
      }
    }
  }

  // 3. If threadId is known, verify thread still exists on Discord
  if (threadId) {
    try {
      const thread = client.channels.cache.get(threadId) || await client.channels.fetch(threadId).catch(() => null);
      if (thread && !thread.deleted) {
        if (thread.archived) {
          await thread.setArchived(false).catch(() => {});
        }
        threadCache.set(cacheKey, thread.id);
        return thread;
      }
    } catch {
      // Thread might have been deleted manually on Discord
    }
  }

  // 4. Fetch host guild and forum channel
  const hostGuild = client.guilds.cache.get(IMAGE_HOST_GUILD_ID) ||
    await client.guilds.fetch(IMAGE_HOST_GUILD_ID).catch(() => null);

  if (!hostGuild) {
    throw new Error(`Bot is not in asset host server ${IMAGE_HOST_GUILD_ID} or lacks permissions.`);
  }

  const forumChannel = hostGuild.channels.cache.get(channelId) ||
    await hostGuild.channels.fetch(channelId).catch(() => null);

  if (!forumChannel) {
    throw new Error(`Forum channel ${channelId} for category '${category}' not found in host server.`);
  }

  // 5. Search existing forum threads (both active and archived) to prevent duplicates
  let existingThread = null;
  try {
    const activeResult = await forumChannel.threads.fetchActive().catch(() => ({ threads: new Map() }));
    existingThread = activeResult.threads.find(t => t.name.includes(guildId));

    if (!existingThread) {
      const archivedResult = await forumChannel.threads.fetchArchived({ limit: 100 }).catch(() => ({ threads: new Map() }));
      existingThread = archivedResult.threads.find(t => t.name.includes(guildId));
    }
  } catch (searchErr) {
    sysWarn('Error searching existing forum threads', searchErr);
  }

  if (existingThread) {
    if (existingThread.archived) {
      await existingThread.setArchived(false).catch(() => {});
    }
    await saveThreadRecord(guildId, category, existingThread.id);
    threadCache.set(cacheKey, existingThread.id);
    return existingThread;
  }

  // 6. Create a brand-new post/thread for this server in the forum channel
  const cleanName = guildName.replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim() || 'Server';
  const threadTitle = `${cleanName.slice(0, 60)} (${guildId})`.trim();

  // If forum requires tags, pass the first available tag to satisfy requirements
  const options = {
    name: threadTitle,
    autoArchiveDuration: 10080, // 7 days (maximum standard)
    message: {
      content: `📂 **Asset Storage Thread**\n` +
        `**Server:** ${guildName} (\`${guildId}\`)\n` +
        `**Category:** \`${category.toUpperCase()}\`\n` +
        `*All uploaded ${category} assets for this server will be archived and hosted here.*`
    }
  };

  if (forumChannel.availableTags && forumChannel.availableTags.length > 0) {
    options.appliedTags = [forumChannel.availableTags[0].id];
  }

  const newThread = await forumChannel.threads.create(options);

  await saveThreadRecord(guildId, category, newThread.id);
  threadCache.set(cacheKey, newThread.id);

  sysLog('Image Host Thread Created', {
    guild: guildId,
    category,
    detail: `Thread: ${newThread.name} (${newThread.id})`
  });

  return newThread;
}

/**
 * Persist thread mapping to PostgreSQL.
 */
async function saveThreadRecord(guildId, category, threadId) {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO image_host_threads (guild_id, category, thread_id, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (guild_id, category) DO UPDATE
       SET thread_id = EXCLUDED.thread_id, updated_at = NOW()`,
      [guildId, category, threadId]
    );
  } catch (err) {
    sysWarn('Failed to persist image host thread record', err);
  }
}

/**
 * Upload an asset file or buffer to the guild's dedicated forum thread.
 *
 * @param {import('discord.js').Client} client
 * @param {'items'|'avatars'|'boxes'|'embeds'} category
 * @param {import('discord.js').Guild|{id: string, name?: string}} guild
 * @param {Buffer|string|AttachmentBuilder|{url: string, name?: string}} fileInput
 * @param {object} [options]
 * @param {string} [options.filename]
 * @param {string} [options.label]
 * @returns {Promise<{url: string, proxyUrl: string, attachmentId: string, messageId: string, threadId: string, channelId: string, threadName: string}>}
 */
export async function uploadHostAsset(client, category, guild, fileInput, options = {}) {
  const thread = await getOrCreateGuildThread(client, category, guild);

  let attachment;
  if (Buffer.isBuffer(fileInput)) {
    const filename = options.filename || `${category}_${Date.now()}.png`;
    attachment = new AttachmentBuilder(fileInput, { name: filename });
  } else if (fileInput instanceof AttachmentBuilder) {
    attachment = fileInput;
  } else if (typeof fileInput === 'string') {
    // URL string
    const res = await fetch(fileInput);
    if (!res.ok) {
      throw new Error(`Failed to download source image (${res.status} ${res.statusText})`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = fileInput.split('?')[0].split('.').pop() || 'png';
    const filename = options.filename || `${category}_${Date.now()}.${ext}`;
    attachment = new AttachmentBuilder(buf, { name: filename });
  } else if (fileInput && typeof fileInput === 'object' && fileInput.url) {
    // Discord uploaded attachment object
    const res = await fetch(fileInput.url);
    if (!res.ok) {
      throw new Error(`Failed to download uploaded attachment (${res.status} ${res.statusText})`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const filename = fileInput.name || options.filename || `${category}_${Date.now()}.png`;
    attachment = new AttachmentBuilder(buf, { name: filename });
  } else {
    throw new Error('Unsupported file input type for uploadHostAsset');
  }

  const message = await thread.send({
    content: options.label || `🖼️ Asset uploaded for **${guild.name || guild.id}** (\`${guild.id}\`)`,
    files: [attachment]
  });

  const uploadedAttachment = message.attachments.first();
  if (!uploadedAttachment) {
    throw new Error('Failed to retrieve uploaded attachment from host thread');
  }

  return {
    url: uploadedAttachment.url,
    proxyUrl: uploadedAttachment.proxyURL,
    attachmentId: uploadedAttachment.id,
    messageId: message.id,
    threadId: thread.id,
    channelId: thread.parentId,
    threadName: thread.name
  };
}

/**
 * Generate a branded 800x400 test card image buffer using @napi-rs/canvas.
 *
 * @param {'items'|'avatars'|'boxes'|'embeds'} category
 * @param {import('discord.js').Guild|{id: string, name?: string}} guild
 * @returns {Buffer}
 */
export function generateTestCard(category, guild) {
  const theme = CATEGORY_THEMES[category] || { name: category.toUpperCase(), color: '#5865F2' };
  const guildName = guild.name || `Server ${guild.id}`;
  const guildId = guild.id;

  const canvas = createCanvas(800, 400);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#1e1f22';
  ctx.fillRect(0, 0, 800, 400);

  // Inner Card
  ctx.fillStyle = '#2b2d31';
  ctx.fillRect(20, 20, 760, 360);

  // Top Accent Stripe in Category Color
  ctx.fillStyle = theme.color;
  ctx.fillRect(20, 20, 760, 10);

  const boldFont = '"Roboto-Bold", "Cairo", "NotoSansArabic", "Segoe UI Emoji", Arial, sans-serif';
  const regularFont = '"Roboto", "Cairo", "NotoSansArabic", "Segoe UI Emoji", Arial, sans-serif';

  // Header Title
  ctx.fillStyle = '#ffffff';
  ctx.font = `28px ${boldFont}`;
  ctx.fillText('MEDHAT ASSET HOSTING PIPELINE', 50, 80);

  // Category Tagline
  ctx.fillStyle = theme.color;
  ctx.font = `22px ${boldFont}`;
  ctx.fillText(`CATEGORY: ${theme.name.toUpperCase()} CHANNEL TEST`, 50, 130);

  // Metadata Details
  ctx.fillStyle = '#b5bac1';
  ctx.font = `18px ${regularFont}`;
  ctx.fillText(`Target Server: ${guildName.slice(0, 40)} (${guildId})`, 50, 185);
  ctx.fillText(`Host Forum Channel: ${IMAGE_HOST_CHANNELS[category]}`, 50, 225);
  ctx.fillText(`Generated: ${new Date().toISOString()}`, 50, 265);

  // Verified Status Pill
  ctx.fillStyle = '#232428';
  ctx.fillRect(50, 305, 360, 42);
  ctx.fillStyle = '#57F287';
  ctx.font = `18px ${boldFont}`;
  ctx.fillText('✓ PIPELINE VERIFIED & OPERATIONAL', 70, 332);

  return canvas.toBuffer('image/png');
}

/**
 * Execute a test cycle across all 4 host forum channels for a target guild.
 *
 * @param {import('discord.js').Client} client
 * @param {import('discord.js').Guild|{id: string, name?: string}} guild
 * @returns {Promise<Array<{category: string, success: boolean, url?: string, threadId?: string, threadName?: string, channelId?: string, messageId?: string, error?: string}>>}
 */
export async function sendTestImagesForGuild(client, guild) {
  const categories = ['items', 'avatars', 'boxes', 'embeds'];
  const results = [];

  for (const category of categories) {
    try {
      const cardBuffer = generateTestCard(category, guild);
      const filename = `${category}_test_${Date.now()}.png`;
      const label = `🖼️ **${CATEGORY_THEMES[category]?.name.toUpperCase()} TEST ASSET**\n` +
        `**Server:** ${guild.name || guild.id} (\`${guild.id}\`)\n` +
        `**Timestamp:** <t:${Math.floor(Date.now() / 1000)}:F>`;

      const uploadResult = await uploadHostAsset(client, category, guild, cardBuffer, {
        filename,
        label
      });

      results.push({
        category,
        success: true,
        url: uploadResult.url,
        threadId: uploadResult.threadId,
        threadName: uploadResult.threadName,
        channelId: uploadResult.channelId,
        messageId: uploadResult.messageId
      });

      sysLog('Image Host Test Upload Success', {
        guild: guild.id,
        category,
        detail: `Uploaded to ${uploadResult.threadName} (${uploadResult.url})`
      });
    } catch (err) {
      sysError(`Image Host Test Upload Failed for category '${category}'`, err, {
        guild: guild.id,
        category
      });
      results.push({
        category,
        success: false,
        channelId: IMAGE_HOST_CHANNELS[category],
        error: err.message
      });
    }
  }

  return results;
}

/**
 * Startup hook: Automatically verify and seed test threads if not already present.
 *
 * @param {import('discord.js').Client} client
 */
export async function initializeImageHostStartupTest(client) {
  try {
    await ensureImageHostTable();

    const hostGuild = client.guilds.cache.get(IMAGE_HOST_GUILD_ID) ||
      await client.guilds.fetch(IMAGE_HOST_GUILD_ID).catch(() => null);

    if (!hostGuild) {
      sysWarn('Image host guild not found during startup check', { hostGuildId: IMAGE_HOST_GUILD_ID });
      return;
    }

    const pool = getPool();
    let hasExisting = false;
    if (pool) {
      const res = await pool.query('SELECT 1 FROM image_host_threads LIMIT 1').catch(() => ({ rows: [] }));
      hasExisting = res.rows.length > 0;
    }

    // If no threads have been seeded yet in DB, run test for the host guild and the first connected guild
    if (!hasExisting) {
      sysLog('Running Initial Image Host Test Cycle', { detail: 'Seeding forum posts for host guild' });
      await sendTestImagesForGuild(client, hostGuild);

      // Also check if bot is in another server (e.g. user server) and seed it as well
      const otherGuild = Array.from(client.guilds.cache.values()).find(g => g.id !== IMAGE_HOST_GUILD_ID);
      if (otherGuild) {
        sysLog('Running Initial Image Host Test Cycle for Connected Server', {
          guild: otherGuild.id,
          name: otherGuild.name
        });
        await sendTestImagesForGuild(client, otherGuild);
      }
    }
  } catch (startupErr) {
    sysError('Image Host Startup Check Error', startupErr);
  }
}
