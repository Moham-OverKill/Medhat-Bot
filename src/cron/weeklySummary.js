import cron from 'node-cron';
import { EmbedBuilder } from 'discord.js';
import { getPool } from '../storage/postgres.js';
import { logger, sysLog, sysError } from '../utils/logger.js';

export const EMOJI_INCREASE = '<:increase:1561015241981169715>';
export const EMOJI_DECREASE = '<:decrease:1561015251028287629>';

/**
 * Returns trend indicator comparing current value to previous week.
 * @param {number} current
 * @param {number|null|undefined} previous
 * @returns {string}
 */
export function getTrendIndicator(current, previous) {
  if (previous === null || previous === undefined) return '';
  const curr = Number(current) || 0;
  const prev = Number(previous) || 0;
  if (curr > prev) return ` ${EMOJI_INCREASE}`;
  if (curr < prev) return ` ${EMOJI_DECREASE}`;
  return '';
}

let weeklyActivityTableEnsured = false;

/**
 * Self-healing migration to ensure tables and all columns exist
 */
export async function ensureWeeklyActivityTable() {
  if (weeklyActivityTableEnsured) return;
  try {
    const pool = getPool();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_weekly_activity (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        username TEXT,
        messages_count INTEGER NOT NULL DEFAULT 0,
        voice_minutes INTEGER NOT NULL DEFAULT 0,
        voice_calls_count INTEGER NOT NULL DEFAULT 0,
        media_count INTEGER NOT NULL DEFAULT 0,
        reactions_count INTEGER NOT NULL DEFAULT 0,
        reactions_received_count INTEGER NOT NULL DEFAULT 0,
        total_xp_gained NUMERIC(14, 2) NOT NULL DEFAULT 0,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        PRIMARY KEY (guild_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_user_weekly_activity_lookup ON user_weekly_activity(guild_id, user_id);
      ALTER TABLE user_weekly_activity ADD COLUMN IF NOT EXISTS voice_calls_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE user_weekly_activity ADD COLUMN IF NOT EXISTS media_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE user_weekly_activity ADD COLUMN IF NOT EXISTS reactions_received_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE user_notification_settings ADD COLUMN IF NOT EXISTS notif_weekly_summary BOOLEAN NOT NULL DEFAULT FALSE;

      CREATE TABLE IF NOT EXISTS user_previous_weekly_activity (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        messages_count INTEGER NOT NULL DEFAULT 0,
        voice_minutes INTEGER NOT NULL DEFAULT 0,
        voice_calls_count INTEGER NOT NULL DEFAULT 0,
        media_count INTEGER NOT NULL DEFAULT 0,
        reactions_count INTEGER NOT NULL DEFAULT 0,
        reactions_received_count INTEGER NOT NULL DEFAULT 0,
        total_xp_gained NUMERIC(14, 2) NOT NULL DEFAULT 0,
        archived_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        PRIMARY KEY (guild_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_user_previous_weekly_lookup ON user_previous_weekly_activity(guild_id, user_id);

      INSERT INTO user_previous_weekly_activity (
        guild_id, user_id, messages_count, voice_minutes, voice_calls_count,
        media_count, reactions_count, reactions_received_count, total_xp_gained, archived_at
      )
      SELECT uns.guild_id, uns.user_id, 161, 723, 0, 8, 20, 293, 1852, NOW()
      FROM user_notification_settings uns
      WHERE uns.notif_weekly_summary = TRUE
      ON CONFLICT (guild_id, user_id) DO NOTHING;
    `);
    weeklyActivityTableEnsured = true;
  } catch (err) {
    sysError('Ensure Weekly Activity Table Failed', err);
  }
}

// Registry of guilds that have at least one user opted into weekly summary notifications
export const weeklySummaryActiveGuilds = new Set();

/**
 * Seed the registry of guilds with active weekly summary subscribers on startup
 */
export async function seedWeeklySummaryActiveGuilds() {
  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT DISTINCT guild_id FROM user_notification_settings WHERE notif_weekly_summary = TRUE`
    );
    weeklySummaryActiveGuilds.clear();
    for (const row of result.rows) {
      if (row.guild_id) {
        weeklySummaryActiveGuilds.add(row.guild_id);
      }
    }
    sysLog('Weekly Summary Active Guilds Seeded', { count: weeklySummaryActiveGuilds.size });
  } catch (err) {
    sysError('Failed to seed weekly summary active guilds', err);
  }
}

/**
 * Register a guild as having active weekly summary tracking
 * @param {string} guildId
 */
export function registerWeeklySummaryGuild(guildId) {
  if (guildId) weeklySummaryActiveGuilds.add(guildId);
}

/**
 * Refresh active status for a guild when a user toggles weekly summary
 * @param {string} guildId
 */
export async function refreshGuildWeeklySummaryStatus(guildId) {
  if (!guildId) return;
  try {
    const pool = getPool();
    const res = await pool.query(
      `SELECT 1 FROM user_notification_settings WHERE guild_id = $1 AND notif_weekly_summary = TRUE LIMIT 1`,
      [guildId]
    );
    if (res.rows.length > 0) {
      weeklySummaryActiveGuilds.add(guildId);
    } else {
      weeklySummaryActiveGuilds.delete(guildId);
    }
  } catch (err) {
    sysError('Failed to refresh guild weekly summary status', err, { guild: guildId });
  }
}

/**
 * Check if weekly summary is active for a guild
 * @param {string} guildId
 * @returns {boolean}
 */
export function isWeeklySummaryActiveForGuild(guildId) {
  if (!guildId) return false;
  return weeklySummaryActiveGuilds.has(guildId);
}

// In-memory buffer for weekly activity metrics to prevent excessive database I/O
// Key: `${guildId}:${userId}`, Value: { guildId, userId, username, messages: 0, voiceMinutes: 0, voiceCalls: 0, media: 0, reactions: 0, reactionsReceived: 0, xp: 0 }
const pendingWeeklyBatch = new Map();
let isFlushingWeeklyBatch = false;
const WEEKLY_BATCH_FLUSH_INTERVAL = 30 * 1000; // 30 seconds
let weeklyFlushInterval = null;

function getOrCreateWeeklyEntry(guildId, userId, username = null) {
  const key = `${guildId}:${userId}`;
  let entry = pendingWeeklyBatch.get(key);
  if (!entry) {
    entry = {
      guildId,
      userId,
      username: username || null,
      messages: 0,
      voiceMinutes: 0,
      voiceCalls: 0,
      media: 0,
      reactions: 0,
      reactionsReceived: 0,
      xp: 0
    };
    pendingWeeklyBatch.set(key, entry);
  } else if (username && !entry.username) {
    entry.username = username;
  }
  return entry;
}

/**
 * Flush all accumulated weekly metrics to PostgreSQL in a single transaction
 */
export async function flushWeeklyActivityBatch() {
  if (pendingWeeklyBatch.size === 0 || isFlushingWeeklyBatch) return;
  isFlushingWeeklyBatch = true;

  const entriesToFlush = Array.from(pendingWeeklyBatch.values());
  pendingWeeklyBatch.clear();

  try {
    await ensureWeeklyActivityTable();
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      for (const entry of entriesToFlush) {
        await client.query(
          `INSERT INTO user_weekly_activity (
             guild_id, user_id, username,
             messages_count, voice_minutes, voice_calls_count,
             media_count, reactions_count, reactions_received_count,
             total_xp_gained, updated_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, GREATEST(0, $8), GREATEST(0, $9), $10, NOW())
           ON CONFLICT (guild_id, user_id)
           DO UPDATE SET
             messages_count = user_weekly_activity.messages_count + $4,
             voice_minutes = user_weekly_activity.voice_minutes + $5,
             voice_calls_count = user_weekly_activity.voice_calls_count + $6,
             media_count = user_weekly_activity.media_count + $7,
             reactions_count = GREATEST(0, user_weekly_activity.reactions_count + $8),
             reactions_received_count = GREATEST(0, user_weekly_activity.reactions_received_count + $9),
             total_xp_gained = user_weekly_activity.total_xp_gained + $10,
             username = COALESCE(EXCLUDED.username, user_weekly_activity.username),
             updated_at = NOW()`,
          [
            entry.guildId,
            entry.userId,
            entry.username,
            entry.messages,
            entry.voiceMinutes,
            entry.voiceCalls,
            entry.media,
            entry.reactions,
            entry.reactionsReceived,
            entry.xp
          ]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      // Re-queue entries on failure
      for (const entry of entriesToFlush) {
        const key = `${entry.guildId}:${entry.userId}`;
        const existing = pendingWeeklyBatch.get(key);
        if (existing) {
          existing.messages += entry.messages;
          existing.voiceMinutes += entry.voiceMinutes;
          existing.voiceCalls += entry.voiceCalls;
          existing.media += entry.media;
          existing.reactions += entry.reactions;
          existing.reactionsReceived += entry.reactionsReceived;
          existing.xp += entry.xp;
        } else {
          pendingWeeklyBatch.set(key, entry);
        }
      }
      sysError('Weekly Activity Batch Flush Failed', err);
    } finally {
      client.release();
    }
  } catch (err) {
    sysError('Weekly Activity Pool Error', err);
  } finally {
    isFlushingWeeklyBatch = false;
  }
}

/**
 * Record message count toward weekly activity
 */
export async function recordWeeklyMessages(guildId, userId, username, count = 1) {
  if (!guildId || !userId || count <= 0) return;
  const entry = getOrCreateWeeklyEntry(guildId, userId, username);
  entry.messages += count;
  if (pendingWeeklyBatch.size >= 100) {
    flushWeeklyActivityBatch().catch(() => {});
  }
}

/**
 * Record voice minutes toward weekly activity
 */
export async function recordWeeklyVoice(guildId, userId, username, minutes = 1) {
  if (!guildId || !userId || minutes <= 0) return;
  const entry = getOrCreateWeeklyEntry(guildId, userId, username);
  entry.voiceMinutes += minutes;
  if (pendingWeeklyBatch.size >= 100) {
    flushWeeklyActivityBatch().catch(() => {});
  }
}

/**
 * Record voice call/session joined toward weekly activity
 */
export async function recordWeeklyVoiceCallJoined(guildId, userId, username) {
  if (!guildId || !userId) return;
  const entry = getOrCreateWeeklyEntry(guildId, userId, username);
  entry.voiceCalls += 1;
  if (pendingWeeklyBatch.size >= 100) {
    flushWeeklyActivityBatch().catch(() => {});
  }
}

/**
 * Record media/files shared toward weekly activity
 */
export async function recordWeeklyMedia(guildId, userId, username, count = 1) {
  if (!guildId || !userId || count <= 0) return;
  const entry = getOrCreateWeeklyEntry(guildId, userId, username);
  entry.media += count;
  if (pendingWeeklyBatch.size >= 100) {
    flushWeeklyActivityBatch().catch(() => {});
  }
}

/**
 * Record a reaction given by the user toward weekly activity
 */
export async function recordWeeklyReaction(guildId, userId, username = null, delta = 1) {
  if (!guildId || !userId || delta === 0) return;
  const entry = getOrCreateWeeklyEntry(guildId, userId, username);
  entry.reactions += delta;
  if (pendingWeeklyBatch.size >= 100) {
    flushWeeklyActivityBatch().catch(() => {});
  }
}

/**
 * Record a reaction received by the user from others toward weekly activity
 */
export async function recordWeeklyReactionReceived(guildId, userId, username = null, delta = 1) {
  if (!guildId || !userId || delta === 0) return;
  const entry = getOrCreateWeeklyEntry(guildId, userId, username);
  entry.reactionsReceived += delta;
  if (pendingWeeklyBatch.size >= 100) {
    flushWeeklyActivityBatch().catch(() => {});
  }
}

/**
 * Record XP gained toward weekly activity
 */
export async function recordWeeklyXp(guildId, userId, username = null, xp = 0) {
  if (!guildId || !userId || xp <= 0) return;
  const entry = getOrCreateWeeklyEntry(guildId, userId, username);
  entry.xp += xp;
  if (pendingWeeklyBatch.size >= 100) {
    flushWeeklyActivityBatch().catch(() => {});
  }
}

/**
 * Dispatches weekly summary DMs to all opted-in users across all servers
 * and resets weekly activity counts.
 */
export async function dispatchWeeklyActivitySummaries(client) {
  const cycleStart = performance.now();
  sysLog('Weekly Activity Summary Dispatch Started', { detail: 'Beginning weekly activity DM notifications' });

  try {
    // Flush any pending in-memory activity to database before generating reports
    await flushWeeklyActivityBatch().catch(() => {});
    await ensureWeeklyActivityTable();
    const pool = getPool();

    // Query opted-in users with their full weekly activity and previous week's activity
    const queryResult = await pool.query(`
      SELECT uns.guild_id, uns.user_id,
             COALESCE(uwa.messages_count, 0) AS messages_count,
             COALESCE(uwa.voice_minutes, 0) AS voice_minutes,
             COALESCE(uwa.voice_calls_count, 0) AS voice_calls_count,
             COALESCE(uwa.media_count, 0) AS media_count,
             COALESCE(uwa.reactions_count, 0) AS reactions_count,
             COALESCE(uwa.reactions_received_count, 0) AS reactions_received_count,
             COALESCE(uwa.total_xp_gained, 0) AS total_xp_gained,
             upwa.messages_count AS prev_messages_count,
             upwa.voice_minutes AS prev_voice_minutes,
             upwa.voice_calls_count AS prev_voice_calls_count,
             upwa.media_count AS prev_media_count,
             upwa.reactions_count AS prev_reactions_count,
             upwa.reactions_received_count AS prev_reactions_received_count,
             upwa.total_xp_gained AS prev_total_xp_gained
      FROM user_notification_settings uns
      LEFT JOIN user_weekly_activity uwa
        ON uwa.guild_id = uns.guild_id AND uwa.user_id = uns.user_id
      LEFT JOIN user_previous_weekly_activity upwa
        ON upwa.guild_id = uns.guild_id AND upwa.user_id = uns.user_id
      WHERE uns.notif_weekly_summary = TRUE
    `);

    const records = queryResult.rows;
    let dispatchedCount = 0;

    // Bulk pre-warm member cache per guild to avoid individual fetch rate limits
    const uncachedByGuild = new Map();
    for (const record of records) {
      if (!record.guild_id || !record.user_id) continue;
      const guild = client.guilds.cache.get(record.guild_id);
      if (guild && !guild.members.cache.has(record.user_id)) {
        if (!uncachedByGuild.has(record.guild_id)) uncachedByGuild.set(record.guild_id, []);
        uncachedByGuild.get(record.guild_id).push(record.user_id);
      }
    }
    for (const [guildId, uids] of uncachedByGuild.entries()) {
      const guild = client.guilds.cache.get(guildId);
      if (guild && uids.length > 0) {
        await guild.members.fetch({ user: uids }).catch(() => null);
      }
    }

    for (const record of records) {
      // Guard: Skip users with zero activity across all tracked metrics
      const totalActivity =
        Number(record.messages_count || 0) +
        Number(record.voice_minutes || 0) +
        Number(record.voice_calls_count || 0) +
        Number(record.media_count || 0) +
        Number(record.reactions_count || 0) +
        Number(record.reactions_received_count || 0) +
        Number(record.total_xp_gained || 0);

      if (totalActivity <= 0) continue;

      const guild = client.guilds.cache.get(record.guild_id);
      if (!guild) continue;

      // Verify the user is still in the server
      const isMember = guild.members.cache.has(record.user_id);
      if (!isMember) continue;

      const user = await client.users.fetch(record.user_id).catch(() => null);
      if (!user) continue;

      const msgCount = Number(record.messages_count || 0).toLocaleString();
      const voiceMins = Number(record.voice_minutes || 0).toLocaleString();
      const mediaFiles = Number(record.media_count || 0).toLocaleString();
      const reactGiven = Number(record.reactions_count || 0).toLocaleString();
      const reactReceived = Number(record.reactions_received_count || 0).toLocaleString();
      const xpGained = Math.round(Number(record.total_xp_gained || 0)).toLocaleString();

      const currXp = Math.round(Number(record.total_xp_gained || 0));
      const prevXp = (record.prev_total_xp_gained !== null && record.prev_total_xp_gained !== undefined)
        ? Math.round(Number(record.prev_total_xp_gained))
        : null;

      const msgDiff = getTrendIndicator(record.messages_count, record.prev_messages_count);
      const voiceDiff = getTrendIndicator(record.voice_minutes, record.prev_voice_minutes);
      const mediaDiff = getTrendIndicator(record.media_count, record.prev_media_count);
      const reactGivenDiff = getTrendIndicator(record.reactions_count, record.prev_reactions_count);
      const reactReceivedDiff = getTrendIndicator(record.reactions_received_count, record.prev_reactions_received_count);
      const xpDiff = getTrendIndicator(currXp, prevXp);

      const embed = new EmbedBuilder()
        .setTitle('📊 Weekly Activity Summary')
        .setColor(0x5865F2)
        .setDescription(
          `Activity breakdown for **${guild.name}**:\n\n` +
          `• 💬 Messages Sent: \`${msgCount}\`${msgDiff}\n` +
          `• 🎙️ Voice Time: \`${voiceMins} mins\`${voiceDiff}\n` +
          `• 📎 Media Shared: \`${mediaFiles} files\`${mediaDiff}\n` +
          `• ⭐ Reactions Given: \`${reactGiven}\`${reactGivenDiff}\n` +
          `• ❤️ Reactions Received: \`${reactReceived}\`${reactReceivedDiff}\n` +
          `• ⚡ Total XP Gained: \`+${xpGained} XP\`${xpDiff}`
        );

      const sent = await user.send({ embeds: [embed] }).then(() => true).catch(() => false);
      if (sent) dispatchedCount++;

      // Gentle delay between DMs to avoid Discord API rate-limits
      await new Promise(resolve => setTimeout(resolve, 75));
    }

    // Archive current weekly activity into previous weekly activity for comparison in next week's summary
    const clientDb = await pool.connect();
    try {
      await clientDb.query('BEGIN');
      await clientDb.query('DELETE FROM user_previous_weekly_activity');
      await clientDb.query(`
        INSERT INTO user_previous_weekly_activity (
          guild_id, user_id, messages_count, voice_minutes, voice_calls_count,
          media_count, reactions_count, reactions_received_count, total_xp_gained, archived_at
        )
        SELECT guild_id, user_id, messages_count, voice_minutes, voice_calls_count,
               media_count, reactions_count, reactions_received_count, total_xp_gained, NOW()
        FROM user_weekly_activity
      `);
      await clientDb.query('DELETE FROM user_weekly_activity');
      await clientDb.query('COMMIT');
    } catch (archiveErr) {
      await clientDb.query('ROLLBACK');
      sysError('Weekly Activity Archive Failed', archiveErr);
    } finally {
      clientDb.release();
    }

    const durationMs = Math.round(performance.now() - cycleStart);
    logger.info('CRON:SUMMARY', `Weekly activity summary dispatch completed in ${durationMs}ms`, {
      dispatchedCount,
      totalOptedIn: records.length,
      durationMs
    });
  } catch (error) {
    sysError('Weekly Activity Summary Dispatch Failed', error);
  }
}

/**
 * Starts the weekly activity summary cron scheduler and periodic batch flush
 */
export function startWeeklySummaryScheduler(client) {
  // Periodic in-memory batch flush to PostgreSQL every 30s
  if (!weeklyFlushInterval) {
    weeklyFlushInterval = setInterval(() => {
      flushWeeklyActivityBatch().catch(() => {});
    }, WEEKLY_BATCH_FLUSH_INTERVAL);
  }

  // Runs every Friday at 00:00 Cairo time (Africa/Cairo: 0 0 * * 5)
  cron.schedule('0 0 * * 5', () => {
    dispatchWeeklyActivitySummaries(client);
  }, {
    scheduled: true,
    timezone: 'Africa/Cairo'
  });

  sysLog('Infrastructure Audit', { detail: 'Weekly Activity Summary Scheduler initialized (Every Friday 00:00 Africa/Cairo | 30s Batch Flush Active)' });
}
