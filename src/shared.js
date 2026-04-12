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
    return `@${user.username}`;
}

/**
 * Helper: Sort inventory items by Discord role position (highest first)
 * Falls back to name sort for non-role items
 */
export async function sortItemsByRolePosition(items, guild) {
  if (!guild || !items) return items || [];
  
  // Fetch all roles from cache
  const roleCache = guild.roles.cache;

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

  return `${statusEmoji} ${nameDisplay}`;
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

// Custom Emoji Constants
export const COIN_EMOJI = '<:OK_COIN:1490666813501997076>';

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
