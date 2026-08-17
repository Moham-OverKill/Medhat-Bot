import { getPool } from '../storage/postgres.js';
import { sanitizeError, runInGuildContext } from '../shared.js';
import { sysLog, sysError } from '../utils/logger.js';

// ============================================
// TEXT CHAT: ANTI-SPAM CONFIGURATION
// ============================================
const MESSAGE_COOLDOWN_MS = 10000; // 10 seconds between valid messages
const MIN_MESSAGE_LENGTH = 5; // Minimum 5 characters
const COMMAND_PREFIXES = ['/', '!', '?', '.', '-', '$', '>']; // Ignore commands

// In-memory cache for cooldowns (Key: `${guildId}:${userId}`, Value: timestamp)
const userMessageCooldownCache = new Map();

// In-memory cache for duplicate message checking per channel
// Key: `${guildId}:${channelId}:${userId}`, Value: { content: string, timestamp: number }
const userLastChannelContentCache = new Map();
const CONTENT_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours retention
const CACHE_CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes

// Periodic cleanup to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of userMessageCooldownCache.entries()) {
    if (now - timestamp > MESSAGE_COOLDOWN_MS * 10) {
      userMessageCooldownCache.delete(key);
    }
  }
  for (const [key, data] of userLastChannelContentCache.entries()) {
    if (now - data.timestamp > CONTENT_CACHE_TTL_MS) {
      userLastChannelContentCache.delete(key);
    }
  }
}, CACHE_CLEANUP_INTERVAL);

// In-memory queue for batching message points to PostgreSQL
// Key: `${guildId}:${userId}`, Value: { guildId, userId, username, count, lastTime }
const pendingMessageBatch = new Map();
let isFlushingBatch = false;
const BATCH_FLUSH_INTERVAL = 15 * 1000; // 15 seconds

export async function flushMessageBatch() {
  if (pendingMessageBatch.size === 0 || isFlushingBatch) return;
  isFlushingBatch = true;

  const entriesToFlush = Array.from(pendingMessageBatch.values());
  pendingMessageBatch.clear();

  try {
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const entry of entriesToFlush) {
        await client.query(
          `INSERT INTO user_activity (guild_id, user_id, username, message_count, last_message_time, last_active)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (guild_id, user_id)
           DO UPDATE SET 
             message_count = user_activity.message_count + $4,
             last_message_time = GREATEST(user_activity.last_message_time, $5),
             last_active = GREATEST(user_activity.last_active, $6),
             username = $3`,
          [entry.guildId, entry.userId, entry.username, entry.count, entry.lastTime, new Date(entry.lastTime)]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      // Re-queue entries on failure so no data is lost
      for (const entry of entriesToFlush) {
        const key = `${entry.guildId}:${entry.userId}`;
        const existing = pendingMessageBatch.get(key);
        if (existing) {
          existing.count += entry.count;
          existing.lastTime = Math.max(existing.lastTime, entry.lastTime);
        } else {
          pendingMessageBatch.set(key, entry);
        }
      }
      sysError('Batch Message Activity Flush Failed', err);
    } finally {
      client.release();
    }
  } catch (error) {
    sysError('Batch Connection Pool Error', error);
  } finally {
    isFlushingBatch = false;
  }
}

// Auto flush every 15 seconds
setInterval(() => {
  flushMessageBatch().catch(err => sysError('Periodic Batch Flush Error', err));
}, BATCH_FLUSH_INTERVAL);

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
      sysLog('Presence Audit', { detail: `Cleared stale voice tracking for ${result.rowCount} users` });
    }
  } catch (error) {
    sysError('Presence Audit Failed', error, { detail: 'Stale voice tracking' });
  }
}

/**
 * Get guild activity from database
 * Returns a structure compatible with legacy code: { users: Map(...) }
 */
export async function getGuildActivity(guildId) {
  await flushMessageBatch().catch(() => {});
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
    sysError('Activity Fetch Failed', error, { guild: guildId });
  }

  return { users };
}

/**
 * Reset guild activity in database (scores only)
 */
export async function resetGuildActivity(guildId) {
  await flushMessageBatch().catch(() => {});
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
    sysError('Activity Reset Failed', error, { guild: guildId });
  }
}

/**
 * Add message point with strict anti-spam checks and batch buffering
 */
export async function addMessagePoint(guild, userId, username, messageContent = '', hasAttachments = false, channelId = null) {
  if (!guild || !userId) return false;
  const guildId = guild.id;
  const now = Date.now();
  const userKey = `${guildId}:${userId}`;
  const content = (messageContent || '').trim();

  // 1. Check if channel is ignored for activity
  if (channelId) {
    try {
      const { isActivityIgnored } = await import('../middleware/organize.js');
      if (await isActivityIgnored(guildId, channelId)) return false;
    } catch {}
  }

  // 2. Minimum length OR valid attachment
  const hasContent = content.length >= MIN_MESSAGE_LENGTH || hasAttachments;
  if (!hasContent) return false;

  // 3. Command prefix check (only if text content exists)
  if (content.length > 0) {
    const firstChar = content.charAt(0);
    if (COMMAND_PREFIXES.includes(firstChar)) return false;
  }

  // 4. Cooldown check (10s per user)
  const lastMsgTime = userMessageCooldownCache.get(userKey);
  if (lastMsgTime && (now - lastMsgTime) < MESSAGE_COOLDOWN_MS) return false;

  // 5. Channel-Specific Duplicate Content Check (anti-spam across all systems)
  // If the message is identical to the user's previous message in the same channel -> REJECT
  const contentLower = content.toLowerCase();
  if (contentLower.length > 0 && !hasAttachments) {
    const channelKey = channelId ? `${guildId}:${channelId}:${userId}` : `${guildId}:global:${userId}`;
    const previousEntry = userLastChannelContentCache.get(channelKey);
    if (previousEntry && previousEntry.content === contentLower) {
      sysLog('Anti-Spam Duplicate Message Rejected', {
        user: userId,
        guild: guildId,
        detail: `Channel: ${channelId || 'Global'} | Text: "${contentLower.slice(0, 30)}"`
      });
      return false;
    }
    userLastChannelContentCache.set(channelKey, { content: contentLower, timestamp: now });
  }

  userMessageCooldownCache.set(userKey, now);

  // 6. Buffer into pending batch
  const existingBatch = pendingMessageBatch.get(userKey);
  if (existingBatch) {
    existingBatch.count += 1;
    existingBatch.lastTime = now;
    existingBatch.username = username;
  } else {
    pendingMessageBatch.set(userKey, {
      guildId,
      userId,
      username,
      count: 1,
      lastTime: now
    });
  }

  // If batch reaches 50 items, flush proactively
  if (pendingMessageBatch.size >= 50) {
    flushMessageBatch().catch(() => {});
  }

  // 7. Battlepass XP hook — reads msg XP rate from guild config (default: 1)
  import('../storage/config.js')
    .then(({ getGuildConfig }) => getGuildConfig(guildId))
    .then(cfg => {
      const msgXp = Math.max(0, parseInt(cfg?.battlepass_msg_xp ?? 1, 10));
      if (msgXp <= 0) return;
      return import('../commands/settings/pass-engine.js')
        .then(({ awardBattlepassXp }) => awardBattlepassXp(guildId, userId, username, msgXp, null));
    })
    .catch(err => {
      import('../utils/logger.js').then(({ sysError }) => sysError('Battlepass Msg XP Hook Error', err));
    });

  return true;
}

/**
 * Get top active users for MVP selection
 */
export async function getTopActiveUsers(guildId, limit = 1, guildObj = null) {
  await flushMessageBatch().catch(() => {});
  const pool = getPool();
  const users = [];

  try {
    const fetchLimit = guildObj ? Math.max(limit * 3, 20) : limit;
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
      [guildId, fetchLimit]
    );

    for (const row of result.rows) {
      if (users.length >= limit) break;

      if (guildObj) {
        // Verify user is still a member of the Discord server
        const member = await guildObj.members.fetch(row.user_id).catch(() => null);
        if (!member) {
          // User left the server — purge stale record so they don't clog leaderboard/MVP slots
          await pool.query('DELETE FROM user_activity WHERE guild_id = $1 AND user_id = $2', [guildId, row.user_id]).catch(() => {});
          continue;
        }
        if (member.user.bot) continue;
      }

      users.push({
        userId: row.user_id,
        username: row.username,
        messages: parseInt(row.message_count || 0, 10),
        voiceMinutes: parseInt(row.voice_minutes || 0, 10),
        score: parseInt(row.score || 0, 10),
        lastActive: row.last_active ? new Date(row.last_active) : new Date()
      });
    }
  } catch (error) {
    sysError('Activity Fetch Failed', error, { guild: guildId, detail: 'Top users' });
  }

  return users;
}

/**
 * Stop all voice tracking for a guild
 */
export async function stopAllVoiceTracking(guildId) {
  const pool = getPool();
  try {
    await flushAllVoiceTime(guildId);
    await pool.query(
      `UPDATE user_activity 
       SET is_voice_tracking = FALSE,
           voice_valid_start = NULL
       WHERE guild_id = $1`,
      [guildId]
    );
  } catch (error) {
    sysError('Activity Update Failed', error, { guild: guildId, detail: 'Stop all voice tracking' });
  }
}

// ============================================
// VOICE CHAT: EVENT-BASED STOPWATCH SYSTEM
// ============================================

export function isVoiceStateValid(voiceState) {
  if (!voiceState || !voiceState.channel) return false;
  if (voiceState.selfMute || voiceState.serverMute) return false;
  if (voiceState.selfDeaf || voiceState.serverDeaf) return false;
  if (voiceState.guild?.afkChannelId && voiceState.channel.id === voiceState.guild.afkChannelId) return false;
  const members = voiceState.channel.members;
  if (!members) return false;
  const humanCount = typeof members.filter === 'function'
    ? members.filter(m => !m.user?.bot).size
    : Array.from(members.values ? members.values() : []).filter(m => !m.user?.bot).length;
  if (humanCount < 2) return false;
  return true;
}

export async function handleVoiceStateChange(guild, oldState, newState) {
  if (!guild) return;
  const member = newState?.member || oldState?.member;
  if (!member || member.user.bot) return;

  const userId = member.id;
  const username = member.user.username;
  const wasValid = isVoiceStateValid(oldState);
  const isNowValid = isVoiceStateValid(newState);

  if (!wasValid && isNowValid) {
    await startVoiceTracking(guild, userId, username);
  } else if (wasValid && !isNowValid) {
    await pauseVoiceTracking(guild, userId, username, oldState);
  }

  const affectedChannels = new Set();
  if (oldState?.channel) affectedChannels.add(oldState.channel);
  if (newState?.channel) affectedChannels.add(newState.channel);

  for (const channel of affectedChannels) {
    await reevaluateOtherUsersInChannel(guild, channel, userId);
  }
}

async function reevaluateOtherUsersInChannel(guild, channel, excludeUserId) {
  if (!channel) return;
  const humanMembers = channel.members.filter(m => !m.user.bot && m.id !== excludeUserId);
  const totalHumans = channel.members.filter(m => !m.user.bot).size;
  const hasEnoughPeople = totalHumans >= 2;

  for (const [memberId, member] of humanMembers) {
    const voiceState = member.voice;
    const username = member.user.username;

    const shouldBeTracking = hasEnoughPeople &&
      !voiceState.selfMute && !voiceState.serverMute &&
      !voiceState.selfDeaf && !voiceState.serverDeaf;

    const pool = getPool();
    const result = await pool.query(
      `SELECT voice_valid_start FROM user_activity WHERE guild_id = $1 AND user_id = $2`,
      [guild.id, memberId]
    );

    const isCurrentlyTracking = result.rows.length > 0 &&
      result.rows[0].voice_valid_start !== null &&
      parseInt(result.rows[0].voice_valid_start) > 0;

    if (shouldBeTracking && !isCurrentlyTracking) {
      await startVoiceTracking(guild, memberId, username);
    } else if (!shouldBeTracking && isCurrentlyTracking) {
      await pauseVoiceTracking(guild, memberId, username, voiceState);
    }
  }
}

async function startVoiceTracking(guild, userId, username) {
  if (!guild || !userId) return;
  const guildId = guild.id;
  const now = Date.now();

  try {
    const pool = getPool();
    const check = await pool.query(
      `SELECT voice_valid_start FROM user_activity WHERE guild_id = $1 AND user_id = $2`,
      [guildId, userId]
    );

    const alreadyTracking = check.rows.length > 0 &&
      check.rows[0].voice_valid_start !== null &&
      parseInt(check.rows[0].voice_valid_start) > 0;

    if (alreadyTracking) return;

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
  } catch (error) {
    sysError('Activity Update Failed', error, { user: userId, guild: guildId, detail: 'Start voice tracking' });
  }
}

async function pauseVoiceTracking(guild, userId, username, voiceState = null) {
  if (!guild || !userId) return;
  const guildId = guild.id;
  const now = Date.now();

  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT voice_valid_start, voice_seconds_accumulated 
       FROM user_activity 
       WHERE guild_id = $1 AND user_id = $2`,
      [guildId, userId]
    );

    if (result.rows.length === 0) return;

    const row = result.rows[0];
    const validStart = row.voice_valid_start ? parseInt(row.voice_valid_start) : null;
    if (!validStart || validStart <= 0) return;

    let buffer = parseInt(row.voice_seconds_accumulated || 0);
    const elapsedMs = now - validStart;
    const elapsedSeconds = Math.floor(elapsedMs / 1000);
    buffer += elapsedSeconds;

    const pointsToAward = Math.floor(buffer / VOICE_POINTS_THRESHOLD_SECONDS) * VOICE_POINTS_REWARD;
    const remainingBuffer = buffer % VOICE_POINTS_THRESHOLD_SECONDS;

    // ATOMIC UPDATE: Consume valid time and increment points in one step
    await pool.query(
      `UPDATE user_activity 
       SET voice_valid_start = NULL,
           voice_seconds_accumulated = $3,
           voice_minutes = voice_minutes + $4,
           last_active = $5
       WHERE guild_id = $1 AND user_id = $2`,
      [guildId, userId, remainingBuffer, pointsToAward, new Date(now)]
    );

    // Battlepass XP hook for voice points — reads voice XP rate from guild config (default: 1)
    if (pointsToAward > 0) {
      import('../storage/config.js')
        .then(({ getGuildConfig }) => getGuildConfig(guildId))
        .then(cfg => {
          const voiceXpRate = Math.max(0, parseInt(cfg?.battlepass_voice_xp ?? 1, 10));
          if (voiceXpRate <= 0) return;
          const totalVoiceXp = pointsToAward * voiceXpRate;
          return import('../commands/settings/pass-engine.js')
            .then(({ awardBattlepassXp }) => awardBattlepassXp(guildId, userId, username, totalVoiceXp, null));
        })
        .catch(err => {
          import('../utils/logger.js').then(({ sysError }) => sysError('Battlepass Voice XP Hook Error', err));
        });
    }

    // NEW: Sync with Quest Engine
    if (pointsToAward > 0) {
      try {
        const { checkVoiceQuest } = await import('./index.js');
        const voiceChannelId = voiceState?.channel?.id || voiceState?.channelId;
        if (voiceChannelId) {
          await checkVoiceQuest(guildId, userId, voiceChannelId, pointsToAward, voiceState);
        }
      } catch {
        // Silent fail
      }
    }
  } catch (error) {
    sysError('Activity Update Failed', error, { user: userId, guild: guildId, detail: 'Pause voice tracking' });
  }
}

export async function voicePointsTick(client) {
  if (!client) return;

  // Flush pending message batch to keep activity in sync
  await flushMessageBatch().catch(() => {});

  const pool = getPool();
  const now = Date.now();

  try {
    const { isActivityIgnored } = await import('../middleware/organize.js');

    // 1. SELF-HEALING SWEEP: Scan voice channels to resume valid users who were paused
    for (const [guildId, guild] of client.guilds.cache) {
      const voiceChannels = guild.channels.cache.filter(c => c.isVoiceBased?.() || c.type === 2 || c.type === 13);
      for (const [channelId, channel] of voiceChannels) {
        if (await isActivityIgnored(guildId, channelId)) continue;
        const humanMembers = channel.members?.filter(m => !m.user.bot);
        if (humanMembers && humanMembers.size >= 2) {
          for (const [memberId, member] of humanMembers) {
            if (isVoiceStateValid(member.voice)) {
              await startVoiceTracking(guild, memberId, member.user.username);
            }
          }
        }
      }
    }

    // 2. Query all actively tracking users and process point accrual
    const result = await pool.query(
      `SELECT guild_id, user_id, username, voice_valid_start, voice_seconds_accumulated
       FROM user_activity 
       WHERE voice_valid_start IS NOT NULL`
    );

    for (const row of result.rows) {
      await runInGuildContext(row.guild_id, async () => {
        const validStart = parseInt(row.voice_valid_start);
        if (!validStart || validStart <= 0) return;

        const guild = client.guilds.cache.get(row.guild_id);
        if (!guild) {
          await stopTrackingUser(pool, row.guild_id, row.user_id, null, 'guild not found');
          return;
        }

        let member;
        try {
          member = await guild.members.fetch(row.user_id);
        } catch (e) {
          await stopTrackingUser(pool, row.guild_id, row.user_id, guild, 'not in server');
          return;
        }

        const voiceState = member.voice;
        if (!voiceState || !voiceState.channel) {
          await pauseVoiceTracking(guild, row.user_id, row.username, voiceState);
          return;
        }

        if (await isActivityIgnored(row.guild_id, voiceState.channel.id)) {
          await pauseVoiceTracking(guild, row.user_id, row.username, voiceState);
          return;
        }

        if (voiceState.selfMute || voiceState.serverMute || voiceState.selfDeaf || voiceState.serverDeaf) {
          await pauseVoiceTracking(guild, row.user_id, row.username, voiceState);
          return;
        }

        if (guild.afkChannelId && voiceState.channel.id === guild.afkChannelId) {
          await pauseVoiceTracking(guild, row.user_id, row.username, voiceState);
          return;
        }

        const humanCount = voiceState.channel.members.filter(m => !m.user.bot).size;
        if (humanCount < 2) {
          await pauseVoiceTracking(guild, row.user_id, row.username, voiceState);
          return;
        }

        // ========== VALIDATION PASSED - AWARD POINTS ==========
        const buffer = parseInt(row.voice_seconds_accumulated || 0);
        const elapsedMs = now - validStart;
        const elapsedSeconds = Math.floor(elapsedMs / 1000);
        const totalBuffer = buffer + elapsedSeconds;

        if (totalBuffer >= VOICE_POINTS_THRESHOLD_SECONDS) {
          const pointsToAward = Math.floor(totalBuffer / VOICE_POINTS_THRESHOLD_SECONDS) * VOICE_POINTS_REWARD;
          const remainingBuffer = totalBuffer % VOICE_POINTS_THRESHOLD_SECONDS;

          // ATOMIC UPDATE: Consume valid time and increment points in one step
          // We use a WHERE clause on voice_valid_start to ensure we only update if it hasn't changed
          const updateResult = await pool.query(
            `UPDATE user_activity 
             SET voice_valid_start = $3,
                 voice_seconds_accumulated = $4,
                 voice_minutes = voice_minutes + $5,
                 last_active = $6
             WHERE guild_id = $1 AND user_id = $2 AND voice_valid_start = $7`,
            [row.guild_id, row.user_id, now, remainingBuffer, pointsToAward, new Date(now), row.voice_valid_start]
          );

          if (updateResult.rowCount === 0) {
            sysLog('Activity Sync Notice', { user: row.user_id, guild: row.guild_id, detail: 'Atomic update skipped: state changed' });
            return;
          }

          // Battlepass XP hook for voice tick
          import('../storage/config.js')
            .then(({ getGuildConfig }) => getGuildConfig(row.guild_id))
            .then(cfg => {
              const voiceXpRate = Math.max(0, parseInt(cfg?.battlepass_voice_xp ?? 1, 10));
              if (voiceXpRate <= 0) return;
              const totalVoiceXp = pointsToAward * voiceXpRate;
              return import('../commands/settings/pass-engine.js')
                .then(({ awardBattlepassXp }) => awardBattlepassXp(row.guild_id, row.user_id, row.username, totalVoiceXp, null));
            })
            .catch(err => {
              import('../utils/logger.js').then(({ sysError }) => sysError('Battlepass Voice Tick XP Hook Error', err));
            });

          try {
            const { checkVoiceQuest } = await import('./index.js');
            const voiceChannelId = voiceState?.channel?.id;
            if (voiceChannelId) {
              await checkVoiceQuest(row.guild_id, row.user_id, voiceChannelId, pointsToAward, voiceState);
            }
          } catch (e) {
            // Silent fail
          }
        }
      });
    }
  } catch (error) {
    sysError('Activity Heart-Beat Failed', error, { detail: 'Voice points tick' });
  }
}

async function stopTrackingUser(pool, guildId, userId, guild, reason) {
  try {
    await pool.query(
      `UPDATE user_activity 
       SET voice_valid_start = NULL, is_voice_tracking = FALSE
       WHERE guild_id = $1 AND user_id = $2`,
      [guildId, userId]
    );
  } catch (e) {}
}

export async function syncVoicePresence(guild) {
  if (!guild) return;
  try {
    const channels = guild.channels.cache.filter(c => c.isVoiceBased());
    for (const [id, channel] of channels) {
      const humanMembers = channel.members.filter(m => !m.user.bot);
      for (const [memberId, member] of humanMembers) {
        if (isVoiceStateValid(member.voice)) {
          await startVoiceTracking(guild, memberId, member.user.username);
        }
      }
    }
  } catch (error) {
    sysError('Presence Audit Failed', error, { guild: guild.id, detail: 'Initial voice sync' });
  }
}

export async function flushAllVoiceTime(guildId) {
  const pool = getPool();
  const now = Date.now();

  try {
    const result = await pool.query(
      `SELECT user_id, username, voice_valid_start, voice_seconds_accumulated 
       FROM user_activity 
       WHERE guild_id = $1 AND voice_valid_start IS NOT NULL`,
      [guildId]
    );

    for (const row of result.rows) {
      const validStart = parseInt(row.voice_valid_start);
      if (!validStart || validStart <= 0) continue;

      let buffer = parseInt(row.voice_seconds_accumulated || 0);
      const elapsedMs = now - validStart;
      const elapsedSeconds = Math.floor(elapsedMs / 1000);
      buffer += elapsedSeconds;

      const pointsToAward = Math.floor(buffer / VOICE_POINTS_THRESHOLD_SECONDS) * VOICE_POINTS_REWARD;
      const remainingBuffer = buffer % VOICE_POINTS_THRESHOLD_SECONDS;

      // ATOMIC UPDATE: Consume valid time and increment points in one step
      await pool.query(
        `UPDATE user_activity 
         SET voice_valid_start = NULL,
             voice_seconds_accumulated = $3,
             voice_minutes = voice_minutes + $4
         WHERE guild_id = $1 AND user_id = $2`,
        [guildId, row.user_id, remainingBuffer, pointsToAward]
      );
    }
  } catch (error) {
    sysError('Activity Flush Failed', error, { guild: guildId, detail: 'Flush all voice time' });
  }
}
