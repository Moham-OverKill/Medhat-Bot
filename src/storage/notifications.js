import { getPool } from './postgres.js';
import { sysError } from '../utils/logger.js';

export const NOTIFICATION_KEYS = {
  LEVEL_UP: 'notif_level_up',
  DAILY_CLAIM: 'notif_daily_claim',
  TRADES: 'notif_trades',
  MVP_WIN: 'notif_mvp_win',
  QUESTS_REFRESH: 'notif_quests_refresh'
};

const DEFAULT_SETTINGS = {
  notif_level_up: false,
  notif_daily_claim: false,
  notif_trades: false,
  notif_mvp_win: false,
  notif_quests_refresh: false
};

/**
 * Fetch notification preferences for a user in a specific guild
 * @param {string} guildId
 * @param {string} userId
 * @returns {Promise<Object>}
 */
export async function getUserNotificationSettings(guildId, userId) {
  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT notif_level_up, notif_daily_claim, notif_trades, notif_mvp_win, notif_quests_refresh
       FROM user_notification_settings
       WHERE guild_id = $1 AND user_id = $2`,
      [guildId, userId]
    );

    if (result.rows.length === 0) {
      return { ...DEFAULT_SETTINGS };
    }

    const row = result.rows[0];
    return {
      notif_level_up: Boolean(row.notif_level_up),
      notif_daily_claim: Boolean(row.notif_daily_claim),
      notif_trades: Boolean(row.notif_trades),
      notif_mvp_win: Boolean(row.notif_mvp_win),
      notif_quests_refresh: Boolean(row.notif_quests_refresh)
    };
  } catch (error) {
    sysError('Get Notification Settings Failed', error, { guild: guildId, user: userId });
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Toggle a specific notification setting for a user in a guild
 * @param {string} guildId
 * @param {string} userId
 * @param {string} key
 * @returns {Promise<Object>} Updated settings
 */
export async function toggleUserNotificationSetting(guildId, userId, key) {
  if (!Object.values(NOTIFICATION_KEYS).includes(key)) {
    throw new Error(`Invalid notification key: ${key}`);
  }

  try {
    const pool = getPool();
    const result = await pool.query(
      `INSERT INTO user_notification_settings (guild_id, user_id, ${key}, updated_at)
       VALUES ($1, $2, TRUE, NOW())
       ON CONFLICT (guild_id, user_id)
       DO UPDATE SET ${key} = NOT user_notification_settings.${key}, updated_at = NOW()
       RETURNING notif_level_up, notif_daily_claim, notif_trades, notif_mvp_win, notif_quests_refresh`,
      [guildId, userId]
    );

    const row = result.rows[0];
    return {
      notif_level_up: Boolean(row.notif_level_up),
      notif_daily_claim: Boolean(row.notif_daily_claim),
      notif_trades: Boolean(row.notif_trades),
      notif_mvp_win: Boolean(row.notif_mvp_win),
      notif_quests_refresh: Boolean(row.notif_quests_refresh)
    };
  } catch (error) {
    sysError('Toggle Notification Setting Failed', error, { guild: guildId, user: userId, key });
    return await getUserNotificationSettings(guildId, userId);
  }
}

/**
 * Retrieve user IDs who have enabled a specific notification in a guild
 * @param {string} guildId
 * @param {string} key
 * @returns {Promise<string[]>}
 */
export async function getUsersForNotification(guildId, key) {
  if (!Object.values(NOTIFICATION_KEYS).includes(key)) {
    return [];
  }

  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT user_id FROM user_notification_settings WHERE guild_id = $1 AND ${key} = TRUE`,
      [guildId]
    );
    return result.rows.map(r => r.user_id);
  } catch (error) {
    sysError('Fetch Users for Notification Failed', error, { guild: guildId, key });
    return [];
  }
}

/**
 * Retrieve unique user IDs across all guilds who have enabled a specific notification
 * @param {string} key
 * @returns {Promise<string[]>}
 */
export async function getAllUniqueUsersForNotification(key) {
  if (!Object.values(NOTIFICATION_KEYS).includes(key)) {
    return [];
  }

  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT DISTINCT user_id FROM user_notification_settings WHERE ${key} = TRUE`
    );
    return result.rows.map(r => r.user_id);
  } catch (error) {
    sysError('Fetch All Unique Users for Notification Failed', error, { key });
    return [];
  }
}

/**
 * Reset all notification preferences to FALSE when a member leaves a guild.
 * @param {string} guildId
 * @param {string} userId
 */
export async function disableUserNotificationsOnLeave(guildId, userId) {
  if (!guildId || !userId) return;

  try {
    const pool = getPool();
    await pool.query(
      `UPDATE user_notification_settings
       SET notif_level_up = FALSE,
           notif_daily_claim = FALSE,
           notif_trades = FALSE,
           notif_mvp_win = FALSE,
           notif_quests_refresh = FALSE,
           updated_at = NOW()
       WHERE guild_id = $1 AND user_id = $2`,
      [guildId, userId]
    );
    const { sysLog } = await import('../utils/logger.js');
    sysLog('Member Leave Notifications Reset', {
      user: userId,
      guild: guildId,
      detail: 'Disabled all notification preferences for departed member'
    });
  } catch (error) {
    sysError('Disable Notifications On Leave Failed', error, { guild: guildId, user: userId });
  }
}

/**
 * Startup reconciliation: checks all users in a guild with active notification settings
 * and turns them off if the user has left the server while the bot was offline.
 * @param {Guild} guild - The Discord.js Guild object
 */
export async function reconcileGuildNotifications(guild) {
  if (!guild?.id) return;

  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT DISTINCT user_id FROM user_notification_settings
       WHERE guild_id = $1 AND (
         notif_level_up = TRUE OR
         notif_daily_claim = TRUE OR
         notif_trades = TRUE OR
         notif_mvp_win = TRUE OR
         notif_quests_refresh = TRUE
       )`,
      [guild.id]
    );

    if (!result.rows || result.rows.length === 0) return;

    const activeUserIds = result.rows.map(r => r.user_id);
    const departed = [];

    for (const userId of activeUserIds) {
      if (guild.members.cache.has(userId)) continue;
      try {
        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member) {
          departed.push(userId);
        }
      } catch (err) {
        if (err.code === 10007 || err.status === 404) {
          departed.push(userId);
        }
      }
    }

    if (departed.length === 0) return;

    await pool.query(
      `UPDATE user_notification_settings
       SET notif_level_up = FALSE,
           notif_daily_claim = FALSE,
           notif_trades = FALSE,
           notif_mvp_win = FALSE,
           notif_quests_refresh = FALSE,
           updated_at = NOW()
       WHERE guild_id = $1 AND user_id = ANY($2::text[])`,
      [guild.id, departed]
    );

    const { sysLog } = await import('../utils/logger.js');
    sysLog('Startup Notification Reconciliation', {
      guild: guild.id,
      detail: `Disabled notifications for ${departed.length} users who left while offline`
    });
  } catch (error) {
    sysError('Startup Notification Reconciliation Failed', error, { guild: guild.id });
  }
}

