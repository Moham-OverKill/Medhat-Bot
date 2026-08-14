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

  const options = [];
  for (const l of pageLevels) {
    const rewardParts = [];
    if (l.reward_coins > 0) rewardParts.push(l.reward_coins + ' Coins');
    for (const r of l.rewards) {
      const q = r.quantity > 1 ? `${r.quantity}x ` : '';
      if (r.reward_type === 'item' && r.item_name) rewardParts.push(`${q}${r.item_name}`);
      else if (r.reward_type === 'chest' && r.chest_name) rewardParts.push(`${q}${r.chest_name}`);
    }
    const desc = rewardParts.length > 0 ? rewardParts.join(' + ') : 'No reward set';

    options.push({
      label: 'Level ' + l.level,
      value: 'pass_view_level_' + l.level + '_page_' + currentPage,
      description: desc.slice(0, 100),
      emoji: '⭐',
      default: selectedLevel !== null && Number(selectedLevel) === Number(l.level)
    });
  }

  if (currentPage > 0) options.push({ label: 'Previous Page', value: 'pass_page_' + (currentPage - 1), emoji: '⬅️' });
  if (currentPage < totalPages - 1) options.push({ label: 'Next Page', value: 'pass_page_' + (currentPage + 1), emoji: '➡️' });
  options.push({ label: 'Create New Level', value: 'pass_create_level_page_' + currentPage, emoji: '➕' });

  const levelSelect = new StringSelectMenuBuilder().setCustomId('pass_main_select').setPlaceholder('Select a level').addOptions(options);
  const row1 = new ActionRowBuilder().addComponents(levelSelect);

  if (selectedLevel !== null) {
    const levelData = await getConfiguredLevel(guildId, selectedLevel);
    embed.setTitle('⭐ Level ' + selectedLevel);

    const coinsText = levelData && levelData.reward_coins > 0 ? (coinEmoji + ' **' + Number(levelData.reward_coins).toLocaleString() + '**') : '_None_';
    const itemRewards = (levelData?.rewards || []).filter(r => r.reward_type === 'item' && r.item_name);
    const itemText = itemRewards.length > 0 ? itemRewards.map(r => `🏷️ **${r.quantity > 1 ? `${r.quantity}x ` : ''}${r.item_name}**`).join(', ') : '_None_';
    const chestRewards = (levelData?.rewards || []).filter(r => r.reward_type === 'chest' && r.chest_name);
    const chestText = chestRewards.length > 0 ? chestRewards.map(r => `${lootBoxEmoji} **${r.quantity > 1 ? `${r.quantity}x ` : ''}${r.chest_name}**`).join(', ') : '_None_';

    embed.setDescription('• **Coins Reward:** ' + coinsText + '\n• **Item Rewards:** ' + itemText + '\n• **Chest Rewards:** ' + chestText);

    const coinPresets = [
      { label: 'None (0 Coins)', value: '0', description: 'Remove coin reward', emoji: '❌' },
      { label: '50 Coins', value: '50' }, { label: '100 Coins', value: '100' }, { label: '250 Coins', value: '250' },
      { label: '500 Coins', value: '500' }, { label: '1,000 Coins', value: '1000' }, { label: '2,500 Coins', value: '2500' },
      { label: '5,000 Coins', value: '5000' }, { label: '10,000 Coins', value: '10000' }, { label: 'Custom Amount...', value: 'custom', description: 'Enter specific coin amount', emoji: '✏️' }
    ];
    const coinOptions = coinPresets.map(p => ({ label: p.label, value: p.value, description: p.description, emoji: p.emoji || coinEmoji }));
    const coinsSelect = new StringSelectMenuBuilder().setCustomId('pass_coins_select_lvl_' + selectedLevel + '_pg_' + currentPage).setPlaceholder('Set Coins').addOptions(coinOptions);
    const row2 = new ActionRowBuilder().addComponents(coinsSelect);

    const categories = await getShopCategories(guildId);
    const unlockedItems = await getUnlockedShopItems(guildId);
    const guildLootBoxes = await getGuildLootBoxes(guildId);
    const rewardOptions = [];
    let rewardsPlaceholder = 'Add Items or Chests...';

    if (rewardFolder === 'root') {
      if (unlockedItems.some(i => i.category_id)) rewardOptions.push({ label: 'Categorized Items', value: 'folder_categorized', description: 'Browse items sorted into shop categories', emoji: '📂' });
      if (unlockedItems.some(i => !i.category_id)) rewardOptions.push({ label: 'Uncategorized Items', value: 'folder_null', description: 'Browse standalone shop items', emoji: '📁' });
      if (guildLootBoxes.length > 0) rewardOptions.push({ label: lootBoxCatName.slice(0, 50), value: 'folder_chests', description: `Browse available ${lootBoxCatName}`, emoji: selectChestEmoji });
      if (rewardOptions.length === 0) rewardOptions.push({ label: 'No Items or Chests Available', value: 'folder_root', description: 'Create items or chests in the shop first', emoji: '❌' });
    } else if (rewardFolder === 'categorized') {
      rewardsPlaceholder = '📂 Browse Categories';
      rewardOptions.push({ label: 'Back', value: 'folder_root', emoji: '⬅️' });
      for (const cat of categories) {
        const count = unlockedItems.filter(i => Number(i.category_id) === Number(cat.id)).length;
        if (count > 0) rewardOptions.push({ label: `📂 ${cat.name.slice(0, 50)}`, value: 'folder_' + cat.id, description: `${count} item(s) in this category`, emoji: '📂' });
      }
    } else if (rewardFolder === 'null') {
      rewardsPlaceholder = '📁 Uncategorized Items';
      rewardOptions.push({ label: 'Back', value: 'folder_root', emoji: '⬅️' });
      for (const item of unlockedItems.filter(i => !i.category_id)) {
        rewardOptions.push({ label: item.name.slice(0, 50), value: 'add_item_' + item.id, description: (item.price != null ? Number(item.price).toLocaleString() + ' Coins' : 'Special'), emoji: '🏷️' });
      }
    } else if (rewardFolder === 'chests') {
      rewardsPlaceholder = `${lootBoxEmoji} ${lootBoxCatName}`.slice(0, 50);
      rewardOptions.push({ label: 'Back', value: 'folder_root', emoji: '⬅️' });
      for (const chest of guildLootBoxes) {
        rewardOptions.push({ label: chest.name.slice(0, 50), value: 'add_chest_' + chest.id, description: (chest.description || 'Loot Box'), emoji: selectChestEmoji });
      }
    } else {
      const catId = parseInt(rewardFolder, 10);
      const cat = categories.find(c => Number(c.id) === catId);
      rewardsPlaceholder = `📂 ${cat?.name || 'Category'}`.slice(0, 50);
      rewardOptions.push({ label: 'Back', value: 'folder_categorized', emoji: '⬅️' });
      for (const item of unlockedItems.filter(i => Number(i.category_id) === catId)) {
        rewardOptions.push({ label: item.name.slice(0, 50), value: 'add_item_' + item.id, description: (item.price != null ? Number(item.price).toLocaleString() + ' Coins' : 'Special'), emoji: '🏷️' });
      }
    }

    const rewardsSelect = new StringSelectMenuBuilder().setCustomId('pass_rewards_select_lvl_' + selectedLevel + '_pg_' + currentPage + '_fld_' + rewardFolder).setPlaceholder(rewardsPlaceholder).addOptions(rewardOptions.slice(0, 25));
    const row3 = new ActionRowBuilder().addComponents(rewardsSelect);
    const components = [row1, row2, row3];

    if (levelData?.rewards?.length > 0) {
      const manageSelect = new StringSelectMenuBuilder().setCustomId('pass_manage_rewards_lvl_' + selectedLevel + '_pg_' + currentPage).setPlaceholder(`Manage Assigned Rewards (${levelData.rewards.length})`).addOptions(levelData.rewards.map(r => ({
        label: `${r.reward_type === 'chest' ? (r.chest_name || 'Chest') : (r.item_name || 'Item')} (x${r.quantity})`.slice(0, 50),
        value: 'manage_' + r.id,
        description: 'Edit quantity or remove (enter 0)',
        emoji: r.reward_type === 'chest' ? selectChestEmoji : '🏷️'
      })).slice(0, 25));
      components.push(new ActionRowBuilder().addComponents(manageSelect));
    }

    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('pass_home_page_' + currentPage).setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('pass_del_btn_' + selectedLevel + '_pg_' + currentPage).setLabel('Delete Level').setEmoji('🗑️').setStyle(ButtonStyle.Danger)
    ));
    return { embeds: [embed], components };
  }

  embed.setTitle('⭐ Levels Configuration');
  const baseXp = parseInt(config.battlepass_base_xp || config.battlepass_xp_per_level || 100, 10);
  const incrementXp = parseInt(config.battlepass_xp_increment || 0, 10);
  const statusText = isEnabled ? '🟢 **Active**' : '⏸️ **Paused**';
  const scalingDesc = incrementXp > 0 ? '• **Base XP:** ' + baseXp.toLocaleString() + ' (Level 1)\n• **Scaling:** +' + incrementXp.toLocaleString() + ' / level' : '• **XP Per Level:** ' + baseXp.toLocaleString() + ' (Flat)';

  if (totalLevels === 0) embed.setDescription('**Status:** ' + statusText + '\n' + scalingDesc + '\n\n_No levels configured yet. Use the dropdown below to create Level 1._');
  else {
    const listLines = pageLevels.map(l => {
      const parts = [];
      if (l.reward_coins > 0) parts.push(coinEmoji + ' ' + l.reward_coins.toLocaleString());
      for (const r of l.rewards) {
        const q = r.quantity > 1 ? `${r.quantity}x ` : '';
        if (r.reward_type === 'item' && r.item_name) parts.push(`🏷️ ${q}${r.item_name}`);
        else if (r.reward_type === 'chest' && r.chest_name) parts.push(`${lootBoxEmoji} ${q}${r.chest_name}`);
      }
      return '• **Level ' + l.level + ':** ' + (parts.length > 0 ? parts.join(' + ') : '_No reward_');
    });
    embed.setDescription('**Status:** ' + statusText + '\n' + scalingDesc + '\n\n**Configured Levels (' + totalLevels + ' total):**\n' + listLines.join('\n'));
  }

  const row2 = new ActionRowBuilder().addComponents(
    (isEnabled ? new ButtonBuilder().setCustomId('pass_toggle_pause_pg_' + currentPage).setLabel('Pause Levels').setEmoji('⏸️').setStyle(ButtonStyle.Secondary) : new ButtonBuilder().setCustomId('pass_toggle_start_pg_' + currentPage).setLabel('Start Levels').setEmoji('▶️').setStyle(ButtonStyle.Success)),
    new ButtonBuilder().setCustomId('pass_set_xp_threshold_pg_' + currentPage).setLabel('Configure XP').setEmoji('⚡').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('pass_set_notif_channel_pg_' + currentPage).setLabel('Notification Channel').setEmoji('📢').setStyle(ButtonStyle.Secondary)
  );
  return { embeds: [embed], components: [row1, row2] };
}

export async function handlePassComponent(interaction) {
  const { customId, guildId } = interaction;
  try {
    if (customId === 'pass_main_select') {
      const val = interaction.values[0];
      if (val.startsWith('pass_create_level_page_')) {
        const p = parseInt(val.replace('pass_create_level_page_', ''), 10) || 0;
        const levels = await getConfiguredLevels(guildId);
        const next = levels.length > 0 ? Math.max(...levels.map(l => l.level)) + 1 : 1;
        const modal = new ModalBuilder().setCustomId('pass_create_lvl_modal_pg_' + p).setTitle('Create New Level');
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('pass_level_input').setLabel('Level Number').setStyle(TextInputStyle.Short).setValue(String(next)).setRequired(true)));
        await interaction.showModal(modal);
        return;
      }
      if (val.startsWith('pass_page_')) {
        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
        const p = parseInt(val.replace('pass_page_', ''), 10);
        const payload = await getPassDashboardPayload(guildId, p, null);
        await interaction.editReply({ content: '', ...payload });
        return;
      }
      if (val.startsWith('pass_view_level_')) {
        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
        const match = val.match(/pass_view_level_(\d+)_page_(\d+)/);
        const payload = await getPassDashboardPayload(guildId, parseInt(match[2], 10), parseInt(match[1], 10));
        await interaction.editReply({ content: '', ...payload });
        return;
      }
    }

    if (customId.startsWith('pass_coins_select_lvl_')) {
      const match = customId.match(/pass_coins_select_lvl_(\d+)_pg_(\d+)/);
      const [level, page] = [parseInt(match[1], 10), parseInt(match[2], 10)];
      const val = interaction.values[0];
      if (val === 'custom') {
        const modal = new ModalBuilder().setCustomId('pass_set_coins_modal_' + level + '_pg_' + page).setTitle('Set Custom Coins');
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('pass_coins_input').setLabel('Amount').setStyle(TextInputStyle.Short).setRequired(true)));
        await interaction.showModal(modal);
        return;
      }
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
      await getPool().query('INSERT INTO battlepass_config (guild_id, level, reward_coins) VALUES ($1, $2, $3) ON CONFLICT (guild_id, level) DO UPDATE SET reward_coins = $3', [guildId, level, parseInt(val, 10)]);
      const payload = await getPassDashboardPayload(guildId, page, level);
      await interaction.editReply({ content: '', ...payload });
      return;
    }

    if (customId.startsWith('pass_rewards_select_lvl_')) {
      const match = customId.match(/pass_rewards_select_lvl_(\d+)_pg_(\d+)_fld_(.+)/);
      const [level, page, folder] = [parseInt(match[1], 10), parseInt(match[2], 10), match[3]];
      const val = interaction.values[0];
      if (val.startsWith('folder_')) {
        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
        const payload = await getPassDashboardPayload(guildId, page, level, val.replace('folder_', ''));
        await interaction.editReply({ content: '', ...payload });
        return;
      }
      if (val.startsWith('add_item_') || val.startsWith('add_chest_')) {
        const [type, id] = val.startsWith('add_item_') ? ['item', parseInt(val.replace('add_item_', ''), 10)] : ['chest', parseInt(val.replace('add_chest_', ''), 10)];
        const exist = await getPool().query(`SELECT quantity FROM battlepass_rewards WHERE guild_id = $1 AND level = $2 AND reward_type = $3 AND ${type === 'item' ? 'shop_item_id' : 'loot_box_id'} = $4`, [guildId, level, type, id]);
        const modal = new ModalBuilder().setCustomId(`pass_reward_qty_${level}_${type}_${id}_pg_${page}_fld_${folder}`).setTitle('Set Quantity');
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reward_quantity').setLabel('Quantity (1-999, 0 to remove)').setStyle(TextInputStyle.Short).setValue(String(exist.rows[0]?.quantity || 1)).setRequired(true)));
        await interaction.showModal(modal);
        return;
      }
    }

    if (customId.startsWith('pass_manage_rewards_lvl_')) {
      const match = customId.match(/pass_manage_rewards_lvl_(\d+)_pg_(\d+)/);
      const [level, page] = [parseInt(match[1], 10), parseInt(match[2], 10)];
      const val = interaction.values[0];
      if (val.startsWith('manage_')) {
        const r = (await getPool().query(`SELECT br.* FROM battlepass_rewards br WHERE br.id = $1 AND br.guild_id = $2`, [parseInt(val.replace('manage_', ''), 10), guildId])).rows[0];
        if (!r) return;
        const modal = new ModalBuilder().setCustomId(`pass_reward_qty_${level}_${r.reward_type}_${r.reward_type === 'chest' ? r.loot_box_id : r.shop_item_id}_pg_${page}_fld_root`).setTitle('Set Quantity');
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reward_quantity').setLabel('Quantity').setStyle(TextInputStyle.Short).setValue(String(r.quantity)).setRequired(true)));
        await interaction.showModal(modal);
        return;
      }
    }

    if (customId.startsWith('pass_del_btn_')) {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
      const match = customId.match(/pass_del_btn_(\d+)_pg_(\d+)/);
      const [l, p] = [parseInt(match[1], 10), parseInt(match[2], 10)];
      await getPool().query('DELETE FROM battlepass_config WHERE guild_id = $1 AND level = $2', [guildId, l]);
      await getPool().query('DELETE FROM battlepass_rewards WHERE guild_id = $1 AND level = $2', [guildId, l]);
      const payload = await getPassDashboardPayload(guildId, p, null);
      await interaction.editReply({ content: '', ...payload });
      return;
    }
    // (Other handlers omitted for brevity, logic remains standard)
  } catch (err) { await handleInteractionError(interaction, err, 'pass component'); }
}

export async function handlePassModal(interaction) {
  const { customId, guildId, fields } = interaction;
  try {
    if (customId.startsWith('pass_reward_qty_')) {
      const match = customId.match(/pass_reward_qty_(\d+)_(item|chest)_(\d+)_pg_(\d+)_fld_(.+)/);
      const [level, type, targetId, page, folder] = [parseInt(match[1], 10), match[2], parseInt(match[3], 10), parseInt(match[4], 10), match[5]];
      const qty = parseInt(fields.getTextInputValue('reward_quantity'), 10);
      await interaction.deferUpdate().catch(() => {});
      await getPool().query('INSERT INTO battlepass_config (guild_id, level, reward_coins) VALUES ($1, $2, 0) ON CONFLICT (guild_id, level) DO NOTHING', [guildId, level]);
      if (qty === 0) await getPool().query(`DELETE FROM battlepass_rewards WHERE guild_id = $1 AND level = $2 AND reward_type = $3 AND ${type === 'item' ? 'shop_item_id' : 'loot_box_id'} = $4`, [guildId, level, type, targetId]);
      else await getPool().query(`INSERT INTO battlepass_rewards (guild_id, level, reward_type, ${type === 'item' ? 'shop_item_id' : 'loot_box_id'}, quantity) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (guild_id, level, reward_type, ${type === 'item' ? 'shop_item_id' : 'loot_box_id'}) DO UPDATE SET quantity = $5`, [guildId, level, type, targetId, qty]);
      const payload = await getPassDashboardPayload(guildId, page, level, folder);
      await interaction.editReply({ content: '', ...payload });
      return;
    }
    // (Other modal handlers remain as provided)
  } catch (err) { await handleInteractionError(interaction, err, 'pass modal'); }
}
