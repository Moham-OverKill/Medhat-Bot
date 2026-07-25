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

// Secondary fallback domain matrices for high availability
const FALLBACK_MATRIX = {
  tiktok: ['tnktok.com', 'vxtiktok.com'],
  instagram: ['kkinstagram.com', 'igp.app'],
  facebook: ['fixacebook.com'],
  twitter: ['fixupx.com', 'fxtwitter.com']
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
 * Tests candidate URLs sequentially until a working video player renders cleanly without errors.
 */
async function sendVerifiedVideoMessage(channel, webhook, authorUsername, authorAvatar, userId, targetUrl, candidates) {
  let sentMsg = null;
  const baseText = `shared a [video](${targetUrl})`;
  const fallbackText = webhook ? baseText : `<@${userId}> ${baseText}`;

  for (const candidateUrl of candidates) {
    const content = `${fallbackText} [\u2800](${candidateUrl})`;

    try {
      if (!sentMsg) {
        if (webhook) {
          sentMsg = await webhook.send({ username: authorUsername, avatarURL: authorAvatar, content });
        } else {
          sentMsg = await channel.send({ content });
        }
      } else {
        await sentMsg.edit({ content });
      }

      // Poll up to 3.5 seconds (7 iterations) to verify if Discord rendered a valid video embed
      let isValidVideo = false;
      let hasErrorOrNotice = false;

      for (let attempt = 0; attempt < 7; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 500));
        const refetched = await channel.messages.fetch(sentMsg.id).catch(() => null);
        if (!refetched) break;

        const embeds = refetched.embeds || [];

        hasErrorOrNotice = embeds.some(e => {
          const text = `${e.title || ''} ${e.description || ''} ${e.author?.name || ''}`;
          return /legal request|no longer available|error|not found|404/i.test(text);
        });

        isValidVideo = embeds.some(e => e.video || e.data?.video || e.type === 'video');

        if (hasErrorOrNotice) {
          isValidVideo = false;
          break; // Reject immediately on legal request / error notice
        }

        if (isValidVideo) break;
      }

      if (isValidVideo && !hasErrorOrNotice) {
        return sentMsg; // Success! Locked in working candidate.
      }
    } catch (err) {
      // Continue to next candidate
    }
  }

  // Final Fallback: Edit message to clean text hyperlink without broken proxy embeds
  if (sentMsg) {
    await sentMsg.edit({ content: fallbackText }).catch(() => {});
  } else {
    if (webhook) {
      sentMsg = await webhook.send({ username: authorUsername, avatarURL: authorAvatar, content: fallbackText });
    } else {
      sentMsg = await channel.send({ content: fallbackText });
    }
  }
  return sentMsg;
}

/**
 * Custom Fix Embeds handler: Deletes original user message and posts a standalone custom embed
 * via Webhook using the user's avatar and name, with sequential 3-tier video/image verification.
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

    // Build candidate list for video testing in order
    const candidateUrls = [];
    if (mediaInfo?.url && mediaInfo.type !== 'image') {
      candidateUrls.push(mediaInfo.url);
    }

    const platformRules = [
      { name: 'tiktok', pattern: /(https?:\/\/)(www\.)?([a-z0-9]+\.)?(tiktok\.com)(?=\/|$)/i, matrix: FALLBACK_MATRIX.tiktok },
      { name: 'instagram', pattern: /(https?:\/\/)(www\.)?([a-z0-9]+\.)?(instagram\.com)(?=\/|$)/i, matrix: FALLBACK_MATRIX.instagram },
      { name: 'facebook', pattern: /(https?:\/\/)(www\.)?([a-z0-9]+\.)?(facebook\.com|fb\.watch)(?=\/|$)/i, matrix: FALLBACK_MATRIX.facebook },
      { name: 'twitter', pattern: /(https?:\/\/)(www\.)?([a-z0-9]+\.)?(twitter\.com|x\.com)(?=\/|$)/i, matrix: FALLBACK_MATRIX.twitter }
    ];

    const matchedPlatform = platformRules.find(p => p.pattern.test(targetUrl));
    if (matchedPlatform && matchedPlatform.matrix) {
      for (const domain of matchedPlatform.matrix) {
        const proxyUrl = targetUrl.replace(matchedPlatform.pattern, `$1${domain}`);
        if (!candidateUrls.includes(proxyUrl)) {
          candidateUrls.push(proxyUrl);
        }
      }
    }
    if (!candidateUrls.includes(targetUrl)) {
      candidateUrls.push(targetUrl);
    }

    const isImage = mediaInfo?.type === 'image';
    const authorUsername = message.member?.displayName || message.author.displayName || message.author.username;
    const authorAvatar = message.author.displayAvatarURL({ dynamic: true });
    const webhook = await getOrCreateWebhook(message.channel);

    let sentMsg;

    if (isImage) {
      const embed = new EmbedBuilder()
        .setColor('#2B2D31')
        .setDescription(`shared an [image](${targetUrl})`);

      if (mediaInfo?.url) {
        embed.setImage(mediaInfo.url);
      }

      if (webhook) {
        sentMsg = await webhook.send({ username: authorUsername, avatarURL: authorAvatar, embeds: [embed] });
      } else {
        sentMsg = await message.channel.send({ content: `<@${message.author.id}> shared an [image](${targetUrl})`, embeds: [embed] });
      }
    } else {
      // Sequential video verification engine
      sentMsg = await sendVerifiedVideoMessage(message.channel, webhook, authorUsername, authorAvatar, message.author.id, targetUrl, candidateUrls);
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
