import { EmbedBuilder, ActionRowBuilder } from 'discord.js';
import { sysLog, sysError } from './logger.js';

/**
 * Checks whether all images and thumbnails inside an embed have been resolved
 * by Discord's media proxy with valid dimensions.
 *
 * @param {import('discord.js').Embed} embed
 * @returns {boolean}
 */
function isEmbedMediaLoaded(embed) {
  if (embed.image?.url) {
    const hasProxy = Boolean(embed.image.proxyURL);
    const hasDimensions = Boolean(embed.image.width || embed.image.height);
    if (!hasProxy || !hasDimensions) return false;
  }
  if (embed.thumbnail?.url) {
    const hasProxy = Boolean(embed.thumbnail.proxyURL);
    const hasDimensions = Boolean(embed.thumbnail.width || embed.thumbnail.height);
    if (!hasProxy || !hasDimensions) return false;
  }
  return true;
}

/**
 * Verify and heal image loading in public Discord bot messages.
 *
 * Background: When Discord sends MESSAGE_CREATE to clients upon message creation,
 * Discord's media proxy has often not yet resolved or measured external image URLs.
 * Once Discord's proxy completes caching in the database, Discord DOES NOT dispatch
 * a MESSAGE_UPDATE gateway event. Connected clients therefore continue displaying
 * collapsed or unrendered images until an edit event is explicitly triggered.
 *
 * This function polls the Discord API in the background until the proxy metadata
 * (proxyURL and width/height) is verified, then dispatches a single live message
 * edit to broadcast MESSAGE_UPDATE to all connected clients.
 *
 * @param {import('discord.js').Message} message - The message to verify and heal
 * @param {Object} [options={}]
 * @param {number} [options.maxAttempts=6] - Maximum verification attempts (default: 6)
 * @param {number} [options.initialDelayMs=1500] - Delay before first inspection (default: 1500ms)
 * @param {number} [options.retryDelayMs=1500] - Delay between subsequent checks (default: 1500ms)
 */
export function verifyAndHealMessageImages(message, options = {}) {
  if (!message || !message.channel || !message.guild || !message.id) return;
  if (!message.embeds || message.embeds.length === 0) return;

  // Bot can only edit its own messages
  if (message.author?.id && message.client?.user?.id && message.author.id !== message.client.user.id) {
    return;
  }

  // Check if any embed expects an image or thumbnail
  const hasExpectedMedia = message.embeds.some(e => Boolean(e.image?.url || e.thumbnail?.url));
  if (!hasExpectedMedia) return;

  // If all expected media are ALREADY verified and loaded on the provided message,
  // the client already has the dimensions and no healing or edit is needed.
  const alreadyFullyLoaded = message.embeds.every(isEmbedMediaLoaded);
  if (alreadyFullyLoaded) return;

  // Run asynchronously in background so we do not block caller
  (async () => {
    try {
      const maxAttempts = options.maxAttempts || 6;
      const initialDelayMs = options.initialDelayMs ?? 1500;
      const retryDelayMs = options.retryDelayMs ?? 1500;

      if (initialDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, initialDelayMs));
      }

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // Fetch latest state from Discord API
        const freshMsg = await message.channel.messages.fetch(message.id).catch(() => null);
        if (!freshMsg || !freshMsg.embeds || freshMsg.embeds.length === 0) return;

        const isLoaded = freshMsg.embeds.every(isEmbedMediaLoaded);

        if (isLoaded) {
          // Discord proxy has resolved and cached the image dimensions in its database.
          // We MUST edit the message so Discord broadcasts a MESSAGE_UPDATE gateway event
          // to all connected clients, forcing Discord desktop/mobile clients to render the image.
          const rebuiltEmbeds = freshMsg.embeds.map(e => EmbedBuilder.from(e));
          const rebuiltComponents = (freshMsg.components || []).map(c =>
            ActionRowBuilder.from(typeof c.toJSON === 'function' ? c.toJSON() : c)
          );

          await freshMsg.edit({
            embeds: rebuiltEmbeds,
            components: rebuiltComponents
          }).catch(() => null);

          sysLog('Embed Image Healed', {
            guild: message.guildId,
            channel: message.channelId,
            detail: `Message ${message.id} image(s) verified and refreshed after ${attempt} attempt(s)`
          });
          return;
        }

        // If not yet loaded after attempt 3, Discord's proxy scraper may need a nudge.
        // Re-editing re-queues the embed URLs in Discord's internal proxy fetcher.
        if (attempt >= 3 && attempt < maxAttempts) {
          const rebuiltEmbeds = freshMsg.embeds.map(e => EmbedBuilder.from(e));
          const rebuiltComponents = (freshMsg.components || []).map(c =>
            ActionRowBuilder.from(typeof c.toJSON === 'function' ? c.toJSON() : c)
          );

          await freshMsg.edit({
            embeds: rebuiltEmbeds,
            components: rebuiltComponents
          }).catch(() => null);

          sysLog('Embed Image Scraper Nudge', {
            guild: message.guildId,
            channel: message.channelId,
            detail: `Message ${message.id} re-edited to nudge Discord proxy (Attempt ${attempt}/${maxAttempts})`
          });
        }

        if (attempt >= maxAttempts) {
          // Final attempt: perform one last refresh edit in case resolution finished at the boundary
          const rebuiltEmbeds = freshMsg.embeds.map(e => EmbedBuilder.from(e));
          const rebuiltComponents = (freshMsg.components || []).map(c =>
            ActionRowBuilder.from(typeof c.toJSON === 'function' ? c.toJSON() : c)
          );

          await freshMsg.edit({
            embeds: rebuiltEmbeds,
            components: rebuiltComponents
          }).catch(() => null);

          sysLog('Embed Image Healing Exhausted', {
            guild: message.guildId,
            channel: message.channelId,
            detail: `Message ${message.id} reached max attempts (${maxAttempts})`
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
