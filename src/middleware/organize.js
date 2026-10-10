import { EmbedBuilder, ChannelType } from 'discord.js';
import { getPool } from '../storage/postgres.js';
import { sysLog, sysError } from '../utils/logger.js';

// In-memory cache: guildId -> { links_only: Set, images_only: Set, media_only: Set, cmd_only: Set, cachedAt: number }
const filterCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Allowed social media domains for "media_only" (Socials Only) rule
const SOCIAL_MEDIA_DOMAINS = [
  'youtube.com', 'youtu.be', 'www.youtube.com', 'm.youtube.com',
  'tiktok.com', 'www.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com', 'lite.tiktok.com', 'tiktokv.com',
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
        auto_react: new Set(),
        forum_auto_delete_enabled: false,
        forum_auto_delete_channels: new Set(),
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
      auto_react: new Set(Array.isArray(filters.auto_react) ? filters.auto_react : []),
      auto_react_emojis: Array.isArray(filters.auto_react_emojis) && filters.auto_react_emojis.length > 0
        ? filters.auto_react_emojis
        : ['👍', '❤️', '😂', '😭'],
      forum_auto_delete_enabled: filters.forum_auto_delete_enabled === true,
      forum_auto_delete_channels: new Set(Array.isArray(filters.forum_auto_delete_channels) ? filters.forum_auto_delete_channels : []),
      fix_embeds: !!filters.fix_embeds,
      cachedAt: Date.now()
    };
    entry.hasAnyRule = entry.links_only.size > 0 || entry.images_only.size > 0 ||
                       entry.media_only.size > 0 || entry.cmd_only.size > 0 ||
                       entry.auto_react.size > 0 || entry.forum_auto_delete_enabled;
    filterCache.set(guildId, entry);
  } catch (error) {
    sysError('Filter Cache Load Failed', error, { guild: guildId });
  }
}

/**
 * Fast-check if activity (messages/voice) should be ignored for a channel
 */
export async function isActivityIgnored(guildId, channelId) {
  if (!guildId || !channelId) return false;
  let entry = filterCache.get(guildId);
  if (!entry || Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    await loadGuildFilters(guildId);
    entry = filterCache.get(guildId);
  }
  if (!entry) return false;
  return entry.cmd_only?.has(channelId);
}

/**
 * Invalidate the filter cache for a specific guild (called when admin changes settings)
 */
export function invalidateFilterCache(guildId) {
  filterCache.delete(guildId);
  import('./emoji-filter.js')
    .then(({ invalidateEmojiBlacklistCache }) => invalidateEmojiBlacklistCache(guildId))
    .catch(() => {});
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
        if (urls.length > 0 && urls.every(url => isSocialMediaUrl(url) && isMediaPostUrl(url))) return false;
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

/**
 * Check if a URL is a valid media post (video, reel, photo, tweet) and NOT a user profile link.
 */
function isMediaPostUrl(url) {
  if (!url) return false;
  
  if (/(instagram\.com|instagr\.am)/i.test(url)) {
    return /\/(p|reel|reels|tv)\/[\w-]+/i.test(url);
  }

  if (/(tiktok\.com|tiktokv\.com)/i.test(url)) {
    return /\/(video|photo|v)\/\d+/i.test(url) || /(vt|vm)\.tiktok\.com/i.test(url) || /\/t\/[\w-]+/i.test(url);
  }

  if (/(youtube\.com|youtu\.be)/i.test(url)) {
    return /(watch\?v=|\/shorts\/|\/live\/|\/v\/|\/embed\/|youtu\.be\/)/i.test(url);
  }

  if (/(twitter\.com|x\.com)/i.test(url)) {
    return /\/status\/\d+/i.test(url);
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
 * Helper to decode HTML entities and clean Instagram title prefixes and quotes
 */
function decodeHtmlEntities(str) {
  if (!str) return '';
  let cleaned = str
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(dec))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\u200e|\u200f/g, '')
    .trim();

  // Strip "User on Instagram:" or "User on Instagram : " prefix
  cleaned = cleaned.replace(/^[^\n:]+?\s+on\s+Instagram\s*:\s*/gi, '');

  // Strip leading and trailing quotes if present
  if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
    cleaned = cleaned.slice(1, -1).trim();
  }

  // Reject generic Instagram fallbacks
  if (/Instagram photos and videos|Login • Instagram|Open in App/i.test(cleaned)) {
    return '';
  }

  return cleaned;
}

/**
 * Get active media URL for embed rendering (e.g. kkinstagram.com for Instagram)
 */
function getActiveMediaUrl(targetUrl) {
  if (/(instagram\.com|instagr\.am)/i.test(targetUrl)) {
    return targetUrl.replace(/https?:\/\/(www\.)?(instagram\.com|instagr\.am)/i, 'https://kkinstagram.com');
  }
  return targetUrl;
}

/**
 * Fast oEmbed and OpenGraph metadata extractor for YouTube, TikTok, Instagram, and web links.
 */
async function fetchMediaMetadata(targetUrl) {
  const isImageExt = /\.(jpe?g|png|webp|gif)$/i.test(targetUrl.split('?')[0]);

  try {
    // 1. Fast path for YouTube
    if (/(youtube\.com|youtu\.be)/i.test(targetUrl)) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1000);
      const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(targetUrl)}&format=json`, { signal: controller.signal }).catch(() => null);
      clearTimeout(timeout);
      if (res && res.ok) {
        const data = await res.json().catch(() => null);
        if (data && data.title) return { type: 'video', title: decodeHtmlEntities(data.title) };
      }
    }

    // 2. Fast path for TikTok
    if (/tiktok\.com/i.test(targetUrl)) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1000);
      const res = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(targetUrl)}`, { signal: controller.signal }).catch(() => null);
      clearTimeout(timeout);
      if (res && res.ok) {
        const data = await res.json().catch(() => null);
        if (data && data.title) return { type: 'video', title: decodeHtmlEntities(data.title) };
      }
    }

    // 3. Fast path for Instagram & generic web links (1.0s strict timeout)
    const fetchUrl = getActiveMediaUrl(targetUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);

    const res = await fetch(fetchUrl, {
      headers: { 'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' },
      signal: controller.signal
    }).catch(() => null);

    clearTimeout(timeout);
    if (res && res.ok) {
      const html = await res.text().catch(() => '');
      const titleMatch = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i) ||
                         html.match(/<title>([^<]+)<\/title>/i);
      const ogTypeMatch = html.match(/<meta\s+property=["']og:type["']\s+content=["']([^"']+)["']/i);
      
      const isPhotoType = isImageExt || (ogTypeMatch && /image|photo/i.test(ogTypeMatch[1]));
      const decodedTitle = titleMatch ? decodeHtmlEntities(titleMatch[1]) : null;

      return {
        type: isPhotoType ? 'image' : 'video',
        title: decodedTitle
      };
    }
  } catch (err) {}

  return { type: isImageExt ? 'image' : 'video', title: null };
}

/**
 * Check if the previous message in the channel (excluding the current user link message)
 * was sent by the bot or a webhook within the last 10 minutes.
 */
async function shouldAddSeparator(channel, currentMsgId) {
  try {
    const lastMessages = await channel.messages.fetch({ limit: 5 }).catch(() => null);
    if (!lastMessages || lastMessages.size === 0) return false;

    // Filter out the incoming user message being processed/deleted
    const otherMessages = lastMessages.filter(m => m.id !== currentMsgId);
    if (otherMessages.size === 0) return false;

    const prevMsg = otherMessages.first();
    if (!prevMsg) return false;

    const isFromBotOrWebhook = prevMsg.author.bot || !!prevMsg.webhookId;
    const isRecent = (Date.now() - prevMsg.createdTimestamp) < 10 * 60 * 1000; // < 10 minutes

    return isFromBotOrWebhook && isRecent;
  } catch (err) {
    return false;
  }
}

/**
 * Fix Embeds handler: Disabled.
 */
export async function processFixEmbeds() {
  return;
}

/**
 * Cleanup handler (retained for interface compatibility)
 */
export async function handleFixedEmbedCleanup(channel, messageId) {
  // Native embeds manage their own lifecycle
}

/**
 * Auto React handler: Automatically adds 👍, ❤️, 😂, 😭 reactions to non-bot messages sent in Auto React channels/threads/VCs.
 */
export async function processAutoReact(message) {
  const guildId = message.guild?.id;
  if (!guildId) return;

  let cached = filterCache.get(guildId);
  if (!cached || (Date.now() - cached.cachedAt > CACHE_TTL_MS)) {
    await loadGuildFilters(guildId);
    cached = filterCache.get(guildId);
  }

  if (!cached || !cached.auto_react || cached.auto_react.size === 0) return;

  const channelId = message.channel?.id;
  let parentId = message.channel?.parentId;

  // Robust parent resolution for threads missing cached parentId
  if (!parentId && message.channel?.isThread?.()) {
    try {
      const fetched = await message.client.channels.fetch(channelId).catch(() => null);
      if (fetched?.parentId) parentId = fetched.parentId;
    } catch {}
  }

  // Match current channel ID, parent ID (for threads & forum posts)
  const isDirectMatch = cached.auto_react.has(channelId);
  const isParentMatch = Boolean(parentId && cached.auto_react.has(parentId));

  if (!isDirectMatch && !isParentMatch) return;

  // If the message is inside a thread / forum post
  const isThread = Boolean(message.channel?.isThread?.());
  if (isThread) {
    let parentChannel = message.channel.parent;
    if (!parentChannel && parentId && message.guild) {
      parentChannel = message.guild.channels.cache.get(parentId)
        || await message.guild.channels.fetch(parentId).catch(() => null);
    }

    const isForumOrMedia = Boolean(
      parentChannel && (
        parentChannel.type === ChannelType.GuildForum ||
        parentChannel.type === ChannelType.GuildMedia ||
        parentChannel.type === 15 ||
        parentChannel.type === 16
      )
    );

    // If parent is a forum/media channel OR configured for auto_react,
    // ONLY react to the original post (starter message) of the thread.
    if (isForumOrMedia || isParentMatch) {
      const isOriginalPost = Boolean(
        message.id === message.channel.id ||
        (message.channel.starterMessageId && message.id === message.channel.starterMessageId) ||
        message.position === 0
      );

      if (!isOriginalPost) {
        // Do NOT auto-react to comments/replies inside the forum post
        return;
      }
    }
  }

  const emojis = Array.isArray(cached.auto_react_emojis) && cached.auto_react_emojis.length > 0
    ? cached.auto_react_emojis
    : ['👍', '❤️', '😂', '😭'];

  for (const emoji of emojis) {
    const customMatch = typeof emoji === 'string' && emoji.match(/^<a?:[a-zA-Z0-9_]+:(\d{17,20})>$/);
    const reactTarget = customMatch ? customMatch[1] : emoji;
    if (message.reactions?.cache?.get(reactTarget)?.me) continue;
    await message.react(reactTarget).catch(() => {});
  }
}

const deletingThreads = new Set();

/**
 * Check if auto-delete is enabled for a given forum/media post thread
 */
export async function shouldAutoDeleteForumPost(guildId, parentChannelId) {
  if (!guildId) return false;
  let cached = filterCache.get(guildId);
  if (!cached || (Date.now() - cached.cachedAt > CACHE_TTL_MS)) {
    await loadGuildFilters(guildId);
    cached = filterCache.get(guildId);
  }
  if (!cached || !cached.forum_auto_delete_enabled) return false;
  // If specific channels are configured, only apply to those; otherwise apply to all forum/media channels
  if (cached.forum_auto_delete_channels && cached.forum_auto_delete_channels.size > 0) {
    return cached.forum_auto_delete_channels.has(parentChannelId);
  }
  return true;
}

// Strict blocklist of all non-thread Guild Channel types that must NEVER be deleted
const FORBIDDEN_GUILD_CHANNEL_TYPES = new Set([
  ChannelType.GuildText,          // 0
  ChannelType.GuildVoice,         // 2
  ChannelType.GuildCategory,      // 4
  ChannelType.GuildAnnouncement,  // 5
  ChannelType.GuildStageVoice,    // 13
  ChannelType.GuildDirectory,     // 14
  ChannelType.GuildForum,         // 15 (Forum Channel container itself)
  ChannelType.GuildMedia,         // 16 (Media Channel container itself)
  0, 2, 4, 5, 13, 14, 15, 16
]);

/**
 * Cleanup orphaned forum/media post (ThreadChannel) if its original starter message was deleted.
 * Multi-layer safeguards ensure ONLY a child Forum/Media Post Thread (type 11) whose starter
 * message is confirmed 404-deleted can ever be removed, and NEVER a server channel.
 *
 * @param {ThreadChannel} postThread - The forum/media post thread where the starter message was deleted
 * @param {string|string[]} deletedMessageIds - Array or single ID of the deleted message(s)
 */
export async function handleOrphanedForumPostCleanup(postThread, deletedMessageIds) {
  if (!postThread || !postThread.id) return;

  // Safeguard Layer 1: Hard blocklist on any Guild Channel type
  if (postThread.type !== undefined && postThread.type !== null && FORBIDDEN_GUILD_CHANNEL_TYPES.has(postThread.type)) {
    return;
  }

  const idSet = Array.isArray(deletedMessageIds)
    ? new Set(deletedMessageIds)
    : new Set([deletedMessageIds]);

  const isStarterDeleted = idSet.has(postThread.id) ||
    (postThread.starterMessageId && idSet.has(postThread.starterMessageId));

  if (!isStarterDeleted) return;

  const threadId = postThread.id;
  if (deletingThreads.has(threadId)) return;

  if (postThread.partial || postThread.type === undefined || postThread.type === null) {
    postThread = await postThread.fetch().catch(() => null);
    if (!postThread) return;
  }

  // Safeguard Layer 2: Explicit Thread & Type verification (Must be a ThreadChannel, never a Channel)
  if (
    FORBIDDEN_GUILD_CHANNEL_TYPES.has(postThread.type) ||
    postThread.isThread?.() !== true ||
    (postThread.type !== ChannelType.PublicThread && postThread.type !== ChannelType.PrivateThread && postThread.type !== 11 && postThread.type !== 12)
  ) {
    return;
  }

  // Safeguard Layer 3: Parent-Child Snowflake Isolation
  let parentId = postThread.parentId;
  if (!parentId) {
    try {
      const fetched = await postThread.fetch().catch(() => null);
      if (fetched?.parentId) parentId = fetched.parentId;
    } catch {}
  }
  if (!parentId || parentId === postThread.id || postThread.id === postThread.guildId) {
    return;
  }

  let parentChannel = postThread.parent;
  if (!parentChannel && postThread.guild) {
    parentChannel = postThread.guild.channels.cache.get(parentId)
      || await postThread.guild.channels.fetch(parentId).catch(() => null);
  }

  // Safeguard Layer 4: Parent must strictly be a Forum or Media channel, with a distinct ID
  const isForumOrMediaParent = Boolean(
    parentChannel &&
    parentChannel.id === parentId &&
    parentChannel.id !== postThread.id && (
      parentChannel.type === ChannelType.GuildForum ||
      parentChannel.type === ChannelType.GuildMedia ||
      parentChannel.type === 15 ||
      parentChannel.type === 16
    )
  );

  if (!isForumOrMediaParent) return;

  const guildId = postThread.guild?.id || parentChannel?.guild?.id;
  if (!guildId) return;

  const isEnabled = await shouldAutoDeleteForumPost(guildId, parentId);
  if (!isEnabled) return;

  // Safeguard Layer 5: Confirm starter message (id === postThread.id) is genuinely 404-deleted on Discord
  try {
    const starterMsg = await postThread.messages.fetch(postThread.id);
    if (starterMsg) {
      // Starter message still exists — abort immediately!
      return;
    }
  } catch (verifyErr) {
    if (!verifyErr || (verifyErr.code !== 10008 && verifyErr.status !== 404)) {
      // Abort if error is anything other than 10008 Unknown Message (404)
      return;
    }
  }

  deletingThreads.add(threadId);
  setTimeout(() => deletingThreads.delete(threadId), 30000);

  try {
    const threadName = postThread.name || 'Unnamed Post';
    const parentName = parentChannel?.name || parentId;
    await postThread.delete('Auto-deleted forum post: original starter message was deleted');

    sysLog('Forum Post Auto-Deleted', {
      guild: guildId,
      threadId: postThread.id,
      threadName,
      parentId,
      parentName
    });

    const { sendLog } = await import('../utils/logger.js');
    if (postThread.guild) {
      sendLog(
        postThread.guild,
        'audit',
        'orange',
        '🗑️ Post Auto-Deleted',
        `**Channel:** <#${parentId}>\n` +
        `**Post Title:** \`${threadName}\`\n` +
        `**Reason:** Starter message was deleted`
      );
    }
  } catch (error) {
    if (error?.code === 10003) return; // Unknown Channel/Thread (already deleted)
    sysError('Forum Post Auto-Delete Failed', error, {
      guild: guildId,
      threadId: postThread.id
    });
  }
}

/**
 * Sweep existing Forum & Media channels in a guild and delete any post
 * whose original starter message has already been deleted ("Original message was deleted").
 */
export async function sweepOrphanedForumPosts(guild) {
  if (!guild?.id) return 0;

  let cached = filterCache.get(guild.id);
  if (!cached || (Date.now() - cached.cachedAt > CACHE_TTL_MS)) {
    await loadGuildFilters(guild.id);
    cached = filterCache.get(guild.id);
  }

  if (!cached || !cached.forum_auto_delete_enabled) return 0;

  const forumChannels = guild.channels.cache.filter(c =>
    c.type === ChannelType.GuildForum ||
    c.type === ChannelType.GuildMedia ||
    c.type === 15 ||
    c.type === 16
  );

  let deletedCount = 0;

  for (const forumChannel of forumChannels.values()) {
    const inScope = await shouldAutoDeleteForumPost(guild.id, forumChannel.id);
    if (!inScope) continue;

    const threadsMap = new Map();

    try {
      const activeRes = await forumChannel.threads.fetchActive().catch(() => null);
      if (activeRes?.threads) {
        for (const [id, t] of activeRes.threads) threadsMap.set(id, t);
      }
    } catch {}

    try {
      const archivedRes = await forumChannel.threads.fetchArchived({ limit: 50 }).catch(() => null);
      if (archivedRes?.threads) {
        for (const [id, t] of archivedRes.threads) threadsMap.set(id, t);
      }
    } catch {}

    for (const thread of threadsMap.values()) {
      try {
        await thread.messages.fetch(thread.id);
      } catch (err) {
        // Error code 10008 = Unknown Message (starter message was deleted)
        if (err && (err.code === 10008 || err.status === 404)) {
          await handleOrphanedForumPostCleanup(thread, [thread.id]);
          deletedCount++;
        }
      }
      await new Promise(r => setTimeout(r, 150));
    }
  }

  return deletedCount;
}


