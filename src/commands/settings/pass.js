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
 * Render the Battlepass Dashboard payload with persistent dropdown
 */
export async function getPassDashboardPayload(guildId, page = 0, selectedLevel = null) {
  const levels = await getConfiguredLevels(guildId);
  const totalLevels = levels.length;
  const totalPages = Math.max(1, Math.ceil(totalLevels / ITEMS_PER_PAGE));
  const currentPage = Math.min(Math.max(0, page), totalPages - 1);

  const startIdx = currentPage * ITEMS_PER_PAGE;
  const endIdx = startIdx + ITEMS_PER_PAGE;
  const pageLevels = levels.slice(startIdx, endIdx);

  const embed = new EmbedBuilder()
    .setColor(0x5865F2);

  // Build Dropdown Options
  const options = [];

  // 1. Level items on this page
  for (const l of pageLevels) {
    const rewardParts = [];
    if (l.reward_coins > 0) rewardParts.push(l.reward_coins + ' Coins');
    if (l.item_name) rewardParts.push(l.item_name);
    const desc = rewardParts.length > 0 ? rewardParts.join(' + ') : 'No reward set';

    options.push({
      label: 'Level ' + l.level,
      value: 'pass_view_level_' + l.level + '_page_' + currentPage,
      description: desc.slice(0, 100),
      emoji: '⭐',
      default: selectedLevel !== null && Number(selectedLevel) === Number(l.level)
    });
  }

  // 2. Previous Page
  if (currentPage > 0) {
    options.push({
      label: 'Previous Page',
      value: 'pass_page_' + (currentPage - 1),
      emoji: '⬅️'
    });
  }

  // 3. Next Page
  if (currentPage < totalPages - 1) {
    options.push({
      label: 'Next Page',
      value: 'pass_page_' + (currentPage + 1),
      emoji: '➡️'
    });
  }

  // 4. Create New Level
  options.push({
    label: 'Create New Level',
    value: 'pass_create_level_page_' + currentPage,
    emoji: '➕'
  });

  const select = new StringSelectMenuBuilder()
    .setCustomId('pass_main_select')
    .setPlaceholder(totalLevels > 0 ? 'Select a level to manage or create new level...' : 'Create a new level...')
    .addOptions(options);

  const row1 = new ActionRowBuilder().addComponents(select);

  // If a specific level is selected for management
  if (selectedLevel !== null) {
    const data = await getConfiguredLevel(guildId, selectedLevel);
    embed.setTitle('🎟️ Battlepass — Level ' + selectedLevel);

    const coinsText = data && data.reward_coins > 0
      ? (COIN_EMOJI + ' **' + Number(data.reward_coins).toLocaleString() + '**')
      : '_None_';

    const itemText = data && data.item_name
      ? ('🎁 **' + data.item_name + '** (' + (data.rarity || 'Common') + ')')
      : '_None_';

    embed.setDescription(
      '**Level ' + selectedLevel + ' Rewards**\n\n' +
      '• **Coins Reward:** ' + coinsText + '\n' +
      '• **Item Reward:** ' + itemText + '\n\n' +
      '_Use the buttons below to configure rewards for Level ' + selectedLevel + ', or switch levels using the menu above._'
    );

    // Row 2: Action buttons for the selected level
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('pass_coins_btn_' + selectedLevel + '_pg_' + currentPage)
        .setLabel('Coins Reward')
        .setEmoji('🪙')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('pass_item_btn_' + selectedLevel + '_pg_' + currentPage)
        .setLabel('Item Reward')
        .setEmoji('🎁')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('pass_del_btn_' + selectedLevel + '_pg_' + currentPage)
        .setLabel('Delete Level')
        .setEmoji('🗑️')
        .setStyle(ButtonStyle.Danger)
    );

    // Row 3: Back to main settings
    const row3 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('settings_home')
        .setLabel('Back')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary)
    );

    return { embeds: [embed], components: [row1, row2, row3] };
  }

  // Default Overview (No level selected)
  embed.setTitle('🎟️ Battlepass Configuration');

  if (totalLevels === 0) {
    embed.setDescription(
      '_No level rewards configured yet._\n\n' +
      'Use the dropdown menu below and select **➕ Create New Level** to add your first level.'
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
      const rewardText = parts.length > 0 ? parts.join(' + ') : '_No Reward Set_';
      return '• **Level ' + row.level + ':** ' + rewardText;
    });

    embed.setDescription(
      '**Configured Levels (' + totalLevels + ' total — Page ' + (currentPage + 1) + '/' + totalPages + ')**\n\n' +
      lines.join('\n') +
      '\n\n_Select a level from the dropdown to manage its rewards, or choose **Create New Level**._'
    );
  }

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
    const payload = await getPassDashboardPayload(guildId, 0, null);
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
    // 1. Main Dropdown Selection
    if (customId === 'pass_main_select') {
      const selectedValue = interaction.values[0];

      // A. Create New Level -> Show Modal asking ONLY for level number
      if (selectedValue.startsWith('pass_create_level_page_')) {
        const page = parseInt(selectedValue.replace('pass_create_level_page_', ''), 10) || 0;
        const modal = new ModalBuilder()
          .setCustomId('pass_create_lvl_modal_pg_' + page)
          .setTitle('Create New Level');

        const levelInput = new TextInputBuilder()
          .setCustomId('pass_level_input')
          .setLabel('Target Level Number (e.g. 5, 10, 25)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Enter level number')
          .setMinLength(1)
          .setMaxLength(6)
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(levelInput));
        await interaction.showModal(modal);
        return;
      }

      // B. Pagination
      if (selectedValue.startsWith('pass_page_')) {
        if (!interaction.deferred && !interaction.replied) {
          await interaction.deferUpdate().catch(() => {});
        }
        const targetPage = parseInt(selectedValue.replace('pass_page_', ''), 10) || 0;
        const payload = await getPassDashboardPayload(guildId, targetPage, null);
        await interaction.editReply({ content: '', ...payload });
        return;
      }

      // C. Switch to specific Level view
      if (selectedValue.startsWith('pass_view_level_')) {
        if (!interaction.deferred && !interaction.replied) {
          await interaction.deferUpdate().catch(() => {});
        }
        const match = selectedValue.match(/pass_view_level_(\d+)_page_(\d+)/);
        const level = match ? parseInt(match[1], 10) : 1;
        const page = match ? parseInt(match[2], 10) : 0;

        const payload = await getPassDashboardPayload(guildId, page, level);
        await interaction.editReply({ content: '', ...payload });
        return;
      }
    }

    // 2. Set Coins Button for Selected Level -> Show Coins Modal
    if (customId.startsWith('pass_coins_btn_')) {
      const match = customId.match(/pass_coins_btn_(\d+)_pg_(\d+)/);
      const level = match ? parseInt(match[1], 10) : 1;
      const page = match ? parseInt(match[2], 10) : 0;

      const data = await getConfiguredLevel(guildId, level);

      const modal = new ModalBuilder()
        .setCustomId('pass_set_coins_modal_' + level + '_pg_' + page)
        .setTitle('Set Level ' + level + ' Coins');

      const coinsInput = new TextInputBuilder()
        .setCustomId('pass_coins_input')
        .setLabel('Coin Reward (0 to remove)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Enter coin amount (e.g. 500)')
        .setValue(String(data?.reward_coins || 0))
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(coinsInput));
      await interaction.showModal(modal);
      return;
    }

    // 3. Set Item Button for Selected Level -> Show Shop Item Selector
    if (customId.startsWith('pass_item_btn_')) {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate().catch(() => {});
      }

      const match = customId.match(/pass_item_btn_(\d+)_pg_(\d+)/);
      const level = match ? parseInt(match[1], 10) : 1;
      const page = match ? parseInt(match[2], 10) : 0;

      const unlockedItems = await getUnlockedShopItems(guildId);

      const options = [
        {
          label: 'None (Remove Item)',
          value: 'none',
          description: 'No item reward for this level',
          emoji: '❌'
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
        .setCustomId('pass_bind_item_' + level + '_pg_' + page)
        .setPlaceholder('Choose an unlocked shop item for Level ' + level + '...')
        .addOptions(options.slice(0, 25));

      const row1 = new ActionRowBuilder().addComponents(select);
      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('pass_cancel_item_' + level + '_pg_' + page)
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary)
      );

      const embed = new EmbedBuilder()
        .setTitle('🎁 Level ' + level + ' — Select Item Reward')
        .setDescription('Choose an unlocked shop item from the list below to bind to **Level ' + level + '**.')
        .setColor(0x5865F2);

      await interaction.editReply({
        embeds: [embed],
        components: [row1, row2]
      });
      return;
    }

    // 4. Cancel Item Selection
    if (customId.startsWith('pass_cancel_item_')) {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate().catch(() => {});
      }
      const match = customId.match(/pass_cancel_item_(\d+)_pg_(\d+)/);
      const level = match ? parseInt(match[1], 10) : 1;
      const page = match ? parseInt(match[2], 10) : 0;

      const payload = await getPassDashboardPayload(guildId, page, level);
      await interaction.editReply({ content: '', ...payload });
      return;
    }

    // 5. Bind Item Selected
    if (customId.startsWith('pass_bind_item_')) {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate().catch(() => {});
      }
      const match = customId.match(/pass_bind_item_(\d+)_pg_(\d+)/);
      const level = match ? parseInt(match[1], 10) : 1;
      const page = match ? parseInt(match[2], 10) : 0;

      const selectedValue = interaction.values[0];
      const rewardItemId = selectedValue === 'none' ? null : parseInt(selectedValue, 10);

      const pool = getPool();
      await pool.query(
        'INSERT INTO battlepass_config (guild_id, level, reward_coins, reward_item_id) VALUES ($1, $2, 0, $3) ON CONFLICT (guild_id, level) DO UPDATE SET reward_item_id = $3',
        [guildId, level, rewardItemId]
      );

      sysLog('Battlepass Item Bound', {
        guild: guildId,
        user: interaction.user.id,
        detail: 'Level ' + level + ' item set to ' + (rewardItemId || 'None')
      });

      const payload = await getPassDashboardPayload(guildId, page, level);
      await interaction.editReply({ content: '', ...payload });
      return;
    }

    // 6. Delete Level Button
    if (customId.startsWith('pass_del_btn_')) {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate().catch(() => {});
      }
      const match = customId.match(/pass_del_btn_(\d+)_pg_(\d+)/);
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

      const payload = await getPassDashboardPayload(guildId, page, null);
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
    // 1. Create New Level Modal (Level Number only)
    if (customId.startsWith('pass_create_lvl_modal_pg_')) {
      const page = parseInt(customId.replace('pass_create_lvl_modal_pg_', ''), 10) || 0;
      const levelRaw = interaction.fields.getTextInputValue('pass_level_input').trim();

      const level = parseInt(levelRaw, 10);
      if (isNaN(level) || level <= 0) {
        return interaction.reply({ content: '❌ Level must be a positive whole number.', flags: MessageFlags.Ephemeral });
      }

      const pool = getPool();
      await pool.query(
        'INSERT INTO battlepass_config (guild_id, level, reward_coins, reward_item_id) VALUES ($1, $2, 0, NULL) ON CONFLICT (guild_id, level) DO NOTHING',
        [guildId, level]
      );

      sysLog('Battlepass Level Created', {
        guild: guildId,
        user: interaction.user.id,
        detail: 'Level ' + level + ' created'
      });

      // Render Level Management View directly for this newly created level
      const payload = await getPassDashboardPayload(guildId, page, level);
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: '', ...payload });
      } else {
        await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
      }
      return;
    }

    // 2. Set Coins Modal
    if (customId.startsWith('pass_set_coins_modal_')) {
      const match = customId.match(/pass_set_coins_modal_(\d+)_pg_(\d+)/);
      const level = match ? parseInt(match[1], 10) : 1;
      const page = match ? parseInt(match[2], 10) : 0;

      const coinsRaw = interaction.fields.getTextInputValue('pass_coins_input').trim();
      const coins = parseInt(coinsRaw, 10);
      if (isNaN(coins) || coins < 0) {
        return interaction.reply({ content: '❌ Coin amount must be 0 or a positive whole number.', flags: MessageFlags.Ephemeral });
      }

      const pool = getPool();
      await pool.query(
        'INSERT INTO battlepass_config (guild_id, level, reward_coins, reward_item_id) VALUES ($1, $2, $3, NULL) ON CONFLICT (guild_id, level) DO UPDATE SET reward_coins = $3',
        [guildId, level, coins]
      );

      sysLog('Battlepass Coins Configured', {
        guild: guildId,
        user: interaction.user.id,
        detail: 'Level ' + level + ' coins set to ' + coins
      });

      const payload = await getPassDashboardPayload(guildId, page, level);
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: '', ...payload });
      } else {
        await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
      }
      return;
    }
  } catch (error) {
    await handleInteractionError(interaction, error, 'pass modal');
  }
}
