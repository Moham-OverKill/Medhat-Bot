import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fontsDir = path.resolve(__dirname, '../assets/fonts');

// Register bundled fonts for consistent typography
try {
  const boldPath = path.join(fontsDir, 'Roboto-Bold.ttf');
  const regularPath = path.join(fontsDir, 'Roboto-Regular.ttf');
  if (fs.existsSync(boldPath)) GlobalFonts.registerFromPath(boldPath, 'Roboto-Bold');
  if (fs.existsSync(regularPath)) GlobalFonts.registerFromPath(regularPath, 'Roboto');
} catch {
  // Ignore duplicate registration errors
}

const fontStack = '"Roboto-Bold", "Roboto", "Segoe UI", Arial, sans-serif';

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
 * Check if a hex color is valid
 */
function normalizeHex(hex) {
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
 */
function toHexColor(val) {
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
 */
function getLuminance(hex) {
  const cleaned = normalizeHex(hex);
  const r = parseInt(cleaned.slice(1, 3), 16) || 0;
  const g = parseInt(cleaned.slice(3, 5), 16) || 0;
  const b = parseInt(cleaned.slice(5, 7), 16) || 0;
  return ((r * 299) + (g * 587) + (b * 114)) / 1000;
}

/**
 * Determine contrast text color (white or black) based on color luminance
 */
function getContrastTextColor(hexOrLum) {
  const lum = typeof hexOrLum === 'number' ? hexOrLum : getLuminance(hexOrLum);
  return lum >= 140 ? '#000000' : '#FFFFFF';
}

/**
 * Generate a transparent PNG grid with 5x4 colored squares and numbers inside.
 * Supports Solid, Gradient, and Holographic role color styles.
 * No headers, titles, hex codes, or external containers.
 * 
 * @param {Array<{ roleId: string, name?: string, hexColor?: string, colors?: object, index: number }>} panelColors
 * @returns {Promise<Buffer>}
 */
export async function generateColorPanelImage(panelColors = []) {
  const count = panelColors.length;
  const cols = 5;
  const rows = Math.max(1, Math.ceil(count / cols));

  const squareSize = 100;
  const gap = 12;
  const framePadding = 16;
  const outerMargin = 8;
  const squareRadius = 14;
  const frameRadius = 22;

  const gridW = cols * squareSize + (cols - 1) * gap;
  const gridH = rows * squareSize + (rows - 1) * gap;

  const frameW = gridW + framePadding * 2;
  const frameH = gridH + framePadding * 2;

  const canvasW = frameW + outerMargin * 2;
  const canvasH = frameH + outerMargin * 2;

  const canvas = createCanvas(canvasW, canvasH);
  const ctx = canvas.getContext('2d');

  const frameX = outerMargin;
  const frameY = outerMargin;

  // 1. Draw Frame Background (Sleek dark Discord card surface)
  ctx.fillStyle = '#1E1F22';
  roundRect(ctx, frameX, frameY, frameW, frameH, frameRadius);
  ctx.fill();

  // 2. Draw Frame Outer Stroke
  ctx.strokeStyle = '#2B2D31';
  ctx.lineWidth = 2;
  roundRect(ctx, frameX, frameY, frameW, frameH, frameRadius);
  ctx.stroke();

  // 3. Subtle Frame Inner Highlight
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.lineWidth = 1;
  roundRect(ctx, frameX + 1, frameY + 1, frameW - 2, frameH - 2, frameRadius - 1);
  ctx.stroke();

  for (let i = 0; i < count; i++) {
    const item = panelColors[i];
    const col = i % cols;
    const row = Math.floor(i / cols);

    const x = frameX + framePadding + col * (squareSize + gap);
    const y = frameY + framePadding + row * (squareSize + gap);

    const baseHex = normalizeHex(item.hexColor || item.role?.hexColor);
    const labelNum = String(item.index || (i + 1)).padStart(2, '0');
    const roleColors = item.colors || item.role?.colors;

    let fillStyle = baseHex;
    let avgLum = getLuminance(baseHex);

    if (roleColors?.tertiaryColor != null) {
      // Holographic Style (3 stops, pastel iridescent)
      const c1 = toHexColor(roleColors.primaryColor) || '#A9CBFF';
      const c2 = toHexColor(roleColors.secondaryColor) || '#FFBBEE';
      const c3 = toHexColor(roleColors.tertiaryColor) || '#FFC3A0';

      const grad = ctx.createLinearGradient(x, y, x + squareSize, y + squareSize);
      grad.addColorStop(0, c1);
      grad.addColorStop(0.5, c2);
      grad.addColorStop(1, c3);

      fillStyle = grad;
      avgLum = (getLuminance(c1) + getLuminance(c2) + getLuminance(c3)) / 3;
    } else if (roleColors?.secondaryColor != null && roleColors.secondaryColor !== roleColors.primaryColor) {
      // Gradient Style (2 stops, horizontal linear gradient)
      const c1 = toHexColor(roleColors.primaryColor) || baseHex;
      const c2 = toHexColor(roleColors.secondaryColor) || '#000000';

      const grad = ctx.createLinearGradient(x, y, x + squareSize, y);
      grad.addColorStop(0, c1);
      grad.addColorStop(1, c2);

      fillStyle = grad;
      avgLum = (getLuminance(c1) + getLuminance(c2)) / 2;
    }

    // 1. Draw colored square
    ctx.fillStyle = fillStyle;
    roundRect(ctx, x, y, squareSize, squareSize, squareRadius);
    ctx.fill();

    // 2. Subtle contour border for contrast against dark/light themes
    const textColor = getContrastTextColor(avgLum);
    ctx.strokeStyle = textColor === '#000000' ? 'rgba(0, 0, 0, 0.25)' : 'rgba(255, 255, 255, 0.25)';
    ctx.lineWidth = 1.5;
    roundRect(ctx, x, y, squareSize, squareSize, squareRadius);
    ctx.stroke();

    // 3. Draw number centered inside the square with subtle drop shadow for crisp readability
    ctx.save();
    ctx.fillStyle = textColor;
    ctx.font = `bold 36px ${fontStack}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = textColor === '#000000' ? 'rgba(255, 255, 255, 0.5)' : 'rgba(0, 0, 0, 0.6)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 1;
    ctx.fillText(labelNum, x + squareSize / 2, y + squareSize / 2);
    ctx.restore();
  }

  return canvas.toBuffer('image/png');
}
