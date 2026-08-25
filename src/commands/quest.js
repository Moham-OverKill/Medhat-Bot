import {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} from 'discord.js';
import { getGuildConfig, setGuildConfig } from '../storage/config.js';
import {
  getProgress,
  generateProgressBar,
  formatQuestTask,
  formatCompactQuest,
  getQuests
} from '../quests/quests.js';
import { sanitizeError, COIN_EMOJI } from '../shared.js';
import { getNextQuestRefresh } from '../utils/time.js';
import { sysLog, sysError } from '../utils/logger.js';

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
      return isButton ? interaction.editReply({ files: [], content: msg, embeds: [], components: [] }) : interaction.editReply({ files: [], content: msg });
    }

    // Snapshot Architecture: Render directly from the immutable snapshot
    const validQuests = config.active_quest_snapshot || [];
    
    if (validQuests.length === 0) {
      const msg = '📝 There are currently no active quests. Please check back later!';
      return isButton ? interaction.editReply({ files: [], content: msg, embeds: [], components: [] }) : interaction.editReply({ files: [], content: msg });
    }

    // --- PAGINATION ---
    const totalQuests = validQuests.length;
    const itemsPerPage = 3;
    const totalPages = Math.ceil(totalQuests / itemsPerPage);
    const currentPage = Math.max(0, Math.min(page, totalPages - 1));
    
    const startIdx = currentPage * itemsPerPage;
    const pageQuests = validQuests.slice(startIdx, startIdx + itemsPerPage);

    // Track total completions for Title
    let completedCount = 0;
    const questEntries = [];

    // We still need to check completion for ALL quests even if not on page to get total count
    for (const quest of validQuests) {
      const progress = await getProgress(guildId, user.id, quest.id);
      const isCompleted = progress?.is_claimed === true;
      const currentCount = progress?.progress || 0;
      
      if (isCompleted) completedCount++;

      // Only format entries for the current page
      if (validQuests.indexOf(quest) >= startIdx && validQuests.indexOf(quest) < startIdx + itemsPerPage) {
        const questInfo = formatQuestTask(quest);
        const progressBar = generateProgressBar(currentCount, quest.required_count);
        
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
      .setTitle(`${totalQuests === 1 ? 'Quest' : 'Quests'} Progress (${completedCount} / ${totalQuests}) - 🎯`)
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

    await interaction.editReply({ files: [], embeds: [embed],
      components: [row] });

  } catch (error) {
    sysError('Quest command failed', error, { user: user.id, guild: guildId });
    const errorMsg = '❌ An error occurred while fetching your quest progress.';
    if (isButton) await interaction.editReply({ files: [], content: errorMsg });
    else await interaction.editReply({ files: [], content: errorMsg });
  }
}

/**
 * Handle button interactions for quest pagination/refresh
 */
export async function handleQuestInteraction(interaction) {
    const customId = interaction.customId;
    
    if (customId === 'quest_refresh') {
        // The Refresh button now triggers a DEEP sync.
        // 1. Force the activity tracker to rebuild its channel watch-list
        try {
            const { syncQuestChannelCache } = await import('../activity/index.js');
            await syncQuestChannelCache(interaction.guildId);
            sysLog('Quest Refresh Triggered', { user: interaction.user.id, guild: interaction.guildId, detail: 'Manual deep-sync performed' });
        } catch (err) {
            sysError('Quest Cache Refresh Failed', err, { guild: interaction.guildId });
        }

        // 2. Re-render the UI (fetches fresh config from DB)
        await renderQuests(interaction, 0);
        return;
    }
    
    if (customId.startsWith('quest_page_')) {
        const page = parseInt(customId.split('_').pop(), 10);
        await renderQuests(interaction, page);
        return;
    }
}
