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
 * Determine contrast text color (white or black) based on color luminance
 */
function getContrastTextColor(hex) {
  const cleaned = normalizeHex(hex);
  const r = parseInt(cleaned.slice(1, 3), 16) || 0;
  const g = parseInt(cleaned.slice(3, 5), 16) || 0;
  const b = parseInt(cleaned.slice(5, 7), 16) || 0;
  const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
  return yiq >= 140 ? '#000000' : '#FFFFFF';
}

/**
 * Generate a transparent PNG grid with 5x4 colored squares and numbers inside.
 * No headers, titles, hex codes, or external containers.
 * 
 * @param {Array<{ roleId: string, name?: string, hexColor?: string, index: number }>} panelColors
 * @returns {Promise<Buffer>}
 */
export async function generateColorPanelImage(panelColors = []) {
  const count = panelColors.length;
  const cols = 5;
  const rows = Math.max(1, Math.ceil(count / cols));

  const squareSize = 100;
  const gap = 12;
  const padding = 8;
  const radius = 16;

  const canvasW = padding * 2 + cols * squareSize + (cols - 1) * gap;
  const canvasH = padding * 2 + rows * squareSize + (rows - 1) * gap;

  const canvas = createCanvas(canvasW, canvasH);
  const ctx = canvas.getContext('2d');

  // Background is transparent - no fills or containers

  for (let i = 0; i < count; i++) {
    const item = panelColors[i];
    const col = i % cols;
    const row = Math.floor(i / cols);

    const x = padding + col * (squareSize + gap);
    const y = padding + row * (squareSize + gap);

    const hex = normalizeHex(item.hexColor);
    const labelNum = String(item.index || (i + 1)).padStart(2, '0');

    // 1. Draw colored square
    ctx.fillStyle = hex;
    roundRect(ctx, x, y, squareSize, squareSize, radius);
    ctx.fill();

    // 2. Subtle contour border for contrast against dark/light themes
    const textColor = getContrastTextColor(hex);
    ctx.strokeStyle = textColor === '#000000' ? 'rgba(0, 0, 0, 0.25)' : 'rgba(255, 255, 255, 0.25)';
    ctx.lineWidth = 1.5;
    roundRect(ctx, x, y, squareSize, squareSize, radius);
    ctx.stroke();

    // 3. Draw number centered inside the square
    ctx.fillStyle = textColor;
    ctx.font = `bold 36px ${fontStack}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(labelNum, x + squareSize / 2, y + squareSize / 2);
  }

  return canvas.toBuffer('image/png');
}
