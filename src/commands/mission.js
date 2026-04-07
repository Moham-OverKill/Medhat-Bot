import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { getGuildConfig } from '../storage/config.js';
import { getMission, getProgress, generateProgressBar, formatMissionTask, formatCompactMission } from '../missions/missions.js';
import { sanitizeError } from '../shared.js';

export const data = new SlashCommandBuilder()
  .setName('mission')
  .setDescription('Opt-in to the daily mission and claim your reward');

export async function execute(interaction) {
  const { guildId, user } = interaction;
  
  try {
    const config = await getGuildConfig(guildId);
    if (!config?.missions_enabled || !config?.active_mission_id) {
      return interaction.reply({
        content: '❌ Daily missions are currently disabled or not set up for this server.',
        flags: MessageFlags.Ephemeral
      });
    }

    const mission = await getMission(config.active_mission_id);
    if (!mission) {
      return interaction.reply({
        content: '❌ Today\'s mission data could not be found.',
        flags: MessageFlags.Ephemeral
      });
    }

    const progress = await getProgress(guildId, user.id, mission.id);
    const currentCount = progress?.progress || 0;
    const isCompleted = progress?.completed || false;
    const isTracking = progress?.active_tracking || false;
    const isClaimed = progress?.is_claimed || false;

    const missionInfo = formatMissionTask(mission);
    const progressBar = generateProgressBar(currentCount, mission.required_count);

    const embed = new EmbedBuilder()
      .setTitle('🎯 Daily Mission Progress')
      .setColor('#F1C40F') // Gold
      .setDescription(
        `${formatCompactMission(mission)}\n\n` +
        `${progressBar}\n` +
        `**Progress**: \`${currentCount}\` / \`${mission.required_count}\` ${missionInfo.unit}`
      );

    const row = new ActionRowBuilder();

    // Button 1: Start Mission
    const startButton = new ButtonBuilder()
      .setCustomId(`mission_start_${mission.id}`)
      .setLabel('Start Mission')
      .setEmoji('🏁')
      .setStyle(isTracking ? ButtonStyle.Secondary : ButtonStyle.Primary)
      .setDisabled(isTracking);
    
    row.addComponents(startButton);

    // Button: Refresh
    const refreshButton = new ButtonBuilder()
      .setCustomId(`mission_refresh_${mission.id}`)
      .setLabel('Refresh')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary);

    row.addComponents(refreshButton);

    // Button 2: Claim Reward
    let claimStyle = ButtonStyle.Secondary;
    let claimLabel = '💰 Claim Reward';
    let claimDisabled = true;

    if (isClaimed) {
      claimStyle = ButtonStyle.Success;
      claimLabel = '✅ Reward Claimed';
      claimDisabled = true;
    } else if (isCompleted) {
      claimStyle = ButtonStyle.Success;
      claimLabel = '💰 Claim Reward';
      claimDisabled = false;
    }

    const claimButton = new ButtonBuilder()
      .setCustomId(`mission_claim_${mission.id}`)
      .setLabel(claimLabel)
      .setStyle(claimStyle)
      .setDisabled(claimDisabled);

    row.addComponents(claimButton);

    await interaction.reply({
      embeds: [embed],
      components: [row]
    });

  } catch (error) {
    console.error('[Missions] Command error:', sanitizeError(error));
    await interaction.reply({
      content: '❌ An error occurred while fetching your mission progress.',
      flags: MessageFlags.Ephemeral
    });
  }
}
