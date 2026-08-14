import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  MessageFlags
} from 'discord.js';
import { getPool } from '../../storage/postgres.js';
import { COIN_EMOJI } from '../../shared.js';
import { sysLog, sysError } from '../../utils/logger.js';
import { handleInteractionError } from '../../utils/errors.js';

/**
 * Get count of unlocked shop items (is_tradable is true or null, is_active is true)
 */
export async function getUnlockedItemCount(guildId) {
  const pool = getPool();
  const res = await pool.query(
    'SELECT COUNT(*) as count FROM shop_items WHERE guild_id = $1 AND is_active = true AND (is_tradable IS TRUE OR is_tradable IS NULL)',
    [guildId]
  );
  return parseInt(res.rows[0]?.count || 0, 10);
}

/**
 * Get all unlocked shop items for item picker
 */
async function getUnlockedShopItems(guildId) {
  const pool = getPool();
  const res = await pool.query(
    'SELECT id, name, price, rarity, item_type FROM shop_items WHERE guild_id = $1 AND is_active = true AND (is_tradable IS TRUE OR is_tradable IS NULL) ORDER BY price ASC, name ASC LIMIT 24',
    [guildId]
  );
  return res.rows;
}

/**
 * Fetch all configured battlepass levels for a guild
 */
async function getConfiguredLevels(guildId) {
  const pool = getPool();
  const res = await pool.query(
    'SELECT bc.level, bc.reward_coins, bc.reward_item_id, si.name as item_name, si.rarity FROM battlepass_config bc LEFT JOIN shop_items si ON bc.reward_item_id = si.id WHERE bc.guild_id = $1 ORDER BY bc.level ASC',
    [guildId]
  );
  return res.rows;
}

/**
 * Render the Battlepass Dashboard payload
 */
export async function getPassDashboardPayload(guildId) {
  const levels = await getConfiguredLevels(guildId);

  const embed = new EmbedBuilder()
    .setTitle('🎟️ Battlepass Configuration')
    .setColor(0x5865F2);

  if (levels.length === 0) {
    embed.setDescription(
      '_No level rewards configured yet._\n\n' +
      'Click **Add Level** below to configure rewards (Coins, Items, or both) for target levels.'
    );
  } else {
    const lines = levels.map(row => {
      const parts = [];
      if (row.reward_coins > 0) {
        parts.push(COIN_EMOJI + ' **' + Number(row.reward_coins).toLocaleString() + '**');
      }
      if (row.item_name) {
        parts.push('🎁 **' + row.item_name + '**');
      }
      const rewardText = parts.length > 0 ? parts.join(' + ') : '_No Reward_';
      return '• **Level ' + row.level + ':** ' + rewardText;
    });

    embed.setDescription(lines.join('\n'));
  }

  // Row 1: Add Level & Remove Level
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('pass_add_level_btn')
      .setLabel('Add Level')
      .setEmoji('➕')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('pass_remove_level_btn')
      .setLabel('Remove Level')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(levels.length === 0)
  );

  // Row 2: Back to Settings Main Menu
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('settings_home')
      .setLabel('Back')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row1, row2] };
}

/**
 * Entry point when [ 🎟️ Pass ] is clicked in /settings
 */
export async function handlePassSetup(interaction) {
  try {
    const guildId = interaction.guildId;

    // 1. Prerequisite Check: 5-Item Gate
    const count = await getUnlockedItemCount(guildId);
    if (count < 5) {
      const warning = '⚠️ Please add at least 5 unlocked items to the shop before configuring the Battlepass.';
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: warning, embeds: [], components: [] });
      } else {
        await interaction.reply({ content: warning, flags: MessageFlags.Ephemeral });
      }
      return;
    }

    // 2. Render Dashboard
    const payload = await getPassDashboardPayload(guildId);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: '', ...payload });
    } else if (interaction.isButton() || interaction.isAnySelectMenu()) {
      await interaction.update({ content: '', ...payload });
    } else {
      await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    }
  } catch (error) {
    await handleInteractionError(interaction, error, 'pass setup');
  }
}

/**
 * Handle Battlepass Button & Select Interactions
 */
export async function handlePassComponent(interaction) {
  const customId = interaction.customId;
  const guildId = interaction.guildId;

  try {
    // 1. Dashboard Home Refresh
    if (customId === 'pass_home') {
      const payload = await getPassDashboardPayload(guildId);
      await interaction.update({ content: '', ...payload });
      return;
    }

    // 2. Add / Edit Level Button -> Show Modal Step 1
    if (customId === 'pass_add_level_btn') {
      const modal = new ModalBuilder()
        .setCustomId('pass_add_level_modal')
        .setTitle('Configure Level Reward');

      const levelInput = new TextInputBuilder()
        .setCustomId('pass_level_input')
        .setLabel('Target Level (e.g. 5, 10, 25)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Enter level number')
        .setMinLength(1)
        .setMaxLength(6)
        .setRequired(true);

      const coinsInput = new TextInputBuilder()
        .setCustomId('pass_coins_input')
        .setLabel('Coin Reward (Optional, 0 for none)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Enter coin amount (e.g. 100)')
        .setValue('0')
        .setRequired(false);

      modal.addComponents(
        new ActionRowBuilder().addComponents(levelInput),
        new ActionRowBuilder().addComponents(coinsInput)
      );

      await interaction.showModal(modal);
      return;
    }

    // 3. Remove Level Button -> Show Level Select Dropdown
    if (customId === 'pass_remove_level_btn') {
      const levels = await getConfiguredLevels(guildId);
      if (levels.length === 0) {
        return interaction.reply({ content: '⚠️ No levels are currently configured.', flags: MessageFlags.Ephemeral });
      }

      const options = levels.map(l => ({
        label: 'Level ' + l.level,
        value: String(l.level),
        description: ('Reward: ' + (l.reward_coins > 0 ? (l.reward_coins + ' Coins ') : '') + (l.item_name ? ('+ ' + l.item_name) : '')).trim()
      }));

      const select = new StringSelectMenuBuilder()
        .setCustomId('pass_remove_level_select')
        .setPlaceholder('Select a level to remove...')
        .addOptions(options.slice(0, 25));

      const row1 = new ActionRowBuilder().addComponents(select);
      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('pass_home')
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary)
      );

      const embed = new EmbedBuilder()
        .setTitle('🗑️ Remove Level Reward')
        .setDescription('Select a configured level from the dropdown below to delete its reward.')
        .setColor(0xED4245);

      await interaction.update({
        embeds: [embed],
        components: [row1, row2]
      });
      return;
    }

    // 4. Handle Remove Level Selection
    if (customId === 'pass_remove_level_select') {
      const selectedLevel = parseInt(interaction.values[0], 10);
      const pool = getPool();
      await pool.query(
        'DELETE FROM battlepass_config WHERE guild_id = $1 AND level = $2',
        [guildId, selectedLevel]
      );

      const payload = await getPassDashboardPayload(guildId);
      await interaction.update({ content: '', ...payload });
      return;
    }

    // 5. Handle Item Picker Selection (Step 2 of Add Level)
    if (customId.startsWith('pass_select_item_')) {
      const parts = customId.split('_');
      const targetLevel = parseInt(parts[3], 10);
      const coinsAmount = parseInt(parts[4], 10) || 0;

      const selectedValue = interaction.values[0];
      const rewardItemId = selectedValue === 'none' ? null : parseInt(selectedValue, 10);

      if (coinsAmount <= 0 && !rewardItemId) {
        return interaction.reply({
          content: '⚠️ You must provide either Coins, an Item, or both for this level.',
          flags: MessageFlags.Ephemeral
        });
      }

      const pool = getPool();
      await pool.query(
        'INSERT INTO battlepass_config (guild_id, level, reward_coins, reward_item_id) VALUES ($1, $2, $3, $4) ON CONFLICT (guild_id, level) DO UPDATE SET reward_coins = $3, reward_item_id = $4',
        [guildId, targetLevel, coinsAmount, rewardItemId]
      );

      sysLog('Battlepass Level Configured', {
        guild: guildId,
        user: interaction.user.id,
        detail: 'Level ' + targetLevel + ' configured (Coins: ' + coinsAmount + ', Item: ' + (rewardItemId || 'None') + ')'
      });

      const payload = await getPassDashboardPayload(guildId);
      await interaction.update({ content: '', ...payload });
      return;
    }

  } catch (error) {
    await handleInteractionError(interaction, error, 'pass component');
  }
}

/**
 * Handle Modal Submissions for Battlepass
 */
export async function handlePassModal(interaction) {
  const customId = interaction.customId;
  const guildId = interaction.guildId;

  try {
    if (customId === 'pass_add_level_modal') {
      const levelRaw = interaction.fields.getTextInputValue('pass_level_input').trim();
      const coinsRaw = interaction.fields.getTextInputValue('pass_coins_input').trim();

      const level = parseInt(levelRaw, 10);
      if (isNaN(level) || level <= 0) {
        return interaction.reply({ content: '❌ Level must be a positive whole number.', flags: MessageFlags.Ephemeral });
      }

      let coins = 0;
      if (coinsRaw && coinsRaw.length > 0) {
        coins = parseInt(coinsRaw, 10);
        if (isNaN(coins) || coins < 0) {
          return interaction.reply({ content: '❌ Coin reward must be 0 or a positive number.', flags: MessageFlags.Ephemeral });
        }
      }

      // Step 2: Show Item Picker Select Menu
      const unlockedItems = await getUnlockedShopItems(guildId);

      const options = [
        {
          label: 'None (Coins Only)',
          value: 'none',
          description: coins > 0 ? ('Award ' + coins + ' coins only') : 'No item reward',
          emoji: '🪙'
        }
      ];

      for (const item of unlockedItems) {
        options.push({
          label: item.name.slice(0, 50),
          value: String(item.id),
          description: (item.price.toLocaleString() + ' Coins | ' + (item.rarity || 'Common')).slice(0, 50),
          emoji: '🎁'
        });
      }

      const select = new StringSelectMenuBuilder()
        .setCustomId('pass_select_item_' + level + '_' + coins)
        .setPlaceholder('Choose an item reward for Level ' + level + '...')
        .addOptions(options.slice(0, 25));

      const row1 = new ActionRowBuilder().addComponents(select);
      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('pass_home')
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary)
      );

      const embed = new EmbedBuilder()
        .setTitle('🎟️ Level ' + level + ' — Select Item Reward')
        .setDescription(
          '**Configuring Level ' + level + '**\n' +
          '• **Coins:** ' + (coins > 0 ? (COIN_EMOJI + ' ' + coins.toLocaleString()) : '_None_') + '\n\n' +
          'Choose an unlocked item from the shop below, or select **None (Coins Only)**.'
        )
        .setColor(0x5865F2);

      await interaction.reply({
        embeds: [embed],
        components: [row1, row2],
        flags: MessageFlags.Ephemeral
      });
      return;
    }
  } catch (error) {
    await handleInteractionError(interaction, error, 'pass modal');
  }
}
