import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
  MessageFlags
} from 'discord.js';
import { getUserPassProgress } from './settings/pass-engine.js';
import { getLootBoxCategoryEmoji } from '../economy/lootbox.js';
import { COIN_EMOJI } from '../shared.js';
import { handleInteractionError } from '../utils/errors.js';

export const levelCommand = new SlashCommandBuilder()
  .setName('level')
  .setDescription('Check your Level progress and rewards.');

export const passCommand = levelCommand;

/**
 * Generate tabbed payload for /level command
 */
export async function getLevelViewPayload(guildId, userId, activeTab = 'level') {
  const data = await getUserPassProgress(guildId, userId);

  if (!data.isEnabled) {
    return {
      content: 'The Level system is not active in this server yet. An admin needs to configure and start it first.',
      embeds: [],
      components: []
    };
  }

  const coinEmoji = COIN_EMOJI.forGuild(guildId);
  const lootBoxEmoji = await getLootBoxCategoryEmoji(guildId);

  const embed = new EmbedBuilder().setColor(0x5865F2);

  if (activeTab === 'level') {
    const requiredXp = Math.max(1, data.xpForNextLevel || 1);
    const pct = Math.min(Math.max(0, (data.xpIntoCurrentLevel || 0) / requiredXp), 1);
    const filled = Math.min(10, Math.max(0, Math.round(pct * 10)));
    const empty = 10 - filled;
    let bar = '';
    for (let i = 0; i < filled; i++) bar += String.fromCodePoint(0x2588);
    for (let i = 0; i < empty; i++) bar += String.fromCodePoint(0x2591);

    embed.setTitle(`You Are Level ${data.currentLevel}`);

    const currentXpDisplay = Math.floor(data.xpIntoCurrentLevel || 0);
    let desc = `**Progress:**\n\`${bar}\` ${currentXpDisplay} / ${data.xpForNextLevel} XP`;
    if (data.totalBoostPct > 0 && data.activeBoosts && data.activeBoosts.length > 0) {
      const rolesList = data.activeBoosts.map(b => `<@&${b.roleId}>`).join(' + ');
      desc += `\n\n🚀 **+${data.totalBoostPct}%** XP Boost from ${rolesList}`;
    }

    embed.setDescription(desc);
  } else {
    embed.setTitle('🎉 Claimed Rewards:');

    let desc = '';

    if (data.claims.length > 0) {
      // 1. Calculate Lifetime Aggregates
      const totalCoins = data.claims.reduce((sum, c) => sum + (c.reward_coins || 0), 0);
      let totalItems = 0;
      let totalChests = 0;

      for (const c of data.claims) {
        for (const r of (c.rewards || [])) {
          const qty = r.quantity || 1;
          if (r.reward_type === 'item') totalItems += qty;
          else if (r.reward_type === 'chest') totalChests += qty;
        }
      }

      const summaryLines = [];
      if (totalCoins > 0) summaryLines.push(`• ${coinEmoji} **${totalCoins.toLocaleString()} Total Coins**`);
      if (totalItems > 0) summaryLines.push(`• 🏷️ **${totalItems.toLocaleString()} Total Items**`);
      if (totalChests > 0) summaryLines.push(`• ${lootBoxEmoji} **${totalChests.toLocaleString()} Total Chests**`);

      desc = summaryLines.length > 0 ? summaryLines.join('\n') : '_No rewards claimed yet._';
    } else {
      desc = '_You have not claimed any level rewards yet._';
    }

    if (data.nextReward) {
      const nr = data.nextReward;
      const parts = [];
      if (nr.reward_coins > 0) parts.push(`• ${coinEmoji} **${Number(nr.reward_coins).toLocaleString()} Coins**`);
      for (const r of (nr.rewards || [])) {
        const qStr = r.quantity > 1 ? `${r.quantity}x ` : '';
        if (r.reward_type === 'item' && r.item_name) parts.push(`• 🏷️ **${qStr}${r.item_name}**`);
        else if (r.reward_type === 'chest' && r.chest_name) parts.push(`• ${lootBoxEmoji} **${qStr}${r.chest_name}**`);
      }
      if (parts.length > 0) {
        desc += `\n\n───────────────\n\n**▶️ Next Reward (Level ${nr.level})**\n\n${parts.join('\n')}`;
      }
    }

    embed.setDescription(desc);
  }

  const buttonsRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`level_tab_level_${userId}`)
      .setLabel('Level')
      .setEmoji('⭐')
      .setStyle(activeTab === 'level' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`level_tab_rewards_${userId}`)
      .setLabel('Rewards')
      .setEmoji('🎉')
      .setStyle(activeTab === 'rewards' ? ButtonStyle.Primary : ButtonStyle.Secondary)
  );

  return {
    content: null,
    embeds: [embed],
    components: [buttonsRow]
  };
}

export async function handleLevelCommand(interaction) {
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const payload = await getLevelViewPayload(interaction.guildId, interaction.user.id, 'level');
    await interaction.editReply(payload);
  } catch (error) {
    await handleInteractionError(interaction, error, 'level user');
  }
}

export async function handleLevelTabButton(interaction) {
  try {
    const parts = interaction.customId.split('_'); // ['level', 'tab', 'level'|'rewards', userId]
    const tab = parts[2];
    const targetUserId = parts[3];

    if (interaction.user.id !== targetUserId) {
      return interaction.reply({ content: '❌ This level progress view belongs to someone else.', flags: MessageFlags.Ephemeral });
    }

    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => {});
    }

    const payload = await getLevelViewPayload(interaction.guildId, interaction.user.id, tab);
    await interaction.editReply(payload);
  } catch (error) {
    await handleInteractionError(interaction, error, 'level tab button');
  }
}

export const handlePassCommand = handleLevelCommand;
