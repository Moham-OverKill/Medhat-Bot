// In-memory activity tracking (resets after each MVP award)
const guildActivity = new Map();

export function getGuildActivity(guildId) {
  if (!guildActivity.has(guildId)) {
    guildActivity.set(guildId, {
      users: new Map(),
      voiceSessions: new Map()
    });
  }
  return guildActivity.get(guildId);
}

export function getUserActivity(guildId, userId) {
  const guild = getGuildActivity(guildId);
  if (!guild.users.has(userId)) {
    guild.users.set(userId, {
      messages: 0,
      voiceMinutes: 0,
      lastActive: new Date(),
      lastMessageTime: 0
    });
  }
  return guild.users.get(userId);
}

export function resetGuildActivity(guildId) {
  guildActivity.delete(guildId);
}

export function addMessagePoint(guildId, userId) {
  const user = getUserActivity(guildId, userId);
  const now = Date.now();
  
  // Apply 5-second cooldown per user
  if (now - user.lastMessageTime >= 5000) {
    user.messages++;
    user.lastActive = new Date();
    user.lastMessageTime = now;
    console.log(`💬 Message point -> ${userId} (total=${user.messages})`);
    return true;
  }
  return false;
}

export function getVoiceSession(guildId, userId) {
  const guild = getGuildActivity(guildId);
  if (!guild.voiceSessions.has(userId)) {
    guild.voiceSessions.set(userId, {
      startTime: null,
      lastTick: null,
      isEligible: false,
      currentChannelId: null
    });
  }
  return guild.voiceSessions.get(userId);
}

export function startVoiceSession(guildId, userId, channelId) {
  const session = getVoiceSession(guildId, userId);
  const now = Date.now();
  
  session.startTime = now;
  session.lastTick = now;
  session.currentChannelId = channelId;
  session.isEligible = false;
  
  console.log(`🎤 Voice tracking started for ${userId} in channel ${channelId}`);
}

export function endVoiceSession(guildId, userId) {
  const session = getVoiceSession(guildId, userId);
  const user = getUserActivity(guildId, userId);
  
  if (session.startTime && session.isEligible) {
    const elapsedMinutes = Math.floor((Date.now() - session.startTime) / 60000);
    if (elapsedMinutes > 0) {
      user.voiceMinutes += elapsedMinutes;
      user.lastActive = new Date();
      console.log(`🎤 Voice session ended for ${userId} (+${elapsedMinutes} min, total=${user.voiceMinutes})`);
    }
  }
  
  // Reset session
  session.startTime = null;
  session.lastTick = null;
  session.isEligible = false;
  session.currentChannelId = null;
}

export function updateVoiceEligibility(guildId, userId, isEligible) {
  const session = getVoiceSession(guildId, userId);
  const user = getUserActivity(guildId, userId);
  
  if (isEligible && !session.isEligible) {
    // Resume tracking
    session.isEligible = true;
    session.lastTick = Date.now();
    console.log(`🎤 Voice tracking resumed for ${userId}`);
  } else if (!isEligible && session.isEligible) {
    // Pause and bank time
    const elapsedMinutes = Math.floor((Date.now() - session.lastTick) / 60000);
    if (elapsedMinutes > 0) {
      user.voiceMinutes += elapsedMinutes;
      user.lastActive = new Date();
      console.log(`⏸️ Voice tracking paused for ${userId} (+${elapsedMinutes} min, total=${user.voiceMinutes})`);
    }
    session.isEligible = false;
  }
}

export function voiceTick(guildId) {
  const guild = getGuildActivity(guildId);
  const now = Date.now();
  
  for (const [userId, session] of guild.voiceSessions) {
    if (session.isEligible && session.lastTick) {
      const elapsedMinutes = Math.floor((now - session.lastTick) / 60000);
      if (elapsedMinutes > 0) {
        const user = getUserActivity(guildId, userId);
        user.voiceMinutes += elapsedMinutes;
        user.lastActive = new Date();
        session.lastTick = now;
        console.log(`🎤 Voice tick for ${userId} (+${elapsedMinutes} min, total=${user.voiceMinutes})`);
      }
    }
  }
}
