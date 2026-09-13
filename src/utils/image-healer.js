import { EmbedBuilder } from 'discord.js';
import { sysLog, sysError } from './logger.js';
import { sanitizeEmbed } from './embed-sanitizer.js';

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
 * Perform a lightweight HTTP HEAD request to verify a URL is reachable.
 * Returns true if the server responds with 2xx, false otherwise.
 *
 * @param {string} url
 * @returns {Promise<{ok: boolean, status: number|null, reason: string}>}
 */
async function checkUrlReachable(url) {
  if (!url || typeof url !== 'string') return { ok: false, status: null, reason: 'empty_url' };
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    let res = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'follow'
    }).catch(() => null);

    // If HEAD method is rejected (e.g. 405 Method Not Allowed), retry with GET
    if (!res || res.status === 405) {
      res = await fetch(url, {
        method: 'GET',
        headers: { 'Range': 'bytes=0-0' },
        signal: controller.signal,
        redirect: 'follow'
      }).catch(() => null);
    }

    clearTimeout(timeout);
    if (res && (res.ok || res.status === 206 || res.status === 304)) {
      return { ok: true, status: res.status, reason: 'ok' };
    }
    return { ok: false, status: res?.status ?? null, reason: res ? `http_${res.status}` : 'network_error' };
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'timeout' : (err.code || err.message || 'network_error');
    return { ok: false, status: null, reason };
  }
}

/**
 * Verify image loading in public Discord bot messages.
 * If Discord's media proxy has not indexed the image after initial send,
 * performs a clean re-edit to nudge the proxy. If the image URL itself is
 * broken (404, DNS failure, etc.), aborts immediately without retrying.
 *
 * All operations are invisible to users — no public messages, no embed text
 * changes, no visible retries. Only internal console logging.
 *
 * @param {import('discord.js').Message} message - The message to verify
 * @param {Object} [options={}]
 * @param {number} [options.maxAttempts=4] - Maximum verification checks (default: 4)
 * @param {number} [options.initialDelayMs=2000] - Delay before first inspection (default: 2000ms)
 * @param {number} [options.retryDelayMs=3000] - Delay between subsequent checks (default: 3000ms)
 * @param {string|null} [options.expectedImageUrl] - Known-good image URL from DB
 * @param {string|null} [options.expectedThumbnailUrl] - Known-good thumbnail URL from DB
 */
export function verifyAndHealMessageImages(message, options = {}) {
  if (!message || !message.channel || !message.guild || !message.id) return;
  if (!message.embeds || message.embeds.length === 0) return;

  // Bot can only edit its own messages
  if (message.author?.id && message.client?.user?.id && message.author.id !== message.client.user.id) {
    return;
  }

  // Extract expected media URLs from the original message embeds,
  // with caller-provided overrides taking priority
  const expectedMedia = message.embeds.map((e, idx) => ({
    imageUrl: (idx === 0 && options.expectedImageUrl) || e.image?.url || null,
    thumbUrl: (idx === 0 && options.expectedThumbnailUrl) || e.thumbnail?.url || null
  }));

  const hasExpectedMedia = expectedMedia.some(m => Boolean(m.imageUrl || m.thumbUrl));
  if (!hasExpectedMedia) return;

  // Run asynchronously in background so we do not block caller
  (async () => {
    try {
      const maxAttempts = options.maxAttempts || 4;
      const initialDelayMs = options.initialDelayMs ?? 2000;
      const retryDelayMs = options.retryDelayMs ?? 3000;

      if (initialDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, initialDelayMs));
      }

      // URL reachability pre-check: abort early if the URL itself is broken
      let urlsVerified = false;
      for (const media of expectedMedia) {
        for (const url of [media.imageUrl, media.thumbUrl]) {
          if (!url) continue;
          const check = await checkUrlReachable(url);
          if (!check.ok) {
            sysError('Image URL Unreachable — Aborting Healer', null, {
              guild: message.guildId,
              channel: message.channelId,
              messageId: message.id,
              url,
              status: check.status,
              reason: check.reason
            });
            return; // Abort entirely — no point retrying a dead link
          }
        }
      }
      urlsVerified = true;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // Fetch latest state from Discord API
        const freshMsg = await message.channel.messages.fetch(message.id).catch(() => null);
        if (!freshMsg || !freshMsg.embeds || freshMsg.embeds.length === 0) return;

        const allLoaded = freshMsg.embeds.every((e, idx) =>
          isEmbedMediaLoaded(e, expectedMedia[idx] || {})
        );

        if (allLoaded) {
          sysLog('Embed Image Verified', {
            guild: message.guildId,
            channel: message.channelId,
            detail: `Message ${message.id} media verified on attempt ${attempt}`
          });
          return;
        }

        // Re-edit with sanitized embed to nudge Discord's proxy
        if (attempt >= 2) {
          const rebuiltEmbeds = freshMsg.embeds.map((e, idx) => {
            const media = expectedMedia[idx] || {};
            const b = sanitizeEmbed(e);
            // Re-apply expected URLs if Discord has stripped them
            if (media.imageUrl && !b.data.image?.url) b.setImage(media.imageUrl);
            if (media.thumbUrl && !b.data.thumbnail?.url) b.setThumbnail(media.thumbUrl);
            return b;
          });

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
          // Final attempt: one last forced edit with known-good URLs
          if (urlsVerified) {
            const finalEmbeds = freshMsg.embeds.map((e, idx) => {
              const media = expectedMedia[idx] || {};
              const b = sanitizeEmbed(e);
              if (media.imageUrl) b.setImage(media.imageUrl);
              if (media.thumbUrl) b.setThumbnail(media.thumbUrl);
              return b;
            });

            await freshMsg.edit({
              embeds: finalEmbeds,
              components: freshMsg.components
            }).catch(() => null);
          }

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
