import { getGuildConfig } from '../storage/config.js';
import { maskSnowflake } from '../shared.js';

/**
 * In-memory activity tracking (resets after each MVP award)
 * Key: guildId (string)
 * Value: {
 *   users: Map<userId, {messages, voiceMinutes, lastActive, lastMessageTime, username}>,
 *   voiceSessions: Map<userId, {startTime, isEligible, ...}>
 * }
 * TTL: None (persists until award cycle or manual reset)
 * Invalidation: resetGuildActivity(guildId) after MVP award
 * Cleanup: Automatic removal of guilds inactive > 24 hours
 */
const guildActivity = new Map();

// Constants
const MESSAGE_COOLDOWN_MS = 5000; // 5 seconds between message points
const MILLIS_PER_MINUTE = 60000;
const MAX_GUILD_AGE = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Clean up old guild data to prevent memory leaks
 */
async function cleanupOldGuilds() {
  const now = Date.now();
  let cleaned = 0;
  
  for (const [guildId] of guildActivity.entries()) {
    const lastActive = lastActivity.get(guildId) || 0;
    
    // Remove guild data if inactive for too long
    if ((now - lastActive) > MAX_GUILD_AGE) {
      guildActivity.delete(guildId);
      lastActivity.delete(guildId);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    console.log(`[Cleanup] Removed ${cleaned} inactive guilds from memory`);
  }
  
  return cleaned;
}

/**
 * Guild config cache to reduce disk I/O
 * Key: guildId (string)
 * Value: {config: Object, timestamp: number}
 * TTL: 5 minutes
 * Invalidation: Manual via invalidateConfigCache(guildId)
 * Cache miss behavior: Falls back to getGuildConfig() from storage
 */
const configCache = new Map();
const CONFIG_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Voice session tracking for active users
 * Key: `${guildId}:${userId}`
 * Value: {
 *   startTime, channelId, isEligible, hadEnoughUsers,
 *   effectiveMuted, effectiveDeafened, username, pendingJoinReason
 * }
 * TTL: None (persists for session duration)
 * Cleanup: endVoiceSession() when user leaves voice
 */
const voiceSessions = new Map();

/**
 * Last activity timestamp per guild (for cleanup)
 * Key: guildId (string)
 * Value: timestamp (ms)
 * Purpose: Track guild activity to remove stale data after 24h inactivity
 */
const lastActivity = new Map();

function touchGuild(guildId) {
  lastActivity.set(guildId, Date.now());
}

export async function getCachedGuildConfig(guildId) {
  const cached = configCache.get(guildId);
  const now = Date.now();

  if (cached && now - cached.timestamp < CONFIG_CACHE_TTL) {
    return cached.config;
  }

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

function emitVoiceScoreLog(username, minutesEarned, totalMinutes) {
  if (!minutesEarned || minutesEarned <= 0) return;
  const safeUsername = username || '[User]';
  const amount = minutesEarned === 1 ? '+1' : `+${minutesEarned}`;
  const message = `⏫🔊 | ${amount} voice score for ${safeUsername}`;
  logEvent('VOICE_SCORE', { message }, { plain: true });
}

/**
 * Get guild activity
 */
export function getGuildActivity(guildId) {
  if (!guildActivity.has(guildId)) {
    guildActivity.set(guildId, {
      users: new Map(),
      voiceSessions: new Map()
    });
  }
  touchGuild(guildId);
  return guildActivity.get(guildId);
}

/**
 * Get user activity
 */
export function getUserActivity(guildId, userId, username = null) {
  const guild = getGuildActivity(guildId);
  if (!guild.users.has(userId)) {
    guild.users.set(userId, {
      messages: 0,
      voiceMinutes: 0,
      lastActive: new Date(),
      lastMessageTime: 0,
      username: username || `User${userId.slice(-4)}`
    });
  }
  const user = guild.users.get(userId);
  // Update username if provided
  if (username && user.username !== username) {
    user.username = username;
  }
  touchGuild(guildId);
  return user;
}

/**
 * Reset guild activity
 */
export function resetGuildActivity(guildId) {
  guildActivity.delete(guildId);
  lastActivity.delete(guildId);
}

/**
 * Add message point
 */
export function addMessagePoint(guildId, userId, username = null) {
  const user = getUserActivity(guildId, userId, username);
  const now = Date.now();
  
  // Apply cooldown per user
  if (now - user.lastMessageTime >= MESSAGE_COOLDOWN_MS) {
    user.messages++;
    user.lastActive = new Date();
    user.lastMessageTime = now;
    touchGuild(guildId);
    logEvent('CHAT_SCORE', {
      message: `⏫💬 | +1 text score for ${user.username || '[User]'}`
    }, { plain: true });
    return true;
  }
  return false;
}

/**
 * Get voice session
 */
export function getVoiceSession(guildId, userId, username = null) {
  const guild = getGuildActivity(guildId);
  if (!guild.voiceSessions.has(userId)) {
    guild.voiceSessions.set(userId, {
      state: 'paused',
      reason: 'not enough users',
      lastTickAt: null,
      carrySeconds: 0,
      isEligible: false,
      currentChannelId: null,
      startTime: null,
      username: username || null,
      effectiveMuted: false,
      effectiveDeafened: false,
      hadEnoughUsers: false,
      pendingJoinReason: false
    });
  }
  const session = guild.voiceSessions.get(userId);
  if (username && session.username !== username) {
    session.username = username;
  }
  return session;
}

/**
 * Start voice session
 */
export function startVoiceSession(guildId, userId, channelId, username = null) {
  const session = getVoiceSession(guildId, userId, username);
  const user = getUserActivity(guildId, userId, username);
  const now = Date.now();

  // SAFETY: Don't set lastTickAt here - only when becoming eligible
  session.lastTickAt = null;
  session.currentChannelId = channelId;
  session.state = 'paused';
  session.isEligible = false;
  session.startTime = now;
  session.username = user.username;
  session.effectiveMuted = false;
  session.effectiveDeafened = false;
  session.hadEnoughUsers = false;
  session.pendingJoinReason = true;
  touchGuild(guildId);
}

/**
 * End voice session
 */
export function endVoiceSession(guildId, userId, username = null) {
  const session = getVoiceSession(guildId, userId, username);
  const user = getUserActivity(guildId, userId, username);
  
  bankVoiceTime(session, user, true);
  session.state = 'paused';
  session.reason = 'left the call';
  session.lastTickAt = null;
  session.carrySeconds = 0;
  session.isEligible = false;
  session.currentChannelId = null;
  session.startTime = null;
  session.username = user.username;
  session.effectiveMuted = false;
  session.effectiveDeafened = false;
  session.hadEnoughUsers = false;
  session.pendingJoinReason = false;
}

export function syncEffectiveVoiceState(guildId, userId, muted, deafened, username = null) {
  const session = getVoiceSession(guildId, userId, username);
  const previousMuted = Boolean(session.effectiveMuted);
  const previousDeafened = Boolean(session.effectiveDeafened);
  const nextMuted = Boolean(muted);
  const nextDeafened = Boolean(deafened);

  session.effectiveMuted = nextMuted;
  session.effectiveDeafened = nextDeafened;

  return {
    previousMuted,
    previousDeafened,
    mutedChanged: previousMuted !== nextMuted,
    deafenedChanged: previousDeafened !== nextDeafened,
    currentMuted: nextMuted,
    currentDeafened: nextDeafened
  };
}

/**
 * Update voice eligibility
 */
export function updateVoiceEligibility(guildId, userId, isEligible, username = null) {
  const session = getVoiceSession(guildId, userId, username);
  const user = getUserActivity(guildId, userId, username);
  const wasEligible = session.isEligible;
  
  if (isEligible && !wasEligible) {
    session.isEligible = true;
    session.state = 'active';
    session.lastTickAt = Date.now();
    return { changed: true, nowEligible: true };
  } else if (!isEligible && wasEligible) {
    bankVoiceTime(session, user);
    session.isEligible = false;
    session.state = 'paused';
    session.lastTickAt = null;
    return { changed: true, nowEligible: false };
  }

  return { changed: false, nowEligible: session.isEligible };
}

/**
 * Voice tick
 */
export async function voiceTick(guildId) {
  const guild = getGuildActivity(guildId);
  const now = Date.now();
  
  for (const [userId, session] of guild.voiceSessions) {
    try {
      // SAFETY: Only accumulate if currently eligible AND has an active tick timestamp
      if (session.isEligible && session.lastTickAt) {
        const user = getUserActivity(guildId, userId);
        
        // Double-check eligibility hasn't changed mid-tick
        if (!session.isEligible) {
          console.warn(`⚠️ Eligibility changed mid-tick for ${user.username}, skipping`);
          continue;
        }
        
        const earned = accumulateVoiceTime(session, user, now);
        if (earned > 0) {
          touchGuild(guildId);
        }
      }
    } catch (error) {
      console.error(`Error processing voice tick for user ${userId}:`, error);
    }
  }

  await cleanupOldGuilds();
}

function bankVoiceTime(session, user, resetCarry = false) {
  if (!session.lastTickAt) return;
  accumulateVoiceTime(session, user, Date.now(), true);
  session.lastTickAt = null;
  if (resetCarry) {
    session.carrySeconds = 0;
    session.startTime = null;
  }
}

function accumulateVoiceTime(session, user, now, forceBank = false) {
  const lastTick = session.lastTickAt ?? now;
  const elapsedSeconds = Math.max(0, Math.floor((now - lastTick) / 1000));
  const totalSeconds = session.carrySeconds + elapsedSeconds;
  let earnedMinutes = Math.floor(totalSeconds / 60);

  // SAFETY: Cap to 1 minute per tick to prevent bulk dumps
  if (earnedMinutes > 1) {
    console.warn(`⚠️ voice score overrun clamped for ${user.username} (requested +${earnedMinutes}, applied +1)`);
    earnedMinutes = 1;
  }

  if (earnedMinutes > 0) {
    user.voiceMinutes += earnedMinutes;
    user.lastActive = new Date();
    emitVoiceScoreLog(user.username, earnedMinutes, user.voiceMinutes);
  }

  // Only carry over up to 59 seconds, never minutes
  session.carrySeconds = (totalSeconds - (earnedMinutes * 60)) % 60;
  session.lastTickAt = forceBank ? null : now;

  return earnedMinutes;
}

function logEvent(event, data, { plain = false } = {}) {
  if (plain) {
    console.log(data.message);
    return;
  }

  const payload = {
    event,
    timestamp: new Date().toISOString(),
    ...data,
    guildId: data.guildId ? maskSnowflake(String(data.guildId)) : undefined,
    userId: data.userId ? maskSnowflake(String(data.userId)) : undefined
  };

  if (process.env.NODE_ENV === 'production') {
    console.log(JSON.stringify(payload));
  } else {
    console.log(`[${event}]`, payload);
  }
}
