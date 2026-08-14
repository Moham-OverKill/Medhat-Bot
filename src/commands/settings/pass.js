import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags
} from 'discord.js';
import { getPool } from '../../storage/postgres.js';
import { getGuildConfig, setGuildConfig } from '../../storage/config.js';
import { sysLog, sendLog } from '../../utils/logger.js';
import { getShopCategories } from '../../economy/shop.js';
import { getLootBoxCategoryName, getLootBoxCategoryEmoji } from '../../economy/lootbox.js';
import { COIN_EMOJI } from '../../shared.js';
import { handleInteractionError } from '../../utils/errors.js';

const ITEMS_PER_PAGE = 5;

/**
 * Get count of unlocked shop items
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
    'SELECT id, name, price, rarity, item_type, category_id FROM shop_items WHERE guild_id = $1 AND is_active = true AND (is_tradable IS TRUE OR is_tradable IS NULL) AND (item_type != \'loot_box\' AND loot_box_id IS NULL) ORDER BY price ASC, name ASC LIMIT 100',
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
    'SELECT id, name, description FROM loot_boxes WHERE guild_id = $1 ORDER BY id ASC LIMIT 25',
    [guildId]
  );
  return res.rows;
}

/**
 * Fetch all configured battlepass levels for a guild
 */
export async function getConfiguredLevels(guildId) {
  const pool = getPool();
  const levelsRes = await pool.query(
    'SELECT level, reward_coins FROM battlepass_config WHERE guild_id = $1 ORDER BY level ASC',
    [guildId]
  );
  const rewardsRes = await pool.query(
    `SELECT br.id, br.level, br.reward_type, br.shop_item_id, br.loot_box_id, br.quantity,
            si.name as item_name, si.rarity as item_rarity,
            lb.name as chest_name
     FROM battlepass_rewards br
     LEFT JOIN shop_items si ON br.shop_item_id = si.id
     LEFT JOIN loot_boxes lb ON br.loot_box_id = lb.id
     WHERE br.guild_id = $1
     ORDER BY br.reward_type ASC, br.id ASC`,
    [guildId]
  );

  const rewardsByLevel = new Map();
  for (const r of rewardsRes.rows) {
    if (!rewardsByLevel.has(r.level)) rewardsByLevel.set(r.level, []);
    rewardsByLevel.get(r.level).push(r);
  }

  return levelsRes.rows.map(l => ({
    level: l.level,
    reward_coins: parseInt(l.reward_coins, 10) || 0,
    rewards: rewardsByLevel.get(l.level) || []
  }));
}

/**
 * Fetch a single configured level
 */
export async function getConfiguredLevel(guildId, level) {
  const pool = getPool();
  const levelRes = await pool.query(
    'SELECT level, reward_coins FROM battlepass_config WHERE guild_id = $1 AND level = $2',
    [guildId, level]
  );
  if (levelRes.rows.length === 0) return null;

  const rewardsRes = await pool.query(
    `SELECT br.id, br.level, br.reward_type, br.shop_item_id, br.loot_box_id, br.quantity,
            si.name as item_name, si.rarity as item_rarity, si.price as item_price,
            lb.name as chest_name
     FROM battlepass_rewards br
     LEFT JOIN shop_items si ON br.shop_item_id = si.id
     LEFT JOIN loot_boxes lb ON br.loot_box_id = lb.id
     WHERE br.guild_id = $1 AND br.level = $2
     ORDER BY br.reward_type ASC, br.id ASC`,
    [guildId, level]
  );

  return {
    level: levelRes.rows[0].level,
    reward_coins: parseInt(levelRes.rows[0].reward_coins, 10) || 0,
    rewards: rewardsRes.rows
  };
}

/**
 * Render the Battlepass Dashboard payload
 */
export async function getPassDashboardPayload(guildId, page = 0, selectedLevel = null, rewardFolder = 'root') {
  const levels = await getConfiguredLevels(guildId);
  const config = await getGuildConfig(guildId) || {};
  const isEnabled = config.battlepass_enabled === true;
  const coinEmoji = COIN_EMOJI.forGuild(guildId);
  const lootBoxCatName = await getLootBoxCategoryName(guildId);
  const lootBoxEmoji = await getLootBoxCategoryEmoji(guildId);
  const emojiMatch = lootBoxEmoji ? lootBoxEmoji.match(/:(\d+)>$/) : null;
  const selectChestEmoji = emojiMatch ? emojiMatch[1] : (lootBoxEmoji || '🎁');

  const totalLevels = levels.length;
  const totalPages = Math.max(1, Math.ceil(totalLevels / ITEMS_PER_PAGE));
  const currentPage = Math.min(Math.max(0, page), totalPages - 1);

  const startIdx = currentPage * ITEMS_PER_PAGE;
  const endIdx = startIdx + ITEMS_PER_PAGE;
  const pageLevels = levels.slice(startIdx, endIdx);

  const embed = new EmbedBuilder().setColor(0x5865F2);

  // Build Level Switcher Dropdown Options (No descriptions)
  const options = [];

  for (const l of pageLevels) {
    options.push({
      label: 'Level ' + l.level,
      value: 'pass_view_level_' + l.level + '_page_' + currentPage,
      emoji: '⭐',
      default: selectedLevel !== null && Number(selectedLevel) === Number(l.level)
    });
  }

  if (currentPage > 0) {
    options.push({
      label: 'Previous Page',
      value: 'pass_page_' + (currentPage - 1),
      emoji: '⬅️'
    });
  }

  if (currentPage < totalPages - 1) {
    options.push({
      label: 'Next Page',
      value: 'pass_page_' + (currentPage + 1),
      emoji: '➡️'
    });
  }

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

  // If a specific level is selected for management
  if (selectedLevel !== null) {
    const levelData = await getConfiguredLevel(guildId, selectedLevel);
    embed.setTitle('⭐ Level ' + selectedLevel);

    const coinsText = levelData && levelData.reward_coins > 0
      ? (coinEmoji + ' **' + Number(levelData.reward_coins).toLocaleString() + '**')
      : '_None_';

    const itemRewards = (levelData?.rewards || []).filter(r => r.reward_type === 'item' && r.item_name);
    const itemText = itemRewards.length > 0
      ? itemRewards.map(r => `🏷️ **${r.quantity > 1 ? `${r.quantity}x ` : ''}${r.item_name}**`).join(', ')
      : '_None_';

    const chestRewards = (levelData?.rewards || []).filter(r => r.reward_type === 'chest' && r.chest_name);
    const chestText = chestRewards.length > 0
      ? chestRewards.map(r => `${lootBoxEmoji} **${r.quantity > 1 ? `${r.quantity}x ` : ''}${r.chest_name}**`).join(', ')
      : '_None_';

    embed.setDescription(
      '• **Coins Reward:** ' + coinsText + '\n' +
      '• **Item Rewards:** ' + itemText + '\n' +
      '• **Chest Rewards:** ' + chestText
    );

    // Row 2: Coins Selector (No descriptions)
    const coinPresets = [
      { label: 'None (0 Coins)', value: '0', emoji: '❌' },
      { label: '50 Coins', value: '50' },
      { label: '100 Coins', value: '100' },
      { label: '250 Coins', value: '250' },
      { label: '500 Coins', value: '500' },
      { label: '1,000 Coins', value: '1000' },
      { label: '2,500 Coins', value: '2500' },
      { label: '5,000 Coins', value: '5000' },
      { label: '10,000 Coins', value: '10000' },
      { label: 'Custom Amount...', value: 'custom', emoji: '✏️' }
    ];

    const coinOptions = coinPresets.map(preset => ({
      label: preset.label,
      value: preset.value,
      emoji: preset.emoji || coinEmoji
    }));

    const coinsSelect = new StringSelectMenuBuilder()
      .setCustomId('pass_coins_select_lvl_' + selectedLevel + '_pg_' + currentPage)
      .setPlaceholder('Set Coins')
      .addOptions(coinOptions);

    const row2 = new ActionRowBuilder().addComponents(coinsSelect);

    // Row 3: Merged Rewards Browser Menu (Folder-Aware, No descriptions)
    const categories = await getShopCategories(guildId);
    const unlockedItems = await getUnlockedShopItems(guildId);
    const guildLootBoxes = await getGuildLootBoxes(guildId);

    const rewardOptions = [];
    let rewardsPlaceholder = 'Add Items or Chests...';

    if (rewardFolder === 'root') {
      const hasCategorized = unlockedItems.some(i => i.category_id);
      const hasUncategorized = unlockedItems.some(i => !i.category_id);
      const hasLootBoxes = guildLootBoxes.length > 0;

      if (hasCategorized) {
        rewardOptions.push({
          label: 'Categorized Items',
          value: 'folder_categorized',
          emoji: '📂'
        });
      }
      if (hasUncategorized) {
        rewardOptions.push({
          label: 'Uncategorized Items',
          value: 'folder_null',
          emoji: '📁'
        });
      }
      if (hasLootBoxes) {
        rewardOptions.push({
          label: lootBoxCatName.slice(0, 50),
          value: 'folder_chests',
          emoji: selectChestEmoji
        });
      }

      if (rewardOptions.length === 0) {
        rewardOptions.push({
          label: 'No Items or Chests Available',
          value: 'folder_root',
          emoji: '❌'
        });
      }
    } else if (rewardFolder === 'categorized') {
      rewardsPlaceholder = '📂 Browse Categories';
      rewardOptions.push({
        label: 'Back',
        value: 'folder_root',
        emoji: '⬅️'
      });

      for (const cat of categories) {
        const count = unlockedItems.filter(i => Number(i.category_id) === Number(cat.id)).length;
        if (count > 0) {
          rewardOptions.push({
            label: `📂 ${cat.name.slice(0, 50)}`,
            value: 'folder_' + cat.id,
            emoji: '📂'
          });
        }
      }
    } else if (rewardFolder === 'null') {
      rewardsPlaceholder = '📁 Uncategorized Items';
      rewardOptions.push({
        label: 'Back',
        value: 'folder_root',
        emoji: '⬅️'
      });

      const standaloneItems = unlockedItems.filter(i => !i.category_id);
      for (const item of standaloneItems) {
        rewardOptions.push({
          label: item.name.slice(0, 50),
          value: 'add_item_' + item.id,
          emoji: '🏷️'
        });
      }
    } else if (rewardFolder === 'chests') {
      rewardsPlaceholder = `${lootBoxEmoji} ${lootBoxCatName}`.slice(0, 50);
      rewardOptions.push({
        label: 'Back',
        value: 'folder_root',
        emoji: '⬅️'
      });

      for (const chest of guildLootBoxes) {
        rewardOptions.push({
          label: chest.name.slice(0, 50),
          value: 'add_chest_' + chest.id,
          emoji: selectChestEmoji
        });
      }
    } else {
      // Specific Category Folder
      const catId = parseInt(rewardFolder, 10);
      const currentCat = categories.find(c => Number(c.id) === catId);
      rewardsPlaceholder = `📂 ${currentCat?.name || 'Category'}`.slice(0, 50);

      rewardOptions.push({
        label: 'Back',
        value: 'folder_categorized',
        emoji: '⬅️'
      });

      const catItems = unlockedItems.filter(i => Number(i.category_id) === catId);
      for (const item of catItems) {
        rewardOptions.push({
          label: item.name.slice(0, 50),
          value: 'add_item_' + item.id,
          emoji: '🏷️'
        });
      }
    }

    const rewardsSelect = new StringSelectMenuBuilder()
      .setCustomId('pass_rewards_select_lvl_' + selectedLevel + '_pg_' + currentPage + '_fld_' + rewardFolder)
      .setPlaceholder(rewardsPlaceholder)
      .addOptions(rewardOptions.slice(0, 25));

    const row3 = new ActionRowBuilder().addComponents(rewardsSelect);

    const components = [row1, row2, row3];

    // Row 4 (Optional): Manage existing configured rewards on this level (No descriptions)
    if (levelData && levelData.rewards && levelData.rewards.length > 0) {
      const manageOptions = levelData.rewards.map(r => {
        const name = r.reward_type === 'chest' ? (r.chest_name || 'Chest') : (r.item_name || 'Item');
        const emoji = r.reward_type === 'chest' ? selectChestEmoji : '🏷️';
        return {
          label: `${name} (x${r.quantity})`.slice(0, 50),
          value: 'manage_' + r.id,
          emoji
        };
      });

      const manageSelect = new StringSelectMenuBuilder()
        .setCustomId('pass_manage_rewards_lvl_' + selectedLevel + '_pg_' + currentPage)
        .setPlaceholder(`Manage Assigned Rewards (${levelData.rewards.length})`)
        .addOptions(manageOptions.slice(0, 25));

      components.push(new ActionRowBuilder().addComponents(manageSelect));
    }

    // Action Buttons
    const actionRow = new ActionRowBuilder().addComponents(
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

    components.push(actionRow);

    return { embeds: [embed], components };
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
      '**Status:** ' + statusText + '\n' +
      scalingDesc + '\n\n' +
      '_No levels configured yet. Use the dropdown below to create Level 1._'
    );
  } else {
    const listLines = pageLevels.map(l => {
      const parts = [];
      if (l.reward_coins > 0) parts.push(coinEmoji + ' ' + l.reward_coins.toLocaleString());
      for (const r of l.rewards) {
        const q = r.quantity > 1 ? `${r.quantity}x ` : '';
        if (r.reward_type === 'item' && r.item_name) parts.push(`🏷️ ${q}${r.item_name}`);
        else if (r.reward_type === 'chest' && r.chest_name) parts.push(`${lootBoxEmoji} ${q}${r.chest_name}`);
      }
      const rewardStr = parts.length > 0 ? parts.join(' + ') : '_No reward_';
      return '• **Level ' + l.level + ':** ' + rewardStr;
    });

    embed.setDescription(
      '**Status:** ' + statusText + '\n' +
      scalingDesc + '\n\n' +
      '**Configured Levels (' + totalLevels + ' total):**\n' +
      listLines.join('\n')
    );
  }

  // Row 2: Management Controls ([Back], [XP], [Pause]/[Start])
  const backBtn = new ButtonBuilder()
    .setCustomId('settings_home')
    .setLabel('Back')
    .setEmoji('⬅️')
    .setStyle(ButtonStyle.Secondary);

  const xpBtn = new ButtonBuilder()
    .setCustomId('pass_set_xp_threshold_pg_' + currentPage)
    .setLabel('XP')
    .setEmoji('⚡')
    .setStyle(ButtonStyle.Primary);

  const startPauseBtn = isEnabled
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

  const row2 = new ActionRowBuilder().addComponents(backBtn, xpBtn, startPauseBtn);

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

    const payload = await getPassDashboardPayload(guildId, 0, null);
    await interaction.editReply({ content: '', ...payload });
  } catch (error) {
    await handleInteractionError(interaction, error, 'pass setup');
  }
}

/**
 * Handle Component Interactions for Levels (Buttons & Menus)
 */
export async function handlePassComponent(interaction) {
  const customId = interaction.customId;
  const guildId = interaction.guildId;

  try {
    // 1. Level Switcher Selection
    if (customId === 'pass_main_select') {
      const selectedValue = interaction.values[0];

      if (selectedValue.startsWith('pass_create_level_page_')) {
        const page = parseInt(selectedValue.replace('pass_create_level_page_', ''), 10) || 0;
        const levels = await getConfiguredLevels(guildId);
        const nextSuggestedLevel = levels.length > 0 ? Math.max(...levels.map(l => l.level)) + 1 : 1;

        const modal = new ModalBuilder()
          .setCustomId('pass_create_lvl_modal_pg_' + page)
          .setTitle('Create New Level');

        const levelInput = new TextInputBuilder()
          .setCustomId('pass_level_input')
          .setLabel('Level Number')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Enter level number (e.g. ' + nextSuggestedLevel + ')')
          .setValue(String(nextSuggestedLevel))
          .setMinLength(1)
          .setMaxLength(5)
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(levelInput));
        await interaction.showModal(modal);
        return;
      }

      if (selectedValue.startsWith('pass_page_')) {
        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
        const page = parseInt(selectedValue.replace('pass_page_', ''), 10) || 0;
        const payload = await getPassDashboardPayload(guildId, page, null);
        await interaction.editReply({ content: '', ...payload });
        return;
      }

      if (selectedValue.startsWith('pass_view_level_')) {
        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
        const match = selectedValue.match(/pass_view_level_(\d+)_page_(\d+)/);
        const level = match ? parseInt(match[1], 10) : 1;
        const page = match ? parseInt(match[2], 10) : 0;
        const payload = await getPassDashboardPayload(guildId, page, level);
        await interaction.editReply({ content: '', ...payload });
        return;
      }
    }

    // 2. Coins Selector
    if (customId.startsWith('pass_coins_select_lvl_')) {
      const match = customId.match(/pass_coins_select_lvl_(\d+)_pg_(\d+)/);
      const level = match ? parseInt(match[1], 10) : 1;
      const page = match ? parseInt(match[2], 10) : 0;
      const selectedValue = interaction.values[0];

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

      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});

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

    // 3. Merged Rewards Browser (Folder navigation or Item/Chest selection)
    if (customId.startsWith('pass_rewards_select_lvl_')) {
      const match = customId.match(/pass_rewards_select_lvl_(\d+)_pg_(\d+)_fld_(.+)/);
      const level = match ? parseInt(match[1], 10) : 1;
      const page = match ? parseInt(match[2], 10) : 0;
      const currentFolder = match ? match[3] : 'root';
      const selectedValue = interaction.values[0];

      // Folder navigation check
      if (selectedValue.startsWith('folder_')) {
        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
        const folderTarget = selectedValue.replace('folder_', '');
        const payload = await getPassDashboardPayload(guildId, page, level, folderTarget);
        await interaction.editReply({ content: '', ...payload });
        return;
      }

      // Add Item -> Open Quantity Modal
      if (selectedValue.startsWith('add_item_')) {
        const itemId = parseInt(selectedValue.replace('add_item_', ''), 10);
        const pool = getPool();
        const itemRes = await pool.query('SELECT name FROM shop_items WHERE id = $1', [itemId]);
        const itemName = itemRes.rows[0]?.name || 'Item';

        const existRes = await pool.query(
          'SELECT quantity FROM battlepass_rewards WHERE guild_id = $1 AND level = $2 AND reward_type = $3 AND shop_item_id = $4',
          [guildId, level, 'item', itemId]
        );
        const currentQty = existRes.rows[0]?.quantity || 1;

        const modal = new ModalBuilder()
          .setCustomId(`pass_reward_qty_${level}_item_${itemId}_pg_${page}_fld_${currentFolder}`)
          .setTitle(`Set Quantity: ${itemName}`.slice(0, 45));

        const qtyInput = new TextInputBuilder()
          .setCustomId('reward_quantity')
          .setLabel('Quantity (1-999, enter 0 to remove)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('1')
          .setValue(String(currentQty))
          .setMinLength(1)
          .setMaxLength(3)
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(qtyInput));
        await interaction.showModal(modal);
        return;
      }

      // Add Chest -> Open Quantity Modal
      if (selectedValue.startsWith('add_chest_')) {
        const chestId = parseInt(selectedValue.replace('add_chest_', ''), 10);
        const pool = getPool();
        const chestRes = await pool.query('SELECT name FROM loot_boxes WHERE id = $1', [chestId]);
        const chestName = chestRes.rows[0]?.name || 'Chest';

        const existRes = await pool.query(
          'SELECT quantity FROM battlepass_rewards WHERE guild_id = $1 AND level = $2 AND reward_type = $3 AND loot_box_id = $4',
          [guildId, level, 'chest', chestId]
        );
        const currentQty = existRes.rows[0]?.quantity || 1;

        const modal = new ModalBuilder()
          .setCustomId(`pass_reward_qty_${level}_chest_${chestId}_pg_${page}_fld_${currentFolder}`)
          .setTitle(`Set Quantity: ${chestName}`.slice(0, 45));

        const qtyInput = new TextInputBuilder()
          .setCustomId('reward_quantity')
          .setLabel('Quantity (1-999, enter 0 to remove)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('1')
          .setValue(String(currentQty))
          .setMinLength(1)
          .setMaxLength(3)
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(qtyInput));
        await interaction.showModal(modal);
        return;
      }
    }

    // 4. Manage Assigned Rewards Dropdown (Edit Quantity or Remove)
    if (customId.startsWith('pass_manage_rewards_lvl_')) {
      const match = customId.match(/pass_manage_rewards_lvl_(\d+)_pg_(\d+)/);
      const level = match ? parseInt(match[1], 10) : 1;
      const page = match ? parseInt(match[2], 10) : 0;
      const selectedValue = interaction.values[0];

      if (selectedValue.startsWith('manage_')) {
        const rewardId = parseInt(selectedValue.replace('manage_', ''), 10);
        const pool = getPool();
        const rewardRes = await pool.query(
          `SELECT br.*, si.name as item_name, lb.name as chest_name
           FROM battlepass_rewards br
           LEFT JOIN shop_items si ON br.shop_item_id = si.id
           LEFT JOIN loot_boxes lb ON br.loot_box_id = lb.id
           WHERE br.id = $1 AND br.guild_id = $2`,
          [rewardId, guildId]
        );

        if (rewardRes.rows.length === 0) {
          if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
          const payload = await getPassDashboardPayload(guildId, page, level);
          await interaction.editReply({ content: '', ...payload });
          return;
        }

        const r = rewardRes.rows[0];
        const name = r.reward_type === 'chest' ? (r.chest_name || 'Chest') : (r.item_name || 'Item');
        const targetId = r.reward_type === 'chest' ? r.loot_box_id : r.shop_item_id;

        const modal = new ModalBuilder()
          .setCustomId(`pass_reward_qty_${level}_${r.reward_type}_${targetId}_pg_${page}_fld_root`)
          .setTitle(`Set Quantity: ${name}`.slice(0, 45));

        const qtyInput = new TextInputBuilder()
          .setCustomId('reward_quantity')
          .setLabel('Quantity (1-999, enter 0 to remove)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('1')
          .setValue(String(r.quantity || 1))
          .setMinLength(1)
          .setMaxLength(3)
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(qtyInput));
        await interaction.showModal(modal);
        return;
      }
    }

    // 5. Start Levels -> Confirmation Dialogue
    if (customId.startsWith('pass_toggle_start_pg_')) {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
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

      await interaction.editReply({ embeds: [embed], components: [row1] });
      return;
    }

    // 6. Confirm Start
    if (customId.startsWith('pass_confirm_start_pg_')) {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
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
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
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
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
      const page = customId.startsWith('pass_home_page_') ? (parseInt(customId.replace('pass_home_page_', ''), 10) || 0) : 0;
      const payload = await getPassDashboardPayload(guildId, page, null);
      await interaction.editReply({ content: '', ...payload });
      return;
    }

    // 9. Delete Level Button
    if (customId.startsWith('pass_del_btn_')) {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
      const match = customId.match(/pass_del_btn_(\d+)_pg_(\d+)/);
      const level = match ? parseInt(match[1], 10) : 1;
      const page = match ? parseInt(match[2], 10) : 0;

      const pool = getPool();
      await pool.query('DELETE FROM battlepass_config WHERE guild_id = $1 AND level = $2', [guildId, level]);
      await pool.query('DELETE FROM battlepass_rewards WHERE guild_id = $1 AND level = $2', [guildId, level]);
      await pool.query('DELETE FROM user_pass_claims WHERE guild_id = $1 AND level_claimed = $2', [guildId, level]);

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
    // 1. Reward Quantity Modal (Add or Edit quantity of an item/chest)
    if (customId.startsWith('pass_reward_qty_')) {
      const match = customId.match(/pass_reward_qty_(\d+)_(item|chest)_(\d+)_pg_(\d+)_fld_(.+)/);
      if (!match) return;

      const level = parseInt(match[1], 10);
      const type = match[2];
      const targetId = parseInt(match[3], 10);
      const page = parseInt(match[4], 10) || 0;
      const folder = match[5];

      const qtyRaw = interaction.fields.getTextInputValue('reward_quantity').trim();
      const quantity = parseInt(qtyRaw, 10);

      if (isNaN(quantity) || quantity < 0) {
        return interaction.reply({ content: '❌ Quantity must be 0 or a positive whole number.', flags: MessageFlags.Ephemeral });
      }

      await interaction.deferUpdate().catch(() => {});

      const pool = getPool();
      await pool.query(
        'INSERT INTO battlepass_config (guild_id, level, reward_coins) VALUES ($1, $2, 0) ON CONFLICT (guild_id, level) DO NOTHING',
        [guildId, level]
      );

      if (quantity === 0) {
        if (type === 'item') {
          await pool.query(
            'DELETE FROM battlepass_rewards WHERE guild_id = $1 AND level = $2 AND reward_type = $3 AND shop_item_id = $4',
            [guildId, level, 'item', targetId]
          );
        } else {
          await pool.query(
            'DELETE FROM battlepass_rewards WHERE guild_id = $1 AND level = $2 AND reward_type = $3 AND loot_box_id = $4',
            [guildId, level, 'chest', targetId]
          );
        }
        sysLog('Level Reward Removed', { guild: guildId, user: interaction.user.id, detail: `Level ${level} | ${type} #${targetId} removed` });
      } else {
        if (type === 'item') {
          await pool.query(
            `INSERT INTO battlepass_rewards (guild_id, level, reward_type, shop_item_id, quantity)
             VALUES ($1, $2, 'item', $3, $4)
             ON CONFLICT (guild_id, level, reward_type, shop_item_id)
             DO UPDATE SET quantity = $4`,
            [guildId, level, targetId, quantity]
          );
        } else {
          await pool.query(
            `INSERT INTO battlepass_rewards (guild_id, level, reward_type, loot_box_id, quantity)
             VALUES ($1, $2, 'chest', $3, $4)
             ON CONFLICT (guild_id, level, reward_type, loot_box_id)
             DO UPDATE SET quantity = $4`,
            [guildId, level, targetId, quantity]
          );
        }
        sysLog('Level Reward Updated', { guild: guildId, user: interaction.user.id, detail: `Level ${level} | ${type} #${targetId} qty: ${quantity}` });
      }

      const payload = await getPassDashboardPayload(guildId, page, level, folder);
      await interaction.editReply({ content: '', ...payload });
      return;
    }

    // 2. Create New Level Modal (Level Number only)
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
        'INSERT INTO battlepass_config (guild_id, level, reward_coins) VALUES ($1, $2, 0) ON CONFLICT (guild_id, level) DO NOTHING',
        [guildId, level]
      );

      sysLog('Level Created', {
        guild: guildId,
        user: interaction.user.id,
        detail: 'Level ' + level + ' created'
      });

      sendLog(interaction.guild, 'audit', 'cyan', '⭐ Level Created', `Admin **<@${interaction.user.id}>** created **Level ${level}**.`);

      const payload = await getPassDashboardPayload(guildId, page, level);
      await interaction.editReply({ content: '', ...payload });
      return;
    }

    // 3. Set Coins Modal (Custom Amount)
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
        'INSERT INTO battlepass_config (guild_id, level, reward_coins) VALUES ($1, $2, $3) ON CONFLICT (guild_id, level) DO UPDATE SET reward_coins = $3',
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

    // 4. Set XP Threshold Modal (Base XP + Increment)
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
