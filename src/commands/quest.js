import {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} from 'discord.js';
import { getGuildConfig } from '../storage/config.js';
import {
  getQuest,
  getProgress,
  generateProgressBar,
  formatQuestTask,
  formatCompactQuest,
  getQuests
} from '../quests/quests.js';
import { sanitizeError, COIN_EMOJI } from '../shared.js';
import { getNextQuestRefresh } from '../utils/time.js';

export const data = new SlashCommandBuilder()
  .setName('quest')
  .setDescription('View your current daily quests and progress');

/**
 * Main command entry point
 */
export async function execute(interaction) {
  await renderQuests(interaction, 0); // Start at page 0
}

/**
 * Render the Quest embed with pagination
 * @param {CommandInteraction|ButtonInteraction} interaction 
 * @param {number} page 
 */
export async function renderQuests(interaction, page = 0) {
  const { guildId, user } = interaction;
  const isButton = interaction.isButton();

  try {
    if (!interaction.deferred && !interaction.replied) {
      if (isButton) await interaction.deferUpdate();
      else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }

    const config = await getGuildConfig(guildId) || {};
    const questsEnabled = config.quests_enabled ?? config.missions_enabled ?? false;

    if (!questsEnabled) {
      const msg = '❌ Daily quests are currently disabled or not set up for this server.';
      return isButton ? interaction.editReply({ content: msg, embeds: [], components: [] }) : interaction.editReply({ content: msg });
    }

    let activeQuestIds = config.active_quest_ids || [];

    // Initialization: If pool has quests but active list is empty, trigger ONE rotation and save
    if (activeQuestIds.length === 0) {
      const poolQuests = await getQuests(guildId);
      if (poolQuests.length > 0) {
        const { rotateGuildQuests } = await import('../cron/quests.js');
        await rotateGuildQuests(guildId, config, null);
        const { syncQuestChannelCache } = await import('../activity/index.js');
        await syncQuestChannelCache(guildId);
        activeQuestIds = config.active_quest_ids || [];
      }
    }

    if (activeQuestIds.length === 0) {
      const msg = '📝 There are currently no active quests. Please check back later!';
      return isButton ? interaction.editReply({ content: msg, embeds: [], components: [] }) : interaction.editReply({ content: msg });
    }

    // Pagination Logic: 3 quests per page
    const totalQuests = activeQuestIds.length;
    const itemsPerPage = 3;
    const totalPages = Math.ceil(totalQuests / itemsPerPage);
    const currentPage = Math.max(0, Math.min(page, totalPages - 1));
    
    const startIdx = currentPage * itemsPerPage;
    const pageQuests = activeQuestIds.slice(startIdx, startIdx + itemsPerPage);

    // Track total completions for Title
    let completedCount = 0;
    const questEntries = [];

    for (const questId of activeQuestIds) {
      const quest = await getQuest(questId);
      if (!quest) continue;

      const progress = await getProgress(guildId, user.id, quest.id);
      const currentCount = progress?.progress || 0;
      const isCompleted = progress?.completed || currentCount >= quest.required_count;
      
      if (isCompleted) completedCount++;

      // Only format entries for current page
      if (activeQuestIds.indexOf(questId) >= startIdx && activeQuestIds.indexOf(questId) < startIdx + itemsPerPage) {
        const questInfo = formatQuestTask(quest);
        const progressBar = generateProgressBar(currentCount, quest.required_count);
        
        // If completed, replace progress line with Claimed status
        const progressLine = isCompleted 
          ? `✅ Claimed **${quest.reward_coins}** ${COIN_EMOJI}`
          : `Progress: \`${currentCount}\` / \`${quest.required_count}\` ${questInfo.unit}`;

        questEntries.push(
          `${formatCompactQuest(quest)}\n` +
          `${progressBar}\n` +
          progressLine
        );
      }
    }

    const embed = new EmbedBuilder()
      .setTitle(`🎯 ${totalQuests === 1 ? 'Quest' : 'Quests'} Progress ( ${completedCount} / ${totalQuests} )`)
      .setColor('#F1C40F')
      .setDescription(questEntries.join('\n\n'));
      
    // Calculate next refresh
    const nextRefresh = getNextQuestRefresh(config.quests_refreshes_per_day || 1);
    const timestamp = Math.floor(nextRefresh.getTime() / 1000);
    embed.setDescription(embed.data.description + `\n\n**Next refresh:** <t:${timestamp}:R>`);

    // Pagination Buttons
    const row = new ActionRowBuilder();
    
    if (totalPages > 1) {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`quest_page_${currentPage - 1}`)
                .setLabel('Previous')
                .setEmoji('◀️')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(currentPage === 0),
            new ButtonBuilder()
                .setCustomId('quest_refresh')
                .setLabel('Refresh')
                .setEmoji('🔄')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`quest_page_${currentPage + 1}`)
                .setLabel('Next')
                .setEmoji('▶️')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(currentPage === totalPages - 1)
        );
    } else {
        // Just Refresh button if single page
        row.addComponents(
            new ButtonBuilder()
                .setCustomId('quest_refresh')
                .setLabel('Refresh')
                .setEmoji('🔄')
                .setStyle(ButtonStyle.Secondary)
        );
    }

    await interaction.editReply({
      embeds: [embed],
      components: [row]
    });

  } catch (error) {
    console.error('[Quests] Command error:', sanitizeError(error));
    const errorMsg = '❌ An error occurred while fetching your quest progress.';
    if (isButton) await interaction.editReply({ content: errorMsg });
    else await interaction.editReply({ content: errorMsg });
  }
}

/**
 * Handle button interactions for quest pagination/refresh
 */
export async function handleQuestInteraction(interaction) {
    const customId = interaction.customId;
    
    if (customId === 'quest_refresh') {
        await renderQuests(interaction, 0); // Reset to first page on refresh? Or keep current?
        return;
    }
    
    if (customId.startsWith('quest_page_')) {
        const page = parseInt(customId.split('_').pop(), 10);
        await renderQuests(interaction, page);
        return;
    }
}
