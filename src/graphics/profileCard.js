import { createCanvas } from '@napi-rs/canvas';
import { performance } from 'node:perf_hooks';
import { logger, sysWarn, sysLog } from '../utils/logger.js';
import crypto from 'node:crypto';
import { COIN_NAME } from '../shared.js';
import {
  fontStack,
  roundRect,
  drawVectorCoin,
  hexToRgba,
  shiftColorBrightness,
  extractDominantColor,
  fetchImageSafe,
  formatCompactNumber,
  safeFirstChar
} from './shared.js';

export { formatCompactNumber, extractDominantColor };

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

/**
 * Draw a pill badge vertically centered on a specific Y axis
 */
function drawBadge(ctx, x, centerY, text, textColor, bgColor, borderColor) {
  ctx.font = `bold 11px ${fontStack}`;
  const textW = ctx.measureText(text).width;
  const badgeW = Math.round(textW + 16);
  const badgeH = 24;
  const badgeY = Math.round(centerY - badgeH / 2);

  roundRect(ctx, x, badgeY, badgeW, badgeH, badgeH / 2);
  ctx.fillStyle = bgColor;
  ctx.fill();
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = textColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + badgeW / 2, centerY);

  return badgeW;
}

const profileCardBufferCache = new Map();
const PROFILE_BUFFER_CACHE_MAX = 25;

/**
 * Computes a deterministic SHA-256 hash from all visual profile state attributes.
 * Any change in user metrics, badges, names, or appearance yields a completely new hash.
 * @param {object} data
 * @returns {string} SHA-256 hash string
 */
export function computeProfileStateHash(data) {
  const payload = [
    data.guildId || '',
    data.userId || data.username || '',
    data.displayName || '',
    data.username || '',
    data.avatarUrl || '',
    data.currentLevel ?? 0,
    data.rank ?? 0,
    data.xpIntoCurrentLevel ?? 0,
    data.xpForNextLevel ?? 0,
    data.totalXp ?? 0,
    data.balance ?? 0,
    data.streak ?? 0,
    data.questsDone ?? 0,
    data.itemCount ?? 0,
    data.customCoinUrl || '',
    Boolean(data.isOwner),
    Boolean(data.isBooster),
    Boolean(data.isMvp),
    data.boostPct ?? 0,
    data.accentColor || ''
  ].join('|');

  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Invalidate the cached profile card for a user if manually needed.
 * @param {string} guildId
 * @param {string} userId
 */
export function invalidateProfileCardCache(guildId, userId) {
  if (!guildId || !userId) return;
  profileCardBufferCache.delete(`${guildId}_${userId}`);
}

export async function generateProfileCard(profileData) {
  const userKey = (profileData.guildId && profileData.userId)
    ? `${profileData.guildId}_${profileData.userId}`
    : (profileData.userId || profileData.username || 'default');

  const stateHash = computeProfileStateHash(profileData);
  const cached = profileCardBufferCache.get(userKey);

  if (cached && cached.stateHash === stateHash) {
    // Exact state match: metrics have not changed. Re-insert for LRU freshness and return buffer instantly.
    profileCardBufferCache.delete(userKey);
    profileCardBufferCache.set(userKey, cached);
    sysLog('Profile Card Served from State Cache', {
      detail: `@${profileData.username || userKey} (State unchanged: ${stateHash.slice(0, 8)})`
    });
    return cached.buffer;
  }

  const renderStart = performance.now();
  const baseWidth = 960;
  const baseHeight = 260;
  const scale = 2; // 2x Retina Super-Sampling for crystal-sharp rendering
  const canvas = createCanvas(Math.round(baseWidth * scale), Math.round(baseHeight * scale));
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const width = baseWidth;
  const height = baseHeight;

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
    accentColor = '#00E5FF',
    guildId = null,
    coinName = null
  } = profileData;

  // 1. Fetch images concurrently (Avatar & Custom Coin)
  const [avatarImg, customCoinImg] = await Promise.all([
    fetchImageSafe(avatarUrl),
    fetchImageSafe(customCoinUrl)
  ]);

  // Extract dominant vibrant color from avatar, fallback to server role color or cyan
  const dominantAvatarColor = extractDominantColor(avatarImg);
  const themeColor = dominantAvatarColor || accentColor || '#00E5FF';

  // 2. Base Canvas Background & Corner Clipping (Transparent rounded PNG)
  const cardRadius = 24;
  ctx.save();
  roundRect(ctx, 0, 0, width, height, cardRadius);
  ctx.clip();

  const bgGrad = ctx.createLinearGradient(0, 0, width, height);
  bgGrad.addColorStop(0, '#0B0F15');
  bgGrad.addColorStop(0.5, '#111722');
  bgGrad.addColorStop(1, '#151D2A');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, width, height);

  // Subtle ambient radial glow matched to avatar dominant color (behind avatar on left)
  const glowGrad = ctx.createRadialGradient(90, 85, 10, 90, 85, 230);
  glowGrad.addColorStop(0, hexToRgba(themeColor, 0.22));
  glowGrad.addColorStop(1, 'transparent');
  ctx.fillStyle = glowGrad;
  ctx.fillRect(0, 0, 450, height);

  ctx.restore();

  // Outer border with soft rounded corners matching card radius and state accent tint (Reinforced thickness)
  const borderThickness = 4;
  const halfBorder = borderThickness / 2;
  roundRect(ctx, halfBorder, halfBorder, width - borderThickness, height - borderThickness, cardRadius - halfBorder);
  ctx.strokeStyle = hexToRgba(themeColor, 0.6);
  ctx.lineWidth = borderThickness;
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
    ctx.fillText(safeFirstChar(displayName).toUpperCase(), avatarX + avatarRadius, avatarY + avatarRadius);
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
  const headerCenterY = 40;
  const badgeCenterY = headerCenterY + 0.5;

  // Header: Username (@username) in Arcane style - prominent 32px font vertically centered
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  const userHandle = `@${username}`;
  ctx.font = `bold 32px ${fontStack}`;
  ctx.fillStyle = '#FFFFFF';

  let handleText = userHandle;
  let totalBadgesWidth = 0;
  if (isOwner) totalBadgesWidth += 62 + 8;
  if (isMvp) totalBadgesWidth += 48 + 8;
  if (isBooster) totalBadgesWidth += 68 + 8;
  if (totalBadgesWidth > 0) totalBadgesWidth += 8;

  const maxHandleWidth = Math.max(160, contentWidth - totalBadgesWidth);
  if (ctx.measureText(handleText).width > maxHandleWidth) {
    while (ctx.measureText(handleText + '...').width > maxHandleWidth && handleText.length > 0) {
      handleText = handleText.slice(0, -1);
    }
    handleText += '...';
  }
  ctx.fillText(handleText, contentX, headerCenterY);

  // Badges: Optically aligned with text baseline and cap-height, docked immediately next to name
  let badgeX = contentX + Math.ceil(ctx.measureText(handleText).width) + 8;

  if (isOwner) {
    const bw = drawBadge(ctx, badgeX, badgeCenterY, 'OWNER', '#FF4455', 'rgba(255, 68, 85, 0.18)', 'rgba(255, 68, 85, 0.6)');
    badgeX += bw + 8;
  }

  if (isMvp) {
    const bw = drawBadge(ctx, badgeX, badgeCenterY, 'MVP', '#FFD700', 'rgba(255, 215, 0, 0.18)', 'rgba(255, 215, 0, 0.6)');
    badgeX += bw + 8;
  }

  if (isBooster) {
    const bw = drawBadge(ctx, badgeX, badgeCenterY, 'BOOSTER', '#F47FFF', 'rgba(244, 127, 255, 0.2)', 'rgba(244, 127, 255, 0.6)');
    badgeX += bw + 8;
  }

  // Accent Underline spanning across content area (Y = 82 provides generous clearance for descenders)
  const underlineY = 82;
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
  const coinLabel = coinName || (guildId ? COIN_NAME.forGuild(guildId) : 'Coins');
  const stats = [
    { label: 'Level', value: String(currentLevel), color: '#FFFFFF' },
    { label: 'Rank', value: `#${rank}`, color: rank === 1 ? '#FFD700' : '#00E5FF' },
    { label: 'Streak', value: String(streak), color: '#FF7675' },
    { label: 'Quests', value: String(questsDone), color: '#38EF7D' },
    { label: coinLabel, value: formatCompactNumber(balance), color: '#FFD700', isCoin: true },
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
  const statsY = 104;
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

  const buffer = await canvas.encode('png');
  const durationMs = Math.round(performance.now() - renderStart);
  if (durationMs > 500) {
    logger.warn('RENDER', `Slow profile card rendered in ${durationMs}ms for @${username}`, { user: username, durationMs });
  } else {
    logger.info('RENDER', `Profile card rendered in ${durationMs}ms for @${username}`, { user: username, durationMs });
  }

  if (profileCardBufferCache.size >= PROFILE_BUFFER_CACHE_MAX) {
    const oldestKey = profileCardBufferCache.keys().next().value;
    profileCardBufferCache.delete(oldestKey);
  }
  profileCardBufferCache.set(userKey, { stateHash, buffer });

  return buffer;
}
