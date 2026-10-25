import { SlashCommandBuilder, MessageFlags, EmbedBuilder } from 'discord.js';
import { claimDaily } from '../economy/service.js';
import { getGuildConfig } from '../storage/config.js';
import { createErrorEmbed, handleInteractionError } from '../utils/errors.js';
import { isMemberBooster } from './colors.js';
import { getNextCairoMidnight } from '../utils/time.js';
import { getUserDisplayName, getUserLogName, COIN_EMOJI } from '../shared.js';
import { getCoinThumbnailUrl } from './bank.js';
import { sendLog } from '../utils/logger.js';

export const dailyCommand = new SlashCommandBuilder()
  .setName('daily')
  .setDescription('Claim your daily currency reward');

/**
 * Shared daily claim executor for slash command and interface button
 */
export async function executeDailyClaim(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }

  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  const config = await getGuildConfig(guildId) || {};

  if (config.daily_enabled !== true) {
    const errorEmbed = createErrorEmbed('Daily Rewards', 'Daily rewards are not configured for this server yet.');
    return interaction.editReply({ files: [], content: '', embeds: [errorEmbed], components: [] });
  }

  const member = interaction.member;
  const isBooster = await isMemberBooster(member);
  const coinEmoji = COIN_EMOJI.forGuild(guildId);
  const result = await claimDaily(userId, guildId, getUserDisplayName(member), isBooster);

  if (!result.success) {
    if (result.error === 'daily_disabled') {
      const errorEmbed = createErrorEmbed('Daily Rewards', 'Daily rewards are not configured for this server yet.');
      return interaction.editReply({ files: [], content: '', embeds: [errorEmbed], components: [] });
    }

    if (result.error === 'daily_claimed') {
      const nextMidnight = getNextCairoMidnight();
      const nextMidnightTs = Math.floor(nextMidnight.getTime() / 1000);

      return interaction.editReply({
        files: [],
        content: `You already claimed your daily! Try again <t:${nextMidnightTs}:R>.`,
        embeds: [],
        components: []
      });
    }

    throw new Error(result.error);
  }

  const logUsername = getUserLogName(member);
  const initialBal = result.balance - result.amount;
  sendLog(interaction.guild, 'economy', 'orange', 'Daily Claimed',
    `**User:** \`${logUsername}\`\n` +
    `**Reward:** \`${result.amount.toLocaleString()}\` ${coinEmoji} (Daily)\n` +
    `**Streak:** \`${result.streak} days\`\n` +
    `**Balance:** \`${initialBal.toLocaleString()}\` ➡️ \`${result.balance.toLocaleString()}\``
  );

  const { breakdown } = result;
  const coinThumbnail = getCoinThumbnailUrl(interaction.guildId);
  const claimEmbed = new EmbedBuilder()
    .setColor(0xFFD700)
    .setTitle(`Total: ${result.amount.toLocaleString()}`)
    .setThumbnail(coinThumbnail)
    .setDescription(
      `────────────────\n` +
      `💰 Base: **+${breakdown.base.toLocaleString()}**\n` +
      `🔥 Streak Bonus: **+${breakdown.streakBonus.toLocaleString()}**\n` +
      `🚀 Boost Bonus: **+${breakdown.boostBonus.toLocaleString()}**`
    );

  return interaction.editReply({ files: [], content: '', embeds: [claimEmbed], components: [] });
}

export async function handleDailyCommand(interaction) {
  try {
    await executeDailyClaim(interaction);
  } catch (error) {
    await handleInteractionError(interaction, error, 'Daily command');
  }
}
