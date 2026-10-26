import { createCanvas } from '@napi-rs/canvas';
import {
  boldFontStack,
  roundRect,
  normalizeHex,
  toHexColor,
  getLuminance,
  getContrastTextColor
} from './shared.js';

/**
 * Generate a transparent PNG grid with 5x4 colored squares and numbers inside.
 * Supports Solid, Gradient, and Holographic role color styles.
 * Super-sampled at 2x Retina resolution for razor-sharp visual clarity.
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

  const scale = 2; // 2x Retina super-sampling
  const canvas = createCanvas(canvasW * scale, canvasH * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

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
    ctx.font = `bold 36px ${boldFontStack}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = textColor === '#000000' ? 'rgba(255, 255, 255, 0.5)' : 'rgba(0, 0, 0, 0.6)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 1;
    ctx.fillText(labelNum, x + squareSize / 2, y + squareSize / 2);
    ctx.restore();
  }

  return await canvas.encode('png');
}
