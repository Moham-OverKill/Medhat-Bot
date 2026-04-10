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
import { incrementProgressAndPayout, getQuests } from '../quests/quests.js';
import { getGuildConfig } from '../storage/config.js';
import { getTodayCairo } from '../utils/time.js';

// Re-export for use in index.js
export { clearStaleVoiceTracking };

// Cache for quest data
// guildId -> Array of active quest objects
const activeQuestsCache = new Map();
// guildId -> Map of questId -> Set of userIds who already completed it today
const completedQuestsCache = new Map();

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

  // Pre-populate quest cache on startup
  try {
    const { getPool } = await import('../storage/postgres.js');
    const pool = getPool();
    
    // Load all quests into memory
    const allQuests = await pool.query(`SELECT * FROM quests`);
    const questsById = new Map();
    allQuests.rows.forEach(q => questsById.set(q.id, q));

    // Map active quests per guild
    const configResult = await pool.query(`SELECT guild_id, config FROM guild_configs WHERE (config->>'quests_enabled')::boolean = true AND config->>'active_quest_ids' IS NOT NULL`);
    
    for (const row of configResult.rows) {
      const activeIds = row.config.active_quest_ids || [];
      const activeQuests = activeIds.map(id => questsById.get(id)).filter(Boolean);
      if (activeQuests.length > 0) {
        activeQuestsCache.set(row.guild_id, activeQuests);
        completedQuestsCache.set(row.guild_id, new Map());
      }
    }

    // Load completed state for today
    const statusResult = await pool.query(`
      SELECT guild_id, user_id, quest_id 
      FROM quest_progress 
      WHERE completed = true AND quest_date = $1
    `, [getTodayCairo()]);

    for (const row of statusResult.rows) {
      const guildCompletions = completedQuestsCache.get(row.guild_id);
      if (guildCompletions) {
        if (!guildCompletions.has(row.quest_id)) guildCompletions.set(row.quest_id, new Set());
        guildCompletions.get(row.quest_id).add(row.user_id);
      }
    }

    const logPrefix = client.guilds.cache.first()?.name || 'System';
    console.log(`[${logPrefix}] Quests: Watch-mode active tracking ready.`);
  } catch (err) {
    console.error('[Quests] Cache warmup failed:', err);
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

  addMessagePoint(message.guild, message.author.id, message.author.username, message.content);

  // === QUEST PROGRESS TRACKING ===
  try {
    await checkQuestProgress(message);
  } catch (error) {
    // Silent fail — never crash the bot for tracking
  }
}

async function handleVoiceStateUpdate(oldState, newState) {
  const member = newState?.member ?? oldState?.member;
  if (!member || member.user.bot) return;

  await handleVoiceStateChange(member.guild, oldState, newState);
}

export function invalidateConfigCache(guildId) {
  invalidateTrackerCache(guildId);
}

// ============================================
// QUEST PROGRESS TRACKING ENGINE
// ============================================

const questMessageCooldowns = new Map();
const QUEST_MSG_COOLDOWN_MS = 10000;
const MIN_MESSAGE_LENGTH = 5;

/**
 * Checks all active quests for a message
 */
async function checkQuestProgress(message) {
  const guildId = message.guild.id;
  const quests = activeQuestsCache.get(guildId);
  if (!quests || quests.length === 0) return;

  let actualChannelId = message.channel.id;
  let actualParentId = message.channel.parentId;

  if (!actualParentId && message.channel.isThread?.()) {
    const cached = message.guild?.channels.cache.get(actualChannelId);
    if (cached?.parentId) actualParentId = cached.parentId;
    else {
      try {
        const fetched = await message.client.channels.fetch(actualChannelId).catch(() => null);
        if (fetched?.parentId) actualParentId = fetched.parentId;
      } catch {}
    }
  }

  const content = (message.content || '').trim();
  const hasAttachment = message.attachments.size > 0;
  
  const userId = message.author.id;
  const cooldownKey = `${guildId}:${userId}`;
  let processedCooldown = false;

  for (const quest of quests) {
    // Check channel match
    if (quest.channel_id !== actualChannelId && quest.channel_id !== actualParentId) continue;
    
    // Check completion cache
    const guildCompletions = completedQuestsCache.get(guildId);
    if (guildCompletions?.get(quest.id)?.has(userId)) continue;

    let qualifies = false;
    if (quest.action_type === 'send_messages' && content.length >= MIN_MESSAGE_LENGTH) qualifies = true;
    else if (quest.action_type === 'upload_images' && hasAttachment) qualifies = true;

    if (!qualifies) continue;

    // Apply anti-spam
    if (!processedCooldown) {
      const now = Date.now();
      const lastCounted = questMessageCooldowns.get(cooldownKey) || 0;
      if (now - lastCounted < QUEST_MSG_COOLDOWN_MS) return; 
      questMessageCooldowns.set(cooldownKey, now);
      processedCooldown = true;
    }

    // Increment and Auto-Payout
    const result = await incrementProgressAndPayout(guildId, userId, quest);
    if (result.justCompleted) {
      if (!guildCompletions) completedQuestsCache.set(guildId, new Map());
      const map = completedQuestsCache.get(guildId);
      if (!map.has(quest.id)) map.set(quest.id, new Set());
      map.get(quest.id).add(userId);
    }
  }
}

/**
 * Cache sync helper
 */
export async function syncQuestChannelCache(guildId) {
  try {
    const config = await getGuildConfig(guildId);
    if (!config?.quests_enabled || !config?.active_quest_ids) {
      activeQuestsCache.delete(guildId);
      completedQuestsCache.delete(guildId);
      return;
    }

    const { getQuests } = await import('../quests/quests.js');
    const allQuests = await getQuests(guildId);
    
    const activeQuests = allQuests.filter(q => config.active_quest_ids.includes(q.id));
    activeQuestsCache.set(guildId, activeQuests);
    completedQuestsCache.set(guildId, new Map()); // Wipe completions on new sync for the day
  } catch (e) {
    console.error('[Quests] Cache sync failed:', e);
  }
}

/**
 * Check reaction-based quest progress.
 */
export async function checkReactionQuest(reaction, user) {
  if (user.bot) return;

  const guildId = reaction.message.guildId;
  const quests = activeQuestsCache.get(guildId);
  if (!quests || quests.length === 0) return;

  let channelId = reaction.message.channelId;
  let parentId = reaction.message.channel?.parentId;
  
  if (!parentId && reaction.message.guild) {
    const cached = reaction.message.guild.channels.cache.get(channelId);
    if (cached?.parentId) parentId = cached.parentId;
    else {
      try {
        const fetchedChannel = await reaction.message.client.channels.fetch(channelId).catch(() => null);
        if (fetchedChannel?.parentId) parentId = fetchedChannel.parentId;
      } catch (e) {}
    }
  }

  const userId = user.id;

  for (const quest of quests) {
    if (quest.action_type !== 'react_images') continue;
    if (quest.channel_id !== channelId && quest.channel_id !== parentId) continue;
    
    const guildCompletions = completedQuestsCache.get(guildId);
    if (guildCompletions?.get(quest.id)?.has(userId)) continue;

    const result = await incrementProgressAndPayout(guildId, userId, quest);
    if (result.justCompleted) {
      if (!guildCompletions) completedQuestsCache.set(guildId, new Map());
      const map = completedQuestsCache.get(guildId);
      if (!map.has(quest.id)) map.set(quest.id, new Set());
      map.get(quest.id).add(userId);
    }
  }
}

/**
 * Check voice quest progress.
 */
export async function checkVoiceQuest(guildId, userId, channelId, minutesAdded, voiceState) {
  try {
    const quests = activeQuestsCache.get(guildId);
    if (!quests || quests.length === 0) return;

    for (const quest of quests) {
      if (quest.action_type !== 'voice_minutes') continue;
      if (quest.channel_id !== channelId) continue;
      
      const guildCompletions = completedQuestsCache.get(guildId);
      if (guildCompletions?.get(quest.id)?.has(userId)) continue;

      const result = await incrementProgressAndPayout(guildId, userId, quest, minutesAdded);
      if (result.justCompleted) {
        if (!guildCompletions) completedQuestsCache.set(guildId, new Map());
        const map = completedQuestsCache.get(guildId);
        if (!map.has(quest.id)) map.set(quest.id, new Set());
        map.get(quest.id).add(userId);
      }
    }
  } catch (e) {
    // Silent fail
  }
}
