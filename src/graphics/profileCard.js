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
  ctx.lineTo(x, y + radius.tl);
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
  ctx.font = `bold ${Math.round(radius * 1.05)}px "Segoe UI", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('$', x, y + 0.5);
  ctx.restore();
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
  const height = 240;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

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
    questsDone = 0,
    itemCount = 0,
    customCoinUrl = null,
    isBooster = false,
    boostPct = 0,
    accentColor = '#00E5FF'
  } = profileData;

  const fontStack = '"Roboto", "Segoe UI", "DejaVu Sans", "Helvetica Neue", Arial, sans-serif';

  // 1. Base Canvas Background (Deep Obsidian Gradient)
  const bgGrad = ctx.createLinearGradient(0, 0, width, height);
  bgGrad.addColorStop(0, '#0D1117');
  bgGrad.addColorStop(0.65, '#131922');
  bgGrad.addColorStop(1, '#161E2E');
  ctx.fillStyle = bgGrad;
  roundRect(ctx, 0, 0, width, height, 16);
  ctx.fill();

  // Subtle ambient radial glow (top-left near avatar & top-right)
  const glowGrad = ctx.createRadialGradient(80, 80, 10, 80, 80, 220);
  glowGrad.addColorStop(0, 'rgba(0, 229, 255, 0.16)');
  glowGrad.addColorStop(1, 'transparent');
  ctx.fillStyle = glowGrad;
  ctx.fillRect(0, 0, 420, 240);

  const glowRight = ctx.createRadialGradient(width - 120, 60, 10, width - 120, 60, 240);
  glowRight.addColorStop(0, 'rgba(88, 101, 242, 0.12)');
  glowRight.addColorStop(1, 'transparent');
  ctx.fillStyle = glowRight;
  ctx.fillRect(width - 450, 0, 450, 240);

  // Outer border with soft rounded corners
  roundRect(ctx, 1.5, 1.5, width - 3, height - 3, 16);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // 2. Fetch images concurrently (Avatar & Custom Coin)
  const [avatarImg, customCoinImg] = await Promise.all([
    fetchImageSafe(avatarUrl),
    fetchImageSafe(customCoinUrl)
  ]);

  // 3. User Avatar (Circular portrait with glowing accent border)
  const avatarX = 36;
  const avatarY = 32;
  const avatarSize = 104;
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
    ctx.font = `bold 44px ${fontStack}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((displayName[0] || 'U').toUpperCase(), avatarX + avatarRadius, avatarY + avatarRadius);
  }
  ctx.restore();

  // Avatar Border Ring with subtle glow
  ctx.save();
  ctx.shadowColor = accentColor;
  ctx.shadowBlur = 10;
  ctx.beginPath();
  ctx.arc(avatarX + avatarRadius, avatarY + avatarRadius, avatarRadius, 0, Math.PI * 2);
  ctx.strokeStyle = accentColor;
  ctx.lineWidth = 3.5;
  ctx.stroke();
  ctx.restore();

  // 4. Content Area (To the right of Avatar)
  const contentX = avatarX + avatarSize + 26;
  const contentWidth = width - contentX - 36;

  // Header: Username (@username) in Arcane style
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';

  const userHandle = `@${username}`;
  ctx.font = `bold 30px ${fontStack}`;
  ctx.fillStyle = '#FFFFFF';

  let handleText = userHandle;
  const maxHandleWidth = contentWidth - 180;
  if (ctx.measureText(handleText).width > maxHandleWidth) {
    while (ctx.measureText(handleText + '...').width > maxHandleWidth && handleText.length > 0) {
      handleText = handleText.slice(0, -1);
    }
    handleText += '...';
  }
  ctx.fillText(handleText, contentX, 32);

  // Optional Badges (Booster pill, XP boost)
  let badgeX = contentX + ctx.measureText(handleText).width + 16;
  if (isBooster) {
    const badgeW = 76;
    const badgeH = 22;
    roundRect(ctx, badgeX, 36, badgeW, badgeH, 11);
    ctx.fillStyle = 'rgba(244, 127, 255, 0.18)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(244, 127, 255, 0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = '#F47FFF';
    ctx.font = `bold 11px ${fontStack}`;
    ctx.textAlign = 'center';
    ctx.fillText('BOOSTER', badgeX + badgeW / 2, 40);
    badgeX += badgeW + 8;
  }

  if (boostPct > 0) {
    const boostLabel = `+${boostPct}% XP`;
    ctx.font = `bold 11px ${fontStack}`;
    const boostW = ctx.measureText(boostLabel).width + 16;
    const boostH = 22;
    roundRect(ctx, badgeX, 36, boostW, boostH, 11);
    ctx.fillStyle = 'rgba(56, 239, 125, 0.18)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(56, 239, 125, 0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = '#38EF7D';
    ctx.textAlign = 'center';
    ctx.fillText(boostLabel, badgeX + boostW / 2, 40);
  }

  // Accent Underline beneath username (Exact Arcane signature visual)
  const underlineY = 72;
  const underlineWidth = Math.min(contentWidth, 540);
  ctx.beginPath();
  ctx.moveTo(contentX, underlineY);
  ctx.lineTo(contentX + underlineWidth, underlineY);
  ctx.strokeStyle = accentColor;
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // 5. Statistics Row (Above the progress bar)
  // Format: Level: 41 | XP: 1.1K / 4.2K | Rank: #156 | [Coin] 12,450 | Quests: 14 | Items: 28
  const statsY = 88;
  let curStatX = contentX;

  // Stat item helper
  function drawStat(label, value, valueColor = '#FFFFFF') {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    ctx.font = `bold 15px ${fontStack}`;
    ctx.fillStyle = '#8B949E';
    ctx.fillText(`${label}: `, curStatX, statsY);
    curStatX += ctx.measureText(`${label}: `).width;

    ctx.font = `bold 16px ${fontStack}`;
    ctx.fillStyle = valueColor;
    ctx.fillText(value, curStatX, statsY);
    curStatX += ctx.measureText(value).width + 24;
  }

  // Level
  drawStat('Level', String(currentLevel), '#FFFFFF');

  // XP
  const xpCurrentCompact = formatCompactNumber(Math.floor(xpIntoCurrentLevel));
  const xpNeededCompact = formatCompactNumber(Math.floor(xpForNextLevel));
  drawStat('XP', `${xpCurrentCompact} / ${xpNeededCompact}`, '#FFFFFF');

  // Rank
  drawStat('Rank', `#${rank}`, rank === 1 ? '#FFD700' : '#FFFFFF');

  // Coins (with coin image/vector)
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.font = `bold 15px ${fontStack}`;
  ctx.fillStyle = '#8B949E';
  ctx.fillText('Coins: ', curStatX, statsY);
  curStatX += ctx.measureText('Coins: ').width;

  const coinIconSize = 18;
  const coinIconY = statsY + 1;
  if (customCoinImg) {
    ctx.drawImage(customCoinImg, curStatX, coinIconY, coinIconSize, coinIconSize);
  } else {
    drawVectorCoin(ctx, curStatX + coinIconSize / 2, coinIconY + coinIconSize / 2, coinIconSize / 2);
  }
  curStatX += coinIconSize + 6;

  ctx.font = `bold 16px ${fontStack}`;
  ctx.fillStyle = '#FFD700';
  const coinText = formatCompactNumber(balance);
  ctx.fillText(coinText, curStatX, statsY);
  curStatX += ctx.measureText(coinText).width + 24;

  // Quests Done
  drawStat('Quests', String(questsDone), '#38EF7D');

  // Items Owned
  drawStat('Items', String(itemCount), '#A29BFE');

  // 6. XP Progress Bar (Bottom Capsule Meter)
  const barX = 36;
  const barY = 160;
  const barWidth = width - 72;
  const barHeight = 26;
  const barRadius = 13;

  const requiredXp = Math.max(1, xpForNextLevel);
  const currentXp = Math.max(0, xpIntoCurrentLevel);
  const progressRatio = Math.min(1, Math.max(0, currentXp / requiredXp));

  // Progress Bar Track (Clean high-contrast rounded capsule)
  roundRect(ctx, barX, barY, barWidth, barHeight, barRadius);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();

  // Progress Bar Filled Portion (Vibrant Cyan-to-Blue pill fill)
  if (progressRatio > 0) {
    const minFillWidth = barRadius * 2;
    const fillWidth = Math.max(minFillWidth, barWidth * progressRatio);

    ctx.save();
    // Clip to pill container
    roundRect(ctx, barX, barY, barWidth, barHeight, barRadius);
    ctx.clip();

    // Draw filled bar with rounded ends
    roundRect(ctx, barX, barY, fillWidth, barHeight, barRadius);
    const fillGrad = ctx.createLinearGradient(barX, 0, barX + fillWidth, 0);
    fillGrad.addColorStop(0, '#00E5FF');
    fillGrad.addColorStop(1, '#00B4D8');
    ctx.fillStyle = fillGrad;
    ctx.fill();
    ctx.restore();
  }

  // XP Progress Label (Under Progress Bar)
  ctx.font = `12px ${fontStack}`;
  ctx.fillStyle = '#8B949E';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('Level Progression', barX + 4, barY + barHeight + 8);

  ctx.textAlign = 'right';
  const xpDetailed = `${Math.floor(currentXp).toLocaleString()} / ${Math.floor(requiredXp).toLocaleString()} XP (${Math.round(progressRatio * 100)}%)`;
  ctx.fillText(xpDetailed, barX + barWidth - 4, barY + barHeight + 8);

  return await canvas.encode('png');
}
