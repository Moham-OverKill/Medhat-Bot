import cron from 'node-cron';
import { EmbedBuilder } from 'discord.js';
import { getPool } from '../storage/postgres.js';
import { sysLog, sysError } from '../utils/logger.js';

let weeklyActivityTableEnsured = false;

/**
 * Self-healing migration to ensure table and all columns exist
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
    `);
    weeklyActivityTableEnsured = true;
  } catch (err) {
    sysError('Ensure Weekly Activity Table Failed', err);
  }
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
  sysLog('Weekly Activity Summary Dispatch Started', { detail: 'Beginning weekly activity DM notifications' });

  try {
    // Flush any pending in-memory activity to database before generating reports
    await flushWeeklyActivityBatch().catch(() => {});
    await ensureWeeklyActivityTable();
    const pool = getPool();

    // Query opted-in users with their full weekly activity
    const queryResult = await pool.query(`
      SELECT uns.guild_id, uns.user_id,
             COALESCE(uwa.messages_count, 0) AS messages_count,
             COALESCE(uwa.voice_minutes, 0) AS voice_minutes,
             COALESCE(uwa.voice_calls_count, 0) AS voice_calls_count,
             COALESCE(uwa.media_count, 0) AS media_count,
             COALESCE(uwa.reactions_count, 0) AS reactions_count,
             COALESCE(uwa.reactions_received_count, 0) AS reactions_received_count,
             COALESCE(uwa.total_xp_gained, 0) AS total_xp_gained
      FROM user_notification_settings uns
      LEFT JOIN user_weekly_activity uwa
        ON uwa.guild_id = uns.guild_id AND uwa.user_id = uns.user_id
      WHERE uns.notif_weekly_summary = TRUE
    `);

    const records = queryResult.rows;
    let dispatchedCount = 0;

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
      const isMember = guild.members.cache.has(record.user_id) ||
        await guild.members.fetch(record.user_id).then(() => true).catch(() => false);
      if (!isMember) continue;

      const user = await client.users.fetch(record.user_id).catch(() => null);
      if (!user) continue;

      const msgCount = Number(record.messages_count || 0).toLocaleString();
      const voiceMins = Number(record.voice_minutes || 0).toLocaleString();
      const mediaFiles = Number(record.media_count || 0).toLocaleString();
      const reactGiven = Number(record.reactions_count || 0).toLocaleString();
      const reactReceived = Number(record.reactions_received_count || 0).toLocaleString();
      const xpGained = Math.round(Number(record.total_xp_gained || 0)).toLocaleString();

      const embed = new EmbedBuilder()
        .setTitle('📊 Weekly Activity Summary')
        .setColor(0x5865F2)
        .setDescription(
          `Activity breakdown for **${guild.name}**:\n\n` +
          `• 💬 Messages Sent: \`${msgCount}\`\n` +
          `• 🎙️ Voice Time: \`${voiceMins} mins\`\n` +
          `• 📎 Media Shared: \`${mediaFiles} files\`\n` +
          `• ⭐ Reactions Given: \`${reactGiven}\`\n` +
          `• ❤️ Reactions Received: \`${reactReceived}\`\n` +
          `• ⚡ Total XP Gained: \`+${xpGained} XP\``
        );

      const sent = await user.send({ embeds: [embed] }).then(() => true).catch(() => false);
      if (sent) dispatchedCount++;

      // Gentle delay between DMs to avoid Discord API rate-limits
      await new Promise(resolve => setTimeout(resolve, 75));
    }

    // Reset weekly activity stats after summary dispatch
    await pool.query('DELETE FROM user_weekly_activity');

    sysLog('Weekly Activity Summary Dispatch Complete', {
      detail: `Successfully sent ${dispatchedCount} DM summaries out of ${records.length} opted-in users. Activity ledger reset.`
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
