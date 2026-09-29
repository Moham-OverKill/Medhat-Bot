import { createCanvas, loadImage } from '@napi-rs/canvas';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { sysError } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TILES_DIR = path.resolve(__dirname, '../../assets/tiles');

export const SHORTCUT_REGISTRY = {
  level: {
    id: 'level',
    name: 'Level',
    description: 'Check level, XP, and rank progress',
    emoji: '⭐',
    buttonCustomId: 'hub_btn_level',
    tileFile: 'level.png'
  },
  quests: {
    id: 'quests',
    name: 'Quests',
    description: 'View active quests and claim rewards',
    emoji: '🎯',
    buttonCustomId: 'hub_btn_quests',
    tileFile: 'quests.png'
  },
  daily: {
    id: 'daily',
    name: 'Claim Daily',
    description: 'Claim daily coins and streak bonuses',
    emoji: '💰',
    buttonCustomId: 'hub_btn_daily',
    tileFile: 'daily.png'
  },
  inventory: {
    id: 'inventory',
    name: 'Inventory',
    description: 'Manage items and equipped roles',
    emoji: '🎒',
    buttonCustomId: 'hub_btn_inventory',
    tileFile: 'inventory.png'
  },
  vote: {
    id: 'vote',
    name: 'Vote',
    description: 'Vote for the server and get rewards',
    emoji: '🗳️',
    buttonCustomId: 'hub_btn_vote',
    tileFile: 'vote.png'
  },
  notifications: {
    id: 'notifications',
    name: 'Notifications',
    description: 'Toggle DM notification preferences',
    emoji: '🔔',
    buttonCustomId: 'hub_btn_notifications',
    tileFile: 'notifications.png'
  },
  bank: {
    id: 'bank',
    name: 'Bank',
    description: 'Open the bank and wallet manager',
    emoji: '🏦',
    buttonCustomId: 'hub_btn_bank',
    tileFile: 'bank.png'
  },
  items: {
    id: 'items',
    name: 'Shop Items',
    description: 'Browse items available in the shop',
    emoji: '🛒',
    buttonCustomId: 'hub_btn_items',
    tileFile: 'items.png'
  },
  profile: {
    id: 'profile',
    name: 'Profile',
    description: 'View your arcane profile card',
    emoji: '👤',
    buttonCustomId: 'hub_btn_profile',
    tileFile: 'profile.png'
  }
};

export const DEFAULT_SHORTCUT_ORDER = [
  'level',
  'quests',
  'daily',
  'inventory',
  'vote',
  'notifications',
  'bank',
  'items'
];

export const GRID_CONFIG = {
  cols: 4,
  cardW: 408,
  cardH: 338,
  marginX: 30,
  marginY: 25,
  gapX: 36,
  gapY: 35,
  canvasW: 1800
};

export function getShortcutMeta(id) {
  if (id && SHORTCUT_REGISTRY[id]) {
    return SHORTCUT_REGISTRY[id];
  }
  return null;
}

export function normalizeShortcutOrder(order) {
  if (!Array.isArray(order) || order.length === 0) {
    return [...DEFAULT_SHORTCUT_ORDER];
  }

  const result = [];
  const maxSlots = Math.min(order.length, 12);
  for (let i = 0; i < maxSlots; i++) {
    const rawId = order[i];
    if (rawId && SHORTCUT_REGISTRY[rawId]) {
      result.push(rawId);
    } else {
      result.push(DEFAULT_SHORTCUT_ORDER[i % DEFAULT_SHORTCUT_ORDER.length] || 'level');
    }
  }

  if (result.length === 0) {
    return [...DEFAULT_SHORTCUT_ORDER];
  }

  return result;
}

const tileImageCache = new Map();

async function loadTileImage(tilePath) {
  if (tileImageCache.has(tilePath)) {
    return tileImageCache.get(tilePath);
  }

  if (fs.existsSync(tilePath)) {
    const img = await loadImage(tilePath);
    tileImageCache.set(tilePath, img);
    return img;
  }

  return null;
}

function drawFallbackTile(ctx, slot, shortcutMeta) {
  const { x, y, w, h } = slot;
  const radius = 26;

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  ctx.clip();

  // Background
  const bgGrad = ctx.createLinearGradient(x, y, x, y + h);
  bgGrad.addColorStop(0, '#1a1d29');
  bgGrad.addColorStop(1, '#0e1017');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(x, y, w, h);

  // Border
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#363c52';
  ctx.stroke();

  // Icon
  ctx.font = '54px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(shortcutMeta?.emoji || '⭐', x + w / 2, y + h * 0.4);

  // Label Box
  const boxH = 58;
  const boxY = y + h - boxH - 24;
  ctx.fillStyle = '#151722';
  ctx.roundRect(x + 24, boxY, w - 48, boxH, 14);
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#5865f2';
  ctx.stroke();

  ctx.font = 'bold 22px sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.fillText((shortcutMeta?.name || 'SHORTCUT').toUpperCase(), x + w / 2, boxY + boxH / 2);

  ctx.restore();
}

/**
 * Generates a dynamic composite PNG image buffer of the interface banner
 * 4 slots per row, supporting up to 12 slots across 1 to 3 rows
 * @param {string[]} [shortcutOrder] 
 * @returns {Promise<Buffer>}
 */
export async function generateInterfaceBanner(shortcutOrder) {
  const normalized = normalizeShortcutOrder(shortcutOrder);
  const totalSlots = normalized.length;
  const { cols, cardW, cardH, marginX, marginY, gapX, gapY, canvasW } = GRID_CONFIG;
  const rows = Math.max(1, Math.ceil(totalSlots / cols));
  const canvasH = marginY * 2 + rows * cardH + (rows - 1) * gapY;

  const canvas = createCanvas(canvasW, canvasH);
  const ctx = canvas.getContext('2d');

  for (let i = 0; i < totalSlots; i++) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const x = marginX + col * (cardW + gapX);
    const y = marginY + row * (cardH + gapY);

    const slot = { x, y, w: cardW, h: cardH };
    const shortcutId = normalized[i];
    const meta = SHORTCUT_REGISTRY[shortcutId] || SHORTCUT_REGISTRY[DEFAULT_SHORTCUT_ORDER[i % DEFAULT_SHORTCUT_ORDER.length]];

    let drawn = false;
    if (meta?.tileFile) {
      const tilePath = path.join(TILES_DIR, meta.tileFile);
      try {
        const img = await loadTileImage(tilePath);
        if (img) {
          ctx.drawImage(img, x, y, cardW, cardH);
          drawn = true;
        }
      } catch (err) {
        sysError('Failed to load tile image', err, { tilePath, shortcutId });
      }
    }

    if (!drawn) {
      drawFallbackTile(ctx, slot, meta);
    }
  }

  return canvas.toBuffer('image/png');
}
