import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  StringSelectMenuBuilder,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  AttachmentBuilder
} from 'discord.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import { getGuildConfig, setGuildConfig } from '../storage/config.js';
import { getPool } from '../storage/postgres.js';
import { getNextQuestRefresh, getNextCairoMidnight } from '../utils/time.js';
import { formatCompactQuest } from '../quests/quests.js';
import { claimDaily } from '../economy/service.js';
import { getLevelViewPayload } from './pass.js';
import { buildNotificationsPayload } from './notifications.js';
import { getUserNotificationSettings } from '../storage/notifications.js';
import { handleInventoryButton } from './bank.js';
import { isMemberBooster } from './colors.js';
import { COIN_EMOJI, getUserDisplayName, getUserLogName } from '../shared.js';
import { sendLog, sysLog, sysError, checkChannelPermissions } from '../utils/logger.js';
import { handleInteractionError } from '../utils/errors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TILES_DIR = path.resolve(__dirname, '../../assets/tiles');
export const LOCAL_BANNER_PATH = path.join(__dirname, '../../assets/interface.png');
export const INTERFACE_BANNER_IMAGE = 'https://media.discordapp.net/attachments/1537838869570002994/1538293185070235668/RGWP2LQ.png?ex=6a8226ab&is=6a80d52b&hm=b96ca59f431d7c3a08a1981505efb337516294c4485beb56fe8e783c39e02a5e&animated=true';

// Register bundled fonts for consistent high-res rendering
try {
  const localEmojiFont = path.resolve(__dirname, '../assets/fonts/seguiemj.ttf');
  const winEmojiFont = 'C:/Windows/Fonts/seguiemj.ttf';
  if (fs.existsSync(localEmojiFont)) {
    GlobalFonts.registerFromPath(localEmojiFont, 'Segoe UI Emoji');
  } else if (fs.existsSync(winEmojiFont)) {
    GlobalFonts.registerFromPath(winEmojiFont, 'Segoe UI Emoji');
  }

  const localRobotoBold = path.resolve(__dirname, '../assets/fonts/Roboto-Bold.ttf');
  if (fs.existsSync(localRobotoBold)) {
    GlobalFonts.registerFromPath(localRobotoBold, 'Roboto-Bold');
  }
} catch (fontErr) {
  sysError('Failed to register fonts', fontErr);
}

export const SHORTCUT_REGISTRY = {
  level: {
    id: 'level',
    name: 'Level',
    label: 'LEVEL',
    description: 'Check level, XP, and rank progress',
    emoji: '⭐',
    buttonCustomId: 'hub_btn_level',
    tileFile: 'level.png'
  },
  quests: {
    id: 'quests',
    name: 'Quests',
    label: 'QUESTS',
    description: 'View active quests and claim rewards',
    emoji: '🎯',
    buttonCustomId: 'hub_btn_quests',
    tileFile: 'quests.png'
  },
  daily: {
    id: 'daily',
    name: 'Claim Daily',
    label: 'CLAIM DAILY',
    description: 'Claim daily coins and streak bonuses',
    emoji: '💰',
    buttonCustomId: 'hub_btn_daily',
    tileFile: 'daily.png'
  },
  inventory: {
    id: 'inventory',
    name: 'Inventory',
    label: 'INVENTORY',
    description: 'Manage items and equipped roles',
    emoji: '🎒',
    buttonCustomId: 'hub_btn_inventory',
    tileFile: 'inventory.png'
  },
  vote: {
    id: 'vote',
    name: 'Vote',
    label: 'VOTE',
    description: 'Vote for the server and get rewards',
    emoji: '🗳️',
    buttonCustomId: 'hub_btn_vote',
    tileFile: 'vote.png'
  },
  notifications: {
    id: 'notifications',
    name: 'Notifications',
    label: 'NOTIFICATIONS',
    description: 'Toggle DM notification preferences',
    emoji: '🔔',
    buttonCustomId: 'hub_btn_notifications',
    tileFile: 'notifications.png'
  },
  bank: {
    id: 'bank',
    name: 'Bank',
    label: 'BANK',
    description: 'Open the bank and wallet manager',
    emoji: '🏦',
    buttonCustomId: 'hub_btn_bank',
    tileFile: 'bank.png'
  },
  items: {
    id: 'items',
    name: 'Items',
    label: 'ITEMS',
    description: 'Browse available items and catalog',
    emoji: '🛒',
    buttonCustomId: 'hub_btn_items',
    tileFile: 'items.png'
  },
  profile: {
    id: 'profile',
    name: 'Profile',
    label: 'PROFILE',
    description: 'View your arcane profile card',
    emoji: '👤',
    buttonCustomId: 'hub_btn_profile',
    tileFile: 'profile.png'
  },
  invite: {
    id: 'invite',
    name: 'Invite',
    label: 'INVITE',
    description: 'Get the bot invite link and support info',
    emoji: '🔗',
    buttonCustomId: 'hub_btn_invite',
    tileFile: 'invite.png'
  }
};

export const DEFAULT_SHORTCUT_ORDER = [
  'level',
  'quests',
  'daily',
  'empty',
  'inventory',
  'vote',
  'notifications',
  'empty',
  'empty',
  'empty',
  'empty',
  'empty'
];

export function getShortcutMeta(id) {
  if (id && SHORTCUT_REGISTRY[id]) {
    return SHORTCUT_REGISTRY[id];
  }
  return null;
}

export function normalizeShortcutOrder(order) {
  const result = new Array(12).fill('empty');
  if (Array.isArray(order) && order.length > 0) {
    if (order.length === 6 && order[0] === 'level' && order[3] === 'inventory') {
      result[0] = order[0] || 'level';
      result[1] = order[1] || 'quests';
      result[2] = order[2] || 'daily';
      result[3] = 'empty';
      result[4] = order[3] || 'inventory';
      result[5] = order[4] || 'vote';
      result[6] = order[5] || 'notifications';
      result[7] = 'empty';
    } else {
      for (let i = 0; i < Math.min(order.length, 12); i++) {
        const id = order[i];
        if (id && SHORTCUT_REGISTRY[id]) {
          result[i] = id;
        } else {
          result[i] = 'empty';
        }
      }
    }
  } else {
    for (let i = 0; i < 12; i++) {
      result[i] = DEFAULT_SHORTCUT_ORDER[i];
    }
  }
  return result;
}

export const INTERFACE_CARD_COLORS = [
  { id: 'black', hex: '#000000', name: 'Black (Default)', emoji: '🖤', description: 'Classic black card background' },
  { id: 'red', hex: '#e02443', name: 'Red', emoji: '❤️', description: 'Red card background' },
  { id: 'orange', hex: '#f4900c', name: 'Orange', emoji: '🧡', description: 'Orange card background' },
  { id: 'yellow', hex: '#e5a700', name: 'Yellow', emoji: '💛', description: 'Yellow card background' },
  { id: 'green', hex: '#43b581', name: 'Green', emoji: '💚', description: 'Green card background' },
  { id: 'lightblue', hex: '#29b6f6', name: 'Light Blue', emoji: '🩵', description: 'Light blue card background' },
  { id: 'blue', hex: '#2374e1', name: 'Blue', emoji: '💙', description: 'Blue card background' },
  { id: 'purple', hex: '#8a4bf6', name: 'Purple', emoji: '💜', description: 'Purple card background' },
  { id: 'pink', hex: '#eb459e', name: 'Pink', emoji: '🩷', description: 'Pink card background' },
  { id: 'brown', hex: '#8c564b', name: 'Brown', emoji: '🤎', description: 'Brown card background' },
  { id: 'grey', hex: '#636e72', name: 'Grey', emoji: '🩶', description: 'Grey card background' },
  { id: 'white', hex: '#f1f2f6', name: 'White', emoji: '🤍', description: 'White card background' }
];

export function getCardColorMeta(hexOrId) {
  if (!hexOrId || hexOrId === '#000000' || hexOrId === 'black') return INTERFACE_CARD_COLORS[0];
  const target = String(hexOrId).toLowerCase();
  const found = INTERFACE_CARD_COLORS.find(c => c.hex.toLowerCase() === target || c.id.toLowerCase() === target);
  if (found) return found;

  // Graceful fallback for legacy colors
  if (target.includes('blue') || target === '#5865f2' || target === '#1d4ed8' || target === '#0891b2') {
    return INTERFACE_CARD_COLORS.find(c => c.id === 'blue');
  }
  if (target.includes('red') || target === '#b91c1c' || target === '#881337') {
    return INTERFACE_CARD_COLORS.find(c => c.id === 'red');
  }
  if (target.includes('green') || target === '#15803d' || target === '#14532d') {
    return INTERFACE_CARD_COLORS.find(c => c.id === 'green');
  }
  if (target.includes('purple') || target === '#7e22ce' || target === '#4338ca') {
    return INTERFACE_CARD_COLORS.find(c => c.id === 'purple');
  }
  if (target.includes('orange') || target === '#c2410c') {
    return INTERFACE_CARD_COLORS.find(c => c.id === 'orange');
  }
  if (target.includes('gold') || target === '#b45309') {
    return INTERFACE_CARD_COLORS.find(c => c.id === 'yellow');
  }
  if (target.includes('pink') || target === '#be185d') {
    return INTERFACE_CARD_COLORS.find(c => c.id === 'pink');
  }
  if (target.includes('brown') || target === '#78350f') {
    return INTERFACE_CARD_COLORS.find(c => c.id === 'brown');
  }
  if (target.includes('slate') || target === '#1e293b') {
    return INTERFACE_CARD_COLORS.find(c => c.id === 'grey');
  }

  return {
    id: 'custom',
    hex: hexOrId,
    name: hexOrId.toUpperCase(),
    emoji: '🤍',
    description: 'Custom card background color'
  };
}

function getContrastColor(hex) {
  if (!hex || hex === '#000000') return '#ffffff';
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16) || 0;
  const g = parseInt(clean.substring(2, 4), 16) || 0;
  const b = parseInt(clean.substring(4, 6), 16) || 0;
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 180 ? '#111214' : '#ffffff';
}

export function normalizeSlotColors(raw) {
  const result = new Array(12).fill('#000000');
  if (Array.isArray(raw)) {
    for (let i = 0; i < Math.min(raw.length, 12); i++) {
      if (typeof raw[i] === 'string' && raw[i].startsWith('#')) {
        result[i] = raw[i];
      }
    }
  } else if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      const idx = parseInt(k, 10);
      if (!isNaN(idx) && idx >= 0 && idx < 12 && typeof v === 'string' && v.startsWith('#')) {
        result[idx] = v;
      }
    }
  }
  return result;
}

/**
 * Draw an emoji glyph with a solid black silhouette outline/stroke
 * @param {import('@napi-rs/canvas').SKRSContext2D} targetCtx 
 * @param {string} emoji 
 * @param {number} cx 
 * @param {number} cy 
 * @param {number} fontSize 
 * @param {number} strokeWidth 
 */
function drawEmojiWithStroke(targetCtx, emoji, cx, cy, fontSize, strokeWidth = 5) {
  if (!strokeWidth || strokeWidth <= 0) {
    targetCtx.font = `${fontSize}px "Segoe UI Emoji", sans-serif`;
    targetCtx.textAlign = 'center';
    targetCtx.textBaseline = 'middle';
    targetCtx.fillText(emoji, cx, cy);
    return;
  }

  const pad = strokeWidth * 2 + 10;
  const tempW = Math.ceil(fontSize + pad * 2);
  const tempH = Math.ceil(fontSize + pad * 2);

  const colorCanvas = createCanvas(tempW, tempH);
  const colorCtx = colorCanvas.getContext('2d');
  colorCtx.font = `${fontSize}px "Segoe UI Emoji", sans-serif`;
  colorCtx.textAlign = 'center';
  colorCtx.textBaseline = 'middle';
  colorCtx.fillText(emoji, tempW / 2, tempH / 2);

  const silCanvas = createCanvas(tempW, tempH);
  const silCtx = silCanvas.getContext('2d');
  silCtx.drawImage(colorCanvas, 0, 0);
  silCtx.globalCompositeOperation = 'source-in';
  silCtx.fillStyle = '#000000';
  silCtx.fillRect(0, 0, tempW, tempH);

  targetCtx.save();
  const steps = 16;
  for (let i = 0; i < steps; i++) {
    const angle = (i * 2 * Math.PI) / steps;
    const ox = Math.round(Math.cos(angle) * strokeWidth);
    const oy = Math.round(Math.sin(angle) * strokeWidth);
    targetCtx.drawImage(silCanvas, cx - tempW / 2 + ox, cy - tempH / 2 + oy);
  }
  targetCtx.drawImage(silCanvas, cx - tempW / 2, cy - tempH / 2);
  targetCtx.drawImage(colorCanvas, cx - tempW / 2, cy - tempH / 2);
  targetCtx.restore();
}

/**
 * Render an individual shortcut card tile
 * Features a solid colored card base, crisp border, prominent centered emoji with black outline, and bold bottom label with black outline.
 * @param {import('@napi-rs/canvas').SKRSContext2D} ctx 
 * @param {number} x 
 * @param {number} y 
 * @param {number} cardW 
 * @param {number} cardH 
 * @param {object} meta 
 * @param {string} [bgColor]
 */
function drawShortcutCard(ctx, x, y, cardW, cardH, meta, bgColor = '#000000') {
  const radius = Math.round(cardH * 0.08);
  const borderWidth = Math.max(3, Math.round(cardH * 0.014));
  const strokeColor = '#ffffff';

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, cardW, cardH, radius);
  ctx.fillStyle = bgColor || '#000000';
  ctx.fill();
  ctx.lineWidth = borderWidth;
  ctx.strokeStyle = strokeColor;
  ctx.stroke();
  ctx.clip();

  // 1. Emoji — prominent in center (60% of card height, positioned at 44%) with crisp black outline
  const emojiSize = Math.round(cardH * 0.60);
  const emojiStrokeWidth = Math.max(3, Math.round(cardH * 0.012));
  drawEmojiWithStroke(ctx, meta.emoji || '⭐', x + cardW / 2, y + cardH * 0.44, emojiSize, emojiStrokeWidth);

  // 2. Label Text — bold, uppercase, positioned at 83% with solid black outline
  let labelFontSize = Math.round(cardH * 0.135);
  const label = (meta.label || meta.name || 'SHORTCUT').toUpperCase();
  ctx.font = `bold ${labelFontSize}px "Roboto-Bold", "Arial Black", "Segoe UI", sans-serif`;
  const maxWidth = cardW - 32;
  while (ctx.measureText(label).width > maxWidth && labelFontSize > 18) {
    labelFontSize -= 2;
    ctx.font = `bold ${labelFontSize}px "Roboto-Bold", "Arial Black", "Segoe UI", sans-serif`;
  }

  const textStrokeWidth = Math.max(4, Math.round(labelFontSize * 0.12));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Black outline/stroke
  ctx.lineWidth = textStrokeWidth;
  ctx.strokeStyle = '#000000';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.strokeText(label, x + cardW / 2, y + cardH * 0.83);

  // White text fill
  ctx.fillStyle = '#ffffff';
  ctx.fillText(label, x + cardW / 2, y + cardH * 0.83);

  ctx.restore();
}

/**
 * Generate composite interface banner image buffer
 * Dynamically resizes canvas and scales buttons based on active shortcuts and their row locations.
 * Completely eliminates empty spaces, blank top/bottom margins, and dead column padding.
 * @param {string[]} shortcutOrder 
 * @param {{ showEmptySlots?: boolean, slotColors?: string[] }} [options] 
 * @returns {Promise<Buffer>}
 */
export async function generateInterfaceBanner(shortcutOrder, options = {}) {
  const normalized = normalizeShortcutOrder(shortcutOrder);
  const slotColors = normalizeSlotColors(
    Array.isArray(options) ? options : (options?.slotColors || options?.slot_colors || [])
  );

  // Group slots into 3 configured rows of 4 slots each with their original slot index (0-11)
  const configuredRows = [
    [0, 1, 2, 3].map(i => ({ id: normalized[i], slotIndex: i })),
    [4, 5, 6, 7].map(i => ({ id: normalized[i], slotIndex: i })),
    [8, 9, 10, 11].map(i => ({ id: normalized[i], slotIndex: i }))
  ];

  // For each row, extract active (non-empty) shortcuts
  const activeRows = [];
  for (const row of configuredRows) {
    const activeInRow = row.filter(item => item.id && item.id !== 'empty' && SHORTCUT_REGISTRY[item.id]);
    if (activeInRow.length > 0) {
      activeRows.push(activeInRow);
    }
  }

  // Fallback to default 2 rows of 3 buttons if nothing is configured
  if (activeRows.length === 0) {
    activeRows.push(
      [{ id: 'level', slotIndex: 0 }, { id: 'quests', slotIndex: 1 }, { id: 'daily', slotIndex: 2 }],
      [{ id: 'inventory', slotIndex: 4 }, { id: 'vote', slotIndex: 5 }, { id: 'notifications', slotIndex: 6 }]
    );
  }

  // Determine maximum columns across active rows (at least 1, max 4)
  const maxCols = Math.min(4, Math.max(...activeRows.map(r => r.length)));
  const rowCount = activeRows.length;

  let cardW, cardH, marginX, marginY, gapX, gapY;

  if (maxCols >= 4) {
    cardW = 390;
    cardH = 327;
    marginX = 30;
    marginY = 25;
    gapX = 36;
    gapY = 35;
  } else {
    cardW = 524;
    cardH = 440;
    marginX = 40;
    marginY = 20;
    gapX = 48;
    gapY = 33;
  }

  const canvasW = maxCols * cardW + (maxCols - 1) * gapX + 2 * marginX;
  const canvasH = rowCount * cardH + (rowCount - 1) * gapY + 2 * marginY;

  const canvas = createCanvas(canvasW, canvasH);
  const ctx = canvas.getContext('2d');

  for (let r = 0; r < rowCount; r++) {
    const rowItems = activeRows[r];
    const k = rowItems.length;
    const rowW = k * cardW + (k - 1) * gapX;
    const rowMarginX = (canvasW - rowW) / 2;
    const y = marginY + r * (cardH + gapY);

    for (let c = 0; c < k; c++) {
      const item = rowItems[c];
      const x = rowMarginX + c * (cardW + gapX);
      const meta = SHORTCUT_REGISTRY[item.id];
      const bgColor = slotColors[item.slotIndex] || '#000000';
      if (meta) {
        drawShortcutCard(ctx, x, y, cardW, cardH, meta, bgColor);
      }
    }
  }

  return canvas.toBuffer('image/png');
}

/**
 * Fetch interface configuration for a server from PostgreSQL
 * @param {string} guildId 
 * @returns {Promise<{ guild_id: string, is_enabled: boolean, shortcut_order: string[], target_channel_id: string|null, message_id: string|null }>}
 */
export async function getInterfaceConfig(guildId) {
  try {
    const pool = getPool();
    const res = await pool.query(
      `SELECT guild_id, is_enabled, shortcut_order, slot_colors, target_channel_id, message_id 
       FROM server_interface_config 
       WHERE guild_id = $1`,
      [guildId]
    ).catch(async (queryErr) => {
      if (queryErr.code === '42703' || String(queryErr.message).includes('slot_colors')) {
        await pool.query(`ALTER TABLE server_interface_config ADD COLUMN IF NOT EXISTS slot_colors JSONB NOT NULL DEFAULT '[]'::jsonb`).catch(() => {});
        return pool.query(
          `SELECT guild_id, is_enabled, shortcut_order, slot_colors, target_channel_id, message_id 
           FROM server_interface_config 
           WHERE guild_id = $1`,
          [guildId]
        );
      }
      throw queryErr;
    });

    if (res.rows.length > 0) {
      const row = res.rows[0];
      return {
        guild_id: row.guild_id,
        is_enabled: Boolean(row.is_enabled),
        shortcut_order: normalizeShortcutOrder(row.shortcut_order),
        slot_colors: normalizeSlotColors(row.slot_colors),
        target_channel_id: row.target_channel_id || null,
        message_id: row.message_id || null
      };
    }

    // Fallback: check legacy guild_configs
    const guildConfig = await getGuildConfig(guildId) || {};
    const fallbackChannel = guildConfig.interface_channel_id || null;
    const fallbackMessage = guildConfig.interface_message_id || null;

    return {
      guild_id: guildId,
      is_enabled: true,
      shortcut_order: [...DEFAULT_SHORTCUT_ORDER],
      slot_colors: new Array(12).fill('#000000'),
      target_channel_id: fallbackChannel,
      message_id: fallbackMessage
    };
  } catch (err) {
    sysError('Failed to fetch interface config', err, { guildId });
    return {
      guild_id: guildId,
      is_enabled: true,
      shortcut_order: [...DEFAULT_SHORTCUT_ORDER],
      slot_colors: new Array(12).fill('#000000'),
      target_channel_id: null,
      message_id: null
    };
  }
}

/**
 * Save interface configuration for a server to PostgreSQL
 * @param {string} guildId 
 * @param {Object} data 
 * @returns {Promise<{ guild_id: string, is_enabled: boolean, shortcut_order: string[], slot_colors: string[], target_channel_id: string|null, message_id: string|null }>}
 */
export async function saveInterfaceConfig(guildId, data) {
  try {
    const pool = getPool();
    const normalizedOrder = normalizeShortcutOrder(data.shortcut_order);
    const normalizedColors = normalizeSlotColors(data.slot_colors);
    const isEnabled = data.is_enabled !== undefined ? Boolean(data.is_enabled) : true;
    const channelId = data.target_channel_id !== undefined ? (data.target_channel_id || null) : null;
    const messageId = data.message_id !== undefined ? (data.message_id || null) : null;

    const queryStr = `
      INSERT INTO server_interface_config (guild_id, is_enabled, shortcut_order, slot_colors, target_channel_id, message_id, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (guild_id)
      DO UPDATE SET
        is_enabled = EXCLUDED.is_enabled,
        shortcut_order = EXCLUDED.shortcut_order,
        slot_colors = EXCLUDED.slot_colors,
        target_channel_id = EXCLUDED.target_channel_id,
        message_id = EXCLUDED.message_id,
        updated_at = NOW()
      RETURNING guild_id, is_enabled, shortcut_order, slot_colors, target_channel_id, message_id
    `;
    const params = [guildId, isEnabled, JSON.stringify(normalizedOrder), JSON.stringify(normalizedColors), channelId, messageId];

    let res;
    try {
      res = await pool.query(queryStr, params);
    } catch (saveErr) {
      if (saveErr.code === '42703' || String(saveErr.message).includes('slot_colors')) {
        await pool.query(`ALTER TABLE server_interface_config ADD COLUMN IF NOT EXISTS slot_colors JSONB NOT NULL DEFAULT '[]'::jsonb`).catch(() => {});
        res = await pool.query(queryStr, params);
      } else {
        throw saveErr;
      }
    }

    // Keep legacy guild_configs synchronized for backwards compatibility
    try {
      const guildConfig = await getGuildConfig(guildId) || {};
      guildConfig.interface_channel_id = channelId;
      guildConfig.interface_message_id = messageId;
      await setGuildConfig(guildId, guildConfig);
    } catch (syncErr) {
      sysError('Failed to sync guildConfig interface channel', syncErr, { guildId });
    }

    const row = res.rows[0];
    return {
      guild_id: row.guild_id,
      is_enabled: Boolean(row.is_enabled),
      shortcut_order: normalizeShortcutOrder(row.shortcut_order),
      slot_colors: normalizeSlotColors(row.slot_colors),
      target_channel_id: row.target_channel_id || null,
      message_id: row.message_id || null
    };
  } catch (err) {
    sysError('Failed to save interface config', err, { guildId });
    throw err;
  }
}

export async function buildHubEmbed(guild, config = null) {
  const guildId = guild.id;
  const guildConfig = config || await getGuildConfig(guildId) || {};
  const coinEmoji = COIN_EMOJI.forGuild(guildId);

  // Active Quests Section
  const questsEnabled = guildConfig.quests_enabled ?? guildConfig.missions_enabled ?? false;
  let activeQuests = Array.isArray(guildConfig.active_quest_snapshot) ? guildConfig.active_quest_snapshot : [];
  let poolQuests = [];

  if (questsEnabled) {
    const { getQuests } = await import('../quests/quests.js');
    poolQuests = await getQuests(guildId);
    const targetCount = Math.min(parseInt(guildConfig.quests_per_refresh, 10) || 3, poolQuests.length);
    if (poolQuests.length > 0 && activeQuests.length < targetCount) {
      const { rotateGuildQuests } = await import('../cron/quests.js');
      const { getPool: getPgPool } = await import('../storage/postgres.js');
      await rotateGuildQuests(guildId, guildConfig, getPgPool(), null, { skipNotifications: true });
      const freshConfig = await getGuildConfig(guildId);
      activeQuests = Array.isArray(freshConfig?.active_quest_snapshot) ? freshConfig.active_quest_snapshot : [];
    }
  }

  const refreshesPerDay = guildConfig.quests_refreshes_per_day || 1;
  const nextQuestDate = getNextQuestRefresh(refreshesPerDay);
  const nextQuestTs = Math.floor(nextQuestDate.getTime() / 1000);
  const nextMidnightDate = getNextCairoMidnight();
  const nextMidnightTs = Math.floor(nextMidnightDate.getTime() / 1000);

  const configuredCount = parseInt(guildConfig.quests_per_refresh, 10) || 3;
  const nextCycleCount = poolQuests.length > 0 ? Math.min(configuredCount, poolQuests.length) : configuredCount;
  const nextQuestLabel = nextCycleCount === 1 ? 'Next Quest' : 'Next Quests';

  let questContent = '';
  if (questsEnabled && activeQuests.length > 0) {
    const questLines = activeQuests.map(q => {
      const taskText = formatCompactQuest(q);
      const reward = parseInt(q.reward_coins, 10) || 0;
      return `• ${taskText}: +**${reward.toLocaleString()}** ${coinEmoji}`;
    });
    questContent = questLines.join('\n') + `\n\n${nextQuestLabel} <t:${nextQuestTs}:R>\nNext Daily <t:${nextMidnightTs}:R>`;
  } else if (questsEnabled) {
    questContent = `_No active quests currently._\n\n${nextQuestLabel} <t:${nextQuestTs}:R>\nNext Daily <t:${nextMidnightTs}:R>`;
  } else {
    questContent = `_Daily quests are currently paused._\n\nNext Daily <t:${nextMidnightTs}:R>`;
  }

  const isSingular = activeQuests.length === 1;
  const questFieldName = isSingular ? 'Current Quest' : 'Current Quests';

  const embed = new EmbedBuilder()
    .setTitle('INTERFACE')
    .setColor(0x000000)
    .setImage('attachment://interface.png')
    .addFields({
      name: questFieldName,
      value: questContent,
      inline: false
    });

  return embed;
}

/**
 * Build the shortcut buttons for the Hub message (matches image rows, all gray)
 * @param {import('discord.js').Client} [client]
 * @param {string[]} [shortcutOrder]
 * @returns {ActionRowBuilder[]}
 */
export function buildHubButtons(client = null, shortcutOrder = null) {
  const order = normalizeShortcutOrder(shortcutOrder);
  const rows = [];
  const configuredRows = [
    order.slice(0, 4),
    order.slice(4, 8),
    order.slice(8, 12)
  ];

  for (const row of configuredRows) {
    const actionRow = new ActionRowBuilder();
    for (const id of row) {
      if (id && id !== 'empty') {
        const meta = SHORTCUT_REGISTRY[id];
        if (meta) {
          actionRow.addComponents(
            new ButtonBuilder()
              .setCustomId(meta.buttonCustomId)
              .setEmoji(meta.emoji)
              .setStyle(ButtonStyle.Secondary)
          );
        }
      }
    }

    if (actionRow.components.length > 0) {
      rows.push(actionRow);
    }
  }

  return rows;
}

// Mutex lock to prevent concurrent duplicate hub message updates
const hubUpdateLocks = new Set();

/**
 * Publish or update the public Hub message in the designated channel
 * Edits existing message in-place to prevent duplicate messages and channel jumps.
 * @param {import('discord.js').Client} client 
 * @param {string} guildId 
 * @param {{ allowCreate?: boolean }} [options]
 * @returns {Promise<boolean>}
 */
export async function publishOrUpdateHub(client, guildId, options = {}) {
  const { allowCreate = false } = options;

  if (hubUpdateLocks.has(guildId)) {
    return false;
  }
  hubUpdateLocks.add(guildId);

  try {
    const interfaceConfig = await getInterfaceConfig(guildId);
    if (!interfaceConfig.is_enabled) {
      return false;
    }

    const channelId = interfaceConfig.target_channel_id;
    if (!channelId) {
      return false;
    }

    // If interface is not published yet and creation is not explicitly requested, do not auto-publish
    if (!interfaceConfig.message_id && !allowCreate) {
      return false;
    }

    const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return false;

    const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      sysLog('Hub Channel Inaccessible', { guild: guildId, channel: channelId });
      return false;
    }

    const bannerBuffer = await generateInterfaceBanner(interfaceConfig.shortcut_order, {
      showEmptySlots: false,
      slotColors: interfaceConfig.slot_colors
    });
    const attachment = new AttachmentBuilder(bannerBuffer, { name: 'interface.png' });

    const guildConfig = await getGuildConfig(guildId) || {};
    const embed = await buildHubEmbed(guild, guildConfig);
    const buttonRows = buildHubButtons(client, interfaceConfig.shortcut_order);
    const payload = {
      embeds: [embed],
      components: buttonRows,
      files: [attachment]
    };

    // 1. If an existing message exists, edit it in-place
    const oldMsgId = interfaceConfig.message_id;
    if (oldMsgId) {
      const oldMessage = await channel.messages.fetch(oldMsgId).catch(() => null);
      if (oldMessage) {
        await oldMessage.edit(payload).catch(() => null);
        sysLog('Hub Message Updated In-Place', { guild: guildId, channel: channelId, messageId: oldMsgId });
        return true;
      }
    }

    // 2. If message doesn't exist and allowCreate is false, do not create
    if (!allowCreate) {
      return false;
    }

    // 3. Clean up any orphaned hub messages from the channel before creating a new one
    try {
      const recentMessages = await channel.messages.fetch({ limit: 25 }).catch(() => null);
      if (recentMessages) {
        for (const msg of recentMessages.values()) {
          if (msg.author.id === client.user.id) {
            const hasHubButtons = msg.components?.some(row =>
              row.components?.some(btn => btn.customId?.startsWith('hub_btn_'))
            );
            if (hasHubButtons) {
              await msg.delete().catch(() => {});
            }
          }
        }
      }
    } catch {
      // Non-blocking cleanup
    }

    // 4. Send new message
    const newMessage = await channel.send(payload).catch((err) => {
      sysError('Hub Message Send Failed', err, { guild: guildId, channel: channelId });
      return null;
    });

    if (newMessage) {
      interfaceConfig.message_id = newMessage.id;
      await saveInterfaceConfig(guildId, interfaceConfig);
      sysLog('Hub Message Freshly Published', { guild: guildId, channel: channelId, messageId: newMessage.id });
      return true;
    }

    return false;
  } catch (error) {
    sysError('Hub Publish/Update Error', error, { guild: guildId });
    return false;
  } finally {
    hubUpdateLocks.delete(guildId);
  }
}

/**
 * Render the Admin Interface Configuration Panel in /settings -> Users -> Interface
 * Clean minimal view without shortcut listing
 * All buttons styled in gray (ButtonStyle.Secondary)
 * Layout:
 * - Row 0: Target Channel Selector
 * - Row 1: [ Enable / Disable ] | [ Update ]
 * - Row 2: [ Back ] | [ Setup ]
 * @param {import('discord.js').ButtonInteraction|import('discord.js').ModalSubmitInteraction|import('discord.js').ChannelSelectMenuInteraction} interaction 
 */
export async function showInterfaceSettings(interaction) {
  const guildId = interaction.guildId;
  const config = await getInterfaceConfig(guildId);

  const currentChannel = config.target_channel_id ? `<#${config.target_channel_id}>` : '*Not Set*';
  const isPublished = Boolean(config.target_channel_id && config.message_id);

  let statusText = '`🔴 Disabled`';
  if (config.is_enabled) {
    if (isPublished) {
      statusText = '`🟢 Published & Active`';
    } else if (config.target_channel_id) {
      statusText = '`🟡 Pending Deployment`';
    } else {
      statusText = '`🟡 Pending Setup (Channel Required)`';
    }
  }

  const desc = [
    'Configure the public Community Interface message with active quests, countdown timers, and quick shortcuts.\n',
    `• **Target Channel:** ${currentChannel}`,
    `• **Status:** ${statusText}`
  ].join('\n');

  const embed = new EmbedBuilder()
    .setTitle('Interface Configuration')
    .setDescription(desc)
    .setColor(0x5865F2);

  // Row 0: Channel Selector
  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId('interface_set_channel')
    .setPlaceholder('Select target channel for the Interface...')
    .setChannelTypes(ChannelType.GuildText);

  if (config.target_channel_id) {
    channelSelect.setDefaultChannels([config.target_channel_id]);
  }

  // Row 1: [ Enable / Disable ] | [ Update ] (all gray)
  const toggleBtn = config.is_enabled
    ? new ButtonBuilder()
        .setCustomId('interface_disable_btn')
        .setLabel('Disable')
        .setEmoji('🔴')
        .setStyle(ButtonStyle.Secondary)
    : new ButtonBuilder()
        .setCustomId('interface_enable_btn')
        .setLabel('Enable')
        .setEmoji('🟢')
        .setStyle(ButtonStyle.Secondary);

  const updateBtn = new ButtonBuilder()
    .setCustomId('interface_publish_btn')
    .setLabel(isPublished ? 'Update' : 'Publish')
    .setEmoji('🔄')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(!config.target_channel_id);

  const row1 = new ActionRowBuilder().addComponents(toggleBtn, updateBtn);

  // Row 2: [ Back ] | [ Setup ] (all gray)
  const backBtn = new ButtonBuilder()
    .setCustomId('settings_users')
    .setLabel('Back')
    .setEmoji('⬅️')
    .setStyle(ButtonStyle.Secondary);

  const setupBtn = new ButtonBuilder()
    .setCustomId('interface_setup_btn')
    .setLabel('Setup')
    .setEmoji('🛠️')
    .setStyle(ButtonStyle.Secondary);

  const row2 = new ActionRowBuilder().addComponents(backBtn, setupBtn);

  const components = [
    new ActionRowBuilder().addComponents(channelSelect),
    row1,
    row2
  ];

  const method = (interaction.deferred || interaction.replied)
    ? 'editReply'
    : (interaction.isButton() || interaction.isAnySelectMenu() ? 'update' : 'editReply');

  await interaction[method]({ embeds: [embed], components, content: '', files: [], attachments: [] });
}

/**
 * Render the Shortcut Setup Panel
 * Shows dynamic real-time image preview of all 12 slots (4 per row, 3 rows)
 * Below the image: 12 buttons (4 per row across 3 rows) for instant slot management
 * All buttons gray (ButtonStyle.Secondary)
 * @param {import('discord.js').Interaction} interaction 
 */
export async function showInterfaceSetup(interaction) {
  const guildId = interaction.guildId;
  const config = await getInterfaceConfig(guildId);
  const slots = normalizeShortcutOrder(config.shortcut_order);
  const slotColors = normalizeSlotColors(config.slot_colors);

  // 1. Generate real-time preview of the layout
  const bannerBuffer = await generateInterfaceBanner(slots, { slotColors });
  const attachment = new AttachmentBuilder(bannerBuffer, { name: 'preview.png' });

  const embed = new EmbedBuilder()
    .setTitle('Interface Shortcut Setup')
    .setDescription('Click any slot button below to assign or clear a feature. The preview image updates in real time.')
    .setColor(0x5865F2)
    .setImage('attachment://preview.png');

  // 2. Build 3 rows of 4 slot buttons
  const rows = [];
  for (let r = 0; r < 3; r++) {
    const row = new ActionRowBuilder();
    for (let c = 0; c < 4; c++) {
      const idx = r * 4 + c;
      const slotId = slots[idx];
      const meta = getShortcutMeta(slotId);

      const button = new ButtonBuilder()
        .setCustomId(`interface_slot_${idx}`)
        .setStyle(ButtonStyle.Secondary);

      if (meta && meta.emoji) {
        button.setEmoji(meta.emoji);
      } else {
        button.setLabel('+');
      }

      row.addComponents(button);
    }
    rows.push(row);
  }

  // 3. Navigation & Reset row
  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('interface_back_to_main')
      .setLabel('Back to Interface')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('interface_reset_defaults')
      .setLabel('Reset Defaults')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary)
  );
  rows.push(navRow);

  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferUpdate().catch(() => {});
  }

  await interaction.editReply({ embeds: [embed], components: rows, files: [attachment] });
}

/**
 * Render Feature Assignment picker for a specific slot
 * @param {import('discord.js').Interaction} interaction 
 * @param {number} slotIndex 
 */
export async function showInterfaceSlotAssign(interaction, slotIndex) {
  const guildId = interaction.guildId;
  const config = await getInterfaceConfig(guildId);
  const slots = normalizeShortcutOrder(config.shortcut_order);
  const slotColors = normalizeSlotColors(config.slot_colors);

  const currentId = slots[slotIndex];
  const currentMeta = getShortcutMeta(currentId);
  const currentLabel = currentMeta ? `${currentMeta.emoji} ${currentMeta.name}` : 'None';

  const currentColorHex = slotColors[slotIndex] || '#000000';
  const colorMeta = getCardColorMeta(currentColorHex);
  const currentColorLabel = `${colorMeta.emoji} ${colorMeta.name}`;

  const desc = [
    `• **Current Feature:** ${currentLabel}`,
    `• **Box Color:** ${currentColorLabel}`
  ].join('\n');

  const embed = new EmbedBuilder()
    .setTitle(`Assign Feature — Slot ${slotIndex + 1}`)
    .setDescription(desc)
    .setColor(0x5865F2);

  const featureOptions = [
    ...Object.values(SHORTCUT_REGISTRY).map(item => ({
      label: item.name,
      value: item.id,
      description: item.description,
      emoji: item.emoji,
      default: item.id === currentId
    })),
    {
      label: 'None',
      value: 'empty',
      description: 'Leave this slot empty',
      emoji: '🚫',
      default: !currentMeta || currentId === 'empty'
    }
  ];

  const featureSelect = new StringSelectMenuBuilder()
    .setCustomId(`interface_set_feature_${slotIndex}`)
    .setPlaceholder(`Choose a feature for Slot ${slotIndex + 1}...`)
    .addOptions(featureOptions);

  const colorOptions = INTERFACE_CARD_COLORS.map(c => ({
    label: c.name,
    value: c.hex,
    description: c.description,
    emoji: c.emoji,
    default: currentColorHex.toLowerCase() === c.hex.toLowerCase() ||
             (c.id === 'black' && (!currentColorHex || currentColorHex === '#000000'))
  }));

  const colorSelect = new StringSelectMenuBuilder()
    .setCustomId(`interface_set_color_${slotIndex}`)
    .setPlaceholder(`Choose a box color for Slot ${slotIndex + 1}...`)
    .addOptions(colorOptions);

  const row1 = new ActionRowBuilder().addComponents(featureSelect);
  const row2 = new ActionRowBuilder().addComponents(colorSelect);
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('interface_setup_btn')
      .setLabel('Back to Setup')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary)
  );

  const components = [row1, row2, row3];

  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferUpdate().catch(() => {});
  }

  await interaction.editReply({ embeds: [embed], components, files: [], attachments: [] });
}

/**
 * Handle Interface setup component interactions
 * @param {import('discord.js').Interaction} interaction 
 */
export async function handleInterfaceComponent(interaction) {
  const guildId = interaction.guildId;
  const customId = interaction.customId;

  // Runtime Admin check
  if (!interaction.member?.permissions.has(PermissionFlagsBits.Administrator)) {
    const deny = { content: 'Administrator permission required.', flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) return interaction.followUp(deny);
    return interaction.reply(deny);
  }

  try {
    // 1. Channel Select
    if (customId === 'interface_set_channel') {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
      const channelId = interaction.values[0];

      const channel = interaction.guild.channels.cache.get(channelId) || await interaction.guild.channels.fetch(channelId).catch(() => null);
      const permCheck = checkChannelPermissions(channel);
      if (!permCheck.valid) {
        return interaction.followUp({
          content: `Cannot use that channel. ${permCheck.error}\nPlease ensure the bot has View Channel, Send Messages, and Embed Links permissions there.`,
          flags: MessageFlags.Ephemeral
        });
      }

      const config = await getInterfaceConfig(guildId);
      config.target_channel_id = channelId;
      await saveInterfaceConfig(guildId, config);

      const logName = getUserLogName(interaction);
      sendLog(interaction.guild, 'audit', 'cyan', 'Interface Channel Assigned',
        `**Admin:** \`${logName}\`\n` +
        `**Channel:** <#${channelId}>`
      );

      return showInterfaceSettings(interaction);
    }

    // 2. Open Setup Panel
    if (customId === 'interface_setup_btn') {
      return showInterfaceSetup(interaction);
    }

    // 3. Back to Main Interface Panel
    if (customId === 'interface_back_to_main') {
      return showInterfaceSettings(interaction);
    }

    // 4. Click a Slot Button (0 to 11)
    if (customId.startsWith('interface_slot_')) {
      const slotIndex = parseInt(customId.replace('interface_slot_', ''), 10);
      return showInterfaceSlotAssign(interaction, slotIndex);
    }

    // 5. Select Menu: Assign or Clear Feature for Slot
    if (customId.startsWith('interface_set_feature_')) {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
      const slotIndex = parseInt(customId.replace('interface_set_feature_', ''), 10);
      const selectedFeature = interaction.values[0];

      const config = await getInterfaceConfig(guildId);
      const slots = normalizeShortcutOrder(config.shortcut_order);
      slots[slotIndex] = selectedFeature === 'empty' ? 'empty' : selectedFeature;
      config.shortcut_order = slots;
      await saveInterfaceConfig(guildId, config);

      return showInterfaceSlotAssign(interaction, slotIndex);
    }

    // 6. Select Menu: Assign Background Color for Slot Box
    if (customId.startsWith('interface_set_color_')) {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
      const slotIndex = parseInt(customId.replace('interface_set_color_', ''), 10);
      const selectedColor = interaction.values[0];

      const config = await getInterfaceConfig(guildId);
      const slotColors = normalizeSlotColors(config.slot_colors);
      slotColors[slotIndex] = selectedColor;
      config.slot_colors = slotColors;
      await saveInterfaceConfig(guildId, config);

      return showInterfaceSlotAssign(interaction, slotIndex);
    }

    // 7. Reset Defaults
    if (customId === 'interface_reset_defaults') {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
      const config = await getInterfaceConfig(guildId);
      config.shortcut_order = [...DEFAULT_SHORTCUT_ORDER];
      config.slot_colors = new Array(12).fill('#000000');
      await saveInterfaceConfig(guildId, config);

      return showInterfaceSetup(interaction);
    }

    // 7. Enable Interface
    if (customId === 'interface_enable_btn') {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
      const config = await getInterfaceConfig(guildId);
      config.is_enabled = true;
      await saveInterfaceConfig(guildId, config);

      if (config.target_channel_id) {
        await publishOrUpdateHub(interaction.client, guildId, { allowCreate: true }).catch(() => {});
      }

      return showInterfaceSettings(interaction);
    }

    // 8. Disable Interface
    if (customId === 'interface_disable_btn') {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
      const config = await getInterfaceConfig(guildId);
      config.is_enabled = false;

      if (config.target_channel_id && config.message_id) {
        const channel = interaction.guild.channels.cache.get(config.target_channel_id) ||
          await interaction.guild.channels.fetch(config.target_channel_id).catch(() => null);
        if (channel?.isTextBased?.()) {
          const oldMsg = await channel.messages.fetch(config.message_id).catch(() => null);
          if (oldMsg) await oldMsg.delete().catch(() => {});
        }
        config.message_id = null;
      }

      await saveInterfaceConfig(guildId, config);
      return showInterfaceSettings(interaction);
    }

    // 9. Publish / Update Hub
    if (customId === 'interface_publish_btn') {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
      const config = await getInterfaceConfig(guildId);

      if (!config.target_channel_id) {
        return interaction.followUp({
          content: 'Please select a target channel first before publishing or updating the Interface.',
          flags: MessageFlags.Ephemeral
        });
      }

      if (!config.is_enabled) {
        config.is_enabled = true;
        await saveInterfaceConfig(guildId, config);
      }

      const success = await publishOrUpdateHub(interaction.client, guildId, { allowCreate: true });
      const freshConfig = await getInterfaceConfig(guildId);

      if (success) {
        const logName = getUserLogName(interaction);
        sendLog(interaction.guild, 'audit', 'cyan', 'Interface Published/Updated',
          `**Admin:** \`${logName}\`\n` +
          `**Channel:** <#${freshConfig.target_channel_id}>`
        );

        await interaction.followUp({
          content: `Interface published successfully to <#${freshConfig.target_channel_id}>!`,
          flags: MessageFlags.Ephemeral
        });
      } else {
        await interaction.followUp({
          content: 'Failed to publish the Interface. Please verify channel permissions and try again.',
          flags: MessageFlags.Ephemeral
        });
      }

      return showInterfaceSettings(interaction);
    }

  } catch (error) {
    await handleInteractionError(interaction, error, 'interface component');
  }
}

export async function handleInterfaceModal(interaction) {
  // Deprecated
}

/**
 * Handle interactive ephemeral Hub shortcut buttons
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
export async function handleHubShortcut(interaction) {
  const customId = interaction.customId;
  const guildId = interaction.guildId;
  const userId = interaction.user.id;

  try {
    // 1. Level Shortcut (⭐)
    if (customId === 'hub_btn_level') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const payload = await getLevelViewPayload(guildId, userId, 'level');
      return interaction.editReply(payload);
    }

    // 2. Quests Shortcut (🎯)
    if (customId === 'hub_btn_quests') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const { renderQuests } = await import('./quest.js');
      return renderQuests(interaction, 0);
    }

    // 3. Daily Shortcut (💰)
    if (customId === 'hub_btn_daily') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const member = interaction.member;
      const isBooster = await isMemberBooster(member);
      const coinEmoji = COIN_EMOJI.forGuild(guildId);
      const result = await claimDaily(userId, guildId, getUserDisplayName(member), isBooster);

      if (!result.success) {
        if (result.error === 'daily_claimed') {
          const nextMidnight = getNextCairoMidnight();
          const nextMidnightTs = Math.floor(nextMidnight.getTime() / 1000);

          return interaction.editReply({
            content: `You already claimed your daily! Try again <t:${nextMidnightTs}:R>.`,
            embeds: []
          });
        }

        throw new Error(result.error);
      }

      const logUsername = getUserLogName(member);
      const initialBal = result.balance - result.amount;
      sendLog(interaction.guild, 'economy', 'orange', 'Daily Claimed',
        `**User:** \`${logUsername}\`\n` +
        `**Reward:** \`${result.amount.toLocaleString()}\` ${coinEmoji} (Daily)\n` +
        `**Streak:** \`${result.streak} days\`\n` +
        `**Balance:** \`${initialBal.toLocaleString()}\` ➡️ \`${result.balance.toLocaleString()}\``
      );

      const { breakdown } = result;
      let msg = `You received **${result.amount}** ${coinEmoji}\n`;
      msg += `> Base: **+${breakdown.base}**\n`;
      msg += `> Streak Bonus: **+${breakdown.streakBonus}**\n`;
      msg += `> Boost Bonus: **+${breakdown.boostBonus}**\n`;

      return interaction.editReply({ files: [], content: msg, embeds: [] });
    }

    // 4. Inventory Shortcut (🎒)
    if (customId === 'hub_btn_inventory') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      return handleInventoryButton(interaction);
    }

    // 5. Vote Shortcut (🗳️)
    if (customId === 'hub_btn_vote') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const { handleVoteCommand } = await import('./vote.js');
      return handleVoteCommand(interaction);
    }

    // 6. Notifications Shortcut (🔔)
    if (customId === 'hub_btn_notifications') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const settings = await getUserNotificationSettings(guildId, userId);
      const payload = buildNotificationsPayload(interaction.guild, settings);
      return interaction.editReply(payload);
    }

    // 7. Bank Shortcut (🏦)
    if (customId === 'hub_btn_bank') {
      const { handleBankCommand } = await import('./bank.js');
      return handleBankCommand(interaction);
    }

    // 8. Shop Items Shortcut (🛒)
    if (customId === 'hub_btn_items') {
      const { handleItemsCommand } = await import('./items.js');
      return handleItemsCommand(interaction);
    }

    // 9. Profile Shortcut (👤)
    if (customId === 'hub_btn_profile') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const { handleProfileCommand } = await import('./profile.js');
      return handleProfileCommand(interaction);
    }

    // 10. Invite Shortcut (🔗)
    if (customId === 'hub_btn_invite') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const clientId = interaction.client.user?.id || '815148891598356502';
      const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${clientId}`;
      const topGgUrl = `https://top.gg/bot/${clientId}`;

      const embed = new EmbedBuilder()
        .setDescription('**ADD MEDHAT BOT TO YOUR OWN SERVER!! 🤩**')
        .setColor('#5865F2');

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('❤️ TOP.GG')
          .setStyle(ButtonStyle.Link)
          .setURL(topGgUrl),
        new ButtonBuilder()
          .setLabel('➕ INVITE')
          .setStyle(ButtonStyle.Link)
          .setURL(inviteUrl)
      );

      return interaction.editReply({
        embeds: [embed],
        components: [row]
      });
    }

  } catch (error) {
    await handleInteractionError(interaction, error, 'hub shortcut');
  }
}
