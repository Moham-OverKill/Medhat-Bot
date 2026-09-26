import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { sysError, sysLog } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fontsDir = path.resolve(__dirname, '../assets/fonts');

// Register bundled Roboto fonts for consistent font rendering across all platforms and Docker
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
  sysError('Font Registration Error', err);
}

/**
 * Format numbers with compact suffixes (e.g., 1.5K, 2.3M) or standard commas
 * @param {number} num
 * @returns {string}
 */
export function formatCompactNumber(num) {
  const n = Number(num) || 0;
  if (Math.abs(n) >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1).replace(/\.0$/, '') + 'B';
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (Math.abs(n) >= 10_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return n.toLocaleString();
}

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
 * Safely fetch an external image with timeout and buffer fallback
 * @param {string} url
 * @returns {Promise<import('@napi-rs/canvas').Image|null>}
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
 * Draw a crisp, high-resolution golden coin vector on canvas
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x - Center X
 * @param {number} y - Center Y
 * @param {number} radius - Coin radius
 */
function drawVectorCoin(ctx, x, y, radius) {
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
  ctx.font = `bold ${Math.round(radius * 1.05)}px "Roboto", "Segoe UI", Arial, sans-serif`;
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
function hexToRgba(hex, alpha = 1) {
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
function shiftColorBrightness(hex, percent) {
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
 * Extract dominant vibrant color from an avatar image
 * @param {import('@napi-rs/canvas').Image} img
 * @returns {string|null} Hex color code or null
 */
function extractDominantColor(img) {
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

      if (a < 128) continue; // transparent pixel

      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const delta = max - min;
      const brightness = (r + g + b) / 3;

      // Filter out extreme darks, extreme lights, and low-saturation grays
      if (brightness < 30 || brightness > 235) continue;
      if (delta < 20) continue;

      // Quantize to 5 bits per channel (16-step quantization)
      const qr = Math.min(255, Math.round(r / 16) * 16);
      const qg = Math.min(255, Math.round(g / 16) * 16);
      const qb = Math.min(255, Math.round(b / 16) * 16);
      const key = (qr << 16) | (qg << 8) | qb;

      // Weight by saturation and hue intensity
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
 * Generate Arcane-style Profile Card Buffer
 *
 * @param {object} profileData
 * @param {string} profileData.displayName
 * @param {string} profileData.username
 * @param {string} [profileData.avatarUrl]
 * @param {number} profileData.currentLevel
 * @param {number} profileData.rank
 * @param {number} profileData.xpIntoCurrentLevel
 * @param {number} profileData.xpForNextLevel
 * @param {number} profileData.totalXp
 * @param {number} profileData.balance
 * @param {number} [profileData.streak=0]
 * @param {number} profileData.questsDone
 * @param {number} profileData.itemCount
 * @param {string} [profileData.customCoinUrl]
 * @param {boolean} [profileData.isBooster=false]
 * @param {number} [profileData.boostPct=0]
 * @param {string} [profileData.accentColor='#00E5FF']
 * @returns {Promise<Buffer>}
 */
export async function generateProfileCard(profileData) {
  const width = 960;
  const height = 260;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const {
    displayName = 'User',
    username = 'user',
    avatarUrl,
    currentLevel = 0,
    rank = 1,
    xpIntoCurrentLevel = 0,
    xpForNextLevel = 100,
    totalXp = 0,
    balance = 0,
    streak = 0,
    questsDone = 0,
    itemCount = 0,
    customCoinUrl = null,
    isOwner = false,
    isBooster = false,
    isMvp = false,
    boostPct = 0,
    accentColor = '#00E5FF'
  } = profileData;

  const fontStack = '"Roboto", "Segoe UI", "DejaVu Sans", "Helvetica Neue", Arial, sans-serif';

  // 1. Fetch images concurrently (Avatar & Custom Coin)
  const [avatarImg, customCoinImg] = await Promise.all([
    fetchImageSafe(avatarUrl),
    fetchImageSafe(customCoinUrl)
  ]);

  // Extract dominant vibrant color from avatar, fallback to server role color or cyan
  const dominantAvatarColor = extractDominantColor(avatarImg);
  const themeColor = dominantAvatarColor || accentColor || '#00E5FF';

  // 2. Base Canvas Background (Deep Obsidian Gradient)
  const bgGrad = ctx.createLinearGradient(0, 0, width, height);
  bgGrad.addColorStop(0, '#0B0F15');
  bgGrad.addColorStop(0.5, '#111722');
  bgGrad.addColorStop(1, '#151D2A');
  ctx.fillStyle = bgGrad;
  roundRect(ctx, 0, 0, width, height, 16);
  ctx.fill();

  // Subtle ambient radial glow matched to avatar dominant color (behind avatar on left)
  const glowGrad = ctx.createRadialGradient(90, 85, 10, 90, 85, 230);
  glowGrad.addColorStop(0, hexToRgba(themeColor, 0.22));
  glowGrad.addColorStop(1, 'transparent');
  ctx.fillStyle = glowGrad;
  ctx.fillRect(0, 0, 450, 260);

  // Outer border with soft rounded corners
  roundRect(ctx, 1.5, 1.5, width - 3, height - 3, 16);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // 3. User Avatar (Circular portrait with glowing accent border)
  const avatarX = 36;
  const avatarY = 32;
  const avatarSize = 110;
  const avatarRadius = avatarSize / 2;

  ctx.save();
  ctx.beginPath();
  ctx.arc(avatarX + avatarRadius, avatarY + avatarRadius, avatarRadius, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();

  if (avatarImg) {
    ctx.drawImage(avatarImg, avatarX, avatarY, avatarSize, avatarSize);
  } else {
    // Fallback monogram avatar
    ctx.fillStyle = '#21262D';
    ctx.fillRect(avatarX, avatarY, avatarSize, avatarSize);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = `bold 48px ${fontStack}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((displayName[0] || 'U').toUpperCase(), avatarX + avatarRadius, avatarY + avatarRadius);
  }
  ctx.restore();

  // Avatar Border Ring with glowing theme color
  ctx.save();
  ctx.shadowColor = themeColor;
  ctx.shadowBlur = 14;
  ctx.beginPath();
  ctx.arc(avatarX + avatarRadius, avatarY + avatarRadius, avatarRadius, 0, Math.PI * 2);
  ctx.strokeStyle = themeColor;
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.restore();

  // 4. Content Area (To the right of Avatar)
  const contentX = avatarX + avatarSize + 28;
  const contentWidth = width - contentX - 36;

  // Header: Username (@username) in Arcane style - prominent 36px font
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';

  const userHandle = `@${username}`;
  ctx.font = `bold 36px ${fontStack}`;
  ctx.fillStyle = '#FFFFFF';

  let handleText = userHandle;
  let totalBadgesWidth = 0;
  if (isOwner) totalBadgesWidth += 68 + 8;
  if (isMvp) totalBadgesWidth += 54 + 8;
  if (isBooster) totalBadgesWidth += 76 + 8;
  if (totalBadgesWidth > 0) totalBadgesWidth += 16;

  const maxHandleWidth = Math.max(160, contentWidth - totalBadgesWidth);
  if (ctx.measureText(handleText).width > maxHandleWidth) {
    while (ctx.measureText(handleText + '...').width > maxHandleWidth && handleText.length > 0) {
      handleText = handleText.slice(0, -1);
    }
    handleText += '...';
  }
  ctx.fillText(handleText, contentX, 28);

  // Badges (Owner, MVP, Booster)
  let badgeX = contentX + ctx.measureText(handleText).width + 16;

  if (isOwner) {
    const badgeW = 68;
    const badgeH = 26;
    roundRect(ctx, badgeX, 34, badgeW, badgeH, 13);
    ctx.fillStyle = 'rgba(255, 68, 85, 0.18)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 68, 85, 0.6)';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    ctx.fillStyle = '#FF4455';
    ctx.font = `bold 12px ${fontStack}`;
    ctx.textAlign = 'center';
    ctx.fillText('OWNER', badgeX + badgeW / 2, 40);
    badgeX += badgeW + 8;
  }

  if (isMvp) {
    const badgeW = 54;
    const badgeH = 26;
    roundRect(ctx, badgeX, 34, badgeW, badgeH, 13);
    ctx.fillStyle = 'rgba(255, 215, 0, 0.18)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 215, 0, 0.6)';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    ctx.fillStyle = '#FFD700';
    ctx.font = `bold 12px ${fontStack}`;
    ctx.textAlign = 'center';
    ctx.fillText('MVP', badgeX + badgeW / 2, 40);
    badgeX += badgeW + 8;
  }

  if (isBooster) {
    const badgeW = 76;
    const badgeH = 26;
    roundRect(ctx, badgeX, 34, badgeW, badgeH, 13);
    ctx.fillStyle = 'rgba(244, 127, 255, 0.2)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(244, 127, 255, 0.6)';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    ctx.fillStyle = '#F47FFF';
    ctx.font = `bold 12px ${fontStack}`;
    ctx.textAlign = 'center';
    ctx.fillText('BOOSTER', badgeX + badgeW / 2, 40);
    badgeX += badgeW + 8;
  }

  // Accent Underline spanning across content area
  const underlineY = 78;
  ctx.beginPath();
  ctx.moveTo(contentX, underlineY);
  ctx.lineTo(contentX + contentWidth, underlineY);
  const lineGrad = ctx.createLinearGradient(contentX, 0, contentX + contentWidth, 0);
  lineGrad.addColorStop(0, themeColor);
  lineGrad.addColorStop(0.85, themeColor);
  lineGrad.addColorStop(1, hexToRgba(themeColor, 0.2));
  ctx.strokeStyle = lineGrad;
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // 5. Statistics Row (Above the progress bar)
  // Reordered per user instruction: Level, Rank, Streak, Quests, Coins, Items (Coins then Items are last 2)
  // XP removed from this row to eliminate repetition with the progress bar underneath
  const stats = [
    { label: 'Level', value: String(currentLevel), color: '#FFFFFF' },
    { label: 'Rank', value: `#${rank}`, color: rank === 1 ? '#FFD700' : '#00E5FF' },
    { label: 'Streak', value: String(streak), color: '#FF7675' },
    { label: 'Quests', value: String(questsDone), color: '#38EF7D' },
    { label: 'Coins', value: formatCompactNumber(balance), color: '#FFD700', isCoin: true },
    { label: 'Items', value: String(itemCount), color: '#C4B5FD' }
  ];

  // Measure all stats to evenly distribute them across contentWidth with zero empty space
  const coinIconSize = 28;
  const coinSpacing = 8;
  const measured = stats.map(st => {
    ctx.font = `bold 17px ${fontStack}`;
    const labelW = ctx.measureText(st.label + ': ').width;
    ctx.font = `bold 22px ${fontStack}`;
    const valW = ctx.measureText(st.value).width;
    const coinW = st.isCoin ? (coinIconSize + coinSpacing) : 0;
    return { ...st, width: labelW + coinW + valW, labelW, valW, coinW };
  });

  const totalStatsW = measured.reduce((acc, m) => acc + m.width, 0);
  const gap = Math.max(16, (contentWidth - totalStatsW) / (measured.length - 1));
  const statsY = 98;
  let curX = contentX;

  measured.forEach((st) => {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    // Label
    ctx.font = `bold 17px ${fontStack}`;
    ctx.fillStyle = '#94A3B8';
    ctx.fillText(st.label + ':', curX, statsY);

    let valX = curX + st.labelW;

    if (st.isCoin) {
      const coinIconY = statsY - 3;
      if (customCoinImg) {
        ctx.drawImage(customCoinImg, valX, coinIconY, coinIconSize, coinIconSize);
      } else {
        drawVectorCoin(ctx, valX + coinIconSize / 2, coinIconY + coinIconSize / 2, coinIconSize / 2);
      }
      valX += coinIconSize + coinSpacing;
    }

    // Value
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = `bold 22px ${fontStack}`;
    ctx.fillStyle = st.color;
    ctx.fillText(st.value, valX, statsY - 2);

    curX += st.width + gap;
  });

  // 6. XP Progress Bar (Bottom Capsule Meter)
  const barX = 36;
  const barY = 168;
  const barWidth = width - 72;
  const barHeight = 28;
  const barRadius = 14;

  const requiredXp = Math.max(1, xpForNextLevel);
  const currentXp = Math.max(0, xpIntoCurrentLevel);
  const progressRatio = Math.min(1, Math.max(0, currentXp / requiredXp));

  // Progress Bar Track & Fill
  if (progressRatio <= 0) {
    // 0% progress: whole track is white capsule
    roundRect(ctx, barX, barY, barWidth, barHeight, barRadius);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
  } else if (progressRatio >= 1) {
    // 100% progress: full capsule filled with theme gradient
    roundRect(ctx, barX, barY, barWidth, barHeight, barRadius);
    const fillGrad = ctx.createLinearGradient(barX, 0, barX + barWidth, 0);
    fillGrad.addColorStop(0, themeColor);
    fillGrad.addColorStop(1, shiftColorBrightness(themeColor, -0.25));
    ctx.fillStyle = fillGrad;
    ctx.fill();
  } else {
    // Partial progress: clip to track capsule so the rounded outer bounds are preserved
    const minFillWidth = barRadius * 2;
    const fillWidth = Math.max(minFillWidth, barWidth * progressRatio);

    ctx.save();
    roundRect(ctx, barX, barY, barWidth, barHeight, barRadius);
    ctx.clip();

    // White unfilled track rendered ONLY behind the unfilled area (preventing white fringe on the left cap)
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(barX + fillWidth - barRadius, barY - 2, barWidth - fillWidth + barRadius + 4, barHeight + 4);

    // Filled portion with dynamic gradient and rounded right end cap
    roundRect(ctx, barX, barY, fillWidth, barHeight, barRadius);
    const fillGrad = ctx.createLinearGradient(barX, 0, barX + fillWidth, 0);
    fillGrad.addColorStop(0, themeColor);
    fillGrad.addColorStop(1, shiftColorBrightness(themeColor, -0.25));
    ctx.fillStyle = fillGrad;
    ctx.fill();

    ctx.restore();
  }

  // XP Progress Label (Under Progress Bar) - Bigger, bolder typography
  const textY = barY + barHeight + 10;
  ctx.font = `bold 15px ${fontStack}`;
  ctx.fillStyle = '#94A3B8';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('Level Progression', barX + 4, textY);

  ctx.textAlign = 'right';
  ctx.font = `bold 16px ${fontStack}`;
  ctx.fillStyle = '#E2E8F0';
  const xpDetailed = `${Math.floor(currentXp).toLocaleString()} / ${Math.floor(requiredXp).toLocaleString()} XP (${Math.round(progressRatio * 100)}%)`;
  ctx.fillText(xpDetailed, barX + barWidth - 4, textY);

  return await canvas.encode('png');
}
