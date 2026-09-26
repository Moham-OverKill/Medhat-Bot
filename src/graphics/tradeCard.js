import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { sysError } from '../utils/logger.js';

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
  }
  ctx.beginPath();
  ctx.moveTo(x + radius.tl, y);
  ctx.lineTo(x + width - radius.tr, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius.tr);
  ctx.lineTo(x + width, y + height - radius.br);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius.br, y + height);
  ctx.lineTo(x + radius.bl, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius.bl);
  ctx.lineTo(x + radius.tl);
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
function drawExchangeIcon(ctx, centerX, centerY, status = 'pending') {
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
    const color = status === 'completed' ? '#10B981' : '#F59E0B';
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;

    const len = 20;
    const arrowHead = 7;

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

  ctx.restore();
}

/**
 * Generate a high-resolution, 2x Retina trade settlement card
 * @param {Object} tradeData
 * @param {string} [tradeData.status='pending'] - 'pending' | 'completed' | 'declined' | 'expired'
 * @param {string} [tradeData.expiresText='Expires in 5m']
 * @param {string|null} [tradeData.customCoinUrl=null] - Custom server coin emoji URL
 * @param {Object} tradeData.sender - { username, displayName, avatarUrl, coins, items, accentColor }
 * @param {Object} tradeData.target - { username, displayName, avatarUrl, coins, items, accentColor }
 * @returns {Promise<Buffer>} PNG image buffer
 */
export async function renderTradeCard({
  status = 'pending',
  expiresText = 'Expires in 5m',
  customCoinUrl = null,
  sender = {},
  target = {}
}) {
  const senderItems = Array.isArray(sender.items) ? sender.items : [];
  const targetItems = Array.isArray(target.items) ? target.items : [];

  // Calculate dynamic card height based on maximum items on either side
  const maxItems = Math.max(senderItems.length, targetItems.length);
  const extraItems = Math.max(0, maxItems - 1);
  const baseHeight = 340 + extraItems * 48;
  const baseWidth = 960;

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

  // Concurrently fetch participant avatars and custom coin icon
  const [senderAvatarImg, targetAvatarImg, customCoinImg] = await Promise.all([
    fetchImageSafe(sender.avatarUrl),
    fetchImageSafe(target.avatarUrl),
    fetchImageSafe(customCoinUrl)
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

  // 2. Outer Border with state accent tint
  roundRect(ctx, 1, 1, baseWidth - 2, baseHeight - 2, cardRadius);
  ctx.strokeStyle = hexToRgba(themeColor, 0.4);
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Top Specular Highlight
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(cardRadius + 20, 1.5);
  ctx.lineTo(baseWidth - cardRadius - 20, 1.5);
  const topLightGrad = ctx.createLinearGradient(cardRadius, 0, baseWidth - cardRadius, 0);
  topLightGrad.addColorStop(0, 'transparent');
  topLightGrad.addColorStop(0.5, 'rgba(255, 255, 255, 0.25)');
  topLightGrad.addColorStop(1, 'transparent');
  ctx.strokeStyle = topLightGrad;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();

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

  // Center Exchange Hub
  const hubX = 480;
  const hubY = 64 + (baseHeight - 64 - 24) / 2;

  // Center Icon (Arrows, Cross, or Clock)
  drawExchangeIcon(ctx, hubX, hubY - 10, status);

  // Subtext / Countdown pill under center icon
  const timerPillW = Math.max(114, ctx.measureText(centerSubtext).width + 24);
  const timerPillH = 26;
  roundRect(ctx, hubX - timerPillW / 2, hubY + 18, timerPillW, timerPillH, 13);
  ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.font = `bold 12px ${fontStack}`;
  ctx.fillStyle = status === 'pending' ? '#94A3B8' : themeColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(centerSubtext, hubX, hubY + 31);

  // 4. Participant Panels (Left & Right)
  function drawParticipantPanel({
    side,
    username = 'User',
    displayName = 'User',
    coins = 0,
    items = [],
    accentColor = '#3B82F6',
    avatarImg = null
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

    // Glowing border ring
    ctx.save();
    ctx.beginPath();
    ctx.arc(avatarX + avatarRadius, avatarY + avatarRadius, avatarRadius + 3, 0, Math.PI * 2);
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.restore();

    // Avatar clipped content
    ctx.save();
    ctx.beginPath();
    ctx.arc(avatarX + avatarRadius, avatarY + avatarRadius, avatarRadius, 0, Math.PI * 2);
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

    // Symmetrical Username
    ctx.font = `bold 22px ${fontStack}`;
    ctx.fillStyle = '#FFFFFF';
    ctx.textBaseline = 'middle';

    if (side === 'left') {
      const textX = avatarX + avatarSize + 16;
      ctx.textAlign = 'left';
      ctx.fillText(`@${username}`, textX, avatarY + avatarRadius);
    } else {
      const textX = avatarX - 16;
      ctx.textAlign = 'right';
      ctx.fillText(`@${username}`, textX, avatarY + avatarRadius);
    }

    // Currency Box
    const coinBoxY = contentY + 88;
    roundRect(ctx, panelX + 16, coinBoxY, panelW - 32, 42, 12);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Custom Server Coin Icon or Embossed Vector Coin
    const coinIconSize = 24;
    const coinIconX = panelX + 28;
    const coinIconY = coinBoxY + (42 - coinIconSize) / 2;

    if (customCoinImg) {
      ctx.drawImage(customCoinImg, coinIconX, coinIconY, coinIconSize, coinIconSize);
    } else {
      drawVectorCoin(ctx, coinIconX + coinIconSize / 2, coinIconY + coinIconSize / 2, coinIconSize / 2);
    }

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `bold 16px ${fontStack}`;
    ctx.fillStyle = '#FDE68A';
    const parsedCoins = parseInt(coins, 10) || 0;
    ctx.fillText(`${parsedCoins.toLocaleString()} Coins`, coinIconX + coinIconSize + 12, coinBoxY + 21);

    // Items Section
    const itemsY = coinBoxY + 52;
    ctx.font = `bold 12px ${fontStack}`;
    ctx.fillStyle = '#94A3B8';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`ITEMS (${items.length})`, panelX + 20, itemsY);

    if (items.length === 0) {
      const emptyY = itemsY + 20;
      roundRect(ctx, panelX + 16, emptyY, panelW - 32, 42, 12);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
      ctx.fill();
      ctx.font = `italic 14px ${fontStack}`;
      ctx.fillStyle = '#64748B';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('None', panelX + panelW / 2, emptyY + 21);
    } else {
      let curItemY = itemsY + 20;
      for (const item of items) {
        // Clean item capsule surface - NO distorted overlapping bar
        roundRect(ctx, panelX + 16, curItemY, panelW - 32, 42, 12);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
        ctx.fill();
        ctx.strokeStyle = item.rarityColor || 'rgba(255, 255, 255, 0.08)';
        ctx.lineWidth = 1.2;
        ctx.stroke();

        let nameStartX = panelX + 30;
        const itemQty = parseInt(item.qty || 1, 10);
        if (itemQty > 1) {
          const qtyText = `${itemQty}x`;
          ctx.font = `bold 12px ${fontStack}`;
          const qtyW = ctx.measureText(qtyText).width + 14;
          roundRect(ctx, nameStartX, curItemY + 11, qtyW, 20, 6);
          ctx.fillStyle = 'rgba(56, 189, 248, 0.18)';
          ctx.fill();
          ctx.strokeStyle = '#38BDF8';
          ctx.lineWidth = 1;
          ctx.stroke();

          ctx.fillStyle = '#7DD3FC';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(qtyText, nameStartX + qtyW / 2, curItemY + 21);
          nameStartX += qtyW + 10;
        }

        // Item Name (in Cairo font supporting Arabic and English)
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.font = `bold 16px ${fontStack}`;
        ctx.fillStyle = '#F8FAFC';
        ctx.fillText(item.name || 'Unknown Item', nameStartX, curItemY + 21);

        // Optional Tier / Rarity Pill
        if (item.tier) {
          ctx.font = `bold 10px ${fontStack}`;
          const tierText = String(item.tier).toUpperCase();
          const tierW = ctx.measureText(tierText).width + 14;
          const tierX = panelX + panelW - 24 - tierW;
          roundRect(ctx, tierX, curItemY + 12, tierW, 18, 5);
          ctx.fillStyle = hexToRgba(item.rarityColor || '#3B82F6', 0.15);
          ctx.fill();
          ctx.strokeStyle = item.rarityColor || '#3B82F6';
          ctx.lineWidth = 1;
          ctx.stroke();

          ctx.fillStyle = item.rarityColor || '#3B82F6';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(tierText, tierX + tierW / 2, curItemY + 21);
        }

        curItemY += 48;
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
