/**
 * Embed Sanitizer — strips Discord's read-only gateway metadata from embeds
 * before sending them via REST API (.edit() or .send()).
 *
 * Discord's gateway injects internal properties (proxy_url, width, height,
 * type: 'rich', id) into embed objects. When these are included in a REST
 * .edit() payload, Discord's API schema validator silently strips the entire
 * image/thumbnail block from the embed, causing permanent image loss.
 *
 * This module provides a single entry point to clean any embed before dispatch.
 */
import { EmbedBuilder } from 'discord.js';

/**
 * Strip all Discord read-only gateway metadata from an embed.
 * Safe to call on EmbedBuilder instances, raw embed data objects,
 * or Discord.js Embed objects (from message.embeds[]).
 *
 * @param {EmbedBuilder|import('discord.js').Embed|Object} embed
 * @returns {EmbedBuilder} Sanitized EmbedBuilder ready for REST dispatch
 */
export function sanitizeEmbed(embed) {
  const b = embed instanceof EmbedBuilder ? embed : EmbedBuilder.from(embed);

  // Top-level read-only fields
  delete b.data.id;
  if (b.data.type === 'rich') delete b.data.type;

  // Image: keep only the URL, discard proxy_url / width / height
  if (b.data.image) {
    const url = b.data.image.url;
    if (url) {
      b.data.image = { url };
    } else {
      delete b.data.image;
    }
  }

  // Thumbnail: same treatment
  if (b.data.thumbnail) {
    const url = b.data.thumbnail.url;
    if (url) {
      b.data.thumbnail = { url };
    } else {
      delete b.data.thumbnail;
    }
  }

  // Author: keep name, url, icon_url — discard proxy_icon_url
  if (b.data.author) {
    const cleaned = { name: b.data.author.name };
    if (b.data.author.url) cleaned.url = b.data.author.url;
    if (b.data.author.icon_url) cleaned.icon_url = b.data.author.icon_url;
    b.data.author = cleaned;
  }

  // Footer: keep text, icon_url — discard proxy_icon_url
  if (b.data.footer) {
    const cleaned = { text: b.data.footer.text };
    if (b.data.footer.icon_url) cleaned.icon_url = b.data.footer.icon_url;
    b.data.footer = cleaned;
  }

  return b;
}

/**
 * Sanitize an embed reconstructed from a Discord message, optionally
 * restoring known-good image/thumbnail URLs if Discord has already
 * stripped them from the gateway embed.
 *
 * @param {EmbedBuilder|import('discord.js').Embed|Object} embed
 * @param {string|null} [expectedImageUrl] - Known-good image URL from DB
 * @param {string|null} [expectedThumbUrl] - Known-good thumbnail URL from DB
 * @returns {EmbedBuilder}
 */
export function sanitizeEmbedFromMessage(embed, expectedImageUrl, expectedThumbUrl) {
  const b = sanitizeEmbed(embed);

  // Restore image if Discord stripped it but we know the correct URL
  if (expectedImageUrl && !b.data.image?.url) {
    b.setImage(expectedImageUrl);
  }

  // Restore thumbnail if Discord stripped it
  if (expectedThumbUrl && !b.data.thumbnail?.url) {
    b.setThumbnail(expectedThumbUrl);
  }

  return b;
}
