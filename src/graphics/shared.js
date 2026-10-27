import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { logger, sysError, sysWarn, sysLog } from '../utils/logger.js';

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

export const fontStack = '"Roboto", "Cairo", "Noto Sans Arabic", "Segoe UI Emoji", "Segoe UI Symbol", "Segoe UI Historic", "Segoe UI", "MS Gothic", "Yu Gothic", "Malgun Gothic", "DejaVu Sans", Arial, sans-serif';
export const boldFontStack = '"Roboto-Bold", "Roboto", "Cairo", "Noto Sans Arabic", "Segoe UI Emoji", "Segoe UI Symbol", "Segoe UI Historic", "Segoe UI", "MS Gothic", "Yu Gothic", "Malgun Gothic", Arial, sans-serif';

/**
 * Small caps character transliteration lookup map.
 */
const SMALL_CAPS_MAP = {
  '\u1D00': 'A', '\u1D03': 'B', '\u1D04': 'C', '\u1D05': 'D', '\u1D07': 'E',
  '\u1D08': 'E', '\u1D09': 'I', '\u1D0A': 'J', '\u1D0B': 'K', '\u1D0C': 'L',
  '\u1D0D': 'M', '\u1D0E': 'N', '\u1D0F': 'O', '\u1D10': 'O', '\u1D11': 'O',
  '\u1D12': 'O', '\u1D13': 'O', '\u1D18': 'P', '\u1D19': 'Q', '\u1D1A': 'R',
  '\u1D1B': 'T', '\u1D1C': 'U', '\u1D1D': 'U', '\u1D1E': 'V', '\u1D1F': 'V',
  '\u1D20': 'W', '\u1D21': 'W', '\u1D22': 'Z',
  '\u0262': 'G', '\u029C': 'H', '\u026A': 'I', '\u029F': 'L', '\u0274': 'N',
  '\u0280': 'R', '\u028F': 'Y', '\u0299': 'B', '\u028C': 'V',
  'ᴀ': 'A', 'ʙ': 'B', 'ᴄ': 'C', 'ᴅ': 'D', 'ᴇ': 'E', 'ғ': 'F', 'ɢ': 'G', 'ʜ': 'H',
  'ɪ': 'I', 'ᴊ': 'J', 'ᴋ': 'K', 'ʟ': 'L', 'ᴍ': 'M', 'ɴ': 'N', 'ᴏ': 'O', 'ᴘ': 'P',
  'ǫ': 'Q', 'ʀ': 'R', 's': 'S', 'ᴛ': 'T', 'ᴜ': 'U', 'ᴠ': 'V', 'ᴡ': 'W', 'x': 'X',
  'ʏ': 'Y', 'ᴢ': 'Z'
};

/**
 * Lookalike unicode characters commonly produced by aesthetic text generators
 * (Canadian Syllabics, Cherokee, Armenian, CJK radicals, and Greek/Math symbols).
 * Maps visual lookalikes back to base Latin characters matching the standard Roboto font.
 */
const FANCY_LOOKALIKE_MAP = {
  // Canadian Aboriginal Syllabics (frequently used in Discord nicknames)
  'ᗩ': 'A', 'ᗷ': 'B', 'ᑕ': 'C', 'ᗪ': 'D', 'ᗡ': 'D', 'ᕼ': 'H', 'ᒍ': 'J', 'ᒪ': 'L',
  'ᗰ': 'M', 'ᑎ': 'N', 'ᑫ': 'Q', 'ᖇ': 'R', 'Տ': 'S', 'ㄒ': 'T', 'ᑌ': 'U', 'ᐯ': 'V',
  'ᗯ': 'W', '᙭': 'X', 'ㄚ': 'Y', '乙': 'Z',
  'ᗢ': 'O', 'ᗣ': 'A', 'ᗤ': 'Q', 'ᗥ': 'Q', 'ᘛ': 'E', 'ᘚ': 'E', 'ᘜ': 'G',

  // CJK Radicals / Ideographs used as visual Latin letters
  '乃': 'B', '匚': 'C', '刀': 'D', '乇': 'E', '千': 'F', '厶': 'G', '卄': 'H',
  '工': 'I', '丨': 'I', '丿': 'J', '片': 'K', '乚': 'L', '爪': 'M', '冂': 'N',
  '口': 'O', '〇': 'O', '卩': 'P', '尺': 'R', '丂': 'S', '凵': 'U', 'リ': 'V',
  '山': 'W', '乂': 'X', '入': 'A',

  // Armenian Lookalikes
  'Տ': 'S', 'տ': 't', 'հ': 'h', 'ո': 'n', 'ս': 'u', 'զ': 'q', 'ց': 'g',
  'լ': 'l', 'ժ': 'd', 'ր': 'r', 'օ': 'o', 'ռ': 'n', 'ք': 'p',

  // Cherokee Lookalikes
  'Ꭰ': 'D', 'Ꭱ': 'R', 'Ꭲ': 'T', 'Ꭳ': 'O', 'Ꭴ': 'U', 'Ꭵ': 'V', 'Ꭶ': 'S',
  'Ꭷ': 'K', 'Ꭸ': 'P', 'Ꭹ': 'y', 'Ꭺ': 'A', 'Ꭻ': 'J', 'Ꭼ': 'E', 'Ꮃ': 'W',
  'Ꮄ': 'P', 'Ꮆ': 'G', 'Ꮇ': 'M', 'Ꮉ': 'M', 'Ꮋ': 'H', 'Ꮐ': 'C', 'Ꮓ': 'Z',
  'Ꮖ': 'X', 'Ꮘ': 'P', 'Ꮙ': 'V', 'Ꮚ': 'W', 'Ꮜ': 'U', 'Ꮝ': 's', 'Ꮞ': '4',
  'Ꮟ': 'b', 'Ꮠ': 'Y', 'Ꮡ': 'y', 'Ꮢ': 'R', 'Ꮣ': 'L', 'Ꮤ': 'W', 'Ꮥ': 'S',
  'Ꮧ': 'J', 'Ꮨ': 'C', 'Ꮩ': 'V', 'Ꮪ': 'S', 'Ꮯ': 'C', 'Ꮹ': 'G', 'Ꮺ': 'P',
  'Ꮼ': 'O', 'Ᏻ': 'G', 'Ᏼ': 'B',

  // Common Greek lookalikes in nicknames
  'Δ': 'A', 'Λ': 'A', 'λ': 'l', 'β': 'b', 'θ': 'o', 'μ': 'u', 'π': 'n',
  'ρ': 'p', 'σ': 'o', 'Σ': 'E', 'τ': 't', 'φ': 'o', 'ψ': 'y', 'ω': 'w', 'Ω': 'O',

  // Math / Misc symbols used as letters
  '∀': 'A', '¢': 'c', '©': 'c', '®': 'r', '§': 's', '†': 't', '‡': 't',
  'ℓ': 'l', 'ø': 'o', 'Ø': 'O', 'Ǝ': 'E', 'ǝ': 'e', 'Ƹ': 'E', 'Ʒ': 'Z'
};

/**
 * Sanitize and normalize display names for canvas rendering across cards.
 * Decomposes fancy unicode fonts (Mathematical Alphanumerics, Fraktur, Fullwidth)
 * and aesthetic lookalike symbols to base Latin characters matching the standard
 * Roboto font, while preserving emojis, Arabic, legitimate CJK, and valid symbols.
 *
 * @param {string} name
 * @returns {string}
 */
export function normalizeDisplayName(name) {
  if (!name || typeof name !== 'string') return 'Unknown';

  // 1. NFKD decomposition maps Mathematical Fraktur, Bold, Script, Double-Struck, Fullwidth, Super/Subscripts to base Latin
  let str = name.normalize('NFKD');

  // 2. Small Caps transliteration
  str = str.replace(/[\u0250-\u02AF\u1D00-\u1D25ᴀ-ᴢ]/g, ch => SMALL_CAPS_MAP[ch] || ch);

  // 3. Aesthetic Lookalike Transliteration (Canadian Syllabics, Cherokee, Armenian, CJK radicals)
  str = str.replace(/./gu, ch => FANCY_LOOKALIKE_MAP[ch] || ch);

  // 4. Remove non-printable control characters, nulls, surrogate debris, private use, and zero-width spaces
  str = str.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\uFEFF\uFFF0-\uFFFF]/g, '');

  // 5. Recompose into NFC so Korean Hangul, Arabic ligatures, and standard accented letters are properly composed
  str = str.normalize('NFC');

  // 6. Collapse multiple spaces into one and trim
  str = str.replace(/\s+/g, ' ').trim();

  return str || 'Unknown';
}

/**
 * Safely extract the first grapheme/character from a string (handles surrogate pairs, emojis, and aesthetic fonts).
 * @param {string} str
 * @param {string} fallback
 * @returns {string}
 */
export function safeFirstChar(str, fallback = 'U') {
  if (!str || typeof str !== 'string') return fallback;
  const normalized = normalizeDisplayName(str);
  const trimmed = normalized.trim();
  if (!trimmed) return fallback;

  const chars = Array.from(trimmed);
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
 * Dynamically boost a color's luminance/lightness to ensure high readability on dark backgrounds,
 * while preserving its original hue and chromatic personality.
 *
 * @param {string} hex - Input hex color
 * @param {number} [targetLightness=0.76] - Minimum HSL lightness (0.0 to 1.0)
 * @returns {string} High-contrast hex color
 */
export function boostColorLuminance(hex, targetLightness = 0.76) {
  const clean = normalizeHex(hex);
  const r = parseInt(clean.slice(1, 3), 16) / 255;
  const g = parseInt(clean.slice(3, 5), 16) / 255;
  const b = parseInt(clean.slice(5, 7), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  let l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }

  if (getLuminance(clean) >= 170 || l >= targetLightness) {
    return clean;
  }

  l = targetLightness;
  s = Math.max(0.40, Math.min(s, 0.85));

  function hue2rgb(p, q, t) {
    let val = t;
    if (val < 0) val += 1;
    if (val > 1) val -= 1;
    if (val < 1 / 6) return p + (q - p) * 6 * val;
    if (val < 1 / 2) return q;
    if (val < 2 / 3) return p + (q - p) * (2 / 3 - val) * 6;
    return p;
  }

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const outR = Math.round(hue2rgb(p, q, h + 1 / 3) * 255);
  const outG = Math.round(hue2rgb(p, q, h) * 255);
  const outB = Math.round(hue2rgb(p, q, h - 1 / 3) * 255);

  return '#' + [outR, outG, outB].map(v => v.toString(16).padStart(2, '0')).join('');
}

/**
 * Extract dominant vibrant color from an image using center-weighted perceptual clustering
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

    const buckets = new Map();
    let neutralCount = 0;
    let neutralLSum = 0;
    let totalValid = 0;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = (y * size + x) * 4;
        const r = data[idx], g = data[idx + 1], b = data[idx + 2], a = data[idx + 3];
        if (a < 128) continue;

        const rNorm = r / 255, gNorm = g / 255, bNorm = b / 255;
        const max = Math.max(rNorm, gNorm, bNorm);
        const min = Math.min(rNorm, gNorm, bNorm);
        const delta = max - min;
        const l = (max + min) / 2;

        if (l < 0.08 || l > 0.95) continue;
        totalValid++;

        // Weight pixels closer to the center circle higher
        const dx = x - 23.5, dy = y - 23.5;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const centerWeight = 1.0 + Math.max(0, 1 - dist / 24) * 0.8;

        const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));

        if (s < 0.12) {
          neutralCount++;
          neutralLSum += l;
          continue;
        }

        let h = 0;
        if (delta !== 0) {
          if (max === rNorm) h = ((gNorm - bNorm) / delta) % 6;
          else if (max === gNorm) h = (bNorm - rNorm) / delta + 2;
          else h = (rNorm - gNorm) / delta + 4;
          h = Math.round(h * 60);
          if (h < 0) h += 360;
        }

        const hueBin = Math.floor(h / 22.5) % 16;
        const satBin = s < 0.35 ? 0 : (s < 0.7 ? 1 : 2);
        const lumBin = l < 0.4 ? 0 : (l < 0.65 ? 1 : 2);
        const key = (hueBin * 9) + (satBin * 3) + lumBin;

        const score = centerWeight * (1 + Math.sqrt(s)) * (1 - Math.abs(l - 0.5) * 0.7);

        const existing = buckets.get(key) || { score: 0, rSum: 0, gSum: 0, bSum: 0, count: 0 };
        existing.score += score;
        existing.rSum += r;
        existing.gSum += g;
        existing.bSum += b;
        existing.count++;
        buckets.set(key, existing);
      }
    }

    if (totalValid === 0) return null;

    let best = null;
    let maxScore = 0;
    for (const b of buckets.values()) {
      if (b.score > maxScore) {
        maxScore = b.score;
        best = b;
      }
    }

    // Fallback for monochrome / black & white avatars
    if (!best || (best.count < totalValid * 0.04 && neutralCount > totalValid * 0.6)) {
      const avgL = neutralCount > 0 ? (neutralLSum / neutralCount) : 0.5;
      return avgL >= 0.5 ? '#CBD5E1' : '#94A3B8';
    }

    let finalR = Math.round(best.rSum / best.count);
    let finalG = Math.round(best.gSum / best.count);
    let finalB = Math.round(best.bSum / best.count);

    // Ensure luminance is visible on dark theme backgrounds
    const lum = (finalR * 299 + finalG * 587 + finalB * 114) / 1000;
    if (lum < 50) {
      const boost = 50 / Math.max(1, lum);
      finalR = Math.min(255, Math.round(finalR * boost));
      finalG = Math.min(255, Math.round(finalG * boost));
      finalB = Math.min(255, Math.round(finalB * boost));
    }

    return '#' + [finalR, finalG, finalB].map(c => c.toString(16).padStart(2, '0')).join('');
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
      logger.warn('RENDER', 'External image fetch network error', {
        url: typeof url === 'string' ? url.slice(0, 100) : 'unknown',
        error: netErr?.message
      });
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
      logger.warn('RENDER', 'External image asset unavailable, falling back to placeholder', {
        url: typeof url === 'string' ? url.slice(0, 100) : 'unknown',
        status: res?.status || 'Network Error'
      });
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
  } catch (err) {
    logger.warn('RENDER', 'External image decode failed, falling back to placeholder', {
      url: typeof url === 'string' ? url.slice(0, 100) : 'buffer',
      error: err?.message || String(err)
    });
    return null;
  }
}
