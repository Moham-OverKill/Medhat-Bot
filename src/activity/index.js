import { 
  addMessagePoint, 
  getVoiceSession, 
  startVoiceSession, 
  endVoiceSession, 
  updateVoiceEligibility,
  voiceTick 
} from './tracker.js';

let client = null;
let voiceTickInterval = null;

export async function initializeActivityTracking(discordClient) {
  client = discordClient;
  
  // Set up message tracking
  client.on('messageCreate', handleMessage);
  
  // Set up voice state tracking
  client.on('voiceStateUpdate', handleVoiceStateUpdate);
  
  // Start periodic voice tick (every 15 seconds)
  voiceTickInterval = setInterval(() => {
    for (const guild of client.guilds.cache.values()) {
      voiceTick(guild.id);
    }
  }, 15000);
  
  console.log('✅ Activity tracking initialized');
}

function handleMessage(message) {
  // Ignore bots, webhooks, and DMs
  if (message.author.bot || message.webhookId || !message.guild) return;
  
  addMessagePoint(message.guild.id, message.author.id);
}

function handleVoiceStateUpdate(oldState, newState) {
  // Ignore bots
  if (newState.member.user.bot) return;
  
  const guildId = newState.guild.id;
  const userId = newState.id;
  
  // User left voice channel
  if (!newState.channel) {
    if (oldState.channel) {
      endVoiceSession(guildId, userId);
    }
    return;
  }
  
  // User joined or switched voice channel
  const channelId = newState.channel.id;
  const wasInVoice = oldState.channel !== null;
  const switchedChannel = wasInVoice && oldState.channel.id !== channelId;
  
  if (!wasInVoice || switchedChannel) {
    startVoiceSession(guildId, userId, channelId);
  }
  
  // Check eligibility for voice points
  const isEligible = checkVoiceEligibility(newState);
  updateVoiceEligibility(guildId, userId, isEligible);
}

function checkVoiceEligibility(voiceState) {
  // User must not be self-muted or self-deafened
  if (voiceState.selfMute || voiceState.selfDeaf) return false;
  
  // Channel must have at least one other non-bot member who is also unmuted and undeafened
  const channel = voiceState.channel;
  if (!channel) return false;
  
  const eligibleMembers = channel.members.filter(member => 
    !member.user.bot && 
    !member.voice.selfMute && 
    !member.voice.selfDeaf &&
    member.id !== voiceState.id
  );
  
  return eligibleMembers.size > 0;
}
