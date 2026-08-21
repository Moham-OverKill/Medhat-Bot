// Shared utility helpers for the MVP bot

const SNOWFLAKE_REGEX = /^(\d{17,20})$/;

/**
 * Validates whether a value is a Discord snowflake ID.
 * @param {string} value
 * @returns {boolean}
 */
export function isValidSnowflake(value) {
  if (typeof value !== 'string') return false;
  return SNOWFLAKE_REGEX.test(value.trim());
}

/**
 * Sanitizes an error object so that sensitive data is not logged in production.
 * @param {unknown} error
 * @returns {string}
 */
export function sanitizeError(error) {
  if (!error) return 'Unknown error';

  const message = error instanceof Error
    ? (error.stack || error.message)
    : typeof error === 'string'
      ? error
      : JSON.stringify(error);

  if (process.env.NODE_ENV === 'production') {
    // Only expose the message in production environments.
    return error instanceof Error
      ? (error.message || 'An error occurred')
      : 'An error occurred';
  }

  return message || 'An error occurred';
}

/**
 * Masks a snowflake so only the first few characters are visible in logs.
 * @param {string} snowflake
 * @returns {string}
 */
export function maskSnowflake(snowflake) {
  if (!isValidSnowflake(snowflake)) return '[id]';
  return `${snowflake.substring(0, 4)}…${snowflake.substring(snowflake.length - 2)}`;
}

/**
 * Formats a guild or guild ID for logging (masks in production)
 * @param {Object|string} guildOrId - Guild object or guild ID string
 * @returns {string}
 */
export function formatGuildForLog(guildOrId) {
  const isProduction = process.env.NODE_ENV === 'production';
  
  if (typeof guildOrId === 'string') {
    return isProduction ? `[Guild:${maskSnowflake(guildOrId)}]` : `[Guild:${guildOrId}]`;
  }
  
  if (!guildOrId) return '[unknown guild]';
  
  if (isProduction) {
    return `[Guild:${maskSnowflake(guildOrId.id)}]`;
  }
  
  return `${guildOrId.name} (${guildOrId.id})`;
}

/**
 * Extracts a user-friendly display name from a member or winner object
 * @param {Object} memberOrWinner - Discord member or winner data object
 * @param {string} [fallback] - Optional fallback name
 * @returns {string}
 */
export function getUserDisplayName(memberOrWinner, fallback = null) {
  if (!memberOrWinner) return fallback || 'Unknown user';
  
  // Try Discord member object paths
  if (memberOrWinner.user?.tag) return memberOrWinner.user.tag;
  if (memberOrWinner.user?.username) return memberOrWinner.user.username;
  if (memberOrWinner.displayName) return memberOrWinner.displayName;
  
  // Try winner data object paths
  if (memberOrWinner.tag) return memberOrWinner.tag;
  if (memberOrWinner.username) return memberOrWinner.username;
  
  // Try ID-based fallback
  if (memberOrWinner.userId) return `User${memberOrWinner.userId.slice(-4)}`;
  if (memberOrWinner.id) return `User${memberOrWinner.id.slice(-4)}`;
  
  return fallback || 'Unknown user';
}

/**
 * Extracts a human-readable log name (username only)
 * @param {Object} memberOrUser - Discord member or user object
 * @returns {string}
 */
export function getUserLogName(memberOrUser) {
    if (!memberOrUser) return 'Unknown User';
    const user = memberOrUser.user || memberOrUser;
    if (user.id) return `<@${user.id}>`;
    if (memberOrUser.userId) return `<@${memberOrUser.userId}>`;
    if (typeof memberOrUser === 'string' && /^\d{17,20}$/.test(memberOrUser.trim())) return `<@${memberOrUser.trim()}>`;
    return user.username ? `<@${user.id || user.username}>` : 'Unknown User';
}

/**
 * Safely truncates a string, ensuring surrogate pairs are not split.
 * Useful for Discord limits and preventing "Invalid string length" errors.
 * @param {string} text - The input string
 * @param {number} limit - The maximum allowed length
 * @returns {string} The truncated string
 */
export function safeTruncate(text, limit) {
  if (!text || typeof text !== 'string') return '';
  if (text.length <= limit) return text;
  
  // Use spread operator to safely isolate characters (including surrogate pairs)
  // then join the slice rather than blindly substringing which can slice bytes in half
  const chars = [...text];
  if (chars.length <= limit) return text; // If character count is within limit, array was just multi-byte logic
  
  // Account for ellipsis
  return chars.slice(0, limit - 1).join('') + '…';
}

/**
 * Helper: Sort inventory items by Discord role position (highest first)
 * Falls back to name sort for non-role items
 */
export async function sortItemsByRolePosition(items, guild) {
  if (!guild || !items || items.length === 0) return items || [];
  
  // Fetch fresh role collection from Discord API to guarantee accurate, live positions
  let roleCache = guild.roles?.cache;
  try {
    const fetched = await guild.roles.fetch();
    if (fetched) roleCache = fetched;
  } catch (_) {
    roleCache = guild.roles?.cache;
  }

  if (!roleCache) return items;

  // Map items with their role position
  const itemsWithPosition = items.map(item => {
    let position = -1; // Default for non-role items
    if (item.role_id) {
      // Handle multi-role items (take first role's position)
      const firstRoleId = item.role_id.split(/[,\s]+/)[0];
      const role = roleCache.get(firstRoleId);
      if (role) {
        position = role.position;
      }
    }
    return { ...item, _rolePosition: position };
  });

  // Sort: highest role position first, then by name for non-roles
  itemsWithPosition.sort((a, b) => {
    // Both have roles - sort by position (higher first)
    if (a._rolePosition >= 0 && b._rolePosition >= 0) {
      return b._rolePosition - a._rolePosition;
    }
    // Only one has role - role items first
    if (a._rolePosition >= 0) return -1;
    if (b._rolePosition >= 0) return 1;
    // Neither has role - sort by name
    return (a.name || '').localeCompare(b.name || '');
  });

  // Filter out items with deleted roles (ghost roles)
  return itemsWithPosition.filter(item => {
    if (!item.role_id) return true; // Keep non-role items
    const firstRoleId = item.role_id.split(/[,\s]+/)[0];
    return roleCache.get(firstRoleId) !== undefined; // Only keep if role exists
  });
}

/**
 * Standardized inventory line formatting for both User and Admin views.
 * Ensures perfectly aligned emojis and mentions.
 * @param {Object} item - Synthesized inventory item
 * @returns {string} - Formatted string (e.g. "✅ @Premium")
 */
export function formatInventoryItemLine(item) {
  const firstRoleId = item.role_id ? item.role_id.split(/[,\s]+/)[0] : null;
  const nameDisplay = firstRoleId ? `<@&${firstRoleId}>` : `**${item.name}**`;
  
  const isAdminIdentified = item.source === 'SYNC';
  const isTemp = !!(item.expires_at || 
                  (item.duration_seconds && item.duration_seconds > 0) || 
                  (item.duration_hours && item.duration_hours > 0));
  
  let statusEmoji = '⬜';
  if (isAdminIdentified) {
    statusEmoji = '🛡️';
  } else if (isTemp) {
    statusEmoji = item.is_active ? '🟢' : '⚪';
  } else {
    statusEmoji = item.is_active ? '✅' : '⬜';
  }

  const qty = parseInt(item.quantity) || 1;
  const qtyBadge = !isAdminIdentified ? ` \`x${qty}\`` : '';

  return `${statusEmoji} ${nameDisplay}${qtyBadge}`;
}

/**
 * Parses an ISO timestamp string to milliseconds
 * @param {string} value - ISO timestamp string
 * @returns {number|null} - Milliseconds since epoch, or null if invalid
 */
export function parseIsoTimestamp(value) {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

const ECONOMY_CEILING = 700000000000;

/**
 * Standardized economy amount validation
 * Ensures values are positive integers within BigInt safe range (PostgreSQL BIGINT limit).
 * Enforces a hard ceiling of 700,000,000,000 as per project sanity check rules.
 * @param {any} value - The input to validate
 * @param {boolean} allowZero - Whether $0 is allowed
 * @returns {boolean}
 */
export function isValidEconomyAmount(value, allowZero = false) {
  const num = parseInt(value, 10);
  if (isNaN(num)) return false;
  
  // Enforce project sanity check ceiling (700B)
  if (num > ECONOMY_CEILING) return false;
  
  if (allowZero) return num >= 0;
  return num > 0;
}

import { AsyncLocalStorage } from 'async_hooks';

export const guildContext = new AsyncLocalStorage();

export function runInGuildContext(guildId, callback) {
  if (!guildId) return callback();
  return guildContext.run({ guildId }, callback);
}

let emojiResolver = null;
export function registerEmojiResolver(resolver) {
  emojiResolver = resolver;
}

export const DEFAULT_COIN_EMOJI = '<:OK_COIN:1490666813501997076>';

class DynamicCoinEmoji {
  /**
   * Resolve for the current async guild context (used via template literal / string coercion)
   */
  toString() {
    const store = guildContext.getStore();
    const guildId = store?.guildId;
    if (guildId && emojiResolver) {
      const customEmoji = emojiResolver(guildId);
      if (customEmoji) return customEmoji;
    }
    return DEFAULT_COIN_EMOJI;
  }

  /**
   * Resolve for an explicit guildId (used outside of async context, e.g. in settings/pass.js)
   */
  forGuild(guildId) {
    if (guildId && emojiResolver) {
      const customEmoji = emojiResolver(guildId);
      if (customEmoji) return customEmoji;
    }
    return DEFAULT_COIN_EMOJI;
  }

  [Symbol.toPrimitive](hint) {
    return this.toString();
  }
}

export const COIN_EMOJI = new DynamicCoinEmoji();


/**
 * Strips emojis, markdown, and extra whitespace for clean console logging.
 * @param {string} text - The text to clean
 * @returns {string} cleaned text
 */
export function stripLog(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/<a?:\w+:\d+>/g, '') // Remove Discord custom emojis
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2300}-\u{23FF}]/gu, '') // Remove standard emojis
    .replace(/\*\*/g, '') // Remove bold markdown
    .replace(/`/g, '') // Remove code markdown
    .replace(/\n/g, ' ') // Flatten newlines
    .replace(/\s+/g, ' ') // Collapse multiple spaces
    .trim();
}
/**
 * Standardized sleep helper
 * @param {number} ms
 * @returns {Promise<void>}
 */
export const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Executes a promise with a timeout
 */
export function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    })
  ]);
}

/**
 * Determines if a Discord API error should be retried
 */
export function shouldRetry(error) {
  if (!error) return false;
  const status = error.status ?? error.httpStatus ?? error.code;
  if (status === 429) return true;
  if (typeof status === 'number' && status >= 500) return true;
  const message = String(error.message ?? '').toLowerCase();
  if (message.includes('rate limit')) return true;
  if (message.includes('server error')) return true;
  if (message.includes('timed out') || message.includes('timeout')) return true;
  if (message.includes('ecconn') || message.includes('socket hang up')) return true;
  return false;
}

/**
 * Executes a promise factory with retries and timeout
 */
export async function executeWithRetry(promiseFactory, { label, timeoutMs = 15000, maxAttempts = 2 } = {}) {
  let attempt = 1;
  const backoffBase = 1500;
  
  while (attempt <= maxAttempts) {
    try {
      return await withTimeout(promiseFactory(), timeoutMs, label);
    } catch (error) {
      if (attempt >= maxAttempts || !shouldRetry(error)) {
        throw error;
      }
      // Use dynamic backoff
      await sleep(backoffBase * attempt);
    }
    attempt += 1;
  }
  throw new Error(`${label} failed after ${maxAttempts} attempts`);
}

/**
 * Item Rarity Definitions
 */
export const RARITY_EMOJIS = {
  common: '<:Common:1540250894308868116>',
  uncommon: '<:Uncommon:1540250893017161738>',
  rare: '<:Rare:1540250891419123784>',
  epic: '<:Epic:1540250890143928400>',
  legendary: '<:Legendary:1540250888700952596>'
};

/**
 * Get the rarity emoji for an item
 * @param {Object|string} item - Shop item object or rarity string
 * @returns {string} - Emoji corresponding to the item's rarity
 */
export function getItemRarityEmoji(item) {
  if (!item) return RARITY_EMOJIS.common;
  const rarity = (typeof item === 'string' ? item : (item.rarity || 'common')).toLowerCase();
  return RARITY_EMOJIS[rarity] || RARITY_EMOJIS.common;
}

export const RARITY_DISPLAY = {
  common: '<:Common:1540250894308868116> Common',
  uncommon: '<:Uncommon:1540250893017161738> Uncommon',
  rare: '<:Rare:1540250891419123784> Rare',
  epic: '<:Epic:1540250890143928400> Epic',
  legendary: '<:Legendary:1540250888700952596> Legendary'
};

export const RARITY_COLORS = {
  common: '#95A5A6',
  uncommon: '#2ECC71',
  rare: '#3498DB',
  epic: '#9B59B6',
  legendary: '#F1C40F'
};

/**
 * Resolves an emoji string or ID into a safe format for Discord Buttons and Select Menus.
 * Validates custom emojis against the bot's accessible emoji cache to prevent COMPONENT_INVALID_EMOJI crashes.
 * @param {string|Object} emojiInput
 * @param {Object} [clientOrGuild] - Discord Client or Guild instance
 * @param {string} [fallback] - Safe fallback emoji (default: '🎁')
 * @returns {string|Object|undefined} Safe emoji for components
 */
export function resolveComponentEmoji(emojiInput, clientOrGuild = null, fallback = '🎁') {
  if (!emojiInput) return fallback;
  if (typeof emojiInput === 'object') {
    if (emojiInput.id) {
      const client = clientOrGuild?.client || clientOrGuild;
      const exists = client?.emojis?.cache?.has(emojiInput.id) || clientOrGuild?.emojis?.cache?.has(emojiInput.id);
      if (client && !exists) return fallback;
    }
    return emojiInput;
  }

  const str = String(emojiInput).trim();
  if (!str) return fallback;

  // 1. Formatted Custom Emoji: <:name:id> or <a:name:id>
  const customMatch = str.match(/^<(a)?:([a-zA-Z0-9_]+):(\d{17,20})>?$/);
  if (customMatch) {
    const id = customMatch[3];
    const name = customMatch[2];
    const animated = customMatch[1] === 'a';
    const found = clientOrGuild?.emojis?.cache?.get(id) || clientOrGuild?.client?.emojis?.cache?.get(id);
    if (found) {
      return { id: found.id, name: found.name, animated: Boolean(found.animated) };
    }
    return { id, name, animated };
  }

  // 2. Pure Snowflake ID: 123456789012345678
  if (/^\d{17,20}$/.test(str)) {
    const found = clientOrGuild?.emojis?.cache?.get(str) || clientOrGuild?.client?.emojis?.cache?.get(str);
    if (found) {
      return { id: found.id, name: found.name, animated: Boolean(found.animated) };
    }
    return fallback;
  }

  // 3. Standard Unicode Emoji
  const emojiRegex = /^(\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Emoji}\uFE0F|\u200D|\p{Emoji_Modifier})+$/u;
  if (emojiRegex.test(str)) {
    return str;
  }

  return fallback;
}

/**
 * Safely format an emoji for Discord Select Menu options
 * @param {string|Object} emojiInput
 * @param {Object} [clientOrGuild]
 * @param {string} [fallback]
 * @returns {string|Object|undefined}
 */
export function parseSelectEmoji(emojiInput, clientOrGuild = null, fallback = '🎁') {
  return resolveComponentEmoji(emojiInput, clientOrGuild, fallback);
}

/**
 * Safely set an emoji on a ButtonBuilder without risking interaction crashes.
 * @param {ButtonBuilder} button
 * @param {string|Object} emojiInput
 * @param {Object} [clientOrGuild]
 * @param {string} [fallback]
 * @returns {ButtonBuilder}
 */
export function safeSetButtonEmoji(button, emojiInput, clientOrGuild = null, fallback = null) {
  if (!button || !emojiInput) return button;
  try {
    const resolved = resolveComponentEmoji(emojiInput, clientOrGuild, fallback);
    if (resolved) {
      button.setEmoji(resolved);
    }
  } catch (_) {
    if (fallback) {
      try { button.setEmoji(fallback); } catch (__) {}
    }
  }
  return button;
}
