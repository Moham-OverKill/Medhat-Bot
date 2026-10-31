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
import { handleInventoryButton, getCoinThumbnailUrl } from './bank.js';
import { isMemberBooster } from './colors.js';
import { COIN_EMOJI, COIN_NAME, getCurrencyName, getCurrencyEmoji, safeSetButtonEmoji, parseSelectEmoji, getUserDisplayName, getUserLogName, isBackDisabled } from '../shared.js';
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
    get description() {
      const name = COIN_NAME.toString().toLowerCase();
      return `Claim daily ${name} and streak bonuses`;
    },
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
    description: 'Browse items available in the shop',
    emoji: '📦',
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
    emoji: '➕',
    buttonCustomId: 'hub_btn_invite',
    tileFile: 'invite.png'
  }
};

export const DEFAULT_SHORTCUT_ORDER = [
  'level',
  'profile',
  'inventory',
  'empty',
  'daily',
  'quests',
  'vote',
  'empty',
  'items',
  'notifications',
  'invite',
  'empty'
];

export const DEFAULT_SLOT_COLORS = [
  '#636e72', '#636e72', '#636e72', '#000000',
  '#43b581', '#43b581', '#43b581', '#000000',
  '#29b6f6', '#29b6f6', '#29b6f6', '#000000'
];

export const DEFAULT_SLOT_BUTTON_COLORS = [
  'secondary', 'secondary', 'secondary', 'secondary',
  'success', 'success', 'success', 'secondary',
  'primary', 'primary', 'primary', 'secondary'
];

export const ADMIN_SHORTCUT_REGISTRY = {
  colors: {
    id: 'colors',
    name: 'Colors',
    label: 'COLORS',
    description: 'Configure and manage color roles',
    emoji: '🎨',
    buttonCustomId: 'admin_hub_colors'
  },
  levels: {
    id: 'levels',
    name: 'Levels',
    label: 'LEVELS',
    description: 'Configure battlepass and level progression',
    emoji: '⭐',
    buttonCustomId: 'admin_hub_pass'
  },
  roles: {
    id: 'roles',
    name: 'Roles',
    label: 'ROLES',
    description: 'Manage self-assignable and milestone roles',
    emoji: '🎭',
    buttonCustomId: 'admin_hub_roles'
  },
  coins: {
    id: 'coins',
    name: 'Coins',
    label: 'COINS',
    description: 'Configure server currency name and rates',
    emoji: '🪙',
    buttonCustomId: 'admin_hub_coins'
  },
  shop: {
    id: 'shop',
    name: 'Shop',
    label: 'SHOP',
    description: 'Manage shop categories, items, and packs',
    emoji: '🛒',
    buttonCustomId: 'admin_hub_shop'
  },
  post: {
    id: 'post',
    name: 'Post',
    label: 'POST',
    description: 'Post items in channels for members to buy',
    emoji: '📢',
    buttonCustomId: 'admin_hub_post'
  },
  chests: {
    id: 'chests',
    name: 'Chests',
    label: 'CHESTS',
    description: 'Configure lootboxes, prize rates, and drops',
    emoji: '🎁',
    buttonCustomId: 'admin_hub_chests'
  },
  economy: {
    id: 'economy',
    name: 'Economy',
    label: 'ECONOMY',
    description: 'View server economy health and multipliers',
    emoji: '📈',
    buttonCustomId: 'admin_hub_economy'
  },
  users: {
    id: 'users',
    name: 'Users',
    label: 'USERS',
    description: 'Manage user balances, streaks, and inventory',
    emoji: '👥',
    buttonCustomId: 'admin_hub_users'
  },
  anticheat: {
    id: 'anticheat',
    name: 'Anti Cheat',
    label: 'ANTI CHEAT',
    description: 'Configure text spam, voice AFK, and alt farming gates',
    emoji: '🚫',
    buttonCustomId: 'admin_hub_anticheat'
  },
  automod: {
    id: 'automod',
    name: 'Auto Mod',
    label: 'AUTO MOD',
    description: 'Manage channel filters, forums, and auto-reactions',
    emoji: '🛡️',
    buttonCustomId: 'admin_hub_automod'
  },
  admins: {
    id: 'admins',
    name: 'Admins',
    label: 'ADMINS',
    description: 'Manage authorized server bot administrators',
    emoji: '💼',
    buttonCustomId: 'admin_hub_admins'
  },
  leaderboard: {
    id: 'leaderboard',
    name: 'Leaderboards',
    label: 'LEADERBOARD',
    description: 'Configure live automated leaderboard channels',
    emoji: '📊',
    buttonCustomId: 'admin_hub_leaderboards'
  },
  embed: {
    id: 'embed',
    name: 'Embeds',
    label: 'EMBEDS',
    description: 'Create, edit, and schedule custom embeds',
    emoji: '📰',
    buttonCustomId: 'admin_hub_embed'
  },
  logs: {
    id: 'logs',
    name: 'Logs',
    label: 'LOGS',
    description: 'Configure audit log routing channels',
    emoji: '📜',
    buttonCustomId: 'admin_hub_logs'
  },
  dashboard: {
    id: 'dashboard',
    name: 'Dashboard',
    label: 'DASHBOARD',
    description: 'Configure the private staff dashboard interface',
    emoji: '🎛️',
    buttonCustomId: 'admin_hub_dashboard'
  },
  shortcuts: {
    id: 'shortcuts',
    name: 'Shortcuts',
    label: 'SHORTCUTS',
    description: 'Configure the public community shortcuts interface',
    emoji: '⚡',
    buttonCustomId: 'admin_hub_shortcuts'
  },
  customize: {
    id: 'customize',
    name: 'Appearance',
    label: 'APPEARANCE',
    description: 'Configure custom bot status, presence, and visuals',
    emoji: '🖼️',
    buttonCustomId: 'admin_hub_customize'
  }
};

export const DEFAULT_ADMIN_SHORTCUT_ORDER = [
  'colors', 'levels', 'roles', 'leaderboard',
  'coins', 'shop', 'chests', 'post',
  'users', 'anticheat', 'automod', 'embed'
];

export const DEFAULT_ADMIN_SLOT_COLORS = [
  '#000000', '#000000', '#000000', '#000000',
  '#000000', '#000000', '#000000', '#000000',
  '#000000', '#000000', '#000000', '#000000'
];

export const DEFAULT_ADMIN_SLOT_BUTTON_COLORS = [
  'secondary', 'secondary', 'secondary', 'secondary',
  'secondary', 'secondary', 'secondary', 'secondary',
  'secondary', 'secondary', 'secondary', 'secondary'
];

export function getShortcutMeta(id) {
  if (id && SHORTCUT_REGISTRY[id]) {
    return SHORTCUT_REGISTRY[id];
  }
  return null;
}

export function getAdminShortcutMeta(id) {
  if (id === 'lootboxes') id = 'chests';
  if (id && ADMIN_SHORTCUT_REGISTRY[id]) {
    return ADMIN_SHORTCUT_REGISTRY[id];
  }
  return null;
}

export function normalizeAdminShortcutOrder(order) {
  const result = [...DEFAULT_ADMIN_SHORTCUT_ORDER];
  if (Array.isArray(order) && order.length > 0) {
    for (let i = 0; i < Math.min(order.length, 12); i++) {
      const id = order[i];
      if (id === 'empty') {
        result[i] = 'empty';
      } else if (id === 'lootboxes') {
        result[i] = 'chests';
      } else if (id && ADMIN_SHORTCUT_REGISTRY[id]) {
        result[i] = id;
      } else if (id === undefined) {
        result[i] = DEFAULT_ADMIN_SHORTCUT_ORDER[i];
      }
    }
  }
  return result;
}

export function normalizeShortcutOrder(order) {
  if (!Array.isArray(order) || order.length === 0) {
    return [...DEFAULT_SHORTCUT_ORDER];
  }

  // Detect legacy 6-slot orders and migrate cleanly
  if (order.length === 6 && order[0] === 'level' && order[3] === 'inventory') {
    return [...DEFAULT_SHORTCUT_ORDER];
  }

  const result = new Array(12).fill('empty');
  for (let i = 0; i < Math.min(order.length, 12); i++) {
    const id = order[i];
    if (id && SHORTCUT_REGISTRY[id]) {
      result[i] = id;
    } else {
      result[i] = 'empty';
    }
  }
  return result;
}

export const INTERFACE_CARD_COLORS = [
  { id: 'black', hex: '#000000', name: 'Black', emoji: '🖤', description: 'Black card background' },
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

export function normalizeSlotColors(raw, defaultColors = null) {
  const defaults = Array.isArray(defaultColors) && defaultColors.length === 12
    ? defaultColors
    : [...DEFAULT_SLOT_COLORS];
  const result = [...defaults];
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

export const DISCORD_BUTTON_COLORS = [
  { id: 'primary', name: 'Blue', emoji: '💙', style: ButtonStyle.Primary, description: 'Blue button' },
  { id: 'success', name: 'Green', emoji: '💚', style: ButtonStyle.Success, description: 'Green button' },
  { id: 'danger', name: 'Red', emoji: '❤️', style: ButtonStyle.Danger, description: 'Red button' },
  { id: 'secondary', name: 'Gray', emoji: '🩶', style: ButtonStyle.Secondary, description: 'Gray button' }
];

export function normalizeSlotButtonColors(raw, defaultBtnColors = null) {
  const defaults = Array.isArray(defaultBtnColors) && defaultBtnColors.length === 12
    ? defaultBtnColors
    : [...DEFAULT_SLOT_BUTTON_COLORS];
  const result = [...defaults];
  const valid = new Set(['secondary', 'primary', 'success', 'danger']);
  if (Array.isArray(raw)) {
    for (let i = 0; i < Math.min(raw.length, 12); i++) {
      if (typeof raw[i] === 'string' && valid.has(raw[i].toLowerCase())) {
        result[i] = raw[i].toLowerCase();
      }
    }
  } else if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      const idx = parseInt(k, 10);
      if (!isNaN(idx) && idx >= 0 && idx < 12 && typeof v === 'string' && valid.has(v.toLowerCase())) {
        result[idx] = v.toLowerCase();
      }
    }
  }
  return result;
}

export function getButtonColorMeta(id) {
  const clean = (id || 'secondary').toLowerCase();
  return DISCORD_BUTTON_COLORS.find(c => c.id === clean) || DISCORD_BUTTON_COLORS[3];
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
function drawEmojiWithStroke(targetCtx, emoji, cx, cy, fontSize, strokeWidth = 8) {
  if (!strokeWidth || strokeWidth <= 0) {
    targetCtx.font = `${fontSize}px "Segoe UI Emoji", sans-serif`;
    targetCtx.textAlign = 'center';
    targetCtx.textBaseline = 'middle';
    targetCtx.fillText(emoji, cx, cy);
    return;
  }

  const pad = strokeWidth * 2 + 12;
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
  // Multi-ring concentric dilation with subpixel floating-point anti-aliased coordinates
  const stepSize = Math.max(1.2, strokeWidth / 4);
  for (let r = stepSize; r <= strokeWidth; r += stepSize) {
    const ringSteps = Math.max(14, Math.ceil(2 * Math.PI * r));
    for (let i = 0; i < ringSteps; i++) {
      const angle = (i * 2 * Math.PI) / ringSteps;
      const ox = Math.cos(angle) * r;
      const oy = Math.sin(angle) * r;
      targetCtx.drawImage(silCanvas, cx - tempW / 2 + ox, cy - tempH / 2 + oy);
    }
  }
  targetCtx.drawImage(silCanvas, cx - tempW / 2, cy - tempH / 2);
  targetCtx.drawImage(colorCanvas, cx - tempW / 2, cy - tempH / 2);
  targetCtx.restore();
}

/**
 * Resolve an emoji string to an image URL if it is a Discord custom emoji or direct image URL.
 * Supports <:name:id>, <a:name:id>, pure snowflake ID, and direct URLs.
 * @param {string} emojiStr
 * @returns {string|null}
 */
export function parseEmojiImageUrl(emojiStr) {
  if (!emojiStr || typeof emojiStr !== 'string') return null;
  const str = emojiStr.trim();
  if (str.startsWith('http://') || str.startsWith('https://')) {
    return str;
  }
  const customMatch = str.match(/<a?:[a-zA-Z0-9_]+:(\d{17,22})>/);
  if (customMatch && customMatch[1]) {
    return `https://cdn.discordapp.com/emojis/${customMatch[1]}.png?size=128&quality=lossless`;
  }
  if (/^\d{17,22}$/.test(str)) {
    return `https://cdn.discordapp.com/emojis/${str}.png?size=128&quality=lossless`;
  }
  return null;
}

const emojiImageCache = new Map();

/**
 * Detect non-transparent bounding box in an Image to crop empty margins
 * @param {import('@napi-rs/canvas').Image} image
 * @returns {{ sx: number, sy: number, sw: number, sh: number }|null}
 */
function getNonTransparentBounds(image) {
  try {
    const temp = createCanvas(image.width, image.height);
    const tCtx = temp.getContext('2d');
    tCtx.drawImage(image, 0, 0);
    const data = tCtx.getImageData(0, 0, image.width, image.height).data;
    let minX = image.width, maxX = 0, minY = image.height, maxY = 0;
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        if (data[(y * image.width + x) * 4 + 3] > 10) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < minX || maxY < minY) return null;
    return { sx: minX, sy: minY, sw: maxX - minX + 1, sh: maxY - minY + 1 };
  } catch {
    return null;
  }
}

/**
 * Fetch and load an image safely from a URL or CDN with timeout and in-memory caching.
 * Automatically analyzes non-transparent bounds to trim empty border padding.
 * @param {string} url
 * @returns {Promise<{ img: import('@napi-rs/canvas').Image, trim: { sx: number, sy: number, sw: number, sh: number }|null }|null>}
 */
async function fetchEmojiImageSafe(url) {
  if (!url) return null;
  if (emojiImageCache.has(url)) {
    return emojiImageCache.get(url);
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const img = await loadImage(buffer);
    const trim = getNonTransparentBounds(img);
    const entry = { img, trim };
    if (emojiImageCache.size > 100) {
      const firstKey = emojiImageCache.keys().next().value;
      emojiImageCache.delete(firstKey);
    }
    emojiImageCache.set(url, entry);
    return entry;
  } catch (err) {
    sysError('Failed to fetch custom emoji image for interface banner', err, { url });
    return null;
  }
}

/**
 * Draw an Image onto targetCtx centered at (cx, cy) with concentric silhouette dilation
 * creating a crisp black outline matching drawEmojiWithStroke.
 * Supports source sub-rect trimming to eliminate transparent padding.
 * @param {import('@napi-rs/canvas').SKRSContext2D} targetCtx 
 * @param {import('@napi-rs/canvas').Image} img 
 * @param {number} cx 
 * @param {number} cy 
 * @param {number} targetSize 
 * @param {number} strokeWidth 
 * @param {{ sx: number, sy: number, sw: number, sh: number }|null} [trim]
 */
function drawImageWithStroke(targetCtx, img, cx, cy, targetSize, strokeWidth = 8, trim = null) {
  const sx = trim?.sx ?? 0;
  const sy = trim?.sy ?? 0;
  const sw = trim?.sw ?? img.width;
  const sh = trim?.sh ?? img.height;
  const aspect = (sw && sh) ? (sw / sh) : 1;
  let drawW = targetSize;
  let drawH = targetSize;
  if (aspect > 1) {
    drawH = targetSize / aspect;
  } else if (aspect < 1) {
    drawW = targetSize * aspect;
  }

  if (!strokeWidth || strokeWidth <= 0) {
    targetCtx.drawImage(img, sx, sy, sw, sh, cx - drawW / 2, cy - drawH / 2, drawW, drawH);
    return;
  }

  const pad = strokeWidth * 2 + 12;
  const tempW = Math.ceil(drawW + pad * 2);
  const tempH = Math.ceil(drawH + pad * 2);

  const colorCanvas = createCanvas(tempW, tempH);
  const colorCtx = colorCanvas.getContext('2d');
  colorCtx.drawImage(img, sx, sy, sw, sh, pad, pad, drawW, drawH);

  const silCanvas = createCanvas(tempW, tempH);
  const silCtx = silCanvas.getContext('2d');
  silCtx.drawImage(colorCanvas, 0, 0);
  silCtx.globalCompositeOperation = 'source-in';
  silCtx.fillStyle = '#000000';
  silCtx.fillRect(0, 0, tempW, tempH);

  targetCtx.save();
  const stepSize = Math.max(1.2, strokeWidth / 4);
  for (let r = stepSize; r <= strokeWidth; r += stepSize) {
    const ringSteps = Math.max(14, Math.ceil(2 * Math.PI * r));
    for (let i = 0; i < ringSteps; i++) {
      const angle = (i * 2 * Math.PI) / ringSteps;
      const ox = Math.cos(angle) * r;
      const oy = Math.sin(angle) * r;
      targetCtx.drawImage(silCanvas, cx - tempW / 2 + ox, cy - tempH / 2 + oy);
    }
  }
  targetCtx.drawImage(silCanvas, cx - tempW / 2, cy - tempH / 2);
  targetCtx.drawImage(colorCanvas, cx - tempW / 2, cy - tempH / 2);
  targetCtx.restore();
}

/**
 * Render an individual shortcut card tile
 * Features a solid colored card base, crisp border, prominent centered emoji with black outline, and bold bottom label with black outline.
 * Supports both Unicode emoji glyphs and custom Discord emojis (rendered as images).
 * @param {import('@napi-rs/canvas').SKRSContext2D} ctx 
 * @param {number} x 
 * @param {number} y 
 * @param {number} cardW 
 * @param {number} cardH 
 * @param {object} meta 
 * @param {string} [bgColor]
 */
async function drawShortcutCard(ctx, x, y, cardW, cardH, meta, bgColor = '#000000') {
  const radius = Math.round(cardH * 0.08);
  const borderWidth = Math.max(4, Math.round(cardH * 0.024));
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

  // 1. Emoji / Icon — prominent in center with crisp, refined black outline and clean spacing
  const isCoinSlot = meta.id === 'coins';
  const isChestSlot = meta.id === 'chests' || meta.id === 'lootboxes';
  const rawEmoji = meta.emoji || '⭐';

  const customUrl = parseEmojiImageUrl(rawEmoji);
  let customData = null;
  if (customUrl) {
    customData = await fetchEmojiImageSafe(customUrl);
  }

  const isCustomImage = Boolean(customData && customData.img);
  // Custom images are trimmed to non-transparent bounds (100% visual density); scale slightly lower than font glyphs
  const emojiSize = isCustomImage ? Math.round(cardH * 0.46) : Math.round(cardH * 0.50);
  const emojiStrokeWidth = Math.max(3, Math.round(cardH * 0.016));
  const emojiCenterY = y + Math.round(cardH * 0.41);

  if (isCustomImage) {
    drawImageWithStroke(ctx, customData.img, x + cardW / 2, emojiCenterY, emojiSize, emojiStrokeWidth, customData.trim);
  } else {
    // If it was supposed to be a custom emoji but fetch failed or is unparseable text, fallback to standard glyph
    let fallbackEmoji = rawEmoji;
    if (customUrl || rawEmoji.includes('<') || rawEmoji.includes('>')) {
      fallbackEmoji = isCoinSlot ? '🪙' : (isChestSlot ? '🎁' : '⭐');
    }
    drawEmojiWithStroke(ctx, fallbackEmoji, x + cardW / 2, emojiCenterY, emojiSize, emojiStrokeWidth);
  }

  // 2. Label Text — bold, uppercase, positioned at 83% with thick, smooth rounded black outline
  let labelFontSize = Math.round(cardH * 0.135);
  const label = (meta.label || meta.name || 'SHORTCUT').toUpperCase();
  ctx.font = `bold ${labelFontSize}px "Roboto-Bold", "Arial Black", "Segoe UI", sans-serif`;
  const maxWidth = cardW - 28;
  while (ctx.measureText(label).width > maxWidth && labelFontSize > 14) {
    labelFontSize -= 2;
    ctx.font = `bold ${labelFontSize}px "Roboto-Bold", "Arial Black", "Segoe UI", sans-serif`;
  }

  const textStrokeWidth = Math.max(5, Math.round(labelFontSize * 0.22));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Black outline/stroke
  ctx.lineWidth = textStrokeWidth;
  ctx.strokeStyle = '#000000';
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
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

  // Balanced high-resolution grid (optimized for sub-second generation and fast Discord upload)
  if (maxCols >= 4) {
    cardW = 312; // 390 * 0.80
    cardH = 262; // 327 * 0.80
    marginX = 24; // 30 * 0.80
    marginY = 20; // 25 * 0.80
    gapX = 29;    // 36 * 0.80
    gapY = 28;    // 35 * 0.80
  } else {
    cardW = 419; // 524 * 0.80
    cardH = 352; // 440 * 0.80
    marginX = 32; // 40 * 0.80
    marginY = 16; // 20 * 0.80
    gapX = 38;    // 48 * 0.80
    gapY = 26;    // 33 * 0.80
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
        await drawShortcutCard(ctx, x, y, cardW, cardH, meta, bgColor);
      }
    }
  }

  return await canvas.encode('png');
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
      `SELECT guild_id, is_enabled, shortcut_order, slot_colors, slot_button_colors, target_channel_id, message_id,
              admin_is_enabled, admin_target_channel_id, admin_message_id,
              admin_shortcut_order, admin_slot_colors, admin_slot_button_colors
       FROM server_interface_config 
       WHERE guild_id = $1`,
      [guildId]
    ).catch(async (queryErr) => {
      await pool.query(`ALTER TABLE server_interface_config ADD COLUMN IF NOT EXISTS slot_colors JSONB NOT NULL DEFAULT '[]'::jsonb`).catch(() => {});
      await pool.query(`ALTER TABLE server_interface_config ADD COLUMN IF NOT EXISTS slot_button_colors JSONB NOT NULL DEFAULT '[]'::jsonb`).catch(() => {});
      await pool.query(`ALTER TABLE server_interface_config ADD COLUMN IF NOT EXISTS admin_is_enabled BOOLEAN NOT NULL DEFAULT TRUE`).catch(() => {});
      await pool.query(`ALTER TABLE server_interface_config ADD COLUMN IF NOT EXISTS admin_target_channel_id VARCHAR(32)`).catch(() => {});
      await pool.query(`ALTER TABLE server_interface_config ADD COLUMN IF NOT EXISTS admin_message_id VARCHAR(32)`).catch(() => {});
      await pool.query(`ALTER TABLE server_interface_config ADD COLUMN IF NOT EXISTS admin_shortcut_order JSONB NOT NULL DEFAULT '["colors","levels","roles","empty","coins","shop","economy","empty","users","anticheat","automod","empty"]'::jsonb`).catch(() => {});
      await pool.query(`ALTER TABLE server_interface_config ADD COLUMN IF NOT EXISTS admin_slot_colors JSONB NOT NULL DEFAULT '["#000000","#000000","#000000","#000000","#000000","#000000","#000000","#000000","#000000","#000000","#000000","#000000"]'::jsonb`).catch(() => {});
      await pool.query(`ALTER TABLE server_interface_config ADD COLUMN IF NOT EXISTS admin_slot_button_colors JSONB NOT NULL DEFAULT '["secondary","secondary","secondary","secondary","secondary","secondary","secondary","secondary","secondary","secondary","secondary","secondary"]'::jsonb`).catch(() => {});
      return pool.query(
        `SELECT guild_id, is_enabled, shortcut_order, slot_colors, slot_button_colors, target_channel_id, message_id,
                admin_is_enabled, admin_target_channel_id, admin_message_id,
                admin_shortcut_order, admin_slot_colors, admin_slot_button_colors
         FROM server_interface_config 
         WHERE guild_id = $1`,
        [guildId]
      );
    });

    if (res.rows.length > 0) {
      const row = res.rows[0];
      const rawAdminColors = row.admin_slot_colors;
      const isLegacyAdminColors = Array.isArray(rawAdminColors) && (
        (rawAdminColors[0] === '#43b581' && rawAdminColors[4] === '#2374e1' && rawAdminColors[8] === '#e02443') ||
        rawAdminColors.every(c => c === '#636e72') ||
        rawAdminColors.length === 0
      );
      const rawAdminBtnColors = row.admin_slot_button_colors;
      const isLegacyAdminBtnColors = Array.isArray(rawAdminBtnColors) && (
        (rawAdminBtnColors[0] === 'success' && rawAdminBtnColors[4] === 'primary' && rawAdminBtnColors[8] === 'danger') ||
        rawAdminBtnColors.length === 0
      );

      const rawShortcuts = row.shortcut_order;
      const isLegacyShortcuts = Array.isArray(rawShortcuts) && (
        (rawShortcuts.length === 6 && rawShortcuts[0] === 'level' && rawShortcuts[3] === 'inventory') ||
        (rawShortcuts.length === 12 && rawShortcuts[0] === 'level' && rawShortcuts[1] === 'quests' && rawShortcuts[2] === 'daily' && rawShortcuts[3] === 'empty' && rawShortcuts[4] === 'inventory' && rawShortcuts[5] === 'vote' && rawShortcuts[6] === 'notifications')
      );

      const rawAdminOrder = row.admin_shortcut_order;
      const isLegacyAdminOrder = Array.isArray(rawAdminOrder) && (
        rawAdminOrder.length === 12 &&
        rawAdminOrder[0] === 'colors' &&
        rawAdminOrder[1] === 'levels' &&
        rawAdminOrder[2] === 'roles' &&
        rawAdminOrder[3] === 'empty' &&
        rawAdminOrder[4] === 'coins' &&
        rawAdminOrder[5] === 'shop' &&
        rawAdminOrder[6] === 'economy' &&
        rawAdminOrder[7] === 'empty'
      );

      const rawColors = row.slot_colors;
      const isLegacyColors = !Array.isArray(rawColors) || rawColors.length === 0 || rawColors.every(c => c === '#000000');
      const rawBtnColors = row.slot_button_colors;
      const isLegacyBtnColors = !Array.isArray(rawBtnColors) || rawBtnColors.length === 0 || rawBtnColors.every(c => c === 'secondary');

      return {
        guild_id: row.guild_id,
        is_enabled: Boolean(row.is_enabled),
        shortcut_order: isLegacyShortcuts ? [...DEFAULT_SHORTCUT_ORDER] : normalizeShortcutOrder(row.shortcut_order),
        slot_colors: isLegacyColors ? [...DEFAULT_SLOT_COLORS] : normalizeSlotColors(rawColors, DEFAULT_SLOT_COLORS),
        slot_button_colors: isLegacyBtnColors ? [...DEFAULT_SLOT_BUTTON_COLORS] : normalizeSlotButtonColors(rawBtnColors, DEFAULT_SLOT_BUTTON_COLORS),
        target_channel_id: row.target_channel_id || null,
        message_id: row.message_id || null,
        admin_is_enabled: Boolean(row.admin_is_enabled ?? true),
        admin_target_channel_id: row.admin_target_channel_id || null,
        admin_message_id: row.admin_message_id || null,
        admin_shortcut_order: isLegacyAdminOrder ? [...DEFAULT_ADMIN_SHORTCUT_ORDER] : normalizeAdminShortcutOrder(row.admin_shortcut_order),
        admin_slot_colors: isLegacyAdminColors ? [...DEFAULT_ADMIN_SLOT_COLORS] : normalizeSlotColors(rawAdminColors, DEFAULT_ADMIN_SLOT_COLORS),
        admin_slot_button_colors: isLegacyAdminBtnColors ? [...DEFAULT_ADMIN_SLOT_BUTTON_COLORS] : normalizeSlotButtonColors(rawAdminBtnColors, DEFAULT_ADMIN_SLOT_BUTTON_COLORS)
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
      slot_colors: [...DEFAULT_SLOT_COLORS],
      slot_button_colors: [...DEFAULT_SLOT_BUTTON_COLORS],
      target_channel_id: fallbackChannel,
      message_id: fallbackMessage,
      admin_is_enabled: true,
      admin_target_channel_id: null,
      admin_message_id: null,
      admin_shortcut_order: [...DEFAULT_ADMIN_SHORTCUT_ORDER],
      admin_slot_colors: [...DEFAULT_ADMIN_SLOT_COLORS],
      admin_slot_button_colors: [...DEFAULT_ADMIN_SLOT_BUTTON_COLORS]
    };
  } catch (err) {
    sysError('Failed to fetch interface config', err, { guildId });
    return {
      guild_id: guildId,
      is_enabled: true,
      shortcut_order: [...DEFAULT_SHORTCUT_ORDER],
      slot_colors: [...DEFAULT_SLOT_COLORS],
      slot_button_colors: [...DEFAULT_SLOT_BUTTON_COLORS],
      target_channel_id: null,
      message_id: null,
      admin_is_enabled: true,
      admin_target_channel_id: null,
      admin_message_id: null,
      admin_shortcut_order: [...DEFAULT_ADMIN_SHORTCUT_ORDER],
      admin_slot_colors: [...DEFAULT_ADMIN_SLOT_COLORS],
      admin_slot_button_colors: [...DEFAULT_ADMIN_SLOT_BUTTON_COLORS]
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
    const existing = await getInterfaceConfig(guildId);

    const isEnabled = data.is_enabled !== undefined ? Boolean(data.is_enabled) : existing.is_enabled;
    const normalizedOrder = data.shortcut_order !== undefined ? normalizeShortcutOrder(data.shortcut_order) : existing.shortcut_order;
    const normalizedColors = data.slot_colors !== undefined ? normalizeSlotColors(data.slot_colors) : existing.slot_colors;
    const normalizedBtnColors = data.slot_button_colors !== undefined ? normalizeSlotButtonColors(data.slot_button_colors) : existing.slot_button_colors;
    const channelId = data.target_channel_id !== undefined ? (data.target_channel_id || null) : existing.target_channel_id;
    const messageId = data.message_id !== undefined ? (data.message_id || null) : existing.message_id;

    const adminIsEnabled = data.admin_is_enabled !== undefined ? Boolean(data.admin_is_enabled) : existing.admin_is_enabled;
    const adminChannelId = data.admin_target_channel_id !== undefined ? (data.admin_target_channel_id || null) : existing.admin_target_channel_id;
    const adminMessageId = data.admin_message_id !== undefined ? (data.admin_message_id || null) : existing.admin_message_id;

    const adminNormalizedOrder = data.admin_shortcut_order !== undefined
      ? normalizeAdminShortcutOrder(data.admin_shortcut_order)
      : (existing.admin_shortcut_order || [...DEFAULT_ADMIN_SHORTCUT_ORDER]);
    const adminNormalizedColors = data.admin_slot_colors !== undefined
      ? normalizeSlotColors(data.admin_slot_colors, DEFAULT_ADMIN_SLOT_COLORS)
      : (existing.admin_slot_colors || [...DEFAULT_ADMIN_SLOT_COLORS]);
    const adminNormalizedBtnColors = data.admin_slot_button_colors !== undefined
      ? normalizeSlotButtonColors(data.admin_slot_button_colors, DEFAULT_ADMIN_SLOT_BUTTON_COLORS)
      : (existing.admin_slot_button_colors || [...DEFAULT_ADMIN_SLOT_BUTTON_COLORS]);

    const queryStr = `
      INSERT INTO server_interface_config (
        guild_id, is_enabled, shortcut_order, slot_colors, slot_button_colors,
        target_channel_id, message_id,
        admin_is_enabled, admin_target_channel_id, admin_message_id,
        admin_shortcut_order, admin_slot_colors, admin_slot_button_colors,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
      ON CONFLICT (guild_id)
      DO UPDATE SET
        is_enabled = EXCLUDED.is_enabled,
        shortcut_order = EXCLUDED.shortcut_order,
        slot_colors = EXCLUDED.slot_colors,
        slot_button_colors = EXCLUDED.slot_button_colors,
        target_channel_id = EXCLUDED.target_channel_id,
        message_id = EXCLUDED.message_id,
        admin_is_enabled = EXCLUDED.admin_is_enabled,
        admin_target_channel_id = EXCLUDED.admin_target_channel_id,
        admin_message_id = EXCLUDED.admin_message_id,
        admin_shortcut_order = EXCLUDED.admin_shortcut_order,
        admin_slot_colors = EXCLUDED.admin_slot_colors,
        admin_slot_button_colors = EXCLUDED.admin_slot_button_colors,
        updated_at = NOW()
      RETURNING guild_id, is_enabled, shortcut_order, slot_colors, slot_button_colors,
                target_channel_id, message_id,
                admin_is_enabled, admin_target_channel_id, admin_message_id,
                admin_shortcut_order, admin_slot_colors, admin_slot_button_colors
    `;
    const params = [
      guildId,
      isEnabled,
      JSON.stringify(normalizedOrder),
      JSON.stringify(normalizedColors),
      JSON.stringify(normalizedBtnColors),
      channelId,
      messageId,
      adminIsEnabled,
      adminChannelId,
      adminMessageId,
      JSON.stringify(adminNormalizedOrder),
      JSON.stringify(adminNormalizedColors),
      JSON.stringify(adminNormalizedBtnColors)
    ];

    let res;
    try {
      res = await pool.query(queryStr, params);
    } catch (saveErr) {
      await pool.query(`ALTER TABLE server_interface_config ADD COLUMN IF NOT EXISTS slot_colors JSONB NOT NULL DEFAULT '[]'::jsonb`).catch(() => {});
      await pool.query(`ALTER TABLE server_interface_config ADD COLUMN IF NOT EXISTS slot_button_colors JSONB NOT NULL DEFAULT '[]'::jsonb`).catch(() => {});
      await pool.query(`ALTER TABLE server_interface_config ADD COLUMN IF NOT EXISTS admin_is_enabled BOOLEAN NOT NULL DEFAULT TRUE`).catch(() => {});
      await pool.query(`ALTER TABLE server_interface_config ADD COLUMN IF NOT EXISTS admin_target_channel_id VARCHAR(32)`).catch(() => {});
      await pool.query(`ALTER TABLE server_interface_config ADD COLUMN IF NOT EXISTS admin_message_id VARCHAR(32)`).catch(() => {});
      await pool.query(`ALTER TABLE server_interface_config ADD COLUMN IF NOT EXISTS admin_shortcut_order JSONB NOT NULL DEFAULT '["colors","levels","roles","empty","coins","shop","economy","empty","users","anticheat","automod","empty"]'::jsonb`).catch(() => {});
      await pool.query(`ALTER TABLE server_interface_config ADD COLUMN IF NOT EXISTS admin_slot_colors JSONB NOT NULL DEFAULT '["#000000","#000000","#000000","#000000","#000000","#000000","#000000","#000000","#000000","#000000","#000000","#000000"]'::jsonb`).catch(() => {});
      await pool.query(`ALTER TABLE server_interface_config ADD COLUMN IF NOT EXISTS admin_slot_button_colors JSONB NOT NULL DEFAULT '["secondary","secondary","secondary","secondary","secondary","secondary","secondary","secondary","secondary","secondary","secondary","secondary"]'::jsonb`).catch(() => {});
      res = await pool.query(queryStr, params);
    }

    // Keep legacy guild_configs synchronized ONLY if valid channelId/messageId is present
    if (channelId || messageId) {
      try {
        const guildConfig = await getGuildConfig(guildId) || {};
        if (channelId) guildConfig.interface_channel_id = channelId;
        if (messageId) guildConfig.interface_message_id = messageId;
        await setGuildConfig(guildId, guildConfig);
      } catch (syncErr) {
        sysError('Failed to sync guildConfig interface channel', syncErr, { guildId });
      }
    }

    const row = res.rows[0];
    return {
      guild_id: row.guild_id,
      is_enabled: Boolean(row.is_enabled),
      shortcut_order: normalizeShortcutOrder(row.shortcut_order),
      slot_colors: normalizeSlotColors(row.slot_colors),
      slot_button_colors: normalizeSlotButtonColors(row.slot_button_colors),
      target_channel_id: row.target_channel_id || null,
      message_id: row.message_id || null,
      admin_is_enabled: Boolean(row.admin_is_enabled ?? true),
      admin_target_channel_id: row.admin_target_channel_id || null,
      admin_message_id: row.admin_message_id || null,
      admin_shortcut_order: normalizeAdminShortcutOrder(row.admin_shortcut_order),
      admin_slot_colors: normalizeSlotColors(row.admin_slot_colors, DEFAULT_ADMIN_SLOT_COLORS),
      admin_slot_button_colors: normalizeSlotButtonColors(row.admin_slot_button_colors, DEFAULT_ADMIN_SLOT_BUTTON_COLORS)
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
    .setTitle('SHORTCUTS')
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
 * Build the shortcut buttons for the Hub message (matches image rows and configured button colors)
 * @param {import('discord.js').Client} [client]
 * @param {string[]} [shortcutOrder]
 * @param {string[]} [slotButtonColors]
 * @returns {ActionRowBuilder[]}
 */
export function buildHubButtons(client = null, shortcutOrder = null, slotButtonColors = null) {
  const order = normalizeShortcutOrder(shortcutOrder);
  const buttonColors = normalizeSlotButtonColors(slotButtonColors);
  const rows = [];
  const configuredRows = [
    [0, 1, 2, 3].map(i => ({ id: order[i], slotIndex: i })),
    [4, 5, 6, 7].map(i => ({ id: order[i], slotIndex: i })),
    [8, 9, 10, 11].map(i => ({ id: order[i], slotIndex: i }))
  ];

  for (const row of configuredRows) {
    const actionRow = new ActionRowBuilder();
    for (const item of row) {
      if (item.id && item.id !== 'empty') {
        const meta = SHORTCUT_REGISTRY[item.id];
        if (meta) {
          const colorMeta = getButtonColorMeta(buttonColors[item.slotIndex]);
          actionRow.addComponents(
            new ButtonBuilder()
              .setCustomId(meta.buttonCustomId)
              .setEmoji(meta.emoji)
              .setStyle(colorMeta.style)
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
    const buttonRows = buildHubButtons(client, interfaceConfig.shortcut_order, interfaceConfig.slot_button_colors);
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

export function getAdminShortcutItems(guildId = null) {
  const coinName = guildId ? COIN_NAME.forGuild(guildId) : 'COINS';
  const coinEmoji = guildId ? COIN_EMOJI.forGuild(guildId) : '🪙';
  return [
    [
      { id: 'colors', label: 'COLORS', emoji: '🎨', btnId: 'admin_hub_colors' },
      { id: 'levels', label: 'LEVELS', emoji: '⭐', btnId: 'admin_hub_pass' },
      { id: 'roles', label: 'ROLES', emoji: '🎭', btnId: 'admin_hub_roles' }
    ],
    [
      { id: 'coins', label: coinName.toUpperCase(), emoji: coinEmoji, btnId: 'admin_hub_coins' },
      { id: 'shop', label: 'SHOP', emoji: '🛒', btnId: 'admin_hub_shop' },
      { id: 'economy', label: 'ECONOMY', emoji: '📈', btnId: 'admin_hub_economy' }
    ],
    [
      { id: 'users', label: 'USERS', emoji: '👥', btnId: 'admin_hub_users' },
      { id: 'anticheat', label: 'ANTI CHEAT', emoji: '🚫', btnId: 'admin_hub_anticheat' },
      { id: 'automod', label: 'AUTO MOD', emoji: '🛡️', btnId: 'admin_hub_automod' }
    ]
  ];
}

export const ADMIN_SHORTCUT_ITEMS = getAdminShortcutItems();

/**
 * Generate composite Admin Interface banner image buffer
 * Dynamic row balancing and auto-centering, omitting empty slots
 * @param {string[]} [shortcutOrder]
 * @param {object} [options]
 * @returns {Promise<Buffer>}
 */
export async function generateAdminInterfaceBanner(shortcutOrder = null, options = {}) {
  const guildId = options?.guildId || null;
  const coinName = options?.coinName || (guildId ? await getCurrencyName(guildId) : 'COINS');
  const coinEmoji = options?.coinEmoji || (guildId ? await getCurrencyEmoji(guildId) : '🪙');
  let lootBoxName = options?.lootBoxName || null;
  let lootBoxEmoji = options?.lootBoxEmoji || null;
  if (!lootBoxName || !lootBoxEmoji) {
    if (guildId) {
      try {
        const { getLootBoxCategoryName, getLootBoxCategoryEmoji } = await import('../economy/lootbox.js');
        if (!lootBoxName) lootBoxName = await getLootBoxCategoryName(guildId);
        if (!lootBoxEmoji) lootBoxEmoji = await getLootBoxCategoryEmoji(guildId);
      } catch {}
    }
    if (!lootBoxName) lootBoxName = 'Chests';
    if (!lootBoxEmoji) lootBoxEmoji = '🎁';
  }

  const normalized = normalizeAdminShortcutOrder(shortcutOrder);
  const slotColors = normalizeSlotColors(
    Array.isArray(options) ? options : (options?.slotColors || options?.slot_colors || []),
    DEFAULT_ADMIN_SLOT_COLORS
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
    const activeInRow = row.filter(item => item.id && item.id !== 'empty' && ADMIN_SHORTCUT_REGISTRY[item.id]);
    if (activeInRow.length > 0) {
      activeRows.push(activeInRow);
    }
  }

  // Fallback to default 3x3 layout if nothing is configured
  if (activeRows.length === 0) {
    activeRows.push(
      [{ id: 'colors', slotIndex: 0 }, { id: 'levels', slotIndex: 1 }, { id: 'roles', slotIndex: 2 }],
      [{ id: 'coins', slotIndex: 4 }, { id: 'shop', slotIndex: 5 }, { id: 'economy', slotIndex: 6 }],
      [{ id: 'users', slotIndex: 8 }, { id: 'anticheat', slotIndex: 9 }, { id: 'automod', slotIndex: 10 }]
    );
  }

  const maxCols = Math.min(4, Math.max(...activeRows.map(r => r.length)));
  const rowCount = activeRows.length;

  let cardW, cardH, marginX, marginY, gapX, gapY;
  if (maxCols >= 4) {
    cardW = 312;
    cardH = 262;
    marginX = 24;
    marginY = 20;
    gapX = 29;
    gapY = 28;
  } else {
    cardW = 419;
    cardH = 352;
    marginX = 32;
    marginY = 16;
    gapX = 38;
    gapY = 26;
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
      const meta = ADMIN_SHORTCUT_REGISTRY[item.id];
      const bgColor = slotColors[item.slotIndex] || '#000000';
      if (meta) {
        const itemMeta = { ...meta };
        if (item.id === 'coins') {
          itemMeta.label = (coinName || 'Coins').toUpperCase();
          itemMeta.emoji = coinEmoji || '🪙';
        } else if (item.id === 'chests' || item.id === 'lootboxes') {
          itemMeta.label = (lootBoxName || 'Chests').toUpperCase();
          itemMeta.emoji = lootBoxEmoji || '🎁';
        }
        await drawShortcutCard(ctx, x, y, cardW, cardH, itemMeta, bgColor);
      }
    }
  }

  return await canvas.encode('png');
}

export function buildAdminHubEmbed() {
  return new EmbedBuilder()
    .setTitle('DASHBOARD')
    .setColor(0x000000)
    .setImage('attachment://admin_interface.png');
}

export function buildAdminHubButtons(guildId = null, guild = null, shortcutOrder = null, slotButtonColors = null, options = {}) {
  const order = normalizeAdminShortcutOrder(shortcutOrder);
  const buttonColors = normalizeSlotButtonColors(slotButtonColors, DEFAULT_ADMIN_SLOT_BUTTON_COLORS);
  const rows = [];
  const configuredRows = [
    [0, 1, 2, 3].map(i => ({ id: order[i], slotIndex: i })),
    [4, 5, 6, 7].map(i => ({ id: order[i], slotIndex: i })),
    [8, 9, 10, 11].map(i => ({ id: order[i], slotIndex: i }))
  ];

  for (const row of configuredRows) {
    const actionRow = new ActionRowBuilder();
    for (const item of row) {
      if (item.id && item.id !== 'empty') {
        const meta = ADMIN_SHORTCUT_REGISTRY[item.id];
        if (meta) {
          const btnColorMeta = getButtonColorMeta(buttonColors[item.slotIndex]);
          const btn = new ButtonBuilder()
            .setCustomId(meta.buttonCustomId)
            .setStyle(btnColorMeta.style);

          if (item.id === 'coins' && guildId) {
            const coinEmoji = COIN_EMOJI.forGuild(guildId);
            safeSetButtonEmoji(btn, coinEmoji, guild, '🪙');
          } else if ((item.id === 'chests' || item.id === 'lootboxes') && options?.lootBoxEmoji) {
            safeSetButtonEmoji(btn, options.lootBoxEmoji, guild, '🎁');
          } else {
            safeSetButtonEmoji(btn, meta.emoji, guild, '⭐');
          }
          actionRow.addComponents(btn);
        }
      }
    }
    if (actionRow.components.length > 0) {
      rows.push(actionRow);
    }
  }
  return rows;
}

const adminHubUpdateLocks = new Set();

/**
 * Publish or update the public Admin Hub message in the designated channel
 * @param {import('discord.js').Client} client 
 * @param {string} guildId 
 * @param {{ allowCreate?: boolean }} [options]
 * @returns {Promise<boolean>}
 */
export async function publishOrUpdateAdminHub(client, guildId, options = {}) {
  const { allowCreate = false } = options;

  if (adminHubUpdateLocks.has(guildId)) {
    return false;
  }
  adminHubUpdateLocks.add(guildId);

  try {
    const interfaceConfig = await getInterfaceConfig(guildId);
    if (!interfaceConfig.admin_is_enabled) {
      return false;
    }

    const channelId = interfaceConfig.admin_target_channel_id;
    if (!channelId) {
      return false;
    }

    if (!interfaceConfig.admin_message_id && !allowCreate) {
      return false;
    }

    const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return false;

    const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      sysLog('Admin Hub Channel Inaccessible', { guild: guildId, channel: channelId });
      return false;
    }

    const bannerBuffer = await generateAdminInterfaceBanner(interfaceConfig.admin_shortcut_order, {
      slotColors: interfaceConfig.admin_slot_colors,
      guildId
    });
    const attachment = new AttachmentBuilder(bannerBuffer, { name: 'admin_interface.png' });
    const embed = buildAdminHubEmbed();
    let lootBoxEmoji = '🎁';
    try {
      const { getLootBoxCategoryEmoji } = await import('../economy/lootbox.js');
      lootBoxEmoji = await getLootBoxCategoryEmoji(guildId);
    } catch {}
    const buttonRows = buildAdminHubButtons(guildId, guild, interfaceConfig.admin_shortcut_order, interfaceConfig.admin_slot_button_colors, { lootBoxEmoji });
    const payload = {
      embeds: [embed],
      components: buttonRows,
      files: [attachment]
    };

    const oldMsgId = interfaceConfig.admin_message_id;
    if (oldMsgId) {
      const oldMessage = await channel.messages.fetch(oldMsgId).catch(() => null);
      if (oldMessage) {
        await oldMessage.edit(payload).catch(() => null);
        sysLog('Admin Hub Message Updated In-Place', { guild: guildId, channel: channelId, messageId: oldMsgId });
        return true;
      }
    }

    if (!allowCreate) {
      return false;
    }

    try {
      const recentMessages = await channel.messages.fetch({ limit: 25 }).catch(() => null);
      if (recentMessages) {
        for (const msg of recentMessages.values()) {
          if (msg.author.id === client.user.id) {
            const hasAdminHubButtons = msg.components?.some(row =>
              row.components?.some(btn => btn.customId?.startsWith('admin_hub_'))
            );
            if (hasAdminHubButtons) {
              await msg.delete().catch(() => {});
            }
          }
        }
      }
    } catch {
      // Non-blocking cleanup
    }

    const newMessage = await channel.send(payload).catch((err) => {
      sysError('Admin Hub Message Send Failed', err, { guild: guildId, channel: channelId });
      return null;
    });

    if (newMessage) {
      interfaceConfig.admin_message_id = newMessage.id;
      await saveInterfaceConfig(guildId, interfaceConfig);
      sysLog('Admin Hub Message Freshly Published', { guild: guildId, channel: channelId, messageId: newMessage.id });
      return true;
    }

    return false;
  } catch (error) {
    sysError('Admin Hub Publish/Update Error', error, { guild: guildId });
    return false;
  } finally {
    adminHubUpdateLocks.delete(guildId);
  }
}

/**
 * Handle Admin Hub shortcut buttons clicked by staff in the Admin Interface message
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
export async function handleAdminHubComponent(interaction) {
  const customId = interaction.customId;

  // 1. Strict security check: User MUST be server owner, Discord admin, or on server_admins whitelist
  const { verifyAdminAccess, verifyAdminManagerAccess } = await import('../storage/admins.js');
  if (!(await verifyAdminAccess(interaction))) return;

  // 2. Customize modal must be opened without deferring
  if (customId === 'admin_hub_customize') {
    const { showCustomizeModal } = await import('./settings.js');
    return showCustomizeModal(interaction, 'admin_hub');
  }

  // 3. Admins shortcut: ONLY server owner and Discord Administrators can manage admins!
  if (customId === 'admin_hub_admins') {
    if (!(await verifyAdminManagerAccess(interaction))) return;
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    const { showAdminManagement } = await import('./admin-users.js');
    return showAdminManagement(interaction, true);
  }

  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  switch (customId) {
    case 'admin_hub_colors': {
      const { showColorPanel } = await import('./colors.js');
      return showColorPanel(interaction, 'normal');
    }
    case 'admin_hub_pass': {
      const { handlePassSetup } = await import('./settings/pass.js');
      return handlePassSetup(interaction);
    }
    case 'admin_hub_coins': {
      const { showCoinsSubMenu } = await import('./settings.js');
      return showCoinsSubMenu(interaction);
    }
    case 'admin_hub_shop': {
      const { handleShopSetup } = await import('./shop-setup.js');
      return handleShopSetup(interaction);
    }
    case 'admin_hub_post': {
      const { handleShopPostGate } = await import('./shop-setup.js');
      return handleShopPostGate(interaction);
    }
    case 'admin_hub_chests':
    case 'admin_hub_lootboxes': {
      const { handleLootBoxesPage } = await import('./shop-setup.js');
      return handleLootBoxesPage(interaction);
    }
    case 'admin_hub_moderate':
    case 'admin_hub_users': {
      const { showUserSelector } = await import('./admin-users.js');
      return showUserSelector(interaction);
    }
    case 'admin_hub_anticheat': {
      const { showAntiCheatHub } = await import('./admin-users.js');
      return showAntiCheatHub(interaction, true);
    }
    case 'admin_hub_automod':
    case 'admin_hub_organize': {
      const { showOrganizeMenu } = await import('./settings/organize.js');
      return showOrganizeMenu(interaction);
    }
    case 'admin_hub_roles': {
      const { showRolesMenu } = await import('./settings/role-rewards.js');
      return showRolesMenu(interaction);
    }
    case 'admin_hub_leaderboards': {
      const { handleLeaderboardSettings } = await import('./settings/leaderboards.js');
      return handleLeaderboardSettings(interaction);
    }
    case 'admin_hub_embed': {
      const { renderRootEmbedMenu } = await import('./settings/embeds.js');
      return renderRootEmbedMenu(interaction);
    }
    case 'admin_hub_logs': {
      const { handleLogsSettings } = await import('./settings/logs.js');
      return handleLogsSettings(interaction);
    }
    case 'admin_hub_economy': {
      const { handleEconomySettings } = await import('./settings/economy.js');
      return handleEconomySettings(interaction);
    }
    case 'admin_hub_dashboard': {
      return showAdminInterfaceSettings(interaction);
    }
    case 'admin_hub_shortcuts': {
      return showInterfaceSettings(interaction);
    }
    default:
      return;
  }
}

/**
 * Render the top-level Interface Selection Hub: [Users] [Admins]
 * @param {import('discord.js').Interaction} interaction
 */
export async function showInterfaceMainMenu(interaction) {
  const embed = new EmbedBuilder()
    .setTitle('Interface Selection')
    .setDescription('Select an interface type to configure.')
    .setColor(0x5865F2);

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('interface_menu_users')
      .setLabel('Shortcuts')
      .setEmoji('⚡')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('interface_menu_admins')
      .setLabel('Settings')
      .setEmoji('⚙️')
      .setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('settings_home')
      .setLabel('Back')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(isBackDisabled(interaction))
  );

  const responseMethod = (interaction.deferred || interaction.replied)
    ? 'editReply'
    : (interaction.isButton() || interaction.isAnySelectMenu() ? 'update' : 'editReply');

  await interaction[responseMethod]({
    content: '',
    embeds: [embed],
    components: [row1, row2],
    files: [],
    attachments: []
  });
}

/**
 * Render the User Interface Configuration Panel
 * Layout:
 * - Row 0: Target Channel Selector (Placeholder: "Select target channel for user's interface...")
 * - Row 1: [ Enable / Disable ] | [ Update ]
 * - Row 2: [ Back ] | [ Setup ]
 * @param {import('discord.js').Interaction} interaction 
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
    'Configure the public Community Shortcuts message with active quests, countdown timers, and quick shortcuts.\n',
    `• **Target Channel:** ${currentChannel}`,
    `• **Status:** ${statusText}`
  ].join('\n');

  const embed = new EmbedBuilder()
    .setTitle('Shortcuts')
    .setDescription(desc)
    .setColor(0x5865F2);

  // Row 0: Channel Selector
  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId('interface_set_channel')
    .setPlaceholder("Select target channel for shortcuts...")
    .setChannelTypes(ChannelType.GuildText);

  if (config.target_channel_id) {
    channelSelect.setDefaultChannels([config.target_channel_id]);
  }

  // Row 1: [ Back ] | [ Enable / Disable ] | [ Setup ] (single button row)
  const backBtn = new ButtonBuilder()
    .setCustomId('settings_home')
    .setLabel('Back')
    .setEmoji('⬅️')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(isBackDisabled(interaction));

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

  const setupBtn = new ButtonBuilder()
    .setCustomId('interface_setup_btn')
    .setLabel('Setup')
    .setEmoji('🛠️')
    .setStyle(ButtonStyle.Secondary);

  const buttonRow = new ActionRowBuilder().addComponents(backBtn, toggleBtn, setupBtn);

  const components = [
    new ActionRowBuilder().addComponents(channelSelect),
    buttonRow
  ];

  const method = (interaction.deferred || interaction.replied)
    ? 'editReply'
    : (interaction.isButton() || interaction.isAnySelectMenu() ? 'update' : 'editReply');

  try {
    await interaction[method]({ embeds: [embed], components, content: '', files: [], attachments: [] });
  } catch (err) {
    if (err?.code === 10008 || err?.message?.includes('Unknown Message')) {
      await interaction.followUp({ embeds: [embed], components, content: '', files: [], attachments: [], flags: MessageFlags.Ephemeral }).catch(() => {});
    } else {
      throw err;
    }
  }
}

/**
 * Render the Admin Interface Configuration Panel
 * Layout:
 * - Row 0: Target Channel Selector (Placeholder: "Select target channel for admins interface...")
 * - Row 1: [ Back ] | [ Update ]
 * @param {import('discord.js').Interaction} interaction
 */
export async function showAdminInterfaceSettings(interaction) {
  const guildId = interaction.guildId;
  const config = await getInterfaceConfig(guildId);

  let isPublished = false;
  if (config.admin_target_channel_id && config.admin_message_id) {
    const channel = interaction.guild?.channels.cache.get(config.admin_target_channel_id) ||
      await interaction.guild?.channels.fetch(config.admin_target_channel_id).catch(() => null);
    if (channel?.isTextBased?.()) {
      const existingMsg = await channel.messages.fetch(config.admin_message_id).catch(() => null);
      if (existingMsg) {
        isPublished = true;
      } else {
        config.admin_message_id = null;
        await saveInterfaceConfig(guildId, config).catch(() => {});
      }
    }
  }

  const currentChannel = config.admin_target_channel_id ? `<#${config.admin_target_channel_id}>` : '*Not Set*';

  let statusText = '`🔴 Disabled`';
  if (config.admin_is_enabled) {
    if (isPublished) {
      statusText = '`🟢 Published & Active`';
    } else if (config.admin_target_channel_id) {
      statusText = '`🟡 Pending Deployment`';
    } else {
      statusText = '`🟡 Pending Setup (Channel Required)`';
    }
  }

  const desc = [
    'Configure the private Admin Dashboard message with direct shortcuts to all Control Panel modules.\n',
    `• **Target Channel:** ${currentChannel}`,
    `• **Status:** ${statusText}`
  ].join('\n');

  const embed = new EmbedBuilder()
    .setTitle('Dashboard')
    .setDescription(desc)
    .setColor(0x5865F2);

  // Row 0: Channel Selector
  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId('admin_interface_set_channel')
    .setPlaceholder("Select target channel for dashboard...")
    .setChannelTypes(ChannelType.GuildText);

  if (config.admin_target_channel_id) {
    channelSelect.setDefaultChannels([config.admin_target_channel_id]);
  }

  // Row 1: [ Back ] | [ Enable / Disable ] | [ Setup ] (single button row)
  const backBtn = new ButtonBuilder()
    .setCustomId('settings_home')
    .setLabel('Back')
    .setEmoji('⬅️')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(isBackDisabled(interaction));

  const toggleBtn = config.admin_is_enabled
    ? new ButtonBuilder()
        .setCustomId('admin_interface_disable_btn')
        .setLabel('Disable')
        .setEmoji('🔴')
        .setStyle(ButtonStyle.Secondary)
    : new ButtonBuilder()
        .setCustomId('admin_interface_enable_btn')
        .setLabel('Enable')
        .setEmoji('🟢')
        .setStyle(ButtonStyle.Secondary);

  const setupBtn = new ButtonBuilder()
    .setCustomId('admin_interface_setup_btn')
    .setLabel('Setup')
    .setEmoji('🛠️')
    .setStyle(ButtonStyle.Secondary);

  const buttonRow = new ActionRowBuilder().addComponents(backBtn, toggleBtn, setupBtn);

  const components = [
    new ActionRowBuilder().addComponents(channelSelect),
    buttonRow
  ];

  const method = (interaction.deferred || interaction.replied)
    ? 'editReply'
    : (interaction.isButton() || interaction.isAnySelectMenu() ? 'update' : 'editReply');

  try {
    await interaction[method]({ embeds: [embed], components, content: '', files: [], attachments: [] });
  } catch (err) {
    if (err?.code === 10008 || err?.message?.includes('Unknown Message')) {
      await interaction.followUp({ embeds: [embed], components, content: '', files: [], attachments: [], flags: MessageFlags.Ephemeral }).catch(() => {});
    } else {
      throw err;
    }
  }
}

/**
 * Render the Admin Dashboard Shortcut Setup Panel
 * Shows dynamic real-time image preview of all 12 slots (4 per row, 3 rows)
 * @param {import('discord.js').Interaction} interaction 
 */
export async function showAdminInterfaceSetup(interaction) {
  const guildId = interaction.guildId;
  const config = await getInterfaceConfig(guildId);
  const slots = normalizeAdminShortcutOrder(config.admin_shortcut_order);
  const slotColors = normalizeSlotColors(config.admin_slot_colors, DEFAULT_ADMIN_SLOT_COLORS);
  const slotButtonColors = normalizeSlotButtonColors(config.admin_slot_button_colors, DEFAULT_ADMIN_SLOT_BUTTON_COLORS);

  // 1. Generate real-time preview of the layout
  const bannerBuffer = await generateAdminInterfaceBanner(slots, { slotColors, guildId });
  const previewName = `admin_preview_${Date.now()}.png`;
  const attachment = new AttachmentBuilder(bannerBuffer, { name: previewName });

  const embed = new EmbedBuilder()
    .setTitle('Dashboard Setup')
    .setDescription('Click any slot button below to assign or clear a module. The preview image updates in real time.')
    .setColor(0x5865F2)
    .setImage(`attachment://${previewName}`);

  // 2. Build 3 rows of 4 slot buttons
  const rows = [];
  for (let r = 0; r < 3; r++) {
    const row = new ActionRowBuilder();
    for (let c = 0; c < 4; c++) {
      const idx = r * 4 + c;
      const slotId = slots[idx];
      const meta = ADMIN_SHORTCUT_REGISTRY[slotId];
      const buttonColorMeta = getButtonColorMeta(slotButtonColors[idx]);

      const button = new ButtonBuilder()
        .setCustomId(`admin_interface_slot_${idx}`)
        .setStyle(meta ? buttonColorMeta.style : ButtonStyle.Secondary);

      if (meta && meta.emoji) {
        if (slotId === 'coins') {
          const coinEmoji = await getCurrencyEmoji(guildId);
          safeSetButtonEmoji(button, coinEmoji, interaction.guild, '🪙');
        } else if (slotId === 'chests' || slotId === 'lootboxes') {
          let lootBoxEmoji = '🎁';
          try {
            const { getLootBoxCategoryEmoji } = await import('../economy/lootbox.js');
            lootBoxEmoji = await getLootBoxCategoryEmoji(guildId);
          } catch {}
          safeSetButtonEmoji(button, lootBoxEmoji, interaction.guild, '🎁');
        } else {
          button.setEmoji(meta.emoji);
        }
      } else {
        button.setLabel('+');
      }

      row.addComponents(button);
    }
    rows.push(row);
  }

  // 3. Navigation, Reset & Update row: [ Back ] | [ Reset ] | [ Update ]
  const isPublished = Boolean(config.admin_target_channel_id && config.admin_message_id);

  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('admin_interface_back_to_main')
      .setLabel('Back')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('admin_interface_reset_defaults')
      .setLabel('Reset')
      .setEmoji('🔃')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('admin_interface_publish_btn')
      .setLabel(isPublished ? 'Update' : 'Publish')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!config.admin_target_channel_id)
  );
  rows.push(navRow);

  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferUpdate().catch(() => {});
  }

  await interaction.editReply({ embeds: [embed], components: rows, files: [attachment] });
}

/**
 * Render Module Assignment picker for a specific Admin Dashboard slot
 * @param {import('discord.js').Interaction} interaction 
 * @param {number} slotIndex 
 */
export async function showAdminInterfaceSlotAssign(interaction, slotIndex) {
  const guildId = interaction.guildId;
  const config = await getInterfaceConfig(guildId);
  const slots = normalizeAdminShortcutOrder(config.admin_shortcut_order);
  const slotColors = normalizeSlotColors(config.admin_slot_colors, DEFAULT_ADMIN_SLOT_COLORS);
  const slotButtonColors = normalizeSlotButtonColors(config.admin_slot_button_colors, DEFAULT_ADMIN_SLOT_BUTTON_COLORS);

  const currentId = slots[slotIndex];
  const currentMeta = ADMIN_SHORTCUT_REGISTRY[currentId];
  const coinName = await getCurrencyName(guildId);
  const coinEmoji = await getCurrencyEmoji(guildId);
  let lootBoxName = 'Chests';
  let lootBoxEmoji = '🎁';
  try {
    const { getLootBoxCategoryName, getLootBoxCategoryEmoji } = await import('../economy/lootbox.js');
    lootBoxName = await getLootBoxCategoryName(guildId);
    lootBoxEmoji = await getLootBoxCategoryEmoji(guildId);
  } catch {}

  const currentLabel = currentMeta ? (
    currentId === 'coins'
      ? `${coinEmoji} ${coinName}`
      : (currentId === 'chests' || currentId === 'lootboxes')
        ? `${lootBoxEmoji} ${lootBoxName}`
        : `${currentMeta.emoji} ${currentMeta.name}`
  ) : 'None';

  const currentColorHex = slotColors[slotIndex] || '#000000';
  const colorMeta = getCardColorMeta(currentColorHex);
  const currentColorLabel = `${colorMeta.emoji} ${colorMeta.name}`;

  const currentBtnColorId = slotButtonColors[slotIndex] || 'secondary';
  const btnColorMeta = getButtonColorMeta(currentBtnColorId);
  const currentBtnColorLabel = `${btnColorMeta.emoji} ${btnColorMeta.name}`;

  const desc = [
    `• **Current Module:** ${currentLabel}`,
    `• **Box Color:** ${currentColorLabel}`,
    `• **Button Color:** ${currentBtnColorLabel}`
  ].join('\n');

  const embed = new EmbedBuilder()
    .setTitle(`Assign Module — Slot ${slotIndex + 1}`)
    .setDescription(desc)
    .setColor(0x5865F2);

  const moduleOptions = [
    ...Object.values(ADMIN_SHORTCUT_REGISTRY).map(item => ({
      label: item.id === 'coins' ? coinName : (item.id === 'chests' ? lootBoxName : item.name),
      value: item.id,
      description: item.description,
      emoji: item.id === 'coins'
        ? parseSelectEmoji(coinEmoji, interaction.guild, '🪙')
        : (item.id === 'chests'
          ? parseSelectEmoji(lootBoxEmoji, interaction.guild, '🎁')
          : parseSelectEmoji(item.emoji, interaction.guild, '⭐')),
      default: item.id === currentId || (item.id === 'chests' && currentId === 'lootboxes')
    })),
    {
      label: 'None',
      value: 'empty',
      description: 'Leave this slot empty',
      emoji: '🚫',
      default: !currentMeta || currentId === 'empty'
    }
  ];

  const moduleSelect = new StringSelectMenuBuilder()
    .setCustomId(`admin_interface_set_feature_${slotIndex}`)
    .setPlaceholder(`Choose a module for Slot ${slotIndex + 1}...`)
    .addOptions(moduleOptions);

  const colorOptions = INTERFACE_CARD_COLORS.map(c => ({
    label: c.name,
    value: c.hex,
    description: c.description,
    emoji: c.emoji,
    default: currentColorHex.toLowerCase() === c.hex.toLowerCase() ||
             (c.id === 'black' && (!currentColorHex || currentColorHex === '#000000'))
  }));

  const colorSelect = new StringSelectMenuBuilder()
    .setCustomId(`admin_interface_set_color_${slotIndex}`)
    .setPlaceholder(`Choose a box color for Slot ${slotIndex + 1}...`)
    .addOptions(colorOptions);

  const buttonColorOptions = DISCORD_BUTTON_COLORS.map(c => ({
    label: c.name,
    value: c.id,
    description: c.description,
    emoji: c.emoji,
    default: currentBtnColorId === c.id
  }));

  const buttonColorSelect = new StringSelectMenuBuilder()
    .setCustomId(`admin_interface_set_btn_color_${slotIndex}`)
    .setPlaceholder(`Choose a button color for Slot ${slotIndex + 1}...`)
    .addOptions(buttonColorOptions);

  const backRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('admin_interface_setup_btn')
      .setLabel('Back')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary)
  );

  const components = [
    new ActionRowBuilder().addComponents(moduleSelect),
    new ActionRowBuilder().addComponents(colorSelect),
    new ActionRowBuilder().addComponents(buttonColorSelect),
    backRow
  ];

  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferUpdate().catch(() => {});
  }

  await interaction.editReply({ embeds: [embed], components, files: [], attachments: [] });
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
  const slotButtonColors = normalizeSlotButtonColors(config.slot_button_colors);

  // 1. Generate real-time preview of the layout
  const bannerBuffer = await generateInterfaceBanner(slots, { slotColors });
  const previewName = `preview_${Date.now()}.png`;
  const attachment = new AttachmentBuilder(bannerBuffer, { name: previewName });

  const embed = new EmbedBuilder()
    .setTitle('Shortcuts Setup')
    .setDescription('Click any slot button below to assign or clear a feature. The preview image updates in real time.')
    .setColor(0x5865F2)
    .setImage(`attachment://${previewName}`);

  // 2. Build 3 rows of 4 slot buttons
  const rows = [];
  for (let r = 0; r < 3; r++) {
    const row = new ActionRowBuilder();
    for (let c = 0; c < 4; c++) {
      const idx = r * 4 + c;
      const slotId = slots[idx];
      const meta = getShortcutMeta(slotId);
      const buttonColorMeta = getButtonColorMeta(slotButtonColors[idx]);

      const button = new ButtonBuilder()
        .setCustomId(`interface_slot_${idx}`)
        .setStyle(meta ? buttonColorMeta.style : ButtonStyle.Secondary);

      if (meta && meta.emoji) {
        button.setEmoji(meta.emoji);
      } else {
        button.setLabel('+');
      }

      row.addComponents(button);
    }
    rows.push(row);
  }

  // 3. Navigation, Reset & Update row: [ Back ] | [ Reset ] | [ Update ]
  const isPublished = Boolean(config.target_channel_id && config.message_id);

  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('interface_back_to_main')
      .setLabel('Back')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('interface_reset_defaults')
      .setLabel('Reset')
      .setEmoji('🔃')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('interface_publish_btn')
      .setLabel(isPublished ? 'Update' : 'Publish')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!config.target_channel_id)
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
  const slotButtonColors = normalizeSlotButtonColors(config.slot_button_colors);

  const currentId = slots[slotIndex];
  const currentMeta = getShortcutMeta(currentId);
  const currentLabel = currentMeta ? `${currentMeta.emoji} ${currentMeta.name}` : 'None';

  const currentColorHex = slotColors[slotIndex] || '#000000';
  const colorMeta = getCardColorMeta(currentColorHex);
  const currentColorLabel = `${colorMeta.emoji} ${colorMeta.name}`;

  const currentBtnColorId = slotButtonColors[slotIndex] || 'secondary';
  const btnColorMeta = getButtonColorMeta(currentBtnColorId);
  const currentBtnColorLabel = `${btnColorMeta.emoji} ${btnColorMeta.name}`;

  const desc = [
    `• **Current Feature:** ${currentLabel}`,
    `• **Box Color:** ${currentColorLabel}`,
    `• **Button Color:** ${currentBtnColorLabel}`
  ].join('\n');

  const embed = new EmbedBuilder()
    .setTitle(`Assign Feature — Slot ${slotIndex + 1}`)
    .setDescription(desc)
    .setColor(0x5865F2);

  const coinName = await getCurrencyName(interaction.guildId);
  const featureOptions = [
    ...Object.values(SHORTCUT_REGISTRY).map(item => ({
      label: item.name,
      value: item.id,
      description: item.id === 'daily' ? `Claim daily ${coinName.toLowerCase()} and streak bonuses` : item.description,
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

  const buttonColorOptions = DISCORD_BUTTON_COLORS.map(c => ({
    label: c.name,
    value: c.id,
    description: c.description,
    emoji: c.emoji,
    default: currentBtnColorId === c.id
  }));

  const buttonColorSelect = new StringSelectMenuBuilder()
    .setCustomId(`interface_set_btn_color_${slotIndex}`)
    .setPlaceholder(`Choose a button color for Slot ${slotIndex + 1}...`)
    .addOptions(buttonColorOptions);

  const row1 = new ActionRowBuilder().addComponents(featureSelect);
  const row2 = new ActionRowBuilder().addComponents(colorSelect);
  const row3 = new ActionRowBuilder().addComponents(buttonColorSelect);
  const row4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('interface_setup_btn')
      .setLabel('Back')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary)
  );

  const components = [row1, row2, row3, row4];

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

  const { verifyAdminAccess } = await import('../storage/admins.js');
  if (!(await verifyAdminAccess(interaction))) return;

  try {
    // 0. Interface Landing Navigation
    if (customId === 'interface_home') {
      return showInterfaceMainMenu(interaction);
    }
    if (customId === 'interface_menu_users' || customId === 'interface_menu_shortcuts') {
      return showInterfaceSettings(interaction);
    }
    if (customId === 'interface_menu_admins' || customId === 'interface_menu_settings') {
      return showAdminInterfaceSettings(interaction);
    }

    // Admin Interface Handlers
    if (customId === 'admin_interface_setup_btn') {
      return showAdminInterfaceSetup(interaction);
    }

    if (customId === 'admin_interface_back_to_main') {
      return showAdminInterfaceSettings(interaction);
    }

    if (customId.startsWith('admin_interface_slot_')) {
      const slotIndex = parseInt(customId.replace('admin_interface_slot_', ''), 10);
      return showAdminInterfaceSlotAssign(interaction, slotIndex);
    }

    if (customId.startsWith('admin_interface_set_feature_')) {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
      const slotIndex = parseInt(customId.replace('admin_interface_set_feature_', ''), 10);
      const selectedFeature = interaction.values[0];

      const config = await getInterfaceConfig(guildId);
      const slots = normalizeAdminShortcutOrder(config.admin_shortcut_order);
      slots[slotIndex] = selectedFeature === 'empty' ? 'empty' : selectedFeature;
      config.admin_shortcut_order = slots;
      await saveInterfaceConfig(guildId, config);

      return showAdminInterfaceSlotAssign(interaction, slotIndex);
    }

    if (customId.startsWith('admin_interface_set_color_')) {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
      const slotIndex = parseInt(customId.replace('admin_interface_set_color_', ''), 10);
      const selectedColor = interaction.values[0];

      const config = await getInterfaceConfig(guildId);
      const slotColors = normalizeSlotColors(config.admin_slot_colors, DEFAULT_ADMIN_SLOT_COLORS);
      slotColors[slotIndex] = selectedColor;
      config.admin_slot_colors = slotColors;
      await saveInterfaceConfig(guildId, config);

      return showAdminInterfaceSlotAssign(interaction, slotIndex);
    }

    if (customId.startsWith('admin_interface_set_btn_color_')) {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
      const slotIndex = parseInt(customId.replace('admin_interface_set_btn_color_', ''), 10);
      const selectedBtnColor = interaction.values[0];

      const config = await getInterfaceConfig(guildId);
      const slotButtonColors = normalizeSlotButtonColors(config.admin_slot_button_colors, DEFAULT_ADMIN_SLOT_BUTTON_COLORS);
      slotButtonColors[slotIndex] = selectedBtnColor;
      config.admin_slot_button_colors = slotButtonColors;
      await saveInterfaceConfig(guildId, config);

      return showAdminInterfaceSlotAssign(interaction, slotIndex);
    }

    if (customId === 'admin_interface_reset_defaults') {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
      const config = await getInterfaceConfig(guildId);
      config.admin_shortcut_order = [...DEFAULT_ADMIN_SHORTCUT_ORDER];
      config.admin_slot_colors = [...DEFAULT_ADMIN_SLOT_COLORS];
      config.admin_slot_button_colors = [...DEFAULT_ADMIN_SLOT_BUTTON_COLORS];
      await saveInterfaceConfig(guildId, config);

      return showAdminInterfaceSetup(interaction);
    }

    if (customId === 'admin_interface_set_channel') {
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
      config.admin_target_channel_id = channelId;
      await saveInterfaceConfig(guildId, config);

      const logName = getUserLogName(interaction);
      sendLog(interaction.guild, 'audit', 'cyan', 'Admin Interface Channel Assigned',
        `**Admin:** \`${logName}\`\n` +
        `**Channel:** <#${channelId}>`
      );

      return showAdminInterfaceSettings(interaction);
    }

    if (customId === 'admin_interface_enable_btn') {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
      const config = await getInterfaceConfig(guildId);
      config.admin_is_enabled = true;
      await saveInterfaceConfig(guildId, config);

      if (config.admin_target_channel_id) {
        await publishOrUpdateAdminHub(interaction.client, guildId, { allowCreate: true }).catch(() => {});
      }

      return showAdminInterfaceSettings(interaction);
    }

    if (customId === 'admin_interface_disable_btn') {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
      const config = await getInterfaceConfig(guildId);
      config.admin_is_enabled = false;

      if (config.admin_target_channel_id && config.admin_message_id) {
        const channel = interaction.guild.channels.cache.get(config.admin_target_channel_id) ||
          await interaction.guild.channels.fetch(config.admin_target_channel_id).catch(() => null);
        if (channel?.isTextBased?.()) {
          const oldMsg = await channel.messages.fetch(config.admin_message_id).catch(() => null);
          if (oldMsg && oldMsg.id !== interaction.message?.id) {
            await oldMsg.delete().catch(() => {});
          }
        }
        config.admin_message_id = null;
      }

      await saveInterfaceConfig(guildId, config);
      return showAdminInterfaceSettings(interaction);
    }

    if (customId === 'admin_interface_publish_btn') {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
      const config = await getInterfaceConfig(guildId);

      if (!config.admin_target_channel_id) {
        return interaction.followUp({
          content: 'Please select a target channel first before publishing or updating the Admin Interface.',
          flags: MessageFlags.Ephemeral
        });
      }

      if (!config.admin_is_enabled) {
        config.admin_is_enabled = true;
        await saveInterfaceConfig(guildId, config);
      }

      const success = await publishOrUpdateAdminHub(interaction.client, guildId, { allowCreate: true });
      const freshConfig = await getInterfaceConfig(guildId);

      if (success) {
        const logName = getUserLogName(interaction);
        sendLog(interaction.guild, 'audit', 'cyan', 'Admin Interface Published/Updated',
          `**Admin:** \`${logName}\`\n` +
          `**Channel:** <#${freshConfig.admin_target_channel_id}>`
        );

        await interaction.followUp({
          content: `Admin Interface published successfully to <#${freshConfig.admin_target_channel_id}>!`,
          flags: MessageFlags.Ephemeral
        });
      } else {
        await interaction.followUp({
          content: 'Failed to publish the Admin Interface. Please verify channel permissions and try again.',
          flags: MessageFlags.Ephemeral
        });
      }

      return showAdminInterfaceSettings(interaction);
    }

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

    // 7. Select Menu: Assign Button Color for Slot Shortcut Button
    if (customId.startsWith('interface_set_btn_color_')) {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
      const slotIndex = parseInt(customId.replace('interface_set_btn_color_', ''), 10);
      const selectedBtnColor = interaction.values[0];

      const config = await getInterfaceConfig(guildId);
      const slotButtonColors = normalizeSlotButtonColors(config.slot_button_colors);
      slotButtonColors[slotIndex] = selectedBtnColor;
      config.slot_button_colors = slotButtonColors;
      await saveInterfaceConfig(guildId, config);

      return showInterfaceSlotAssign(interaction, slotIndex);
    }

    // 8. Reset Defaults
    if (customId === 'interface_reset_defaults') {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
      const config = await getInterfaceConfig(guildId);
      config.shortcut_order = [...DEFAULT_SHORTCUT_ORDER];
      config.slot_colors = [...DEFAULT_SLOT_COLORS];
      config.slot_button_colors = [...DEFAULT_SLOT_BUTTON_COLORS];
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
          if (oldMsg && oldMsg.id !== interaction.message?.id) {
            await oldMsg.delete().catch(() => {});
          }
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
      const { executeDailyClaim } = await import('./daily.js');
      return executeDailyClaim(interaction);
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

    // 8. Items Shortcut (📦)
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
