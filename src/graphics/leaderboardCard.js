import { createCanvas } from '@napi-rs/canvas';
import { performance } from 'node:perf_hooks';
import { sysWarn, sysLog } from '../utils/logger.js';
import {
  fontStack,
  boldFontStack,
  roundRect,
  drawVectorCoin,
  hexToRgba,
  shiftColorBrightness,
  safeFirstChar,
  fetchImageSafe,
  formatCompactNumber
} from './shared.js';

/**
 * Auto-scale text within maxWidth by dynamically decreasing font size.
 * Prevents text overflow without abruptly truncating with an ellipsis.
 * 
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} x
 * @param {number} y
 * @param {number} maxWidth
 * @param {number} maxFontSize
 * @param {number} minFontSize
 * @param {boolean} bold
 * @returns {number} The actual font size used
 */
export function drawFittedText(ctx, text, x, y, maxWidth, maxFontSize, minFontSize = 13, bold = true) {
  let size = maxFontSize;
  const stack = bold ? boldFontStack : fontStack;
  ctx.font = `${bold ? 'bold ' : ''}${size}px ${stack}`;
  
  while (ctx.measureText(text).width > maxWidth && size > minFontSize) {
    size -= 1;
    ctx.font = `${bold ? 'bold ' : ''}${size}px ${stack}`;
  }

  // If even at minFontSize it still overflows slightly, perform safety truncation
  let finalText = text;
  if (ctx.measureText(finalText).width > maxWidth) {
    while (ctx.measureText(finalText + '…').width > maxWidth && finalText.length > 0) {
      finalText = finalText.slice(0, -1);
    }
    finalText += '…';
  }

  ctx.fillText(finalText, x, y);
  return { size, text: finalText };
}

/**
 * Category styling definitions
 */
export const LEADERBOARD_THEMES = {
  daily_coins: {
    title: 'MVP CHAMPIONS',
    themeColor: '#F59E0B',
    accentGrad: ['#FFD700', '#D97706'],
    iconEmoji: '⭐',
    unitLabel: 'pts',
    valueKey: 'score'
  },
  coins: {
    title: 'RICHEST MEMBERS',
    themeColor: '#10B981',
    accentGrad: ['#34D399', '#059669'],
    iconEmoji: '🪙',
    unitLabel: '',
    valueKey: 'balance',
    isCoin: true
  },
  streak: {
    title: 'LONGEST STREAKS',
    themeColor: '#FF5722',
    accentGrad: ['#FF7043', '#E64A19'],
    iconEmoji: '🔥',
    unitLabel: 'Days',
    valueKey: 'daily_streak'
  },
  level: {
    title: 'HIGHEST LEVELS',
    themeColor: '#6366F1',
    accentGrad: ['#818CF8', '#4F46E5'],
    iconEmoji: '🆙',
    unitLabel: 'Lv',
    valueKey: 'level',
    isLevel: true
  }
};

/**
 * Format leaderboard value with unit label
 */
function formatLeaderboardValue(item, theme, currencyName = null) {
  if (theme.isLevel) {
    const lv = item.level ?? 1;
    const xp = item.battlepass_xp ? formatCompactNumber(item.battlepass_xp) : null;
    return xp ? `Lv. ${lv} (${xp} XP)` : `Lv. ${lv}`;
  }
  const raw = Number(item[theme.valueKey]) || 0;
  const compact = formatCompactNumber(raw);
  if (theme.isCoin) {
    const label = currencyName ? ` ${currencyName}` : '';
    return `${compact}${label}`;
  }
  if (theme.unitLabel) {
    return `${compact} ${theme.unitLabel}`;
  }
  return compact;
}

/**
 * Render a high-legibility, mobile-first Leaderboard Card buffer
 *
 * @param {object} options
 * @param {string} options.category - 'daily_coins' | 'coins' | 'streak' | 'level'
 * @param {Array<object>} options.data - Enriched leaderboard records
 * @param {Array<string>} [options.mvpRecipients=[]] - List of MVP user IDs
 * @param {string} [options.currencyName] - Custom currency name (e.g. "Coins")
 * @param {string} [options.customCoinUrl] - Custom coin image URL
 * @returns {Promise<Buffer>} PNG image buffer
 */
export async function renderLeaderboardCard({
  category = 'daily_coins',
  data = [],
  mvpRecipients = [],
  currencyName = 'Coins',
  customCoinUrl = null
}) {
  const renderStart = performance.now();
  const theme = LEADERBOARD_THEMES[category] || LEADERBOARD_THEMES.daily_coins;

  // Pre-fetch assets: custom coin icon & participant avatars
  const slicedData = (data || []).slice(0, 10);
  const count = slicedData.length;

  const [customCoinImg, ...avatarImgs] = await Promise.all([
    customCoinUrl ? fetchImageSafe(customCoinUrl) : Promise.resolve(null),
    ...slicedData.map(item => (item.avatarUrl ? fetchImageSafe(item.avatarUrl) : Promise.resolve(null)))
  ]);

  // Dimensions & Retina scale
  const baseWidth = 960;
  const scale = 2; // 2x Retina super-sampling
  const padX = 36;
  const padY = 32;

  // Dynamic layout calculations
  const headerH = 76;
  const hasPodium = count >= 3;
  const podiumH = hasPodium ? 226 : 0;
  const podiumMarginBottom = hasPodium ? 20 : 0;

  const rowCount = hasPodium ? count - 3 : count;
  const rowH = 56;
  const rowGap = 10;
  const rowsSectionH = rowCount > 0 ? (rowCount * rowH + (rowCount - 1) * rowGap) : 0;

  // Determine overall base height
  let baseHeight;
  if (count === 0) {
    baseHeight = padY + headerH + 200 + padY; // Empty state height
  } else {
    baseHeight = padY + headerH + (hasPodium ? podiumH + podiumMarginBottom : 0) + rowsSectionH + padY;
  }

  const canvas = createCanvas(Math.round(baseWidth * scale), Math.round(baseHeight * scale));
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

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

  // Top header ambient glow matching theme color
  const glowGrad = ctx.createRadialGradient(baseWidth / 2, 40, 10, baseWidth / 2, 40, 420);
  glowGrad.addColorStop(0, hexToRgba(theme.themeColor, 0.22));
  glowGrad.addColorStop(1, 'transparent');
  ctx.fillStyle = glowGrad;
  ctx.fillRect(0, 0, baseWidth, 240);

  ctx.restore();

  // 2. Outer Card Border
  const borderThickness = 4;
  const halfBorder = borderThickness / 2;
  roundRect(ctx, halfBorder, halfBorder, baseWidth - borderThickness, baseHeight - borderThickness, cardRadius - halfBorder);
  ctx.strokeStyle = hexToRgba(theme.themeColor, 0.7);
  ctx.lineWidth = borderThickness;
  ctx.stroke();

  // 3. Clean Header (Category Icon + Main Title only, zero subheaders/timers)
  const headerY = padY;
  const iconSize = 48;

  // Icon container
  roundRect(ctx, padX, headerY, iconSize, iconSize, 14);
  ctx.fillStyle = hexToRgba(theme.themeColor, 0.16);
  ctx.fill();
  ctx.strokeStyle = hexToRgba(theme.themeColor, 0.45);
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Draw category icon: if custom coin image exists for Richest, use it; otherwise render emoji
  if (theme.isCoin && (customCoinImg || customCoinUrl)) {
    if (customCoinImg) {
      ctx.drawImage(customCoinImg, padX + 8, headerY + 8, 32, 32);
    } else {
      drawVectorCoin(ctx, padX + iconSize / 2, headerY + iconSize / 2, 16);
    }
  } else {
    ctx.font = `28px ${fontStack}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(theme.iconEmoji, padX + iconSize / 2, headerY + iconSize / 2 + 1);
  }

  // Clean, massive main title
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `bold 28px ${boldFontStack}`;
  ctx.fillText(theme.title, padX + iconSize + 16, headerY + iconSize / 2);

  // Header separator line
  const headerBottomY = headerY + iconSize + 16;
  ctx.beginPath();
  ctx.moveTo(padX, headerBottomY);
  ctx.lineTo(baseWidth - padX, headerBottomY);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Empty State Handling
  if (count === 0) {
    const emptyBoxY = headerBottomY + 28;
    const emptyBoxH = 140;
    const emptyBoxW = baseWidth - padX * 2;

    roundRect(ctx, padX, emptyBoxY, emptyBoxW, emptyBoxH, 16);
    ctx.fillStyle = 'rgba(11, 17, 26, 0.7)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `bold 18px ${boldFontStack}`;
    ctx.fillStyle = '#94A3B8';
    ctx.fillText('No rankings recorded yet for this category.', baseWidth / 2, emptyBoxY + emptyBoxH / 2);

    const buffer = await canvas.encode('png');
    return buffer;
  }

  // 4. Top 3 Tournament Podium Section (When count >= 3)
  let currentY = headerBottomY + 18;

  if (hasPodium) {
    const podiumCardW = 284;
    const podiumGap = 18;

    // Podium order: [ #2 Silver on Left, #1 Champion in Center, #3 Bronze on Right ]
    const podiumList = [
      {
        rank: 2,
        label: '#2',
        defaultColor: '#CBD5E1',
        item: slicedData[1],
        avatarImg: avatarImgs[1],
        isCenter: false
      },
      {
        rank: 1,
        label: '#1',
        defaultColor: '#FFD700',
        item: slicedData[0],
        avatarImg: avatarImgs[0],
        isCenter: true
      },
      {
        rank: 3,
        label: '#3',
        defaultColor: '#CD7F32',
        item: slicedData[2],
        avatarImg: avatarImgs[2],
        isCenter: false
      }
    ];

    podiumList.forEach((podium, idx) => {
      const { rank, label, defaultColor, item, avatarImg, isCenter } = podium;
      const cardX = padX + idx * (podiumCardW + podiumGap);
      const cardY = isCenter ? currentY : currentY + 10;
      const cardH = isCenter ? podiumH : podiumH - 10;

      // Dynamic color adoption: adopt custom profile / role color if available, fallback to gold/silver/bronze
      const userColor = item.accentColor || item.roleColor || defaultColor;
      const isWinner = mvpRecipients.includes(item.userId || item.user_id);

      // Card Background with dynamic user tint
      roundRect(ctx, cardX, cardY, podiumCardW, cardH, 18);
      const cardBgGrad = ctx.createLinearGradient(cardX, cardY, cardX, cardY + cardH);
      if (isCenter) {
        cardBgGrad.addColorStop(0, hexToRgba(userColor, 0.22));
        cardBgGrad.addColorStop(1, '#0C111A');
      } else {
        cardBgGrad.addColorStop(0, hexToRgba(userColor, 0.12));
        cardBgGrad.addColorStop(1, '#090D14');
      }
      ctx.fillStyle = cardBgGrad;
      ctx.fill();

      // Card Border with glow on #1
      ctx.save();
      if (isCenter) {
        ctx.shadowColor = hexToRgba(userColor, 0.45);
        ctx.shadowBlur = 16;
      }
      roundRect(ctx, cardX, cardY, podiumCardW, cardH, 18);
      ctx.strokeStyle = hexToRgba(userColor, isCenter ? 0.9 : 0.5);
      ctx.lineWidth = isCenter ? 2.5 : 1.5;
      ctx.stroke();
      ctx.restore();

      // Streamlined Rank Badge (#1, #2, #3) centered on top border
      const badgeW = isCenter ? 76 : 68;
      const badgeH = 26;
      const badgeX = cardX + (podiumCardW - badgeW) / 2;
      const badgeY = cardY - 13;

      roundRect(ctx, badgeX, badgeY, badgeW, badgeH, 13);
      ctx.fillStyle = userColor;
      ctx.fill();
      ctx.strokeStyle = '#080B10';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.font = `bold ${isCenter ? 15 : 14}px ${boldFontStack}`;
      ctx.fillStyle = '#080B10';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, badgeX + badgeW / 2, badgeY + badgeH / 2);

      // Large Avatar Portrait (Scaled up for mobile readability)
      const avatarD = isCenter ? 84 : 72;
      const avatarR = avatarD / 2;
      const avatarCenterX = cardX + podiumCardW / 2;
      const avatarCenterY = cardY + (isCenter ? 64 : 58);

      ctx.save();
      ctx.beginPath();
      ctx.arc(avatarCenterX, avatarCenterY, avatarR, 0, Math.PI * 2);
      ctx.clip();

      if (avatarImg) {
        ctx.drawImage(avatarImg, avatarCenterX - avatarR, avatarCenterY - avatarR, avatarD, avatarD);
      } else {
        ctx.fillStyle = '#1E293B';
        ctx.fillRect(avatarCenterX - avatarR, avatarCenterY - avatarR, avatarD, avatarD);
        ctx.font = `bold ${isCenter ? 32 : 28}px ${boldFontStack}`;
        ctx.fillStyle = userColor;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(safeFirstChar(item.displayName), avatarCenterX, avatarCenterY);
      }
      ctx.restore();

      // Glowing Avatar Ring
      ctx.save();
      ctx.beginPath();
      ctx.arc(avatarCenterX, avatarCenterY, avatarR, 0, Math.PI * 2);
      ctx.strokeStyle = userColor;
      ctx.lineWidth = isCenter ? 3.5 : 2.5;
      ctx.stroke();
      ctx.restore();

      // Display Name Only (Server nickname) with auto-scaling to eliminate truncation/overflow
      const nameY = cardY + (isCenter ? 134 : 124);
      const maxNameWidth = podiumCardW - 24;
      const rawName = item.displayName || 'Unknown';
      const nameToDisplay = isWinner ? `${rawName} ★` : rawName;

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#FFFFFF';
      drawFittedText(ctx, nameToDisplay, avatarCenterX, nameY, maxNameWidth, isCenter ? 22 : 19, 13, true);

      // Highlighted Value Capsule Pill
      const valText = formatLeaderboardValue(item, theme, currencyName);
      const valPillW = Math.min(podiumCardW - 32, Math.max(140, ctx.measureText(valText).width + 36));
      const valPillH = isCenter ? 34 : 30;
      const valPillX = cardX + (podiumCardW - valPillW) / 2;
      const valPillY = cardY + cardH - valPillH - (isCenter ? 18 : 14);

      roundRect(ctx, valPillX, valPillY, valPillW, valPillH, 10);
      ctx.fillStyle = hexToRgba(userColor, 0.18);
      ctx.fill();
      ctx.strokeStyle = hexToRgba(userColor, 0.45);
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.font = `bold ${isCenter ? 16 : 14}px ${boldFontStack}`;
      ctx.fillStyle = userColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(valText, valPillX + valPillW / 2, valPillY + valPillH / 2);
    });

    currentY += podiumH + podiumMarginBottom;
  }

  // 5. Ranks 4 Through 10 Stacked Rows (High-Legibility Mobile Format)
  const listData = hasPodium ? slicedData.slice(3) : slicedData;
  const listStartRank = hasPodium ? 4 : 1;

  if (listData.length > 0) {
    const rowW = baseWidth - padX * 2;

    listData.forEach((item, idx) => {
      const rank = listStartRank + idx;
      const rankStr = String(rank).padStart(2, '0');
      const avatarImg = avatarImgs[hasPodium ? idx + 3 : idx];
      const curY = currentY + idx * (rowH + rowGap);

      // Dynamic color parity with profile/role color
      const userColor = item.accentColor || item.roleColor || theme.themeColor;
      const isWinner = mvpRecipients.includes(item.userId || item.user_id);

      // Row container with subtle dynamic tint
      roundRect(ctx, padX, curY, rowW, rowH, 12);
      ctx.fillStyle = 'rgba(11, 17, 26, 0.75)';
      ctx.fill();
      ctx.strokeStyle = hexToRgba(userColor, 0.25);
      ctx.lineWidth = 1;
      ctx.stroke();

      // Rank Pill Badge on Left
      const rankPillW = 44;
      const rankPillH = 34;
      const rankPillX = padX + 10;
      const rankPillY = curY + (rowH - rankPillH) / 2;

      roundRect(ctx, rankPillX, rankPillY, rankPillW, rankPillH, 8);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.font = `bold 16px ${boldFontStack}`;
      ctx.fillStyle = '#94A3B8';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(rankStr, rankPillX + rankPillW / 2, rankPillY + rankPillH / 2);

      // Scaled Up Circular User Avatar (40px)
      const avatarD = 40;
      const avatarR = avatarD / 2;
      const avatarCenterX = padX + 76 + avatarR;
      const avatarCenterY = curY + rowH / 2;

      ctx.save();
      ctx.beginPath();
      ctx.arc(avatarCenterX, avatarCenterY, avatarR, 0, Math.PI * 2);
      ctx.clip();

      if (avatarImg) {
        ctx.drawImage(avatarImg, avatarCenterX - avatarR, avatarCenterY - avatarR, avatarD, avatarD);
      } else {
        ctx.fillStyle = '#1E293B';
        ctx.fillRect(avatarCenterX - avatarR, avatarCenterY - avatarR, avatarD, avatarD);
        ctx.font = `bold 18px ${boldFontStack}`;
        ctx.fillStyle = userColor;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(safeFirstChar(item.displayName), avatarCenterX, avatarCenterY);
      }
      ctx.restore();

      // Avatar Border Ring
      ctx.beginPath();
      ctx.arc(avatarCenterX, avatarCenterY, avatarR, 0, Math.PI * 2);
      ctx.strokeStyle = hexToRgba(userColor, 0.6);
      ctx.lineWidth = 2;
      ctx.stroke();

      // Right-Aligned Metric Capsule
      const valText = formatLeaderboardValue(item, theme, currencyName);
      ctx.font = `bold 15px ${boldFontStack}`;
      const measuredValW = ctx.measureText(valText).width;
      const scoreBadgeW = Math.max(120, measuredValW + 28);
      const scoreBadgeH = 34;
      const scoreBadgeX = padX + rowW - scoreBadgeW - 12;
      const scoreBadgeY = curY + (rowH - scoreBadgeH) / 2;

      roundRect(ctx, scoreBadgeX, scoreBadgeY, scoreBadgeW, scoreBadgeH, 8);
      ctx.fillStyle = hexToRgba(userColor, 0.12);
      ctx.fill();
      ctx.strokeStyle = hexToRgba(userColor, 0.3);
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = '#FFFFFF';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(valText, scoreBadgeX + scoreBadgeW / 2, scoreBadgeY + scoreBadgeH / 2);

      // Server Display Name Only (Zero Subheaders/Handles) with Auto-Scaling
      const nameStartX = avatarCenterX + avatarR + 16;
      const maxNameWidth = scoreBadgeX - nameStartX - 16;
      const rawName = item.displayName || 'Unknown';
      const nameToDisplay = isWinner ? `${rawName} ★` : rawName;

      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#FFFFFF';
      drawFittedText(ctx, nameToDisplay, nameStartX, curY + rowH / 2, maxNameWidth, 19, 13, true);
    });
  }

  const buffer = await canvas.encode('png');
  const duration = Math.round(performance.now() - renderStart);
  if (duration > 500) {
    sysWarn('Slow Leaderboard Card Render', { category, count, duration });
  } else {
    sysLog('Leaderboard Card Rendered', { category, count, duration });
  }

  return buffer;
}
