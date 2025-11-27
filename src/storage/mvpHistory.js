import { query } from './postgres.js';
import { sanitizeError } from '../shared.js';

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
    console.error('Failed to save MVP award record:', sanitizeError(error));
  }
}

export async function getRecentAwards(guildId = null, limit = 25) {
  try {
    let queryText = 'SELECT * FROM mvp_awards';
    const params = [];
    
    if (guildId) {
      queryText += ' WHERE guild_id = $1';
      params.push(guildId);
    }
    
    queryText += ' ORDER BY awarded_at DESC';
    
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
    console.error('Failed to get recent awards:', sanitizeError(error));
    return [];
  }
}
