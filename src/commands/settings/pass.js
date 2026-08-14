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

const ITEMS_PER_PAGE = 22; // Leaves 3 slots for [Previous, Next, Create New Level] (Max 25 options)

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
 * Fetch a single configured level
 */
async function getConfiguredLevel(guildId, level) {
  const pool = getPool();
  const res = await pool.query(
    'SELECT bc.level, bc.reward_coins, bc.reward_item_id, si.name as item_name, si.rarity FROM battlepass_config bc LEFT JOIN shop_items si ON bc.reward_item_id = si.id WHERE bc.guild_id = $1 AND bc.level = $2',
    [guildId, level]
  );
  return res.rows[0] || null;
}

/**
 * Render the Battlepass Dashboard payload with paginated dropdown
 */
export async function getPassDashboardPayload(guildId, page = 0) {
  const levels = await getConfiguredLevels(guildId);
  const totalLevels = levels.length;
  const totalPages = Math.max(1, Math.ceil(totalLevels / ITEMS_PER_PAGE));
  const currentPage = Math.min(Math.max(0, page), totalPages - 1);

  const startIdx = currentPage * ITEMS_PER_PAGE;
  const endIdx = startIdx + ITEMS_PER_PAGE;
  const pageLevels = levels.slice(startIdx, endIdx);

  const embed = new EmbedBuilder()
    .setTitle('🎟️ Battlepass Configuration')
    .setColor(0x5865F2);

  if (totalLevels === 0) {
    embed.setDescription(
      '_No level rewards configured yet._\n\n' +
      'Use the dropdown menu below and select **➕ Create New Level** to add your first level reward.'
    );
  } else {
    const lines = pageLevels.map(row => {
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

    embed.setDescription(
      '**Configured Levels (' + totalLevels + ' total — Page ' + (currentPage + 1) + '/' + totalPages + ')**\n\n' +
      lines.join('\n') +
      '\n\n_Select a level from the dropdown to edit or remove it, or choose **Create New Level**._'
    );
  }

  // Build Dropdown Options
  const options = [];

  // 1. Level items on this page
  for (const l of pageLevels) {
    const rewardParts = [];
    if (l.reward_coins > 0) rewardParts.push(l.reward_coins + ' Coins');
    if (l.item_name) rewardParts.push(l.item_name);
    const desc = rewardParts.length > 0 ? rewardParts.join(' + ') : 'No reward';

    options.push({
      label: 'Level ' + l.level,
      value: 'pass_view_level_' + l.level + '_page_' + currentPage,
      description: desc.slice(0, 100),
      emoji: '⭐'
    });
  }

  // 2. Previous Page (if not on first page)
  if (currentPage > 0) {
    options.push({
      label: '⬅️ Previous Page',
      value: 'pass_page_' + (currentPage - 1),
      description: 'Go to Page ' + currentPage + ' of ' + totalPages,
      emoji: '⬅️'
    });
  }

  // 3. Next Page (if more pages exist)
  if (currentPage < totalPages - 1) {
    options.push({
      label: '➡️ Next Page',
      value: 'pass_page_' + (currentPage + 1),
      description: 'Go to Page ' + (currentPage + 2) + ' of ' + totalPages,
      emoji: '➡️'
    });
  }

  // 4. Create New Level (Always at the very bottom)
  options.push({
    label: '➕ Create New Level',
    value: 'pass_create_level_page_' + currentPage,
    description: 'Configure a reward for a new level',
    emoji: '➕'
  });

  const select = new StringSelectMenuBuilder()
    .setCustomId('pass_main_select')
    .setPlaceholder(totalLevels > 0 ? 'Select a level to manage or create new level...' : 'Create a new level...')
    .addOptions(options);

  const row1 = new ActionRowBuilder().addComponents(select);

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
 * Render single level detail & management view
 */
async function getLevelDetailPayload(guildId, level, page = 0) {
  const data = await getConfiguredLevel(guildId, level);
  if (!data) {
    return getPassDashboardPayload(guildId, page);
  }

  const embed = new EmbedBuilder()
    .setTitle('🎟️ Battlepass — Level ' + level)
    .setColor(0x5865F2)
    .setDescription(
      '**Level ' + level + ' Configuration**\n\n' +
      '• **Coins Reward:** ' + (data.reward_coins > 0 ? (COIN_EMOJI + ' **' + Number(data.reward_coins).toLocaleString() + '**') : '_None_') + '\n' +
      '• **Item Reward:** ' + (data.item_name ? ('🎁 **' + data.item_name + '** (' + (data.rarity || 'Common') + ')') : '_None_') + '\n\n' +
      'Choose an action below:'
    );

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('pass_edit_level_' + level + '_page_' + page)
      .setLabel('Edit Reward')
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('pass_delete_level_' + level + '_page_' + page)
      .setLabel('Delete Level')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Danger)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('pass_home_page_' + page)
      .setLabel('Back to Levels')
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

    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => {});
    }

    // 1. Prerequisite Check: 5-Item Gate
    const count = await getUnlockedItemCount(guildId);
    if (count < 5) {
      const warning = '⚠️ Please add at least 5 unlocked items to the shop before configuring the Battlepass.';
      await interaction.editReply({ content: warning, embeds: [], components: [] });
      return;
    }

    // 2. Render Dashboard
    const payload = await getPassDashboardPayload(guildId, 0);
    await interaction.editReply({ content: '', ...payload });
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
    // 1. Dashboard Main Dropdown Select
    if (customId === 'pass_main_select') {
      const selectedValue = interaction.values[0];

      // A. Create New Level selected from dropdown
      if (selectedValue.startsWith('pass_create_level_page_')) {
        const page = parseInt(selectedValue.replace('pass_create_level_page_', ''), 10) || 0;
        const modal = new ModalBuilder()
          .setCustomId('pass_add_level_modal_page_' + page)
          .setTitle('Create Level Reward');

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

      // B. Pagination navigation selected from dropdown
      if (selectedValue.startsWith('pass_page_')) {
        if (!interaction.deferred && !interaction.replied) {
          await interaction.deferUpdate().catch(() => {});
        }
        const targetPage = parseInt(selectedValue.replace('pass_page_', ''), 10) || 0;
        const payload = await getPassDashboardPayload(guildId, targetPage);
        await interaction.editReply({ content: '', ...payload });
        return;
      }

      // C. Level selected -> Open Level Details view
      if (selectedValue.startsWith('pass_view_level_')) {
        if (!interaction.deferred && !interaction.replied) {
          await interaction.deferUpdate().catch(() => {});
        }
        const match = selectedValue.match(/pass_view_level_(\d+)_page_(\d+)/);
        const level = match ? parseInt(match[1], 10) : 1;
        const page = match ? parseInt(match[2], 10) : 0;

        const payload = await getLevelDetailPayload(guildId, level, page);
        await interaction.editReply({ content: '', ...payload });
        return;
      }
    }

    // 2. Back to Levels List
    if (customId.startsWith('pass_home_page_') || customId === 'pass_home') {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate().catch(() => {});
      }
      const page = customId.startsWith('pass_home_page_') ? (parseInt(customId.replace('pass_home_page_', ''), 10) || 0) : 0;
      const payload = await getPassDashboardPayload(guildId, page);
      await interaction.editReply({ content: '', ...payload });
      return;
    }

    // 3. Edit Level Reward Button -> Show Modal (Cannot defer before showModal)
    if (customId.startsWith('pass_edit_level_')) {
      const match = customId.match(/pass_edit_level_(\d+)_page_(\d+)/);
      const level = match ? parseInt(match[1], 10) : 1;
      const page = match ? parseInt(match[2], 10) : 0;

      const existingData = await getConfiguredLevel(guildId, level);

      const modal = new ModalBuilder()
        .setCustomId('pass_edit_level_modal_' + level + '_page_' + page)
        .setTitle('Edit Level ' + level + ' Reward');

      const levelInput = new TextInputBuilder()
        .setCustomId('pass_level_input')
        .setLabel('Target Level')
        .setStyle(TextInputStyle.Short)
        .setValue(String(level))
        .setRequired(true);

      const coinsInput = new TextInputBuilder()
        .setCustomId('pass_coins_input')
        .setLabel('Coin Reward (Optional, 0 for none)')
        .setStyle(TextInputStyle.Short)
        .setValue(String(existingData?.reward_coins || 0))
        .setRequired(false);

      modal.addComponents(
        new ActionRowBuilder().addComponents(levelInput),
        new ActionRowBuilder().addComponents(coinsInput)
      );

      await interaction.showModal(modal);
      return;
    }

    // 4. Delete Level Button
    if (customId.startsWith('pass_delete_level_')) {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate().catch(() => {});
      }

      const match = customId.match(/pass_delete_level_(\d+)_page_(\d+)/);
      const level = match ? parseInt(match[1], 10) : 1;
      const page = match ? parseInt(match[2], 10) : 0;

      const pool = getPool();
      await pool.query(
        'DELETE FROM battlepass_config WHERE guild_id = $1 AND level = $2',
        [guildId, level]
      );

      sysLog('Battlepass Level Deleted', {
        guild: guildId,
        user: interaction.user.id,
        detail: 'Level ' + level + ' deleted'
      });

      const payload = await getPassDashboardPayload(guildId, page);
      await interaction.editReply({ content: '', ...payload });
      return;
    }

    // 5. Handle Item Picker Selection (Step 2 of Add/Edit Level)
    if (customId.startsWith('pass_select_item_')) {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate().catch(() => {});
      }

      // pass_select_item_<level>_<coins>_page_<page>
      const match = customId.match(/pass_select_item_(\d+)_(\d+)_page_(\d+)/);
      const targetLevel = match ? parseInt(match[1], 10) : 1;
      const coinsAmount = match ? parseInt(match[2], 10) : 0;
      const page = match ? parseInt(match[3], 10) : 0;

      const selectedValue = interaction.values[0];
      const rewardItemId = selectedValue === 'none' ? null : parseInt(selectedValue, 10);

      if (coinsAmount <= 0 && !rewardItemId) {
        return interaction.followUp({
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

      const payload = await getPassDashboardPayload(guildId, page);
      await interaction.editReply({ content: '', ...payload });
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
    if (customId.startsWith('pass_add_level_modal') || customId.startsWith('pass_edit_level_modal')) {
      const pageMatch = customId.match(/_page_(\d+)/);
      const page = pageMatch ? parseInt(pageMatch[1], 10) : 0;

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
        .setCustomId('pass_select_item_' + level + '_' + coins + '_page_' + page)
        .setPlaceholder('Choose an item reward for Level ' + level + '...')
        .addOptions(options.slice(0, 25));

      const row1 = new ActionRowBuilder().addComponents(select);
      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('pass_home_page_' + page)
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
