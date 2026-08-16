import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  RoleSelectMenuBuilder,
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
import { COIN_EMOJI, parseSelectEmoji } from '../../shared.js';
import { handleInteractionError } from '../../utils/errors.js';
import { validateRoleForAssignment } from './pass-engine.js';

const ITEMS_PER_PAGE = 5;

// In-memory state store for multi-step import flow (keyed by `${guildId}:${userId}`)
const importFlowState = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

export async function getUnlockedItemCount(guildId) {
  const pool = getPool();
  const res = await pool.query(
    'SELECT COUNT(*) as count FROM shop_items WHERE guild_id = $1 AND is_active = true AND (is_tradable IS TRUE OR is_tradable IS NULL)',
    [guildId]
  );
  return parseInt(res.rows[0]?.count || 0, 10);
}

async function getUnlockedShopItems(guildId) {
  const pool = getPool();
  const res = await pool.query(
    "SELECT id, name, price, rarity, item_type, category_id FROM shop_items WHERE guild_id = $1 AND is_active = true AND (is_tradable IS TRUE OR is_tradable IS NULL) AND (item_type != 'loot_box' AND loot_box_id IS NULL) ORDER BY price ASC, name ASC LIMIT 100",
    [guildId]
  );
  return res.rows;
}

async function getGuildLootBoxes(guildId) {
  const pool = getPool();
  const res = await pool.query(
    'SELECT id, name, description FROM loot_boxes WHERE guild_id = $1 ORDER BY id ASC LIMIT 25',
    [guildId]
  );
  return res.rows;
}

export async function getConfiguredLevels(guildId) {
  const pool = getPool();
  const levelsRes = await pool.query(
    'SELECT level, reward_coins, reward_role_id FROM battlepass_config WHERE guild_id = $1 ORDER BY level ASC',
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
    reward_role_id: l.reward_role_id || null,
    rewards: rewardsByLevel.get(l.level) || []
  }));
}

export async function getConfiguredLevel(guildId, level) {
  const pool = getPool();
  const levelRes = await pool.query(
    'SELECT level, reward_coins, reward_role_id FROM battlepass_config WHERE guild_id = $1 AND level = $2',
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
    reward_role_id: levelRes.rows[0].reward_role_id || null,
    rewards: rewardsRes.rows
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD PAYLOAD
// ─────────────────────────────────────────────────────────────────────────────

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

  // Build Level Switcher options
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
    options.push({ label: 'Previous Page', value: 'pass_page_' + (currentPage - 1), emoji: '⬅️' });
  }
  if (currentPage < totalPages - 1) {
    options.push({ label: 'Next Page', value: 'pass_page_' + (currentPage + 1), emoji: '➡️' });
  }
  options.push({ label: 'Create New Level', value: 'pass_create_level_page_' + currentPage, emoji: '➕' });

  const levelSelect = new StringSelectMenuBuilder()
    .setCustomId('pass_main_select')
    .setPlaceholder(isEnabled ? 'Pause to make changes' : 'Select a level')
    .setDisabled(isEnabled)
    .addOptions(options);

  const row1 = new ActionRowBuilder().addComponents(levelSelect);

  // ── SELECTED LEVEL EDITOR ──────────────────────────────────────────────
  if (selectedLevel !== null && !isEnabled) {
    const levelData = await getConfiguredLevel(guildId, selectedLevel);
    embed.setTitle('⭐ Level ' + selectedLevel);

    const coinsText = levelData && levelData.reward_coins > 0
      ? (coinEmoji + ' **' + Number(levelData.reward_coins).toLocaleString() + '**')
      : '_None_';

    const roleText = levelData?.reward_role_id
      ? `<@&${levelData.reward_role_id}>`
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
      '• **Role Reward:** ' + roleText + '\n' +
      '• **Coins Reward:** ' + coinsText + '\n' +
      '• **Item Rewards:** ' + itemText + '\n' +
      '• **Chest Rewards:** ' + chestText
    );

    // Row 2: Role Select (RoleSelectMenuBuilder)
    const roleSelect = new RoleSelectMenuBuilder()
      .setCustomId('pass_role_select_lvl_' + selectedLevel + '_pg_' + currentPage)
      .setPlaceholder('Set Role Reward')
      .setMinValues(0)
      .setMaxValues(1);

    const row2 = new ActionRowBuilder().addComponents(roleSelect);

    // Row 3: Coins Selector
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

    const row3 = new ActionRowBuilder().addComponents(coinsSelect);

    // Row 4: Merged Rewards Browser Menu
    const categories = await getShopCategories(guildId);
    const unlockedItems = await getUnlockedShopItems(guildId);
    const guildLootBoxes = await getGuildLootBoxes(guildId);

    const rewardOptions = [];
    const rewardsPlaceholder = `Set Items/${lootBoxCatName}`;

    if (rewardFolder === 'root') {
      const hasCategorized = unlockedItems.some(i => i.category_id);
      const hasUncategorized = unlockedItems.some(i => !i.category_id);
      const hasLootBoxes = guildLootBoxes.length > 0;

      if (hasCategorized) {
        rewardOptions.push({ label: 'Categorized Items', value: 'folder_categorized', emoji: '📂' });
      }
      if (hasUncategorized) {
        rewardOptions.push({ label: 'Uncategorized Items', value: 'folder_null', emoji: '🏷️' });
      }
      if (hasLootBoxes) {
        rewardOptions.push({ label: lootBoxCatName.slice(0, 50), value: 'folder_chests', emoji: parseSelectEmoji(selectChestEmoji) });
      }
      if (rewardOptions.length === 0) {
        rewardOptions.push({ label: 'No Items or Chests Available', value: 'folder_root', emoji: '❌' });
      }
    } else if (rewardFolder === 'categorized') {
      rewardOptions.push({ label: 'Back', value: 'folder_root', emoji: '⬅️' });
      for (const cat of categories.slice(0, 24)) {
        const count = unlockedItems.filter(i => Number(i.category_id) === Number(cat.id)).length;
        if (count > 0) {
          rewardOptions.push({ label: cat.name.slice(0, 50), value: 'folder_' + cat.id, emoji: '📂' });
        }
      }
    } else if (rewardFolder === 'null') {
      rewardOptions.push({ label: 'Back', value: 'folder_root', emoji: '⬅️' });
      for (const item of unlockedItems.filter(i => !i.category_id).slice(0, 24)) {
        rewardOptions.push({ label: item.name.slice(0, 50), value: 'add_item_' + item.id, emoji: '🏷️' });
      }
    } else if (rewardFolder === 'chests') {
      rewardOptions.push({ label: 'Back', value: 'folder_root', emoji: '⬅️' });
      for (const chest of guildLootBoxes.slice(0, 24)) {
        rewardOptions.push({ label: chest.name.slice(0, 50), value: 'add_chest_' + chest.id, emoji: parseSelectEmoji(selectChestEmoji) });
      }
    } else {
      const catId = parseInt(rewardFolder, 10);
      rewardOptions.push({ label: 'Back', value: 'folder_categorized', emoji: '⬅️' });
      for (const item of unlockedItems.filter(i => Number(i.category_id) === catId).slice(0, 24)) {
        rewardOptions.push({ label: item.name.slice(0, 50), value: 'add_item_' + item.id, emoji: '🏷️' });
      }
    }

    const rewardsSelect = new StringSelectMenuBuilder()
      .setCustomId('pass_rewards_select_lvl_' + selectedLevel + '_pg_' + currentPage + '_fld_' + rewardFolder)
      .setPlaceholder(rewardsPlaceholder)
      .addOptions(rewardOptions.slice(0, 25));

    const row4 = new ActionRowBuilder().addComponents(rewardsSelect);

    // Row 5: Action Buttons
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

    return { embeds: [embed], components: [row1, row2, row3, row4, actionRow] };
  }

  // ── ROOT DASHBOARD ─────────────────────────────────────────────────────
  embed.setTitle('⭐ Levels Configuration');

  if (totalLevels === 0) {
    embed.setDescription('No levels configured yet.');
  } else {
    const listLines = pageLevels.map(l => {
      const parts = [];
      if (l.reward_role_id) parts.push(`<@&${l.reward_role_id}>`);
      if (l.reward_coins > 0) parts.push(coinEmoji + ' ' + l.reward_coins.toLocaleString());
      for (const r of l.rewards) {
        const q = r.quantity > 1 ? `${r.quantity}x ` : '';
        if (r.reward_type === 'item' && r.item_name) parts.push(`🏷️ ${q}${r.item_name}`);
        else if (r.reward_type === 'chest' && r.chest_name) parts.push(`${lootBoxEmoji} ${q}${r.chest_name}`);
      }
      const rewardStr = parts.length > 0 ? parts.join(' + ') : '_No reward_';
      return '• **Level ' + l.level + ':** ' + rewardStr;
    });
    embed.setDescription(listLines.join('\n'));
  }

  // Row 1: Level Switcher (already row1 above)
  // Row 2: [ ⚡ XP ] | [ 🚀 Boosts ] | [ ▶️ Start / ⏸️ Pause ]
  const xpBtn = new ButtonBuilder()
    .setCustomId('pass_set_xp_threshold_pg_' + currentPage)
    .setLabel('XP')
    .setEmoji('⚡')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(isEnabled);

  const boostsBtn = new ButtonBuilder()
    .setCustomId('pass_boosts_pg_' + currentPage)
    .setLabel('Boosts')
    .setEmoji('🚀')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(isEnabled);

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

  const row2 = new ActionRowBuilder().addComponents(xpBtn, boostsBtn, startPauseBtn);

  // Row 3: [ ⬅️ Back ] | [ 📥 Import Levels ]
  const backBtn = new ButtonBuilder()
    .setCustomId('settings_home')
    .setLabel('Back')
    .setEmoji('⬅️')
    .setStyle(ButtonStyle.Secondary);

  const importBtn = new ButtonBuilder()
    .setCustomId('pass_import_start_pg_' + currentPage)
    .setLabel('Import Levels')
    .setEmoji('📥')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(isEnabled);

  const row3 = new ActionRowBuilder().addComponents(backBtn, importBtn);

  return { embeds: [embed], components: [row1, row2, row3] };
}

// ─────────────────────────────────────────────────────────────────────────────
// BOOSTS DASHBOARD
// ─────────────────────────────────────────────────────────────────────────────

async function getBoostsDashboardPayload(guildId, page = 0) {
  const pool = getPool();
  const boostersRes = await pool.query(
    'SELECT role_id, boost_percentage FROM role_xp_boosters WHERE guild_id = $1 ORDER BY boost_percentage DESC',
    [guildId]
  );
  const boosters = boostersRes.rows;

  const embed = new EmbedBuilder()
    .setColor(0xFEE75C)
    .setTitle('🚀 XP Boosts');

  if (boosters.length === 0) {
    embed.setDescription('No XP boosts configured.\n\nAdd a role boost below. Members with boosted roles earn bonus XP on all activity.');
  } else {
    const lines = boosters.map(b => `• <@&${b.role_id}> → **+${b.boost_percentage}%** XP`);
    embed.setDescription(lines.join('\n'));
  }

  // Row 1: Add boost role select
  const addRoleSelect = new RoleSelectMenuBuilder()
    .setCustomId('pass_boost_add_role_pg_' + page)
    .setPlaceholder('Add Role Boost...')
    .setMinValues(1)
    .setMaxValues(1);

  const row1 = new ActionRowBuilder().addComponents(addRoleSelect);

  const components = [row1];

  // Row 2: Remove boost select (only if there are boosters)
  if (boosters.length > 0) {
    const removeOptions = boosters.slice(0, 25).map(b => ({
      label: `@Role (${b.boost_percentage}%)`,
      description: `Remove +${b.boost_percentage}% XP boost`,
      value: 'remove_boost_' + b.role_id,
      emoji: '❌'
    }));

    // Use a regular select menu for removal since we need value-based removal
    const removeSelect = new StringSelectMenuBuilder()
      .setCustomId('pass_boost_remove_pg_' + page)
      .setPlaceholder('Remove a Role Boost...')
      .addOptions(removeOptions);

    components.push(new ActionRowBuilder().addComponents(removeSelect));
  }

  // Back button row
  const backRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('pass_home_page_' + page)
      .setLabel('Back')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary)
  );
  components.push(backRow);

  return { embeds: [embed], components };
}

// ─────────────────────────────────────────────────────────────────────────────
// ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT HANDLER
// ─────────────────────────────────────────────────────────────────────────────

export async function handlePassComponent(interaction) {
  const customId = interaction.customId;
  const guildId = interaction.guildId;

  try {
    const config = await getGuildConfig(guildId) || {};
    const isEnabled = config.battlepass_enabled === true;

    // ── 1. Pause ──────────────────────────────────────────────────────────
    if (customId.startsWith('pass_toggle_pause_pg_')) {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
      const page = parseInt(customId.replace('pass_toggle_pause_pg_', ''), 10) || 0;
      await setGuildConfig(guildId, { battlepass_enabled: false });
      sysLog('Levels Paused', { guild: guildId, user: interaction.user.id });
      sendLog(interaction.guild, 'audit', 'orange', '⏸️ Levels Paused', `Admin **<@${interaction.user.id}>** paused Level progression.`);
      const payload = await getPassDashboardPayload(guildId, page, null);
      await interaction.editReply({ content: '', ...payload });
      return;
    }

    // ── 2. Start → Confirmation Dialogue ─────────────────────────────────
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

    // ── 3. Confirm Start ──────────────────────────────────────────────────
    if (customId.startsWith('pass_confirm_start_pg_')) {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
      const page = parseInt(customId.replace('pass_confirm_start_pg_', ''), 10) || 0;
      await setGuildConfig(guildId, { battlepass_enabled: true });
      sysLog('Levels Started', { guild: guildId, user: interaction.user.id });
      sendLog(interaction.guild, 'audit', 'green', '⭐ Levels Started', `Admin **<@${interaction.user.id}>** started Level progression.`);

      // Background reward distribution for all members with imported/existing XP
      import('./pass-engine.js').then(async ({ syncUserLevelRewards }) => {
        const pool = getPool();
        const activeUsers = await pool.query(
          'SELECT user_id, username FROM user_activity WHERE guild_id = $1 AND battlepass_xp > 0',
          [guildId]
        );
        for (const u of activeUsers.rows) {
          await syncUserLevelRewards(guildId, u.user_id, u.username, null).catch(() => {});
        }
      }).catch(() => {});

      const payload = await getPassDashboardPayload(guildId, page, null);
      await interaction.editReply({ content: '', ...payload });
      return;
    }

    // ── 4. Back to Levels List ────────────────────────────────────────────
    if (customId.startsWith('pass_home_page_') || customId === 'pass_home') {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
      const page = customId.startsWith('pass_home_page_') ? (parseInt(customId.replace('pass_home_page_', ''), 10) || 0) : 0;
      const payload = await getPassDashboardPayload(guildId, page, null);
      await interaction.editReply({ content: '', ...payload });
      return;
    }

    // ── 5. XP Threshold Modal ─────────────────────────────────────────────
    if (customId.startsWith('pass_set_xp_threshold_pg_')) {
      if (isEnabled) {
        const msg = { content: '⚠️ You must pause levels before changing XP settings.', flags: MessageFlags.Ephemeral };
        if (interaction.deferred || interaction.replied) return interaction.followUp(msg);
        return interaction.reply(msg);
      }
      const page = parseInt(customId.replace('pass_set_xp_threshold_pg_', ''), 10) || 0;
      const freshConfig = await getGuildConfig(guildId) || {};
      const baseXp = parseInt(freshConfig.battlepass_base_xp ?? freshConfig.battlepass_xp_per_level ?? 100, 10);
      const incrementXp = parseInt(freshConfig.battlepass_xp_increment ?? 50, 10);
      const msgXp = parseInt(freshConfig.battlepass_msg_xp ?? 1, 10);
      const voiceXp = parseInt(freshConfig.battlepass_voice_xp ?? 1, 10);
      const questXp = parseInt(freshConfig.battlepass_quest_xp ?? 150, 10);

      const modal = new ModalBuilder()
        .setCustomId('pass_xp_threshold_modal_pg_' + page)
        .setTitle('Configure XP');

      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('pass_base_xp_input')
            .setLabel('Base XP (Level 1)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('100')
            .setValue(String(baseXp))
            .setMaxLength(6)
            .setRequired(false)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('pass_increment_xp_input')
            .setLabel('XP Increment per Level (0 = flat)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('50')
            .setValue(String(incrementXp))
            .setMaxLength(6)
            .setRequired(false)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('pass_msg_xp_input')
            .setLabel('Message XP (per valid message)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('1')
            .setValue(String(msgXp))
            .setMaxLength(4)
            .setRequired(false)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('pass_voice_xp_input')
            .setLabel('Voice XP (per voice minute)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('1')
            .setValue(String(voiceXp))
            .setMaxLength(4)
            .setRequired(false)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('pass_quest_xp_input')
            .setLabel('Quest Completion XP')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('150')
            .setValue(String(questXp))
            .setMaxLength(6)
            .setRequired(false)
        )
      );

      await interaction.showModal(modal);
      return;
    }

    // ── 6. Boosts Dashboard ───────────────────────────────────────────────
    if (customId.startsWith('pass_boosts_pg_')) {
      if (isEnabled) {
        const msg = { content: '⚠️ You must pause levels before changing Boosts.', flags: MessageFlags.Ephemeral };
        if (interaction.deferred || interaction.replied) return interaction.followUp(msg);
        return interaction.reply(msg);
      }
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
      const page = parseInt(customId.replace('pass_boosts_pg_', ''), 10) || 0;
      const payload = await getBoostsDashboardPayload(guildId, page);
      await interaction.editReply({ content: '', ...payload });
      return;
    }

    // ── 7. Add Boost — Role Selected ──────────────────────────────────────
    if (customId.startsWith('pass_boost_add_role_pg_')) {
      const page = parseInt(customId.replace('pass_boost_add_role_pg_', ''), 10) || 0;
      const roleId = interaction.values[0];
      const role = interaction.guild.roles.cache.get(roleId);

      // Security: no dangerous perms, but hierarchy check is optional for boosts
      // (We are not awarding the role, just reading membership)
      if (!role) {
        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
        return interaction.followUp({ content: '⚠️ Role not found.', flags: MessageFlags.Ephemeral });
      }

      const pool = getPool();
      const existingBoost = await pool.query('SELECT boost_percentage FROM role_xp_boosters WHERE guild_id = $1 AND role_id = $2', [guildId, roleId]);
      const currentBoost = existingBoost.rows[0]?.boost_percentage;

      const boostInput = new TextInputBuilder()
        .setCustomId('boost_pct_input')
        .setLabel('XP Boost %')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('35')
        .setMaxLength(4)
        .setRequired(true);

      if (currentBoost) {
        boostInput.setValue(String(currentBoost));
      }

      const modal = new ModalBuilder()
        .setCustomId('pass_boost_pct_modal_' + roleId + '_pg_' + page)
        .setTitle('Set Boost Percentage')
        .addComponents(new ActionRowBuilder().addComponents(boostInput));

      await interaction.showModal(modal);
      return;
    }

    // ── 8. Remove Boost ───────────────────────────────────────────────────
    if (customId.startsWith('pass_boost_remove_pg_')) {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
      const page = parseInt(customId.replace('pass_boost_remove_pg_', ''), 10) || 0;
      const selectedValue = interaction.values[0];

      if (selectedValue.startsWith('remove_boost_')) {
        const roleId = selectedValue.replace('remove_boost_', '');
        const pool = getPool();
        await pool.query('DELETE FROM role_xp_boosters WHERE guild_id = $1 AND role_id = $2', [guildId, roleId]);
        sysLog('XP Boost Removed', { guild: guildId, user: interaction.user.id, detail: `Role ${roleId}` });
        sendLog(interaction.guild, 'audit', 'orange', '🚀 XP Boost Removed', `Admin **<@${interaction.user.id}>** removed XP boost for <@&${roleId}>.`);
      }

      const payload = await getBoostsDashboardPayload(guildId, page);
      await interaction.editReply({ content: '', ...payload });
      return;
    }

    // ─── Guard: all modifications below require Levels to be paused ───────
    if (isEnabled) {
      const msg = { content: '⚠️ You must pause levels before making changes.', flags: MessageFlags.Ephemeral };
      if (interaction.deferred || interaction.replied) return interaction.followUp(msg);
      return interaction.reply(msg);
    }

    // ── 9. Level Switcher Selection ───────────────────────────────────────
    if (customId === 'pass_main_select') {
      const selectedValue = interaction.values[0];

      if (selectedValue.startsWith('pass_create_level_page_')) {
        const page = parseInt(selectedValue.replace('pass_create_level_page_', ''), 10) || 0;
        const levels = await getConfiguredLevels(guildId);
        const nextSuggestedLevel = levels.length > 0 ? Math.max(...levels.map(l => l.level)) + 1 : 1;

        const modal = new ModalBuilder()
          .setCustomId('pass_create_lvl_modal_pg_' + page)
          .setTitle('Create New Level');

        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('pass_level_input')
              .setLabel('Level Number')
              .setStyle(TextInputStyle.Short)
              .setPlaceholder('Enter level number (e.g. ' + nextSuggestedLevel + ')')
              .setValue(String(nextSuggestedLevel))
              .setMinLength(1).setMaxLength(5)
              .setRequired(true)
          )
        );

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

    // ── 10. Role Reward Select (per level editor) ─────────────────────────
    if (customId.startsWith('pass_role_select_lvl_')) {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
      const match = customId.match(/pass_role_select_lvl_(\d+)_pg_(\d+)/);
      const level = match ? parseInt(match[1], 10) : 1;
      const page = match ? parseInt(match[2], 10) : 0;
      const pool = getPool();

      const selectedRoleId = interaction.values[0] ?? null;

      if (!selectedRoleId) {
        // User cleared the selection → remove role reward
        await pool.query(
          'UPDATE battlepass_config SET reward_role_id = NULL WHERE guild_id = $1 AND level = $2',
          [guildId, level]
        );
        sysLog('Level Role Reward Cleared', { guild: guildId, user: interaction.user.id, detail: `Level ${level}` });
        sendLog(interaction.guild, 'audit', 'orange', '⭐ Level Role Cleared', `Admin **<@${interaction.user.id}>** cleared the role reward for **Level ${level}**.`);
        const payload = await getPassDashboardPayload(guildId, page, level);
        await interaction.editReply({ content: '', ...payload });
        return;
      }

      const role = interaction.guild.roles.cache.get(selectedRoleId);
      if (!role) {
        return interaction.followUp({ content: '⚠️ Role not found. Please try again.', flags: MessageFlags.Ephemeral });
      }

      // Security validation
      const err = validateRoleForAssignment(role, interaction.guild);
      if (err) {
        return interaction.followUp({ content: err, flags: MessageFlags.Ephemeral });
      }

      await pool.query(
        'UPDATE battlepass_config SET reward_role_id = $3 WHERE guild_id = $1 AND level = $2',
        [guildId, level, selectedRoleId]
      );

      sysLog('Level Role Reward Set', { guild: guildId, user: interaction.user.id, detail: `Level ${level} → role ${selectedRoleId}` });
      sendLog(interaction.guild, 'audit', 'cyan', '⭐ Level Role Reward Set', `Admin **<@${interaction.user.id}>** set the role reward for **Level ${level}** to <@&${selectedRoleId}>.`);

      const payload = await getPassDashboardPayload(guildId, page, level);
      await interaction.editReply({ content: '', ...payload });
      return;
    }

    // ── 11. Coins Selector ────────────────────────────────────────────────
    if (customId.startsWith('pass_coins_select_lvl_')) {
      const match = customId.match(/pass_coins_select_lvl_(\d+)_pg_(\d+)/);
      const level = match ? parseInt(match[1], 10) : 1;
      const page = match ? parseInt(match[2], 10) : 0;
      const selectedValue = interaction.values[0];

      if (selectedValue === 'custom') {
        const modal = new ModalBuilder()
          .setCustomId('pass_set_coins_modal_' + level + '_pg_' + page)
          .setTitle('Set Custom Coins — Level ' + level);

        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('pass_coins_input')
              .setLabel('Coins reward amount')
              .setStyle(TextInputStyle.Short)
              .setPlaceholder('Enter coin amount (e.g. 500)')
              .setMinLength(1).setMaxLength(8)
              .setRequired(true)
          )
        );
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

      sysLog('Level Coins Updated', { guild: guildId, user: interaction.user.id, detail: 'Level ' + level + ' coins set to ' + coins });

      const payload = await getPassDashboardPayload(guildId, page, level);
      await interaction.editReply({ content: '', ...payload });
      return;
    }

    // ── 12. Rewards Browser ───────────────────────────────────────────────
    if (customId.startsWith('pass_rewards_select_lvl_')) {
      const match = customId.match(/pass_rewards_select_lvl_(\d+)_pg_(\d+)_fld_(.+)/);
      const level = match ? parseInt(match[1], 10) : 1;
      const page = match ? parseInt(match[2], 10) : 0;
      const currentFolder = match ? match[3] : 'root';
      const selectedValue = interaction.values[0];

      if (selectedValue.startsWith('folder_')) {
        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
        const folderTarget = selectedValue.replace('folder_', '');
        const payload = await getPassDashboardPayload(guildId, page, level, folderTarget);
        await interaction.editReply({ content: '', ...payload });
        return;
      }

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

        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('reward_quantity')
              .setLabel('Quantity (0 = Remove)')
              .setStyle(TextInputStyle.Short)
              .setPlaceholder('0 = Remove')
              .setValue(String(currentQty))
              .setMinLength(1).setMaxLength(3)
              .setRequired(true)
          )
        );
        await interaction.showModal(modal);
        return;
      }

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

        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('reward_quantity')
              .setLabel('Quantity (0 = Remove)')
              .setStyle(TextInputStyle.Short)
              .setPlaceholder('0 = Remove')
              .setValue(String(currentQty))
              .setMinLength(1).setMaxLength(3)
              .setRequired(true)
          )
        );
        await interaction.showModal(modal);
        return;
      }
    }

    // ── 13. Delete Level Button ───────────────────────────────────────────
    if (customId.startsWith('pass_del_btn_')) {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
      const match = customId.match(/pass_del_btn_(\d+)_pg_(\d+)/);
      const level = match ? parseInt(match[1], 10) : 1;
      const page = match ? parseInt(match[2], 10) : 0;
      const pool = getPool();
      await pool.query('DELETE FROM battlepass_config WHERE guild_id = $1 AND level = $2', [guildId, level]);
      await pool.query('DELETE FROM battlepass_rewards WHERE guild_id = $1 AND level = $2', [guildId, level]);
      await pool.query('DELETE FROM user_pass_claims WHERE guild_id = $1 AND level_claimed = $2', [guildId, level]);
      sysLog('Level Deleted', { guild: guildId, user: interaction.user.id, detail: 'Level ' + level + ' deleted' });
      sendLog(interaction.guild, 'audit', 'red', '🗑️ Level Deleted', `Admin **<@${interaction.user.id}>** deleted **Level ${level}**.`);
      const payload = await getPassDashboardPayload(guildId, page, null);
      await interaction.editReply({ content: '', ...payload });
      return;
    }

    // ── 14. Import — Warning Gate ─────────────────────────────────────────
    if (customId.startsWith('pass_import_start_pg_')) {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
      const page = parseInt(customId.replace('pass_import_start_pg_', ''), 10) || 0;

      const embed = new EmbedBuilder()
        .setTitle('📥 Import Levels')
        .setColor(0xED4245)
        .setDescription(
          '**Before Importing:**\n' +
          '-# • Only use this tool if transferring levels from another bot.\n' +
          '-# • Disable or remove your previous leveling bot from the server.\n' +
          '-# • Configure your XP settings before importing.\n' +
          '-# • Do not add levels manually; they are created automatically on import.\n' +
          '-# • Customize coins, items, and chests for each level after importing.\n' +
          '-# • Do not re-run this migration after members start earning XP naturally.\n' +
          '-# • Members who left the server will lose their levels.\n' +
          '---\n' +
          '**How Importing Works:**\n' +
          '-# • Map each Discord role to its corresponding level number.\n' +
          '-# • The bot scans all members and assigns levels based on held roles.\n' +
          '-# • Levels are saved to settings and users can resume their progress.'
        );

      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('pass_home_page_' + page)
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('pass_import_proceed_pg_' + page)
          .setLabel('Proceed')
          .setEmoji('✅')
          .setStyle(ButtonStyle.Danger)
      );

      await interaction.editReply({ embeds: [embed], components: [row1] });
      return;
    }

    // ── 15. Import — Proceed (initialize mapping state) ───────────────────
    if (customId.startsWith('pass_import_proceed_pg_')) {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
      const page = parseInt(customId.replace('pass_import_proceed_pg_', ''), 10) || 0;
      const flowKey = `${guildId}:${interaction.user.id}`;

      // Initialize fresh import state
      importFlowState.set(flowKey, { mappings: new Map(), page });

      await renderImportMappingPanel(interaction, guildId, flowKey, page);
      return;
    }

    // ── 16. Import — Role Selected for Mapping ────────────────────────────
    if (customId.startsWith('pass_import_role_select_')) {
      const page = parseInt(customId.replace('pass_import_role_select_', ''), 10) || 0;
      const flowKey = `${guildId}:${interaction.user.id}`;
      const state = importFlowState.get(flowKey);

      if (!state) {
        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
        const payload = await getPassDashboardPayload(guildId, page, null);
        return interaction.editReply({ content: '⚠️ Import session expired. Please start again.', ...payload });
      }

      const roleId = interaction.values[0];
      const role = interaction.guild.roles.cache.get(roleId);

      if (!role) {
        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
        return interaction.followUp({ content: '⚠️ Role not found.', flags: MessageFlags.Ephemeral });
      }

      // No dangerous perms check — we are only READING role membership, not awarding it
      // Store pending role in state and show level input modal
      state.pendingRoleId = roleId;
      state.pendingRoleName = role.name;

      const modal = new ModalBuilder()
        .setCustomId('pass_import_level_modal_' + page)
        .setTitle(`Map: @${role.name.slice(0, 40)}`);

      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('import_level_input')
            .setLabel('What level is this role?')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('e.g. 5')
            .setMinLength(1).setMaxLength(5)
            .setRequired(true)
        )
      );

      await interaction.showModal(modal);
      return;
    }

    // ── 17. Import — Next (scan members and show preview) ─────────────────
    if (customId.startsWith('pass_import_next_pg_')) {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
      const page = parseInt(customId.replace('pass_import_next_pg_', ''), 10) || 0;
      const flowKey = `${guildId}:${interaction.user.id}`;
      const state = importFlowState.get(flowKey);

      if (!state || state.mappings.size === 0) {
        return interaction.followUp({ content: '⚠️ You must map at least one role before proceeding.', flags: MessageFlags.Ephemeral });
      }

      await renderImportPreview(interaction, guildId, flowKey, page);
      return;
    }

    // ── 18. Import — Cancel Flow ──────────────────────────────────────────
    if (customId.startsWith('pass_import_cancel_pg_')) {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
      const page = parseInt(customId.replace('pass_import_cancel_pg_', ''), 10) || 0;
      const flowKey = `${guildId}:${interaction.user.id}`;
      importFlowState.delete(flowKey);
      const payload = await getPassDashboardPayload(guildId, page, null);
      await interaction.editReply({ content: '', ...payload });
      return;
    }

    // ── 19. Import — Confirm & Sync ───────────────────────────────────────
    if (customId.startsWith('pass_import_confirm_pg_')) {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
      const page = parseInt(customId.replace('pass_import_confirm_pg_', ''), 10) || 0;
      const flowKey = `${guildId}:${interaction.user.id}`;
      const state = importFlowState.get(flowKey);

      if (!state || !state.preview) {
        return interaction.followUp({ content: '⚠️ Import session expired. Please start again.', flags: MessageFlags.Ephemeral });
      }

      await executeImportSync(interaction, guildId, flowKey, page);
      return;
    }

  } catch (error) {
    await handleInteractionError(interaction, error, 'pass component');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// IMPORT FLOW HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function renderImportMappingPanel(interaction, guildId, flowKey, page) {
  const state = importFlowState.get(flowKey);
  const mappings = state?.mappings || new Map();

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('📥 Import Levels — Role Mapping');

  const sortedMappings = [...mappings.entries()].sort((a, b) => Number(a[1]) - Number(b[1]));
  const lines = sortedMappings.map(([roleId, level]) => `• <@&${roleId}> → **Level ${level}**`);

  embed.setDescription(
    (lines.length > 0 ? lines.join('\n') + '\n\n' : '') +
    'Select a role below and enter its level. Press **Next** when done.'
  );

  const roleSelect = new RoleSelectMenuBuilder()
    .setCustomId('pass_import_role_select_' + page)
    .setPlaceholder('Select a role to map...')
    .setMinValues(1).setMaxValues(1);

  const row1 = new ActionRowBuilder().addComponents(roleSelect);

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('pass_import_cancel_pg_' + page)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('pass_import_next_pg_' + page)
      .setLabel('Next')
      .setEmoji('➡️')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(mappings.size === 0)
  );

  await interaction.editReply({ embeds: [embed], components: [row1, row2] });
}

async function renderImportPreview(interaction, guildId, flowKey, page) {
  const state = importFlowState.get(flowKey);
  const mappings = state.mappings; // Map<roleId, level>

  // Fetch all guild members
  const guild = interaction.guild;
  let members;
  try {
    members = await guild.members.fetch();
  } catch {
    return interaction.followUp({ content: '⚠️ Failed to fetch server members. Please try again.', flags: MessageFlags.Ephemeral });
  }

  // Level-to-count map for preview
  const levelCounts = new Map(); // Map<level, count>
  const userAssignments = new Map(); // Map<userId, level>

  for (const [memberId, member] of members) {
    if (member.user.bot) continue;

    const matchedLevels = [];
    for (const [roleId, level] of mappings.entries()) {
      if (member.roles.cache.has(roleId)) {
        matchedLevels.push(level);
      }
    }

    if (matchedLevels.length === 0) continue;

    // Conflict resolution: assign the LOWEST level
    const assignedLevel = Math.min(...matchedLevels);
    userAssignments.set(memberId, assignedLevel);

    const current = levelCounts.get(assignedLevel) || 0;
    levelCounts.set(assignedLevel, current + 1);
  }

  if (userAssignments.size === 0) {
    return interaction.followUp({
      content: '⚠️ No members were found with any of the mapped roles. No changes would be made.',
      flags: MessageFlags.Ephemeral
    });
  }

  // Store preview data in state
  state.preview = { userAssignments };

  const sortedLevels = [...levelCounts.entries()].sort((a, b) => a[0] - b[0]);
  const previewLines = sortedLevels.map(([level, count]) => `• ${count} ${count === 1 ? 'user' : 'users'} will be level ${level}`);

  const embed = new EmbedBuilder()
    .setColor(0xFEE75C)
    .setTitle('📥 Import Preview — Confirm')
    .setDescription(
      previewLines.join('\n') + '\n\n' +
      `**Total affected:** ${userAssignments.size} member${userAssignments.size === 1 ? '' : 's'}\n\n` +
      '• Level & XP progress will be set for all mapped members\n' +
      '• Mapped milestone roles will be synchronized\n' +
      '• You can configure coins, items, and chests for each level before clicking Start'
    );

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('pass_import_cancel_pg_' + page)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('pass_import_confirm_pg_' + page)
      .setLabel('Confirm & Sync')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success)
  );

  await interaction.editReply({ embeds: [embed], components: [row1] });
}

async function executeImportSync(interaction, guildId, flowKey, page) {
  const state = importFlowState.get(flowKey);
  const { preview, mappings } = state;
  const { userAssignments } = preview;

  const config = await getGuildConfig(guildId) || {};
  const baseXp = parseInt(config.battlepass_base_xp ?? config.battlepass_xp_per_level ?? 100, 10);
  const incrementXp = parseInt(config.battlepass_xp_increment ?? 50, 10);

  const { getTotalXpForLevel, dispatchLevelReward } = await import('./pass-engine.js');
  const pool = getPool();

  let syncCount = 0;
  const guild = interaction.guild;

  // 0. Auto-create/update all mapped levels and their reward roles in battlepass_config
  for (const [roleId, level] of mappings.entries()) {
    await pool.query(
      `INSERT INTO battlepass_config (guild_id, level, reward_role_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (guild_id, level)
       DO UPDATE SET reward_role_id = EXCLUDED.reward_role_id`,
      [guildId, level, roleId]
    );
  }

  // Fetch all configured role reward IDs for role alignment
  const configuredRolesRes = await pool.query(
    'SELECT reward_role_id FROM battlepass_config WHERE guild_id = $1 AND reward_role_id IS NOT NULL',
    [guildId]
  );
  const allConfiguredRoleIds = configuredRolesRes.rows.map(r => r.reward_role_id);

  // Fetch all configured level rows for this guild
  const configuredLevelsRes = await pool.query(
    `SELECT bc.level, bc.reward_coins, bc.reward_role_id,
            bc.reward_item_id, bc.reward_chest_id,
            si.name as item_name, si.role_id as item_role_id,
            lb.name as chest_name
     FROM battlepass_config bc
     LEFT JOIN shop_items si ON bc.reward_item_id = si.id
     LEFT JOIN loot_boxes lb ON bc.reward_chest_id = lb.id
     WHERE bc.guild_id = $1
     ORDER BY bc.level ASC`,
    [guildId]
  );
  const configuredLevelsMap = new Map();
  for (const row of configuredLevelsRes.rows) {
    configuredLevelsMap.set(row.level, row);
  }

  for (const [userId, assignedLevel] of userAssignments.entries()) {
    try {
      const totalXp = getTotalXpForLevel(assignedLevel, baseXp, incrementXp);
      const member = guild.members.cache.get(userId)
        || await guild.members.fetch(userId).catch(() => null);
      const username = member?.user?.username || 'Member';

      // 1. Upsert user XP and username (Level and XP are now set)
      await pool.query(
        `INSERT INTO user_activity (guild_id, user_id, username, battlepass_xp)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (guild_id, user_id)
         DO UPDATE SET battlepass_xp = $4, username = $3`,
        [guildId, userId, username, totalXp]
      );

      // 2. Role alignment: strip conflicting level roles, ensure lowest-level role is active
      try {
        if (member) {
          const levelRoleRes = await pool.query(
            'SELECT reward_role_id FROM battlepass_config WHERE guild_id = $1 AND level = $2 AND reward_role_id IS NOT NULL',
            [guildId, assignedLevel]
          );
          const assignedRoleId = levelRoleRes.rows[0]?.reward_role_id ?? null;

          // Remove all other configured level roles
          for (const rId of allConfiguredRoleIds) {
            if (rId === assignedRoleId) continue;
            if (member.roles.cache.has(rId)) {
              const r = guild.roles.cache.get(rId);
              if (r) await member.roles.remove(r).catch(() => {});
            }
          }

          // Add assigned role if present and safe
          if (assignedRoleId && !member.roles.cache.has(assignedRoleId)) {
            const assignedRole = guild.roles.cache.get(assignedRoleId)
              || await guild.roles.fetch(assignedRoleId).catch(() => null);
            if (assignedRole) {
              const { validateRoleForAssignment } = await import('./pass-engine.js');
              const err = validateRoleForAssignment(assignedRole, guild);
              if (!err) await member.roles.add(assignedRole).catch(() => {});
            }
          }
        }
      } catch {
        // Role sync failure is non-fatal for the import
      }

      syncCount++;
    } catch (err) {
      sysLog('Import Sync Error', { guild: guildId, user: userId, detail: String(err.message || err) });
    }
  }

  // Clean up state
  importFlowState.delete(flowKey);

  // Audit log
  const mappingDesc = [...mappings.entries()]
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map(([rId, lv]) => `<@&${rId}> → Level ${lv}`)
    .join(', ');
  sendLog(
    interaction.guild, 'audit', 'green', '📥 Level Import Complete',
    `Admin **<@${interaction.user.id}>** imported levels for **${syncCount} member${syncCount === 1 ? '' : 's'}**.\n**Mappings:** ${mappingDesc}`
  );

  sysLog('Level Import Completed', {
    guild: guildId,
    user: interaction.user.id,
    detail: `${syncCount} members synced | Mappings: ${mappingDesc}`
  });

  const embed = new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle('✅ Import Complete')
    .setDescription(`Successfully synced **${syncCount} member${syncCount === 1 ? '' : 's'}**.`);

  const backRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('pass_home_page_' + page)
      .setLabel('Back to Levels')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary)
  );

  await interaction.editReply({ embeds: [embed], components: [backRow] });
}

// ─────────────────────────────────────────────────────────────────────────────
// MODAL HANDLER
// ─────────────────────────────────────────────────────────────────────────────

export async function handlePassModal(interaction) {
  try {
    const guildId = interaction.guildId;
    const customId = interaction.customId;

    // Import level modal is allowed even when levels are running
    if (!customId.startsWith('pass_import_level_modal_') && !customId.startsWith('pass_boost_pct_modal_')) {
      const config = await getGuildConfig(guildId) || {};
      if (config.battlepass_enabled === true) {
        return interaction.reply({ content: '⚠️ You must pause levels before making changes.', flags: MessageFlags.Ephemeral });
      }
    }

    // ── 1. Reward Quantity Modal ──────────────────────────────────────────
    if (customId.startsWith('pass_reward_qty_')) {
      const match = customId.match(/pass_reward_qty_(\d+)_(item|chest)_(\d+)_pg_(\d+)_fld_(.+)/);
      if (!match) return;

      const level = parseInt(match[1], 10);
      const type = match[2];
      const targetId = parseInt(match[3], 10);
      const page = parseInt(match[4], 10);

      const qtyRaw = interaction.fields.getTextInputValue('reward_quantity').trim();
      const quantity = parseInt(qtyRaw, 10);

      if (isNaN(quantity) || quantity < 0 || quantity > 999) {
        return interaction.reply({ content: '❌ Quantity must be between 0 and 999 (enter 0 to remove).', flags: MessageFlags.Ephemeral });
      }

      await interaction.deferUpdate().catch(() => {});

      const pool = getPool();
      if (quantity === 0) {
        if (type === 'item') {
          await pool.query('DELETE FROM battlepass_rewards WHERE guild_id = $1 AND level = $2 AND reward_type = $3 AND shop_item_id = $4', [guildId, level, 'item', targetId]);
        } else {
          await pool.query('DELETE FROM battlepass_rewards WHERE guild_id = $1 AND level = $2 AND reward_type = $3 AND loot_box_id = $4', [guildId, level, 'chest', targetId]);
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

      const payload = await getPassDashboardPayload(guildId, page, level, 'root');
      await interaction.editReply({ content: '', ...payload });
      return;
    }

    // ── 2. Create New Level Modal ─────────────────────────────────────────
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

      sysLog('Level Created', { guild: guildId, user: interaction.user.id, detail: 'Level ' + level + ' created' });
      sendLog(interaction.guild, 'audit', 'cyan', '⭐ Level Created', `Admin **<@${interaction.user.id}>** created **Level ${level}**.`);

      const payload = await getPassDashboardPayload(guildId, page, level);
      await interaction.editReply({ content: '', ...payload });
      return;
    }

    // ── 3. Set Coins Modal ────────────────────────────────────────────────
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

      sysLog('Level Coins Configured', { guild: guildId, user: interaction.user.id, detail: `Level ${level} coins set to ${coins}` });
      sendLog(interaction.guild, 'audit', 'cyan', '⭐ Level Coins Updated', `Admin **<@${interaction.user.id}>** set **Level ${level}** coins to **${coins.toLocaleString()}**.`);

      const payload = await getPassDashboardPayload(guildId, page, level);
      await interaction.editReply({ content: '', ...payload });
      return;
    }

    // ── 4. Set XP Modal (unified 5-field) ─────────────────────────────────
    if (customId.startsWith('pass_xp_threshold_modal_pg_')) {
      const page = parseInt(customId.replace('pass_xp_threshold_modal_pg_', ''), 10) || 0;

      const baseRaw = (interaction.fields.getTextInputValue('pass_base_xp_input') || '').trim();
      const incRaw = (interaction.fields.getTextInputValue('pass_increment_xp_input') || '').trim();
      const msgRaw = (interaction.fields.getTextInputValue('pass_msg_xp_input') || '').trim();
      const voiceRaw = (interaction.fields.getTextInputValue('pass_voice_xp_input') || '').trim();
      const questRaw = (interaction.fields.getTextInputValue('pass_quest_xp_input') || '').trim();

      const baseXp = baseRaw === '' ? 100 : parseInt(baseRaw, 10);
      const incrementXp = incRaw === '' ? 50 : parseInt(incRaw, 10);
      const msgXp = msgRaw === '' ? 1 : parseInt(msgRaw, 10);
      const voiceXp = voiceRaw === '' ? 1 : parseInt(voiceRaw, 10);
      const questXp = questRaw === '' ? 150 : parseInt(questRaw, 10);

      if (isNaN(baseXp) || baseXp < 1) return interaction.reply({ content: '❌ Base XP must be at least 1.', flags: MessageFlags.Ephemeral });
      if (isNaN(incrementXp) || incrementXp < 0) return interaction.reply({ content: '❌ XP Increment must be 0 or higher.', flags: MessageFlags.Ephemeral });
      if (isNaN(msgXp) || msgXp < 0) return interaction.reply({ content: '❌ Message XP must be 0 or higher.', flags: MessageFlags.Ephemeral });
      if (isNaN(voiceXp) || voiceXp < 0) return interaction.reply({ content: '❌ Voice XP must be 0 or higher.', flags: MessageFlags.Ephemeral });
      if (isNaN(questXp) || questXp < 0) return interaction.reply({ content: '❌ Quest XP must be 0 or higher.', flags: MessageFlags.Ephemeral });

      await interaction.deferUpdate().catch(() => {});

      await setGuildConfig(guildId, {
        battlepass_base_xp: baseXp,
        battlepass_xp_increment: incrementXp,
        battlepass_xp_per_level: baseXp, // legacy alias kept
        battlepass_msg_xp: msgXp,
        battlepass_voice_xp: voiceXp,
        battlepass_quest_xp: questXp
      });

      sysLog('Level XP Config Set', { guild: guildId, user: interaction.user.id, detail: `Base:${baseXp} Inc:${incrementXp} Msg:${msgXp} Voice:${voiceXp} Quest:${questXp}` });

      sendLog(
        interaction.guild, 'audit', 'cyan', '⚡ XP Configuration Updated',
        `Admin **<@${interaction.user.id}>** updated XP settings:\n` +
        `• Base XP (Level 1): **${baseXp.toLocaleString()}**\n` +
        `• Increment per Level: **+${incrementXp.toLocaleString()}**\n` +
        `• Message XP: **${msgXp}**/msg\n` +
        `• Voice XP: **${voiceXp}**/min\n` +
        `• Quest Completion XP: **${questXp}**`
      );

      const payload = await getPassDashboardPayload(guildId, page, null);
      await interaction.editReply({ content: '', ...payload });
      return;
    }

    // ── 5. Boost Percentage Modal ─────────────────────────────────────────
    if (customId.startsWith('pass_boost_pct_modal_')) {
      const match = customId.match(/pass_boost_pct_modal_(.+)_pg_(\d+)/);
      if (!match) return;
      const roleId = match[1];
      const page = parseInt(match[2], 10) || 0;

      const pctRaw = interaction.fields.getTextInputValue('boost_pct_input').trim();
      const pct = parseInt(pctRaw, 10);

      if (isNaN(pct) || pct < 1 || pct > 500) {
        return interaction.reply({ content: '❌ Boost percentage must be between 1 and 500.', flags: MessageFlags.Ephemeral });
      }

      await interaction.deferUpdate().catch(() => {});

      const pool = getPool();
      await pool.query(
        `INSERT INTO role_xp_boosters (guild_id, role_id, boost_percentage)
         VALUES ($1, $2, $3)
         ON CONFLICT (guild_id, role_id)
         DO UPDATE SET boost_percentage = $3`,
        [guildId, roleId, pct]
      );

      sysLog('XP Boost Set', { guild: guildId, user: interaction.user.id, detail: `Role ${roleId} → +${pct}%` });
      sendLog(
        interaction.guild, 'audit', 'cyan', '🚀 XP Boost Set',
        `Admin **<@${interaction.user.id}>** set XP boost for <@&${roleId}> to **+${pct}%**.`
      );

      const payload = await getBoostsDashboardPayload(guildId, page);
      await interaction.editReply({ content: '', ...payload });
      return;
    }

    // ── 6. Import Level Modal (role → level mapping) ──────────────────────
    if (customId.startsWith('pass_import_level_modal_')) {
      const page = parseInt(customId.replace('pass_import_level_modal_', ''), 10) || 0;
      const flowKey = `${guildId}:${interaction.user.id}`;
      const state = importFlowState.get(flowKey);

      if (!state || !state.pendingRoleId) {
        return interaction.reply({ content: '⚠️ Import session expired. Please start again.', flags: MessageFlags.Ephemeral });
      }

      const levelRaw = interaction.fields.getTextInputValue('import_level_input').trim();
      const level = parseInt(levelRaw, 10);

      if (isNaN(level) || level <= 0) {
        return interaction.reply({ content: '❌ Level must be a positive whole number.', flags: MessageFlags.Ephemeral });
      }

      // Add mapping
      state.mappings.set(state.pendingRoleId, level);
      delete state.pendingRoleId;
      delete state.pendingRoleName;

      await interaction.deferUpdate().catch(() => {});
      await renderImportMappingPanel(interaction, guildId, flowKey, page);
      return;
    }

  } catch (error) {
    await handleInteractionError(interaction, error, 'pass modal');
  }
}
