import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { sysError } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fontsDir = path.resolve(__dirname, '../assets/fonts');

// Register bundled Roboto fonts if present
try {
  const boldPath = path.join(fontsDir, 'Roboto-Bold.ttf');
  const regularPath = path.join(fontsDir, 'Roboto-Regular.ttf');
  if (fs.existsSync(boldPath)) {
    GlobalFonts.registerFromPath(boldPath, 'Roboto');
  }
  if (fs.existsSync(regularPath)) {
    GlobalFonts.registerFromPath(regularPath, 'Roboto');
  }
} catch (err) {
  sysError('TradeCard Font Registration Error', err);
}

const fontStack = '"Roboto", "Segoe UI", "Tahoma", "Arial", sans-serif';

/**
 * Draw a rounded rectangle path on 2D context
 */
function roundRect(ctx, x, y, width, height, radius) {
  if (typeof radius === 'number') {
    radius = { tl: radius, tr: radius, br: radius, bl: radius };
  }
  ctx.beginPath();
  ctx.moveTo(x + radius.tl, y);
  ctx.lineTo(x + width - radius.tr, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius.tr);
  ctx.lineTo(x + width, y + height - radius.br);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius.br, y + height);
  ctx.lineTo(x + radius.bl, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius.bl);
  ctx.lineTo(x, y + radius.tl);
  ctx.quadraticCurveTo(x, y, x + radius.tl, y);
  ctx.closePath();
}

/**
 * Safely fetch an external image with timeout
 */
async function fetchImageSafe(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3500) });
    if (!res.ok) return null;
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
 * Draw central vector status symbol
 */
function drawExchangeIcon(ctx, centerX, centerY, status = 'pending') {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (status === 'declined') {
    // Red Cross icon '✕'
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
    // Clock geometry in muted slate
    ctx.strokeStyle = '#64748B';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(centerX, centerY, 14, 0, Math.PI * 2);
    ctx.stroke();
    // Clock hands
    ctx.beginPath();
    ctx.moveTo(centerX, centerY - 8);
    ctx.lineTo(centerX, centerY);
    ctx.lineTo(centerX + 6, centerY);
    ctx.stroke();
  } else {
    // Pending / Completed Dual Directional Arrows
    const color = status === 'completed' ? '#10B981' : '#F59E0B';
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.8;

    const len = 18;
    const arrowHead = 6;

    // Top arrow: pointing right (-->)
    const topY = centerY - 7;
    ctx.beginPath();
    ctx.moveTo(centerX - len, topY);
    ctx.lineTo(centerX + len, topY);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(centerX + len - arrowHead, topY - arrowHead);
    ctx.lineTo(centerX + len, topY);
    ctx.lineTo(centerX + len - arrowHead, topY + arrowHead);
    ctx.stroke();

    // Bottom arrow: pointing left (<--)
    const botY = centerY + 7;
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

  ctx.restore();
}

/**
 * Generate a high-resolution trade settlement card
 * @param {Object} tradeData
 * @param {string} [tradeData.status='pending'] - 'pending' | 'completed' | 'declined' | 'expired'
 * @param {string} [tradeData.expiresText='Expires in 5m']
 * @param {Object} tradeData.sender - { username, displayName, avatarUrl, coins, items, accentColor }
 * @param {Object} tradeData.target - { username, displayName, avatarUrl, coins, items, accentColor }
 * @returns {Promise<Buffer>} PNG image buffer
 */
export async function renderTradeCard({
  status = 'pending',
  expiresText = 'Expires in 5m',
  sender = {},
  target = {}
}) {
  const senderItems = Array.isArray(sender.items) ? sender.items : [];
  const targetItems = Array.isArray(target.items) ? target.items : [];

  // Calculate dynamic card height based on maximum items on either side
  const maxItems = Math.max(senderItems.length, targetItems.length);
  const extraItems = Math.max(0, maxItems - 1);
  const height = 330 + extraItems * 46;

  const width = 960;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // State Themes
  let themeColor = '#F59E0B'; // Pending (Amber)
  let titleText = 'PENDING OFFER';
  let centerSubtext = expiresText;

  if (status === 'completed') {
    themeColor = '#10B981'; // Emerald Green
    titleText = 'TRADE COMPLETED';
    centerSubtext = 'Settled';
  } else if (status === 'declined') {
    themeColor = '#EF4444'; // Ruby Red
    titleText = 'TRADE DECLINED';
    centerSubtext = 'Rejected';
  } else if (status === 'expired') {
    themeColor = '#64748B'; // Slate Gray
    titleText = 'TRADE EXPIRED';
    centerSubtext = 'Timed Out';
  }

  // Concurrently fetch participant avatars
  const [senderAvatarImg, targetAvatarImg] = await Promise.all([
    fetchImageSafe(sender.avatarUrl),
    fetchImageSafe(target.avatarUrl)
  ]);

  // 1. Transparent Rounded Card Background
  const cardRadius = 22;
  ctx.save();
  roundRect(ctx, 0, 0, width, height, cardRadius);
  ctx.clip();

  const bgGrad = ctx.createLinearGradient(0, 0, width, height);
  bgGrad.addColorStop(0, '#090D14');
  bgGrad.addColorStop(0.5, '#0E1520');
  bgGrad.addColorStop(1, '#121A27');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, width, height);

  // Central Ambient Radial Glow
  const ambientGlow = ctx.createRadialGradient(480, 80, 10, 480, 80, 280);
  ambientGlow.addColorStop(0, hexToRgba(themeColor, 0.16));
  ambientGlow.addColorStop(1, 'transparent');
  ctx.fillStyle = ambientGlow;
  ctx.fillRect(0, 0, width, height);

  ctx.restore();

  // 2. Outer Border with state accent tint
  roundRect(ctx, 1, 1, width - 2, height - 2, cardRadius);
  ctx.strokeStyle = hexToRgba(themeColor, 0.35);
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // 3. Main Title Pill centered at top
  const titlePillW = 166;
  const titlePillH = 32;
  const titlePillX = 480 - titlePillW / 2;
  const titlePillY = 22;

  roundRect(ctx, titlePillX, titlePillY, titlePillW, titlePillH, 16);
  ctx.fillStyle = hexToRgba(themeColor, 0.18);
  ctx.fill();
  ctx.strokeStyle = hexToRgba(themeColor, 0.65);
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.font = `bold 13px ${fontStack}`;
  ctx.fillStyle = shiftColorBrightness(themeColor, 0.2);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(titleText, 480, titlePillY + titlePillH / 2);

  // Center Icon (Arrows, Cross, or Clock)
  const centerIconY = 66 + (height - 66 - 20) / 2 - 10;
  drawExchangeIcon(ctx, 480, centerIconY, status);

  // Subtext under center icon
  ctx.font = `bold 12px ${fontStack}`;
  ctx.fillStyle = status === 'pending' ? '#64748B' : themeColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(centerSubtext, 480, centerIconY + 28);

  // 4. Participant Panels (Left & Right)
  function drawParticipantPanel({
    side, // 'left' or 'right'
    username = 'User',
    displayName = 'User',
    coins = 0,
    items = [],
    accentColor = '#3B82F6',
    avatarImg = null
  }) {
    const panelW = 404;
    const panelX = side === 'left' ? 32 : 524;
    const contentY = 66;
    const panelH = height - contentY - 24;

    // Panel card surface
    roundRect(ctx, panelX, contentY, panelW, panelH, 16);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.022)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Symmetrical Avatar Positioning
    const avatarSize = 54;
    const avatarRadius = avatarSize / 2;
    const avatarY = contentY + 16;
    const avatarX = side === 'left'
      ? panelX + 16
      : panelX + panelW - 16 - avatarSize;

    ctx.save();
    ctx.beginPath();
    ctx.arc(avatarX + avatarRadius, avatarY + avatarRadius, avatarRadius, 0, Math.PI * 2);
    ctx.clip();

    if (avatarImg) {
      ctx.drawImage(avatarImg, avatarX, avatarY, avatarSize, avatarSize);
    } else {
      ctx.fillStyle = side === 'left' ? '#1E3A8A' : '#4C1D95';
      ctx.fillRect(avatarX, avatarY, avatarSize, avatarSize);
      ctx.font = `bold 22px ${fontStack}`;
      ctx.fillStyle = '#FFFFFF';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const initial = (displayName && displayName[0]) ? displayName[0].toUpperCase() : 'U';
      ctx.fillText(initial, avatarX + avatarRadius, avatarY + avatarRadius);
    }
    ctx.restore();

    // Avatar Ring
    ctx.beginPath();
    ctx.arc(avatarX + avatarRadius, avatarY + avatarRadius, avatarRadius, 0, Math.PI * 2);
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // Symmetrical Username
    ctx.font = `bold 20px ${fontStack}`;
    ctx.fillStyle = '#FFFFFF';
    ctx.textBaseline = 'middle';

    if (side === 'left') {
      const textX = avatarX + avatarSize + 14;
      ctx.textAlign = 'left';
      ctx.fillText(`@${username}`, textX, avatarY + avatarRadius);
    } else {
      const textX = avatarX - 14;
      ctx.textAlign = 'right';
      ctx.fillText(`@${username}`, textX, avatarY + avatarRadius);
    }

    // Currency Box
    const coinBoxY = contentY + 84;
    roundRect(ctx, panelX + 16, coinBoxY, panelW - 32, 40, 10);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    ctx.stroke();

    const coinIconX = panelX + 34;
    const coinIconY = coinBoxY + 20;
    ctx.beginPath();
    ctx.arc(coinIconX, coinIconY, 11, 0, Math.PI * 2);
    ctx.fillStyle = '#F59E0B';
    ctx.fill();
    ctx.font = `bold 12px ${fontStack}`;
    ctx.fillStyle = '#78350F';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('$', coinIconX, coinIconY);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `bold 15px ${fontStack}`;
    ctx.fillStyle = '#FBBF24';
    const parsedCoins = parseInt(coins, 10) || 0;
    ctx.fillText(`${parsedCoins.toLocaleString()} Coins`, coinIconX + 18, coinIconY);

    // Items Section
    const itemsY = coinBoxY + 48;
    ctx.font = `bold 11px ${fontStack}`;
    ctx.fillStyle = '#94A3B8';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`ITEMS (${items.length})`, panelX + 18, itemsY);

    if (items.length === 0) {
      const emptyY = itemsY + 18;
      roundRect(ctx, panelX + 16, emptyY, panelW - 32, 40, 10);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
      ctx.fill();
      ctx.font = `italic 13px ${fontStack}`;
      ctx.fillStyle = '#64748B';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('None', panelX + panelW / 2, emptyY + 20);
    } else {
      let curItemY = itemsY + 18;
      for (const item of items) {
        roundRect(ctx, panelX + 16, curItemY, panelW - 32, 40, 10);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
        ctx.fill();
        ctx.strokeStyle = item.rarityColor || 'rgba(255, 255, 255, 0.1)';
        ctx.lineWidth = 1.2;
        ctx.stroke();

        // Left Accent Bar
        ctx.save();
        roundRect(ctx, panelX + 16, curItemY, 5, 40, { tl: 10, bl: 10, tr: 0, br: 0 });
        ctx.fillStyle = item.rarityColor || '#94A3B8';
        ctx.fill();
        ctx.restore();

        // Quantity Badge (e.g. [5x])
        let nameStartX = panelX + 28;
        const itemQty = parseInt(item.qty || 1, 10);
        if (itemQty > 1) {
          const qtyText = `${itemQty}x`;
          ctx.font = `bold 11px ${fontStack}`;
          const qtyW = ctx.measureText(qtyText).width + 12;
          roundRect(ctx, nameStartX, curItemY + 10, qtyW, 20, 5);
          ctx.fillStyle = 'rgba(59, 130, 246, 0.25)';
          ctx.fill();
          ctx.strokeStyle = '#3B82F6';
          ctx.lineWidth = 1;
          ctx.stroke();

          ctx.fillStyle = '#93C5FD';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(qtyText, nameStartX + qtyW / 2, curItemY + 20);
          nameStartX += qtyW + 8;
        }

        // Item Name
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.font = `bold 15px ${fontStack}`;
        ctx.fillStyle = '#F8FAFC';
        ctx.fillText(item.name || 'Unknown Item', nameStartX, curItemY + 20);

        // Optional Tier / Rarity Pill
        if (item.tier) {
          ctx.font = `bold 10px ${fontStack}`;
          const tierText = String(item.tier).toUpperCase();
          const tierW = ctx.measureText(tierText).width + 14;
          const tierX = panelX + panelW - 24 - tierW;
          roundRect(ctx, tierX, curItemY + 11, tierW, 18, 5);
          ctx.fillStyle = hexToRgba(item.rarityColor || '#3B82F6', 0.15);
          ctx.fill();
          ctx.strokeStyle = item.rarityColor || '#3B82F6';
          ctx.lineWidth = 1;
          ctx.stroke();

          ctx.fillStyle = item.rarityColor || '#3B82F6';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(tierText, tierX + tierW / 2, curItemY + 20);
        }

        curItemY += 46;
      }
    }
  }

  // Draw Participants
  drawParticipantPanel({
    side: 'left',
    ...sender,
    items: senderItems,
    avatarImg: senderAvatarImg
  });

  drawParticipantPanel({
    side: 'right',
    ...target,
    items: targetItems,
    avatarImg: targetAvatarImg
  });

  return canvas.toBuffer('image/png');
}
