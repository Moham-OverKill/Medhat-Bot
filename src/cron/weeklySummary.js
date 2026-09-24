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

/**
 * Record message count toward weekly activity
 */
export async function recordWeeklyMessages(guildId, userId, username, count = 1) {
  if (!guildId || !userId || count <= 0) return;
  try {
    await ensureWeeklyActivityTable();
    const pool = getPool();
    await pool.query(
      `INSERT INTO user_weekly_activity (guild_id, user_id, username, messages_count, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (guild_id, user_id)
       DO UPDATE SET
         messages_count = user_weekly_activity.messages_count + $4,
         username = COALESCE(EXCLUDED.username, user_weekly_activity.username),
         updated_at = NOW()`,
      [guildId, userId, username, count]
    );
  } catch (err) {
    sysError('Record Weekly Messages Failed', err, { guild: guildId, user: userId });
  }
}

/**
 * Record voice minutes toward weekly activity
 */
export async function recordWeeklyVoice(guildId, userId, username, minutes = 1) {
  if (!guildId || !userId || minutes <= 0) return;
  try {
    await ensureWeeklyActivityTable();
    const pool = getPool();
    await pool.query(
      `INSERT INTO user_weekly_activity (guild_id, user_id, username, voice_minutes, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (guild_id, user_id)
       DO UPDATE SET
         voice_minutes = user_weekly_activity.voice_minutes + $4,
         username = COALESCE(EXCLUDED.username, user_weekly_activity.username),
         updated_at = NOW()`,
      [guildId, userId, username, minutes]
    );
  } catch (err) {
    sysError('Record Weekly Voice Failed', err, { guild: guildId, user: userId });
  }
}

/**
 * Record voice call/session joined toward weekly activity
 */
export async function recordWeeklyVoiceCallJoined(guildId, userId, username) {
  if (!guildId || !userId) return;
  try {
    await ensureWeeklyActivityTable();
    const pool = getPool();
    await pool.query(
      `INSERT INTO user_weekly_activity (guild_id, user_id, username, voice_calls_count, updated_at)
       VALUES ($1, $2, $3, 1, NOW())
       ON CONFLICT (guild_id, user_id)
       DO UPDATE SET
         voice_calls_count = user_weekly_activity.voice_calls_count + 1,
         username = COALESCE(EXCLUDED.username, user_weekly_activity.username),
         updated_at = NOW()`,
      [guildId, userId, username]
    );
  } catch (err) {
    sysError('Record Weekly Voice Call Joined Failed', err, { guild: guildId, user: userId });
  }
}

/**
 * Record media/files shared toward weekly activity
 */
export async function recordWeeklyMedia(guildId, userId, username, count = 1) {
  if (!guildId || !userId || count <= 0) return;
  try {
    await ensureWeeklyActivityTable();
    const pool = getPool();
    await pool.query(
      `INSERT INTO user_weekly_activity (guild_id, user_id, username, media_count, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (guild_id, user_id)
       DO UPDATE SET
         media_count = user_weekly_activity.media_count + $4,
         username = COALESCE(EXCLUDED.username, user_weekly_activity.username),
         updated_at = NOW()`,
      [guildId, userId, username, count]
    );
  } catch (err) {
    sysError('Record Weekly Media Failed', err, { guild: guildId, user: userId });
  }
}

/**
 * Record a reaction given by the user toward weekly activity
 */
export async function recordWeeklyReaction(guildId, userId, username = null, delta = 1) {
  if (!guildId || !userId) return;
  try {
    await ensureWeeklyActivityTable();
    const pool = getPool();
    if (delta > 0) {
      await pool.query(
        `INSERT INTO user_weekly_activity (guild_id, user_id, username, reactions_count, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (guild_id, user_id)
         DO UPDATE SET
           reactions_count = user_weekly_activity.reactions_count + $4,
           username = COALESCE(EXCLUDED.username, user_weekly_activity.username),
           updated_at = NOW()`,
        [guildId, userId, username, delta]
      );
    } else if (delta < 0) {
      await pool.query(
        `UPDATE user_weekly_activity
         SET reactions_count = GREATEST(0, reactions_count + $3),
             updated_at = NOW()
         WHERE guild_id = $1 AND user_id = $2`,
        [guildId, userId, delta]
      );
    }
  } catch (err) {
    sysError('Record Weekly Reaction Failed', err, { guild: guildId, user: userId });
  }
}

/**
 * Record a reaction received by the user from others toward weekly activity
 */
export async function recordWeeklyReactionReceived(guildId, userId, username = null, delta = 1) {
  if (!guildId || !userId) return;
  try {
    await ensureWeeklyActivityTable();
    const pool = getPool();
    if (delta > 0) {
      await pool.query(
        `INSERT INTO user_weekly_activity (guild_id, user_id, username, reactions_received_count, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (guild_id, user_id)
         DO UPDATE SET
           reactions_received_count = user_weekly_activity.reactions_received_count + $4,
           username = COALESCE(EXCLUDED.username, user_weekly_activity.username),
           updated_at = NOW()`,
        [guildId, userId, username, delta]
      );
    } else if (delta < 0) {
      await pool.query(
        `UPDATE user_weekly_activity
         SET reactions_received_count = GREATEST(0, reactions_received_count + $3),
             updated_at = NOW()
         WHERE guild_id = $1 AND user_id = $2`,
        [guildId, userId, delta]
      );
    }
  } catch (err) {
    sysError('Record Weekly Reaction Received Failed', err, { guild: guildId, user: userId });
  }
}

/**
 * Record XP gained toward weekly activity
 */
export async function recordWeeklyXp(guildId, userId, username = null, xp = 0) {
  if (!guildId || !userId || xp <= 0) return;
  try {
    await ensureWeeklyActivityTable();
    const pool = getPool();
    await pool.query(
      `INSERT INTO user_weekly_activity (guild_id, user_id, username, total_xp_gained, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (guild_id, user_id)
       DO UPDATE SET
         total_xp_gained = user_weekly_activity.total_xp_gained + $4,
         username = COALESCE(EXCLUDED.username, user_weekly_activity.username),
         updated_at = NOW()`,
      [guildId, userId, username, xp]
    );
  } catch (err) {
    sysError('Record Weekly XP Failed', err, { guild: guildId, user: userId });
  }
}

/**
 * Dispatches weekly summary DMs to all opted-in users across all servers
 * and resets weekly activity counts.
 */
export async function dispatchWeeklyActivitySummaries(client) {
  sysLog('Weekly Activity Summary Dispatch Started', { detail: 'Beginning weekly activity DM notifications' });

  try {
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
      const voiceCalls = Number(record.voice_calls_count || 0).toLocaleString();
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
          `• 🎙️ Voice Time: \`${voiceMins} mins\` (${voiceCalls} calls joined)\n` +
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
 * Starts the weekly activity summary cron scheduler
 */
export function startWeeklySummaryScheduler(client) {
  // Runs every Friday at 00:00 Cairo time (Africa/Cairo: 0 0 * * 5)
  cron.schedule('0 0 * * 5', () => {
    dispatchWeeklyActivitySummaries(client);
  }, {
    scheduled: true,
    timezone: 'Africa/Cairo'
  });

  sysLog('Infrastructure Audit', { detail: 'Weekly Activity Summary Scheduler initialized (Every Friday 00:00 Africa/Cairo)' });
}
