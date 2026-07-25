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

// Tracks userMessageId -> { botReplyId, lastFixedUrls }
// Used to update or remove "Fixed Embed" replies when the user edits their message.
// Entries are auto-deleted after 1 hour.
const fixedEmbedTracker = new Map();
const TRACKER_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

// Lock to prevent concurrent reply creations during race conditions
const pendingFixes = new Set();

/**
 * Request high-quality direct video stream URL using the Cobalt API engine.
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

    if (data.url) return data.url;
    if (data.picker && Array.isArray(data.picker) && data.picker.length > 0 && data.picker[0].url) {
      return data.picker[0].url;
    }
    return null;
  } catch (err) {
    return null;
  }
}

/**
 * Replace broken social media links with working embeddable alternatives.
 * Handles both new messages and edits dynamically.
 */
export async function processFixEmbeds(message, isEdit = false) {
  const guildId = message.guild.id;

  // 1. Guard: Check if feature is enabled AND channel is configured for Socials Only (media_only)
  const cached = filterCache.get(guildId);
  if (!cached || !cached.fix_embeds || !cached.media_only.has(message.channel.id)) return;

  const content = message.content || '';
  const urlPattern = /https?:\/\/[^\s<]+/gi;
  const urls = content.match(urlPattern) || [];
  
  const fixedUrls = [];
  const targetPlatforms = [
    { name: 'tiktok', pattern: /(https?:\/\/)(www\.)?([a-z0-9]+\.)?(tiktok\.com)(?=\/|$)/i, fallback: FALLBACK_DOMAINS.tiktok },
    { name: 'instagram', pattern: /(https?:\/\/)(www\.)?([a-z0-9]+\.)?(instagram\.com)(?=\/|$)/i, fallback: FALLBACK_DOMAINS.instagram },
    { name: 'facebook', pattern: /(https?:\/\/)(www\.)?([a-z0-9]+\.)?(facebook\.com|fb\.watch)(?=\/|$)/i, fallback: FALLBACK_DOMAINS.facebook },
    { name: 'twitter', pattern: /(https?:\/\/)(www\.)?([a-z0-9]+\.)?(twitter\.com|x\.com)(?=\/|$)/i, fallback: FALLBACK_DOMAINS.twitter }
  ];

  for (let url of urls) {
    let modifiedUrl = url;

    // Clean trailing punctuation commonly attached to URLs in chat messages
    modifiedUrl = modifiedUrl.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()\]\[]+$/, (match) => {
      return match === '/' ? '/' : '';
    });

    // Expand short links (vm, vt, v) for TikTok
    if (/(https?:\/\/)(vm|vt|v)\.tiktok\.com/i.test(modifiedUrl)) {
      try {
        const response = await fetch(modifiedUrl, {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          redirect: 'follow'
        });
        if (response.url && !/(vm|vt|v)\.tiktok\.com/i.test(response.url)) {
          modifiedUrl = response.url.split('?')[0];
        }
      } catch (err) {}
    }

    const matchedPlatform = targetPlatforms.find(p => p.pattern.test(modifiedUrl));
    if (matchedPlatform) {
      // 1. Primary: Try extracting clean stream via Cobalt Engine API
      const cobaltStreamUrl = await fetchCobaltMediaUrl(modifiedUrl);
      if (cobaltStreamUrl) {
        fixedUrls.push(cobaltStreamUrl);
      } else {
        // 2. Secondary Fallback: Use reliable fallback domain proxy
        const fallbackUrl = modifiedUrl.replace(matchedPlatform.pattern, `$1${matchedPlatform.fallback}`);
        fixedUrls.push(fallbackUrl);
      }
    }
  }

  // Generate current "invisible links" string
  const currentFixedUrls = fixedUrls.map(url => `[\u2800](${url})`).join('');
  let existingRecord = fixedEmbedTracker.get(message.id);

  // If this is an edit and the reply isn't in memory, search the next 5 messages sent after it
  if (isEdit && !existingRecord) {
    try {
      const siblingMessages = await message.channel.messages.fetch({ after: message.id, limit: 5 }).catch(() => null);
      if (siblingMessages) {
        const botReplyMessage = siblingMessages.find(m => m.author.id === message.client.user.id && m.reference?.messageId === message.id);
        if (botReplyMessage) {
          existingRecord = { botReplyId: botReplyMessage.id, lastFixedUrls: botReplyMessage.content };
          fixedEmbedTracker.set(message.id, existingRecord);
        }
      }
    } catch (err) {
      // Silent fail
    }
  }

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
      // If this is an edit, do not create a new message if one wasn't found
      if (isEdit) return;

      // Prevent concurrent creations for the same message ID
      if (pendingFixes.has(message.id)) return;
      pendingFixes.add(message.id);

      try {
        botReply = await message.reply({ content: currentFixedUrls });
        fixedEmbedTracker.set(message.id, { botReplyId: botReply.id, lastFixedUrls: currentFixedUrls });
        
        // Auto-expire from map after 1 hour
        setTimeout(() => fixedEmbedTracker.delete(message.id), TRACKER_EXPIRY_MS);
      } finally {
        pendingFixes.delete(message.id);
      }
    }

    // --- SHARED VERIFICATION FLOW ---
    // Poll every 500ms up to 15 seconds (30 iterations) to see if Discord has generated the embed yet.
    // This allows the bot to be fast when Discord is fast, and patient when it's slow.
    let fetchedBotReply = null;
    let hasContentEmbed = false;

    for (let i = 0; i < 30; i++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      
      fetchedBotReply = await message.channel.messages.fetch(botReply.id).catch(() => null);
      hasContentEmbed = fetchedBotReply?.embeds.some(e => 
        e.video || e.data?.video || e.type === 'video' || 
        e.image || e.data?.image || e.thumbnail || e.data?.thumbnail
      );

      if (hasContentEmbed) {
        // Optional: If we found at least one, we can wait 1 more second to let other multi-links finish rendering
        if (fixedUrls.length > 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          fetchedBotReply = await message.channel.messages.fetch(botReply.id).catch(() => null);
        }
        break; 
      }
    }

    if (fetchedBotReply && hasContentEmbed) {
      await message.suppressEmbeds(true).catch(() => {});

      // MULTI-LINK PRUNING: If multiple links were sent, check if any failed to embed
      if (fixedUrls.length > 1) {
        const workingUrls = [];
        for (const url of fixedUrls) {
          // Does any embed's URL match this fixed URL?
          const embedExists = fetchedBotReply.embeds.some(e => 
            e.url && (e.url === url || e.url.includes(url) || url.includes(e.url)) &&
            (e.video || e.data?.video || e.type === 'video' || e.image || e.data?.image || e.thumbnail || e.data?.thumbnail)
          );
          if (embedExists) workingUrls.push(url);
        }

        // If some links failed, update the bot's reply to only show the working ones
        if (workingUrls.length > 0 && workingUrls.length < fixedUrls.length) {
          const newInvisibleLinks = workingUrls.map(u => `[\u2800](${u})`).join('');
          await fetchedBotReply.edit({ content: newInvisibleLinks }).catch(() => {});
          fixedEmbedTracker.set(message.id, { botReplyId: fetchedBotReply.id, lastFixedUrls: newInvisibleLinks });
        }
      }

    } else if (fetchedBotReply) {
      // Fail Route: 15 seconds passed and no playable content appeared.
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

