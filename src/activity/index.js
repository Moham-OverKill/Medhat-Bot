// Activity Tracking System - Anti-Spam & Balanced Scoring
import {
  addMessagePoint,
  getCachedGuildConfig,
  invalidateConfigCache as invalidateTrackerCache,
  handleVoiceStateChange,
  voicePointsTick,
  clearStaleVoiceTracking
} from './tracker.js';
import { cleanupExpiredItems } from '../economy/shop.js';
import { sanitizeError } from '../shared.js';
import { getMission, incrementProgress, getProgress } from '../missions/missions.js';
import { getGuildConfig } from '../storage/config.js';
import { getTodayCairo } from '../utils/time.js';

// Re-export for use in index.js
export { clearStaleVoiceTracking };

// Cache for mission data (guildId -> { channelId, completedUsers: Set, trackingUsers: Set })
const missionCache = new Map();

let client = null;
let tickInterval = null;
let handlersInitialized = false;

export async function initializeActivityTracking(discordClient) {
  if (handlersInitialized) {
    return;
  }

  client = discordClient;

  // Clear existing interval if any
  if (tickInterval) {
    clearInterval(tickInterval);
  }

  // Remove old listeners if they exist (prevents memory leak)
  client.removeListener('messageCreate', handleMessage);
  client.removeListener('voiceStateUpdate', handleVoiceStateUpdate);

  // Set up message tracking (with anti-spam)
  client.on('messageCreate', handleMessage);

  // Set up voice state tracking (event-based stopwatch)
  client.on('voiceStateUpdate', handleVoiceStateUpdate);

  // Voice points tick every 30 seconds (awards +1 per 60s of valid time)
  tickInterval = setInterval(async () => {
    try {
      await voicePointsTick(client);
    } catch (error) {
      console.error('[System] Voice points tick error:', sanitizeError(error));
    }
  }, 30000);

  // Shop cleanup tick every 60 seconds (separate interval)
  setInterval(async () => {
    try {
      await cleanupExpiredItems(client);
    } catch (error) {
      console.error('[System] Shop cleanup error:', sanitizeError(error));
    }
  }, 60000);

  // Pre-populate mission channel & completion cache on startup
  try {
    const { getPool } = await import('../storage/postgres.js');
    const pool = getPool();
    
    // 1. Get all active mission channels
    const missionResult = await pool.query(`
      SELECT m.guild_id, m.channel_id, m.id as mission_id
      FROM missions m
      INNER JOIN guild_configs gc ON gc.guild_id = m.guild_id
      WHERE gc.config->>'active_mission_id' IS NOT NULL
        AND (gc.config->>'active_mission_id')::integer = m.id
        AND (gc.config->>'missions_enabled')::boolean = true
    `);
    
    for (const row of missionResult.rows) {
      missionCache.set(row.guild_id, { 
        channelId: row.channel_id, 
        completedUsers: new Set(),
        trackingUsers: new Set()
      });
    }

    // 2. Load users who already completed missions or are tracking TODAY
    const statusResult = await pool.query(`
      SELECT guild_id, user_id, completed, active_tracking
      FROM mission_progress 
      WHERE (completed = true OR active_tracking = true)
        AND mission_date = $1
    `, [getTodayCairo()]);

    for (const row of statusResult.rows) {
      const data = missionCache.get(row.guild_id);
      if (data) {
        if (row.completed) data.completedUsers.add(row.user_id);
        if (row.active_tracking) data.trackingUsers.add(row.user_id);
      }
    }

    const logPrefix = client.guilds.cache.first()?.name || 'System';
    console.log(`[${logPrefix}] Missions: Watch-mode active for ${missionResult.rowCount} channels (${statusResult.rowCount} users cached)`);
  } catch (err) {
    console.error('[Missions] Cache warmup failed:', err);
  }

  handlersInitialized = true;
}

export function cleanup() {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }

  if (client) {
    client.removeListener('messageCreate', handleMessage);
    client.removeListener('voiceStateUpdate', handleVoiceStateUpdate);
  }

  invalidateTrackerCache();
  handlersInitialized = false;
}

async function handleMessage(message) {
  // Ignore bots, webhooks, and DMs
  if (message.author.bot || message.webhookId || !message.guild) return;

  // Activity tracking is always on (silent tracking)
  // MVP awards are controlled separately by the Auto/Manual toggle
  addMessagePoint(message.guild, message.author.id, message.author.username, message.content);

  // === MISSION PROGRESS TRACKING ===
  try {
    await checkMissionProgress(message);
  } catch (error) {
    // Silent fail — never crash the bot for mission tracking
  }
}

async function handleVoiceStateUpdate(oldState, newState) {
  const member = newState?.member ?? oldState?.member;
  if (!member || member.user.bot) return;

  // Activity tracking is always on (silent tracking)
  // MVP awards are controlled separately by the Auto/Manual toggle
  await handleVoiceStateChange(member.guild, oldState, newState);
}

export function invalidateConfigCache(guildId) {
  invalidateTrackerCache(guildId);
}

// ============================================
// MISSION PROGRESS TRACKING
// ============================================

// Per-user cooldown map for mission message tracking (separate from XP tracking)
// Key: `${guildId}:${userId}`, Value: timestamp of last counted message
const missionMessageCooldowns = new Map();
const MISSION_MSG_COOLDOWN_MS = 10000; // 10 seconds (Unified with XP system)
const MIN_MESSAGE_LENGTH = 5; // Unified with XP system

/**
 * Check and increment mission progress when a message is sent.
 * Handles: send_messages, upload_images
 * Has its own anti-spam cooldown independent from XP tracking.
 */
async function checkMissionProgress(message) {
  // === PERFORMANCE OPTIMIZATION: Early Cache Check ===
  // Strict Watch-Mode: Exit immediately if this isn't a mission channel
  // Support threads/posts by checking parentId too
  const channelId = message.channel.id;
  const parentId = message.channel.parentId;
  if (!isMissionChannel(message.guild.id, channelId) && (!parentId || !isMissionChannel(message.guild.id, parentId))) return;

  const cachedTracking = isUserTracking(message.guild.id, message.author.id);
  const cachedCompleted = isMissionCompleted(message.guild.id, message.author.id);

  if (cachedCompleted) return;

  // Let the logic determine tracking state (caching handled inside)
  const dbProgress = await getProgress(message.guild.id, message.author.id);
  if (!dbProgress || !dbProgress.active_tracking) return;

  // Sync cache if missing
  if (!cachedTracking) {
    await addUserToMissionsTracking(message.guild.id, message.author.id);
  }

  const config = await getGuildConfig(message.guild.id);
  if (!config?.missions_enabled || !config?.active_mission_id) {
    missionCache.delete(message.guild.id);
    return;
  }

  const mission = await getMission(config.active_mission_id);
  if (!mission) return;

  const content = (message.content || '').trim();
  const hasImage = message.attachments.some(att => {
    const ct = att.contentType || '';
    return ct.startsWith('image/');
  });

  // Determine if this message qualifies
  let qualifies = false;

  if (mission.action_type === 'send_messages') {
    // Text missions follow XP rules: min length 5
    if (content.length >= MIN_MESSAGE_LENGTH) qualifies = true;
  } else if (mission.action_type === 'upload_images') {
    // Image missions count regardless of text length if an image is present
    if (hasImage) qualifies = true;
  }

  if (!qualifies) return;

  // === ANTI-SPAM COOLDOWN (Unified with XP System) ===
  const cooldownKey = `${message.guild.id}:${message.author.id}`;
  const now = Date.now();
  const lastCounted = missionMessageCooldowns.get(cooldownKey) || 0;
  if (now - lastCounted < MISSION_MSG_COOLDOWN_MS) {
    return; // Too fast, skip this message for mission tracking
  }
  missionMessageCooldowns.set(cooldownKey, now);

  const result = await incrementProgress(
    message.guild.id,
    message.author.id,
    mission.id,
    mission.required_count
  );

  if (result.justCompleted) {
    // Add to completion cache immediately
    const data = missionCache.get(message.guild.id);
    if (data) data.completedUsers.add(message.author.id);
    
    // Auto-rewards removed as requested. User must now claim via /mission
  }
}


/**
 * Check if a channel is the current active mission channel for the guild.
 */
export function isMissionChannel(guildId, channelId, parentId = null) {
  const data = missionCache.get(guildId);
  if (!data) return false;
  return data.channelId === channelId || (parentId && data.channelId === parentId);
}

/**
 * Check if a user has already completed today's mission.
 */
export function isMissionCompleted(guildId, userId) {
  const data = missionCache.get(guildId);
  return data?.completedUsers?.has(userId) || false;
}

/**
 * Check if a user is tracking today's mission.
 */
export function isUserTracking(guildId, userId) {
  const data = missionCache.get(guildId);
  return data?.trackingUsers?.has(userId) || false;
}

/**
 * Update the mission activity cache for a guild.
 */
export function syncMissionChannelCache(guildId, channelId, resetAll = false) {
  if (channelId) {
    const existing = missionCache.get(guildId) || { completedUsers: new Set(), trackingUsers: new Set() };
    missionCache.set(guildId, { 
      channelId, 
      completedUsers: resetAll ? new Set() : existing.completedUsers,
      trackingUsers: resetAll ? new Set() : existing.trackingUsers
    });
  } else {
    missionCache.delete(guildId);
  }
}

/**
 * Add a user to the tracking cache
 */
export async function addUserToMissionsTracking(guildId, userId) {
  let data = missionCache.get(guildId);
  
  if (!data) {
    // Cache miss: try to recover by fetching active mission
    try {
      const { getGuildConfig } = await import('../storage/config.js');
      const { getMission } = await import('../missions/missions.js');
      const config = await getGuildConfig(guildId);
      
      if (config?.missions_enabled && config?.active_mission_id) {
        const mission = await getMission(config.active_mission_id);
        if (mission) {
          syncMissionChannelCache(guildId, mission.channel_id);
          data = missionCache.get(guildId);
        }
      }
    } catch (e) {
      console.error('[Missions] Cache recovery failed:', e);
    }
  }

  if (data) {
    data.trackingUsers.add(userId);
  }
}

/**
 * Check reaction-based mission progress.
 */
export async function checkReactionMission(reaction, user) {
  if (user.bot) return;

  const message = reaction.message;
  const guildId = message.guildId;
  const channelId = message.channelId;
  const userId = user.id;
  if (!guildId) return;

  // === PERFORMANCE OPTIMIZATION: Early Cache Check ===
  const data = missionCache.get(guildId);
  if (!data) return;
  
  const parentId = reaction.message.channel?.parentId;
  if (!isMissionChannel(guildId, channelId, parentId)) return;
  
  if (!data.trackingUsers.has(userId) || data.completedUsers.has(userId)) return;

  const { getGuildConfig } = await import('../storage/config.js');
  const config = await getGuildConfig(guildId);
  if (!config?.missions_enabled || !config?.active_mission_id) {
    missionCache.delete(guildId);
    return;
  }

  const { getMission, incrementProgress, formatActionType } = await import('../missions/missions.js');
  const mission = await getMission(config.active_mission_id);
  
  if (!mission) {
    missionCache.delete(guildId);
    return;
  }

  // Update cache if it was missing or outdated
  if (data.channelId !== mission.channel_id) {
    data.channelId = mission.channel_id;
  }

  // Final check: only handle 'react_images' type in the specific channel (including threads)
  if (mission.action_type !== 'react_images' || !isMissionChannel(guildId, channelId, parentId)) return;

  const result = await incrementProgress(
    message.guild.id,
    user.id,
    mission.id,
    mission.required_count
  );

  if (result.justCompleted) {
    // Add to completion cache immediately
    if (data) data.completedUsers.add(userId);
    // Auto-rewards removed. User must claim via /mission
  }
}

/**
 * Check voice mission progress.
 * Called from the voice points tick interval in tracker.js.
 * 
 * Guardrails:
 * - AFK channel check: skip if user is in guild's AFK channel
 * - Deafened check: skip if server-deafened or self-deafened
 * - Cumulative: progress is stored in DB, so disconnects don't reset it
 *   (two 15-minute sessions count toward a 30-minute goal)
 * 
 * @param {string} guildId
 * @param {string} userId
 * @param {string} channelId - The voice channel the user is in
 * @param {number} minutesAdded - How many minutes were just awarded
 * @param {object} voiceState - The member's current voice state (for AFK/deaf checks)
 */
export async function checkVoiceMission(guildId, userId, channelId, minutesAdded, voiceState) {
  try {
    // === AFK / DEAFENED PROTECTION ===
    const data = missionCache.get(guildId);
    if (!data || channelId !== data.channelId) return;
    if (!data.trackingUsers.has(userId) || data.completedUsers.has(userId)) return;

    const { getGuildConfig } = await import('../storage/config.js');
    const config = await getGuildConfig(guildId);
    if (!config?.missions_enabled || !config?.active_mission_id) return;

    const { getMission, incrementProgress, formatActionType } = await import('../missions/missions.js');
    const mission = await getMission(config.active_mission_id);
    if (!mission || mission.action_type !== 'voice_minutes') return;
    if (channelId !== mission.channel_id) return;

    const result = await incrementProgress(
      guildId,
      userId,
      mission.id,
      mission.required_count,
      minutesAdded
    );

    if (result.justCompleted) {
      // Add to cache
      if (data) data.completedUsers.add(userId);
      // Auto-rewards removed. User must claim via /mission
    }
  } catch {
    // Silent fail — never crash core voice tracking
  }
}
