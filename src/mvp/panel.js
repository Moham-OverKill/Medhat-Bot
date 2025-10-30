import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { getGuildActivity, getUserActivity } from '../activity/tracker.js';
import { getGuildConfig } from '../storage/config.js';
import { awardMvp } from './award.js';
import { handleMvpComponent } from '../commands/mvp.js';

export async function showStats(interaction) {
  const guildId = interaction.guildId;
  const config = await getGuildConfig(guildId);
  const guild = getGuildActivity(guildId);
  
  const embed = new EmbedBuilder()
    .setTitle('📊 Current MVP Stats')
    .setColor(0x0099FF);

  if (guild.users.size === 0) {
    embed.setDescription('No activity yet.');
  } else {
    // Exclude the command user
    const otherUsers = Array.from(guild.users.entries())
      .filter(([userId]) => userId !== interaction.user.id)
      .map(([userId, data]) => ({ userId, ...data }))
      .sort((a, b) => (b.messages + b.voiceMinutes) - (a.messages + a.voiceMinutes))
      .slice(0, 3);

    if (otherUsers.length > 0) {
      const topUser = otherUsers[0];
      const member = await interaction.guild.members.fetch(topUser.userId).catch(() => null);
      const userName = member ? member.displayName : `User ${topUser.userId}`;
      
      embed.setDescription(
        `**Current Top Member:** ${userName}\n` +
        `📝 Messages: ${topUser.messages}\n` +
        `🎤 Voice: ${topUser.voiceMinutes} min\n` +
        `🏆 Score: ${topUser.messages + topUser.voiceMinutes}`
      );
    }
  }

  // Add next check time if configured
  if (config) {
    const intervalMs = config.intervalUnit === 'weeks' 
      ? config.intervalNumber * 7 * 24 * 60 * 60 * 1000
      : config.intervalNumber * 60 * 60 * 1000;
    
    const nextCheck = new Date(Date.now() + intervalMs);
    embed.addFields({
      name: '⏰ Next MVP Check',
      value: `<t:${Math.floor(nextCheck.getTime() / 1000)}:R>`
    });
  }

  const backButton = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('mvp_back')
        .setLabel('⬅️ Back')
        .setStyle(ButtonStyle.Secondary)
    );

  await interaction.update({
    embeds: [embed],
    components: [backButton]
  });
}

export async function showLeaderboard(interaction) {
  const guildId = interaction.guildId;
  const guild = getGuildActivity(guildId);
  
  const embed = new EmbedBuilder()
    .setTitle('🏆 MVP Leaderboard')
    .setColor(0xFFD700);

  if (guild.users.size === 0) {
    embed.setDescription('No activity yet.');
  } else {
    const leaderboard = Array.from(guild.users.entries())
      .map(([userId, data], index) => ({ userId, rank: index + 1, ...data }))
      .sort((a, b) => (b.messages + b.voiceMinutes) - (a.messages + a.voiceMinutes))
      .slice(0, 10);

    const lines = await Promise.all(leaderboard.map(async (entry) => {
      const member = await interaction.guild.members.fetch(entry.userId).catch(() => null);
      const userName = member ? member.displayName : `User ${entry.userId}`;
      const score = entry.messages + entry.voiceMinutes;
      
      return `#${entry.rank} ${userName} — Msg:${entry.messages} | Voice:${entry.voiceMinutes} | Score:${score}`;
    }));

    embed.setDescription('```' + lines.join('\n') + '```');
  }

  const backButton = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('mvp_back')
        .setLabel('⬅️ Back')
        .setStyle(ButtonStyle.Secondary)
    );

  await interaction.update({
    embeds: [embed],
    components: [backButton]
  });
}

export async function testMvpAward(interaction) {
  await interaction.update({
    content: '🔄 Running test MVP award...',
    embeds: [],
    components: []
  });

  try {
    await awardMvp(interaction.client, interaction.guildId, true);
    
    const embed = new EmbedBuilder()
      .setTitle('✅ Test MVP Award Complete')
      .setDescription('Test award has been processed and scores have been reset.')
      .setColor(0x00FF00);

    const backButton = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('mvp_back')
          .setLabel('⬅️ Back')
          .setStyle(ButtonStyle.Secondary)
      );

    await interaction.followUp({
      embeds: [embed],
      components: [backButton],
      flags: MessageFlags.Ephemeral
    });
  } catch (error) {
    console.error('Test MVP award failed:', error);
    
    await interaction.followUp({
      content: `❌ Test MVP award failed: ${error.message}`,
      flags: MessageFlags.Ephemeral
    });
  }
}
