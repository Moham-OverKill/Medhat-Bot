import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { sysError, sysWarn, sysLog } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fontsDir = path.resolve(__dirname, '../assets/fonts');

// Centralized font registration for consistent cross-platform and Docker rendering
try {
  const boldPath = path.join(fontsDir, 'Roboto-Bold.ttf');
  const regularPath = path.join(fontsDir, 'Roboto-Regular.ttf');
  const cairoPath = path.join(fontsDir, 'Cairo.ttf');
  const notoPath = path.join(fontsDir, 'NotoSansArabic.ttf');
  const emojiPath = path.join(fontsDir, 'seguiemj.ttf');

  if (fs.existsSync(boldPath)) {
    GlobalFonts.registerFromPath(boldPath, 'Roboto-Bold');
    GlobalFonts.registerFromPath(boldPath, 'Roboto');
  }
  if (fs.existsSync(regularPath)) {
    GlobalFonts.registerFromPath(regularPath, 'Roboto');
  }
  if (fs.existsSync(cairoPath)) {
    GlobalFonts.registerFromPath(cairoPath, 'Cairo');
  }
  if (fs.existsSync(notoPath)) {
    GlobalFonts.registerFromPath(notoPath, 'Noto Sans Arabic');
    GlobalFonts.registerFromPath(notoPath, 'NotoSansArabic');
  }
  if (fs.existsSync(emojiPath)) {
    GlobalFonts.registerFromPath(emojiPath, 'Segoe UI Emoji');
  }
} catch (err) {
  sysError('Shared Font Registration Error', err);
}

export const fontStack = '"Roboto", "Cairo", "Noto Sans Arabic", "Segoe UI Emoji", "Segoe UI", "DejaVu Sans", Arial, sans-serif';
export const boldFontStack = '"Roboto-Bold", "Roboto", "Cairo", "Noto Sans Arabic", "Segoe UI Emoji", "Segoe UI", Arial, sans-serif';

/**
 * Safely extract the first grapheme/character from a string (handles surrogate pairs and emojis).
 * @param {string} str
 * @param {string} fallback
 * @returns {string}
 */
export function safeFirstChar(str, fallback = 'U') {
  if (!str || typeof str !== 'string') return fallback;
  const chars = Array.from(str.trim());
  return chars.length > 0 ? chars[0] : fallback;
}

/**
 * Format numbers with compact suffixes (e.g. 1.5K, 2.3M, 1.2B, 10T)
 * @param {number|string} num
 * @returns {string}
 */
export function formatCompactNumber(num) {
  const n = Number(num) || 0;
  if (Math.abs(n) >= 1_000_000_000_000) return (n / 1_000_000_000_000).toFixed(1).replace(/\.0$/, '') + 'T';
  if (Math.abs(n) >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1).replace(/\.0$/, '') + 'B';
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (Math.abs(n) >= 10_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  return n.toLocaleString();
}

/**
 * Draw a rounded rectangle path on 2D context
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} width
 * @param {number} height
 * @param {number|{tl: number, tr: number, br: number, bl: number}} radius
 */
export function roundRect(ctx, x, y, width, height, radius) {
  let r;
  if (typeof radius === 'number') {
    r = { tl: radius, tr: radius, br: radius, bl: radius };
  } else {
    r = {
      tl: radius?.tl || 0,
      tr: radius?.tr || 0,
      br: radius?.br || 0,
      bl: radius?.bl || 0
    };
  }
  const maxR = Math.min(width / 2, height / 2);
  const tl = Math.max(0, Math.min(r.tl, maxR));
  const tr = Math.max(0, Math.min(r.tr, maxR));
  const br = Math.max(0, Math.min(r.br, maxR));
  const bl = Math.max(0, Math.min(r.bl, maxR));

  ctx.beginPath();
  ctx.moveTo(x + tl, y);
  ctx.lineTo(x + width - tr, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + tr);
  ctx.lineTo(x + width, y + height - br);
  ctx.quadraticCurveTo(x + width, y + height, x + width - br, y + height);
  ctx.lineTo(x + bl, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - bl);
  ctx.lineTo(x, y + tl);
  ctx.quadraticCurveTo(x, y, x + tl, y);
  ctx.closePath();
}

/**
 * Draw a crisp golden coin vector on canvas
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x - Center X
 * @param {number} y - Center Y
 * @param {number} radius - Coin radius
 */
export function drawVectorCoin(ctx, x, y, radius) {
  ctx.save();
  // Outer gold rim
  const outerGrad = ctx.createLinearGradient(x - radius, y - radius, x + radius, y + radius);
  outerGrad.addColorStop(0, '#FFE875');
  outerGrad.addColorStop(0.5, '#F5A623');
  outerGrad.addColorStop(1, '#B87400');
  ctx.fillStyle = outerGrad;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();

  // Inner coin ridge
  const innerRadius = radius * 0.82;
  const innerGrad = ctx.createLinearGradient(x - innerRadius, y - innerRadius, x + innerRadius, y + innerRadius);
  innerGrad.addColorStop(0, '#F7B731');
  innerGrad.addColorStop(1, '#D48806');
  ctx.fillStyle = innerGrad;
  ctx.beginPath();
  ctx.arc(x, y, innerRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Coin star/dollar symbol in center
  ctx.fillStyle = '#FFF8DB';
  ctx.font = `bold ${Math.round(radius * 1.05)}px ${fontStack}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('$', x, y + 0.5);
  ctx.restore();
}

/**
 * Convert hex color to rgba string
 * @param {string} hex
 * @param {number} alpha
 * @returns {string}
 */
export function hexToRgba(hex, alpha = 1) {
  let clean = String(hex || '#00E5FF').replace('#', '');
  if (clean.length === 3) {
    clean = clean.split('').map(c => c + c).join('');
  }
  const num = parseInt(clean, 16);
  if (isNaN(num)) return `rgba(0, 229, 255, ${alpha})`;
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Shift hex color brightness by a percentage (-1.0 to 1.0)
 * @param {string} hex
 * @param {number} percent
 * @returns {string}
 */
export function shiftColorBrightness(hex, percent) {
  let clean = String(hex || '#00E5FF').replace('#', '');
  if (clean.length === 3) clean = clean.split('').map(c => c + c).join('');
  const num = parseInt(clean, 16);
  if (isNaN(num)) return '#0099FF';
  let r = (num >> 16) & 255;
  let g = (num >> 8) & 255;
  let b = num & 255;
  r = Math.min(255, Math.max(0, Math.round(r * (1 + percent))));
  g = Math.min(255, Math.max(0, Math.round(g * (1 + percent))));
  b = Math.min(255, Math.max(0, Math.round(b * (1 + percent))));
  return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
}

/**
 * Check and clean hex color string
 * @param {string} hex
 * @returns {string}
 */
export function normalizeHex(hex) {
  if (!hex || typeof hex !== 'string') return '#80848E';
  let cleaned = hex.trim();
  if (!cleaned.startsWith('#')) cleaned = '#' + cleaned;
  if (cleaned.length === 4) {
    cleaned = '#' + cleaned[1] + cleaned[1] + cleaned[2] + cleaned[2] + cleaned[3] + cleaned[3];
  }
  if (/^#([0-9A-Fa-f]{6})$/.test(cleaned)) {
    return cleaned;
  }
  return '#80848E';
}

/**
 * Convert integer color or raw hex to standard #RRGGBB
 * @param {number|string} val
 * @returns {string|null}
 */
export function toHexColor(val) {
  if (typeof val === 'number') {
    return '#' + val.toString(16).padStart(6, '0');
  }
  if (typeof val === 'string') {
    return normalizeHex(val);
  }
  return null;
}

/**
 * Calculate relative luminance (YIQ) of a hex color
 * @param {string} hex
 * @returns {number}
 */
export function getLuminance(hex) {
  const cleaned = normalizeHex(hex);
  const r = parseInt(cleaned.slice(1, 3), 16) || 0;
  const g = parseInt(cleaned.slice(3, 5), 16) || 0;
  const b = parseInt(cleaned.slice(5, 7), 16) || 0;
  return ((r * 299) + (g * 587) + (b * 114)) / 1000;
}

/**
 * Determine contrast text color (white or black) based on color luminance
 * @param {string|number} hexOrLum
 * @returns {string}
 */
export function getContrastTextColor(hexOrLum) {
  const lum = typeof hexOrLum === 'number' ? hexOrLum : getLuminance(hexOrLum);
  return lum >= 140 ? '#000000' : '#FFFFFF';
}

/**
 * Extract dominant vibrant color from an image
 * @param {import('@napi-rs/canvas').Image} img
 * @returns {string|null}
 */
export function extractDominantColor(img) {
  if (!img) return null;
  try {
    const size = 48;
    const offCanvas = createCanvas(size, size);
    const offCtx = offCanvas.getContext('2d');
    offCtx.drawImage(img, 0, 0, size, size);
    const { data } = offCtx.getImageData(0, 0, size, size);

    const colorCounts = new Map();
    let maxScore = 0;
    let dominant = null;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];

      if (a < 128) continue;

      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const delta = max - min;
      const brightness = (r + g + b) / 3;

      if (brightness < 30 || brightness > 235) continue;
      if (delta < 20) continue;

      const qr = Math.min(255, Math.round(r / 16) * 16);
      const qg = Math.min(255, Math.round(g / 16) * 16);
      const qb = Math.min(255, Math.round(b / 16) * 16);
      const key = (qr << 16) | (qg << 8) | qb;

      const saturation = delta / max;
      const score = (colorCounts.get(key) || 0) + (1 + saturation * 2.5);
      colorCounts.set(key, score);

      if (score > maxScore) {
        maxScore = score;
        dominant = { r: qr, g: qg, b: qb };
      }
    }

    if (!dominant) return null;
    return '#' + [dominant.r, dominant.g, dominant.b].map(x => x.toString(16).padStart(2, '0')).join('');
  } catch (_) {
    return null;
  }
}

/**
 * Extract coin color from custom coin image or fallback
 * @param {import('@napi-rs/canvas').Image} img
 * @param {string} fallback
 * @returns {string}
 */
export function extractCoinColor(img, fallback = '#F59E0B') {
  if (!img) return fallback;
  return extractDominantColor(img) || fallback;
}

/**
 * Normalize any image input (direct HTTP URL, Discord custom emoji, snowflake ID, or Unicode emoji)
 * into a renderable image URL.
 * @param {string|null} input
 * @returns {string|null}
 */
export function normalizeToImageUrl(input) {
  if (!input || typeof input !== 'string') return null;
  const str = input.trim();
  if (!str || str.toLowerCase() === 'none' || str.toLowerCase() === 'null') return null;

  if (str.startsWith('http://') || str.startsWith('https://')) {
    return str;
  }

  const customEmojiMatch = str.match(/<a?:[a-zA-Z0-9_]+:(\d+)>/);
  if (customEmojiMatch && customEmojiMatch[1]) {
    return `https://cdn.discordapp.com/emojis/${customEmojiMatch[1]}.png?size=128&quality=lossless`;
  }

  if (/^\d{17,22}$/.test(str)) {
    return `https://cdn.discordapp.com/emojis/${str}.png?size=128&quality=lossless`;
  }

  const isEmoji = /^(\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Emoji}\uFE0F|\u200D|\p{Emoji_Modifier})+$/u.test(str);
  if (!isEmoji) {
    return null;
  }

  const codePoints = [];
  for (const sym of str) {
    codePoints.push(sym.codePointAt(0).toString(16));
  }
  const filtered = codePoints.filter(c => c !== 'fe0f');
  const code = (filtered.length > 0 ? filtered : codePoints).join('-');
  if (code && code.length > 0) {
    return `https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/${code}.png`;
  }

  return null;
}

// Global in-memory image cache with TTL and LRU eviction
const imageCache = new Map();
const IMAGE_CACHE_MAX = 100;
const IMAGE_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

/**
 * Safely fetch an external image with in-memory caching, User-Agent header,
 * Discord emoji normalization, CDN fallback, and local path/buffer support.
 * @param {string|Buffer|null} rawUrl
 * @returns {Promise<import('@napi-rs/canvas').Image|null>}
 */
export async function fetchImageSafe(rawUrl) {
  if (!rawUrl) return null;

  // Buffer handling (not cached by string key unless converted)
  if (Buffer.isBuffer(rawUrl)) {
    try {
      return await loadImage(rawUrl);
    } catch {
      return null;
    }
  }

  const url = (typeof rawUrl === 'string' ? normalizeToImageUrl(rawUrl) : null) || rawUrl;
  if (!url || typeof url !== 'string') return null;

  const now = Date.now();
  const cached = imageCache.get(url);
  if (cached && (now - cached.timestamp < IMAGE_CACHE_TTL)) {
    return cached.img;
  }

  try {
    // Local filesystem path support
    if (url.startsWith('/') || url.includes(':\\') || url.includes(':/') || url.startsWith('file://')) {
      const cleanPath = url.replace('file://', '');
      if (fs.existsSync(cleanPath)) {
        const img = await loadImage(cleanPath);
        if (imageCache.size >= IMAGE_CACHE_MAX) {
          const oldestKey = imageCache.keys().next().value;
          imageCache.delete(oldestKey);
        }
        imageCache.set(url, { img, timestamp: now });
        return img;
      }
    }

    // Network fetch with browser User-Agent to avoid CDN 403 Forbidden
    let res = null;
    try {
      res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        signal: AbortSignal.timeout(4000)
      });
    } catch (netErr) {
      sysWarn('Image Primary Fetch Network Error', { url: url.slice(0, 120), error: netErr?.message });
    }

    // Twemoji fallback CDN if cdnjs fails
    if (!res || !res.ok) {
      if (url.includes('cdnjs.cloudflare.com/ajax/libs/twemoji/')) {
        const fallbackUrl = url.replace(
          'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/',
          'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/'
        );
        try {
          const fbRes = await fetch(fallbackUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            signal: AbortSignal.timeout(4000)
          });
          if (fbRes.ok) {
            const fbBuffer = await fbRes.arrayBuffer();
            const img = await loadImage(Buffer.from(fbBuffer));
            if (imageCache.size >= IMAGE_CACHE_MAX) {
              const oldest = imageCache.keys().next().value;
              imageCache.delete(oldest);
            }
            imageCache.set(url, { img, timestamp: now });
            return img;
          }
        } catch (_) {}
      }
      return null;
    }

    const arrayBuffer = await res.arrayBuffer();
    const img = await loadImage(Buffer.from(arrayBuffer));

    if (imageCache.size >= IMAGE_CACHE_MAX) {
      const oldestKey = imageCache.keys().next().value;
      imageCache.delete(oldestKey);
    }
    imageCache.set(url, { img, timestamp: now });
    return img;
  } catch (_) {
    return null;
  }
}
