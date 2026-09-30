import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { performance } from 'node:perf_hooks';
import { sysError, sysWarn, sysLog } from '../utils/logger.js';
import { extractDominantColor } from './profileCard.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fontsDir = path.resolve(__dirname, '../assets/fonts');

// Register bundled fonts for cross-platform rendering (including Docker/Linux)
try {
  const cairoPath = path.join(fontsDir, 'Cairo.ttf');
  const notoArabicPath = path.join(fontsDir, 'NotoSansArabic.ttf');
  const boldPath = path.join(fontsDir, 'Roboto-Bold.ttf');
  const regularPath = path.join(fontsDir, 'Roboto-Regular.ttf');

  if (fs.existsSync(cairoPath)) {
    GlobalFonts.registerFromPath(cairoPath, 'Cairo');
  }
  if (fs.existsSync(notoArabicPath)) {
    GlobalFonts.registerFromPath(notoArabicPath, 'Noto Sans Arabic');
  }
  if (fs.existsSync(boldPath)) {
    GlobalFonts.registerFromPath(boldPath, 'Roboto');
  }
  if (fs.existsSync(regularPath)) {
    GlobalFonts.registerFromPath(regularPath, 'Roboto');
  }
} catch (err) {
  sysError('TradeCard Font Registration Error', err);
}

const fontStack = '"Cairo", "Noto Sans Arabic", "Roboto", "Segoe UI", "Tahoma", Arial, sans-serif';

/**
 * Draw a rounded rectangle path on 2D context
 */
function roundRect(ctx, x, y, width, height, radius) {
  if (typeof radius === 'number') {
    radius = { tl: radius, tr: radius, br: radius, bl: radius };
  } else {
    radius = {
      tl: radius?.tl || 0,
      tr: radius?.tr || 0,
      br: radius?.br || 0,
      bl: radius?.bl || 0
    };
  }
  const maxR = Math.min(width / 2, height / 2);
  const tl = Math.max(0, Math.min(radius.tl, maxR));
  const tr = Math.max(0, Math.min(radius.tr, maxR));
  const br = Math.max(0, Math.min(radius.br, maxR));
  const bl = Math.max(0, Math.min(radius.bl, maxR));

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
 * Normalize any image input (direct HTTP URL, Discord custom emoji, snowflake ID, or Unicode emoji)
 * into a renderable image URL.
 * @param {string|null} input
 * @returns {string|null}
 */
export function normalizeToImageUrl(input) {
  if (!input || typeof input !== 'string') return null;
  const str = input.trim();
  if (!str) return null;

  // Direct image URL
  if (str.startsWith('http://') || str.startsWith('https://')) {
    return str;
  }

  // Discord custom emoji: <:name:ID> or <a:name:ID>
  const customEmojiMatch = str.match(/<a?:[a-zA-Z0-9_]+:(\d+)>/);
  if (customEmojiMatch && customEmojiMatch[1]) {
    return `https://cdn.discordapp.com/emojis/${customEmojiMatch[1]}.png?size=128&quality=lossless`;
  }

  // Raw snowflake ID: 17-22 digits
  if (/^\d{17,22}$/.test(str)) {
    return `https://cdn.discordapp.com/emojis/${str}.png?size=128&quality=lossless`;
  }

  // Unicode emoji: extract code points and build Twemoji CDN URL
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

/**
 * Safely fetch an external image with timeout
 */
async function fetchImageSafe(rawUrl) {
  if (!rawUrl) return null;
  const url = (typeof rawUrl === 'string' ? normalizeToImageUrl(rawUrl) : null) || rawUrl;
  if (!url) return null;
  try {
    if (Buffer.isBuffer(url)) return await loadImage(url);
    if (typeof url === 'string' && (url.startsWith('/') || url.includes(':\\') || url.includes(':/') || url.startsWith('file://'))) {
      const cleanPath = url.replace('file://', '');
      if (fs.existsSync(cleanPath)) return await loadImage(cleanPath);
    }
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      signal: AbortSignal.timeout(4000)
    });
    if (!res.ok) {
      if (typeof url === 'string' && url.includes('cdnjs.cloudflare.com/ajax/libs/twemoji/')) {
        const fallbackUrl = url.replace('https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/', 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/');
        const fbRes = await fetch(fallbackUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
          },
          signal: AbortSignal.timeout(4000)
        });
        if (fbRes.ok) {
          const fbBuffer = await fbRes.arrayBuffer();
          return await loadImage(Buffer.from(fbBuffer));
        }
      }
      return null;
    }
    const arrayBuffer = await res.arrayBuffer();
    return await loadImage(Buffer.from(arrayBuffer));
  } catch (_) {
    return null;
  }
}

/**
 * Convert hex color to rgba string
 */
function hexToRgba(hex, alpha = 1) {
  let clean = String(hex || '#00E5FF').replace('#', '');
  if (clean.length === 3) clean = clean.split('').map(c => c + c).join('');
  const num = parseInt(clean, 16);
  if (isNaN(num)) return `rgba(0, 229, 255, ${alpha})`;
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Shift color brightness
 */
function shiftColorBrightness(hex, percent) {
  let clean = String(hex || '#00E5FF').replace('#', '');
  if (clean.length === 3) clean = clean.split('').map(c => c + c).join('');
  const num = parseInt(clean, 16);
  if (isNaN(num)) return '#0099FF';
  const r = Math.min(255, Math.max(0, Math.round(((num >> 16) & 255) * (1 + percent))));
  const g = Math.min(255, Math.max(0, Math.round(((num >> 8) & 255) * (1 + percent))));
  const b = Math.min(255, Math.max(0, Math.round((num & 255) * (1 + percent))));
  return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
}

/**
 * Extract dominant vibrant color from custom coin icon with fallback to gold
 */
export function extractCoinColor(img, fallback = '#F59E0B') {
  if (!img) return fallback;
  try {
    const dominant = extractDominantColor(img);
    if (dominant) return dominant;

    // Fallback: If extractDominantColor filtered out low-saturation/monochromatic pixels,
    // sample average RGB of non-transparent pixels
    const size = 32;
    const offCanvas = createCanvas(size, size);
    const offCtx = offCanvas.getContext('2d');
    offCtx.drawImage(img, 0, 0, size, size);
    const { data } = offCtx.getImageData(0, 0, size, size);

    let rSum = 0, gSum = 0, bSum = 0, count = 0;
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a < 128) continue;
      rSum += data[i];
      gSum += data[i + 1];
      bSum += data[i + 2];
      count++;
    }

    if (count > 0) {
      const r = Math.round(rSum / count);
      const g = Math.round(gSum / count);
      const b = Math.round(bSum / count);
      return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
    }
  } catch (err) {
    sysWarn('Failed to extract coin color, using fallback', err);
  }
  return fallback;
}

/**
 * Draw embossed golden coin vector
 */
function drawVectorCoin(ctx, x, y, radius) {
  ctx.save();
  const outerGrad = ctx.createLinearGradient(x - radius, y - radius, x + radius, y + radius);
  outerGrad.addColorStop(0, '#FFE875');
  outerGrad.addColorStop(0.5, '#F5A623');
  outerGrad.addColorStop(1, '#B87400');
  ctx.fillStyle = outerGrad;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();

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

  ctx.fillStyle = '#FFF8DB';
  ctx.font = `bold ${Math.round(radius * 1.05)}px ${fontStack}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('$', x, y + 0.5);
  ctx.restore();
}

/**
 * Draw central vector status symbol
 */
function drawExchangeIcon(ctx, centerX, centerY, status = 'pending', direction = 'both') {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (status === 'declined') {
    ctx.strokeStyle = '#EF4444';
    ctx.lineWidth = 3.5;
    const size = 12;
    ctx.beginPath();
    ctx.moveTo(centerX - size, centerY - size);
    ctx.lineTo(centerX + size, centerY + size);
    ctx.moveTo(centerX + size, centerY - size);
    ctx.lineTo(centerX - size, centerY + size);
    ctx.stroke();
  } else if (status === 'expired') {
    ctx.strokeStyle = '#64748B';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(centerX, centerY, 14, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(centerX, centerY - 8);
    ctx.lineTo(centerX, centerY);
    ctx.lineTo(centerX + 6, centerY);
    ctx.stroke();
  } else {
    const color = (status === 'completed' || status === 'accepted') ? '#10B981' : '#F59E0B';
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;

    const len = 22;
    const arrowHead = 8;

    if (direction === 'right') {
      // One-way transfer: Left -> Right
      ctx.beginPath();
      ctx.moveTo(centerX - len, centerY);
      ctx.lineTo(centerX + len, centerY);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(centerX + len - arrowHead, centerY - arrowHead);
      ctx.lineTo(centerX + len, centerY);
      ctx.lineTo(centerX + len - arrowHead, centerY + arrowHead);
      ctx.stroke();
    } else if (direction === 'left') {
      // One-way transfer: Right -> Left
      ctx.beginPath();
      ctx.moveTo(centerX + len, centerY);
      ctx.lineTo(centerX - len, centerY);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(centerX - len + arrowHead, centerY - arrowHead);
      ctx.lineTo(centerX - len, centerY);
      ctx.lineTo(centerX - len + arrowHead, centerY + arrowHead);
      ctx.stroke();
    } else {
      // Bidirectional mutual exchange
      const topY = centerY - 8;
      ctx.beginPath();
      ctx.moveTo(centerX - len, topY);
      ctx.lineTo(centerX + len, topY);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(centerX + len - arrowHead, topY - arrowHead);
      ctx.lineTo(centerX + len, topY);
      ctx.lineTo(centerX + len - arrowHead, topY + arrowHead);
      ctx.stroke();

      const botY = centerY + 8;
      ctx.beginPath();
      ctx.moveTo(centerX + len, botY);
      ctx.lineTo(centerX - len, botY);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(centerX - len + arrowHead, botY - arrowHead);
      ctx.lineTo(centerX - len, botY);
      ctx.lineTo(centerX - len + arrowHead, botY + arrowHead);
      ctx.stroke();
    }
  }

  ctx.restore();
}

const RARITY_COLORS = {
  common: '#94A3B8',
  uncommon: '#10B981',
  rare: '#3B82F6',
  epic: '#A855F7',
  legendary: '#F59E0B',
  mythic: '#EF4444'
};

/**
 * Draw an aspect-ratio preserved, cleanly clipped image inside a rounded container
 */
function drawContainedImage(ctx, img, x, y, size, radius = 6) {
  if (!img) return;
  ctx.save();
  roundRect(ctx, x, y, size, size, radius);
  ctx.clip();

  // Subtle dark background under the icon in case of transparency
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.fillRect(x, y, size, size);

  const iw = img.width || 1;
  const ih = img.height || 1;
  const ratio = Math.min(size / iw, size / ih);
  const dw = iw * ratio;
  const dh = ih * ratio;
  const dx = x + (size - dw) / 2;
  const dy = y + (size - dh) / 2;

  ctx.drawImage(img, dx, dy, dw, dh);
  ctx.restore();

  // Crisp 1px border around the thumbnail
  ctx.save();
  roundRect(ctx, x, y, size, size, radius);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

/**
 * Draw an individual item container with dynamic rarity border and mirrored item image layout
 */
function drawItemBox(ctx, x, y, width, height, item, side = 'left', loadedImg = null) {
  const cleanRarity = (item.rarity || item.tier || '').toString().toLowerCase().trim();
  const rarityColor = item.rarityColor || RARITY_COLORS[cleanRarity] || RARITY_COLORS.common;

  // Distinct item container with dynamic rarity border
  roundRect(ctx, x, y, width, height, 10);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.fill();
  ctx.strokeStyle = rarityColor;
  ctx.lineWidth = 1.4;
  ctx.stroke();

  const itemQty = parseInt(item.qty || item.quantity || 1, 10);
  const imgSize = 28;
  const pad = 7;
  const imgY = y + (height - imgSize) / 2;

  let name = item.name || 'Unknown Item';
  if (loadedImg) {
    const stripped = name.replace(/\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Emoji}\uFE0F/gu, '').trim();
    if (stripped.length > 0) name = stripped;
  }
  ctx.font = `bold 13px ${fontStack}`;
  ctx.fillStyle = '#F8FAFC';
  ctx.textBaseline = 'middle';

  if (side === 'left') {
    let textStartX = x + 10;
    let maxNameW = x + width - textStartX - 10;

    if (loadedImg) {
      // Left Panel: Item image on the far right
      const imgX = x + width - pad - imgSize;
      drawContainedImage(ctx, loadedImg, imgX, imgY, imgSize, 6);

      // Quantity pill (if > 1) on the left
      if (itemQty > 1) {
        const qtyText = `${itemQty}x`;
        ctx.font = `bold 11px ${fontStack}`;
        const qtyW = ctx.measureText(qtyText).width + 10;
        roundRect(ctx, textStartX, y + (height - 18) / 2, qtyW, 18, 5);
        ctx.fillStyle = 'rgba(56, 189, 248, 0.2)';
        ctx.fill();
        ctx.strokeStyle = '#38BDF8';
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.fillStyle = '#7DD3FC';
        ctx.textAlign = 'center';
        ctx.fillText(qtyText, textStartX + qtyW / 2, y + height / 2);

        textStartX += qtyW + 6;
      }

      maxNameW = (imgX - 6) - textStartX;
    } else {
      // No image configured: Clean text-only display
      if (itemQty > 1) {
        const qtyText = `${itemQty}x`;
        ctx.font = `bold 11px ${fontStack}`;
        const qtyW = ctx.measureText(qtyText).width + 10;
        roundRect(ctx, textStartX, y + (height - 18) / 2, qtyW, 18, 5);
        ctx.fillStyle = 'rgba(56, 189, 248, 0.2)';
        ctx.fill();
        ctx.strokeStyle = '#38BDF8';
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.fillStyle = '#7DD3FC';
        ctx.textAlign = 'center';
        ctx.fillText(qtyText, textStartX + qtyW / 2, y + height / 2);

        textStartX += qtyW + 8;
      }

      maxNameW = x + width - textStartX - 10;
    }

    ctx.font = `bold 13px ${fontStack}`;
    ctx.textAlign = 'left';
    if (ctx.measureText(name).width > maxNameW) {
      while (ctx.measureText(name + '...').width > maxNameW && name.length > 0) {
        name = name.slice(0, -1);
      }
      name += '...';
    }
    ctx.fillText(name, textStartX, y + height / 2);
  } else {
    // Right Panel (Exact opposite of left): Item image on far left, text/quantity on far right
    let textEndX = x + width - 10;
    let maxNameW = textEndX - (x + 10);

    if (loadedImg) {
      const imgX = x + pad;
      drawContainedImage(ctx, loadedImg, imgX, imgY, imgSize, 6);

      // Quantity pill (if > 1) on the far right
      if (itemQty > 1) {
        const qtyText = `${itemQty}x`;
        ctx.font = `bold 11px ${fontStack}`;
        const qtyW = ctx.measureText(qtyText).width + 10;
        const qtyX = textEndX - qtyW;
        roundRect(ctx, qtyX, y + (height - 18) / 2, qtyW, 18, 5);
        ctx.fillStyle = 'rgba(56, 189, 248, 0.2)';
        ctx.fill();
        ctx.strokeStyle = '#38BDF8';
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.fillStyle = '#7DD3FC';
        ctx.textAlign = 'center';
        ctx.fillText(qtyText, qtyX + qtyW / 2, y + height / 2);

        textEndX = qtyX - 6;
      }

      maxNameW = textEndX - (imgX + imgSize + 6);
    } else {
      // No image configured: text aligned to the right
      if (itemQty > 1) {
        const qtyText = `${itemQty}x`;
        ctx.font = `bold 11px ${fontStack}`;
        const qtyW = ctx.measureText(qtyText).width + 10;
        const qtyX = textEndX - qtyW;
        roundRect(ctx, qtyX, y + (height - 18) / 2, qtyW, 18, 5);
        ctx.fillStyle = 'rgba(56, 189, 248, 0.2)';
        ctx.fill();
        ctx.strokeStyle = '#38BDF8';
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.fillStyle = '#7DD3FC';
        ctx.textAlign = 'center';
        ctx.fillText(qtyText, qtyX + qtyW / 2, y + height / 2);

        textEndX = qtyX - 8;
      }

      maxNameW = textEndX - (x + 10);
    }

    ctx.font = `bold 13px ${fontStack}`;
    ctx.textAlign = 'right';
    if (ctx.measureText(name).width > maxNameW) {
      while (ctx.measureText(name + '...').width > maxNameW && name.length > 0) {
        name = name.slice(0, -1);
      }
      name += '...';
    }
    ctx.fillText(name, textEndX, y + height / 2);
  }
}

/**
 * Generate a high-resolution, 2x Retina trade settlement card
 * @param {Object} tradeData
 * @param {string} [tradeData.status='pending'] - 'pending' | 'completed' | 'declined' | 'expired'
 * @param {string} [tradeData.expiresText='Expires in 5m']
 * @param {string|null} [tradeData.customCoinUrl=null] - Custom server coin emoji URL
 * @param {string|null} [tradeData.chestEmojiUrl=null] - Custom server chest emoji URL
 * @param {Object} tradeData.sender - { username, displayName, avatarUrl, coins, items, accentColor }
 * @param {Object} tradeData.target - { username, displayName, avatarUrl, coins, items, accentColor }
 * @returns {Promise<Buffer>} PNG image buffer
 */
export async function renderTradeCard({
  status = 'pending',
  expiresText = 'Expires in 5m',
  customCoinUrl = null,
  chestEmojiUrl = null,
  sender = {},
  target = {}
}) {
  const renderStart = performance.now();
  const senderItems = Array.isArray(sender.items) ? sender.items : [];
  const targetItems = Array.isArray(target.items) ? target.items : [];
  const senderCoins = parseInt(sender.coins, 10) || 0;
  const targetCoins = parseInt(target.coins, 10) || 0;
  const senderHasOffer = senderCoins > 0 || senderItems.length > 0;
  const targetHasOffer = targetCoins > 0 || targetItems.length > 0;

  // Determine transfer direction (one-way for free gifts / requests, bidirectional for mutual trades)
  let direction = 'both';
  if (senderHasOffer && !targetHasOffer) {
    direction = 'right'; // Left gives to Right for free
  } else if (!senderHasOffer && targetHasOffer) {
    direction = 'left';  // Right gives to Left
  } else {
    direction = 'both';  // Mutual exchange
  }

  // Calculate dynamic card height based on items and currency
  const maxPerCol = 4;
  const itemHeight = 42;
  const itemGapY = 8;
  const itemGapX = 8;

  const calcContentHeight = (coins, itemsCount) => {
    const hasCoins = coins > 0;
    const hasItems = itemsCount > 0;
    const rows = hasItems ? (itemsCount <= maxPerCol ? itemsCount : Math.max(maxPerCol, Math.ceil(itemsCount / 2))) : 0;
    const itemsH = rows > 0 ? (rows * itemHeight + (rows - 1) * itemGapY) : 0;
    if (hasCoins && hasItems) {
      return 42 + 12 + itemsH;
    } else if (hasCoins && !hasItems) {
      return 42;
    } else if (!hasCoins && hasItems) {
      return itemsH;
    } else {
      return 42;
    }
  };

  const senderContentH = calcContentHeight(senderCoins, senderItems.length);
  const targetContentH = calcContentHeight(targetCoins, targetItems.length);
  const maxContentH = Math.max(senderContentH, targetContentH);

  const contentY = 64;
  const baseHeight = Math.max(244, contentY + 88 + maxContentH + 24 + 24);
  const baseWidth = 960;
  const panelH = baseHeight - contentY - 24;

  // 2x Retina Super-Sampling: Renders at double pixel density for crisp, razor-sharp output
  const scale = 2;
  const canvas = createCanvas(baseWidth * scale, baseHeight * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // State Themes
  let themeColor = '#F59E0B'; // Pending (Amber Gold)
  let titleText = 'PENDING OFFER';

  if (status === 'completed' || status === 'accepted') {
    themeColor = '#10B981'; // Emerald Green
    titleText = 'TRADE COMPLETED';
  } else if (status === 'declined') {
    themeColor = '#EF4444'; // Ruby Red
    titleText = 'TRADE DECLINED';
  } else if (status === 'expired') {
    themeColor = '#64748B'; // Slate Gray
    titleText = 'TRADE EXPIRED';
  }

  const resolveItemImgUrl = (item) => {
    const raw = item.image_url || item.imageUrl || item.default_image_url;
    if (raw) {
      return normalizeToImageUrl(raw) || raw;
    }
    const nameLower = String(item.name || '').toLowerCase();
    const isChest = Boolean(
      item.item_type === 'loot_box' ||
      item.item_type === 'chest' ||
      item.loot_box_id ||
      (typeof item.role_id === 'string' && (item.role_id.startsWith('CHEST_') || item.role_id.startsWith('LOOT_BOX_'))) ||
      nameLower.includes('chest') ||
      nameLower.includes('صندوق')
    );
    if (isChest && chestEmojiUrl) {
      return normalizeToImageUrl(chestEmojiUrl) || chestEmojiUrl;
    }
    // Check if item name contains a unicode emoji
    const emojiMatch = String(item.name || '').match(/(\p{Extended_Pictographic}|\p{Emoji_Presentation})/u);
    if (emojiMatch && emojiMatch[0]) {
      return normalizeToImageUrl(emojiMatch[0]);
    }
    return null;
  };

  // Concurrently fetch participant avatars, custom coin icon, and item images
  const [senderAvatarImg, targetAvatarImg, customCoinImg, senderItemImgs, targetItemImgs] = await Promise.all([
    fetchImageSafe(sender.avatarUrl),
    fetchImageSafe(target.avatarUrl),
    fetchImageSafe(customCoinUrl),
    Promise.all(senderItems.map(item => {
      const url = resolveItemImgUrl(item);
      return url ? fetchImageSafe(url) : Promise.resolve(null);
    })),
    Promise.all(targetItems.map(item => {
      const url = resolveItemImgUrl(item);
      return url ? fetchImageSafe(url) : Promise.resolve(null);
    }))
  ]);

  // 1. Transparent Rounded Card Background
  const cardRadius = 24;
  ctx.save();
  roundRect(ctx, 0, 0, baseWidth, baseHeight, cardRadius);
  ctx.clip();

  const bgGrad = ctx.createLinearGradient(0, 0, baseWidth, baseHeight);
  bgGrad.addColorStop(0, '#080B10');
  bgGrad.addColorStop(0.4, '#0D131C');
  bgGrad.addColorStop(1, '#121A26');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, baseWidth, baseHeight);

  // Central Ambient Radial Glow
  const ambientGlow = ctx.createRadialGradient(480, 50, 10, 480, 50, 360);
  ambientGlow.addColorStop(0, hexToRgba(themeColor, 0.22));
  ambientGlow.addColorStop(1, 'transparent');
  ctx.fillStyle = ambientGlow;
  ctx.fillRect(0, 0, baseWidth, baseHeight);
  ctx.restore();

  // 2. Outer Border with state accent tint (Reinforced thickness for high-DPI scaling)
  const borderThickness = 4;
  const halfBorder = borderThickness / 2;
  roundRect(ctx, halfBorder, halfBorder, baseWidth - borderThickness, baseHeight - borderThickness, cardRadius - halfBorder);
  ctx.strokeStyle = hexToRgba(themeColor, 0.6);
  ctx.lineWidth = borderThickness;
  ctx.stroke();

  // 3. Main Title Pill centered at top
  const titlePillW = 180;
  const titlePillH = 34;
  const titlePillX = 480 - titlePillW / 2;
  const titlePillY = 20;

  roundRect(ctx, titlePillX, titlePillY, titlePillW, titlePillH, 17);
  ctx.fillStyle = hexToRgba(themeColor, 0.16);
  ctx.fill();
  ctx.strokeStyle = hexToRgba(themeColor, 0.7);
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.font = `bold 13px ${fontStack}`;
  ctx.fillStyle = shiftColorBrightness(themeColor, 0.2);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(titleText, 480, titlePillY + titlePillH / 2);

  // Center Exchange Hub (Icon vertically centered between participant panels)
  const hubX = 480;
  const hubY = 64 + (baseHeight - 64 - 24) / 2;

  // Center Icon (Directional Arrows, Cross, or Clock)
  drawExchangeIcon(ctx, hubX, hubY, status, direction);

  // 4. Participant Panels (Left & Right)
  function drawParticipantPanel({
    side,
    username = 'User',
    displayName = 'User',
    coins = 0,
    items = [],
    itemImgs = [],
    accentColor = '#3B82F6',
    avatarImg = null,
    otherHasOffer = true,
    coinBorderColor = '#F59E0B'
  }) {
    const panelW = 400;
    const panelX = side === 'left' ? 32 : 528;
    const contentY = 64;
    const panelH = baseHeight - contentY - 24;

    // Surface
    roundRect(ctx, panelX, contentY, panelW, panelH, 18);
    const panelGrad = ctx.createLinearGradient(panelX, contentY, panelX, contentY + panelH);
    panelGrad.addColorStop(0, 'rgba(255, 255, 255, 0.038)');
    panelGrad.addColorStop(1, 'rgba(255, 255, 255, 0.012)');
    ctx.fillStyle = panelGrad;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Symmetrical Avatar Positioning
    const avatarSize = 56;
    const avatarRadius = avatarSize / 2;
    const avatarY = contentY + 16;
    const avatarX = side === 'left'
      ? panelX + 18
      : panelX + panelW - 18 - avatarSize;

    // Extract dominant color from avatar if possible, exactly like /profile
    const dominantAvatarColor = extractDominantColor(avatarImg);
    const userAccent = dominantAvatarColor || accentColor || (side === 'left' ? '#3B82F6' : '#8B5CF6');

    // Avatar clipped content
    ctx.save();
    ctx.beginPath();
    ctx.arc(avatarX + avatarRadius, avatarY + avatarRadius, avatarRadius, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();

    if (avatarImg) {
      ctx.drawImage(avatarImg, avatarX, avatarY, avatarSize, avatarSize);
    } else {
      ctx.fillStyle = side === 'left' ? '#1E3A8A' : '#4C1D95';
      ctx.fillRect(avatarX, avatarY, avatarSize, avatarSize);
      ctx.font = `bold 24px ${fontStack}`;
      ctx.fillStyle = '#FFFFFF';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const initial = (displayName && displayName[0]) ? displayName[0].toUpperCase() : 'U';
      ctx.fillText(initial, avatarX + avatarRadius, avatarY + avatarRadius);
    }
    ctx.restore();

    // Glowing avatar border ring matching dominant avatar color (just like /profile)
    ctx.save();
    ctx.shadowColor = userAccent;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(avatarX + avatarRadius, avatarY + avatarRadius, avatarRadius, 0, Math.PI * 2);
    ctx.strokeStyle = userAccent;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();

    // Symmetrical Username with auto-truncation ellipsis
    ctx.font = `bold 20px ${fontStack}`;
    ctx.fillStyle = '#FFFFFF';
    ctx.textBaseline = 'middle';

    let handleText = `@${username}`;
    const maxHandleWidth = 270;
    if (ctx.measureText(handleText).width > maxHandleWidth) {
      while (ctx.measureText(handleText + '...').width > maxHandleWidth && handleText.length > 0) {
        handleText = handleText.slice(0, -1);
      }
      handleText += '...';
    }

    if (side === 'left') {
      const textX = avatarX + avatarSize + 16;
      ctx.textAlign = 'left';
      ctx.fillText(handleText, textX, avatarY + avatarRadius);
    } else {
      const textX = avatarX - 16;
      ctx.textAlign = 'right';
      ctx.fillText(handleText, textX, avatarY + avatarRadius);
    }

    const parsedCoins = parseInt(coins, 10) || 0;
    const itemsList = Array.isArray(items) ? items : [];
    const hasCoins = parsedCoins > 0;
    const hasItems = itemsList.length > 0;

    let cursorY = contentY + 88;

    // 1. Currency Box (Only rendered if coins > 0)
    if (hasCoins) {
      roundRect(ctx, panelX + 16, cursorY, panelW - 32, 42, 10);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
      ctx.fill();
      ctx.strokeStyle = coinBorderColor;
      ctx.lineWidth = 1.4;
      ctx.stroke();

      const coinIconSize = 24;
      const coinIconY = cursorY + (42 - coinIconSize) / 2;
      const coinText = parsedCoins === 1 ? '1 Coin' : `${parsedCoins.toLocaleString()} Coins`;
      ctx.font = `bold 16px ${fontStack}`;
      ctx.fillStyle = '#FDE68A';
      ctx.textBaseline = 'middle';

      if (side === 'left') {
        const coinIconX = panelX + 28;
        if (customCoinImg) {
          ctx.drawImage(customCoinImg, coinIconX, coinIconY, coinIconSize, coinIconSize);
        } else {
          drawVectorCoin(ctx, coinIconX + coinIconSize / 2, coinIconY + coinIconSize / 2, coinIconSize / 2);
        }
        ctx.textAlign = 'left';
        ctx.fillText(coinText, coinIconX + coinIconSize + 12, cursorY + 21);
      } else {
        const coinIconX = panelX + panelW - 28 - coinIconSize;
        if (customCoinImg) {
          ctx.drawImage(customCoinImg, coinIconX, coinIconY, coinIconSize, coinIconSize);
        } else {
          drawVectorCoin(ctx, coinIconX + coinIconSize / 2, coinIconY + coinIconSize / 2, coinIconSize / 2);
        }
        ctx.textAlign = 'right';
        ctx.fillText(coinText, coinIconX - 12, cursorY + 21);
      }

      cursorY += 42 + 12;
    }

    // 2. Items Section (Only rendered if items.length > 0)
    if (hasItems) {
      const colW = (panelW - 32 - itemGapX) / 2; // 180px
      const colLeftX = panelX + 16;
      const colRightX = panelX + 16 + colW + itemGapX;

      // Left user: columns go left-to-right (col1 = left, col2 = right)
      // Right user: columns go right-to-left (col1 = right, col2 = left)
      const col1X = side === 'left' ? colLeftX : colRightX;
      const col2X = side === 'left' ? colRightX : colLeftX;
      const itemsStartY = cursorY;

      if (itemsList.length <= maxPerCol) {
        // All items in Column 1 (Column 2 is not drawn at all)
        for (let i = 0; i < itemsList.length; i++) {
          const itemY = itemsStartY + i * (itemHeight + itemGapY);
          drawItemBox(ctx, col1X, itemY, colW, itemHeight, itemsList[i], side, itemImgs[i] || null);
        }
      } else {
        // Column 1 is full, Column 2 appears (don't show empty slots)
        const rows = Math.max(maxPerCol, Math.ceil(itemsList.length / 2));
        for (let i = 0; i < itemsList.length; i++) {
          const col = i < rows ? 0 : 1;
          const row = i < rows ? i : (i - rows);
          const itemX = col === 0 ? col1X : col2X;
          const itemY = itemsStartY + row * (itemHeight + itemGapY);
          drawItemBox(ctx, itemX, itemY, colW, itemHeight, itemsList[i], side, itemImgs[i] || null);
        }
      }
    } else if (!hasCoins) {
      // 3. Neither coins nor items offered: Clean minimal placeholder
      roundRect(ctx, panelX + 16, cursorY, panelW - 32, 42, 12);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
      ctx.lineWidth = 1;
      ctx.stroke();

      const placeholderText = otherHasOffer ? 'No Offer (Receiving)' : 'No Offer';
      ctx.font = `italic 14px ${fontStack}`;
      ctx.fillStyle = '#64748B';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(placeholderText, panelX + panelW / 2, cursorY + 21);
    }
  }

  // Extract dynamic dominant color from custom coin image with gold fallback
  const coinBorderColor = extractCoinColor(customCoinImg, '#F59E0B');

  // Draw Participants
  drawParticipantPanel({
    side: 'left',
    ...sender,
    items: senderItems,
    itemImgs: senderItemImgs,
    avatarImg: senderAvatarImg,
    otherHasOffer: targetHasOffer,
    coinBorderColor
  });

  drawParticipantPanel({
    side: 'right',
    ...target,
    items: targetItems,
    itemImgs: targetItemImgs,
    avatarImg: targetAvatarImg,
    otherHasOffer: senderHasOffer,
    coinBorderColor
  });

  const buffer = canvas.toBuffer('image/png');
  const duration = Math.round(performance.now() - renderStart);
  const detailStr = `Status: ${status} | Direction: ${direction} | H: ${baseHeight}px`;
  if (duration > 500) {
    sysWarn('Slow Trade Card Render', { detail: detailStr, duration });
  } else {
    sysLog('Trade Card Rendered', { detail: detailStr, duration });
  }

  return buffer;
}
