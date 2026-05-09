import { getPool } from '../storage/postgres.js';
import { sysLog, sysError } from '../utils/logger.js';

// In-memory cache: guildId -> { links_only: Set, images_only: Set, media_only: Set, cmd_only: Set, cachedAt: number }
const filterCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Allowed social media domains for "media_only" rule
const SOCIAL_MEDIA_DOMAINS = [
  'youtube.com', 'youtu.be', 'www.youtube.com', 'm.youtube.com',
  'tiktok.com', 'www.tiktok.com', 'vm.tiktok.com',
  'instagram.com', 'www.instagram.com',
  'reddit.com', 'www.reddit.com', 'old.reddit.com',
  'x.com', 'www.x.com',
  'twitter.com', 'www.twitter.com', 'mobile.twitter.com',
  'facebook.com', 'www.facebook.com', 'm.facebook.com', 'fb.watch'
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
      // No filters configured — cache an empty entry so we don't re-query
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
 * Extract all URLs from message content
 */
function extractUrls(content) {
  const urlPattern = /https?:\/\/[^\s<]+/gi;
  return content.match(urlPattern) || [];
}

/**
 * Check if a message should be deleted based on channel content filters.
 * Returns true if the message should be deleted, false if it should be kept.
 * 
 * This is designed for the hot path — uses in-memory Set lookups only.
 */
export async function checkContentFilter(message) {
  const guildId = message.guild.id;
  const channelId = message.channel.id;

  // Load cache if missing or expired
  let cached = filterCache.get(guildId);
  if (!cached || (Date.now() - cached.cachedAt > CACHE_TTL_MS)) {
    await loadGuildFilters(guildId);
    cached = filterCache.get(guildId);
  }

  // Early guard: no filters configured for this guild
  if (!cached || !cached.hasAnyRule) return false;

  // Collect all rules that apply to this specific channel
  const applicableRules = [];
  if (cached.links_only.has(channelId)) applicableRules.push('links_only');
  if (cached.images_only.has(channelId)) applicableRules.push('images_only');
  if (cached.media_only.has(channelId)) applicableRules.push('media_only');
  if (cached.cmd_only.has(channelId)) applicableRules.push('cmd_only');

  // No rules apply to this channel — allow everything
  if (applicableRules.length === 0) return false;

  // Stacking logic (OR): if ANY rule is satisfied, the message is allowed.
  // Only delete if NO rule is satisfied.
  const content = (message.content || '').trim();

  for (const rule of applicableRules) {
    switch (rule) {
      case 'links_only': {
        // Passes if message starts with http:// or https://
        if (content.startsWith('http://') || content.startsWith('https://')) return false;
        break;
      }
      case 'images_only': {
        // Passes if message has at least 1 attachment
        if (message.attachments && message.attachments.size > 0) return false;
        break;
      }
      case 'media_only': {
        // Passes if message contains a social media URL
        const urls = extractUrls(content);
        if (urls.some(url => isSocialMediaUrl(url))) return false;
        break;
      }
      case 'cmd_only': {
        // Passes if the message author is a bot (slash commands are interactions, not messages)
        // Human messages in CMD-only channels are always deleted
        if (message.author.bot) return false;
        break;
      }
    }
  }

  // No rule was satisfied — delete the message
  return true;
}

/**
 * Replace broken social media links with working embeddable alternatives.
 * Runs AFTER checkContentFilter logic.
 */
export async function processFixEmbeds(message) {
  const guildId = message.guild.id;

  // Read from hot-cache
  const cached = filterCache.get(guildId);
  if (!cached || !cached.fix_embeds) return;

  const content = message.content || '';
  if (!content) return;

  let newContent = content;
  let modified = false;

  const replacers = [
    { pattern: /(https?:\/\/)(www\.)?(tiktok\.com|vm\.tiktok\.com)\b/gi, replacement: '$1tnktok.com' },
    { pattern: /(https?:\/\/)(www\.)?(instagram\.com)\b/gi, replacement: '$1eeinstagram.com' },
    { pattern: /(https?:\/\/)(www\.)?(facebook\.com|fb\.watch)\b/gi, replacement: '$1facebed.com' }
  ];

  for (const { pattern, replacement } of replacers) {
    if (pattern.test(newContent)) {
      newContent = newContent.replace(pattern, replacement);
      modified = true;
    }
  }

  if (!modified) return;

  try {
    // 1. Reply to the original message with the replaced links
    const botReply = await message.reply({ content: newContent });

    // 2. Wait 3.5 seconds to give Discord time to generate the video embed on the bot's reply
    await new Promise(resolve => setTimeout(resolve, 3500));

    // 3. Fetch the bot's reply message to check for embeds
    const fetchedBotReply = await message.channel.messages.fetch(botReply.id).catch(() => null);

    if (fetchedBotReply && fetchedBotReply.embeds.length > 0) {
      // Success Route: The service generated a playable embed, suppress the user's original broken embed
      await message.suppressEmbeds(true).catch(() => {});
    } else if (fetchedBotReply) {
      // Fail Route: The embed failed to generate, clean up the bot's reply silently
      await fetchedBotReply.delete().catch(() => {});
    }
  } catch (error) {
    sysError('Fix Embeds Failed', error, { guild: guildId, channel: message.channel.id });
  }
}

