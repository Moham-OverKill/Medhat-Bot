import { EmbedBuilder } from 'discord.js';
import { sysLog, sysError } from './logger.js';

/**
 * Verify and heal image loading in public Discord messages.
 * If Discord's image proxy fails to cache/render an embed image or thumbnail,
 * the bot refreshes (re-edits) the message without creating a new one,
 * then verifies if Discord resolved it, retrying up to maxAttempts (default: 5).
 *
 * @param {import('discord.js').Message} message - The message to verify and heal
 * @param {Object} [options={}]
 * @param {number} [options.maxAttempts=5] - Maximum retry attempts (default: 5)
 * @param {number} [options.initialDelayMs=1500] - Delay before first inspection
 * @param {number} [options.retryDelayMs=2000] - Delay multiplier between retry edits
 */
export function verifyAndHealMessageImages(message, options = {}) {
  if (!message || !message.channel || !message.guild || !message.id) return;
  if (!message.embeds || message.embeds.length === 0) return;

  const maxAttempts = options.maxAttempts || 5;
  const initialDelayMs = options.initialDelayMs || 1500;
  const retryDelayMs = options.retryDelayMs || 2000;

  // Check if any embed expects an image or thumbnail
  const hasExpectedMedia = message.embeds.some(e => Boolean(e.image?.url || e.thumbnail?.url));
  if (!hasExpectedMedia) return;

  // Run asynchronously in background so we do not block caller
  (async () => {
    try {
      if (initialDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, initialDelayMs));
      }

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // Fetch latest state from Discord API
        const freshMsg = await message.channel.messages.fetch(message.id).catch(() => null);
        if (!freshMsg || !freshMsg.embeds || freshMsg.embeds.length === 0) return;

        let needsRefresh = false;

        for (const embed of freshMsg.embeds) {
          // Check large banner image
          if (embed.image?.url) {
            const isLoaded = Boolean(embed.image.proxyURL && (embed.image.width || embed.image.height));
            if (!isLoaded) {
              needsRefresh = true;
              break;
            }
          }

          // Check thumbnail
          if (embed.thumbnail?.url) {
            const isLoaded = Boolean(embed.thumbnail.proxyURL && (embed.thumbnail.width || embed.thumbnail.height));
            if (!isLoaded) {
              needsRefresh = true;
              break;
            }
          }
        }

        if (!needsRefresh) {
          if (attempt > 1) {
            sysLog('Embed Image Healed', {
              guild: message.guildId,
              channel: message.channelId,
              detail: `Message ${message.id} images loaded after ${attempt} attempts`
            });
          }
          return;
        }

        if (attempt >= maxAttempts) {
          sysLog('Embed Image Healing Exhausted', {
            guild: message.guildId,
            channel: message.channelId,
            detail: `Message ${message.id} reached max attempts (${maxAttempts})`
          });
          return;
        }

        // Refresh/re-edit message live
        const rebuiltEmbeds = freshMsg.embeds.map(e => EmbedBuilder.from(e));
        await freshMsg.edit({
          embeds: rebuiltEmbeds,
          components: freshMsg.components
        }).catch(() => null);

        sysLog('Embed Image Refresh Triggered', {
          guild: message.guildId,
          channel: message.channelId,
          detail: `Message ${message.id} refreshed (Attempt ${attempt}/${maxAttempts})`
        });

        await new Promise(resolve => setTimeout(resolve, retryDelayMs * attempt));
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
