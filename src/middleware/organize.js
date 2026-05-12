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

// Domains used for the "Fix Embeds" feature
const FIX_SERVICE_DOMAINS = {
  tiktok: 'tnktok.com',
  instagram: 'kkinstagram.com',
  facebook: 'facebed.com'
};

// Tracks userMessageId -> { botReplyId, lastFixedUrls }
// Used to update or remove "Fixed Embed" replies when the user edits their message.
// Entries are auto-deleted after 1 hour.
const fixedEmbedTracker = new Map();
const TRACKER_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

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
        // Strict Check: If links are present, EVERY link must be a valid social media URL.
        // If NO links are present, this specific rule fails (may be saved by images_only).
        const urls = extractUrls(content);
        if (urls.length > 0 && urls.every(url => isSocialMediaUrl(url))) return false;
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
 * Handles both new messages and edits dynamically.
 */
export async function processFixEmbeds(message) {
  const guildId = message.guild.id;

  // 1. Guard: Check if feature is enabled
  const cached = filterCache.get(guildId);
  if (!cached || !cached.fix_embeds) return;

  const content = message.content || '';
  const urlPattern = /https?:\/\/[^\s<]+/gi;
  const urls = content.match(urlPattern) || [];
  
  const fixedUrls = [];
  const replacers = [
    { pattern: /(https?:\/\/)(www\.)?([a-z0-9]+\.)?(tiktok\.com)(?=\/|$)/i, replacement: `$1${FIX_SERVICE_DOMAINS.tiktok}` },
    { pattern: /(https?:\/\/)(www\.)?(instagram\.com)(?=\/|$)/i, replacement: `$1${FIX_SERVICE_DOMAINS.instagram}` },
    { pattern: /(https?:\/\/)(www\.)?(facebook\.com|fb\.watch)(?=\/|$)/i, replacement: `$1${FIX_SERVICE_DOMAINS.facebook}` }
  ];

  for (let url of urls) {
    let modifiedUrl = url;
    let modified = false;
    for (const { pattern, replacement } of replacers) {
      if (pattern.test(modifiedUrl)) {
        modifiedUrl = modifiedUrl.replace(pattern, replacement);
        modified = true;
        break;
      }
    }
    if (modified) fixedUrls.push(modifiedUrl);
  }

  // Generate current "invisible links" string
  const currentFixedUrls = fixedUrls.map(url => `[\u2800](${url})`).join('');
  const existingRecord = fixedEmbedTracker.get(message.id);

  // === ROUTE A: CLEANUP (User removed the social links) ===
  if (currentFixedUrls.length === 0) {
    if (existingRecord) {
      try {
        const botReply = await message.channel.messages.fetch(existingRecord.botReplyId).catch(() => null);
        if (botReply) await botReply.delete().catch(() => {});
        fixedEmbedTracker.delete(message.id);
      } catch (err) { /* silent */ }
    }
    return;
  }

  // === ROUTE B: NO-CHANGE (Links are the same, just a text edit) ===
  if (existingRecord && existingRecord.lastFixedUrls === currentFixedUrls) {
    return; // Do nothing, existing player is fine
  }

  try {
    let botReply;
    
    // === ROUTE C: UPDATE (User changed the link) ===
    if (existingRecord) {
      botReply = await message.channel.messages.fetch(existingRecord.botReplyId).catch(() => null);
      if (botReply) {
        await botReply.edit({ content: currentFixedUrls });
        // Update the record with new URL signature
        fixedEmbedTracker.set(message.id, { ...existingRecord, lastFixedUrls: currentFixedUrls });
      }
    } 
    
    // === ROUTE D: CREATE (New message or first valid link edit) ===
    if (!botReply) {
      botReply = await message.reply({ content: currentFixedUrls });
      fixedEmbedTracker.set(message.id, { botReplyId: botReply.id, lastFixedUrls: currentFixedUrls });
      
      // Auto-expire from map after 1 hour
      setTimeout(() => fixedEmbedTracker.delete(message.id), TRACKER_EXPIRY_MS);
    }

    // --- SHARED VERIFICATION FLOW ---
    // Poll every 500ms up to 5 seconds to see if Discord has generated the embed yet.
    // This allows the bot to be fast when Discord is fast, and patient when it's slow.
    let fetchedBotReply = null;
    let hasContentEmbed = false;

    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      
      fetchedBotReply = await message.channel.messages.fetch(botReply.id).catch(() => null);
      hasContentEmbed = fetchedBotReply?.embeds.some(e => 
        e.video || e.data?.video || e.type === 'video' || 
        e.image || e.data?.image
      );

      if (hasContentEmbed) break; // Found it! Stop waiting.
    }

    if (fetchedBotReply && hasContentEmbed) {
      await message.suppressEmbeds(true).catch(() => {});
    } else if (fetchedBotReply) {
      // Fail Route: 5 seconds passed and no playable content appeared.
      await fetchedBotReply.delete().catch(() => {});
      fixedEmbedTracker.delete(message.id);
    }
  } catch (error) {
    sysError('Fix Embeds Dynamic Update Failed', error, { guild: guildId, channel: message.channel.id });
  }
}

/**
 * Force-clean a fixed embed reply (e.g. when the original message is deleted).
 */
export async function handleFixedEmbedCleanup(channel, messageId) {
  const record = fixedEmbedTracker.get(messageId);
  if (!record) return;

  try {
    const botReply = await channel.messages.fetch(record.botReplyId).catch(() => null);
    if (botReply) await botReply.delete().catch(() => {});
  } catch (err) {
    // Silent fail if already deleted
  } finally {
    fixedEmbedTracker.delete(messageId);
  }
}

