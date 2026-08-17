/**
 * Image Cache Utility
 *
 * Fetches external image URLs as raw buffers, stores them in-memory,
 * and returns Discord AttachmentBuilder instances for native embed attachment.
 *
 * This eliminates Discord media proxy latency on third-party hosts (e.g. ImgBB)
 * by uploading the image buffer directly with the message payload, causing Discord
 * to serve it from cdn.discordapp.com instantly with zero external dependency.
 *
 * Cache Strategy:
 * - Keyed by URL string (exact match).
 * - Max 200 entries. When full, evicts the oldest 20 entries (LRU-lite).
 * - Failed fetches are NOT cached (allows retry on next render).
 * - Fetch timeout: 5 seconds (aborts and falls back gracefully on timeout).
 */

import { AttachmentBuilder } from 'discord.js';

/** @type {Map<string, { buffer: Buffer, ts: number }>} */
const imageCache = new Map();

const MAX_CACHE_SIZE = 200;
const FETCH_TIMEOUT_MS = 5000;

/**
 * Resolves an external image URL to a Discord AttachmentBuilder and attachment URI.
 * Falls back gracefully to null if the fetch fails or the URL is invalid.
 *
 * @param {string|null|undefined} url    - The external image URL to fetch
 * @param {string}               filename - The attachment filename (e.g. 'chest.png')
 * @returns {Promise<{ attachment: AttachmentBuilder, uri: string } | null>}
 */
export async function resolveImageAttachment(url, filename) {
  if (!url || typeof url !== 'string' || !url.startsWith('http')) return null;

  try {
    // 1. Cache hit — bump LRU timestamp and return immediately
    if (imageCache.has(url)) {
      const cached = imageCache.get(url);
      cached.ts = Date.now();
      const attachment = new AttachmentBuilder(cached.buffer, { name: filename });
      return { attachment, uri: `attachment://${filename}` };
    }

    // 2. Fetch with abort timeout
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let res;
    try {
      res = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) return null;

    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // 3. Evict oldest 20 entries when at capacity
    if (imageCache.size >= MAX_CACHE_SIZE) {
      const entries = [...imageCache.entries()].sort((a, b) => a[1].ts - b[1].ts);
      for (let i = 0; i < 20; i++) imageCache.delete(entries[i][0]);
    }

    // 4. Store in cache
    imageCache.set(url, { buffer, ts: Date.now() });

    const attachment = new AttachmentBuilder(buffer, { name: filename });
    return { attachment, uri: `attachment://${filename}` };

  } catch {
    // Timeout, network error, or invalid response — fail silently
    return null;
  }
}

/**
 * Invalidates a specific URL from the image cache.
 * Call this when an admin updates or removes an image URL so the next
 * render fetches the new image instead of serving the old cached buffer.
 *
 * @param {string|null|undefined} url
 */
export function invalidateImageCache(url) {
  if (url) imageCache.delete(url);
}
