import { EmbedBuilder } from 'discord.js';
import { sysLog, sysError } from './logger.js';

/**
 * Checks whether all expected images/thumbnails inside an embed have been resolved
 * by Discord's media proxy with valid dimensions.
 *
 * @param {import('discord.js').Embed} embed
 * @param {Object} expected - The expected media URLs from the original message
 * @returns {boolean}
 */
function isEmbedMediaLoaded(embed, expected) {
  if (expected.imageUrl) {
    if (!embed.image?.url) return false;
    const hasProxy = Boolean(embed.image.proxyURL);
    const hasDimensions = Boolean(embed.image.width || embed.image.height);
    if (!hasProxy || !hasDimensions) return false;
  }
  if (expected.thumbUrl) {
    if (!embed.thumbnail?.url) return false;
    const hasProxy = Boolean(embed.thumbnail.proxyURL);
    const hasDimensions = Boolean(embed.thumbnail.width || embed.thumbnail.height);
    if (!hasProxy || !hasDimensions) return false;
  }
  return true;
}

/**
 * Cleanly reconstructs an embed for an edit operation, stripping Discord's
 * internal read-only gateway properties (proxy_url, width, height, type)
 * that cause Discord REST API to discard the media.
 *
 * @param {import('discord.js').Embed} embed
 * @param {Object} expected - The original expected media URLs
 * @returns {EmbedBuilder}
 */
function cleanEmbedForEdit(embed, expected) {
  const b = EmbedBuilder.from(embed);
  delete b.data.id;
  delete b.data.type;

  const imgUrl = expected.imageUrl || embed.image?.url;
  if (imgUrl) {
    b.setImage(imgUrl);
  } else {
    delete b.data.image;
  }

  const thumbUrl = expected.thumbUrl || embed.thumbnail?.url;
  if (thumbUrl) {
    b.setThumbnail(thumbUrl);
  } else {
    delete b.data.thumbnail;
  }

  return b;
}

/**
 * Verify image loading in public Discord bot messages without destructive edits.
 * Only re-applies the original media URL if Discord's proxy scraper stalled.
 * Never edits messages that are already loaded.
 *
 * @param {import('discord.js').Message} message - The message to verify
 * @param {Object} [options={}]
 * @param {number} [options.maxAttempts=4] - Maximum verification checks (default: 4)
 * @param {number} [options.initialDelayMs=3000] - Delay before first inspection (default: 3000ms)
 * @param {number} [options.retryDelayMs=3000] - Delay between subsequent checks (default: 3000ms)
 */
export function verifyAndHealMessageImages(message, options = {}) {
  if (!message || !message.channel || !message.guild || !message.id) return;
  if (!message.embeds || message.embeds.length === 0) return;

  // Bot can only edit its own messages
  if (message.author?.id && message.client?.user?.id && message.author.id !== message.client.user.id) {
    return;
  }

  // Extract expected media URLs from the original message embeds
  const expectedMedia = message.embeds.map(e => ({
    imageUrl: e.image?.url || null,
    thumbUrl: e.thumbnail?.url || null
  }));

  const hasExpectedMedia = expectedMedia.some(m => Boolean(m.imageUrl || m.thumbUrl));
  if (!hasExpectedMedia) return;

  // Run asynchronously in background so we do not block caller
  (async () => {
    try {
      const maxAttempts = options.maxAttempts || 4;
      const initialDelayMs = options.initialDelayMs ?? 3000;
      const retryDelayMs = options.retryDelayMs ?? 3000;

      if (initialDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, initialDelayMs));
      }

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // Fetch latest state from Discord API
        const freshMsg = await message.channel.messages.fetch(message.id).catch(() => null);
        if (!freshMsg || !freshMsg.embeds || freshMsg.embeds.length === 0) return;

        const allLoaded = freshMsg.embeds.every((e, idx) =>
          isEmbedMediaLoaded(e, expectedMedia[idx] || {})
        );

        if (allLoaded) {
          // Media is verified and properly indexed by Discord proxy.
          // Do NOT edit the message; Discord already has the image.
          sysLog('Embed Image Verified', {
            guild: message.guildId,
            channel: message.channelId,
            detail: `Message ${message.id} media verified on attempt ${attempt}`
          });
          return;
        }

        // If after 2 checks the image is still not resolved, Discord's proxy scraper may need a nudge.
        if (attempt >= 2 && attempt < maxAttempts) {
          const rebuiltEmbeds = freshMsg.embeds.map((e, idx) =>
            cleanEmbedForEdit(e, expectedMedia[idx] || {})
          );

          await freshMsg.edit({
            embeds: rebuiltEmbeds,
            components: freshMsg.components
          }).catch(() => null);

          sysLog('Embed Image Scraper Nudge', {
            guild: message.guildId,
            channel: message.channelId,
            detail: `Message ${message.id} re-sent cleanly to nudge Discord proxy (Attempt ${attempt}/${maxAttempts})`
          });
        }

        if (attempt >= maxAttempts) {
          sysLog('Embed Image Healing Exhausted', {
            guild: message.guildId,
            channel: message.channelId,
            detail: `Message ${message.id} reached max verification attempts (${maxAttempts})`
          });
          return;
        }

        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      }
    } catch (err) {
      sysError('Image Healer Background Failure', err, {
        guild: message.guildId,
        channel: message.channelId,
        messageId: message.id
      });
    }
  })().catch(() => {});
}
