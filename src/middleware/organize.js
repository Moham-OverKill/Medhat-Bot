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

// Secondary fallback domain replacers for high availability
const FALLBACK_DOMAINS = {
  tiktok: 'vxtiktok.com',
  instagram: 'ddinstagram.com',
  facebook: 'fixacebook.com',
  twitter: 'fixupx.com'
};

// Lock to prevent concurrent processing during race conditions
const pendingFixes = new Set();

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

/**
 * Request high-quality direct video/image stream URL using Cobalt API.
 * Returns: { type: 'video'|'image', url: string } | null
 */
async function fetchCobaltMediaUrl(targetUrl) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);

    const response = await fetch('https://api.cobalt.tools/', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      body: JSON.stringify({ url: targetUrl }),
      signal: controller.signal
    });

    clearTimeout(timeout);
    if (!response.ok) return null;
    const data = await response.json();

    if (data.status === 'picker' && Array.isArray(data.picker) && data.picker.length > 0) {
      const item = data.picker[0];
      const isPhoto = item.type === 'photo' || item.type === 'image' || /\.(jpe?g|png|webp|gif)/i.test(item.url);
      return {
        type: isPhoto ? 'image' : 'video',
        url: item.url
      };
    }

    if (data.url) {
      const isPhoto = data.status === 'photo' || data.type === 'image' || /\.(jpe?g|png|webp|gif)/i.test(data.url);
      return {
        type: isPhoto ? 'image' : 'video',
        url: data.url
      };
    }

    return null;
  } catch (err) {
    return null;
  }
}

/**
 * Custom Fix Embeds handler: Deletes original user message and posts a standalone custom embed
 * with 3-tier video/image fallbacks and sequential automated reactions.
 */
export async function processFixEmbeds(message, isEdit = false) {
  const guildId = message.guild.id;

  // Guard: Feature must be enabled AND channel configured for Socials Only (media_only)
  const cached = filterCache.get(guildId);
  if (!cached || !cached.fix_embeds || !cached.media_only.has(message.channel.id)) return;

  // Ignore edits or bot messages for custom standalone reposting
  if (isEdit || message.author.bot) return;

  const content = message.content || '';
  const urls = extractUrls(content).filter(u => isSocialMediaUrl(u));
  if (urls.length === 0) return;

  if (pendingFixes.has(message.id)) return;
  pendingFixes.add(message.id);

  try {
    const targetUrl = urls[0];
    let mediaInfo = await fetchCobaltMediaUrl(targetUrl);

    // Secondary Fallback Proxy check
    const targetPlatforms = [
      { name: 'instagram', pattern: /(https?:\/\/)(www\.)?([a-z0-9]+\.)?(instagram\.com)(?=\/|$)/i, fallback: FALLBACK_DOMAINS.instagram },
      { name: 'facebook', pattern: /(https?:\/\/)(www\.)?([a-z0-9]+\.)?(facebook\.com|fb\.watch)(?=\/|$)/i, fallback: FALLBACK_DOMAINS.facebook }
    ];

    if (!mediaInfo) {
      const matchedPlatform = targetPlatforms.find(p => p.pattern.test(targetUrl));
      if (matchedPlatform && matchedPlatform.fallback) {
        const fallbackUrl = targetUrl.replace(matchedPlatform.pattern, `$1${matchedPlatform.fallback}`);
        mediaInfo = { type: 'video', url: fallbackUrl };
      }
    }

    const isImage = mediaInfo?.type === 'image';
    const headerText = `<@${message.author.id}> shared a ${isImage ? 'image' : 'video'}:`;

    // Construct custom embed with clickable blue link
    const embed = new EmbedBuilder()
      .setColor('#2B2D31')
      .setAuthor({
        name: message.author.displayName || message.author.username,
        iconURL: message.author.displayAvatarURL({ dynamic: true })
      })
      .setDescription(`[Click to View Original Post](${targetUrl})`)
      .setURL(targetUrl);

    if (isImage && mediaInfo?.url) {
      embed.setImage(mediaInfo.url);
    }

    // Message payload: For videos, attach stream link to message content for playable player rendering
    const messagePayload = {
      content: isImage || !mediaInfo?.url 
        ? headerText 
        : `${headerText} [\u2800](${mediaInfo.url})`,
      embeds: [embed]
    };

    // Post standalone message
    const sentMsg = await message.channel.send(messagePayload);

    // Delete user's original message
    await message.delete().catch(() => {});

    // Add automated reactions sequentially: 👍, ❤️, 😂, 😭
    const emojis = ['👍', '❤️', '😂', '😭'];
    for (const emoji of emojis) {
      await sentMsg.react(emoji).catch(() => {});
    }

    // Tier 3 Validation: If video was attached, verify that Discord generated a video player card
    if (!isImage && mediaInfo?.url) {
      let hasVideoEmbed = false;
      for (let i = 0; i < 20; i++) {
        await new Promise(resolve => setTimeout(resolve, 500));
        const refetched = await message.channel.messages.fetch(sentMsg.id).catch(() => null);
        hasVideoEmbed = refetched?.embeds.some(e => e.video || e.data?.video || e.type === 'video');
        if (hasVideoEmbed) break;
      }

      // If rendering failed after 10s, edit message to remove broken stream link (Tier 3 fallback)
      if (!hasVideoEmbed) {
        await sentMsg.edit({
          content: headerText,
          embeds: [embed]
        }).catch(() => {});
      }
    }

  } catch (error) {
    sysError('Custom Fix Embed Repost Failed', error, { guild: guildId, channel: message.channel.id });
  } finally {
    pendingFixes.delete(message.id);
  }
}

/**
 * Force-clean (no-op retained for backwards interface compatibility)
 */
export async function handleFixedEmbedCleanup(channel, messageId) {
  // Standalone messages manage their own lifecycle
}
