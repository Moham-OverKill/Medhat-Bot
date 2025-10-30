import { EmbedBuilder } from 'discord.js';
import { getGuildActivity, resetGuildActivity, endVoiceSession } from '../activity/tracker.js';
import { getGuildConfig } from '../storage/config.js';

const mvpTimers = new Map();

export async function scheduleMvpTimer(client, guildId) {
  const config = await getGuildConfig(guildId);
  if (!config) return;

  // Cancel existing timer for this guild
  cancelMvpTimer(guildId);

  const intervalMs = config.intervalUnit === 'weeks' 
    ? config.intervalNumber * 7 * 24 * 60 * 60 * 1000
    : config.intervalNumber * 60 * 60 * 1000;

  const timer = setTimeout(async () => {
    try {
      await awardMvp(client, guildId, false);
      // Reschedule for next interval
      await scheduleMvpTimer(client, guildId);
    } catch (error) {
      console.error(`MVP award failed for guild ${guildId}:`, error);
      // Still reschedule even if award fails
      await scheduleMvpTimer(client, guildId);
    }
  }, intervalMs);

  mvpTimers.set(guildId, timer);
  
  const guild = client.guilds.cache.get(guildId);
  console.log(`🕒 Scheduled MVP for ${guild?.name || guildId} in ${intervalMs}ms`);
}

export async function scheduleAllMvpTimers(client) {
  const { loadGuildConfigs } = await import('../storage/config.js');
  const configs = await loadGuildConfigs();
  
  for (const guildId of Object.keys(configs)) {
    await scheduleMvpTimer(client, guildId);
  }
}

export function cancelMvpTimer(guildId) {
  if (mvpTimers.has(guildId)) {
    clearTimeout(mvpTimers.get(guildId));
    mvpTimers.delete(guildId);
  }
}

export async function awardMvp(client, guildId, isTest = false) {
  const config = await getGuildConfig(guildId);
  if (!config) {
    throw new Error('MVP not configured for this guild');
  }

  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    throw new Error('Guild not found');
  }

  // Finalize all voice sessions
  const activity = getGuildActivity(guildId);
  for (const [userId] of activity.voiceSessions) {
    endVoiceSession(guildId, userId);
  }

  // Calculate winners
  const userScores = Array.from(activity.users.entries())
    .map(([userId, data]) => {
      const score = data.messages + data.voiceMinutes;
      return { userId, score, ...data };
    })
    .filter(user => user.score > 0)
    .sort((a, b) => {
      // Sort by score descending, then by lastActivity descending (tie-breaker)
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.lastActive) - new Date(a.lastActive);
    });

  const winners = userScores.slice(0, config.winnersCount || 1);
  
  if (winners.length === 0) {
    console.log(`No activity to award MVP for guild ${guild.name}`);
    if (!isTest) return; // Don't reset scores if no activity and not a test
  }

  // Remove MVP role from current holders
  try {
    const mvpRole = await guild.roles.fetch(config.mvpRoleId);
    if (!mvpRole) {
      throw new Error('MVP role not found');
    }

    // Remove role from all current members
    const membersWithRole = mvpRole.members;
    for (const member of membersWithRole) {
      await member[1].roles.remove(mvpRole).catch(console.error);
    }

    // Assign MVP role to winners
    const winnerMembers = [];
    for (const winner of winners) {
      try {
        const member = await guild.members.fetch(winner.userId);
        if (member) {
          await member.roles.add(mvpRole);
          winnerMembers.push(member);
        }
      } catch (error) {
        console.error(`Failed to assign MVP role to user ${winner.userId}:`, error);
      }
    }

    // Announce winners
    if (winnerMembers.length > 0) {
      await announceWinners(guild, config, winnerMembers, winners.slice(0, winnerMembers.length));
      console.log(`✅ MVP awarded to ${winnerMembers.map(m => m.displayName).join(', ')} in ${guild.name}`);
    }

  } catch (error) {
    console.error(`Error managing MVP roles in guild ${guild.name}:`, error);
    throw error;
  }

  // Reset scores
  resetGuildActivity(guildId);
  console.log(`♻️ Scores reset for guild ${guild.name}`);
}

async function announceWinners(guild, config, winnerMembers, winnerData) {
  const channel = await guild.channels.fetch(config.announceChannelId).catch(() => null);
  if (!channel) {
    console.warn(`Announcement channel ${config.announceChannelId} not found in guild ${guild.name}`);
    return;
  }

  if (!channel.isTextBased() && !channel.isThread()) {
    console.warn(`Announcement channel ${config.announceChannelId} is not a text channel in guild ${guild.name}`);
    return;
  }

  const title = winnerMembers.length === 1 ? '🏆 New MVP' : `🏆 New MVPs (${winnerMembers.length})`;
  
  // Format winner data in monospaced table
  const tableLines = winnerData.map(winner => {
    const member = winnerMembers.find(m => m.id === winner.userId);
    const userName = member ? member.displayName : `User ${winner.userId}`;
    return `${userName.padEnd(20)} | Msg:${winner.messages.toString().padStart(3)} | Voice:${winner.voiceMinutes.toString().padStart(3)} min | Score:${(winner.messages + winner.voiceMinutes).toString().padStart(4)}`;
  });

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(0xFFD700)
    .setDescription('```\n' + tableLines.join('\n') + '\n```');

  try {
    await channel.send({
      content: winnerMembers.map(member => member.toString()).join(' '),
      embeds: [embed],
      allowedMentions: { users: winnerMembers.map(m => m.id) }
    });
  } catch (error) {
    console.error(`Failed to send MVP announcement in guild ${guild.name}:`, error);
    throw error;
  }
}
