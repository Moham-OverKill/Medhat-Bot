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
