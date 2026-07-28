// Activity Tracking System - Anti-Spam & Balanced Scoring
import {
  addMessagePoint,
  getCachedGuildConfig,
  invalidateConfigCache as invalidateTrackerCache,
  handleVoiceStateChange,
  voicePointsTick,
  clearStaleVoiceTracking
} from './tracker.js';
import { sanitizeError, runInGuildContext } from '../shared.js';
import { getGuildConfig } from '../storage/config.js';
import { getTodayCairo } from '../utils/time.js';
import { sysLog, sysError } from '../utils/logger.js';

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

// Set of guild IDs currently being sync'd to avoid race conditions
const syncingGuilds = new Set();

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
  client.on('messageUpdate', handleMessageUpdate);
  client.on('messageDelete', handleMessageDelete);

  // Set up voice state tracking (event-based stopwatch)
  client.on('voiceStateUpdate', handleVoiceStateUpdate);

  // Voice points tick every 30 seconds (awards +1 per 60s of valid time)
  tickInterval = setInterval(async () => {
    try {
      await voicePointsTick(client);
    } catch (error) {
      sysError('Activity Heart-Beat Sync Error', error, { detail: 'Voice points tick' });
    }
  }, 30000);

  // Pre-populate quest cache on startup
  try {
    const { getPool } = await import('../storage/postgres.js');
    const pool = getPool();
    
    // Load all quests into memory
    const allQuests = await pool.query(`SELECT * FROM quests`);
    const questsById = new Map();
    allQuests.rows.forEach(q => questsById.set(q.id, q));

    // NEW ROBUST QUERY: Fetch any guild that has active quest IDs synced in their config
    const configResult = await pool.query(`
      SELECT guild_id, config 
      FROM guild_configs 
      WHERE (config->>'active_quest_ids') IS NOT NULL 
        AND jsonb_array_length((config->'active_quest_ids')::jsonb) > 0
    `);
    
    for (const row of configResult.rows) {
      const snapshot = row.config.active_quest_snapshot;
      if (snapshot && Array.isArray(snapshot) && snapshot.length > 0) {
        // Snapshot Architecture: Prioritize the frozen snapshot from config
        activeQuestsCache.set(row.guild_id, snapshot);
      } else {
        // Fallback for legacy configs that only have IDs
        const activeIds = row.config.active_quest_ids || [];
        const activeQuests = activeIds.map(id => questsById.get(id)).filter(Boolean);
        if (activeQuests.length > 0) {
          activeQuestsCache.set(row.guild_id, activeQuests);
        }
      }
    }

    // Always ensure completed cache exists for any guild with active quests
    for (const guildId of activeQuestsCache.keys()) {
      if (!completedQuestsCache.has(guildId)) {
        completedQuestsCache.set(guildId, new Map());
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

    sysLog('Quest Cache Audit', { detail: `Watch-mode tracking ready | Guilds: ${activeQuestsCache.size}` });

    // PERFORM INITIAL VOICE SWEEP (Fix for ghosting on startup)
    const { syncVoicePresence } = await import('./tracker.js');
    sysLog('Presence Audit', { detail: 'Performing initial voice sync for all guilds' });
    for (const [id, guild] of client.guilds.cache) {
      await syncVoicePresence(guild);
    }
  } catch (err) {
    sysError('Quest Cache Warmup Failed', err);
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
    client.removeListener('messageUpdate', handleMessageUpdate);
    client.removeListener('messageDelete', handleMessageDelete);
    client.removeListener('voiceStateUpdate', handleVoiceStateUpdate);
  }

  invalidateTrackerCache();
  handlersInitialized = false;
}

async function handleMessage(message) {
  // Ignore bots, webhooks, and DMs, and safely handle partials missing authors
  if (!message.author || message.author.bot || message.webhookId || !message.guild) return;

  return runInGuildContext(message.guild.id, async () => {
    // === CONTENT FILTER CHECK (early guard) ===
    try {
      const { checkContentFilter, processAutoReact } = await import('../middleware/organize.js');
      const shouldDelete = await checkContentFilter(message);
      if (shouldDelete) {
        await message.delete().catch(() => {});
        return; // Do NOT track activity for deleted messages
      }
      
      // === AUTO REACT ===
      processAutoReact(message).catch(err => sysError('Auto React Background Failure', err));

    } catch (error) {
      // Never let filter errors block activity tracking
      sysError('Content Filter Check Failed', error, { guild: message.guild?.id, channel: message.channel?.id });
    }

    addMessagePoint(message.guild, message.author.id, message.author.username, message.content);

    // === QUEST PROGRESS TRACKING ===
    try {
      await checkQuestProgress(message);
    } catch (error) {
      // Log — do NOT silently swallow. Silent failures make bugs invisible.
      sysError('Quest Progress Check Failed', error, { guild: message.guild?.id, user: message.author?.id });
    }
  });
}

/**
 * Handle message edits to prevent filter bypass.
 */
async function handleMessageUpdate(oldMessage, newMessage) {
  // Guard: Ignore bots, webhooks, DMs, and partials
  if (!newMessage.author || newMessage.author.bot || newMessage.webhookId || !newMessage.guild) return;

  // Guard: Only proceed if content or attachments changed (avoids loops on embed unfurling)
  const contentChanged = oldMessage.content !== newMessage.content;
  const attachmentsChanged = oldMessage.attachments?.size !== newMessage.attachments?.size;
  if (!contentChanged && !attachmentsChanged) return;

  return runInGuildContext(newMessage.guild.id, async () => {
    try {
      const { checkContentFilter } = await import('../middleware/organize.js');
      
      // Enforce Organize Rules on the edited content
      const shouldDelete = await checkContentFilter(newMessage);
      if (shouldDelete) {
        await newMessage.delete().catch(() => {});
        return;
      }

    } catch (error) {
      sysError('Message Update Guard Failed', error, { guild: newMessage.guild.id });
    }
  });
}

/**
 * Handle message deletions to clean up orphaned bot replies.
 */
async function handleMessageDelete(message) {
  const guildId = message.guild?.id || message.guildId;
  return runInGuildContext(guildId, async () => {
    // Use the local client reference to fetch the channel if message.channel is partial/missing
    const channel = message.channel || await client.channels.fetch(message.channelId).catch(() => null);
    if (!channel) return;
    
    try {
      const { handleFixedEmbedCleanup } = await import('../middleware/organize.js');
      await handleFixedEmbedCleanup(channel, message.id);
    } catch (error) {
      // Fail silently, just a cleanup task
    }
  });
}

async function handleVoiceStateUpdate(oldState, newState) {
  const member = newState?.member ?? oldState?.member;
  if (!member || member.user.bot) return;

  return runInGuildContext(member.guild.id, async () => {
    await handleVoiceStateChange(member.guild, oldState, newState);
  });
}

export function invalidateConfigCache(guildId) {
  invalidateTrackerCache(guildId);
}

/**
 * Fast-check if a channel is active for quests
 */
export async function isQuestChannel(guildId, channelId, parentId = null) {
  // LAZY LOAD: Ensure cache exists for validation
  if (!activeQuestsCache.has(guildId)) {
    await syncQuestChannelCache(guildId);
  }

  const quests = activeQuestsCache.get(guildId);
  if (!quests || quests.length === 0) return false;
  return quests.some(q => q.channel_id === channelId || (parentId && q.channel_id === parentId));
}

// ============================================
// QUEST PROGRESS TRACKING ENGINE
// ============================================

const questMessageCooldowns = new Map();
const QUEST_MSG_COOLDOWN_MS = 3000; // 3 seconds (Reduced from 10s for better feel)
const MIN_MESSAGE_LENGTH = 3;

// P-09 FIX: Periodic cleanup to prevent unbounded growth
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of questMessageCooldowns.entries()) {
    if (now - timestamp > 30000) questMessageCooldowns.delete(key);
  }
}, 5 * 60 * 1000);

// Discord ChannelType values for Post channels
const POST_CHANNEL_TYPES = new Set([15, 16]); // GuildForum = 15, GuildMedia = 16

/**
 * Returns true if the channel (or its parent) is a Forum or Media "Post" channel.
 * Robust implementation that handles partial caches.
 */
async function isPostChannel(channel) {
  if (!channel) return false;
  
  // 1. Direct type check (for the channel itself)
  if (POST_CHANNEL_TYPES.has(channel.type)) return true;

  // 2. Thread check (Threads in Forum/Media share parent type)
  if (channel.isThread?.()) {
    // Proactive Parent Fetch: If parent is missing from cache, fetch it once
    if (!channel.parent && channel.parentId) {
      try {
        await channel.client.channels.fetch(channel.parentId).catch(() => null);
      } catch {}
    }

    if (channel.parent && POST_CHANNEL_TYPES.has(channel.parent.type)) return true;
    
    // Final fallback: try fetching the parent type directly from ID
    if (channel.parentId) {
      const parent = channel.client.channels.cache.get(channel.parentId);
      if (parent && POST_CHANNEL_TYPES.has(parent.type)) return true;
    }
  }

  return false;
}

/**
 * Checks all active quests for a message.
 * Applies Dual-Logic: different rules for Normal vs Post (Forum/Media) channels.
 */
async function checkQuestProgress(message) {
  const guildId = message.guild.id;
  
  const quests = activeQuestsCache.get(guildId);
  if (!quests) {
    await syncQuestChannelCache(guildId);
  }

  const finalQuests = activeQuestsCache.get(guildId);
  if (!finalQuests || finalQuests.length === 0) return;

  const actualChannelId = message.channel.id;
  let actualParentId = message.channel.parentId;

  // Robust Parent ID fetching for threads
  if (!actualParentId && message.channel.isThread?.()) {
    try {
      const fetched = await message.client.channels.fetch(actualChannelId).catch(() => null);
      if (fetched?.parentId) actualParentId = fetched.parentId;
    } catch {}
  }

  let content = '';
  let hasAttachments = false;
  let hasSticker = false;
  let hasMedia = false;
  let isThreadStarter = false;
  let inPostChannel = false;

  const userId = message.author.id;
  const cooldownKey = `${guildId}:${userId}`;

  try {
    content = (message.content || '').trim();
    hasAttachments = (message.attachments?.size || 0) > 0;
    hasSticker = (message.stickers?.size || 0) > 0;
    
    const hasEmbedMedia = message.embeds?.some(e => e.image || e.video || e.thumbnail);
    const hasMediaUrl = content.includes('cdn.discordapp.com') || 
                        content.includes('media.discordapp.net') ||
                        /https?:\/\/[^\s<>]+\.(png|jpe?g|gif|webp|mp4|mov|webm)/i.test(content) ||
                        /(youtube\.com|youtu\.be|tiktok\.com|instagram\.com|x\.com|twitter\.com|tenor\.com|imgur\.com)/i.test(content);

    hasMedia = hasAttachments || hasEmbedMedia || hasMediaUrl;

    const isThread = message.channel.isThread?.() || false;
    inPostChannel = await isPostChannel(message.channel);

    isThreadStarter = isThread && (
      message.id === message.channel.id ||
      (message.channel.starterMessageId && message.id === message.channel.starterMessageId) ||
      (!message.reference && message.channel.ownerId === userId && (message.channel.messageCount === undefined || message.channel.messageCount <= 1))
    );
  } catch (error) {
    sysError('Message Parse Error (Quest Engine)', error, { user: userId, guild: guildId, detail: 'Failed to read message properties' });
    return; // Fast fail
  }

  // ──────────────────────────────────────────────────────────────────────────

  let cooldownApplied = false;

  for (const quest of finalQuests) {
    // 1. Channel Isolation & Container Matching (Threads/Posts/Normal)
    const isChannelMatch = (quest.channel_id === actualChannelId || quest.channel_id === actualParentId);
    if (!isChannelMatch) continue;
    
    // 2. Completion Check
    const guildCompletions = completedQuestsCache.get(guildId);
    if (guildCompletions?.get(quest.id)?.has(userId)) continue;

    // 3. Dual-Logic Action Type Qualification
    let qualifies = false;

    if (quest.action_type === 'send_messages') {
      if (inPostChannel) {
        // POST CHANNEL: Only comments qualify (NOT the new-post starter message)
        qualifies = !isThreadStarter && (content.length >= MIN_MESSAGE_LENGTH || hasSticker || hasMedia);
      } else {
        // NORMAL CHANNEL: Any message with text, sticker, or media counts
        qualifies = content.length >= MIN_MESSAGE_LENGTH || hasSticker || hasMedia;
      }
    } else if (quest.action_type === 'upload_images') {
      if (inPostChannel) {
        // POST CHANNEL: New post starter message with media qualifies
        qualifies = isThreadStarter && hasMedia;
      } else {
        // NORMAL CHANNEL: Any message with media counts
        qualifies = hasMedia;
      }
    }

    if (!qualifies) continue;

    // 4. Targeted Anti-Spam (Only applies if a quest qualifies)
    if (!cooldownApplied) {
      const now = Date.now();
      const lastCounted = questMessageCooldowns.get(cooldownKey) || 0;
      if (now - lastCounted < QUEST_MSG_COOLDOWN_MS) {
        // Descriptive log for debugging "stuck" progress
        const remaining = Math.ceil((QUEST_MSG_COOLDOWN_MS - (now - lastCounted)) / 1000);
        sysLog('Quest Progress Skipped', { user: userId, guild: guildId, detail: `Rate-limited: ${remaining}s left | QuestID: ${quest.id}` });
        return; 
      }
      questMessageCooldowns.set(cooldownKey, now);
      cooldownApplied = true;
    }

    // 5. Atomic Update
    try {
        const { incrementProgressAndPayout } = await import('../quests/quests.js');
        const result = await incrementProgressAndPayout(guildId, userId, quest);
        
        const context = inPostChannel
          ? (isThreadStarter ? 'New Post' : 'Comment')
          : 'Message';
        sysLog('Quest Progress Captured', { user: userId, guild: guildId, detail: `QuestID: ${quest.id} | Type: ${quest.action_type} | Context: ${context}` });

        if (result.completed) {
          // Re-fetch the map in case it was just created in this cycle
          if (!completedQuestsCache.has(guildId)) completedQuestsCache.set(guildId, new Map());
          const map = completedQuestsCache.get(guildId);
          if (!map.has(quest.id)) map.set(quest.id, new Set());
          map.get(quest.id).add(userId);
        }
    } catch (e) {
        sysError('Quest Progress Update Failed', e, { user: userId, guild: guildId, detail: `QuestID: ${quest.id}` });
    }
  }
}

/**
 * Cache sync helper — called when config changes.
 * SAFE: Never wipes an active cache unless quests are explicitly disabled.
 */
export async function syncQuestChannelCache(guildId) {
  try {
    const config = await getGuildConfig(guildId);

    // Only wipe the cache if quests are EXPLICITLY turned OFF
    // If config is missing/null (transient error), we KEEP existing cache for safety.
    if (config?.quests_enabled === false || config?.missions_enabled === false) {
      activeQuestsCache.set(guildId, []);
      completedQuestsCache.delete(guildId);
      
      sysLog('Quest Cache Maintenance', { guild: guildId, detail: 'Cleared memory cache: quests explicitly disabled' });
      return;
    }

    // Snapshot Architecture: Prioritize the frozen snapshot from config
    let activeQuests = [];
    if (config?.active_quest_snapshot && Array.isArray(config.active_quest_snapshot) && config.active_quest_snapshot.length > 0) {
      activeQuests = config.active_quest_snapshot;
    } else {
        // No snapshot = no active quests. 
        // We do NOT fall back to active_quest_ids anymore to prevent "Hidden Quests" 
        // from tracking in the background after a manual pool modification.
    }

    if (activeQuests.length > 0) {
      activeQuestsCache.set(guildId, activeQuests);
    } else {
      // Explicitly clear stale cache — do not leave old quests in memory
      activeQuestsCache.set(guildId, []);
    }

    // Rebuild completed cache directly from DB to clear stale ghosts from previous cycles
    const { getPool } = await import('../storage/postgres.js');
    const pool = getPool();
    
    const statusResult = await pool.query(`
      SELECT user_id, quest_id 
      FROM quest_progress 
      WHERE guild_id = $1 AND completed = true AND quest_date = $2
    `, [guildId, getTodayCairo()]);

    const newCompletionMap = new Map();
    for (const row of statusResult.rows) {
      if (!newCompletionMap.has(row.quest_id)) newCompletionMap.set(row.quest_id, new Set());
      newCompletionMap.get(row.quest_id).add(row.user_id);
    }
    completedQuestsCache.set(guildId, newCompletionMap);

    sysLog('Quest Cache Sync', { guild: guildId, detail: `Tracking ${activeQuests.length} quest(s)` });
  } catch (e) {
    sysError('Quest Cache Sync Failed', e, { guild: guildId });
    // On error, never wipe the existing cache — stale is safer than empty
  }
}

/**
 * Check reaction-based quest progress.
 */
export async function checkReactionQuest(reaction, user) {
  if (!user || user.bot) return;

  const guildId = reaction.message?.guildId;
  if (!guildId) return;


  let quests = activeQuestsCache.get(guildId);
  if (quests === undefined) {
    if (syncingGuilds.has(guildId)) return;
    syncingGuilds.add(guildId);
    try {
        await syncQuestChannelCache(guildId);
    } finally {
        syncingGuilds.delete(guildId);
    }
    quests = activeQuestsCache.get(guildId);
  }

  if (!quests || quests.length === 0) return;

  const channelId = reaction.message.channelId;
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

  // ── Dual-Logic: Determine if this reaction is on the Original Post ─────────
  let inPostChannel = false;
  let isOriginalPost = false;
  
  try {
    const reactChannel = reaction.message.channel;
    inPostChannel = await isPostChannel(reactChannel);
    const isThread = reactChannel.isThread?.() || false;
    isOriginalPost = inPostChannel
      ? (isThread && (
          reaction.message.id === reactChannel.id ||
          (reactChannel.starterMessageId && reaction.message.id === reactChannel.starterMessageId) ||
          (!reaction.message.reference && reactChannel.ownerId === reaction.message.author?.id)
        ))
      : true; // Normal channels: any message qualifies
  } catch (err) {
    sysError('Reaction Parse Error (Quest Engine)', err, { user: userId, guild: guildId });
    return; // Fast fail
  }
  // ──────────────────────────────────────────────────────────────────────────

  for (const quest of quests) {
    if (quest.action_type !== 'react_images') continue;
    if (quest.channel_id !== channelId && quest.channel_id !== parentId) continue;

    // POST CHANNEL: Only reactions on the Original Post count
    if (inPostChannel && !isOriginalPost) continue;
    
    const guildCompletions = completedQuestsCache.get(guildId);
    if (guildCompletions?.get(quest.id)?.has(userId)) continue;

    try {
        const { incrementProgressAndPayout } = await import('../quests/quests.js');
        const result = await incrementProgressAndPayout(guildId, userId, quest);
        
        const context = inPostChannel ? 'Original Post' : 'Message';
        sysLog('Quest Progress Captured', { user: userId, guild: guildId, detail: `Source: Reaction | Context: ${context} | QuestID: ${quest.id}` });

        if (result.completed) {
          if (!completedQuestsCache.has(guildId)) completedQuestsCache.set(guildId, new Map());
          const map = completedQuestsCache.get(guildId);
          if (!map.has(quest.id)) map.set(quest.id, new Set());
          map.get(quest.id).add(userId);
        }
    } catch (e) {
        sysError('Quest Progress Update Failed', e, { user: userId, guild: guildId, detail: `Source: Reaction | QuestID: ${quest.id}` });
    }
  }
}

/**
 * Check voice quest progress.
 */
export async function checkVoiceQuest(guildId, userId, channelId, minutesAdded, voiceState) {
  try {
    // LAZY LOAD: If cache is missing, attempt one-time sync before skipping
    if (!activeQuestsCache.has(guildId)) {
      await syncQuestChannelCache(guildId);
    }

    const quests = activeQuestsCache.get(guildId);
    if (!quests || quests.length === 0) return;

    for (const quest of quests) {
      if (quest.action_type !== 'voice_minutes') continue;
      
      // Robust Voice Matching: Match channel ID OR Category parent ID
      const isChannelMatch = (quest.channel_id === channelId || (voiceState?.channel?.parentId === quest.channel_id));
      if (!isChannelMatch) continue;
      
      const guildCompletions = completedQuestsCache.get(guildId);
      if (guildCompletions?.get(quest.id)?.has(userId)) continue;

      sysLog('Quest Progress Captured', { user: userId, guild: guildId, detail: `Source: Voice | QuestID: ${quest.id} | Minutes: ${minutesAdded}` });

      const { incrementProgressAndPayout } = await import('../quests/quests.js');
      const result = await incrementProgressAndPayout(guildId, userId, quest, minutesAdded);
      
      if (result.completed) {
        if (!completedQuestsCache.has(guildId)) completedQuestsCache.set(guildId, new Map());
        const map = completedQuestsCache.get(guildId);
        if (!map.has(quest.id)) map.set(quest.id, new Set());
        map.get(quest.id).add(userId);
      }
    }
  } catch (e) {
    // Silent fail
  }
}
