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
import { getGuildConfig, setGuildConfig } from '../../storage/config.js';
import { getLootBoxCategoryEmoji } from '../../economy/lootbox.js';
import { getShopCategories } from '../../economy/shop.js';
import { COIN_EMOJI } from '../../shared.js';
import { sysLog, sysError, sendLog } from '../../utils/logger.js';
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
 * Get regular unlocked shop items (excluding loot boxes)
 */
async function getUnlockedShopItems(guildId) {
  const pool = getPool();
  const res = await pool.query(
    'SELECT id, name, price, rarity, item_type FROM shop_items WHERE guild_id = $1 AND is_active = true AND (is_tradable IS TRUE OR is_tradable IS NULL) AND (item_type != \'loot_box\' AND loot_box_id IS NULL) ORDER BY price ASC, name ASC LIMIT 24',
    [guildId]
  );
  return res.rows;
}

/**
 * Get all available loot boxes (chests) in the guild
 */
async function getGuildLootBoxes(guildId) {
  const pool = getPool();
  const res = await pool.query(
    'SELECT id, name, description FROM loot_boxes WHERE guild_id = $1 ORDER BY id ASC LIMIT 24',
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
    'SELECT bc.level, bc.reward_coins, bc.reward_item_id, bc.reward_chest_id, si.name as item_name, si.rarity as item_rarity, lb.name as chest_name FROM battlepass_config bc LEFT JOIN shop_items si ON bc.reward_item_id = si.id LEFT JOIN loot_boxes lb ON bc.reward_chest_id = lb.id WHERE bc.guild_id = $1 ORDER BY bc.level ASC',
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
    'SELECT bc.level, bc.reward_coins, bc.reward_item_id, bc.reward_chest_id, si.name as item_name, si.rarity as item_rarity, lb.name as chest_name FROM battlepass_config bc LEFT JOIN shop_items si ON bc.reward_item_id = si.id LEFT JOIN loot_boxes lb ON bc.reward_chest_id = lb.id WHERE bc.guild_id = $1 AND bc.level = $2',
    [guildId, level]
  );
  return res.rows[0] || null;
}

/**
 * Render the Battlepass Dashboard payload with persistent dropdown, 3 reward selectors, and Start/Pause toggle
 */
export async function getPassDashboardPayload(guildId, page = 0, selectedLevel = null, itemFolder = 'root') {
  const levels = await getConfiguredLevels(guildId);
  const config = await getGuildConfig(guildId) || {};
  const isEnabled = config.battlepass_enabled === true;
  const coinEmoji = COIN_EMOJI.forGuild(guildId);
  const lootBoxEmoji = await getLootBoxCategoryEmoji(guildId);
  const emojiMatch = lootBoxEmoji ? lootBoxEmoji.match(/:(\d+)>$/) : null;
  const selectChestEmoji = emojiMatch ? emojiMatch[1] : (lootBoxEmoji || '🎁');

  const totalLevels = levels.length;
  const totalPages = Math.max(1, Math.ceil(totalLevels / ITEMS_PER_PAGE));
  const currentPage = Math.min(Math.max(0, page), totalPages - 1);

  const startIdx = currentPage * ITEMS_PER_PAGE;
  const endIdx = startIdx + ITEMS_PER_PAGE;
  const pageLevels = levels.slice(startIdx, endIdx);

  const embed = new EmbedBuilder()
    .setColor(0x5865F2);

  // Build Level Switcher Dropdown Options
  const options = [];

  // 1. Level items on this page
  for (const l of pageLevels) {
    const rewardParts = [];
    if (l.reward_coins > 0) rewardParts.push(l.reward_coins + ' Coins');
    if (l.item_name) rewardParts.push(l.item_name);
    if (l.chest_name) rewardParts.push(l.chest_name);
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

  const levelSelect = new StringSelectMenuBuilder()
    .setCustomId('pass_main_select')
    .setPlaceholder('Select a level')
    .addOptions(options);

  const row1 = new ActionRowBuilder().addComponents(levelSelect);

  // If a specific level is selected for management -> Show 3 Select Menus + Actions
  if (selectedLevel !== null) {
    const data = await getConfiguredLevel(guildId, selectedLevel);
    embed.setTitle('⭐ Level ' + selectedLevel);

    const coinsText = data && data.reward_coins > 0
      ? (coinEmoji + ' **' + Number(data.reward_coins).toLocaleString() + '**')
      : '_None_';

    const itemText = data && data.item_name
      ? ('🏷️ **' + data.item_name + '** (' + (data.item_rarity || 'Common') + ')')
      : '_None_';

    const chestText = data && data.chest_name
      ? (lootBoxEmoji + ' **' + data.chest_name + '**')
      : '_None_';

    embed.setDescription(
      '• **Coins Reward:** ' + coinsText + '\n' +
      '• **Item Reward:** ' + itemText + '\n' +
      '• **Chest Reward:** ' + chestText
    );

    // Row 2: Select Menu 1 — Coins Selector
    const coinPresets = [
      { label: 'None (0 Coins)', value: '0', description: 'Remove coin reward', emoji: '❌' },
      { label: '50 Coins', value: '50' },
      { label: '100 Coins', value: '100' },
      { label: '250 Coins', value: '250' },
      { label: '500 Coins', value: '500' },
      { label: '1,000 Coins', value: '1000' },
      { label: '2,500 Coins', value: '2500' },
      { label: '5,000 Coins', value: '5000' },
      { label: '10,000 Coins', value: '10000' },
      { label: 'Custom Amount...', value: 'custom', description: 'Enter specific coin amount', emoji: '✏️' }
    ];

    const coinOptions = coinPresets.map(preset => ({
      label: preset.label,
      value: preset.value,
      description: preset.description,
      emoji: preset.emoji || coinEmoji
    }));

    const coinsSelect = new StringSelectMenuBuilder()
      .setCustomId('pass_coins_select_lvl_' + selectedLevel + '_pg_' + currentPage)
      .setPlaceholder('Set Coins')
      .addOptions(coinOptions);

    const row2 = new ActionRowBuilder().addComponents(coinsSelect);

    // Row 3: Select Menu 2 — Items Selector (Folder-Aware)
    const categories = await getShopCategories(guildId);
    const unlockedItems = await getUnlockedShopItems(guildId);
    const itemOptions = [];

    if (categories && categories.length > 0) {
      if (itemFolder === 'root') {
        itemOptions.push({
          label: 'None (Remove Item)',
          value: 'none',
          description: 'No item reward for this level',
          emoji: '❌'
        });

        for (const cat of categories) {
          const count = unlockedItems.filter(i => Number(i.category_id) === Number(cat.id)).length;
          if (count > 0) {
            itemOptions.push({
              label: `📂 ${cat.name.slice(0, 50)}`,
              value: 'folder_' + cat.id,
              description: `${count} item(s) in this folder`,
              emoji: '📂'
            });
          }
        }

        const uncatCount = unlockedItems.filter(i => !i.category_id).length;
        if (uncatCount > 0) {
          itemOptions.push({
            label: '📁 Uncategorized Items',
            value: 'folder_null',
            description: `${uncatCount} standalone item(s)`,
            emoji: '📁'
          });
        }
      } else {
        // Inside a specific folder
        const targetCatId = itemFolder === 'null' ? null : parseInt(itemFolder, 10);
        const currentCat = categories.find(c => Number(c.id) === targetCatId);
        const folderItems = unlockedItems.filter(i => targetCatId === null ? !i.category_id : Number(i.category_id) === targetCatId);

        itemOptions.push({
          label: '⬅️ Back to Folders',
          value: 'folder_root',
          description: 'Browse all category folders',
          emoji: '⬅️'
        });

        itemOptions.push({
          label: 'None (Remove Item)',
          value: 'none',
          description: 'No item reward for this level',
          emoji: '❌'
        });

        for (const item of folderItems) {
          const priceLabel = item.price != null ? (Number(item.price).toLocaleString() + ' Coins') : 'Special Item';
          itemOptions.push({
            label: item.name.slice(0, 50),
            value: String(item.id),
            description: (priceLabel + ' | ' + (item.rarity || 'Common')).slice(0, 50),
            emoji: '🏷️'
          });
        }
      }
    } else {
      // Direct list if server has no categories
      itemOptions.push({
        label: 'None (Remove Item)',
        value: 'none',
        description: 'No item reward for this level',
        emoji: '❌'
      });

      for (const item of unlockedItems) {
        const priceLabel = item.price != null ? (Number(item.price).toLocaleString() + ' Coins') : 'Special Item';
        itemOptions.push({
          label: item.name.slice(0, 50),
          value: String(item.id),
          description: (priceLabel + ' | ' + (item.rarity || 'Common')).slice(0, 50),
          emoji: '🏷️'
        });
      }
    }

    const itemsPlaceholder = itemFolder !== 'root'
      ? (itemFolder === 'null' ? '📁 Uncategorized Items' : `📂 ${categories.find(c => Number(c.id) === parseInt(itemFolder, 10))?.name || 'Folder'}`)
      : 'Set Items';

    const itemsSelect = new StringSelectMenuBuilder()
      .setCustomId('pass_items_select_lvl_' + selectedLevel + '_pg_' + currentPage + '_fld_' + itemFolder)
      .setPlaceholder(itemsPlaceholder.slice(0, 100))
      .addOptions(itemOptions.slice(0, 25));

    const row3 = new ActionRowBuilder().addComponents(itemsSelect);

    // Row 4: Select Menu 3 — Chests (Loot Boxes) Selector
    const guildLootBoxes = await getGuildLootBoxes(guildId);
    const chestOptions = [
      {
        label: 'None (Remove Chest)',
        value: 'none',
        description: 'No chest reward for this level',
        emoji: '❌'
      }
    ];

    for (const chest of guildLootBoxes) {
      chestOptions.push({
        label: chest.name.slice(0, 50),
        value: String(chest.id),
        description: (chest.description || 'Loot Box Chest').slice(0, 50),
        emoji: selectChestEmoji
      });
    }

    const chestsSelect = new StringSelectMenuBuilder()
      .setCustomId('pass_chests_select_lvl_' + selectedLevel + '_pg_' + currentPage)
      .setPlaceholder('Set Chests')
      .addOptions(chestOptions.slice(0, 25));

    const row4 = new ActionRowBuilder().addComponents(chestsSelect);

    // Row 5: Action Buttons (Back & Delete Level)
    const row5 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('pass_home_page_' + currentPage)
        .setLabel('Back')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('pass_del_btn_' + selectedLevel + '_pg_' + currentPage)
        .setLabel('Delete Level')
        .setEmoji('🗑️')
        .setStyle(ButtonStyle.Danger)
    );

    return { embeds: [embed], components: [row1, row2, row3, row4, row5] };
  }

  // Default Overview (No level selected)
  embed.setTitle('⭐ Levels Configuration');

  const baseXp = parseInt(config.battlepass_base_xp || config.battlepass_xp_per_level || 100, 10);
  const incrementXp = parseInt(config.battlepass_xp_increment || 0, 10);
  const statusText = isEnabled ? '🟢 **Active**' : '⏸️ **Paused**';

  const scalingDesc = incrementXp > 0
    ? '• **Base XP:** ' + baseXp.toLocaleString() + ' points (Level 1)\n• **XP Scaling:** +' + incrementXp.toLocaleString() + ' points / level'
    : '• **XP Per Level:** ' + baseXp.toLocaleString() + ' points (Flat)';

  if (totalLevels === 0) {
    embed.setDescription(
      '• **Status:** ' + statusText + '\n' +
      scalingDesc + '\n\n' +
      '_No level rewards configured yet._'
    );
  } else {
    const lines = pageLevels.map(row => {
      const parts = [];
      if (row.reward_coins > 0) {
        parts.push(coinEmoji + ' **' + Number(row.reward_coins).toLocaleString() + '**');
      }
      if (row.item_name) {
        parts.push('🏷️ **' + row.item_name + '**');
      }
      if (row.chest_name) {
        parts.push(lootBoxEmoji + ' **' + row.chest_name + '**');
      }
      const rewardText = parts.length > 0 ? parts.join(' + ') : '_No Reward Set_';
      return '• **Level ' + row.level + ':** ' + rewardText;
    });

    embed.setDescription(
      '• **Status:** ' + statusText + '\n' +
      scalingDesc + '\n\n' +
      lines.join('\n')
    );
  }

  const startPauseButton = isEnabled
    ? new ButtonBuilder()
        .setCustomId('pass_toggle_pause_pg_' + currentPage)
        .setLabel('Pause')
        .setEmoji('⏸️')
        .setStyle(ButtonStyle.Danger)
    : new ButtonBuilder()
        .setCustomId('pass_toggle_start_pg_' + currentPage)
        .setLabel('Start')
        .setEmoji('▶️')
        .setStyle(ButtonStyle.Success);

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('settings_home')
      .setLabel('Back')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('pass_set_xp_threshold_pg_' + currentPage)
      .setLabel('XP')
      .setEmoji('⚡')
      .setStyle(ButtonStyle.Primary),
    startPauseButton
  );

  return { embeds: [embed], components: [row1, row2] };
}

/**
 * Entry point when [ ⭐ Levels ] is clicked in /settings
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
      const warning = '⚠️ Please add at least 5 unlocked items to the shop before configuring Levels.';
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
 * Handle Levels Button & Select Interactions
 */
export async function handlePassComponent(interaction) {
  const customId = interaction.customId;
  const guildId = interaction.guildId;

  try {
    // 1. Main Level Selector Dropdown
    if (customId === 'pass_main_select') {
      const selectedValue = interaction.values[0];

      // A. Create New Level Action
      if (selectedValue.startsWith('pass_create_level_page_')) {
        const page = parseInt(selectedValue.replace('pass_create_level_page_', ''), 10) || 0;
        const modal = new ModalBuilder()
          .setCustomId('pass_create_lvl_modal_pg_' + page)
          .setTitle('Create Level');

        const levelInput = new TextInputBuilder()
          .setCustomId('pass_level_input')
          .setLabel('Level Number (e.g. 1, 2, 3)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Enter level number')
          .setMinLength(1)
          .setMaxLength(4)
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(levelInput));
        await interaction.showModal(modal);
        return;
      }

      // B. Pagination Action
      if (selectedValue.startsWith('pass_page_')) {
        if (!interaction.deferred && !interaction.replied) {
          await interaction.deferUpdate().catch(() => {});
        }
        const targetPage = parseInt(selectedValue.replace('pass_page_', ''), 10);
        const payload = await getPassDashboardPayload(guildId, targetPage, null);
        await interaction.editReply({ content: '', ...payload });
        return;
      }

      // C. Level Selected for Detailed Configuration
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

    // 2. Select Menu 1 — Coins Selector
    if (customId.startsWith('pass_coins_select_lvl_')) {
      const match = customId.match(/pass_coins_select_lvl_(\d+)_pg_(\d+)/);
      const level = match ? parseInt(match[1], 10) : 1;
      const page = match ? parseInt(match[2], 10) : 0;
      const selectedValue = interaction.values[0];

      // Custom coins option -> open modal
      if (selectedValue === 'custom') {
        const modal = new ModalBuilder()
          .setCustomId('pass_set_coins_modal_' + level + '_pg_' + page)
          .setTitle('Set Custom Coins — Level ' + level);

        const coinsInput = new TextInputBuilder()
          .setCustomId('pass_coins_input')
          .setLabel('Coins reward amount')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Enter coin amount (e.g. 500)')
          .setMinLength(1)
          .setMaxLength(8)
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(coinsInput));
        await interaction.showModal(modal);
        return;
      }

      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate().catch(() => {});
      }

      const coins = parseInt(selectedValue, 10) || 0;
      const pool = getPool();
      await pool.query(
        'INSERT INTO battlepass_config (guild_id, level, reward_coins) VALUES ($1, $2, $3) ON CONFLICT (guild_id, level) DO UPDATE SET reward_coins = $3',
        [guildId, level, coins]
      );

      sysLog('Level Coins Updated', {
        guild: guildId,
        user: interaction.user.id,
        detail: 'Level ' + level + ' coins set to ' + coins
      });

      const payload = await getPassDashboardPayload(guildId, page, level);
      await interaction.editReply({ content: '', ...payload });
      return;
    }

    // 3. Select Menu 2 — Items Selector (Folder-Aware)
    if (customId.startsWith('pass_items_select_lvl_')) {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate().catch(() => {});
      }
      const match = customId.match(/pass_items_select_lvl_(\d+)_pg_(\d+)/);
      const level = match ? parseInt(match[1], 10) : 1;
      const page = match ? parseInt(match[2], 10) : 0;
      const selectedValue = interaction.values[0];

      // Folder navigation check
      if (selectedValue.startsWith('folder_')) {
        const folderTarget = selectedValue.replace('folder_', '');
        const payload = await getPassDashboardPayload(guildId, page, level, folderTarget);
        await interaction.editReply({ content: '', ...payload });
        return;
      }

      const itemId = selectedValue === 'none' ? null : parseInt(selectedValue, 10);

      const pool = getPool();
      await pool.query(
        'INSERT INTO battlepass_config (guild_id, level, reward_coins, reward_item_id) VALUES ($1, $2, 0, $3) ON CONFLICT (guild_id, level) DO UPDATE SET reward_item_id = $3',
        [guildId, level, itemId]
      );

      sysLog('Level Item Updated', {
        guild: guildId,
        user: interaction.user.id,
        detail: 'Level ' + level + ' item set to ' + (itemId || 'None')
      });

      sendLog(interaction.guild, 'audit', 'cyan', '⭐ Level Item Updated', `Admin **<@${interaction.user.id}>** set **Level ${level}** item reward to ${itemId ? `Item #${itemId}` : 'None'}.`);

      const payload = await getPassDashboardPayload(guildId, page, level, 'root');
      await interaction.editReply({ content: '', ...payload });
      return;
    }

    // 4. Select Menu 3 — Chests (Loot Boxes) Selector
    if (customId.startsWith('pass_chests_select_lvl_')) {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate().catch(() => {});
      }
      const match = customId.match(/pass_chests_select_lvl_(\d+)_pg_(\d+)/);
      const level = match ? parseInt(match[1], 10) : 1;
      const page = match ? parseInt(match[2], 10) : 0;
      const selectedValue = interaction.values[0];
      const chestId = selectedValue === 'none' ? null : parseInt(selectedValue, 10);

      const pool = getPool();
      await pool.query(
        'INSERT INTO battlepass_config (guild_id, level, reward_coins, reward_chest_id) VALUES ($1, $2, 0, $3) ON CONFLICT (guild_id, level) DO UPDATE SET reward_chest_id = $3',
        [guildId, level, chestId]
      );

      sysLog('Level Chest Updated', {
        guild: guildId,
        user: interaction.user.id,
        detail: 'Level ' + level + ' chest set to ' + (chestId || 'None')
      });

      const payload = await getPassDashboardPayload(guildId, page, level);
      await interaction.editReply({ content: '', ...payload });
      return;
    }

    // 5. Start Levels -> Confirmation Dialogue
    if (customId.startsWith('pass_toggle_start_pg_')) {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate().catch(() => {});
      }
      const page = parseInt(customId.replace('pass_toggle_start_pg_', ''), 10) || 0;

      const embed = new EmbedBuilder()
        .setTitle('⚠️ Start Level Progression?')
        .setColor(0xFEE75C)
        .setDescription(
          'Please make sure your levels and rewards are fully configured before starting.\n\n' +
          'Once started, members will begin earning XP and unlocking rewards.\n\n' +
          '_You can pause level progression at any time to freeze progress._'
        );

      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('pass_home_page_' + page)
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('pass_confirm_start_pg_' + page)
          .setLabel('Confirm & Start')
          .setEmoji('✅')
          .setStyle(ButtonStyle.Success)
      );

      await interaction.editReply({
        embeds: [embed],
        components: [row1]
      });
      return;
    }

    // 6. Confirm Start
    if (customId.startsWith('pass_confirm_start_pg_')) {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate().catch(() => {});
      }
      const page = parseInt(customId.replace('pass_confirm_start_pg_', ''), 10) || 0;

      await setGuildConfig(guildId, { battlepass_enabled: true });

      sysLog('Levels Started', {
        guild: guildId,
        user: interaction.user.id
      });

      sendLog(interaction.guild, 'audit', 'green', '⭐ Levels Started', `Admin **<@${interaction.user.id}>** started Level progression.`);

      const payload = await getPassDashboardPayload(guildId, page, null);
      await interaction.editReply({ content: '', ...payload });
      return;
    }

    // 7. Pause Levels
    if (customId.startsWith('pass_toggle_pause_pg_')) {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate().catch(() => {});
      }
      const page = parseInt(customId.replace('pass_toggle_pause_pg_', ''), 10) || 0;

      await setGuildConfig(guildId, { battlepass_enabled: false });

      sysLog('Levels Paused', {
        guild: guildId,
        user: interaction.user.id
      });

      sendLog(interaction.guild, 'audit', 'orange', '⏸️ Levels Paused', `Admin **<@${interaction.user.id}>** paused Level progression.`);

      const payload = await getPassDashboardPayload(guildId, page, null);
      await interaction.editReply({ content: '', ...payload });
      return;
    }

    // 8. Back to Levels List
    if (customId.startsWith('pass_home_page_') || customId === 'pass_home') {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate().catch(() => {});
      }
      const page = customId.startsWith('pass_home_page_') ? (parseInt(customId.replace('pass_home_page_', ''), 10) || 0) : 0;
      const payload = await getPassDashboardPayload(guildId, page, null);
      await interaction.editReply({ content: '', ...payload });
      return;
    }

    // 9. Delete Level Button
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
      await pool.query(
        'DELETE FROM user_pass_claims WHERE guild_id = $1 AND level_claimed = $2',
        [guildId, level]
      );

      sysLog('Level Deleted', {
        guild: guildId,
        user: interaction.user.id,
        detail: 'Level ' + level + ' deleted and claim history reset'
      });

      sendLog(interaction.guild, 'audit', 'red', '🗑️ Level Deleted', `Admin **<@${interaction.user.id}>** deleted **Level ${level}**.`);

      const payload = await getPassDashboardPayload(guildId, page, null);
      await interaction.editReply({ content: '', ...payload });
      return;
    }

    // 10. Set XP Threshold Button
    if (customId.startsWith('pass_set_xp_threshold_pg_')) {
      const page = parseInt(customId.replace('pass_set_xp_threshold_pg_', ''), 10) || 0;
      const config = await getGuildConfig(guildId) || {};
      const baseXp = parseInt(config.battlepass_base_xp || config.battlepass_xp_per_level || 100, 10);
      const incrementXp = parseInt(config.battlepass_xp_increment || 0, 10);

      const modal = new ModalBuilder()
        .setCustomId('pass_xp_threshold_modal_pg_' + page)
        .setTitle('Configure Level XP');

      const baseInput = new TextInputBuilder()
        .setCustomId('pass_base_xp_input')
        .setLabel('Base XP for Level 1 (e.g. 10)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Enter base XP (e.g. 10, 50, 100)')
        .setValue(String(baseXp))
        .setMinLength(1)
        .setMaxLength(6)
        .setRequired(true);

      const incInput = new TextInputBuilder()
        .setCustomId('pass_increment_xp_input')
        .setLabel('XP added per level (0 for flat)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Enter increment (e.g. 0, 5, 25)')
        .setValue(String(incrementXp))
        .setMinLength(1)
        .setMaxLength(6)
        .setRequired(true);

      modal.addComponents(
        new ActionRowBuilder().addComponents(baseInput),
        new ActionRowBuilder().addComponents(incInput)
      );
      await interaction.showModal(modal);
      return;
    }

  } catch (error) {
    await handleInteractionError(interaction, error, 'pass component');
  }
}

/**
 * Handle Modal Submissions for Levels
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

      await interaction.deferUpdate().catch(() => {});

      const pool = getPool();
      await pool.query(
        'INSERT INTO battlepass_config (guild_id, level, reward_coins, reward_item_id) VALUES ($1, $2, 0, NULL) ON CONFLICT (guild_id, level) DO NOTHING',
        [guildId, level]
      );

      sysLog('Level Created', {
        guild: guildId,
        user: interaction.user.id,
        detail: 'Level ' + level + ' created'
      });

      sendLog(interaction.guild, 'audit', 'cyan', '⭐ Level Created', `Admin **<@${interaction.user.id}>** created **Level ${level}**.`);

      // Render Level Management View directly for this newly created level
      const payload = await getPassDashboardPayload(guildId, page, level);
      await interaction.editReply({ content: '', ...payload });
      return;
    }

    // 2. Set Coins Modal (Custom Amount)
    if (customId.startsWith('pass_set_coins_modal_')) {
      const match = customId.match(/pass_set_coins_modal_(\d+)_pg_(\d+)/);
      const level = match ? parseInt(match[1], 10) : 1;
      const page = match ? parseInt(match[2], 10) : 0;

      const coinsRaw = interaction.fields.getTextInputValue('pass_coins_input').trim();
      const coins = parseInt(coinsRaw, 10);
      if (isNaN(coins) || coins < 0) {
        return interaction.reply({ content: '❌ Coin amount must be 0 or a positive whole number.', flags: MessageFlags.Ephemeral });
      }

      await interaction.deferUpdate().catch(() => {});

      const pool = getPool();
      await pool.query(
        'INSERT INTO battlepass_config (guild_id, level, reward_coins, reward_item_id) VALUES ($1, $2, $3, NULL) ON CONFLICT (guild_id, level) DO UPDATE SET reward_coins = $3',
        [guildId, level, coins]
      );

      sysLog('Level Coins Configured', {
        guild: guildId,
        user: interaction.user.id,
        detail: 'Level ' + level + ' coins set to ' + coins
      });

      sendLog(interaction.guild, 'audit', 'cyan', '⭐ Level Coins Updated', `Admin **<@${interaction.user.id}>** set **Level ${level}** coins to **${coins.toLocaleString()}**.`);

      const payload = await getPassDashboardPayload(guildId, page, level);
      await interaction.editReply({ content: '', ...payload });
      return;
    }

    // 3. Set XP Threshold Modal (Base XP + Increment)
    if (customId.startsWith('pass_xp_threshold_modal_pg_')) {
      const page = parseInt(customId.replace('pass_xp_threshold_modal_pg_', ''), 10) || 0;
      const baseRaw = interaction.fields.getTextInputValue('pass_base_xp_input').trim();
      const incRaw = interaction.fields.getTextInputValue('pass_increment_xp_input').trim();

      const baseXp = parseInt(baseRaw, 10);
      const incrementXp = parseInt(incRaw, 10);

      if (isNaN(baseXp) || baseXp < 1) {
        return interaction.reply({ content: '❌ Base XP must be a positive whole number (e.g. 10).', flags: MessageFlags.Ephemeral });
      }

      if (isNaN(incrementXp) || incrementXp < 0) {
        return interaction.reply({ content: '❌ XP increment must be 0 or a positive whole number (e.g. 0, 5).', flags: MessageFlags.Ephemeral });
      }

      await interaction.deferUpdate().catch(() => {});

      await setGuildConfig(guildId, {
        battlepass_base_xp: baseXp,
        battlepass_xp_increment: incrementXp,
        battlepass_xp_per_level: baseXp
      });

      sysLog('Level XP Scaling Set', {
        guild: guildId,
        user: interaction.user.id,
        detail: `Base: ${baseXp} | Increment: +${incrementXp}/lvl`
      });

      const logDesc = incrementXp > 0
        ? `Admin **<@${interaction.user.id}>** configured Level XP scaling:\n• **Base XP:** **${baseXp.toLocaleString()}** (Level 1)\n• **Scaling:** **+${incrementXp.toLocaleString()}** XP per level`
        : `Admin **<@${interaction.user.id}>** set Level XP to **${baseXp.toLocaleString()}** points per level (Flat).`;

      sendLog(interaction.guild, 'audit', 'cyan', '⚡ Level XP Configured', logDesc);

      const payload = await getPassDashboardPayload(guildId, page, null);
      await interaction.editReply({ content: '', ...payload });
      return;
    }
  } catch (error) {
    await handleInteractionError(interaction, error, 'pass modal');
  }
}
