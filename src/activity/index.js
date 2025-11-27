import { 
  addMessagePoint, 
  startVoiceSession, 
  endVoiceSession, 
  updateVoiceEligibility,
  voiceTick,
  getCachedGuildConfig,
  invalidateConfigCache as invalidateTrackerCache,
  getVoiceSession,
  syncEffectiveVoiceState
} from './tracker.js';
import { sanitizeError, getUserDisplayName } from '../shared.js';

let client = null;
let voiceTickInterval = null;
let cacheCleanupInterval = null;
let handlersInitialized = false;

const VOICE_LOG_DEBOUNCE_MS = 2000;
const VOICE_LOG_HISTORY_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Voice tracking log debounce cache
 * Key format: `${guildId}:${userId}`
 * Value: { reason: string, resumed: boolean, timestamp: number }
 * TTL: 2 seconds (implicit, checked on each log attempt)
 * Cleanup: Periodic cleanup every 5 minutes removes entries older than 10 minutes
 */
const voiceLogHistory = new Map();

/**
 * Cleans up old entries from voiceLogHistory to prevent memory leaks
 * Called periodically every 5 minutes
 */
function cleanupVoiceLogHistory() {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, entry] of voiceLogHistory.entries()) {
    if (now - entry.timestamp > VOICE_LOG_HISTORY_MAX_AGE_MS) {
      voiceLogHistory.delete(key);
      cleaned++;
    }
  }
  if (cleaned > 0 && process.env.NODE_ENV !== 'production') {
    console.log(`🧹 Cleaned ${cleaned} old voice log entries`);
  }
}

// Use getUserDisplayName from shared.js for consistent name formatting

function emitTrackingLog(guildId, userId, resumed, username, reason) {
  if (!reason) return;
  const key = `${guildId}:${userId}`;
  const now = Date.now();
  const last = voiceLogHistory.get(key);
  if (last && last.reason === reason && last.resumed === resumed && (now - last.timestamp) < VOICE_LOG_DEBOUNCE_MS) {
    return;
  }
  voiceLogHistory.set(key, { reason, resumed, timestamp: now });

  const emoji = resumed ? '🟢🎙️' : '🔴🎙️';
  const state = resumed ? 'resumed' : 'paused';
  const safeUsername = username || '[User]';
  console.log(`${emoji} | tracking ${state} for ${safeUsername} | ${reason}`);
}

function computeEffectiveFlags(voiceState) {
  if (!voiceState) {
    return { muted: false, deafened: false };
  }
  return {
    muted: Boolean(voiceState.selfMute || voiceState.serverMute),
    deafened: Boolean(voiceState.selfDeaf || voiceState.serverDeaf)
  };
}

function buildTransitionSnapshot(previousFlags, currentFlags) {
  const previousMuted = Boolean(previousFlags?.muted);
  const previousDeafened = Boolean(previousFlags?.deafened);
  const currentMuted = Boolean(currentFlags?.muted);
  const currentDeafened = Boolean(currentFlags?.deafened);

  return {
    previousMuted,
    previousDeafened,
    mutedChanged: previousMuted !== currentMuted,
    deafenedChanged: previousDeafened !== currentDeafened,
    currentMuted,
    currentDeafened
  };
}

function getTransitionHints(transitions) {
  if (!transitions) return {};

  const { previousMuted, previousDeafened, currentMuted, currentDeafened, mutedChanged, deafenedChanged } = transitions;
  if (!mutedChanged && !deafenedChanged) return {};

  if (currentMuted || currentDeafened) {
    if (mutedChanged && currentMuted) {
      return { pauseReason: 'muted' };
    }
    if (deafenedChanged && currentDeafened) {
      return { pauseReason: 'deafened' };
    }
    if (currentMuted) {
      return { pauseReason: 'muted' };
    }
    return { pauseReason: 'deafened' };
  }

  const unmuted = previousMuted && !currentMuted;
  const undeafened = previousDeafened && !currentDeafened;

  if (unmuted) {
    return { resumeReason: 'unmuted' };
  }
  if (undeafened) {
    return { resumeReason: 'undeafened' };
  }

  return {};
}

function ensureSelfReason(hints, transitions, eventType) {
  switch (eventType) {
    case 'mute':
      return { pauseReason: 'muted' };
    case 'deafen':
      return { pauseReason: 'deafened' };
    case 'unmute':
      return { resumeReason: 'unmuted' };
    case 'undeafen':
      return { resumeReason: 'undeafened' };
    default:
      break;
  }

  if (hints.pauseReason || hints.resumeReason) {
    return hints;
  }

  if (transitions) {
    const { mutedChanged, deafenedChanged, currentMuted, currentDeafened } = transitions;
    if (mutedChanged) {
      return currentMuted
        ? { pauseReason: 'muted' }
        : { resumeReason: 'unmuted' };
    }
    if (deafenedChanged) {
      return currentDeafened
        ? { pauseReason: 'deafened' }
        : { resumeReason: 'undeafened' };
    }
  }

  return hints || {};
}

function getVoiceContext(voiceState, overrides = null) {
  if (!voiceState) {
    return {
      channelId: null,
      nonBotCount: 0,
      hasEnoughUsers: false,
      eligible: false
    };
  }

  const overrideState = overrides?.get(voiceState.id);
  if (overrideState === null) {
    return {
      channelId: null,
      nonBotCount: 0,
      hasEnoughUsers: false,
      eligible: false
    };
  }

  const subjectState = overrideState ?? voiceState;
  const channel = subjectState?.channel;
  if (!channel) {
    return {
      channelId: null,
      nonBotCount: 0,
      hasEnoughUsers: false,
      eligible: false
    };
  }

  let nonBotCount = 0;
  let otherEligible = false;

  for (const member of channel.members.values()) {
    if (member.user.bot) continue;

    const memberOverride = overrides?.get(member.id);
    if (memberOverride === null) continue;
    const memberState = memberOverride ?? member.voice;
    if (!memberState?.channel || memberState.channel.id !== channel.id) continue;

    nonBotCount += 1;
    const memberFlags = computeEffectiveFlags(memberState);
    if (member.id !== subjectState.id && !memberFlags.muted && !memberFlags.deafened) {
      otherEligible = true;
    }
  }

  const subjectFlags = computeEffectiveFlags(subjectState);
  const eligible = !subjectFlags.muted && !subjectFlags.deafened && otherEligible;

  return {
    channelId: channel.id,
    nonBotCount,
    hasEnoughUsers: nonBotCount >= 2,
    eligible,
    effectiveMuted: subjectFlags.muted,
    effectiveDeafened: subjectFlags.deafened
  };
}

function describeReasons({
  context,
  hints,
  eventType,
  initialJoin,
  hadEnoughBefore,
  pendingJoin
}) {
  const pauseHint = hints.pauseReason;
  const resumeHint = hints.resumeReason;

  const paused = eventType === 'leave'
    || !!pauseHint
    || !context?.eligible;

  if (paused) {
    const priorities = [
      () => pauseHint,
      () => (eventType === 'leave' ? 'left the call' : null),
      () => (context?.effectiveDeafened ? 'deafened' : null),
      () => (context?.effectiveMuted ? 'muted' : null),
      () => (!context?.hasEnoughUsers ? 'not enough users' : null),
      () => (context?.hasEnoughUsers && !context?.eligible ? 'no eligible users' : null)
    ];

    for (const getReason of priorities) {
      const reason = getReason();
      if (reason) {
        return { resumed: false, reason };
      }
    }

    return { resumed: false, reason: 'not enough users' };
  }

  if (resumeHint === 'undeafened') {
    return { resumed: true, reason: 'undeafened' };
  }

  if (resumeHint === 'unmuted') {
    return { resumed: true, reason: 'unmuted' };
  }

  const joinLike = (initialJoin || pendingJoin || eventType === 'switch') && context?.eligible;
  if (joinLike) {
    return { resumed: true, reason: 'joined a call' };
  }

  if (context) {
    const { hasEnoughUsers, eligible } = context;

    if (!hadEnoughBefore && hasEnoughUsers) {
      return { resumed: true, reason: 'enough users' };
    }

    if (hasEnoughUsers && eligible) {
      return { resumed: true, reason: hadEnoughBefore ? 'enough eligible users' : 'enough users' };
    }

    if (hasEnoughUsers) {
      return { resumed: true, reason: 'enough users' };
    }
  }

  return { resumed: true, reason: 'enough users' };
}

function determineVoiceEventType(oldState, newState) {
  const oldChannel = oldState?.channel ?? null;
  const newChannel = newState?.channel ?? null;
  if (!oldChannel && newChannel) return 'join';
  if (oldChannel && !newChannel) return 'leave';
  if (oldChannel && newChannel && oldChannel.id !== newChannel.id) return 'switch';

  const oldFlags = computeEffectiveFlags(oldState);
  const newFlags = computeEffectiveFlags(newState);

  if (oldFlags.deafened !== newFlags.deafened) return newFlags.deafened ? 'deafen' : 'undeafen';
  if (oldFlags.muted !== newFlags.muted) return newFlags.muted ? 'mute' : 'unmute';
  return 'other';
}

export async function initializeActivityTracking(discordClient) {
  if (handlersInitialized) {
    console.warn('⚠️ Activity tracking already initialized');
    return;
  }
  
  client = discordClient;
  
  // Clear existing interval if any
  if (voiceTickInterval) {
    clearInterval(voiceTickInterval);
  }
  
  // Remove old listeners if they exist (prevents memory leak)
  client.removeListener('messageCreate', handleMessage);
  client.removeListener('voiceStateUpdate', handleVoiceStateUpdate);
  
  // Set up message tracking
  client.on('messageCreate', handleMessage);
  
  // Set up voice state tracking
  client.on('voiceStateUpdate', handleVoiceStateUpdate);
  
  // Start periodic voice tick (every 60 seconds) with cached configs
  voiceTickInterval = setInterval(async () => {
    try {
      for (const guild of client.guilds.cache.values()) {
        const config = await getCachedGuildConfig(guild.id);
        if (config && config.enabled !== false) {
          try {
            await voiceTick(guild.id);
          } catch (error) {
            console.error(`Error during voice tick for guild ${guild.id}:`, sanitizeError(error));
          }
        }
      }
    } catch (error) {
      console.error('Error processing voice tick interval:', sanitizeError(error));
    }
  }, 60000); // Increased from 15s to 60s for better performance
  
  // Start periodic cache cleanup (every 5 minutes)
  cacheCleanupInterval = setInterval(() => {
    try {
      cleanupVoiceLogHistory();
    } catch (error) {
      console.error('Error during cache cleanup:', sanitizeError(error));
    }
  }, 5 * 60 * 1000); // 5 minutes
  
  handlersInitialized = true;
  console.log('✅ Activity tracking initialized');
}

export function cleanup() {
  if (voiceTickInterval) {
    clearInterval(voiceTickInterval);
    voiceTickInterval = null;
  }
  
  if (cacheCleanupInterval) {
    clearInterval(cacheCleanupInterval);
    cacheCleanupInterval = null;
  }
  
  // Remove event listeners
  if (client) {
    client.removeListener('messageCreate', handleMessage);
    client.removeListener('voiceStateUpdate', handleVoiceStateUpdate);
  }
  
  // Clear cached configs
  invalidateTrackerCache();
  
  handlersInitialized = false;
  console.log('✅ Activity tracking cleaned up');
}

async function handleMessage(message) {
  // Ignore bots, webhooks, and DMs
  if (message.author.bot || message.webhookId || !message.guild) return;
  
  // Ignore bot commands (slash commands don't appear as messages, but filter prefix commands)
  if (message.content.startsWith('/') || message.content.startsWith('!') || message.content.startsWith('.')) return;
  
  // Check if MVP is enabled for this guild
  const config = await getCachedGuildConfig(message.guild.id);
  if (!config || config.enabled === false) return;
  
  addMessagePoint(message.guild.id, message.author.id, message.author.username);
}

async function handleVoiceStateUpdate(oldState, newState) {
  const member = newState?.member ?? oldState?.member;
  if (!member || member.user.bot) return;

  const guildId = member.guild.id;
  const userId = member.id;

  const config = await getCachedGuildConfig(guildId);
  if (!config || config.enabled === false) return;

  const username = getUserDisplayName(member);
  const session = getVoiceSession(guildId, userId, username);
  const previouslyHadEnoughUsers = !!session.hadEnoughUsers;
  const hadPendingJoin = !!session.pendingJoinReason;

  const previousFlags = oldState ? computeEffectiveFlags(oldState) : {
    muted: session.effectiveMuted,
    deafened: session.effectiveDeafened
  };
  const newFlags = computeEffectiveFlags(newState);
  const transitions = buildTransitionSnapshot(previousFlags, newFlags);
  syncEffectiveVoiceState(guildId, userId, newFlags.muted, newFlags.deafened, username);

  const eventType = determineVoiceEventType(oldState, newState);
  const hints = ensureSelfReason(getTransitionHints(transitions), transitions, eventType);

  const overridesByChannel = new Map();
  const affectedChannels = new Set();

  if (newState?.channel) {
    affectedChannels.add(newState.channel);
    const override = overridesByChannel.get(newState.channel.id) ?? new Map();
    override.set(userId, newState);
    overridesByChannel.set(newState.channel.id, override);
  }

  if (oldState?.channel) {
    affectedChannels.add(oldState.channel);
    const override = overridesByChannel.get(oldState.channel.id) ?? new Map();
    if (!newState?.channel || newState.channel.id !== oldState.channel.id) {
      override.set(userId, null);
    }
    overridesByChannel.set(oldState.channel.id, override);
  }

  let context = null;
  if (newState?.channel) {
    const overrides = overridesByChannel.get(newState.channel.id);
    context = getVoiceContext(newState, overrides);
  }

  let eligibility = { changed: false, nowEligible: session.isEligible };
  let initialJoin = false;

  switch (eventType) {
    case 'leave':
      context = getVoiceContext(oldState, overridesByChannel.get(oldState.channel?.id));
      endVoiceSession(guildId, userId, username);
      emitTrackingLog(guildId, userId, false, session.username ?? username, 'left the call');
      session.hadEnoughUsers = false;
      break;
    case 'join': {
      initialJoin = true;
      const channelId = newState.channel.id;
      startVoiceSession(guildId, userId, channelId, username);
      const overrides = overridesByChannel.get(channelId);
      context = getVoiceContext(newState, overrides);
      eligibility = updateVoiceEligibility(guildId, userId, context.eligible, username);
      session.hadEnoughUsers = context.hasEnoughUsers;
      session.pendingJoinReason = false;
      break;
    }
    case 'switch': {
      const channelId = newState.channel.id;
      endVoiceSession(guildId, userId, username);
      emitTrackingLog(guildId, userId, false, session.username ?? username, 'left the call');
      startVoiceSession(guildId, userId, channelId, username);
      const overrides = overridesByChannel.get(channelId);
      context = getVoiceContext(newState, overrides);
      eligibility = updateVoiceEligibility(guildId, userId, context.eligible, username);
      session.hadEnoughUsers = context.hasEnoughUsers;
      session.pendingJoinReason = false;
      break;
    }
    case 'mute':
    case 'deafen': {
      if (newState?.channel) {
        const overrides = overridesByChannel.get(newState.channel.id);
        context = getVoiceContext(newState, overrides);
      }
      eligibility = updateVoiceEligibility(guildId, userId, context?.eligible ?? false, username);
      session.hadEnoughUsers = context?.hasEnoughUsers ?? false;
      break;
    }
    case 'unmute':
    case 'undeafen': {
      if (newState?.channel) {
        const overrides = overridesByChannel.get(newState.channel.id);
        context = getVoiceContext(newState, overrides);
      }
      eligibility = updateVoiceEligibility(guildId, userId, context?.eligible ?? false, username);
      session.hadEnoughUsers = context?.hasEnoughUsers ?? false;
      break;
    }
    default: {
      if (newState?.channel) {
        const overrides = overridesByChannel.get(newState.channel.id);
        context = getVoiceContext(newState, overrides);
        eligibility = updateVoiceEligibility(guildId, userId, context.eligible, username);
        session.hadEnoughUsers = context.hasEnoughUsers;
      }
    }
  }

  const shouldLogSelf = eventType === 'join'
    || eventType === 'switch'
    || hints.pauseReason
    || hints.resumeReason
    || eligibility.changed
    || initialJoin;

  if (eventType !== 'leave' && shouldLogSelf) {
    const { resumed, reason } = describeReasons({
      context,
      hints,
      eventType,
      initialJoin,
      hadEnoughBefore: previouslyHadEnoughUsers,
      pendingJoin: initialJoin || hadPendingJoin || session.pendingJoinReason
    });
    if (reason) {
      emitTrackingLog(guildId, userId, resumed, session.username ?? username, reason);
    }
  }

  if (session.pendingJoinReason) {
    session.pendingJoinReason = false;
  }

  for (const channel of affectedChannels) {
    const overrides = overridesByChannel.get(channel.id);
    for (const [memberId, memberObj] of channel.members) {
      if (memberObj.user.bot || memberId === userId) continue;
      const memberSession = getVoiceSession(guildId, memberId, getUserDisplayName(memberObj));
      const memberContext = getVoiceContext(memberObj.voice, overrides);
      const hadEnoughUsersBeforeMember = memberSession.hadEnoughUsers;
      const result = updateVoiceEligibility(guildId, memberId, memberContext.eligible, memberObj.user.username);
      if (!result.changed) continue;

      memberSession.hadEnoughUsers = memberContext.hasEnoughUsers;

      const reason = result.nowEligible
        ? (memberContext.hasEnoughUsers
          ? (hadEnoughUsersBeforeMember ? 'enough eligible users' : 'enough users')
          : 'enough users')
        : (memberContext.hasEnoughUsers ? 'no eligible users' : 'not enough users');
      emitTrackingLog(guildId, memberId, result.nowEligible, memberSession.username ?? getUserDisplayName(memberObj), reason);
    }
  }
}

export function invalidateConfigCache(guildId) {
  invalidateTrackerCache(guildId);
}
