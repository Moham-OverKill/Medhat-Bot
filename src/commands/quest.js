import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { getGuildConfig } from '../storage/config.js';
import { getQuest, getProgress, generateProgressBar, formatQuestTask, formatCompactQuest } from '../quests/quests.js';
import { sanitizeError } from '../shared.js';

export const data = new SlashCommandBuilder()
  .setName('quest')
  .setDescription('View your current daily quests and progress');

export async function execute(interaction) {
  const { guildId, user } = interaction;
  
  try {
    const config = await getGuildConfig(guildId);
    // Note: Config might still use missions_enabled due to older DB schemas
    const questsEnabled = config?.quests_enabled ?? config?.missions_enabled ?? false;

    if (!questsEnabled) {
      return interaction.reply({
        content: '❌ Daily quests are currently disabled or not set up for this server.',
        flags: MessageFlags.Ephemeral
      });
    }

    let activeQuestIds = config.active_quest_ids || [];
    
    // BUG FIX: If pool has quests but active list is empty (e.g. brand new setup),
    // immediately trigger a rotation so users don't see an empty list.
    if (activeQuestIds.length === 0) {
      const { getQuests } = await import('../quests/quests.js');
      const poolQuests = await getQuests(guildId);
      
      if (poolQuests.length > 0) {
        const { rotateGuildQuests } = await import('../cron/quests.js');
        await rotateGuildQuests(guildId, config, null);
        activeQuestIds = config.active_quest_ids || [];
      }
    }

    if (activeQuestIds.length === 0) {
      return interaction.reply({
        content: '📝 There are currently no active quests. Please check back later!',
        flags: MessageFlags.Ephemeral
      });
    }

    const embed = new EmbedBuilder()
      .setTitle('🎯 Current Quests')
      .setColor('#F1C40F'); // Gold

    for (const questId of activeQuestIds) {
      const quest = await getQuest(questId);
      if (!quest) continue;

      const progress = await getProgress(guildId, user.id, quest.id);
      const currentCount = progress?.progress || 0;
      const isCompleted = progress?.completed || false;
      const isClaimed = progress?.is_claimed || false;

      const questInfo = formatQuestTask(quest);
      const progressBar = generateProgressBar(currentCount, quest.required_count);

      let statusIcon = '⏳';
      if (isCompleted || isClaimed) statusIcon = '✅';

      embed.addFields({
        name: `${statusIcon} ${questInfo.text}`,
        value: `${formatCompactQuest(quest)}\n${progressBar} \`${currentCount}\` / \`${quest.required_count}\``
      });
    }

    await interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });

  } catch (error) {
    console.error('[Quests] Command error:', sanitizeError(error));
    await interaction.reply({
      content: '❌ An error occurred while fetching your quest progress.',
      flags: MessageFlags.Ephemeral
    });
  }
}
