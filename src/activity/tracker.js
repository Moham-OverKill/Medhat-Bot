import { getPool } from '../storage/postgres.js';
import { sanitizeError } from '../shared.js';

// ============================================
// TEXT CHAT: ANTI-SPAM CONFIGURATION
// ============================================
const MESSAGE_COOLDOWN_MS = 10000; // 10 seconds between valid messages
const MIN_MESSAGE_LENGTH = 5; // Minimum 5 characters
const COMMAND_PREFIXES = ['/', '!', '?', '.', '-', '$', '>']; // Ignore commands

// In-memory cache for cooldowns and last message content
// Key: `${guildId}:${userId}`, Value: { timestamp, lastContent }
const userMessageCache = new Map();
const CACHE_CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour

// Periodic cleanup to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [key, data] of userMessageCache.entries()) {
    if (now - data.timestamp > MESSAGE_COOLDOWN_MS * 10) {
      userMessageCache.delete(key);
    }
  }
}, CACHE_CLEANUP_INTERVAL);

// ============================================
// VOICE CHAT: STOPWATCH CONFIGURATION
// ============================================
const VOICE_POINTS_THRESHOLD_SECONDS = 60; // 1 minute = 1 point
const VOICE_POINTS_REWARD = 1; // Points per threshold
const VOICE_TICK_INTERVAL_MS = 30000; // Check every 30 seconds

/**
 * Guild config cache to reduce disk I/O
 * Key: guildId (string)
 * Value: {config: Object, timestamp: number}
 * TTL: 5 minutes
 */
const configCache = new Map();
const CONFIG_CACHE_TTL = 5 * 60 * 1000;

export async function getCachedGuildConfig(guildId) {
  const cached = configCache.get(guildId);
  const now = Date.now();

  if (cached && now - cached.timestamp < CONFIG_CACHE_TTL) {
    return cached.config;
  }

  // Circular import avoidance: dynamically import config storage
  const { getGuildConfig } = await import('../storage/config.js');
  const config = await getGuildConfig(guildId);
  configCache.set(guildId, { config, timestamp: now });
  return config;
}

export function invalidateConfigCache(guildId) {
  if (guildId) {
    configCache.delete(guildId);
  } else {
    configCache.clear();
  }
}

/**
 * Clear stale voice tracking data on startup
 * Prevents awarding points for time when bot was offline
 * ALSO clears is_voice_tracking to prevent ghost tracking
 */
export async function clearStaleVoiceTracking() {
  const pool = getPool();
  try {
    const result = await pool.query(`
      UPDATE user_activity 
      SET voice_valid_start = NULL,
          voice_seconds_accumulated = 0,
          is_voice_tracking = FALSE
      WHERE voice_valid_start IS NOT NULL OR is_voice_tracking = TRUE
    `);
    if (result.rowCount > 0) {
      console.log(`[System] Cleared stale voice tracking for ${result.rowCount} users`);
    }
  } catch (error) {
    console.error('[System] Failed to clear stale voice tracking:', sanitizeError(error));
  }
}

/**
 * Get guild activity from database
 * Returns a structure compatible with legacy code: { users: Map(...) }
 */
export async function getGuildActivity(guildId) {
  const pool = getPool();
  const users = new Map();

  try {
    const result = await pool.query(
      `SELECT user_id, username, message_count, voice_minutes, last_active 
       FROM user_activity 
       WHERE guild_id = $1`,
      [guildId]
    );

    for (const row of result.rows) {
      users.set(row.user_id, {
        userId: row.user_id,
        username: row.username,
        messages: parseInt(row.message_count || 0, 10),
        voiceMinutes: parseInt(row.voice_minutes || 0, 10),
        lastActive: row.last_active ? new Date(row.last_active) : new Date()
      });
    }
  } catch (error) {
    console.error(`Failed to fetch guild activity for ${guildId}:`, sanitizeError(error));
  }

  return { users };
}

/**
 * Reset guild activity in database (scores only)
 */
export async function resetGuildActivity(guildId) {
  const pool = getPool();
  const now = Date.now();
  try {
    await pool.query(
      `UPDATE user_activity 
       SET message_count = 0, 
           voice_minutes = 0, 
           voice_seconds_accumulated = 0,
           voice_valid_start = CASE 
             WHEN voice_valid_start IS NOT NULL THEN $2::bigint 
             ELSE NULL 
           END
       WHERE guild_id = $1`,
      [guildId, now]
    );
    invalidateConfigCache(guildId);
  } catch (error) {
    console.error(`Failed to reset guild activity for ${guildId}:`, sanitizeError(error));
  }
}

/**
 * Add message point with strict anti-spam checks
 * Rules:
 * 1. 10-second cooldown between valid messages
 * 2. Minimum 5 characters
 * 3. No duplicate content (same as last message)
 * 4. No command prefixes (/, !, ?, etc.)
 * 
 * @param {Object} guild - Discord guild object
 * @param {string} userId - Discord user ID
 * @param {string} username - Discord username
 * @param {string} messageContent - The actual message content
 * @returns {boolean} - Whether point was awarded
 */
export async function addMessagePoint(guild, userId, username, messageContent = '') {
  if (!guild || !userId) return false;
  const guildId = guild.id;
  const now = Date.now();
  const key = `${guildId}:${userId}`;
  const content = (messageContent || '').trim();

  // === ANTI-SPAM CHECKS ===

  // Check 1: Minimum length (5 characters)
  if (content.length < MIN_MESSAGE_LENGTH) {
    return false;
  }

  // Check 2: No command prefixes
  const firstChar = content.charAt(0);
  if (COMMAND_PREFIXES.includes(firstChar)) {
    return false;
  }

  // Check 3: Cooldown (10 seconds)
  const cached = userMessageCache.get(key);
  if (cached && (now - cached.timestamp) < MESSAGE_COOLDOWN_MS) {
    return false;
  }

  // Check 4: Anti-duplicate (compare with last message)
  const contentLower = content.toLowerCase();
  if (cached && cached.lastContent === contentLower) {
    return false;
  }

  // === ALL CHECKS PASSED - AWARD POINT ===

  // Update in-memory cache
  userMessageCache.set(key, { timestamp: now, lastContent: contentLower });

  // Update database
  try {
    const pool = getPool();
    await pool.query(
      `INSERT INTO user_activity (guild_id, user_id, username, message_count, last_message_time, last_active, last_message_content)
       VALUES ($1, $2, $3, 1, $4, $5, $6)
       ON CONFLICT (guild_id, user_id)
       DO UPDATE SET 
         message_count = user_activity.message_count + 1,
         last_message_time = $4,
         last_active = $5,
         last_message_content = $6,
         username = $3`,
      [guildId, userId, username, now, new Date(now), contentLower.substring(0, 500)]
    );
    return true;
  } catch (error) {
    console.error(`[Activity Tracker] Failed to persist message point for ${username}:`, sanitizeError(error));
    return false;
  }
}

/**
 * Get top active users for MVP selection with proper SQL filtering
 * Uses ORDER BY score DESC, LIMIT, and filters for score > 0
 * @param {string} guildId - Guild ID
 * @param {number} limit - Maximum number of winners (from config)
 * @param {string} guildName - Guild name for logging
 * @returns {Promise<Array>} - Array of top users sorted by score
 */
export async function getTopActiveUsers(guildId, limit = 1, guildName = null) {
  const pool = getPool();
  const users = [];
  const tag = guildName ? `[${guildName}]` : '[System]';

  try {
    // Strict SQL query:
    // 1. Filter by guild
    // 2. Calculate score as message_count + voice_minutes
    // 3. Filter WHERE score > 0 (no inactive users)
    // 4. ORDER BY score DESC (highest first)
    // 5. LIMIT by configured winner count
    const result = await pool.query(
      `SELECT 
         user_id, 
         username, 
         message_count, 
         voice_minutes, 
         (COALESCE(message_count, 0) + COALESCE(voice_minutes, 0)) AS score,
         last_active 
       FROM user_activity 
       WHERE guild_id = $1 
         AND (COALESCE(message_count, 0) + COALESCE(voice_minutes, 0)) > 0
       ORDER BY score DESC, last_active DESC
       LIMIT $2`,
      [guildId, limit]
    );

    for (const row of result.rows) {
      users.push({
        userId: row.user_id,
        username: row.username,
        messages: parseInt(row.message_count || 0, 10),
        voiceMinutes: parseInt(row.voice_minutes || 0, 10),
        score: parseInt(row.score || 0, 10),
        lastActive: row.last_active ? new Date(row.last_active) : new Date()
      });
    }

    console.log(`${tag} Query: ${users.length} candidates found (limit: ${limit})`);

  } catch (error) {
    console.error(`${tag} Failed to fetch top active users:`, sanitizeError(error));
  }

  return users;
}

/**
 * Stop all voice tracking for a guild (used when disabling system)
 */
export async function stopAllVoiceTracking(guildId) {
  const pool = getPool();
  try {
    // First, flush any accumulated time for users who were tracking
    await flushAllVoiceTime(guildId);

    await pool.query(
      `UPDATE user_activity 
       SET is_voice_tracking = FALSE,
           voice_valid_start = NULL
       WHERE guild_id = $1`,
      [guildId]
    );
  } catch (error) {
    console.error(`Failed to stop all voice tracking for ${guildId}:`, sanitizeError(error));
  }
}

// ============================================
// VOICE CHAT: EVENT-BASED STOPWATCH SYSTEM
// ============================================

/**
 * Check if a voice state is "valid" for tracking
 * Invalid if: alone, muted, deafened
 */
export function isVoiceStateValid(voiceState) {
  if (!voiceState || !voiceState.channel) return false;

  // Check if user is muted or deafened
  if (voiceState.selfMute || voiceState.serverMute) return false;
  if (voiceState.selfDeaf || voiceState.serverDeaf) return false;

  // Check AFK channel
  if (voiceState.guild.afkChannelId && voiceState.channel.id === voiceState.guild.afkChannelId) return false;

  // Check if user is alone (only humans count, not bots)
  const humanMembers = voiceState.channel.members.filter(m => !m.user.bot);
  if (humanMembers.size < 2) return false;

  return true;
}

/**
 * Count human members in a voice channel
 */
export function countHumansInChannel(channel) {
  if (!channel) return 0;
  return channel.members.filter(m => !m.user.bot).size;
}

/**
 * Handle voice state change with proper state transitions:
 * - Invalid -> Valid: START tracking
 * - Valid -> Invalid: STOP & SAVE time
 * - Valid -> Valid: DO NOTHING (preserve timer)
 */
export async function handleVoiceStateChange(guild, oldState, newState) {
  if (!guild) return;

  // Get the user who triggered the event
  const member = newState?.member || oldState?.member;
  if (!member || member.user.bot) return;

  const userId = member.id;
  const username = member.user.username;

  // Determine old and new validity for THIS user
  const wasValid = isVoiceStateValid(oldState);
  const isNowValid = isVoiceStateValid(newState);

  // State transition for the user who triggered the event
  if (!wasValid && isNowValid) {
    // Invalid -> Valid: START tracking
    await startVoiceTracking(guild, userId, username);
  } else if (wasValid && !isNowValid) {
    // Valid -> Invalid: STOP & SAVE
    await pauseVoiceTracking(guild, userId, username);
  }
  // Valid -> Valid: DO NOTHING (timer continues)

  // Now handle OTHER users who might be affected (e.g., someone left making others alone)
  const affectedChannels = new Set();
  if (oldState?.channel) affectedChannels.add(oldState.channel);
  if (newState?.channel) affectedChannels.add(newState.channel);

  for (const channel of affectedChannels) {
    await reevaluateOtherUsersInChannel(guild, channel, userId);
  }
}

/**
 * Re-evaluate OTHER users in a channel (not the one who triggered the event)
 * This handles the case where User A leaves, making User B alone
 */
async function reevaluateOtherUsersInChannel(guild, channel, excludeUserId) {
  if (!channel) return;

  const humanMembers = channel.members.filter(m => !m.user.bot && m.id !== excludeUserId);
  const totalHumans = channel.members.filter(m => !m.user.bot).size;
  const hasEnoughPeople = totalHumans >= 2;

  for (const [memberId, member] of humanMembers) {
    const voiceState = member.voice;
    const username = member.user.username;

    // Check if this user SHOULD be tracking
    const shouldBeTracking = hasEnoughPeople &&
      !voiceState.selfMute && !voiceState.serverMute &&
      !voiceState.selfDeaf && !voiceState.serverDeaf;

    // Check if this user IS currently tracking (in DB)
    const pool = getPool();
    const result = await pool.query(
      `SELECT voice_valid_start FROM user_activity 
       WHERE guild_id = $1 AND user_id = $2`,
      [guild.id, memberId]
    );

    const isCurrentlyTracking = result.rows.length > 0 &&
      result.rows[0].voice_valid_start !== null &&
      parseInt(result.rows[0].voice_valid_start) > 0;

    if (shouldBeTracking && !isCurrentlyTracking) {
      await startVoiceTracking(guild, memberId, username);
    } else if (!shouldBeTracking && isCurrentlyTracking) {
      await pauseVoiceTracking(guild, memberId, username);
    }
  }
}

/**
 * Start voice tracking for a user (Invalid -> Valid transition)
 * Only logs if actually starting (not already tracking)
 */
async function startVoiceTracking(guild, userId, username) {
  if (!guild || !userId) return;
  const guildId = guild.id;
  const now = Date.now();

  try {
    const pool = getPool();

    // Check if already tracking (to avoid duplicate logs)
    const check = await pool.query(
      `SELECT voice_valid_start FROM user_activity WHERE guild_id = $1 AND user_id = $2`,
      [guildId, userId]
    );

    const alreadyTracking = check.rows.length > 0 &&
      check.rows[0].voice_valid_start !== null &&
      parseInt(check.rows[0].voice_valid_start) > 0;

    if (alreadyTracking) return; // Already tracking, don't reset or re-log

    // Start tracking
    await pool.query(
      `INSERT INTO user_activity (guild_id, user_id, username, voice_valid_start, last_active)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (guild_id, user_id)
       DO UPDATE SET 
         voice_valid_start = $4,
         last_active = $5,
         username = $3`,
      [guildId, userId, username, now, new Date(now)]
    );
    // Voice tracking logic (logs removed)
  } catch (error) {
    logServerError(guild, username, `Failed to start voice tracking: ${sanitizeError(error)}`);
  }
}

/**
 * Pause voice tracking for a user (Valid -> Invalid transition)
 * Saves elapsed time to buffer. Awards points if threshold crossed.
 * Buffer is preserved so user can resume where they left off.
 */
async function pauseVoiceTracking(guild, userId, username) {
  if (!guild || !userId) return;
  const guildId = guild.id;
  const now = Date.now();

  try {
    const pool = getPool();

    // Get current tracking state
    const result = await pool.query(
      `SELECT voice_valid_start, voice_seconds_accumulated, voice_minutes 
       FROM user_activity 
       WHERE guild_id = $1 AND user_id = $2`,
      [guildId, userId]
    );

    if (result.rows.length === 0) return;

    const row = result.rows[0];
    const validStart = row.voice_valid_start ? parseInt(row.voice_valid_start) : null;

    if (!validStart || validStart <= 0) return; // Wasn't tracking

    let buffer = parseInt(row.voice_seconds_accumulated || 0);
    let voiceMinutes = parseInt(row.voice_minutes || 0);

    // Calculate elapsed time since tracking started
    const elapsedMs = now - validStart;
    const elapsedSeconds = Math.floor(elapsedMs / 1000);
    buffer += elapsedSeconds;

    // Award points if threshold crossed (60 seconds = 1 point)
    const pointsToAward = Math.floor(buffer / VOICE_POINTS_THRESHOLD_SECONDS) * VOICE_POINTS_REWARD;
    const remainingBuffer = buffer % VOICE_POINTS_THRESHOLD_SECONDS;

    if (pointsToAward > 0) {
      voiceMinutes += pointsToAward;
      buffer = remainingBuffer;
    }

    // Update DB: clear start time, save buffer for next session
    await pool.query(
      `UPDATE user_activity 
       SET voice_valid_start = NULL,
           voice_seconds_accumulated = $3,
           voice_minutes = $4,
           last_active = $5
       WHERE guild_id = $1 AND user_id = $2`,
      [guildId, userId, buffer, voiceMinutes, new Date(now)]
    );
  } catch (error) {
    console.error(`Failed to pause voice tracking for ${username} in ${guild.id}:`, sanitizeError(error));
  }
}

/**
 * PERIODIC TICK: Award points to active voice users every 30 seconds
 * Checks all currently valid users and awards +1 point per 60 seconds of buffer
 * NOW INCLUDES REALTIME VALIDATION - verifies user is actually in voice
 */
export async function voicePointsTick(client) {
  if (!client) return;

  const pool = getPool();
  const now = Date.now();

  try {
    // Get all users currently tracking across all guilds
    const result = await pool.query(
      `SELECT guild_id, user_id, username, voice_valid_start, voice_seconds_accumulated, voice_minutes
       FROM user_activity 
       WHERE voice_valid_start IS NOT NULL`
    );

    for (const row of result.rows) {
      const validStart = parseInt(row.voice_valid_start);
      if (!validStart || validStart <= 0) continue;

      // ========== REALTIME VALIDATION ==========
      // Fetch guild and member to verify they're actually in voice
      const guild = client.guilds.cache.get(row.guild_id);
      if (!guild) {
        // Guild not cached, stop tracking
        await stopTrackingUser(pool, row.guild_id, row.user_id, null, 'guild not found');
        continue;
      }

      let member;
      try {
        member = await guild.members.fetch(row.user_id);
      } catch {
        // Member not in server anymore
        await stopTrackingUser(pool, row.guild_id, row.user_id, guild, 'not in server');
        continue;
      }

      // Check if actually in voice and valid state
      const voiceState = member.voice;
      if (!voiceState || !voiceState.channel) {
        await pauseVoiceTracking(guild, row.user_id, row.username);
        console.log(`[${guild.name}] Paused ghost tracking for ${row.username}: not in voice (buffer saved)`);
        continue;
      }

      // Check mute/deaf
      if (voiceState.selfMute || voiceState.serverMute || voiceState.selfDeaf || voiceState.serverDeaf) {
        await pauseVoiceTracking(guild, row.user_id, row.username);
        console.log(`[${guild.name}] Paused ghost tracking for ${row.username}: muted/deafened (buffer saved)`);
        continue;
      }

      // Check AFK channel
      if (guild.afkChannelId && voiceState.channel.id === guild.afkChannelId) {
        await pauseVoiceTracking(guild, row.user_id, row.username);
        console.log(`[${guild.name}] Paused ghost tracking for ${row.username}: in AFK channel (buffer saved)`);
        continue;
      }

      // Check 2+ humans
      const humanCount = voiceState.channel.members.filter(m => !m.user.bot).size;
      if (humanCount < 2) {
        await pauseVoiceTracking(guild, row.user_id, row.username);
        console.log(`[${guild.name}] Paused ghost tracking for ${row.username}: alone in channel (buffer saved)`);
        continue;
      }

      // ========== VALIDATION PASSED - AWARD POINTS ==========
      let buffer = parseInt(row.voice_seconds_accumulated || 0);
      let voiceMinutes = parseInt(row.voice_minutes || 0);

      const elapsedMs = now - validStart;
      const elapsedSeconds = Math.floor(elapsedMs / 1000);
      const totalBuffer = buffer + elapsedSeconds;

      if (totalBuffer >= VOICE_POINTS_THRESHOLD_SECONDS) {
        const pointsToAward = Math.floor(totalBuffer / VOICE_POINTS_THRESHOLD_SECONDS) * VOICE_POINTS_REWARD;
        const remainingBuffer = totalBuffer % VOICE_POINTS_THRESHOLD_SECONDS;

        voiceMinutes += pointsToAward;

        await pool.query(
          `UPDATE user_activity 
           SET voice_valid_start = $3,
               voice_seconds_accumulated = $4,
               voice_minutes = $5,
               last_active = $6
           WHERE guild_id = $1 AND user_id = $2`,
          [row.guild_id, row.user_id, now, remainingBuffer, voiceMinutes, new Date(now)]
        );

        // Check voice mission progress
        try {
          const { checkVoiceMission } = await import('./index.js');
          const voiceChannelId = voiceState?.channel?.id;
          if (voiceChannelId) {
            await checkVoiceMission(row.guild_id, row.user_id, voiceChannelId, pointsToAward, voiceState);
          }
        } catch {
          // Silent fail — never crash core voice tracking for missions
        }
      }
    }
  } catch (error) {
    console.error('Voice points tick error:', sanitizeError(error));
  }
}

/**
 * Helper to stop tracking a user and log reason
 */
async function stopTrackingUser(pool, guildId, userId, guild, reason) {
  try {
    await pool.query(
      `UPDATE user_activity 
       SET voice_valid_start = NULL, is_voice_tracking = FALSE
       WHERE guild_id = $1 AND user_id = $2`,
      [guildId, userId]
    );
    const tag = guild?.name ? `[${guild.name}]` : '[System]';
    console.log(`${tag} Stopped ghost tracking for ${userId}: ${reason}`);
  } catch (e) {
    // Ignore errors during cleanup
  }
}

/**
 * Flush all voice time for a guild (used before MVP award or when stopping)
 * Awards any pending points and saves remaining buffer
 */
export async function flushAllVoiceTime(guildId) {
  const pool = getPool();
  const now = Date.now();

  try {
    // Get all users currently tracking
    const result = await pool.query(
      `SELECT user_id, username, voice_valid_start, voice_seconds_accumulated, voice_minutes
       FROM user_activity 
       WHERE guild_id = $1 AND voice_valid_start IS NOT NULL`,
      [guildId]
    );

    for (const row of result.rows) {
      const validStart = parseInt(row.voice_valid_start);
      if (!validStart || validStart <= 0) continue;

      let buffer = parseInt(row.voice_seconds_accumulated || 0);
      let voiceMinutes = parseInt(row.voice_minutes || 0);

      const elapsedMs = now - validStart;
      const elapsedSeconds = Math.floor(elapsedMs / 1000);
      buffer += elapsedSeconds;

      // Award points (60 seconds = 1 point)
      const pointsToAward = Math.floor(buffer / VOICE_POINTS_THRESHOLD_SECONDS) * VOICE_POINTS_REWARD;
      const remainingBuffer = buffer % VOICE_POINTS_THRESHOLD_SECONDS;

      if (pointsToAward > 0) {
        voiceMinutes += pointsToAward;
        buffer = remainingBuffer;
      }

      await pool.query(
        `UPDATE user_activity 
         SET voice_valid_start = NULL,
             voice_seconds_accumulated = $3,
             voice_minutes = $4
         WHERE guild_id = $1 AND user_id = $2`,
        [guildId, row.user_id, buffer, voiceMinutes]
      );
    }
  } catch (error) {
    console.error(`Failed to flush voice time for ${guildId}:`, sanitizeError(error));
  }
}
