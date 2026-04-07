import { getPool } from '../storage/postgres.js';
import { sendLog } from '../utils/logger.js';
import { sanitizeError, getUserDisplayName, getUserLogName } from '../shared.js';

/**
 * Check if a user is eligible for voice tracking
 * Rules: not muted, not deafened, at least 2 humans in channel
 */
function isVoiceEligible(member) {
  if (!member?.voice?.channel) return false;

  const voice = member.voice;
  if (voice.selfMute || voice.serverMute || voice.selfDeaf || voice.serverDeaf) {
    return false;
  }

  let humanCount = 0;
  for (const [, channelMember] of voice.channel.members) {
    if (!channelMember.user.bot) {
      humanCount++;
      if (humanCount >= 2) return true;
    }
  }

  return false;
}

/**
 * Update voice tracking state for a user
 * Called when voice state changes (join, leave, mute, unmute, etc.)
 */
export async function updateVoiceTracking(guild, member) {
  if (!guild || !member || member.user.bot) return;

  const pool = getPool();
  const guildId = guild.id;
  const userId = member.id;
  const username = getUserDisplayName(member);
  const now = new Date();

  try {
    const eligible = isVoiceEligible(member);

    // Get current tracking state from DB
    const result = await pool.query(
      `SELECT is_voice_tracking, voice_seconds_accumulated, last_voice_check
       FROM user_activity 
       WHERE guild_id = $1 AND user_id = $2`,
      [guildId, userId]
    );

    const current = result.rows[0];
    const wasTracking = current?.is_voice_tracking || false;
    // Use current time if no last check exists (first time)
    const lastCheck = current?.last_voice_check ? new Date(current.last_voice_check) : now;
    const accumulated = current?.voice_seconds_accumulated || 0;

    let newAccumulated = accumulated;

    // 1. Delta Time Accumulation: Calculate elapsed time if we were tracking
    if (wasTracking) {
      const elapsedSeconds = Math.max(0, Math.floor((now - lastCheck) / 1000));
      newAccumulated += elapsedSeconds;
    }

    // 2. Update DB with new state, new accumulated time, and reset timestamp to NOW
    await pool.query(
      `INSERT INTO user_activity (
         guild_id, user_id, username, is_voice_tracking, 
         voice_seconds_accumulated, last_voice_check, last_active
       )
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       ON CONFLICT (guild_id, user_id) 
       DO UPDATE SET 
         is_voice_tracking = $4,
         voice_seconds_accumulated = $5,
         last_voice_check = $6,
         last_active = $6,
         username = $3`,
      [guildId, userId, username, eligible, newAccumulated, now]
    );

    // Log state changes
    if (eligible && !wasTracking) {
      sendLog(guild, 'audit', 'blue', '🎙️ Voice Tracking', 
        `**User:** \`${getUserLogName(member)}\`\n` +
        `**Action:** \`Tracking Resumed\`\n` +
        `**Reason:** Eligible voice state detected.`
      );
    } else if (!eligible && wasTracking) {
      sendLog(guild, 'audit', 'blue', '🎙️ Voice Tracking', 
        `**User:** \`${getUserLogName(member)}\`\n` +
        `**Action:** \`Tracking Paused\`\n` +
        `**Reason:** User muted/left/alone.`
      );
    }

  } catch (error) {
    console.error(`[Voice Tracker] Update failed for ${username}:`, sanitizeError(error));
  }
}

/**
 * Reset timestamps for all tracking users to NOW
 * Called on bot startup to prevent awarding points for offline time
 */
export async function resetVoiceTrackingTimestamps() {
  const pool = getPool();
  try {
    const now = new Date();
    await pool.query(
      `UPDATE user_activity 
       SET last_voice_check = $1, last_active = $1 
       WHERE is_voice_tracking = TRUE`,
      [now]
    );
  } catch (error) {
    console.error('Failed to reset voice tracking timestamps:', sanitizeError(error));
  }
}

/**
 * Voice tracking tick - runs every 60 seconds
 * Awards +1 voice score for each full minute of eligible time
 * NOW INCLUDES REALTIME VALIDATION - verifies user is actually in voice
 */
export async function voiceTrackingTick(client, guildId) {
  const pool = getPool();
  const now = new Date();

  try {
    // Get all users currently being tracked
    const result = await pool.query(
      `SELECT user_id, username, voice_seconds_accumulated, last_voice_check
       FROM user_activity 
       WHERE guild_id = $1 AND is_voice_tracking = TRUE`,
      [guildId]
    );

    if (result.rows.length === 0) return;

    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return;

    for (const row of result.rows) {
      const userId = row.user_id;

      // ========== REALTIME VALIDATION ==========
      let member;
      try {
        member = await guild.members.fetch(userId);
      } catch {
        // Member not in server - stop tracking
        await stopGhostTracking(pool, guildId, userId, guild, 'not in server');
        continue;
      }

      // Check if actually in voice
      const voiceState = member.voice;
      if (!voiceState || !voiceState.channel) {
        await stopGhostTracking(pool, guildId, userId, guild, 'not in voice');
        continue;
      }

      // Check mute/deaf
      if (voiceState.selfMute || voiceState.serverMute || voiceState.selfDeaf || voiceState.serverDeaf) {
        await stopGhostTracking(pool, guildId, userId, guild, 'muted/deafened');
        continue;
      }

      // Check 2+ humans
      const humanCount = voiceState.channel.members.filter(m => !m.user.bot).size;
      if (humanCount < 2) {
        await stopGhostTracking(pool, guildId, userId, guild, 'alone in channel');
        continue;
      }

      // ========== VALIDATION PASSED - AWARD POINTS ==========
      const lastCheck = row.last_voice_check ? new Date(row.last_voice_check) : now;
      const accumulated = row.voice_seconds_accumulated || 0;

      let elapsedSeconds = Math.floor((now - lastCheck) / 1000);

      // Cap elapsed time to avoid bursts
      if (elapsedSeconds > 70) {
        elapsedSeconds = 60;
      }

      const totalSeconds = accumulated + elapsedSeconds;
      const fullMinutes = Math.floor(totalSeconds / 60);
      const remainingSeconds = totalSeconds % 60;

      if (fullMinutes > 0) {
        await pool.query(
          `UPDATE user_activity 
           SET voice_minutes = voice_minutes + $1,
               voice_seconds_accumulated = $2,
               last_voice_check = $3,
               last_active = $3
           WHERE guild_id = $4 AND user_id = $5`,
          [fullMinutes, remainingSeconds, now, guildId, userId]
        );
        // Points awarded in DB; high-frequency Discord logs removed.
      } else {
        await pool.query(
          `UPDATE user_activity 
           SET voice_seconds_accumulated = $1,
               last_voice_check = $2,
               last_active = $2
           WHERE guild_id = $3 AND user_id = $4`,
          [totalSeconds, now, guildId, userId]
        );
      }
    }

  } catch (error) {
    console.error(`Voice tick error:`, sanitizeError(error));
  }
}

/**
 * Helper to stop ghost tracking
 */
async function stopGhostTracking(pool, guildId, userId, guild, reason) {
  try {
    await pool.query(
      `UPDATE user_activity 
       SET is_voice_tracking = FALSE, voice_seconds_accumulated = 0
       WHERE guild_id = $1 AND user_id = $2`,
      [guildId, userId]
    );
    const tag = guild?.name ? `[${guild.name}]` : '[System]';
    console.log(`${tag} Stopped ghost voice tracking for ${userId}: ${reason}`);
  } catch (e) {
    // Ignore
  }
}
