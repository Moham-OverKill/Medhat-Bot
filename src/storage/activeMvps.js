import { query, getPool } from './postgres.js';
import { sysLog, sysError } from '../utils/logger.js';

/**
 * Get all currently active MVPs for a guild, ordered by rank.
 * @param {string} guildId
 * @returns {Promise<Array<{userId: string, rank: number, since: Date}>>}
 */
export async function getActiveMvps(guildId) {
  try {
    const result = await query(
      `SELECT user_id, rank, since FROM active_mvps WHERE guild_id = $1 ORDER BY rank ASC`,
      [guildId]
    );
    return result.rows.map(r => ({
      userId: r.user_id,
      rank: r.rank,
      since: r.since
    }));
  } catch (error) {
    sysError('Active MVPs Fetch Failed', error, { guild: guildId });
    return [];
  }
}

/**
 * Atomically replace the entire active MVP list for a guild.
 * Removes all old entries and inserts the new list in a single transaction.
 * @param {string} guildId
 * @param {Array<{userId: string, rank: number}>} newMvpList
 */
export async function setActiveMvps(guildId, newMvpList) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Delete all existing active MVPs for this guild
    await client.query('DELETE FROM active_mvps WHERE guild_id = $1', [guildId]);

    // Insert the new list
    for (const mvp of newMvpList) {
      await client.query(
        `INSERT INTO active_mvps (guild_id, user_id, rank, since)
         VALUES ($1, $2, $3, NOW())`,
        [guildId, mvp.userId, mvp.rank]
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    sysError('Active MVPs Update Failed', error, { guild: guildId });
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Get all active MVPs across all guilds.
 * Used for seeding the in-memory cache on startup.
 * @returns {Promise<Array<{guild_id: string, user_id: string, rank: number}>>}
 */
export async function getAllActiveMvps() {
  try {
    const result = await query(
      'SELECT guild_id, user_id, rank FROM active_mvps ORDER BY guild_id ASC, rank ASC',
      []
    );
    return result.rows;
  } catch (error) {
    sysError('All Active MVPs Fetch Failed', error);
    return [];
  }
}
