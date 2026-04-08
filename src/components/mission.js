import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { getMission, getProgress, startUserMission, claimUserMissionReward, generateProgressBar, formatMissionTask, formatCompactMission } from '../missions/missions.js';
import { updateBalance } from '../economy/service.js';
import { addUserToMissionsTracking, isMissionCompleted } from '../activity/index.js';
import { sanitizeError, getUserLogName, COIN_EMOJI } from '../shared.js';
import { sendLog } from '../utils/logger.js';

export async function handleMissionInteraction(interaction) {
  const customId = interaction.customId;
  const { guildId, user } = interaction;
  
  const [prefix, action, missionIdStr] = customId.split('_');
  const missionId = parseInt(missionIdStr);

  // Security: Only the user who ran the /mission command can click its buttons
  const originalUserId = interaction.message.interaction?.user?.id;
  if (originalUserId && user.id !== originalUserId) {
    const payload = { content: "❌ This isn't your mission page.", flags: 64 };
    if (interaction.deferred || interaction.replied) return interaction.followUp(payload);
    return interaction.reply(payload);
  }

  try {
    const mission = await getMission(missionId);
    if (!mission) return interaction.update({ content: '❌ Mission no longer exists.', components: [] });

    if (action === 'start') {
      await startUserMission(guildId, user.id, missionId);
      await addUserToMissionsTracking(guildId, user.id);
      
      // Update the UI
      return updateMissionEmbed(interaction, mission);
    }

    if (action === 'refresh') {
      // Just re-fetch and update the UI
      return updateMissionEmbed(interaction, mission);
    }

    if (action === 'claim') {
      // 1. Pre-interaction check: has the user already claimed today?
      const progressCheck = await getProgress(guildId, user.id, missionId);
      if (progressCheck?.is_claimed) {
        const payload = { content: '❌ You have already claimed this mission.', flags: 64 };
        if (interaction.deferred || interaction.replied) return interaction.followUp(payload);
        return interaction.reply(payload);
      }

      // 2. Perform ATOMIC claim in DB (This handles parallel clicks)
      const result = await claimUserMissionReward(guildId, user.id, missionId, mission.reward_coins);
      
      if (result.error) {
        const payload = { content: `❌ ${result.error}`, flags: 64 };
        if (interaction.deferred || interaction.replied) return interaction.followUp(payload);
        return interaction.reply(payload);
      }

      // 3. Award coins only AFTER DB confirms claim was successful
      await updateBalance(
        user.id,
        guildId,
        mission.reward_coins,
        'mission_reward',
        `Daily Mission: ${mission.action_type === 'react_images' ? 'react' : mission.action_type.replace(/_/g, ' ')} ×${mission.required_count}`
      );

      // 4. Log to Discord Logs
      const logUsername = getUserLogName(interaction.member);
      sendLog(interaction.guild, 'economy', 'orange', '🎁 Rewards Claimed', 
        `**User:** \`${logUsername}\`\n` +
        `**Type:** \`Mission Reward\`\n` +
        `**Task:** \`${mission.action_type === 'react_images' ? 'Reaction' : mission.action_type.replace(/_/g, ' ')} ×${mission.required_count}\`\n` +
        `**Reward:** \`${mission.reward_coins.toLocaleString()}\` ${COIN_EMOJI}`
      );

      // Update the UI
      return updateMissionEmbed(interaction, mission);
    }

  } catch (error) {
    console.error('[Missions] Interaction error:', sanitizeError(error));
    const payload = { content: '❌ An error occurred.', flags: 64 };
    if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => {});
    else await interaction.reply(payload).catch(() => {});
  }
}

async function updateMissionEmbed(interaction, mission) {
  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  
  const progress = await getProgress(guildId, userId, mission.id);
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

  await interaction.update({
    embeds: [embed],
    components: [row]
  });
}
