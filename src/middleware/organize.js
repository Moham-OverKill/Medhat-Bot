import { EmbedBuilder } from 'discord.js';
import { getPool } from '../storage/postgres.js';
import { sysLog, sysError } from '../utils/logger.js';

// In-memory cache: guildId -> { links_only: Set, images_only: Set, media_only: Set, cmd_only: Set, cachedAt: number }
const filterCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Allowed social media domains for "media_only" (Socials Only) rule
const SOCIAL_MEDIA_DOMAINS = [
  'youtube.com', 'youtu.be', 'www.youtube.com', 'm.youtube.com',
  'tiktok.com', 'www.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com',
  'instagram.com', 'www.instagram.com',
  'reddit.com', 'www.reddit.com', 'old.reddit.com',
  'x.com', 'www.x.com',
  'twitter.com', 'www.twitter.com', 'mobile.twitter.com',
  'facebook.com', 'www.facebook.com', 'm.facebook.com', 'fb.watch',
  'twitch.tv', 'www.twitch.tv', 'clips.twitch.tv', 'm.twitch.tv',
  'kick.com', 'www.kick.com'
];

/**
 * Load filter config for a guild into the cache
 */
async function loadGuildFilters(guildId) {
  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT config->'channel_filters' as filters FROM guild_configs WHERE guild_id = $1`,
      [guildId]
    );

    const filters = result.rows[0]?.filters;
    if (!filters || typeof filters !== 'object') {
      filterCache.set(guildId, {
        links_only: new Set(),
        images_only: new Set(),
        media_only: new Set(),
        cmd_only: new Set(),
        hasAnyRule: false,
        cachedAt: Date.now()
      });
      return;
    }

    const entry = {
      links_only: new Set(Array.isArray(filters.links_only) ? filters.links_only : []),
      images_only: new Set(Array.isArray(filters.images_only) ? filters.images_only : []),
      media_only: new Set(Array.isArray(filters.media_only) ? filters.media_only : []),
      cmd_only: new Set(Array.isArray(filters.cmd_only) ? filters.cmd_only : []),
      fix_embeds: !!filters.fix_embeds,
      cachedAt: Date.now()
    };
    entry.hasAnyRule = entry.links_only.size > 0 || entry.images_only.size > 0 ||
                       entry.media_only.size > 0 || entry.cmd_only.size > 0;
    filterCache.set(guildId, entry);
  } catch (error) {
    sysError('Filter Cache Load Failed', error, { guild: guildId });
  }
}

/**
 * Invalidate the filter cache for a specific guild (called when admin changes settings)
 */
export function invalidateFilterCache(guildId) {
  filterCache.delete(guildId);
}

/**
 * Check if a URL belongs to an allowed social media domain
 */
function isSocialMediaUrl(url) {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    return SOCIAL_MEDIA_DOMAINS.some(domain => hostname === domain || hostname.endsWith('.' + domain));
  } catch {
    return false;
  }
}

/**
 * Extract all URLs from message content (including markdown targets)
 */
function extractUrls(content) {
  const urlPattern = /https?:\/\/[^\s<>)"']+/gi;
  const matches = content.match(urlPattern) || [];
  return matches.map(u => u.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()\]\[]+$/, ''));
}

/**
 * Check if a message should be deleted based on channel content filters.
 * Returns true if the message should be deleted, false if it should be kept.
 */
export async function checkContentFilter(message) {
  const guildId = message.guild.id;
  const channelId = message.channel.id;

  let cached = filterCache.get(guildId);
  if (!cached || (Date.now() - cached.cachedAt > CACHE_TTL_MS)) {
    await loadGuildFilters(guildId);
    cached = filterCache.get(guildId);
  }

  if (!cached || !cached.hasAnyRule) return false;

  const applicableRules = [];
  if (cached.links_only.has(channelId)) applicableRules.push('links_only');
  if (cached.images_only.has(channelId)) applicableRules.push('images_only');
  if (cached.media_only.has(channelId)) applicableRules.push('media_only');
  if (cached.cmd_only.has(channelId)) applicableRules.push('cmd_only');

  if (applicableRules.length === 0) return false;

  const content = (message.content || '').trim();

  for (const rule of applicableRules) {
    switch (rule) {
      case 'links_only': {
        const urls = extractUrls(content);
        if (urls.length > 0) {
          if (content.startsWith('http://') || content.startsWith('https://') || content.startsWith('[')) {
            if (urls.every(url => url.startsWith('http://') || url.startsWith('https://'))) return false;
          }
        }
        break;
      }
      case 'images_only': {
        if (message.attachments && message.attachments.size > 0) return false;
        if (content.includes('https://media.discordapp.net') || content.includes('https://cdn.discordapp.com')) return false;
        break;
      }
      case 'media_only': {
        const urls = extractUrls(content);
        if (urls.length > 0 && urls.every(url => isSocialMediaUrl(url))) return false;
        break;
      }
      case 'cmd_only': {
        if (message.author.bot) return false;
        break;
      }
    }
  }

  return true;
}

// Lock to prevent concurrent processing during race conditions
const pendingFixes = new Set();

/**
 * Helper to fetch or create a bot-managed webhook for seamless user impersonation reposting.
 */
async function getOrCreateWebhook(channel) {
  try {
    const webhooks = await channel.fetchWebhooks();
    let webhook = webhooks.find(w => w.name === 'Medhat-FixEmbeds');
    if (!webhook) {
      webhook = await channel.createWebhook({
        name: 'Medhat-FixEmbeds',
        reason: 'Automated Social Media Fix Embeds Reposting'
      });
    }
    return webhook;
  } catch (err) {
    return null;
  }
}

/**
 * Fast oEmbed title extractor for YouTube, TikTok, and web metadata.
 */
async function fetchVideoTitle(targetUrl) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);

    if (/(youtube\.com|youtu\.be)/i.test(targetUrl)) {
      const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(targetUrl)}&format=json`, { signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) {
        const data = await res.json();
        if (data.title) return data.title;
      }
    }

    if (/tiktok\.com/i.test(targetUrl)) {
      const res = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(targetUrl)}`, { signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) {
        const data = await res.json();
        if (data.title) return data.title;
      }
    }

    const res = await fetch(targetUrl, {
      headers: { 'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' },
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (res.ok) {
      const html = await res.text();
      const match = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i) ||
                    html.match(/<title>([^<]+)<\/title>/i);
      if (match && match[1]) {
        return match[1].trim();
      }
    }
  } catch (err) {}
  return null;
}

/**
 * Fix Embeds handler: Deletes user message and posts a single zero-gap message:
 * - Line 1: @user shared a video:
 * - Line 2: [Video Title](targetUrl) [\u2800](targetUrl) (Same line prevents vertical gap!)
 * - Discord native playable video player card rendered directly underneath.
 * - Sequential automated reactions (👍, ❤️, 😂, 😭).
 */
export async function processFixEmbeds(message, isEdit = false) {
  const guildId = message.guild.id;

  // Guard: Feature must be enabled AND channel configured for Socials Only (media_only)
  const cached = filterCache.get(guildId);
  if (!cached || !cached.fix_embeds || !cached.media_only.has(message.channel.id)) return;

  // Ignore edits or bot messages
  if (isEdit || message.author.bot) return;

  const content = message.content || '';
  const urls = extractUrls(content).filter(u => isSocialMediaUrl(u));
  if (urls.length === 0) return;

  if (pendingFixes.has(message.id)) return;
  pendingFixes.add(message.id);

  try {
    const targetUrl = urls[0];
    const authorUsername = message.member?.displayName || message.author.displayName || message.author.username;
    const authorAvatar = message.author.displayAvatarURL({ dynamic: true });
    const webhook = await getOrCreateWebhook(message.channel);

    const videoTitle = await fetchVideoTitle(targetUrl);
    const titleLink = videoTitle ? `[**${videoTitle}**](${targetUrl})` : `[video](${targetUrl})`;

    // Format Line 1 and Line 2 on the exact same text block so invisible link doesn't create Line 3 empty space
    const userHeader = webhook ? `shared a video:` : `<@${message.author.id}> shared a video:`;
    const singleMessageContent = `${userHeader}\n${titleLink} [\u2800](${targetUrl})`;

    let sentMsg;
    if (webhook) {
      sentMsg = await webhook.send({ username: authorUsername, avatarURL: authorAvatar, content: singleMessageContent });
    } else {
      sentMsg = await message.channel.send({ content: singleMessageContent });
    }

    // Delete user's original message
    await message.delete().catch(() => {});

    // Add automated reactions sequentially: 👍, ❤️, 😂, 😭
    if (sentMsg && sentMsg.react) {
      const emojis = ['👍', '❤️', '😂', '😭'];
      for (const emoji of emojis) {
        await sentMsg.react(emoji).catch(() => {});
      }
    }

  } catch (error) {
    sysError('Fix Embed Repost Failed', error, { guild: guildId, channel: message.channel.id });
  } finally {
    pendingFixes.delete(message.id);
  }
}

/**
 * Cleanup handler (retained for interface compatibility)
 */
export async function handleFixedEmbedCleanup(channel, messageId) {
  // Native embeds manage their own lifecycle
}
