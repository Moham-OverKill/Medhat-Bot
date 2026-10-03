import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fontsDir = path.resolve(__dirname, '../assets/fonts');

// Register bundled fonts for consistent cross-platform typography
try {
  const cairoPath = path.join(fontsDir, 'Cairo.ttf');
  const notoPath = path.join(fontsDir, 'NotoSansArabic.ttf');
  const boldPath = path.join(fontsDir, 'Roboto-Bold.ttf');
  const regularPath = path.join(fontsDir, 'Roboto-Regular.ttf');
  const emojiPath = path.join(fontsDir, 'seguiemj.ttf');

  if (fs.existsSync(cairoPath)) GlobalFonts.registerFromPath(cairoPath, 'Cairo');
  if (fs.existsSync(notoPath)) GlobalFonts.registerFromPath(notoPath, 'Noto Sans Arabic');
  if (fs.existsSync(boldPath)) GlobalFonts.registerFromPath(boldPath, 'Roboto-Bold');
  if (fs.existsSync(regularPath)) GlobalFonts.registerFromPath(regularPath, 'Roboto');
  if (fs.existsSync(emojiPath)) GlobalFonts.registerFromPath(emojiPath, 'Segoe UI Emoji');
} catch {
  // Ignore duplicate registration errors
}

const boldFontStack = '"Roboto-Bold", "Roboto", "Cairo", "Noto Sans Arabic", "Segoe UI Emoji", "Segoe UI", Arial, sans-serif';
const regularFontStack = '"Roboto", "Cairo", "Noto Sans Arabic", "Segoe UI Emoji", "Segoe UI", Arial, sans-serif';

/**
 * Draw a rounded rectangle on a 2D canvas context
 */
function roundRect(ctx, x, y, width, height, radius) {
  let r = typeof radius === 'number'
    ? { tl: radius, tr: radius, br: radius, bl: radius }
    : { tl: radius?.tl || 0, tr: radius?.tr || 0, br: radius?.br || 0, bl: radius?.bl || 0 };

  ctx.beginPath();
  ctx.moveTo(x + r.tl, y);
  ctx.lineTo(x + width - r.tr, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r.tr);
  ctx.lineTo(x + width, y + height - r.br);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r.br, y + height);
  ctx.lineTo(x + r.bl, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r.bl);
  ctx.lineTo(x, y + r.tl);
  ctx.quadraticCurveTo(x, y, x + r.tl, y);
  ctx.closePath();
}

/**
 * Truncate text with ellipsis if it exceeds maxWidth
 */
function truncateText(ctx, text, maxWidth) {
  if (!text) return '';
  if (ctx.measureText(text).width <= maxWidth) return text;

  let truncated = text;
  while (truncated.length > 1 && ctx.measureText(truncated + '...').width > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return truncated.trim() + '...';
}

/**
 * Check if a hex color is valid
 */
function normalizeHex(hex) {
  if (!hex || typeof hex !== 'string') return '#80848E';
  let cleaned = hex.trim();
  if (!cleaned.startsWith('#')) cleaned = '#' + cleaned;
  if (/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(cleaned)) {
    return cleaned;
  }
  return '#80848E';
}

/**
 * Generate a visual color palette banner image
 * 
 * @param {Array<{ roleId: string, name: string, hexColor?: string, index: number }>} panelColors
 * @param {object} [options]
 * @param {string} [options.title] - Header title (e.g. 'NORMAL COLORS' or 'BOOSTER COLORS')
 * @param {string} [options.subtitle] - Header subtitle
 * @param {boolean} [options.isBooster] - Whether this panel uses booster theme styling
 * @param {number} [options.panelIndex] - Current panel zero-based index
 * @param {number} [options.totalPanels] - Total number of panels
 * @returns {Promise<Buffer>}
 */
export async function generateColorPanelImage(panelColors = [], options = {}) {
  const isBooster = Boolean(options.isBooster);
  const title = options.title || (isBooster ? 'BOOSTER COLORS' : 'NORMAL COLORS');
  const subtitle = options.subtitle || 'Select a number button below to equip your color';
  const panelIndex = typeof options.panelIndex === 'number' ? options.panelIndex : 0;
  const totalPanels = typeof options.totalPanels === 'number' ? options.totalPanels : 1;

  const canvasW = 1000;
  const headerH = 74;
  const cardW = 176;
  const cardH = 118;
  const gapX = 16;
  const gapY = 16;
  const marginY_bottom = 24;
  const marginX = Math.round((canvasW - (5 * cardW + 4 * gapX)) / 2); // 28px

  const count = panelColors.length;
  const rows = count > 5 ? 2 : 1;
  const canvasH = headerH + (rows * cardH) + ((rows - 1) * gapY) + marginY_bottom;

  const canvas = createCanvas(canvasW, canvasH);
  const ctx = canvas.getContext('2d');

  // 1. Background fill
  ctx.fillStyle = '#111214';
  roundRect(ctx, 0, 0, canvasW, canvasH, 16);
  ctx.fill();

  // Subtle background glow based on theme
  const accentColor = isBooster ? '#FEE75C' : '#5865F2';
  const bgGrad = ctx.createLinearGradient(0, 0, 0, canvasH);
  bgGrad.addColorStop(0, isBooster ? 'rgba(254, 231, 92, 0.08)' : 'rgba(88, 101, 242, 0.08)');
  bgGrad.addColorStop(0.5, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = bgGrad;
  roundRect(ctx, 0, 0, canvasW, canvasH, 16);
  ctx.fill();

  // Outer border
  ctx.strokeStyle = '#232428';
  ctx.lineWidth = 1.5;
  roundRect(ctx, 0, 0, canvasW, canvasH, 16);
  ctx.stroke();

  // 2. Header
  // Left accent pill
  ctx.fillStyle = accentColor;
  roundRect(ctx, marginX, 24, 4, 28, 2);
  ctx.fill();

  // Title text
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `bold 19px ${boldFontStack}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(title, marginX + 14, 38);

  // Subtitle text
  ctx.fillStyle = '#949BA4';
  ctx.font = `12px ${regularFontStack}`;
  ctx.fillText(subtitle, marginX + 14, 55);

  // Badge on the right
  const badgeText = totalPanels > 1
    ? `PANEL ${panelIndex + 1} / ${totalPanels}`
    : `${count} COLOR${count === 1 ? '' : 'S'}`;

  ctx.font = `bold 11px ${boldFontStack}`;
  const badgeWidth = ctx.measureText(badgeText).width + 20;
  const badgeX = canvasW - marginX - badgeWidth;
  const badgeY = 27;

  ctx.fillStyle = '#1E1F22';
  roundRect(ctx, badgeX, badgeY, badgeWidth, 22, 6);
  ctx.fill();

  ctx.strokeStyle = '#2B2D31';
  ctx.lineWidth = 1;
  roundRect(ctx, badgeX, badgeY, badgeWidth, 22, 6);
  ctx.stroke();

  ctx.fillStyle = '#B5BAC1';
  ctx.textAlign = 'center';
  ctx.fillText(badgeText, badgeX + badgeWidth / 2, badgeY + 15);

  // 3. Render Color Cards
  for (let i = 0; i < count; i++) {
    const item = panelColors[i];
    const col = i % 5;
    const row = Math.floor(i / 5);

    const x = marginX + col * (cardW + gapX);
    const y = headerH + row * (cardH + gapY);

    const hex = normalizeHex(item.hexColor);
    const labelNum = String(item.index || (i + 1)).padStart(2, '0');
    const roleName = item.name || `Color ${labelNum}`;

    // Card background
    ctx.fillStyle = '#1E1F22';
    roundRect(ctx, x, y, cardW, cardH, 10);
    ctx.fill();

    // Card border
    ctx.strokeStyle = '#2B2D31';
    ctx.lineWidth = 1;
    roundRect(ctx, x, y, cardW, cardH, 10);
    ctx.stroke();

    // Subtle top accent line using the role's color
    ctx.fillStyle = hex;
    roundRect(ctx, x + 20, y + 2, cardW - 40, 2.5, 1.5);
    ctx.fill();

    // Number badge (top-left)
    const numBadgeW = 30;
    const numBadgeH = 18;
    ctx.fillStyle = '#2B2D31';
    roundRect(ctx, x + 10, y + 10, numBadgeW, numBadgeH, 5);
    ctx.fill();

    ctx.fillStyle = '#FFFFFF';
    ctx.font = `bold 11px ${boldFontStack}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(labelNum, x + 10 + numBadgeW / 2, y + 10 + numBadgeH / 2);

    // Hex code (top-right)
    ctx.fillStyle = '#80848E';
    ctx.font = `11px ${regularFontStack}`;
    ctx.textAlign = 'right';
    ctx.fillText(hex.toUpperCase(), x + cardW - 10, y + 10 + numBadgeH / 2);

    // Color swatch circle (center)
    const swatchCx = x + cardW / 2;
    const swatchCy = y + 54;
    const swatchRadius = 18;

    // Soft drop glow under swatch
    ctx.save();
    ctx.beginPath();
    ctx.arc(swatchCx, swatchCy, swatchRadius + 3, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
    ctx.fill();
    ctx.restore();

    // Main circle fill
    ctx.save();
    ctx.beginPath();
    ctx.arc(swatchCx, swatchCy, swatchRadius, 0, Math.PI * 2);
    ctx.fillStyle = hex;
    ctx.fill();

    // Circle subtle inner/outer ring for contrast
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();

    // Role Name (bottom)
    ctx.fillStyle = '#F2F3F5';
    ctx.font = `bold 12px ${boldFontStack}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';

    const truncatedName = truncateText(ctx, roleName, cardW - 16);
    ctx.fillText(truncatedName, x + cardW / 2, y + cardH - 12);
  }

  return canvas.toBuffer('image/png');
}
