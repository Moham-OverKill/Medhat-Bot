import { query } from './postgres.js';
import { sanitizeError } from '../shared.js';
import { sysLog, sysError } from '../utils/logger.js';

export async function appendAwardRecord(record) {
  if (!record || typeof record !== 'object') return;

  try {
    await query(
      `INSERT INTO mvp_awards (guild_id, user_id, username, awarded_at, activity_score, rank)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        record.guildId,
        record.userId,
        record.username,
        record.awardedAt || new Date().toISOString(),
        record.activityScore || 0,
        record.rank || 1
      ]
    );

    // Clean up old records, keep only the most recent 200 per guild
    await query(
      `DELETE FROM mvp_awards
       WHERE id IN (
         SELECT id FROM mvp_awards
         WHERE guild_id = $1
         ORDER BY awarded_at DESC
         OFFSET 200
       )`,
      [record.guildId]
    );
  } catch (error) {
    sysError('History Audit Failed', error, { user: record.userId, guild: record.guildId, detail: 'Saving MVP award record' });
  }
}

export async function getRecentAwards(guildId = null, limit = 25) {
  if (!guildId) return [];
  try {
    let queryText = 'SELECT * FROM mvp_awards WHERE guild_id = $1 ORDER BY awarded_at DESC';
    const params = [guildId];

    if (limit && limit > 0) {
      queryText += ` LIMIT $${params.length + 1}`;
      params.push(limit);
    }

    const result = await query(queryText, params);
    return result.rows.map(row => ({
      guildId: row.guild_id,
      userId: row.user_id,
      username: row.username,
      awardedAt: row.awarded_at,
      activityScore: row.activity_score,
      rank: row.rank,
      savedAt: row.saved_at
    }));
  } catch (error) {
    sysError('History Audit Failed', error, { guild: guildId, detail: 'Getting recent awards' });
    return [];
  }
}

/**
 * Get the most recent completed MVP cycle results (top 15)
 * Groups by the latest awarded_at timestamp to get one cycle's results
 */
export async function getLastMvpCycleResults(guildId, limit = 50) {
  try {
    // Get the most recent awarded_at timestamp for this guild
    const latestResult = await query(
      `SELECT awarded_at FROM mvp_awards 
       WHERE guild_id = $1 
       ORDER BY awarded_at DESC 
       LIMIT 1`,
      [guildId]
    );

    if (!latestResult.rows.length) {
      return { results: [], awardedAt: null };
    }

    const latestAwardedAt = latestResult.rows[0].awarded_at;

    // Fetch all winners from that cycle (same awarded_at timestamp)
    // Deterministic sorting for ties using user_id ASC
    const result = await query(
      `SELECT user_id, username, activity_score, rank, awarded_at
       FROM mvp_awards
       WHERE guild_id = $1 AND awarded_at = $2
       ORDER BY rank ASC, user_id ASC
       LIMIT $3`,
      [guildId, latestAwardedAt, limit]
    );

    return {
      awardedAt: latestAwardedAt,
      results: result.rows.map(row => ({
        userId: row.user_id,
        username: row.username,
        score: row.activity_score || 0,
        rank: row.rank
      }))
    };
  } catch (error) {
    sysError('History Audit Failed', error, { guild: guildId, detail: 'Getting last MVP cycle results' });
    return { results: [], awardedAt: null };
  }
}
