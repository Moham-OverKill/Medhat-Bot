import {
  EmbedBuilder,
  SlashCommandBuilder,
  MessageFlags
} from 'discord.js';
import { getUserPassProgress } from './settings/pass-engine.js';
import { getLootBoxCategoryEmoji } from '../economy/lootbox.js';
import { COIN_EMOJI } from '../shared.js';
import { handleInteractionError } from '../utils/errors.js';

export const passCommand = new SlashCommandBuilder()
  .setName('pass')
  .setDescription('Check your Battlepass progress and rewards.');

export async function handlePassCommand(interaction) {
  try {
    const guildId = interaction.guildId;
    const userId = interaction.user.id;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const data = await getUserPassProgress(guildId, userId);

    if (!data.isEnabled) {
      return interaction.editReply({
        content: 'The Battlepass is not active in this server yet. An admin needs to configure and start it first.'
      });
    }

    const coinEmoji = COIN_EMOJI.forGuild(guildId);
    const lootBoxEmoji = await getLootBoxCategoryEmoji(guildId);

    const pct = Math.min(data.xpIntoCurrentLevel / data.xpForNextLevel, 1);
    const filled = Math.round(pct * 10);
    const empty = 10 - filled;
    let bar = '';
    for (let i = 0; i < filled; i++) bar += String.fromCodePoint(0x2588);
    for (let i = 0; i < empty; i++) bar += String.fromCodePoint(0x2591);

    const embed = new EmbedBuilder()
      .setTitle('Your Battlepass Progress')
      .setColor(0x5865F2);

    embed.addFields({
      name: 'Current Level',
      value:
        '**Level ' + data.currentLevel + '**\n' +
        '`' + bar + '` ' + data.xpIntoCurrentLevel + ' / ' + data.xpForNextLevel + ' XP\n' +
        '_Total XP: ' + data.totalXp.toLocaleString() + ' | ' + data.xpPerLevel + ' XP = 1 Level_',
      inline: false
    });

    if (data.nextReward) {
      const nr = data.nextReward;
      const parts = [];
      if (nr.reward_coins > 0) parts.push(coinEmoji + ' **' + Number(nr.reward_coins).toLocaleString() + ' Coins**');
      if (nr.item_name) parts.push('🏷️ **' + nr.item_name + '**');
      if (nr.chest_name) parts.push(lootBoxEmoji + ' **' + nr.chest_name + '**');
      const rewardStr = parts.length > 0 ? parts.join(' + ') : '_No reward configured_';
      const xpNeeded = (nr.level * data.xpPerLevel) - data.totalXp;
      embed.addFields({
        name: 'Next Reward -- Level ' + nr.level,
        value: rewardStr + '\n_' + Math.max(0, xpNeeded).toLocaleString() + ' XP away_',
        inline: false
      });
    } else if (data.currentLevel > 0) {
      embed.addFields({ name: 'All Rewards Claimed', value: '_You have claimed all available level rewards!_', inline: false });
    } else {
      embed.addFields({ name: 'No Rewards Configured', value: '_No level rewards have been set up yet._', inline: false });
    }

    if (data.claims.length > 0) {
      const claimLines = data.claims.slice(-10).map(c => {
        const parts = [];
        if (c.reward_coins > 0) parts.push(coinEmoji + ' ' + Number(c.reward_coins).toLocaleString());
        if (c.item_name) parts.push('🏷️ ' + c.item_name);
        if (c.chest_name) parts.push(lootBoxEmoji + ' ' + c.chest_name);
        const rewardStr = parts.length > 0 ? parts.join(' + ') : 'Reward';
        return '- **Lvl ' + c.level_claimed + ':** ' + rewardStr;
      });
      embed.addFields({
        name: 'Claimed Rewards (' + data.claims.length + ' total)',
        value: claimLines.join('\n'),
        inline: false
      });
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    await handleInteractionError(interaction, error, 'pass user');
  }
}
