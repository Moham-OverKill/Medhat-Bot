import { getAllActiveMvps } from '../storage/activeMvps.js';
import { sysLog, sysError } from '../utils/logger.js';

/**
 * In-memory MVP cache.
 * Key: guildId (string)
 * Value: Set<userId> (string)
 *
 * This is the single source of truth for "who is MVP right now."
 * It is seeded from the `active_mvps` database table on startup,
 * and updated atomically by the King of the Hill hourly cycle.
 */
const mvpCache = new Map();

/**
 * Set (overwrite) the active MVP list for a guild.
 * Called after every hourly KotH cycle updates the state.
 * @param {string} guildId
 * @param {string[]} userIds
 */
export function setMvpCache(guildId, userIds) {
  mvpCache.set(guildId, new Set(userIds));
}

/**
 * Get the Set of active MVP user IDs for a guild.
 * @param {string} guildId
 * @returns {Set<string>}
 */
export function getMvpCache(guildId) {
  return mvpCache.get(guildId) || new Set();
}

/**
 * Check if a specific user is currently an active MVP. O(1) lookup.
 * Used by the shop prerequisite check.
 * @param {string} guildId
 * @param {string} userId
 * @returns {boolean}
 */
export function isUserMvp(guildId, userId) {
  const guildMvps = mvpCache.get(guildId);
  if (!guildMvps) return false;
  return guildMvps.has(userId);
}

/**
 * Seed the in-memory cache from the database on bot startup.
 * This ensures the bot remembers current MVP state after a reboot.
 * Call this AFTER the database has been initialized.
 */
export async function seedMvpCacheFromDb() {
  try {
    const allActiveMvps = await getAllActiveMvps();

    for (const row of allActiveMvps) {
      const existing = mvpCache.get(row.guild_id) || new Set();
      existing.add(row.user_id);
      mvpCache.set(row.guild_id, existing);
    }

    const guildCount = mvpCache.size;
    const totalCount = allActiveMvps.length;
    sysLog('MVP Cache Seeded', { detail: `${totalCount} active MVP(s) across ${guildCount} guild(s)` });
  } catch (error) {
    sysError('MVP Cache Seed Failed', error);
  }
}
