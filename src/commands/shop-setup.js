import {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  FileUploadBuilder,
  LabelBuilder,
  StringSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  UserSelectMenuBuilder,
  ChannelType,
  MessageFlags
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import { sendLog, formatDiff, sendBulkLog, sysLog, sysError } from '../utils/logger.js';
import { handleInteractionError, diagnoseChannelPermissions } from '../utils/errors.js';
import { sanitizeError, COIN_EMOJI, isValidEconomyAmount, getUserLogName, parseSelectEmoji, safeSetButtonEmoji, resolveComponentEmoji, hasAnyDangerousPermission, RARITY_OPTIONS, getCurrencyName, getCurrencyEmoji, formatCurrentImageDescription, isBackDisabled, getItemEmbedColor, safeDeferUpdate } from '../shared.js';
import { uploadHostAsset } from '../utils/image-host.js';

import { query } from '../storage/postgres.js';
import {
  addShopCategory,
  addShopItem,
  updateShopItem,
  deleteShopItem,
  getShopCategories,
  getShopItems,
  getShopItem,
  getItemImage,
  deleteShopCategory,
  updateShopCategory,
  detachItemsFromCategory,
  getItemUsageCount,
  validateRoleUniqueness
} from '../economy/shop.js';
import {
  getLootBoxes,
  getLootBox,
  createLootBox,
  updateLootBox,
  updateLootBoxRarityRates,
  updateLootBoxCoinsConfig,
  updateLootBoxPrizeCount,
  deleteLootBox,
  toggleLootBoxFeature,
  getLootBoxCategoryName,
  getLootBoxCategoryEmoji
} from '../economy/lootbox.js';
import { setGuildConfig, getGuildConfig } from '../storage/config.js';
import { buildPaginatedSelectMenu } from '../utils/paginator.js';
import { RARITY_DISPLAY, RARITY_EMOJIS, DEFAULT_COIN_EMOJI, getItemRarityEmoji, sortItemsByRarity } from '../shared.js';
import { verifyAndHealMessageImages } from '../utils/image-healer.js';
import { cleanImageUrl, isSameImageUrl } from '../utils/embed-sanitizer.js';

// Temporary storage for post item flow (Session ID / Message ID -> draft state)
const pendingPosts = new Map();
const PENDING_POST_SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes

import { resolveItemDefaultImage, buildShopPostPayload } from '../utils/shop-post-builder.js';
export { resolveItemDefaultImage, buildShopPostPayload };

/**
 * Resolve the isolated post-staging session key for an interaction.
 * Priority:
 * 1. Explicit session ID cached on the interaction object (_postSessionId)
 * 2. Session ID encoded in customId suffix (e.g., "shop_post_stock_modal:sessionId")
 * 3. Discord panel message ID (interaction.message.id) for buttons and select menus
 * 4. Newly generated 8-char UUID fallback
 */
function getPostSessionId(interaction) {
  if (interaction?._postSessionId) {
    return interaction._postSessionId;
  }
  const rawCustomId = interaction?.customId || '';
  if (rawCustomId.includes(':')) {
    const suffix = rawCustomId.split(':')[1]?.trim();
    if (suffix) {
      interaction._postSessionId = suffix;
      return suffix;
    }
  }
  if (interaction?.message?.id) {
    interaction._postSessionId = interaction.message.id;
    return interaction.message.id;
  }
  const generated = randomUUID().slice(0, 8);
  if (interaction) {
    interaction._postSessionId = generated;
  }
  return generated;
}

export async function getPendingPostSession(sessionId) {
  if (!sessionId) return null;
  if (pendingPosts.has(sessionId)) {
    let memState = pendingPosts.get(sessionId);
    if (typeof memState === 'string') {
      try { memState = JSON.parse(memState); } catch (_) {}
      pendingPosts.set(sessionId, memState);
    }
    if (memState && typeof memState === 'object') return memState;
  }
  try {
    const res = await query(
      `SELECT state FROM shop_post_sessions WHERE session_id = $1 LIMIT 1`,
      [sessionId]
    );
    if (res.rows.length > 0 && res.rows[0].state) {
      let dbState = res.rows[0].state;
      while (typeof dbState === 'string') {
        try {
          dbState = JSON.parse(dbState);
        } catch (_) {
          break;
        }
      }
      if (dbState && typeof dbState === 'object') {
        pendingPosts.set(sessionId, dbState);
        return dbState;
      }
    }
  } catch (_) {}
  return null;
}

export async function setPendingPostSession(sessionId, state) {
  if (!sessionId || !state) return;
  state.sessionId = sessionId;
  state.updatedAt = Date.now();
  pendingPosts.set(sessionId, state);

  try {
    const jsonState = typeof state === 'string' ? state : JSON.stringify(state);
    await query(
      `INSERT INTO shop_post_sessions (session_id, state, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (session_id) DO UPDATE SET
         state = EXCLUDED.state,
         updated_at = NOW()`,
      [sessionId, jsonState]
    );
  } catch (_) {}
}

export async function deletePendingPostSession(sessionId) {
  if (!sessionId) return;
  pendingPosts.delete(sessionId);
  try {
    await query(`DELETE FROM shop_post_sessions WHERE session_id = $1`, [sessionId]);
  } catch (_) {}
}

// 15-minute abandoned session sweeper evaluating updatedAt on a per-session basis
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, state] of pendingPosts.entries()) {
    const lastActive = state?.updatedAt || 0;
    if (now - lastActive > PENDING_POST_SESSION_TTL_MS) {
      pendingPosts.delete(sessionId);
    }
  }
}, 60 * 1000).unref();

// Temporary storage for edit/delete flows to isolate state from Post flow.
// (Guild ID : User ID -> action: 'edit_item' | 'edit_pack' | 'delete_item' | 'delete_pack')
export const pendingAdminBrowser = new Map();

function getAdminBrowserKey(interaction) {
  const gId = interaction?.guildId || interaction?.guild?.id || 'global';
  const uId = interaction?.user?.id || 'unknown';
  return `${gId}:${uId}`;
}

// Define the /shop setup command
export const shopSetupCommand = new SlashCommandBuilder()
  .setName('shop')
  .setDescription('Admin: Manage the server shop')
  .setDMPermission(false)
  .addSubcommand(subcommand =>
    subcommand
      .setName('setup')
      .setDescription('Open the shop management panel')
  );

/**
 * Main Shop Command Handler
 */
export async function handleShopCommand(interaction) {
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'setup') {
    await handleShopSetup(interaction);
  } else {
    await handleInteractionError(interaction, new Error(`Unknown subcommand: ${subcommand}`), 'shop command');
  }
}

/**
 * Main shop setup panel handler
 */
export async function handleShopSetup(interaction) {
  try {
    const { verifyAdminAccess } = await import('../storage/admins.js');
    if (!(await verifyAdminAccess(interaction))) return;

    if (interaction.isMessageComponent && interaction.isMessageComponent()) {
      const sessionId = getPostSessionId(interaction);
      await deletePendingPostSession(sessionId);
    }

    // Defer if not already deferred
    if (!interaction.deferred && !interaction.replied) {
      if (interaction.isMessageComponent && interaction.isMessageComponent()) {
        await interaction.deferUpdate();
      } else {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      }
    }

    const payload = await getShopSetupPayload(interaction.guild, interaction.guildId, interaction);
    // Always use editReply since we likely deferred
    await interaction.editReply(payload);
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop setup');
  }
}

export async function getShopSetupPayload(guild, guildId, interaction = null) {
  // Get shop statistics
  const categoriesResult = await query(
    'SELECT COUNT(*) as count FROM shop_categories WHERE guild_id = $1',
    [guildId]
  );

  // Get Items, Packs, and Loot Boxes counts
  const itemsResult = await query(
    `SELECT 
      COUNT(*) FILTER (WHERE item_type = 'pack') as pack_count,
      COUNT(*) FILTER (WHERE item_type = 'loot_box') as lootbox_count,
      COUNT(*) FILTER (WHERE item_type != 'pack' AND item_type != 'loot_box' OR item_type IS NULL) as item_count
     FROM shop_items 
     WHERE guild_id = $1 AND is_active = true`,
    [guildId]
  );

  const lootBoxCatName = await getLootBoxCategoryName(guildId);
  const lootBoxEmoji = await getLootBoxCategoryEmoji(guildId);
  const categoriesCount = parseInt(categoriesResult.rows[0]?.count || 0);
  const packCount = parseInt(itemsResult.rows[0]?.pack_count || 0);
  const itemsCount = parseInt(itemsResult.rows[0]?.item_count || 0);

  const embed = new EmbedBuilder()
    .setColor('#9B59B6')
    .setTitle('Items')
    .setDescription('Manage categories and items in your server shop.')
    .addFields(
      { name: '📂 Categories', value: `${categoriesCount}`, inline: true },
      { name: '🏷️ Items', value: `${itemsCount}`, inline: true },
      { name: '📦 Packs', value: `${packCount}`, inline: true }
    );

  const nonce = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // Select Menu 1: Categories
  const categoriesSelect = new StringSelectMenuBuilder()
    .setCustomId(`shop_menu_categories_${nonce}`)
    .setPlaceholder('📂 Categories')
    .addOptions([
      { label: 'Create Category', value: 'shop_action_create_cat', emoji: '➕' },
      { label: 'Edit Category', value: 'shop_action_edit_cat', emoji: '✏️' },
      { label: 'Delete Category', value: 'shop_action_delete_cat', emoji: '🗑️' }
    ]);
  const rowCategories = new ActionRowBuilder().addComponents(categoriesSelect);

  // Select Menu 2: Items
  const itemsSelect = new StringSelectMenuBuilder()
    .setCustomId(`shop_menu_items_${nonce}`)
    .setPlaceholder('🏷️ Items')
    .addOptions([
      { label: 'Create Item', value: 'shop_action_create_item', emoji: '➕' },
      { label: 'Edit Item', value: 'shop_action_edit_item', emoji: '✏️' },
      { label: 'Delete Item', value: 'shop_action_delete_item', emoji: '🗑️' }
    ]);
  const rowItems = new ActionRowBuilder().addComponents(itemsSelect);

  // Select Menu 3: Packs
  const packsSelect = new StringSelectMenuBuilder()
    .setCustomId(`shop_menu_packs_${nonce}`)
    .setPlaceholder('📦 Packs')
    .addOptions([
      { label: 'Create Pack', value: 'shop_action_create_pack', emoji: '➕' },
      { label: 'Edit Pack', value: 'shop_action_edit_pack', emoji: '✏️' },
      { label: 'Delete Pack', value: 'shop_action_delete_pack', emoji: '🗑️' }
    ]);
  const rowPacks = new ActionRowBuilder().addComponents(packsSelect);

  // Row 4: Back (left), Post (right)
  const rowButtons = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('settings_back')
        .setLabel('Back')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(isBackDisabled(interaction)),
      new ButtonBuilder()
        .setCustomId('shop_admin_post')
        .setLabel('Post')
        .setEmoji('📢')
        .setStyle(ButtonStyle.Secondary)
    );

  return { content: null, embeds: [embed], files: [], attachments: [], components: [rowCategories, rowItems, rowPacks, rowButtons] };
}

export async function refreshShopSetupMessage(interaction) {
  try {
    const payload = await getShopSetupPayload(interaction.guild, interaction.guildId, interaction);
    if (interaction.webhook) {
      await interaction.webhook.editMessage('@original', payload).catch(async () => {
        if (interaction.message?.id) {
          await interaction.webhook.editMessage(interaction.message.id, payload).catch(() => {});
        }
      });
    }
  } catch (err) {
    sysError('Failed to refresh shop setup message', err);
  }
}

// --- Main Menu Handlers ---

export async function handleShopMenuSelect(interaction) {
  const value = interaction.values?.[0];
  if (!value) return;

  switch (value) {
    // Categories
    case 'shop_action_create_cat':
      return handleCreateCategory(interaction);
    case 'shop_action_edit_cat':
      return handleEditCategoryStart(interaction);
    case 'shop_action_delete_cat':
      return handleDeleteCategoryStart(interaction);

    // Items
    case 'shop_action_create_item':
      return handleCreateItemStart(interaction);
    case 'shop_action_edit_item':
      return handleEditItemStart(interaction);
    case 'shop_action_delete_item':
      return handleDeleteItemStart(interaction);

    // Packs
    case 'shop_action_create_pack':
      return handleCreatePackStart(interaction);
    case 'shop_action_edit_pack':
      return handleEditPackStart(interaction);
    case 'shop_action_delete_pack':
      return handleDeletePackStart(interaction);

    default:
      return;
  }
}

export async function handleShopAdminAdd(interaction) {
  return handleShopSetup(interaction);
}

export async function handleShopAdminEdit(interaction) {
  return handleShopSetup(interaction);
}

export async function handleShopAdminDelete(interaction) {
  return handleShopSetup(interaction);
}

/**
 * Dedicated Loot Boxes Management Page
 */
export async function handleLootBoxesPage(interaction, statusMessage = null) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  try {
    const guildId = interaction.guildId;
    const lootBoxCatName = await getLootBoxCategoryName(guildId);
    const lootBoxEmoji = await getLootBoxCategoryEmoji(guildId);
    const config = await getGuildConfig(guildId);
    const serverCoinEmoji = config?.coin_emoji || DEFAULT_COIN_EMOJI || '🪙';
    const lootBoxes = await getLootBoxes(guildId);

    const desc = lootBoxes.length > 0
      ? lootBoxes.map((b, idx) => `${idx + 1}. ${lootBoxEmoji} **${b.name}** — 💎 \`${b.min_prizes || 1}—${b.max_prizes || 1}\` | ${serverCoinEmoji} \`${(parseInt(b.min_coins) || 100).toLocaleString()}—${(parseInt(b.max_coins) || 500).toLocaleString()}\``).join('\n')
      : `*No ${lootBoxCatName.toLowerCase()} created yet. Click Create below to add one!*`;

    const embed = new EmbedBuilder()
      .setColor('#9B59B6')
      .setTitle(lootBoxCatName)
      .setDescription(desc);

    const components = [];

    // 1. Dropdown select menu directly in the main menu
    if (lootBoxes.length > 0) {
      const select = new StringSelectMenuBuilder()
        .setCustomId('shop_lb_select_box')
        .setPlaceholder(`Select ${lootBoxCatName}`)
        .addOptions(lootBoxes.slice(0, 25).map(b => ({
          label: (b.name || `Unnamed Box #${b.id}`).slice(0, 80),
          value: `lb_${b.id}`,
          emoji: parseSelectEmoji(lootBoxEmoji, interaction.guild, '🎁')
        })));
      components.push(new ActionRowBuilder().addComponents(select));
    } else {
      const select = new StringSelectMenuBuilder()
        .setCustomId('shop_lb_select_box_empty')
        .setPlaceholder(`No ${lootBoxCatName.toLowerCase()} created yet`)
        .setDisabled(true)
        .addOptions([{
          label: `No ${lootBoxCatName.toLowerCase()} found`,
          value: 'none'
        }]);
      components.push(new ActionRowBuilder().addComponents(select));
    }

    // 2. Action Buttons: Back, Config, Create
    const buttonRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('settings_back')
        .setLabel('Back')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('shop_lb_rename_cat')
        .setLabel('Appearance')
        .setEmoji('🖼️')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('shop_lb_create_start')
        .setLabel('Create')
        .setEmoji('➕')
        .setStyle(ButtonStyle.Success)
    );
    components.push(buttonRow);

    await interaction.editReply({
      content: statusMessage || null,
      embeds: [embed],
      files: [], attachments: [],
      components
    });

  } catch (error) {
    await handleInteractionError(interaction, error, 'loot boxes page');
  }
}

/**
 * Handles "Create Item" selection from the Shop Setup menu.
 * Renders Tab 1 (Details) in an uninitialized state (item = null).
 * The role picker is shown immediately; selecting a role commits the item to the DB.
 */
export async function handleCreateItemStart(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  try {
    const embed = new EmbedBuilder()
      .setTitle('Create Item')
      .setColor('#95A5A6')
      .setDescription(
        'Role: None (Required)\n' +
        'Category: None'
      );

    // Tab row — all tabs except Details are disabled until role is selected
    const tabRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('shop_item_tab_details_new')
        .setLabel('Details')
        .setEmoji('ℹ️')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId('shop_item_appearance_btn_new')
        .setLabel('Appearance')
        .setEmoji('🖼️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId('shop_item_tab_config_new')
        .setLabel('Config')
        .setEmoji('⚙️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId('shop_item_tab_users_new')
        .setLabel('Users')
        .setEmoji('👥')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true)
    );

    // Role select menu — triggers creation on selection
    const roleRow = new ActionRowBuilder().addComponents(
      new RoleSelectMenuBuilder()
        .setCustomId('shop_create_role_select')
        .setPlaceholder('Select a role to create the item')
    );

    // Category select disabled until role selected
    const catOptions = [{ label: 'No Category', value: 'null', emoji: '🏷️' }];
    const catRow = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('shop_assign_cat_select_create')
        .setPlaceholder('Category (Select role first)')
        .setDisabled(true)
        .addOptions(catOptions)
    );

    // Nav row — only Back is available
    const navRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('shop_admin_home')
        .setLabel('Back')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.editReply({
      content: null,
      embeds: [embed],
      files: [],
      attachments: [],
      components: [tabRow, roleRow, catRow, navRow]
    });
  } catch (error) {
    await handleInteractionError(interaction, error, 'create item start');
  }
}

/**
 * Handles role selection during item creation flow (shop_create_role_select).
 * Runs full validation, then commits the item to DB and re-renders Tab 1 fully initialized.
 */
export async function handleCreateRoleSelect(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  try {
    const role = interaction.roles?.first?.() || interaction.guild.roles.cache.get(interaction.values?.[0]);
    if (!role) {
      return interaction.followUp({ content: '❌ Role not found.', flags: MessageFlags.Ephemeral });
    }

    // Mutual exclusion conflict check: cannot be Admin Role, Top Role, MVP Role, Booster Role, dangerous perm, or @everyone
    const { validateRoleConflict } = await import('../storage/admins.js');
    const conflictCheck = await validateRoleConflict(interaction.guild, role, 'ITEM_ROLE');
    if (!conflictCheck.valid) {
      return interaction.followUp({ content: `❌ ${conflictCheck.error}`, flags: MessageFlags.Ephemeral });
    }

    // Block duplicate roles
    const uniqueCheck = await validateRoleUniqueness(interaction.guildId, role.id);
    if (!uniqueCheck.valid) {
      return interaction.followUp({
        content: `❌ Role is already linked to **${uniqueCheck.existingItem?.name || role.id}**.`,
        flags: MessageFlags.Ephemeral
      });
    }

    // Commit to DB: locked, common, no category, no duration
    const newItem = await addShopItem(
      interaction.guildId,
      null,       // category_id
      role.id,
      role.name,
      '',         // description
      null,       // price (set at post time)
      null,       // duration_seconds
      null,       // stock
      'role',
      [],         // contents
      [],         // required_items
      null,       // default_image_url
      'common',
      false,      // is_tradable = Locked
      true,       // is_active
      null        // color
    );

    sendLog(interaction.guild, 'shop', 'green', '🛍️ Item Created',
      `Admin <@${interaction.user.id}> created item **${newItem.name}** (ID: ${newItem.id}) — Rarity: Common, Status: Locked`);

    // Re-render Tab 1 fully initialized for the new item
    const mock = {
      deferred: true, replied: false,
      deferUpdate: async () => {},
      editReply: interaction.editReply.bind(interaction),
      followUp: interaction.followUp.bind(interaction),
      customId: `shop_item_tab_details_${newItem.id}`,
      values: [String(newItem.id)],
      isAnySelectMenu: () => false,
      guildId: interaction.guildId,
      user: interaction.user,
      guild: interaction.guild,
      member: interaction.member,
      memberPermissions: interaction.memberPermissions
    };
    await handleEditItemSelect(mock, `✅ Item **${newItem.name}** created!`);
  } catch (error) {
    await handleInteractionError(interaction, error, 'create role select');
  }
}

/**
 * Handles role swap for an existing item (shop_item_role_swap_<id>).
 * Runs full validation, then updates the role and re-renders Tab 1.
 */
export async function handleRoleSwapSelect(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  try {
    const itemId = interaction.customId.slice('shop_item_role_swap_'.length);
    const item = await getShopItem(itemId, interaction.guildId);
    if (!item) return interaction.followUp({ content: '❌ Item not found.', flags: MessageFlags.Ephemeral });

    const role = interaction.roles?.first?.() || interaction.guild.roles.cache.get(interaction.values?.[0]);
    if (!role) return interaction.followUp({ content: '❌ Role not found.', flags: MessageFlags.Ephemeral });

    // Mutual exclusion conflict check: cannot be Admin Role, Top Role, MVP Role, Booster Role, dangerous perm, or @everyone
    const { validateRoleConflict } = await import('../storage/admins.js');
    const conflictCheck = await validateRoleConflict(interaction.guild, role, 'ITEM_ROLE');
    if (!conflictCheck.valid) {
      return interaction.followUp({ content: `❌ ${conflictCheck.error}`, flags: MessageFlags.Ephemeral });
    }

    // Block duplicate — exclude current item's role
    const uniqueCheck = await validateRoleUniqueness(interaction.guildId, role.id, item.id);
    if (!uniqueCheck.valid) {
      return interaction.followUp({
        content: `❌ Role is already linked to **${uniqueCheck.existingItem?.name || role.id}**.`,
        flags: MessageFlags.Ephemeral
      });
    }

    const oldRoleId = item.role_id;
    await updateShopItem(itemId, { role_id: role.id }, interaction.guildId);
    sendLog(interaction.guild, 'shop', 'blue', '🔄 Item Role Swapped',
      `Admin <@${interaction.user.id}> swapped role for **${item.name}** (ID: ${itemId}).\n**Role:** <@&${oldRoleId}> ➡️ <@&${role.id}>`);

    const mock = {
      deferred: true, replied: false,
      deferUpdate: async () => {},
      editReply: interaction.editReply.bind(interaction),
      followUp: interaction.followUp.bind(interaction),
      customId: `shop_item_tab_details_${itemId}`,
      values: [String(itemId)],
      isAnySelectMenu: () => false,
      guildId: interaction.guildId,
      user: interaction.user,
      guild: interaction.guild,
      member: interaction.member,
      memberPermissions: interaction.memberPermissions
    };
    await handleEditItemSelect(mock, `✅ Role updated to **${role.name}**.`);
  } catch (error) {
    await handleInteractionError(interaction, error, 'role swap select');
  }
}

/**
 * Handles requirements multi-select submission (shop_item_reqs_select_<id>).
 * Accepts REQUIRE_BOOSTER, REQUIRE_MVP, and integer catalog item IDs.
 */
export async function handleRequirementsSelect(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  try {
    const raw = interaction.customId.slice('shop_item_reqs_select_'.length);
    let itemId = raw;
    let reqPage = 1;
    const pageMatch = raw.match(/_p(\d+)$/);
    if (pageMatch) {
      reqPage = parseInt(pageMatch[1], 10);
      itemId = raw.slice(0, raw.lastIndexOf('_p'));
    }
    const item = await getShopItem(itemId, interaction.guildId);
    if (!item) return interaction.followUp({ content: '❌ Item not found.', flags: MessageFlags.Ephemeral });

    const selectedValue = interaction.values?.[0];
    if (!selectedValue) return;

    // 1. Navigation handling (flips page immediately on click)
    if (selectedValue.startsWith('nav_req_page_')) {
      const targetPage = parseInt(selectedValue.slice('nav_req_page_'.length), 10) || 1;
      const mock = {
        deferred: true, replied: false,
        deferUpdate: async () => {},
        editReply: interaction.editReply.bind(interaction),
        followUp: interaction.followUp.bind(interaction),
        customId: `shop_item_reqpage_${itemId}_p${targetPage}`,
        values: [String(itemId)],
        isAnySelectMenu: () => false,
        guildId: interaction.guildId,
        user: interaction.user,
        guild: interaction.guild,
        member: interaction.member,
        memberPermissions: interaction.memberPermissions
      };
      return await handleEditItemSelect(mock, null);
    }

    // 2. Existing requirements normalization
    let reqItems = item.required_items;
    if (typeof reqItems === 'string') {
      try { reqItems = JSON.parse(reqItems); } catch (e) { reqItems = []; }
    }
    const normalizedReqs = (reqItems || []).map(r => {
      if (r === 'REQUIRE_BOOSTER' || (typeof r === 'string' && r.startsWith('booster:'))) return 'REQUIRE_BOOSTER';
      if (r === 'REQUIRE_MVP' || (typeof r === 'string' && r.startsWith('mvp:'))) return 'REQUIRE_MVP';
      const parsed = parseInt(r, 10);
      return isNaN(parsed) ? null : parsed;
    }).filter(r => r !== null);

    let newReqs = [...normalizedReqs];

    // 3. Clear All
    if (selectedValue === 'clear_all_reqs') {
      newReqs = [];
    }
    // 4. Toggle Booster
    else if (selectedValue === 'toggle_booster' || selectedValue === 'REQUIRE_BOOSTER') {
      if (newReqs.includes('REQUIRE_BOOSTER')) {
        newReqs = newReqs.filter(r => r !== 'REQUIRE_BOOSTER');
      } else {
        newReqs.push('REQUIRE_BOOSTER');
      }
    }
    // 5. Toggle MVP
    else if (selectedValue === 'toggle_mvp' || selectedValue === 'REQUIRE_MVP') {
      if (newReqs.includes('REQUIRE_MVP')) {
        newReqs = newReqs.filter(r => r !== 'REQUIRE_MVP');
      } else {
        newReqs.push('REQUIRE_MVP');
      }
    }
    // 6. Toggle Catalog Item
    else {
      const cleanVal = selectedValue.startsWith('item_') ? selectedValue.slice('item_'.length) : selectedValue;
      const numId = parseInt(cleanVal, 10);
      if (!isNaN(numId)) {
        if (newReqs.some(r => String(r) === String(numId))) {
          newReqs = newReqs.filter(r => String(r) !== String(numId));
        } else {
          newReqs.push(numId);
        }
      }
    }

    const oldItem = { ...item };
    await updateShopItem(itemId, { required_items: newReqs }, interaction.guildId);

    const diff = formatDiff(oldItem, { ...oldItem, required_items: newReqs }, ['id', 'guild_id', 'created_at', 'updated_at']);
    if (diff) {
      sendLog(interaction.guild, 'shop', 'blue', '❗ Item Requirements Updated',
        `Admin <@${interaction.user.id}> updated requirements for **${item.name}** (ID: ${itemId})\n${diff}`);
    }

    const mock = {
      deferred: true, replied: false,
      deferUpdate: async () => {},
      editReply: interaction.editReply.bind(interaction),
      followUp: interaction.followUp.bind(interaction),
      customId: `shop_item_reqpage_${itemId}_p${reqPage}`,
      values: [String(itemId)],
      isAnySelectMenu: () => false,
      guildId: interaction.guildId,
      user: interaction.user,
      guild: interaction.guild,
      member: interaction.member,
      memberPermissions: interaction.memberPermissions
    };
    await handleEditItemSelect(mock, null);
  } catch (error) {
    await handleInteractionError(interaction, error, 'requirements select');
  }
}

/**
 * Opens the Appearance modal (shop_item_appearance_btn_<id>).
 * Fields: Name, Image (file upload), Color hex.
 */
export async function handleOpenAppearanceModal(interaction) {
  try {
    const itemId = interaction.customId.slice('shop_item_appearance_btn_'.length);
    const item = await getShopItem(itemId, interaction.guildId);
    if (!item) return interaction.followUp({ content: '❌ Item not found.', flags: MessageFlags.Ephemeral });

    const modal = new ModalBuilder()
      .setCustomId(`shop_item_modal_appearance_${itemId}_${Date.now()}`)
      .setTitle('Appearance');

    const nameInput = new TextInputBuilder()
      .setCustomId('item_name')
      .setStyle(TextInputStyle.Short)
      .setValue(item.name || '')
      .setRequired(true);
    const nameLabel = new LabelBuilder().setLabel('Name').setTextInputComponent(nameInput);

    const imageUpload = new FileUploadBuilder()
      .setCustomId('item_image_file')
      .setRequired(false);
    const imageLabel = new LabelBuilder()
      .setLabel('Image')
      .setDescription(formatCurrentImageDescription(item.default_image_url || item.image_url))
      .setFileUploadComponent(imageUpload);

    const colorInput = new TextInputBuilder()
      .setCustomId('item_color')
      .setStyle(TextInputStyle.Short)
      .setValue(item.color || '')
      .setPlaceholder('#FFD700')
      .setRequired(false);
    const colorLabel = new LabelBuilder().setLabel('Embed Color (Hex)').setTextInputComponent(colorInput);

    modal.addLabelComponents(nameLabel, imageLabel, colorLabel);
    await interaction.showModal(modal);
  } catch (error) {
    await handleInteractionError(interaction, error, 'open appearance modal');
  }
}

/**
 * Handles Appearance modal submission (shop_item_modal_appearance_<id>_<ts>).
 */
export async function handleAppearanceModalSubmit(interaction) {
  try {
    await interaction.deferUpdate();
    // customId: shop_item_modal_appearance_<id>_<timestamp>
    const parts = interaction.customId.split('_');
    // parts: ['shop','item','modal','appearance','<id>','<ts>']
    const itemId = parts[4];
    const item = await getShopItem(itemId, interaction.guildId);
    if (!item) return interaction.followUp({ content: '❌ Item not found.', flags: MessageFlags.Ephemeral });

    const updates = {};
    const oldItem = { ...item };

    // Name
    const name = interaction.fields.getTextInputValue('item_name')?.trim();
    if (name) updates.name = name;

    // Image upload
    try {
      const uploadedFiles = interaction.fields.getUploadedFiles?.('item_image_file');
      const uploadedFile = uploadedFiles?.first?.() || (Array.isArray(uploadedFiles) ? uploadedFiles[0] : null);
      if (uploadedFile) {
        const uploadRes = await uploadHostAsset(interaction.client, 'items', interaction.guild, uploadedFile, {
          filename: uploadedFile.name,
          label: `🖼️ Item Asset: **${name || item.name}**`
        });
        updates.default_image_url = uploadRes.url;
      }
    } catch (err) {
      sysError('Failed to upload host asset for item appearance', err);
    }

    // Color hex
    const rawColor = interaction.fields.getTextInputValue('item_color')?.trim() ?? '';
    if (rawColor === '' || rawColor.toLowerCase() === 'none' || rawColor.toLowerCase() === 'clear') {
      updates.color = null;
    } else if (/^#?[0-9A-Fa-f]{6}$/.test(rawColor)) {
      updates.color = rawColor.startsWith('#') ? rawColor : `#${rawColor}`;
    } else if (rawColor !== '') {
      return interaction.followUp({ content: '❌ Invalid color. Enter a valid hex like `#FF5733` or leave empty to use rarity color.', flags: MessageFlags.Ephemeral });
    }

    if (Object.keys(updates).length === 0) {
      return interaction.followUp({ content: '⚠️ No changes detected.', flags: MessageFlags.Ephemeral });
    }

    await updateShopItem(itemId, updates, interaction.guildId);
    const updatedItem = await getShopItem(itemId, interaction.guildId);
    const diff = formatDiff(oldItem, updatedItem, ['id', 'guild_id', 'created_at', 'updated_at']);
    if (diff) {
      sendLog(interaction.guild, 'shop', 'blue', '🎨 Item Appearance Updated',
        `Admin <@${interaction.user.id}> updated appearance of **${updatedItem.name}** (ID: ${itemId})\n${diff}`);
    }

    // Re-render Details tab
    const mock = {
      deferred: true, replied: false,
      deferUpdate: async () => {},
      editReply: interaction.editReply.bind(interaction),
      followUp: interaction.followUp.bind(interaction),
      customId: `shop_item_tab_details_${itemId}`,
      values: [String(itemId)],
      isAnySelectMenu: () => false,
      guildId: interaction.guildId,
      user: interaction.user,
      guild: interaction.guild,
      member: interaction.member,
      memberPermissions: interaction.memberPermissions
    };
    await handleEditItemSelect(mock, `✅ Appearance updated for **${updatedItem.name}**.`);
  } catch (error) {
    await handleInteractionError(interaction, error, 'appearance modal submit');
  }
}

/**
 * Opens the Duration modal (shop_item_duration_btn_<id>).
 */
export async function handleOpenDurationModal(interaction) {
  try {
    const itemId = interaction.customId.slice('shop_item_duration_btn_'.length);
    const item = await getShopItem(itemId, interaction.guildId);
    if (!item) return interaction.followUp({ content: '❌ Item not found.', flags: MessageFlags.Ephemeral });

    const currentDays = item.duration_seconds ? String(Math.floor(item.duration_seconds / 86400)) : '';

    const modal = new ModalBuilder()
      .setCustomId(`shop_item_modal_duration_${itemId}_${Date.now()}`)
      .setTitle('Item Duration');

    const durInput = new TextInputBuilder()
      .setCustomId('item_duration')
      .setStyle(TextInputStyle.Short)
      .setValue(currentDays)
      .setPlaceholder('Permanent')
      .setRequired(false);
    const durLabel = new LabelBuilder().setLabel('Duration (Days)').setTextInputComponent(durInput);

    modal.addLabelComponents(durLabel);
    await interaction.showModal(modal);
  } catch (error) {
    await handleInteractionError(interaction, error, 'open duration modal');
  }
}

/**
 * Handles Duration modal submission (shop_item_modal_duration_<id>_<ts>).
 */
export async function handleDurationModalSubmit(interaction) {
  try {
    await interaction.deferUpdate();
    // customId: shop_item_modal_duration_<id>_<timestamp>
    const parts = interaction.customId.split('_');
    const itemId = parts[4];
    const item = await getShopItem(itemId, interaction.guildId);
    if (!item) return interaction.followUp({ content: '❌ Item not found.', flags: MessageFlags.Ephemeral });

    const rawDays = interaction.fields.getTextInputValue('item_duration')?.trim() ?? '';
    let durationSeconds = null;
    if (rawDays !== '' && rawDays.toLowerCase() !== 'permanent' && rawDays.toLowerCase() !== 'perm') {
      const days = parseInt(rawDays, 10);
      if (isNaN(days) || days < 0) {
        return interaction.followUp({ content: '❌ Invalid duration. Enter a positive number of days or leave empty for permanent.', flags: MessageFlags.Ephemeral });
      }
      if (days > 0) durationSeconds = days * 86400;
    }

    await updateShopItem(itemId, { duration_seconds: durationSeconds }, interaction.guildId);
    const durationLabel = durationSeconds ? `${Math.floor(durationSeconds / 86400)} Days` : 'Permanent';
    sendLog(interaction.guild, 'shop', 'blue', '⏱️ Item Duration Updated',
      `Admin <@${interaction.user.id}> set duration of **${item.name}** to **${durationLabel}**`);

    const mock = {
      deferred: true, replied: false,
      deferUpdate: async () => {},
      editReply: interaction.editReply.bind(interaction),
      followUp: interaction.followUp.bind(interaction),
      customId: `shop_item_tab_config_${itemId}`,
      values: [String(itemId)],
      isAnySelectMenu: () => false,
      guildId: interaction.guildId,
      user: interaction.user,
      guild: interaction.guild,
      member: interaction.member,
      memberPermissions: interaction.memberPermissions
    };
    await handleEditItemSelect(mock, `✅ Duration set to **${durationLabel}**.`);
  } catch (error) {
    await handleInteractionError(interaction, error, 'duration modal submit');
  }
}

/**
 * Toggles is_tradable for an item (shop_item_toggle_lock_<id>).
 */
export async function handleToggleItemLock(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  try {
    const itemId = interaction.customId.slice('shop_item_toggle_lock_'.length);
    const item = await getShopItem(itemId, interaction.guildId);
    if (!item) return interaction.followUp({ content: '❌ Item not found.', flags: MessageFlags.Ephemeral });

    const newTradable = !item.is_tradable;
    await updateShopItem(itemId, { is_tradable: newTradable }, interaction.guildId);
    const label = newTradable ? 'Tradable' : 'UnTradable';
    sendLog(interaction.guild, 'shop', 'blue', '🔄 Item Trade Status Toggled',
      `Admin <@${interaction.user.id}> set **${item.name}** to **${label}**`);

    const mock = {
      deferred: true, replied: false,
      deferUpdate: async () => {},
      editReply: interaction.editReply.bind(interaction),
      followUp: interaction.followUp.bind(interaction),
      customId: `shop_item_tab_config_${itemId}`,
      values: [String(itemId)],
      isAnySelectMenu: () => false,
      guildId: interaction.guildId,
      user: interaction.user,
      guild: interaction.guild,
      member: interaction.member,
      memberPermissions: interaction.memberPermissions
    };
    await handleEditItemSelect(mock, null);
  } catch (error) {
    await handleInteractionError(interaction, error, 'toggle item lock');
  }
}

export async function handleCreatePackStart(interaction) {
  return openCreatePackModal(interaction);
}

export async function openCreatePackModal(interaction) {
  const modal = new ModalBuilder()
    .setCustomId(`shop_item_modal_add_new_pack_${Date.now()}`)
    .setTitle('Create Item Pack');

  const nameInput = new TextInputBuilder()
    .setCustomId('item_name')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const nameLabel = new LabelBuilder()
    .setLabel('Name')
    .setTextInputComponent(nameInput);

  modal.addLabelComponents(nameLabel);
  await interaction.showModal(modal);
  await refreshShopSetupMessage(interaction);
}

// Backwards-compat alias — only for packs now
export async function openCreateItemModal(interaction, type) {
  if (type === 'pack') {
    return openCreatePackModal(interaction);
  }
  // Item creation goes through the new tab-based flow — redirect to start
  return handleCreateItemStart(interaction);
}

export async function handleAddTypeSelect(interaction) {
  const type = interaction.customId.split('_').pop(); // item, pack, cat
  if (type === 'cat') {
    return handleCreateCategory(interaction);
  }
  return openCreateItemModal(interaction, type);
}

/**
 * Helper to resolve prerequisite IDs from a raw string input.
 * Supports: Database IDs (numbers), Role Mentions (<@&ID>), and Role Snowflakes (18+ digits)
 */
/**
 * Helper to resolve prerequisite IDs from a raw string input.
 * Supports: Database IDs (numbers), Role Mentions (<@&ID>), Role Snowflakes (18+ digits), and "booster:ID" markers.
 * Returns: { resolved: array, errors: array, hasBooster: boolean }
 */
async function resolvePrerequisiteIds(guild, rawInput, currentItemId = null) {
  if (!rawInput || rawInput.trim().toLowerCase() === 'none' || rawInput.trim() === '') {
    return { resolved: [], errors: [], hasBooster: false, hasMvp: false };
  }

  const guildConfig = await getGuildConfig(guild.id);
  const mvpRoleId = guildConfig?.mvpRoleId;

  const segments = rawInput.split(/[,\s-]+/).filter(s => s.trim().length > 0);
  const allItems = await getShopItems(guild.id, null, 'name', true);
  const boosterRoleId = guild.roles.premiumSubscriberRole?.id;
  
  const resolvedIds = new Set();
  const errors = [];
  let hasBooster = false;
  let hasMvp = false;

  for (const seg of segments) {
    // 1. Check for existing "booster:ID" marker (from re-saves)
    if (seg.startsWith('booster:')) {
      const bId = seg.split(':')[1];
      if (bId === boosterRoleId) {
        resolvedIds.add(seg);
        hasBooster = true;
        continue;
      }
    }

    // 1.5 Check for existing "mvp:ID" marker
    if (seg.startsWith('mvp:')) {
      resolvedIds.add(seg);
      hasMvp = true;
      continue;
    }

    // Extract Snowflake or Numeric ID
    const idMatch = seg.match(/\d+/);
    if (!idMatch) {
      errors.push(seg);
      continue;
    }
    const cleanId = idMatch[0];

    // 2. Check if it's the Booster Role ID
    if (boosterRoleId && cleanId === boosterRoleId) {
      resolvedIds.add(`booster:${cleanId}`);
      hasBooster = true;
      continue;
    }

    // 2.5 Check if it's the MVP Role ID
    if (mvpRoleId && cleanId === mvpRoleId) {
      resolvedIds.add(`mvp:${cleanId}`);
      hasMvp = true;
      continue;
    }

    let found = false;

    // 3. Check if it's a Database ID (Up to 10 digitsUsually safe for serials)
    if (cleanId.length <= 10) {
      const dbId = parseInt(cleanId, 10);
      const exists = allItems.find(i => i.id === dbId);
      if (exists && dbId !== Number(currentItemId)) {
        resolvedIds.add(dbId);
        found = true;
      }
    }

    if (found) continue;

    // 4. Check if it's a Role Snowflake matching a Shop Item
    if (cleanId.length >= 17) {
      const match = allItems.find(i => i.role_id && i.role_id.split(/[,\s-]+/).includes(cleanId));
      if (match && match.id !== Number(currentItemId)) {
        resolvedIds.add(match.id);
        found = true;
      }
    }

    if (!found) {
      errors.push(cleanId);
    }
  }

  return { 
    resolved: [...resolvedIds], 
    errors, 
    hasBooster,
    hasMvp
  };
}

export async function handleItemModalSubmit(interaction) {
  try {
    await interaction.deferUpdate();

    // ID Format Patterns:
    // 1. shop_item_modal_{add|edit}_{param}_{type} (Old/Legacy/Add flow)
    // 2. shop_pack_modal_edit_{id} (New Pack dedicated flow)
    const customId = interaction.customId;
    let itemId, type, action;

    if (customId.startsWith('shop_pack_modal_edit_')) {
      itemId = customId.split('_').pop();
      type = 'pack';
      action = 'edit';
    } else {
      const parts = customId.split('_');
      action = parts[3]; // add or edit
      itemId = parts[4]; // new or numeric id
      type = parts[5] || 'item'; // item or pack
    }

    const name = interaction.fields.getTextInputValue('item_name');

    // Price is only read for PACKS (items no longer have a price field in the modal)
    // Item price is set at post-time via the Post panel.

    if (action === 'add') {
      // ========== ADD FLOW ==========
      if (type === 'item') {
        // Item creation now goes through the new unified role-picker flow.
        // This branch is only reached if somehow the old modal is submitted — redirect to shop setup.
        await interaction.followUp({ content: '❌ Item creation via text modal is no longer supported. Please use "Create Item" from the Shop menu.', flags: MessageFlags.Ephemeral });
        return handleShopSetup(interaction);
      } else if (type === 'pack') {
        // Packs price is set at post time (default to 0 if not provided)
        await addShopItem(interaction.guildId, null, '', name, '', 0, null, null, 'pack');
        sendLog(interaction.guild, 'shop', 'green', '📦 Pack Created', `Admin **<@${interaction.user.id}>** created pack **${name}** (Price: Unset — must be set at post time)`);
        await interaction.followUp({ content: `✅ Pack items created!`, flags: MessageFlags.Ephemeral });
        await handleShopSetup(interaction);
      }
    } else if (action === 'edit') {
      // ========== EDIT FLOW ==========
      const oldItem = await getShopItem(itemId, interaction.guildId);
      if (!oldItem) return interaction.followUp({ content: '❌ Item not found.', flags: MessageFlags.Ephemeral });

      let updates = { name };
      let reqValidation = { resolved: [], errors: [], hasBooster: false, hasMvp: false };

      if (type === 'item') {
        const roleId = interaction.fields.getTextInputValue('item_role').trim();
        const durationRaw = interaction.fields.getTextInputValue('item_duration').trim();
        // Read image from upload field or URL fallback
        try {
          const uploadedFiles = interaction.fields.getUploadedFiles?.('item_image_file');
          const uploadedFile = uploadedFiles?.first?.() || (Array.isArray(uploadedFiles) ? uploadedFiles[0] : null);
          if (uploadedFile) {
            const uploadRes = await uploadHostAsset(interaction.client, 'items', interaction.guild, uploadedFile, {
              filename: uploadedFile.name,
              label: `🖼️ Item Asset: **${name}**`
            });
            updates.default_image_url = uploadRes.url;
          } else {
            const rawImg = interaction.fields.getTextInputValue?.('item_image_url')?.trim?.();
            if (rawImg !== undefined) {
              if (rawImg === '' || rawImg.toLowerCase() === 'none' || rawImg.toLowerCase() === 'clear') {
                updates.default_image_url = null;
              } else if (rawImg) {
                updates.default_image_url = rawImg;
              }
            }
          }
        } catch (e) {
          sysError('Failed to upload host asset for item', e);
        }

        if (roleId && roleId.toLowerCase() !== 'none') {
          // Block Booster Role as main Item Role
          const boosterRoleId = interaction.guild.roles.premiumSubscriberRole?.id;
          if (boosterRoleId && roleId === boosterRoleId) {
            return interaction.followUp({ content: "❌ Server Booster Role can't be a shop item. Enter it in the Requirements field instead to make Boosters only items.", flags: MessageFlags.Ephemeral });
          }

          // Block MVP Role as main Item Role
          const guildConfig = await getGuildConfig(interaction.guildId);
          if (guildConfig && guildConfig.mvpRoleId === roleId) {
            return interaction.followUp({ content: "❌ MVP Role can't be a shop item. Enter it in the Requirements field to make MVP only items.", flags: MessageFlags.Ephemeral });
          }

          const editTargetRoleId = roleId.split(/[,\s]+/)[0];
          const editTargetRole = interaction.guild.roles.cache.get(editTargetRoleId);
          if (!editTargetRole) {
            return interaction.followUp({ content: '❌ Invalid Role ID.', flags: MessageFlags.Ephemeral });
          }
          if (hasAnyDangerousPermission(editTargetRole)) {
            return interaction.followUp({
              content: '❌ **Security Violation**: This role holds administrative or moderation permissions (such as Administrator, Manage Server, Manage Roles, or Ban/Kick Members) and cannot be linked to a shop item.',
              flags: MessageFlags.Ephemeral
            });
          }
          updates.role_id = roleId;
        }

        {
          const days = parseInt(durationRaw, 10);
          updates.duration_seconds = (durationRaw === '' || isNaN(days) || days === 0) ? null : days * 86400;
        }

        try {
          const reqRaw = interaction.fields.getTextInputValue('item_required');
          if (reqRaw !== undefined) {
             reqValidation = await resolvePrerequisiteIds(interaction.guild, reqRaw, itemId);
             
             if (reqValidation.errors.length > 0) {
              return interaction.followUp({ 
                content: `❌ Role(s) **${reqValidation.errors.join(', ')}** are not connected to any item in the shop.\nItems must be created in the shop first before they can be used as a requirement.`, 
                flags: MessageFlags.Ephemeral 
              });
            }
            updates.required_items = reqValidation.resolved;
          }
        } catch (e) {
          sysError('Shop Admin Failure', e, { guild: interaction.guildId, detail: 'Resolving prerequisites during edit' });
        }
      } else if (type === 'pack') {
        // Pack price is set at post time
        updates.item_type = 'pack';
        updates.is_pack = true;
      }

      await updateShopItem(itemId, updates, interaction.guildId);
      const updatedRecord = await getShopItem(itemId, interaction.guildId);

      // Smart Diff: Exclude internal IDs and timestamps
      const diff = formatDiff(oldItem, updatedRecord, ['id', 'guild_id', 'created_at', 'updated_at', 'item_type', 'is_pack', 'category_id']);
      
      if (diff) {
        sendLog(interaction.guild, 'shop', 'blue', type === 'pack' ? '📦 Pack Updated' : '⚙️ Item Updated', `Admin **<@${interaction.user.id}>** updated **${name}** (ID: ${itemId})\n${diff}`);
      }

      const mock = {
        deferred: true, replied: false,
        deferUpdate: async () => {},
        editReply: interaction.editReply.bind(interaction),
        followUp: interaction.followUp.bind(interaction),
        customId: type === 'pack' ? `shop_pack_manage_${itemId}` : `shop_item_edit_${itemId}`,
        values: [String(itemId)],
        isAnySelectMenu: () => true,
        guildId: interaction.guildId,
        user: interaction.user,
        guild: interaction.guild,
        member: interaction.member,
        memberPermissions: interaction.memberPermissions
      };
      
      let successMsg = `✅ Item **${name}** updated!`;
      if (reqValidation.hasBooster) {
        successMsg += `\n🚀 **Booster Requirement Linked:** This item will now require an active Server Boost to buy/equip.`;
      }
      if (reqValidation.hasMvp) {
        successMsg += `\n🏆 **MVP Requirement Linked:** This item will now require the user to be the active Server MVP.`;
      }
      
      if (type === 'pack') await handleEditPackSelect(mock, `✅ Pack **${name}** updated!`);
      else await handleEditItemSelect(mock, successMsg);
    }
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop item/pack modal submit');
  }
}

export async function handleManageItemCategorySelect(interaction) {
  await interaction.deferUpdate();
  const itemId = interaction.customId.split('_').pop();
  const categoryId = interaction.values[0] === 'null' ? null : parseInt(interaction.values[0]);
  const isFromEditFlow = interaction.customId.includes('_manage_');

  const item = await getShopItem(itemId, interaction.guildId);
  const oldCatId = item?.category_id;
  const oldCatName = oldCatId ? (await query('SELECT name FROM shop_categories WHERE id = $1 AND guild_id = $2', [oldCatId, interaction.guildId])).rows[0]?.name : 'None';
  
  await updateShopItem(itemId, { category_id: categoryId }, interaction.guildId);

  // Standardized Shop Admin Log
  const catName = categoryId ? (await query('SELECT name FROM shop_categories WHERE id = $1 AND guild_id = $2', [categoryId, interaction.guildId])).rows[0]?.name : 'None';
  sendLog(interaction.guild, 'shop', 'blue', '📂 Category Changed', `Admin **<@${interaction.user.id}>** moved item **${item?.name || itemId}**.\n**Category:** ${oldCatName} ➡️ ${catName}`);


  if (isFromEditFlow) {
    const mock = {
      deferred: true, replied: false,
      deferUpdate: async () => { },
      editReply: interaction.editReply.bind(interaction),
      followUp: interaction.followUp.bind(interaction),
      customId: `shop_item_edit_${itemId}`,
      values: [String(itemId)],
      isAnySelectMenu: () => true,
      guildId: interaction.guildId,
      user: interaction.user,
      guild: interaction.guild,
      member: interaction.member,
      memberPermissions: interaction.memberPermissions
    };
    const message = categoryId ? `✅ Moved to category **${catName}**.` : '✅ Removed from category.';
    await handleEditItemSelect(mock, message);
  } else {
    // Called from Add Item flow - return to Add Menu
    const message = categoryId ? '✅ Item added to category.' : '✅ Item created.';
    await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral });
    await handleShopAdminAdd(interaction);
  }
}

// Old function name, kept just in case but redirects to new logic if called
export async function handleAssignCategorySelect(interaction) {
  await handleManageItemCategorySelect(interaction);
}

// ============================================================
// NEW ITEM ATTRIBUTE HANDLERS (Item Created panel - no auto-save)
// ============================================================

export function getTradableOptions(lootBoxName = 'loot boxes') {
  const name = (lootBoxName && lootBoxName.trim().length > 0) ? lootBoxName.trim() : 'Loot Boxes';
  return [
    { label: 'Unlocked', value: 'tradable',   emoji: '🔓', description: `Can be traded, dropped, or found in ${name.toLowerCase()}` },
    { label: 'Locked',   value: 'untradable', emoji: '🔒', description: `Cannot be traded, dropped, or found in ${name.toLowerCase()}` }
  ];
}

/**
 * @deprecated Legacy draft panel handler — item creation now goes through the role picker directly.
 * Kept as a no-op export so existing handler routes don't throw import errors.
 */
export async function handleNewItemAttrSelect(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  return interaction.followUp({ content: '❌ This panel is no longer in use. Please create a new item from the Shop menu.', flags: MessageFlags.Ephemeral });
}

/**
 * @deprecated Legacy cancel handler — kept for compatibility.
 */
export async function handleNewItemCancel(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  await handleShopSetup(interaction);
}

/**
 * @deprecated Legacy save handler — kept for compatibility.
 */
export async function handleNewItemSave(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  return interaction.followUp({ content: '❌ This action is no longer available. Please create a new item from the Shop menu.', flags: MessageFlags.Ephemeral });
}



export function parseIntervalStringToSeconds(input) {
  if (!input || typeof input !== 'string') return null;
  const match = input.trim().toLowerCase().match(/^(\d+)\s*([mhd])$/);
  if (!match) return null;
  const count = parseInt(match[1], 10);
  if (isNaN(count) || count <= 0) return null;
  const unit = match[2];
  let seconds = 0;
  if (unit === 'm') seconds = count * 60;
  else if (unit === 'h') seconds = count * 3600;
  else if (unit === 'd') seconds = count * 86400;

  if (seconds < 300 || seconds > 2592000) return null;
  return seconds;
}

export function formatSecondsToIntervalString(seconds) {
  if (!seconds || typeof seconds !== 'number' || seconds <= 0) return '';
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${Math.floor(seconds / 60)}m`;
}

export function formatIntervalHuman(seconds) {
  if (!seconds || typeof seconds !== 'number' || seconds <= 0) return null;
  if (seconds % 86400 === 0) {
    const d = seconds / 86400;
    return `${d} ${d === 1 ? 'Day' : 'Days'}`;
  }
  if (seconds % 3600 === 0) {
    const h = seconds / 3600;
    return `${h} ${h === 1 ? 'Hour' : 'Hours'}`;
  }
  const m = Math.floor(seconds / 60);
  return `${m} ${m === 1 ? 'Minute' : 'Minutes'}`;
}

// Updated Post Item Handlers - Staging Panel
export async function handleShopPostStart(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

  const sessionId = getPostSessionId(interaction);
  const guildId = interaction.guildId;

  // Fetch ALL items/packs
  const items = await getShopItems(guildId, null, 'name', true);

  if (items.length === 0) {
    const emptyRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`shop_admin_home:${sessionId}`).setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary)
    );
    const emptyEmbed = new EmbedBuilder().setColor('#95A5A6').setDescription('No items found.');
    return interaction.editReply({ files: [], attachments: [], content: null, embeds: [emptyEmbed], components: [emptyRow] });
  }

  // Get current pending state or initialize
  let state = (await getPendingPostSession(sessionId)) || {};
  
  // Enforce defaults for missing keys (critical for Post-Publish re-render)
  state.itemId = state.itemId ?? null;
  state.channelId = state.channelId || interaction.channelId;
  state.sellerId = state.sellerId ?? null;
  state.imageUrl = state.imageUrl ?? null;
  state.description = state.description ?? null;
  state.payout = state.payout ?? null;
  state.stock = state.stock ?? null;
  state.overridePrice = state.overridePrice ?? 0;
  state.postStep = (state.postStep === undefined || state.postStep === null) ? 0 : state.postStep;
  state.postFilter = state.postFilter ?? null;
  state.isEditing = state.isEditing ?? false;
  state.stockConfigured = state.stockConfigured ?? false;
  state.postMode = (state.postMode === 'drop') ? 'drop' : 'normal';
  state.autoEquip = state.autoEquip ?? false;
  state.claimLimit = state.claimLimit ?? null;
  state.restockIntervalSeconds = (state.restockIntervalSeconds && state.restockIntervalSeconds > 0) ? state.restockIntervalSeconds : null;
  state.maxStock = state.maxStock ?? null;

  await setPendingPostSession(sessionId, state);

  // Build embed with current selections
  let selectedItem = state.itemId ? items.find(i => String(i.id) === String(state.itemId)) : null;
  if (!selectedItem && state.itemId) {
    try {
      selectedItem = await getShopItem(state.itemId, guildId);
    } catch (_) {}
  }
  const isPack = selectedItem && (selectedItem.item_type === 'pack' || selectedItem.is_pack);

  // Validation for button states
  const canPublish = Boolean(state.itemId && state.channelId);
  const canSetPayout = selectedItem && !isPack && state.sellerId;

  // Determine seller display
  let sellerDisplay = 'None (Default)';
  if (isPack) {
    sellerDisplay = 'Server';
  } else if (state.sellerId) {
    sellerDisplay = `<@${state.sellerId}>`;
  }

  // Determine payout display (just the amount, no percentage)
  // Uses overridePrice (the post-time price) since item.price may be NULL
  let payoutDisplay = 'N/A';
  if (!isPack && state.sellerId) {
    const payoutAmount = (state.payout !== null && state.payout !== undefined) ? state.payout : 0;
    payoutDisplay = payoutAmount.toString();
  }

  let panelTitle = 'Posting an item';
  if (state.isEditing) {
    panelTitle = selectedItem ? `Editing ${selectedItem.name}` : 'Editing an item';
  } else if (selectedItem) {
    panelTitle = `Posting ${selectedItem.name}`;
  }

  const embed = new EmbedBuilder()
    .setTitle(panelTitle)
    .setColor(0x9B59B6);

  // Show item image as small thumbnail preview in the staging embed
  if (selectedItem) {
    const defaultImg = await resolveItemDefaultImage(selectedItem, guildId);
    let previewImg = state.imageUrl || defaultImg;
    if (previewImg) embed.setThumbnail(previewImg);
  }

  // Prioritized status description
  let statusDesc = '';
  if (selectedItem) {
    const coinName = await getCurrencyName(guildId);
    const coinEmoji = await getCurrencyEmoji(guildId);

    // Only use role mention for single items with a valid Discord snowflake role ID (not packs, not chests)
    const isPackItem = selectedItem && (selectedItem.item_type === 'pack' || selectedItem.is_pack);
    const isChestItem = selectedItem && (selectedItem.item_type === 'loot_box' || Boolean(selectedItem.loot_box_id));
    const hasNumericRole = selectedItem.role_id && /^\d{17,20}$/.test(String(selectedItem.role_id));
    const targetMention = (!isPackItem && !isChestItem && hasNumericRole) ? `<@&${selectedItem.role_id}>` : `**${selectedItem.name}**`;

    const priceVal = (state.overridePrice !== null && state.overridePrice !== undefined)
      ? Number(state.overridePrice)
      : (selectedItem.price ?? 0);
    const priceDisplay = priceVal > 0
      ? `\`${priceVal.toLocaleString()}\` ${coinName} ${coinEmoji}`
      : '`Free`';

    const stockStr = (state.stock !== null && state.stock !== undefined && state.stock > 0)
      ? `\`${state.stock.toLocaleString()}\` ${state.stock === 1 ? 'Stock' : 'Stocks'}`
      : '`Unlimited` Stocks';

    const intervalLabel = formatIntervalHuman(state.restockIntervalSeconds);
    const timerStr = intervalLabel ? `Every \`${intervalLabel}\`` : '`No Restock` Timer';

    const claimStr = (state.claimLimit !== null && state.claimLimit !== undefined && state.claimLimit > 0)
      ? `• \`${state.claimLimit.toLocaleString()}\` Per User`
      : '• `No limit` per user';

    const bullet1 = `• Post ${targetMention} for ${priceDisplay}`;
    const bullet2 = `• ${stockStr} • ${timerStr}`;
    const bullet3 = claimStr;

    statusDesc = `${bullet1}\n${bullet2}\n${bullet3}`;

    if (state.description) {
      statusDesc += `\n\n> ${state.description.replace(/\n/g, '\n> ')}`;
    }

    if (!state.isEditing && !state.channelId) {
      statusDesc += '\n\n⚠️ *Set a channel to publish*';
    }
  } else {
    statusDesc = '⚠️ Set Item';
  }

  embed.setDescription(statusDesc || null);

  // --- Item Navigation Wizard ---
  const categories = await getShopCategories(guildId);
  const itemsAll = await getShopItems(guildId, null, 'name', false); // Post flow: Active items only
  const lootBoxCatName = await getLootBoxCategoryName(guildId);
  const lootBoxEmoji = await getLootBoxCategoryEmoji(guildId);
  
  let itemOptions = [];
  let placeholder = '📦 Select Item/Pack (Required)';
  let itemSelect = null;

  if (!state.isEditing) {
    if (state.postStep === 0) {
      const hasCategorized = itemsAll.some(i => i.category_id && !i.is_pack && i.item_type !== 'pack' && i.item_type !== 'loot_box');
      const hasUncategorized = itemsAll.some(i => !i.category_id && !i.is_pack && i.item_type !== 'pack' && i.item_type !== 'loot_box');
      const hasPacks = itemsAll.some(i => i.is_pack || i.item_type === 'pack');
      const hasLootBoxes = itemsAll.some(i => i.item_type === 'loot_box');

      if (hasCategorized) itemOptions.push({ label: 'Categorized Items', value: 'folder_categorized', emoji: '📂' });
      if (hasUncategorized) itemOptions.push({ label: 'Uncategorized Items', value: 'folder_standalone', emoji: '🏷️' });
      if (hasPacks) itemOptions.push({ label: 'Item Packs', value: 'folder_packs', emoji: '📦' });
      if (hasLootBoxes) itemOptions.push({ label: lootBoxCatName.slice(0, 50), value: 'folder_loot_boxes', emoji: parseSelectEmoji(lootBoxEmoji) });
      placeholder = '📦 Select Item/Pack/Box (Required)';
      
      // If an item is already selected, show it as a quick-pick at the top
      if (selectedItem) {
        itemOptions.unshift({
          label: `Staged: ${selectedItem.name.slice(0, 50)}`,
          value: selectedItem.id.toString(),
          emoji: '✅',
          default: true
        });
      }
    } 
    else if (state.postStep === 1) {
      // Category Folder List - Hide Empty Folders
      const usedCategoryIds = new Set(itemsAll.filter(i => !i.is_pack && i.item_type !== 'pack' && i.item_type !== 'loot_box' && i.category_id).map(i => i.category_id));
      const activeCategories = categories.filter(c => usedCategoryIds.has(c.id));

      const page = state.postPage || 1;
      const { selectMenu } = buildPaginatedSelectMenu({
        items: activeCategories,
        page,
        customId: `shop_post_item_select:${sessionId}`,
        placeholder: '📂 Choose Category Folder...',
        backOption: {
          label: 'Back',
          value: 'folder_reset',
          emoji: '⬅️'
        },
        pageNavPrefix: 'shop_post_page_',
        pageSize: 20,
        mapOption: c => ({
          label: c.name.slice(0, 100),
          value: `filter_cat_${c.id}`,
          emoji: '📂'
        })
      });

      itemSelect = !state.isEditing ? selectMenu : null;
    } 
    else if (state.postStep === 2) {
      // Final Item List (Filtered)
      let filtered = [];
      let groupPrefix = '🏷️';
      let groupName = 'Items';

      if (state.postFilter === 'standalone') {
        filtered = itemsAll.filter(i => !i.category_id && !i.is_pack && i.item_type !== 'loot_box');
        filtered = await sortItemsByRarity(filtered, interaction.guild);
        groupName = 'Uncategorized';
        groupPrefix = '🏷️';
      } else if (state.postFilter === 'packs') {
        filtered = itemsAll.filter(i => i.is_pack || i.item_type === 'pack');
        groupName = 'Packs';
        groupPrefix = '📦';
      } else if (state.postFilter === 'loot_boxes') {
        filtered = itemsAll.filter(i => i.item_type === 'loot_box');
        filtered.sort((a, b) => (parseInt(a.loot_box_id) || a.id) - (parseInt(b.loot_box_id) || b.id));
        groupName = lootBoxCatName;
        groupPrefix = lootBoxEmoji;
      } else if (state.postFilter?.startsWith('cat_')) {
        const catId = parseInt(state.postFilter.split('_').pop());
        filtered = itemsAll.filter(i => i.category_id === catId && !i.is_pack && i.item_type !== 'loot_box');
        filtered = await sortItemsByRarity(filtered, interaction.guild);
        groupName = categories.find(c => c.id === catId)?.name || 'Category';
        groupPrefix = '🏷️';
      }

      if (filtered.length === 0) {
        const backBase = (state.isEditing || state.fromGateway) ? 'shop_admin_post' : 'shop_admin_home';
        const emptyRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`${backBase}:${sessionId}`).setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary)
        );
        const emptyEmbed = new EmbedBuilder().setColor('#95A5A6').setDescription('No items found.');
        return interaction.editReply({ files: [], attachments: [], content: null, embeds: [emptyEmbed], components: [emptyRow] });
      }

      const page = state.postPage || 1;
      const displayPrefix = (groupPrefix && !groupPrefix.startsWith('<')) ? `${groupPrefix} ` : '';
      const { selectMenu } = buildPaginatedSelectMenu({
        items: filtered,
        page,
        customId: `shop_post_item_select:${sessionId}`,
        placeholder: `${displayPrefix}${groupName.slice(0, 30)}: Pick one`,
        backOption: {
          label: 'Back',
          value: state.postFilter?.startsWith('cat_') ? 'folder_categorized' : 'folder_reset',
          emoji: '⬅️'
        },
        pageNavPrefix: 'shop_post_page_',
        pageSize: 20,
        mapOption: i => ({
          label: i.name.slice(0, 100),
          value: i.id.toString(),
          emoji: (state.postFilter === 'packs' || state.postFilter === 'loot_boxes') ? parseSelectEmoji(groupPrefix) : getItemRarityEmoji(i),
          default: state.itemId === i.id.toString()
        })
      });

      itemSelect = !state.isEditing ? selectMenu : null;
    }

    // Unified Empty State Fallback for step 0
    if (state.postStep === 0 && itemOptions.length === 0) {
      const emptyBackBase = (state.isEditing || state.fromGateway) ? 'shop_admin_post' : 'shop_admin_home';
      const emptyRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${emptyBackBase}:${sessionId}`)
          .setLabel('Back')
          .setEmoji('⬅️')
          .setStyle(ButtonStyle.Secondary)
      );
      const emptyEmbed = new EmbedBuilder()
        .setColor('#95A5A6')
        .setDescription('No items found.');
      return interaction.editReply({ files: [], attachments: [], content: null, embeds: [emptyEmbed], components: [emptyRow] });
    }

    if (state.postStep === 0) {
      const placeholder = '📦 Select Item/Pack (Required)';
      itemSelect = !state.isEditing ? new StringSelectMenuBuilder()
        .setCustomId(`shop_post_item_select:${sessionId}`)
        .setPlaceholder(placeholder)
        .addOptions(itemOptions) : null;
    }
  }

  // Seller Select (User Select - Optional, disabled for packs and loot boxes)
  const isServerManaged = isPack || (selectedItem && selectedItem.item_type === 'loot_box');
  const userSelect = new UserSelectMenuBuilder()
    .setCustomId(`shop_post_seller_select:${sessionId}`)
    .setPlaceholder(isServerManaged ? '👤 Seller disabled for this type' : '👤 Select Seller (Optional)')
    .setDisabled(isServerManaged === true);
  if (state.sellerId && !isServerManaged) userSelect.setDefaultUsers([state.sellerId]);

  const isItemSelected = !!state.itemId;
  const isCustomConfigured = state.stock !== null || state.restockIntervalSeconds !== null || state.claimLimit !== null;

  const defaultImg = await resolveItemDefaultImage(selectedItem, guildId);
  const isCustomImage = Boolean(state.imageUrl && !isSameImageUrl(state.imageUrl, defaultImg));

  const isModified = state.itemId !== null || 
                     state.sellerId !== null || 
                     state.description !== null || 
                     isCustomImage || 
                     state.payout !== null || 
                     state.stock !== null || 
                     (state.overridePrice !== null && state.overridePrice !== 0) ||
                     state.claimLimit !== null ||
                     state.restockIntervalSeconds !== null ||
                     state.autoEquip !== false;

  // Row 3: Parameter & Configuration Buttons ([Appearance] [Config] [Auto Equip] [Payout])
  const paramComponents = [
    new ButtonBuilder()
      .setCustomId(`shop_post_appearance_btn:${sessionId}`)
      .setLabel('Appearance')
      .setEmoji('🖼️')
      .setStyle((state.description || isCustomImage) ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(!isItemSelected),
    new ButtonBuilder()
      .setCustomId(`shop_post_config_btn:${sessionId}`)
      .setLabel('Config')
      .setEmoji('⚙️')
      .setStyle((isCustomConfigured || (state.overridePrice !== null && state.overridePrice !== 0)) ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(!isItemSelected),
    new ButtonBuilder()
      .setCustomId(`shop_post_auto_equip_toggle:${sessionId}`)
      .setLabel('Auto Equip')
      .setEmoji('⚡')
      .setStyle(state.autoEquip ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(!isItemSelected || isServerManaged)
  ];

  // Only show the 💰 Payout button if a seller is selected, otherwise hide it (appears on the right of Auto Equip)
  if (canSetPayout && isItemSelected && !isServerManaged) {
    paramComponents.push(
      new ButtonBuilder()
        .setCustomId(`shop_post_payout_btn:${sessionId}`)
        .setLabel('Payout')
        .setEmoji('💰')
        .setStyle(state.payout ? ButtonStyle.Primary : ButtonStyle.Secondary)
    );
  }

  const configRow = new ActionRowBuilder().addComponents(paramComponents);

  // External Back button always returns directly to the parent screen (Shop Post list or Shop Admin Home)
  const backBase = (state.isEditing || state.fromGateway) ? 'shop_admin_post' : 'shop_admin_home';
  const postBackCustomId = `${backBase}:${sessionId}`;

  const confirmBtn = new ButtonBuilder()
    .setCustomId(`${state.isEditing ? 'shop_post_update' : 'shop_post_publish'}:${sessionId}`)
    .setLabel(state.isEditing ? 'Update' : 'Publish')
    .setEmoji('📤')
    .setStyle(ButtonStyle.Success);

  let canSubmit = false;
  if (state.isEditing) {
    canSubmit = true;
  } else {
    canSubmit = Boolean(state.itemId && state.channelId);
  }
  confirmBtn.setDisabled(!canSubmit);

  const actionComponents = [
    new ButtonBuilder()
      .setCustomId(postBackCustomId)
      .setLabel('Back')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary)
  ];

  if (!state.isEditing) {
    actionComponents.push(
      new ButtonBuilder()
        .setCustomId(`shop_post_reset:${sessionId}`)
        .setLabel('Reset')
        .setEmoji('🔄')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!isModified)
    );
  }

  actionComponents.push(confirmBtn);

  const actionRow = new ActionRowBuilder().addComponents(actionComponents);

  const components = [];
  if (!state.isEditing) {
    if (itemSelect) components.push(new ActionRowBuilder().addComponents(itemSelect));
  }
  components.push(new ActionRowBuilder().addComponents(userSelect));
  components.push(configRow);
  components.push(actionRow);

  await interaction.editReply({
    content: null,
    embeds: [embed],
    files: [], attachments: [],
    components: components
  });
}

export async function handleShopPostModeSelect(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
    const sessionId = getPostSessionId(interaction);
    const selectedMode = interaction.values[0];
    let state = (await getPendingPostSession(sessionId)) || {};

    if (state.postMode !== selectedMode) {
      state.postMode = selectedMode;
      if (selectedMode === 'drop') {
        state.claimLimit = state.claimLimit || 1;
        state.stockConfigured = false;
      }
    }
    await setPendingPostSession(sessionId, state);
    await handleShopPostStart(interaction);
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop post mode select');
  }
}

export async function handleShopPostAutoEquipToggle(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
    const sessionId = getPostSessionId(interaction);
    let state = (await getPendingPostSession(sessionId)) || {};
    state.autoEquip = !state.autoEquip;
    await setPendingPostSession(sessionId, state);
    await handleShopPostStart(interaction);
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop post auto equip toggle');
  }
}

export async function handleShopPostBackFolder(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
    const sessionId = getPostSessionId(interaction);
    let state = await getPendingPostSession(sessionId);
    if (!state) return handleShopPostStart(interaction);

    if (state.postStep === 2) {
      state.postStep = state.postFilter?.startsWith('cat_') ? 1 : 0;
      state.postPage = 1;
    } else if (state.postStep === 1) {
      state.postStep = 0;
      state.postPage = 1;
    }
    await setPendingPostSession(sessionId, state);
    return handleShopPostStart(interaction);
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop post back folder');
  }
}

// Handle Item Selection in Staging Panel
export async function handleShopPostItemSelect(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
  const sessionId = getPostSessionId(interaction);
  const itemId = interaction.values[0];
  let state = await getPendingPostSession(sessionId);
  if (!state) {
    state = {
      itemId: null, channelId: null, sellerId: null,
      imageUrl: null, description: null, payout: null, stock: null,
      overridePrice: 0, postStep: 0, postFilter: null,
      isEditing: false, stockConfigured: false, fromGateway: false
    };
  }

  // --- Page Navigation Routing ---
  if (itemId.startsWith('shop_post_page_')) {
    state.postPage = parseInt(itemId.replace('shop_post_page_', ''), 10) || 1;
    await setPendingPostSession(sessionId, state);
    return handleShopPostStart(interaction);
  }

  // --- Folder Navigation Routing ---
  if (itemId === 'folder_reset' || itemId === 'folder_back') {
    state.postStep = 0;
    state.postFilter = null;
    state.postPage = 1;
  } else if (itemId === 'folder_categorized') {
    state.postStep = 1;
    state.postFilter = null;
    state.postPage = 1;
  } else if (itemId === 'folder_standalone') {
    state.postStep = 2;
    state.postFilter = 'standalone';
    state.postPage = 1;
  } else if (itemId === 'folder_packs') {
    state.postStep = 2;
    state.postFilter = 'packs';
    state.postPage = 1;
  } else if (itemId === 'folder_loot_boxes') {
    state.postStep = 2;
    state.postFilter = 'loot_boxes';
    state.postPage = 1;
  } else if (itemId.startsWith('filter_cat_')) {
    state.postStep = 2;
    state.postFilter = itemId.replace('filter_', '');
    state.postPage = 1;
  } else {
    // Final Item Selection
    state.itemId = itemId;
    state.postStep = 0; // Return to root after selection
    state.postPage = 1;
    
    const items = await getShopItems(interaction.guildId, null, 'name', true);
    const selectedItem = items.find(i => i.id === parseInt(itemId));

    // For new posts, price defaults to 0 (free) unless overridden
    state.overridePrice = 0;
    state.stock = null;
    state.stockConfigured = false;

    // Check if selected item is a pack or loot box - if so, reset seller/payout (server-only)
    if (selectedItem && (selectedItem.item_type === 'pack' || selectedItem.item_type === 'loot_box')) {
      state.sellerId = null;
      state.payout = null;
    } else if (selectedItem && state.sellerId) {
      // Auto-default payout to 0 when item selected (price set later via Set Price)
      state.payout = 0;
    }
  }

  await setPendingPostSession(sessionId, state);

  // Re-render panel
  await handleShopPostStart(interaction);
}

// Handle Channel Selection in Staging Panel
export async function handleShopPostChannelSelect(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
  const sessionId = getPostSessionId(interaction);
  const channelId = interaction.values[0];

  let state = await getPendingPostSession(sessionId);
  if (!state) {
    state = {
      itemId: null, channelId: null, sellerId: null,
      imageUrl: null, description: null, payout: null, stock: null,
      overridePrice: 0, postStep: 0, postFilter: null,
      isEditing: false, stockConfigured: false, fromGateway: false
    };
  }
  state.channelId = channelId;
  await setPendingPostSession(sessionId, state);

  // Re-render panel
  await handleShopPostStart(interaction);
}

// Handle Seller Selection in Staging Panel
export async function handleShopPostSellerSelect(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
  const sessionId = getPostSessionId(interaction);
  const selectedUserId = interaction.values[0];
  const guildOwnerId = interaction.guild.ownerId;

  let state = await getPendingPostSession(sessionId);
  if (!state) {
    state = {
      itemId: null, channelId: null, sellerId: null,
      imageUrl: null, description: null, payout: null, stock: null,
      overridePrice: 0, postStep: 0, postFilter: null,
      isEditing: false, stockConfigured: false, fromGateway: false
    };
  }

  // Owner-as-reset logic: selecting guild owner = reset seller to null
  if (selectedUserId === guildOwnerId) {
    state.sellerId = null;
    state.payout = null;
  } else {
    state.sellerId = selectedUserId;
    // Use overridePrice (post-time price) for payout cap — item.price may be NULL
    const priceForCap = state.overridePrice !== null && state.overridePrice !== undefined
      ? Number(state.overridePrice)
      : 0;
    const maxCap = Math.floor(priceForCap * 0.5);

    if (state.payout !== null && state.payout !== undefined && state.payout > 0) {
      // Payout already set — clamp if it exceeds max
      if (state.payout > maxCap) state.payout = maxCap;
    } else {
      // Default to 0 (admin can set it manually via Set Payout)
      state.payout = 0;
    }
  }

  await setPendingPostSession(sessionId, state);

  // Re-render panel
  await handleShopPostStart(interaction);
}

// Handle Appearance Button - Show Combined Modal (Description + Image File)
export async function handleShopPostAppearanceBtn(interaction) {
  try {
    const sessionId = getPostSessionId(interaction);
    const state = (await getPendingPostSession(sessionId)) || {};

    let selectedItem = null;
    let defaultImg = null;
    if (state.itemId) {
      try {
        selectedItem = await getShopItem(state.itemId, interaction.guildId);
        defaultImg = await resolveItemDefaultImage(selectedItem, interaction.guildId);
      } catch (_) {}
    }

    const modal = new ModalBuilder()
      .setCustomId(`shop_post_appearance_modal:${sessionId}`)
      .setTitle('Appearance');

    // Description holds: embed-scraped text (edit flow) or user-entered text (create flow)
    let descValue = (state.description ?? selectedItem?.description ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (descValue.length > 1000) descValue = descValue.substring(0, 1000);

    const descInput = new TextInputBuilder()
      .setCustomId('description')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('A very cool item that makes you look even cooler!')
      .setValue(descValue)
      .setRequired(false)
      .setMaxLength(1000);

    const descLabel = new LabelBuilder()
      .setLabel('Description')
      .setTextInputComponent(descInput);

    const isCustomImage = Boolean(state.imageUrl && !isSameImageUrl(state.imageUrl, defaultImg));
    const upload = new FileUploadBuilder()
      .setCustomId('post_image_file')
      .setRequired(false);

    const imageLabel = new LabelBuilder()
      .setLabel('Overwrite Default Image')
      .setDescription(formatCurrentImageDescription(state?.imageUrl || defaultImg))
      .setFileUploadComponent(upload);

    const labelComponents = [descLabel, imageLabel];

    if (isCustomImage) {
      const clearInput = new TextInputBuilder()
        .setCustomId('clear_image')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Type "clear" to remove custom image')
        .setRequired(false);

      const clearLabel = new LabelBuilder()
        .setLabel('Revert to Default Image?')
        .setTextInputComponent(clearInput);

      labelComponents.push(clearLabel);
    }

    modal.addLabelComponents(...labelComponents);
    await interaction.showModal(modal);
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop post appearance btn');
  }
}

// Handle Config Button - Show Combined Modal (Price + Stocks + Max Claims + Restock Timer)
export async function handleShopPostConfigBtn(interaction) {
  try {
    const sessionId = getPostSessionId(interaction);
    let state = (await getPendingPostSession(sessionId)) || {};
    if (typeof state === 'string') {
      try { state = JSON.parse(state); } catch (_) {}
    }

    // Hydration Fallback: If session state was lost across restart, reconstruct from interaction.message embed!
    const embed = interaction.message?.embeds?.[0];
    const embedTitle = embed?.title || '';
    const embedDesc = embed?.description || '';

    if (embedTitle && (state.isEditing === undefined || state.isEditing === null)) {
      state.isEditing = embedTitle.toLowerCase().startsWith('editing');
    }

    if (embedDesc) {
      if (state.overridePrice === undefined || state.overridePrice === null) {
        const priceMatch = embedDesc.match(/for\s*`([\d,]+)`/i);
        if (priceMatch) {
          state.overridePrice = parseInt(priceMatch[1].replace(/,/g, ''), 10);
        } else if (/for\s*`Free`/i.test(embedDesc)) {
          state.overridePrice = 0;
        }
      }

      if (state.stock === undefined || state.stock === null) {
        const stockMatch = embedDesc.match(/•\s*`([\d,]+)`\s*Stocks?/i);
        if (stockMatch) {
          state.stock = parseInt(stockMatch[1].replace(/,/g, ''), 10);
        }
      }

      if (state.restockIntervalSeconds === undefined || state.restockIntervalSeconds === null) {
        const timerMatch = embedDesc.match(/Every\s*`([^`\n]+)`/i);
        if (timerMatch) {
          state.restockIntervalSeconds = parseIntervalStringToSeconds(timerMatch[1]);
        }
      }

      if (state.claimLimit === undefined || state.claimLimit === null) {
        const claimMatch = embedDesc.match(/•\s*`([\d,]+)`\s*Per User/i);
        if (claimMatch) {
          state.claimLimit = parseInt(claimMatch[1].replace(/,/g, ''), 10);
        }
      }
    }

    let selectedItem = null;
    if (state.itemId) {
      try {
        selectedItem = await getShopItem(state.itemId, interaction.guildId);
      } catch (_) {}
    }

    const modal = new ModalBuilder()
      .setCustomId(`shop_post_config_modal:${sessionId}`)
      .setTitle('Post Configuration');

    let priceValue = '';
    const editPrice = (state.overridePrice !== null && state.overridePrice !== undefined)
      ? Number(state.overridePrice)
      : (selectedItem?.price !== null && selectedItem?.price !== undefined ? Number(selectedItem.price) : 0);

    if (editPrice > 0) {
      priceValue = String(editPrice);
    }

    const priceInput = new TextInputBuilder()
      .setCustomId('price_input')
      .setLabel('Price')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('Free')
      .setRequired(false);

    if (priceValue) {
      priceInput.setValue(priceValue);
    }

    const stockInput = new TextInputBuilder()
      .setCustomId('stock')
      .setLabel('Stocks')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('Unlimited')
      .setRequired(false);

    const stockVal = (state.stock !== null && state.stock !== undefined && state.stock > 0)
      ? Number(state.stock)
      : ((state.maxStock !== null && state.maxStock !== undefined && state.maxStock > 0) ? Number(state.maxStock) : null);

    if (stockVal !== null && stockVal > 0) {
      stockInput.setValue(String(stockVal));
    }

    const claimLimitInput = new TextInputBuilder()
      .setCustomId('claim_limit')
      .setLabel('Max Claims (Per User)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('Unlimited')
      .setRequired(false);

    if (state.claimLimit !== null && state.claimLimit !== undefined && state.claimLimit > 0) {
      claimLimitInput.setValue(String(state.claimLimit));
    }

    const intervalInput = new TextInputBuilder()
      .setCustomId('restock_interval')
      .setLabel('Restock Timer')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('Disabled')
      .setRequired(false);

    if (state.restockIntervalSeconds && state.restockIntervalSeconds > 0) {
      intervalInput.setValue(formatSecondsToIntervalString(state.restockIntervalSeconds));
    }

    modal.addComponents(
      new ActionRowBuilder().addComponents(priceInput),
      new ActionRowBuilder().addComponents(stockInput),
      new ActionRowBuilder().addComponents(claimLimitInput),
      new ActionRowBuilder().addComponents(intervalInput)
    );
    await interaction.showModal(modal);
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop post config btn');
  }
}

// Aliases for legacy/backward compatibility
export const handleShopPostStockBtn = handleShopPostConfigBtn;
export const handleShopPostPriceBtn = handleShopPostConfigBtn;
export const handleShopPostDescBtn = handleShopPostAppearanceBtn;
export const handleShopPostImageBtn = handleShopPostAppearanceBtn;

export async function handleShopPostPayoutBtn(interaction) {
  const sessionId = getPostSessionId(interaction);
  const state = await getPendingPostSession(sessionId);
  if (!state) {
    return interaction.reply({
      content: '⚠️ This post session has expired. Please reopen `/settings` > Shop > Edit Post.',
      flags: MessageFlags.Ephemeral
    }).catch(() => {});
  }
  
  // Calculate recommended 50%
  try {
    let suggestedCut = 0;
      // Suggested cut is based on overridePrice (the post-time price), not the stored null price
      if (state.itemId && state.overridePrice !== null) {
        suggestedCut = Math.floor(Number(state.overridePrice) * 0.5);
      }

    const modal = new ModalBuilder()
      .setCustomId(`shop_post_payout_modal:${sessionId}`)
      .setTitle('Seller Payout');

    const payoutInput = new TextInputBuilder()
      .setCustomId('payout')
      .setLabel('Payout (Per purchase)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('0 = None')
      .setValue((state.payout !== null && state.payout !== undefined && state.payout > 0) ? state.payout.toString() : '')
      .setRequired(false);

    modal.addComponents(new ActionRowBuilder().addComponents(payoutInput));
    await interaction.showModal(modal);
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop post payout btn');
  }
}

// Handle Reset Button
export async function handleShopPostReset(interaction) {
  await interaction.deferUpdate();
  const sessionId = getPostSessionId(interaction);
  const prev = await getPendingPostSession(sessionId);
  await deletePendingPostSession(sessionId);
  if (prev?.fromGateway) {
    await setPendingPostSession(sessionId, { fromGateway: true, channelId: interaction.channelId });
  }
  await handleShopPostStart(interaction);
}

// Show Modal for Shop Post Image (Legacy / Direct fallback)
export async function showShopPostImageModal(interaction, sessionId, state) {
  return handleShopPostAppearanceBtn(interaction);
}

// Handle Image Action Select Menu (Add / Remove - Legacy no-op fallback)
export async function handleShopPostImageActionSelect(interaction) {
  const sessionId = getPostSessionId(interaction);
  const selectedValue = interaction.values[0];
  const state = (await getPendingPostSession(sessionId)) || {};

  if (selectedValue === 'action_modal') {
    state.showImageMenu = false;
    await setPendingPostSession(sessionId, state);
    return handleShopPostAppearanceBtn(interaction);
  }

  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferUpdate().catch(() => {});
  }

  if (selectedValue === 'clear_post_image') {
    state.imageUrl = null;
    state.showImageMenu = false;
    await setPendingPostSession(sessionId, state);
    return handleShopPostStart(interaction);
  }
}

// Handle All Post Modal Submits (Appearance, Config, Payout, Legacy)
export async function handleShopPostModalSubmit(interaction) {
  try {
    await interaction.deferUpdate();
    const sessionId = getPostSessionId(interaction);
    const rawCustomId = (interaction.customId || '').split(':')[0];
    const customId = rawCustomId.includes('_modal')
      ? rawCustomId.substring(0, rawCustomId.indexOf('_modal') + 6)
      : rawCustomId;

    let state = await getPendingPostSession(sessionId);
    if (!state) {
      return interaction.followUp({
        content: '⚠️ Your staging session has expired or the bot was restarted. Please open `/settings` > Shop > Edit Post (or New Post) to reopen your post.',
        flags: MessageFlags.Ephemeral
      });
    }

    if (customId === 'shop_post_appearance_modal') {
      try {
        const descVal = (interaction.fields.getTextInputValue('description') || '').trim();
        state.description = descVal === '' ? null : descVal;
      } catch (_) {}

      let uploadedFile = null;
      try {
        const uploadedFiles = interaction.fields.getUploadedFiles?.('post_image_file');
        uploadedFile = uploadedFiles?.first?.() || (Array.isArray(uploadedFiles) ? uploadedFiles[0] : null);
      } catch (_) {}

      if (uploadedFile) {
        const uploadRes = await uploadHostAsset(interaction.client, 'items', interaction.guild, uploadedFile, {
          filename: uploadedFile.name,
          label: `🖼️ Shop Post Image: **${state.itemName || 'Item'}**`
        });
        state.imageUrl = uploadRes.url;
      } else {
        let clearVal = '';
        try {
          clearVal = (interaction.fields.getTextInputValue('clear_image') || '').trim().toLowerCase();
        } catch (_) {}
        if (clearVal === 'clear' || clearVal === 'none' || clearVal === 'default') {
          state.imageUrl = null;
        }
      }
    } else if (
      customId === 'shop_post_config_modal' ||
      customId === 'shop_post_stock_modal' ||
      customId === 'shop_post_drop_modal'
    ) {
      // 1. Price
      let rawPrice = '';
      try {
        rawPrice = (interaction.fields.getTextInputValue('price_input') || '').trim().toLowerCase();
      } catch (_) {}

      let submittedPrice = 0;
      if (rawPrice !== '' && rawPrice !== '0' && rawPrice !== 'free' && rawPrice !== 'null' && rawPrice !== 'none') {
        const newPrice = /^\d+$/.test(rawPrice) ? parseInt(rawPrice, 10) : -1;
        if (newPrice < 0) {
          return interaction.followUp({ content: 'Please enter a valid non-negative whole number for price (or leave empty for Free).', flags: MessageFlags.Ephemeral });
        }
        submittedPrice = newPrice;
      }

      if (state.isEditing) {
        const origPrice = (state.originalPrice !== undefined) ? state.originalPrice : (state.overridePrice ?? 0);
        if (submittedPrice !== origPrice) {
          state.overridePrice = submittedPrice;
        }
      } else {
        state.overridePrice = submittedPrice;
      }

      // 2. Stocks
      let stockVal = '';
      try {
        stockVal = (interaction.fields.getTextInputValue('stock') || interaction.fields.getTextInputValue('drop_stock') || '').trim().toLowerCase();
      } catch (_) {}

      let submittedStock = null;
      if (stockVal !== '' && stockVal !== '0' && stockVal !== 'unlimited' && stockVal !== 'null' && stockVal !== 'none') {
        if (!/^\d+$/.test(stockVal)) {
          return interaction.followUp({ content: 'Invalid stock count. Please enter a valid positive whole number, or leave empty for unlimited.', flags: MessageFlags.Ephemeral });
        }
        const num = parseInt(stockVal, 10);
        submittedStock = num <= 0 ? null : num;
      }

      if (state.isEditing) {
        const origStock = (state.originalStock !== undefined) ? state.originalStock : state.stock;
        if (submittedStock !== origStock) {
          state.stock = submittedStock;
          state.maxStock = submittedStock;
          state.stockModified = true;
          state.stockConfigured = true;
        }
      } else {
        state.stock = submittedStock;
        state.maxStock = submittedStock;
        state.stockModified = true;
        state.stockConfigured = true;
      }

      // 3. Max Claims
      let claimLimitVal = '';
      try {
        claimLimitVal = (interaction.fields.getTextInputValue('claim_limit') || '').trim().toLowerCase();
      } catch (_) {}

      let submittedClaimLimit = null;
      if (claimLimitVal !== '' && claimLimitVal !== '0' && claimLimitVal !== 'unlimited' && claimLimitVal !== 'null' && claimLimitVal !== 'none') {
        if (!/^\d+$/.test(claimLimitVal)) {
          return interaction.followUp({ content: 'Invalid claim limit. Please enter a positive whole number, or leave empty for unlimited.', flags: MessageFlags.Ephemeral });
        }
        const num = parseInt(claimLimitVal, 10);
        submittedClaimLimit = num <= 0 ? null : num;
      }

      if (state.isEditing) {
        const origLimit = (state.originalClaimLimit !== undefined) ? state.originalClaimLimit : null;
        if (submittedClaimLimit !== origLimit) {
          state.claimLimit = submittedClaimLimit;
        }
      } else {
        state.claimLimit = submittedClaimLimit;
      }

      // 4. Restock Timer
      let timerVal = '';
      try {
        timerVal = (interaction.fields.getTextInputValue('restock_interval') || '').trim().toLowerCase();
      } catch (_) {}

      let submittedInterval = null;
      if (timerVal !== '' && timerVal !== '0' && timerVal !== 'disable' && timerVal !== 'disabled' && timerVal !== 'off' && timerVal !== 'null' && timerVal !== 'none') {
        const intervalSeconds = parseIntervalStringToSeconds(timerVal);
        if (!intervalSeconds) {
          return interaction.followUp({ content: 'Invalid restock interval. Format must be between 5m and 30d (e.g. 30m, 6h, 1d), or leave empty to disable.', flags: MessageFlags.Ephemeral });
        }
        submittedInterval = intervalSeconds;
      }

      if (state.isEditing) {
        const origInterval = (state.originalRestockIntervalSeconds !== undefined) ? state.originalRestockIntervalSeconds : null;
        if (submittedInterval !== origInterval) {
          state.restockIntervalSeconds = submittedInterval;
        }
      } else {
        state.restockIntervalSeconds = submittedInterval;
      }
    } else if (customId === 'shop_post_image_modal') {
      const uploadedFiles = interaction.fields.getUploadedFiles?.('post_image_file');
      const uploadedFile = uploadedFiles?.first?.() || (Array.isArray(uploadedFiles) ? uploadedFiles[0] : null);
      if (uploadedFile) {
        const uploadRes = await uploadHostAsset(interaction.client, 'items', interaction.guild, uploadedFile, {
          filename: uploadedFile.name,
          label: `🖼️ Shop Post Image: **${state.itemName || 'Item'}**`
        });
        state.imageUrl = uploadRes.url;
      } else {
        let rawVal = '';
        try { rawVal = (interaction.fields.getTextInputValue('image_url') || '').trim(); } catch (_) {}
        const valLower = rawVal.toLowerCase();
        if (valLower === 'clear' || valLower === 'none' || valLower === 'default') {
          state.imageUrl = null;
        } else if (rawVal) {
          const cleaned = cleanImageUrl(rawVal);
          let defaultImg = null;
          if (state.itemId) {
            try {
              const item = await getShopItem(state.itemId, interaction.guildId);
              defaultImg = await resolveItemDefaultImage(item, interaction.guildId);
            } catch (_) {}
          }
          if (defaultImg && isSameImageUrl(cleaned, defaultImg)) {
            state.imageUrl = null;
          } else {
            state.imageUrl = cleaned;
          }
        }
      }
    } else if (customId === 'shop_post_desc_modal') {
      const val = (interaction.fields.getTextInputValue('description') || '').trim();
      state.description = val === '' ? null : val;
    } else if (customId === 'shop_post_payout_modal') {
      const val = (interaction.fields.getTextInputValue('payout') || '').trim();
      let inputAmount = 0;
      if (val !== '') {
        if (!/^\d+$/.test(val)) {
          return interaction.followUp({ content: 'Invalid payout. Please enter a valid positive whole number.', flags: MessageFlags.Ephemeral });
        }
        inputAmount = parseInt(val, 10);
      }

      state.payout = (inputAmount > 0) ? inputAmount : null;
    } else if (customId === 'shop_post_price_modal') {
      const val = (interaction.fields.getTextInputValue('price_input') || '').trim().toLowerCase();
      
      if (val === '' || val === '0' || val === 'free' || val === 'null' || val === 'none') {
        state.overridePrice = 0;
      } else {
        const newPrice = /^\d+$/.test(val) ? parseInt(val, 10) : -1;
        if (newPrice < 0) {
          return interaction.followUp({ content: 'Please enter a valid non-negative whole number (or leave empty for Free).', flags: MessageFlags.Ephemeral });
        }
        state.overridePrice = newPrice;
      }
    }

    await setPendingPostSession(sessionId, state);

    // Re-render panel
    await handleShopPostStart(interaction);
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop post modal submit');
  }
}

// Handle Publish Button - Actually post the item
export async function handleShopPostPublish(interaction) {
  try {
    const sessionId = getPostSessionId(interaction);
    const state = await getPendingPostSession(sessionId);

    // Validation
    if (!state || !state.itemId || !state.channelId) {
      return handleInteractionError(interaction, new Error('Validation Failed: Channel and Item required for posting'), 'shop post publish');
    }

    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

    const { itemId, channelId, sellerId, imageUrl, description, payout, stock, overridePrice } = state;
    const item = await getShopItem(itemId, interaction.guildId);

    if (!item) {
      return interaction.followUp({ content: '❌ Item not found.', flags: MessageFlags.Ephemeral });
    }

    // Loot Box Configuration Validation
    if (item.item_type === 'loot_box' && item.loot_box_id) {
      const box = await getLootBox(item.loot_box_id, interaction.guildId);
      if (!box) {
        return interaction.followUp({
          content: '❌ Loot box configuration not found.',
          flags: MessageFlags.Ephemeral
        });
      }

      const itemsEnabled = box.items_enabled !== false;
      const coinsEnabled = box.coins_enabled !== false;
      const hasCoins = coinsEnabled && (parseFloat(box.chance_coins) || 0) > 0 && (parseInt(box.max_coins, 10) || 0) > 0;
      const hasItems = itemsEnabled && (box.totalItemWeight || 0) > 0;

      if (!hasCoins && !hasItems) {
        const coinName = await getCurrencyName(interaction.guildId);
        const lootBoxCatName = await getLootBoxCategoryName(interaction.guildId);
        return interaction.followUp({
          content: `❌ This ${lootBoxCatName.toLowerCase()} has neither item drop rates nor ${coinName.toLowerCase()} rewards enabled. Please configure rewards in ${lootBoxCatName} Management before publishing.`,
          flags: MessageFlags.Ephemeral
        });
      }
    }

    // Price defaults to overridePrice, item.price, or 0 (0 = free)
    const effectivePrice = (state.overridePrice !== null && state.overridePrice !== undefined)
      ? Number(state.overridePrice)
      : (item.price !== null && item.price !== undefined ? Number(item.price) : 0);

    const isFree = effectivePrice === 0;

    const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      return interaction.followUp({ content: '❌ Channel not found.', flags: MessageFlags.Ephemeral });
    }

    const botMember = interaction.guild.members.me;
    const diag = diagnoseChannelPermissions(channel, botMember, [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks
    ]);

    if (!diag.hasAll) {
      return handleInteractionError(
        interaction,
        new Error(`Missing Permissions in <#${channelId}>: ${diag.missing.join(', ')}`),
        `Publish Shop Post to <#${channelId}>`,
        { targetChannel: channel }
      );
    }

    // Construct the Embed
    const embed = new EmbedBuilder()
      .setTitle(item.name)
      .setColor('#3498DB'); 

    // Post-level stock and price: isolated per post to prevent cross-channel contamination of catalog items
    const postStock = (state.stock !== null && state.stock !== undefined && state.stock > 0) ? state.stock : null;

    // Image: instance-specific override takes priority, then item's default image
    const defaultImg = await resolveItemDefaultImage(item, interaction.guildId);
    const isCustom = Boolean(imageUrl && !isSameImageUrl(imageUrl, defaultImg));
    const finalImage = isCustom ? imageUrl : defaultImg;
    if (finalImage) {
      embed.setImage(finalImage); // LARGE banner image for publicly posted shop embeds
    }

    // Use custom description if set, otherwise item's default description
    const finalDescription = description || item.description;
    if (finalDescription) {
      embed.setDescription(finalDescription);
    }

    // Pack Contents Field
    if (item.item_type === 'pack') {
      const count = item.contents ? item.contents.length : 0;
      embed.addFields({ name: '📦 Contents', value: `**${count}** Items`, inline: true });
    } else if (item.item_type === 'loot_box' || item.loot_box_id) {
      // Loot Box / Chest: Do NOT add 🏷️ Item or ⏳ Duration fields
    } else {
      // Single Item
      if (item.role_id) {
        embed.addFields({ name: '🏷️ Item', value: `<@&${item.role_id}>`, inline: true });
      } else {
        embed.addFields({ name: '🏷️ Item', value: item.name, inline: true });
      }

      // Duration Field
      let durationText = 'Permanent';
      if (item.duration_seconds) {
        const days = Math.floor(item.duration_seconds / 86400);
        const hours = Math.floor((item.duration_seconds % 86400) / 3600);
        if (days > 0) {
          durationText = `${days} Day${days !== 1 ? 's' : ''}`;
          if (hours > 0) durationText += ` ${hours} Hour${hours !== 1 ? 's' : ''}`;
        } else if (hours > 0) {
          durationText = `${hours} Hour${hours !== 1 ? 's' : ''}`;
        } else {
          const minutes = Math.floor(item.duration_seconds / 60);
          durationText = `${minutes} Minute${minutes !== 1 ? 's' : ''}`;
        }
      }
      embed.addFields({ name: '⏳ Duration', value: durationText, inline: true });
    }

    const autoEquip = state.autoEquip === true;
    const hasTimer = Boolean(state.restockIntervalSeconds && state.restockIntervalSeconds > 0);
    const hasLimit = Boolean(state.claimLimit && state.claimLimit > 0);
    const effectivePostMode = hasTimer ? 'auto' : (hasLimit ? 'drop' : 'normal');
    const claimLimit = hasLimit ? state.claimLimit : null;
    const restockIntervalSeconds = hasTimer ? state.restockIntervalSeconds : null;
    const maxStock = state.stock !== null ? state.stock : null;
    const lastRestockedAt = hasTimer ? new Date() : null;

    // Stock Field (Visual)
    const isSoldOut = postStock !== null && postStock !== undefined && postStock <= 0;
    let stockHeader = '♾️ Unlimited';
    let stockValue = 'Available';

    if (hasTimer) {
      const baseTime = lastRestockedAt ? new Date(lastRestockedAt).getTime() : Date.now();
      let nextRestockMs = baseTime + (restockIntervalSeconds * 1000);
      if (nextRestockMs <= Date.now()) {
        const elapsed = Date.now() - baseTime;
        const cycles = Math.floor(elapsed / (restockIntervalSeconds * 1000)) + 1;
        nextRestockMs = baseTime + (cycles * restockIntervalSeconds * 1000);
      }
      const nextRestockUnix = Math.floor(nextRestockMs / 1000);

      if (postStock === null || postStock === undefined) {
        stockHeader = '♾️ Unlimited';
        stockValue = `Refreshes <t:${nextRestockUnix}:R>`;
      } else if (isSoldOut) {
        stockHeader = '🔴 Out Of Stock';
        stockValue = `Restocks <t:${nextRestockUnix}:R>`;
        embed.setColor('#808080');
      } else {
        stockHeader = `🟢 ${postStock} In Stock`;
        stockValue = `Restocks <t:${nextRestockUnix}:R>`;
      }
    } else {
      if (postStock === null || postStock === undefined) {
        stockHeader = '♾️ Unlimited';
        stockValue = 'Available';
      } else if (isSoldOut) {
        stockHeader = '🔴 Out Of Stock';
        stockValue = 'Sold Out';
        embed.setColor('#808080');
      } else {
        stockHeader = `🟢 ${postStock} In Stock`;
        stockValue = 'Available';
      }
    }
    
    embed.addFields({ name: stockHeader, value: stockValue, inline: true });

    // Create Buy / Claim Button with Seller ID, Payout, and Override Price encoded
    // Format: bank_shop_buy_[itemId]_[sellerId]_[payout]_[overridePrice]
    const sellerPart = sellerId || '0';
    const payoutPart = payout || '0';
    const overridePart = (effectivePrice !== null && effectivePrice !== undefined) ? effectivePrice : '';
    
    let buttonLabel = '';
    if (isSoldOut) {
      buttonLabel = 'SOLD OUT';
    } else if (isFree) {
      buttonLabel = 'CLAIM';
    } else {
      buttonLabel = `BUY (${Number(effectivePrice).toLocaleString()})`;
    }
    
    const buyButton = new ButtonBuilder()
      .setCustomId(`bank_shop_buy_${itemId}_${sellerPart}_${payoutPart}_${overridePart}`)
      .setLabel(buttonLabel)
      .setEmoji(`${COIN_EMOJI}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(isSoldOut);

    const row = new ActionRowBuilder().addComponents(buyButton);

    const postMsg = await channel.send({ embeds: [embed], components: [row] });
    verifyAndHealMessageImages(postMsg, { expectedImageUrl: finalImage || null });

    try {
      const pool = (await import('../storage/postgres.js')).getPool();
      const customDesc = (description && description.trim().length > 0) ? description.trim() : null;
      await pool.query(
        `INSERT INTO shop_posts (
          message_id, guild_id, channel_id, item_id, custom_image_url,
          post_mode, auto_equip, claim_limit_per_user, restock_interval_seconds,
          max_stock, current_stock, override_price, last_restocked_at, custom_description, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
        ON CONFLICT (message_id) DO UPDATE SET
          channel_id = EXCLUDED.channel_id,
          item_id = EXCLUDED.item_id,
          custom_image_url = EXCLUDED.custom_image_url,
          post_mode = EXCLUDED.post_mode,
          auto_equip = EXCLUDED.auto_equip,
          claim_limit_per_user = EXCLUDED.claim_limit_per_user,
          restock_interval_seconds = EXCLUDED.restock_interval_seconds,
          max_stock = EXCLUDED.max_stock,
          current_stock = EXCLUDED.current_stock,
          override_price = EXCLUDED.override_price,
          last_restocked_at = EXCLUDED.last_restocked_at,
          custom_description = EXCLUDED.custom_description,
          updated_at = NOW()`,
        [
          postMsg.id, interaction.guildId, channelId, itemId, isCustom ? imageUrl : null,
          effectivePostMode, autoEquip, claimLimit, restockIntervalSeconds,
          maxStock, postStock, effectivePrice, lastRestockedAt, customDesc
        ]
      );
    } catch (_) {}

    // Standardized Shop Admin Log
    if (item.item_type === 'loot_box' || item.loot_box_id) {
      const lootBoxCatName = await getLootBoxCategoryName(interaction.guildId);
      const lootBoxEmoji = await getLootBoxCategoryEmoji(interaction.guildId);
      const singularName = (lootBoxCatName.endsWith('s') || lootBoxCatName.endsWith('S')) 
        ? lootBoxCatName.slice(0, -1) 
        : lootBoxCatName;
      sendLog(
        interaction.guild, 
        'shop', 
        'blue', 
        `${lootBoxEmoji || '🎁'} ${singularName} Posted`, 
        `Admin **<@${interaction.user.id}>** posted ${singularName.toLowerCase()} **${item.name}** to <#${channelId}> (Price: **${isFree ? 'FREE' : effectivePrice.toLocaleString()}** ${COIN_EMOJI})`
      );
    } else if (item.item_type === 'pack' || item.is_pack) {
      sendLog(
        interaction.guild, 
        'shop', 
        'blue', 
        '📦 Pack Posted', 
        `Admin **<@${interaction.user.id}>** posted pack **${item.name}** to <#${channelId}> (Price: **${isFree ? 'FREE' : effectivePrice.toLocaleString()}** ${COIN_EMOJI})`
      );
    } else {
      sendLog(
        interaction.guild, 
        'shop', 
        'blue', 
        '📢 Shop Post Created', 
        `Admin **<@${interaction.user.id}>** posted item **${item.name}** to <#${channelId}> (Price: **${isFree ? 'FREE' : effectivePrice.toLocaleString()}** ${COIN_EMOJI})`
      );
    }

    // Delete current draft session, then re-seed channelId/sellerId/fromGateway for this panel
    const fromGateway = state.fromGateway ?? true;
    await deletePendingPostSession(sessionId);
    await setPendingPostSession(sessionId, { 
      channelId, 
      sellerId,
      itemId: null,
      imageUrl: null,
      description: null,
      payout: null,
      stock: null,
      overridePrice: 0,
      postStep: 0,
      postFilter: null,
      fromGateway
    });

    // Feedback - Only if posting to a DIFFERENT channel
    if (interaction.channelId !== channelId) {
      await interaction.followUp({ 
        content: `✅ **${item.name}** posted to <#${channelId}>!`, 
        flags: MessageFlags.Ephemeral 
      }).catch(() => {});
    }

    // Re-render panel (stay open for more posts)
    await handleShopPostStart(interaction);
  } catch (error) {
    const state = await getPendingPostSession(getPostSessionId(interaction));
    const targetChannel = state?.channelId ? interaction.guild?.channels?.cache?.get(state.channelId) : interaction.channel;
    await handleInteractionError(interaction, error, 'Publish Shop Post', { targetChannel });
  }
}

// --- Delete Item Handlers ---

export async function handleDeleteItemStart(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    const context = { action: 'delete_item', folder: 'root', message: null };
    pendingAdminBrowser.set(getAdminBrowserKey(interaction), context);
    await renderAdminBrowser(interaction, context);
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop delete item start');
  }
}

// Previously handleDeleteItemCategorySelect - Removed as we now list all items directly.
export async function handleDeleteItemCategorySelect(interaction) {
  // Deprecated redirect in case of old interactions
  await handleDeleteItemStart(interaction);
}

export async function handleDeleteItemSelect(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    const itemId = parseInt(interaction.values[0]);

    // 1. Get name for feedback BEFORE deleting
    const item = await getShopItem(itemId, interaction.guildId);
    const itemName = item ? item.name : 'Unknown Item';

    // 2. Delete
    await deleteShopItem(itemId, interaction.guildId);

    // Standardized Shop Admin Log
    sendLog(interaction.guild, 'shop', 'red', '🗑️ Item Deleted', `Admin **<@${interaction.user.id}>** deleted item **${itemName}** from the Shop.`);

    // 3. Return to Browser with Success Message
    const context = { action: 'delete_item', folder: 'root', message: `✅ Item **${itemName}** deleted.` };
    pendingAdminBrowser.set(getAdminBrowserKey(interaction), context);
    await renderAdminBrowser(interaction, context);
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop delete item select');
  }
}

export async function handleDeletePackStart(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    const context = { action: 'delete_pack', folder: 'root', message: null };
    pendingAdminBrowser.set(getAdminBrowserKey(interaction), context);
    await renderAdminBrowser(interaction, context);
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop delete pack start');
  }
}

export async function handleDeleteLootBoxStart(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    const context = { action: 'delete_lootbox', folder: 'root', message: null };
    pendingAdminBrowser.set(getAdminBrowserKey(interaction), context);
    await renderAdminBrowser(interaction, context);
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop delete lootbox start');
  }
}

export async function handleDeletePackSelect(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    const itemId = parseInt(interaction.values[0]);

    // 1. Get name for feedback BEFORE deleting
    const item = await getShopItem(itemId, interaction.guildId);
    const packName = item ? item.name : 'Pack';

    // 2. Delete
    await deleteShopItem(itemId, interaction.guildId);

    // Standardized Shop Admin Log
    sendLog(interaction.guild, 'shop', 'red', '📦 Pack Deleted', `Admin **<@${interaction.user.id}>** deleted pack **${packName}**.`);

    // 3. Return to Browser with Success Message
    const context = { action: 'delete_pack', folder: 'root', message: `✅ Pack **${packName}** deleted.` };
    pendingAdminBrowser.set(getAdminBrowserKey(interaction), context);
    await renderAdminBrowser(interaction, context);
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop delete pack select');
  }
}

// --- Category Handlers ---

export async function handleCreateCategory(interaction) {
  try {
    const modal = new ModalBuilder()
      .setCustomId('shop_category_modal')
      .setTitle('Create Shop Category');

    const nameInput = new TextInputBuilder()
      .setCustomId('cat_name')
      .setLabel('Category Name')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('e.g. VIP Roles')
      .setRequired(true);

    const typeInput = new TextInputBuilder()
      .setCustomId('cat_type')
      .setLabel('Category Type (0=Multi, 1=Single)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('0 for Stack, 1 for Swap')
      .setMinLength(1)
      .setMaxLength(1)
      .setRequired(true);

    modal.addComponents(
      new ActionRowBuilder().addComponents(nameInput),
      new ActionRowBuilder().addComponents(typeInput)
    );

    await interaction.showModal(modal);
    await refreshShopSetupMessage(interaction);
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop create category');
  }
}

export async function handleCategoryModalSubmit(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    const customId = interaction.customId;
    const isEdit = customId.startsWith('shop_cat_modal_edit_');
    const categoryId = isEdit ? customId.split('_').pop() : null;

    const name = interaction.fields.getTextInputValue('cat_name');
    const typeRaw = interaction.fields.getTextInputValue('cat_type');
    const type = parseInt(typeRaw);

    if (isNaN(type) || (type !== 0 && type !== 1)) {
      return interaction.followUp({ content: '❌ Invalid Category Type. Use 0 for Multi (Stack) or 1 for Single (Swap).', flags: MessageFlags.Ephemeral });
    }

    const { getGuildEmojiBlacklist, containsBlacklistedEmoji } = await import('../middleware/emoji-filter.js');
    const emojiConfig = await getGuildEmojiBlacklist(interaction.guildId);
    if (emojiConfig.enabled && containsBlacklistedEmoji(name, emojiConfig.blacklist)) {
      return interaction.followUp({
        content: `❌ Category name **${name}** contains a restricted emoji and cannot be used.`,
        flags: MessageFlags.Ephemeral
      });
    }

    if (isEdit) {
      // ========== EDIT FLOW ==========
      const res = await query('UPDATE shop_categories SET name = $1, category_type = $2 WHERE id = $3 AND guild_id = $4 RETURNING *', [name, type, categoryId, interaction.guildId]);
      
      if (res.rowCount > 0) {
        sendLog(interaction.guild, 'shop', 'blue', '📂 Category Updated', `Admin **<@${interaction.user.id}>** updated category **${name}** (ID: ${categoryId})`);
        await renderManageCategoryScreen(interaction, categoryId, { from: 'list' });
      } else {
        await interaction.followUp({ content: '❌ Category not found.', flags: MessageFlags.Ephemeral });
      }
    } else {
      // ========== ADD FLOW ==========
      const existingCategories = await getShopCategories(interaction.guildId);
      if (existingCategories.some(c => c.name.trim().toLowerCase() === name.trim().toLowerCase())) {
        return interaction.followUp({
          content: `❌ A category named **${name.trim()}** already exists.`,
          flags: MessageFlags.Ephemeral
        });
      }
      const newCat = await addShopCategory(interaction.guildId, name, 0, type);
      sendLog(interaction.guild, 'shop', 'green', '📂 Category Created', `Admin **<@${interaction.user.id}>** created shop category **${name}**`);
      await renderManageCategoryScreen(interaction, newCat.id, { from: 'create' });
    }
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop category modal submit');
  }
}

export async function handleEditCategoryStart(interaction, page = 1) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    const categories = await getShopCategories(interaction.guildId);

    const rowBack = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('shop_admin_home').setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary)
    );

    if (categories.length === 0) {
      const emptyEmbed = new EmbedBuilder().setColor('#95A5A6').setDescription('No items found.');
      return interaction.editReply({ files: [], attachments: [], content: null, embeds: [emptyEmbed], components: [rowBack] });
    }

    const pageNum = typeof page === 'number' ? page : (parseInt(page, 10) || 1);
    const { selectMenu } = buildPaginatedSelectMenu({
      items: categories,
      page: pageNum,
      customId: 'shop_select_cat_edit_rename',
      placeholder: 'Select',
      pageNavPrefix: 'cat_edit_rename_page_',
      pageSize: 20,
      mapOption: c => ({
        label: ((c.name && c.name.trim().length > 0) ? c.name : `Unnamed Category #${c.id}`).slice(0, 100),
        value: c.id.toString(),
        emoji: '📂'
      })
    });

    const embed = new EmbedBuilder()
      .setColor('#3498DB')
      .setTitle('Category Management')
      .setDescription('**Select a category to manage:**');

    const row = new ActionRowBuilder().addComponents(selectMenu);

    await interaction.editReply({ files: [], attachments: [], content: null, embeds: [embed], components: [row, rowBack] });
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop edit category start');
  }
}

export async function renderManageCategoryScreen(interaction, categoryId, options = {}) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => {});
    }

    const {
      addPage = 1,
      removePage = 1,
      from = 'list'
    } = options;

    const guildId = interaction.guildId;
    const categories = await getShopCategories(guildId);
    const category = categories.find(c => c.id.toString() === String(categoryId));

    if (!category) {
      return interaction.editReply({ files: [], attachments: [], content: '❌ Category not found.', embeds: [], components: [] });
    }

    // Query all shop items for this guild
    const allItems = await getShopItems(guildId, null, 'name', true);

    // Filter items in this category vs standalone
    const catItems = allItems.filter(i =>
      i.category_id === parseInt(categoryId) && !i.is_pack && i.item_type !== 'pack' && i.item_type !== 'loot_box'
    );
    const standaloneItems = allItems.filter(i =>
      !i.category_id && !i.is_pack && i.item_type !== 'pack' && i.item_type !== 'loot_box'
    );

    const sortedCatItems = await sortItemsByRarity(catItems, interaction.guild);
    const sortedStandalone = await sortItemsByRarity(standaloneItems, interaction.guild);

    const count = sortedCatItems.length;
    const typeLabel = category.category_type === 1 ? 'Single (Swap)' : 'Multi (Stack)';

    const embed = new EmbedBuilder()
      .setTitle(`Category: ${category.name}`)
      .setDescription(`Manage items and settings for this category.\n\n**Type:** \`${typeLabel}\`\n**Items:** \`${count}\``)
      .setColor('#9B59B6');

    const nonce = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    // 1. Select Menu 1: Add Items
    let rowAdd;
    if (sortedStandalone.length > 0) {
      const pageNum = typeof addPage === 'number' ? addPage : (parseInt(addPage, 10) || 1);
      const { selectMenu } = buildPaginatedSelectMenu({
        items: sortedStandalone,
        page: pageNum,
        customId: `shop_cat_add_item_${categoryId}_${pageNum}_${removePage}_${from}_${nonce}`,
        placeholder: `➕ Add Items (${sortedStandalone.length} available)`,
        pageNavPrefix: `cat_add_nav_`,
        pageSize: 23,
        mapOption: i => {
          const opt = {
            label: ((i.name && i.name.trim().length > 0) ? i.name : `Unnamed Item #${i.id}`).slice(0, 100),
            value: i.id.toString()
          };
          const em = getItemRarityEmoji(i);
          if (em) opt.emoji = em;
          return opt;
        }
      });
      rowAdd = new ActionRowBuilder().addComponents(selectMenu);
    } else {
      const emptyAdd = new StringSelectMenuBuilder()
        .setCustomId(`shop_cat_empty_add_${nonce}`)
        .setPlaceholder('➕ No standalone items to add')
        .setDisabled(true)
        .addOptions([{ label: 'No standalone items available', value: 'none' }]);
      rowAdd = new ActionRowBuilder().addComponents(emptyAdd);
    }

    // 2. Select Menu 2: Remove Items
    let rowRemove;
    if (sortedCatItems.length > 0) {
      const pageNum = typeof removePage === 'number' ? removePage : (parseInt(removePage, 10) || 1);
      const { selectMenu } = buildPaginatedSelectMenu({
        items: sortedCatItems,
        page: pageNum,
        customId: `shop_cat_remove_item_${categoryId}_${addPage}_${pageNum}_${from}_${nonce}`,
        placeholder: `➖ Remove Items (${sortedCatItems.length} in category)`,
        pageNavPrefix: `cat_remove_nav_`,
        pageSize: 23,
        mapOption: i => {
          const opt = {
            label: ((i.name && i.name.trim().length > 0) ? i.name : `Unnamed Item #${i.id}`).slice(0, 100),
            value: i.id.toString()
          };
          const em = getItemRarityEmoji(i);
          if (em) opt.emoji = em;
          return opt;
        }
      });
      rowRemove = new ActionRowBuilder().addComponents(selectMenu);
    } else {
      const emptyRemove = new StringSelectMenuBuilder()
        .setCustomId(`shop_cat_empty_remove_${nonce}`)
        .setPlaceholder('➖ No items in this category')
        .setDisabled(true)
        .addOptions([{ label: 'No items in this category', value: 'none' }]);
      rowRemove = new ActionRowBuilder().addComponents(emptyRemove);
    }

    // 3. Button Row: Back and Edit
    const backCustomId = from === 'create' ? 'shop_admin_home' : 'shop_edit_category_start';
    const backRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(backCustomId)
        .setLabel('Back')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`shop_cat_settings_${categoryId}`)
        .setLabel('Edit')
        .setEmoji('✏️')
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.editReply({
      files: [],
      attachments: [],
      content: null,
      embeds: [embed],
      components: [rowAdd, rowRemove, backRow]
    });
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop manage category');
  }
}

export async function handleEditCategorySelect(interaction, options = {}) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});

    // Determine categoryId: from select menu (values[0]) or from customId
    let categoryId;
    if (interaction.isAnySelectMenu()) {
      categoryId = interaction.values[0];
    } else if (interaction.customId) {
      categoryId = interaction.customId.split('_').pop();
    }

    if (categoryId && categoryId.startsWith('cat_edit_rename_page_')) {
      const page = parseInt(categoryId.replace('cat_edit_rename_page_', ''), 10) || 1;
      return handleEditCategoryStart(interaction, page);
    }

    return renderManageCategoryScreen(interaction, categoryId, {
      from: options.from || 'list'
    });
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop edit category select');
  }
}

export async function handleCategoryAddSelect(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
    const parts = interaction.customId.split('_');
    // customId format: shop_cat_add_item_${categoryId}_${addPage}_${removePage}_${from}_${nonce}
    const categoryId = parts[4];
    const addPage = parseInt(parts[5], 10) || 1;
    const removePage = parseInt(parts[6], 10) || 1;
    const from = parts[7] || 'list';

    const selection = interaction.values[0];
    if (selection.startsWith('cat_add_nav_')) {
      const nextAddPage = parseInt(selection.replace('cat_add_nav_', ''), 10) || 1;
      return renderManageCategoryScreen(interaction, categoryId, { addPage: nextAddPage, removePage, from });
    }

    const itemId = parseInt(selection, 10);
    const item = await getShopItem(itemId, interaction.guildId);
    if (item && item.category_id !== null && item.category_id !== undefined) {
      return interaction.followUp({
        content: '❌ This item is already in a category. Remove it first.',
        flags: MessageFlags.Ephemeral
      });
    }

    await updateShopItem(itemId, { category_id: parseInt(categoryId) }, interaction.guildId);

    const categories = await getShopCategories(interaction.guildId);
    const category = categories.find(c => c.id.toString() === String(categoryId));
    sendLog(interaction.guild, 'shop', 'blue', '📂 Item Added to Category', `Admin **<@${interaction.user.id}>** added item **${item?.name || itemId}** to category **${category?.name || 'Unknown'}**`);

    return renderManageCategoryScreen(interaction, categoryId, {
      addPage,
      removePage,
      from
    });
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop category add select');
  }
}

export async function handleCategoryRemoveSelect(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
    const parts = interaction.customId.split('_');
    // customId format: shop_cat_remove_item_${categoryId}_${addPage}_${removePage}_${from}_${nonce}
    const categoryId = parts[4];
    const addPage = parseInt(parts[5], 10) || 1;
    const removePage = parseInt(parts[6], 10) || 1;
    const from = parts[7] || 'list';

    const selection = interaction.values[0];
    if (selection.startsWith('cat_remove_nav_')) {
      const nextRemovePage = parseInt(selection.replace('cat_remove_nav_', ''), 10) || 1;
      return renderManageCategoryScreen(interaction, categoryId, { addPage, removePage: nextRemovePage, from });
    }

    const itemId = parseInt(selection, 10);
    const item = await getShopItem(itemId, interaction.guildId);

    await updateShopItem(itemId, { category_id: null }, interaction.guildId);

    const categories = await getShopCategories(interaction.guildId);
    const category = categories.find(c => c.id.toString() === String(categoryId));
    sendLog(interaction.guild, 'shop', 'blue', '📂 Item Removed from Category', `Admin **<@${interaction.user.id}>** removed item **${item?.name || itemId}** from category **${category?.name || 'Unknown'}**`);

    return renderManageCategoryScreen(interaction, categoryId, {
      addPage,
      removePage,
      from
    });
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop category remove select');
  }
}

export async function handleEditCategoryRenameStart(interaction) {
  try {
    // DO NOT DEFER - We need to show a modal immediately
    const categoryId = interaction.customId.split('_').pop();
    const categories = await getShopCategories(interaction.guildId);
    const category = categories.find(c => c.id.toString() === categoryId);

    if (!category) {
      const error = new Error('Category not found');
      return await handleInteractionError(interaction, error, 'shop edit category rename start');
    }

    const modal = new ModalBuilder()
      .setCustomId(`shop_cat_modal_edit_${categoryId}`)
      .setTitle('Edit Category');

    const nameInput = new TextInputBuilder()
      .setCustomId('cat_name')
      .setLabel('Category Name')
      .setStyle(TextInputStyle.Short)
      .setValue(category.name)
      .setRequired(true);

    const typeInput = new TextInputBuilder()
      .setCustomId('cat_type')
      .setLabel('Category Type (0=Multi, 1=Single)')
      .setStyle(TextInputStyle.Short)
      .setValue(String(category.category_type || 0))
      .setMinLength(1)
      .setMaxLength(1)
      .setRequired(true);

    modal.addComponents(
      new ActionRowBuilder().addComponents(nameInput),
      new ActionRowBuilder().addComponents(typeInput)
    );

    await interaction.showModal(modal);
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop edit category rename start');
  }
}

export async function handleEditCategoryAddItemsStart(interaction, page = 1) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    const categoryId = interaction.customId.split('_').pop();

    // Get items with NO category (Standalone), valid roles, not packs
    const items = await getShopItems(interaction.guildId, null, 'name', true);
    const standalone = items.filter(i => {
      if (i.category_id) return false; // Must be standalone
      if (i.is_pack || i.item_type === 'pack') return false; // No packs
      if (!i.role_id) return false; // Must have role
      const roleId = i.role_id.split(/[,\s]+/)[0];
      return interaction.guild.roles.cache.has(roleId); // Role must exist
    });

    const sortedStandalone = await sortItemsByRarity(standalone, interaction.guild);

    const rowBack = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`shop_cat_manage_${categoryId}`) // Back to category management
        .setLabel('Back')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary)
    );

    if (sortedStandalone.length === 0) {
      const emptyEmbed = new EmbedBuilder().setColor('#95A5A6').setDescription('No items found.');
      return interaction.editReply({ files: [], attachments: [], content: null, embeds: [emptyEmbed], components: [rowBack] });
    }

    const pageNum = typeof page === 'number' ? page : (parseInt(page, 10) || 1);
    const { selectMenu } = buildPaginatedSelectMenu({
      items: sortedStandalone,
      page: pageNum,
      customId: `shop_edit_cat_add_select_${categoryId}`,
      placeholder: 'Select',
      pageNavPrefix: `cat_add_nav_${categoryId}_`,
      pageSize: 20,
      mapOption: i => ({
        label: ((i.name && i.name.trim().length > 0) ? i.name : `Unnamed Item #${i.id}`).slice(0, 100),
        value: i.id.toString(),
        emoji: getItemRarityEmoji(i)
      })
    });

    const row = new ActionRowBuilder().addComponents(selectMenu);

    const embedPrompt = new EmbedBuilder()
      .setColor('#2ECC71')
      .setTitle('Select Item(s) to Add to Category');

    await interaction.editReply({ files: [], attachments: [], content: null, 
        components: [row, rowBack], 
        embeds: [embedPrompt] });
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop edit category add items start');
  }
}

export async function handleEditCategoryAddItemsSelect(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    const categoryId = interaction.customId.split('_').pop();
    const selection = interaction.values[0];

    // Handle pagination page navigation
    if (selection.startsWith(`cat_add_nav_${categoryId}_`)) {
      const page = parseInt(selection.split('_').pop(), 10) || 1;
      return handleEditCategoryAddItemsStart(interaction, page);
    }

    const itemId = selection;

    // Validation: Check if item already has a category (strict exclusivity)
    const item = await getShopItem(itemId, interaction.guildId);
    if (item && item.category_id !== null) {
      return interaction.followUp({
        content: '❌ This item is already in a category. Remove it first.',
        flags: MessageFlags.Ephemeral
      });
    }

    await updateShopItem(itemId, { category_id: parseInt(categoryId) }, interaction.guildId);

    // Standardized Shop Admin Log
    const categoriesAll = await getShopCategories(interaction.guildId);
    const categoryTarget = categoriesAll.find(c => c.id.toString() === categoryId);
    sendLog(interaction.guild, 'shop', 'blue', '📂 Item Added to Category', `Admin **<@${interaction.user.id}>** added item **${item?.name || itemId}** to category **${categoryTarget?.name || 'Unknown'}**`);


    // --- Persistent Menu Logic ---

    // 1. Get Category Name for feedback
    const categoryName = categoryTarget ? categoryTarget.name : 'Category';

    // 2. Get Added Item Name
    const addedItemName = item ? item.name : 'Item';

    // 3. Fetch remaining standalone items with valid roles
    const itemsAll = await getShopItems(interaction.guildId, null, 'name', true);
    const standalone = itemsAll.filter(i => {
      if (i.category_id) return false;
      if (i.is_pack || i.item_type === 'pack') return false;
      if (!i.role_id) return false;
      const roleId = i.role_id.split(/[,\s]+/)[0];
      return interaction.guild.roles.cache.has(roleId);
    });
    const sortedStandaloneRemaining = await sortItemsByRarity(standalone, interaction.guild);

    const rowBack = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`shop_cat_manage_${categoryId}`)
        .setLabel('Back')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary)
    );

    if (sortedStandaloneRemaining.length === 0) {
      // No more items - Standardized Empty State
      const emptyEmbed = new EmbedBuilder()
        .setColor('#95A5A6')
        .setDescription('No items found.');

      await interaction.editReply({
        content: `✅ **${addedItemName}** added to **${categoryName}**.`,
        components: [rowBack],
        embeds: [emptyEmbed]
      });
    } else {
      // Update dropdown
      const { selectMenu } = buildPaginatedSelectMenu({
        items: sortedStandaloneRemaining,
        page: 1,
        customId: `shop_edit_cat_add_select_${categoryId}`,
        placeholder: 'Select',
        pageNavPrefix: `cat_add_nav_${categoryId}_`,
        pageSize: 20,
        mapOption: i => ({
          label: ((i.name && i.name.trim().length > 0) ? i.name : `Unnamed Item #${i.id}`).slice(0, 100),
          value: i.id.toString(),
          emoji: getItemRarityEmoji(i)
        })
      });

      const row = new ActionRowBuilder().addComponents(selectMenu);

      const embedPrompt = new EmbedBuilder()
        .setColor('#2ECC71')
        .setTitle('Select Item(s) to Add to Category');

      await interaction.editReply({
        content: `✅ **${addedItemName}** added to **${categoryName}**.`,
        components: [row, rowBack],
        embeds: [embedPrompt]
      });
    }
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop edit category add items select');
  }
}

export async function handleEditCategoryRemoveItemsStart(interaction, successHeader = null, page = 1) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    const categoryId = interaction.customId.split('_').pop();

    const items = await getShopItems(interaction.guildId, parseInt(categoryId), 'price', true);
    const sortedItems = await sortItemsByRarity(items, interaction.guild);

    const rowBack = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`shop_cat_manage_${categoryId}`) // Back to category management
        .setLabel('Back')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary)
    );

    if (sortedItems.length === 0) {
      const emptyEmbed = new EmbedBuilder().setColor('#95A5A6').setDescription('No items found.');
      return interaction.editReply({ files: [], attachments: [], content: null, embeds: [emptyEmbed], components: [rowBack] });
    }

    const pageNum = typeof page === 'number' ? page : (parseInt(page, 10) || 1);
    const { selectMenu } = buildPaginatedSelectMenu({
      items: sortedItems,
      page: pageNum,
      customId: `shop_edit_cat_remove_select_${categoryId}`,
      placeholder: 'Select',
      pageNavPrefix: `cat_remove_nav_${categoryId}_`,
      pageSize: 20,
      mapOption: i => ({
        label: ((i.name && i.name.trim().length > 0) ? i.name : `Unnamed Item #${i.id}`).slice(0, 100),
        value: i.id.toString(),
        emoji: getItemRarityEmoji(i)
      })
    });

    const row = new ActionRowBuilder().addComponents(selectMenu);

    const embedPrompt = new EmbedBuilder()
      .setColor('#3498DB')
      .setTitle('Select Item(s) to Remove from Category');

    await interaction.editReply({ files: [], attachments: [], content: successHeader || null, 
        components: [row, rowBack], 
        embeds: [embedPrompt] });
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop edit category remove items start');
  }
}

export async function handleEditCategoryRemoveItemsSelect(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    const categoryId = interaction.customId.split('_').pop();
    const selection = interaction.values[0];

    // Handle pagination page navigation
    if (selection.startsWith(`cat_remove_nav_${categoryId}_`)) {
      const page = parseInt(selection.split('_').pop(), 10) || 1;
      return handleEditCategoryRemoveItemsStart(interaction, null, page);
    }

    const itemId = parseInt(selection);

    const item = await getShopItem(itemId, interaction.guildId);
    const removedItemName = item?.name || itemId;
    const categoriesAll = await getShopCategories(interaction.guildId);
    const category = categoriesAll.find(c => c.id.toString() === categoryId);
    const categoryName = category ? category.name : 'Category';

    await updateShopItem(itemId, { category_id: null }, interaction.guildId);

    // Standardized Shop Admin Log
    sendLog(interaction.guild, 'shop', 'blue', '📂 Item Removed from Category', `Admin **<@${interaction.user.id}>** removed item **${removedItemName}** from category **${categoryName}**`);


    // --- Persistent Menu Logic ---

    // 3. Fetch remaining items in this category
    const items = await getShopItems(interaction.guildId, parseInt(categoryId), 'price', true);
    const sortedItems = await sortItemsByRarity(items, interaction.guild);

    const rowBack = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`shop_cat_manage_${categoryId}`)
        .setLabel('Back')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary)
    );

    if (sortedItems.length === 0) {
      // Standardized Empty State
      const emptyEmbed = new EmbedBuilder()
        .setColor('#95A5A6')
        .setDescription('No items found.');

      await interaction.editReply({
        content: `✅ **${removedItemName}** removed from **${categoryName}**.`,
        components: [rowBack],
        embeds: [emptyEmbed]
      });
    } else {
      const { selectMenu } = buildPaginatedSelectMenu({
        items: sortedItems,
        page: 1,
        customId: `shop_edit_cat_remove_select_${categoryId}`,
        placeholder: 'Select',
        pageNavPrefix: `cat_remove_nav_${categoryId}_`,
        pageSize: 20,
        mapOption: i => ({
          label: ((i.name && i.name.trim().length > 0) ? i.name : `Unnamed Item #${i.id}`).slice(0, 100),
          value: i.id.toString(),
          emoji: getItemRarityEmoji(i)
        })
      });

      const row = new ActionRowBuilder().addComponents(selectMenu);

      const embedPrompt = new EmbedBuilder()
        .setColor('#E74C3C')
        .setTitle('Select Item(s) to Remove from Category');

      await interaction.editReply({
        content: `✅ **${removedItemName}** removed from **${categoryName}**.`,
        components: [row, rowBack],
        embeds: [embedPrompt]
      });
    }
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop edit category remove items select');
  }
}

export async function handleEditCategoryModalSubmit(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    const categoryId = interaction.customId.split('_').pop();
    const name = interaction.fields.getTextInputValue('cat_name');
    const typeRaw = interaction.fields.getTextInputValue('cat_type');
    const type = parseInt(typeRaw);

    if (isNaN(type) || (type !== 0 && type !== 1)) {
      return interaction.followUp({ content: '❌ Invalid Category Type. Use 0 for Multi (Stack) or 1 for Single (Swap).', flags: MessageFlags.Ephemeral });
    }

    const categories = await getShopCategories(interaction.guildId);
    const oldCat = categories.find(c => c.id.toString() === categoryId);
    if (!oldCat) {
      return interaction.followUp({ content: '❌ Category not found in this server.', flags: MessageFlags.Ephemeral });
    }

    await updateShopCategory(categoryId, { name, category_type: type }, interaction.guildId);

    // Standardized Shop Admin Log (Smart Diffing)
    const diff = formatDiff(oldCat, { ...oldCat, name, category_type: type }, ['name', 'category_type']);
    if (diff) {
      sendLog(interaction.guild, 'shop', 'blue', '📂 Category Updated', `Admin **<@${interaction.user.id}>** updated shop category **${name}**\n${diff}`);
    }


    await renderManageCategoryScreen(interaction, categoryId, { from: 'list' });
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop edit category modal submit');
  }
}

export async function handleDeleteCategoryStart(interaction, page = 1) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    const categories = await getShopCategories(interaction.guildId);

    const rowBack = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('shop_admin_home').setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary)
    );

    if (categories.length === 0) {
      const emptyEmbed = new EmbedBuilder().setColor('#95A5A6').setDescription('No items found.');
      return interaction.editReply({ files: [], attachments: [], content: null, embeds: [emptyEmbed], components: [rowBack] });
    }

    const pageNum = typeof page === 'number' ? page : (parseInt(page, 10) || 1);
    const { selectMenu } = buildPaginatedSelectMenu({
      items: categories,
      page: pageNum,
      customId: 'shop_select_cat_delete_confirm',
      placeholder: 'Select',
      pageNavPrefix: 'cat_del_nav_',
      pageSize: 20,
      mapOption: c => ({
        label: ((c.name && c.name.trim().length > 0) ? c.name : `Unnamed Category #${c.id}`).slice(0, 100),
        value: c.id.toString(),
        emoji: '📂'
      })
    });

    const embed = new EmbedBuilder()
      .setColor('#E74C3C')
      .setTitle('Delete Category')
      .setDescription('**Select a category to delete:**');

    const row = new ActionRowBuilder().addComponents(selectMenu);

    await interaction.editReply({ files: [], attachments: [], content: null,
      embeds: [embed],
      components: [row, rowBack] });
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop delete category start');
  }
}

export async function handleDeleteCategoryConfirm(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    const selection = interaction.values[0];

    // Handle pagination page navigation
    if (selection.startsWith('cat_del_nav_')) {
      const page = parseInt(selection.split('_').pop(), 10) || 1;
      return handleDeleteCategoryStart(interaction, page);
    }

    const categoryId = selection;

    // Get name for feedback
    const categoriesBefore = await getShopCategories(interaction.guildId);
    const category = categoriesBefore.find(c => c.id.toString() === categoryId);
    if (!category) {
      return interaction.followUp({
        content: '❌ Category not found in this server.',
        flags: MessageFlags.Ephemeral
      });
    }
    const categoryName = category.name;

    // Step 1: Detach items (Make them standalone, scoped to guild)
    const detachResult = await detachItemsFromCategory(categoryId, interaction.guildId);

    // Step 2: Delete Category (scoped to guild)
    const deleted = await deleteShopCategory(categoryId, interaction.guildId);
    if (!deleted) {
      return interaction.followUp({
        content: '❌ Failed to delete category from database.',
        flags: MessageFlags.Ephemeral
      });
    }

    // Bulk Audit Log
    sendBulkLog(
      interaction.guild, 
      'shop', 
      'red', 
      'Category Deleted', 
      `Admin ${getUserLogName(interaction.member)} deleted category **'${categoryName}'**.\n• **Status:** Removed successfully.\n• **Items Affected:** **${detachResult.count}** items were made standalone.`
    );

    // Directly re-render category delete view in place (zero header text, clean state)
    return handleDeleteCategoryStart(interaction, 1);
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop delete category confirm');
  }
}

// --- Admin Smart Folders (Isolated State) ---
export async function renderAdminBrowser(interaction, contextMap) {
  try {
    const { action, folder, message } = contextMap;
    // Map contexts back to text/routes.
    const isEdit = action.startsWith('edit');
    const isItem = action.endsWith('item');
    const isLootBox = action.endsWith('lootbox');
    
    // External Back button always returns directly to the parent screen (Shop Admin Home or Loot Boxes Home)
    const backRoute = isLootBox ? 'shop_lb_home' : 'shop_admin_home';
    
    const rowBack = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(backRoute).setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary)
    );

    // Dynamic Title
    let titleText = '';
    if (isLootBox) {
       const catName = await getLootBoxCategoryName(interaction.guildId);
       titleText = `Select ${catName.toLowerCase()} to ${isEdit ? 'edit' : 'delete'}`;
    } else if (isItem) {
       titleText = folder === 'browse_categories' ? 'Select a category to browse' : `Select an item to ${isEdit ? 'edit' : 'delete'}`;
    } else {
       titleText = `Select a pack to ${isEdit ? 'edit' : 'delete'}`;
    }

    // Standardized Embed Style
    const embed = new EmbedBuilder()
      .setColor(isEdit ? '#3498DB' : '#E74C3C')
      .setTitle(titleText);

    // LOOT BOXES logic
    if (isLootBox) {
      const lootBoxes = await getLootBoxes(interaction.guildId);
      const catName = await getLootBoxCategoryName(interaction.guildId);
      const catEmoji = await getLootBoxCategoryEmoji(interaction.guildId);

      if (lootBoxes.length === 0) {
        await handleLootBoxesPage(interaction);
        return interaction.followUp({ content: `❌ No ${catName.toLowerCase()} found.`, flags: MessageFlags.Ephemeral });
      }

      const page = contextMap.page || 1;
      const { selectMenu } = buildPaginatedSelectMenu({
        items: lootBoxes,
        page,
        customId: 'shop_admin_browser_select',
        placeholder: `Select ${catName}`,
        pageNavPrefix: 'admin_browser_page_',
        pageSize: 20,
        mapOption: b => ({
          label: (b.name || `Unnamed Box #${b.id}`).slice(0, 100),
          value: `lb_${b.id}`,
          emoji: parseSelectEmoji(catEmoji)
        })
      });

      return interaction.editReply({ files: [], attachments: [], content: (message && (message.startsWith('✅') || message.startsWith('❌'))) ? message : null,
        components: [new ActionRowBuilder().addComponents(selectMenu), rowBack],
        embeds: [embed] });
    }

    // Fetch items mapping to current folder (if item mode) or just list packs (if pack mode)
    if (isItem) {
      const items = await getShopItems(interaction.guildId, null, 'name', true);
      const singleItems = items.filter(i => !i.is_pack && i.item_type !== 'pack' && i.item_type !== 'loot_box');

      // 1. ROOT VIEW - Show Categorized vs Uncategorized (Matches Post flow)
      if (folder === 'root') {
        const hasCategorized = singleItems.some(i => i.category_id);
        const hasUncategorized = singleItems.some(i => !i.category_id);

        if (!hasCategorized && !hasUncategorized) {
          if (contextMap.action.startsWith('delete')) {
            await handleShopAdminDelete(interaction);
          } else {
            await handleShopAdminEdit(interaction);
          }
          return interaction.followUp({ content: '❌ No items available.', flags: MessageFlags.Ephemeral });
        }

        const options = [];
        if (hasCategorized) {
          options.push({ 
            label: 'Categorized Items', 
            value: 'action_browse_categorized',
            emoji: '📂'
          });
        }
        if (hasUncategorized) {
          options.push({ 
            label: 'Uncategorized Items', 
            value: 'cat_null',
            emoji: '🏷️'
          });
        }

        const select = new StringSelectMenuBuilder()
          .setCustomId('shop_admin_browser_select')
          .setPlaceholder('Select')
          .addOptions(options);

        return interaction.editReply({ files: [], attachments: [], content: (message && (message.startsWith('✅') || message.startsWith('❌'))) ? message : null,
          components: [new ActionRowBuilder().addComponents(select), rowBack],
          embeds: [embed] });
      }

      // 2. CATEGORY LIST VIEW - Show specific Category folders
      if (folder === 'browse_categories') {
        const categories = await getShopCategories(interaction.guildId);
        const usedCategoryIds = new Set(singleItems.map(i => i.category_id));
        const activeCategories = categories.filter(c => usedCategoryIds.has(c.id));

        const page = contextMap.page || 1;
        const { selectMenu } = buildPaginatedSelectMenu({
          items: activeCategories,
          page,
          customId: 'shop_admin_browser_select',
          placeholder: 'Select',
          backOption: {
            label: 'Back',
            value: 'action_back_root',
            emoji: '⬅️'
          },
          pageNavPrefix: 'admin_browser_page_',
          pageSize: 20,
          mapOption: cat => ({
            label: (cat.name || `Category #${cat.id}`).slice(0, 100),
            value: `cat_${cat.id}`,
            emoji: '📂'
          })
        });

        return interaction.editReply({ files: [], attachments: [], content: (message && (message.startsWith('✅') || message.startsWith('❌'))) ? message : null,
          components: [new ActionRowBuilder().addComponents(selectMenu), rowBack],
          embeds: [embed] });
      }

      // 3. ITEM VIEW - List items inside a specific Category or Uncategorized
      const targetCategoryId = folder === 'cat_null' ? null : parseInt(folder.replace('cat_', ''), 10);
      let folderItems = singleItems.filter(i => i.category_id === targetCategoryId);
      folderItems = await sortItemsByRarity(folderItems, interaction.guild);

      if (folderItems.length === 0) {
         pendingAdminBrowser.set(getAdminBrowserKey(interaction), { ...contextMap, folder: 'root', page: 1 });
         return renderAdminBrowser(interaction, pendingAdminBrowser.get(getAdminBrowserKey(interaction)));
      }

      const page = contextMap.page || 1;

      const isCatNull = folder === 'cat_null';
      const { selectMenu } = buildPaginatedSelectMenu({
        items: folderItems,
        page,
        customId: 'shop_admin_browser_select',
        placeholder: 'Select',
        backOption: {
          label: 'Back',
          value: isCatNull ? 'action_back_root' : 'action_back_categories',
          emoji: '⬅️'
        },
        pageNavPrefix: 'admin_browser_page_',
        pageSize: 20,
        mapOption: i => ({
          label: (i.name && i.name.trim().length > 0 ? i.name : `Unnamed Item #${i.id}`).slice(0, 100),
          value: `item_${i.id}`,
          emoji: getItemRarityEmoji(i)
        })
      });

      return interaction.editReply({ files: [], attachments: [], content: (message && (message.startsWith('✅') || message.startsWith('❌'))) ? message : null,
         components: [new ActionRowBuilder().addComponents(selectMenu), rowBack],
         embeds: [embed] });
    }

    // PACKS logic (no categories for packs currently, so they display flat)
    if (!isItem && !isLootBox) {
        const items = await getShopItems(interaction.guildId, null, 'name', true);
        const packs = items.filter(i => i.is_pack || i.item_type === 'pack');
        
        if (packs.length === 0) {
           if (contextMap.action.startsWith('delete')) {
             await handleShopAdminDelete(interaction);
           } else {
             await handleShopAdminEdit(interaction);
           }
           return interaction.followUp({ content: '❌ No packs found.', flags: MessageFlags.Ephemeral });
        }

        const page = contextMap.page || 1;
        const { selectMenu } = buildPaginatedSelectMenu({
          items: packs,
          page,
          customId: 'shop_admin_browser_select',
          placeholder: 'Select',
          pageNavPrefix: 'admin_browser_page_',
          pageSize: 20,
          mapOption: p => ({
            label: (p.name && p.name.trim().length > 0 ? p.name : `Unnamed Pack #${p.id}`).slice(0, 100),
            value: `item_${p.id}`,
            emoji: '📦'
          })
        });

        return interaction.editReply({ files: [], attachments: [], content: (message && (message.startsWith('✅') || message.startsWith('❌'))) ? message : null,
          components: [new ActionRowBuilder().addComponents(selectMenu), rowBack],
          embeds: [embed] });
    }
  } catch (error) {
     await handleInteractionError(interaction, error, 'admin browser render');
  }
}

export async function handleAdminBrowserBackRoot(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    let context = pendingAdminBrowser.get(getAdminBrowserKey(interaction)) || { action: 'edit_item', folder: 'root', page: 1, message: null };
    context.folder = 'root';
    context.page = 1;
    context.message = null;
    pendingAdminBrowser.set(getAdminBrowserKey(interaction), context);
    return renderAdminBrowser(interaction, context);
  } catch (error) {
    await handleInteractionError(interaction, error, 'admin browser back root');
  }
}

export async function handleAdminBrowserBackCat(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    let context = pendingAdminBrowser.get(getAdminBrowserKey(interaction)) || { action: 'edit_item', folder: 'browse_categories', page: 1, message: null };
    context.folder = 'browse_categories';
    context.page = 1;
    context.message = null;
    pendingAdminBrowser.set(getAdminBrowserKey(interaction), context);
    return renderAdminBrowser(interaction, context);
  } catch (error) {
    await handleInteractionError(interaction, error, 'admin browser back cat');
  }
}

export async function handleAdminBrowserSelect(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate();
    }

    const selection = interaction.values[0];
    let context = pendingAdminBrowser.get(getAdminBrowserKey(interaction));

    if (!context) {
      context = { action: 'edit_item', folder: 'root', page: 1, message: null };
      pendingAdminBrowser.set(getAdminBrowserKey(interaction), context);
    }

    // Handle pagination page change
    if (selection.startsWith('admin_browser_page_')) {
      context.page = parseInt(selection.replace('admin_browser_page_', ''), 10) || 1;
      pendingAdminBrowser.set(getAdminBrowserKey(interaction), context);
      return renderAdminBrowser(interaction, context);
    }

    // Handle navigating back up to the root layer
    if (selection === 'action_back_root') {
      context.folder = 'root';
      context.page = 1;
      context.message = null;
      pendingAdminBrowser.set(getAdminBrowserKey(interaction), context);
      return renderAdminBrowser(interaction, context);
    }

    // Handle navigating back up to the categories list
    if (selection === 'action_back_categories') {
      context.folder = 'browse_categories';
      context.page = 1;
      context.message = null;
      pendingAdminBrowser.set(getAdminBrowserKey(interaction), context);
      return renderAdminBrowser(interaction, context);
    }

    // Handle navigating to the categories list
    if (selection === 'action_browse_categorized') {
      context.folder = 'browse_categories';
      context.page = 1;
      context.message = null;
      pendingAdminBrowser.set(getAdminBrowserKey(interaction), context);
      return renderAdminBrowser(interaction, context);
    }

    // Handle drilling into a specific Category folder
    if (selection.startsWith('cat_')) {
      context.folder = selection;
      context.page = 1;
      context.message = null;
      pendingAdminBrowser.set(getAdminBrowserKey(interaction), context);
      return renderAdminBrowser(interaction, context);
    }

    // Handle selecting a loot box
    if (selection.startsWith('lb_')) {
      const boxId = parseInt(selection.replace('lb_', ''), 10);
      const action = context.action || 'edit_lootbox';
      if (action === 'edit_lootbox') {
        return await showLootBoxEditorPanel(interaction, boxId);
      } else if (action === 'delete_lootbox') {
        return await showLootBoxDeleteConfirm(interaction, boxId);
      }
    }

    // Handle selecting the actual item/pack
    if (selection.startsWith('item_')) {
      const itemId = selection.replace('item_', '');
      const action = context.action || 'edit_item';

      // Inject the clean numeric ID directly so handleEditItemSelect doesn't need to re-parse
      interaction.values = [itemId];

      // Route to the correct handler
      if (action === 'edit_item') return await handleEditItemSelect(interaction);
      if (action === 'delete_item') return await handleDeleteItemSelect(interaction);
      if (action === 'edit_pack') return await handleEditPackSelect(interaction);
      if (action === 'delete_pack') return await handleDeletePackSelect(interaction);
    }
  } catch (error) {
    await handleInteractionError(interaction, error, 'admin browser selection');
  }
}

// --- Edit Item Handlers ---

export async function handleEditItemStart(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

    // If the Back button encoded a folder ID, restore the browser at that folder.
    // customId format: 'shop_edit_item_back_<folderId>' (folderId = category UUID or 'root')
    const cid = interaction.customId || '';
    const BACK_PREFIX = 'shop_edit_item_back_';
    if (cid.startsWith(BACK_PREFIX)) {
      const folderId = cid.slice(BACK_PREFIX.length);
      const context = { action: 'edit_item', folder: folderId, message: null };
      pendingAdminBrowser.set(getAdminBrowserKey(interaction), context);
      return renderAdminBrowser(interaction, context);
    }

    // Fresh entry — always start from root
    const context = { action: 'edit_item', folder: 'root', message: null };
    pendingAdminBrowser.set(getAdminBrowserKey(interaction), context);
    await renderAdminBrowser(interaction, context);
  } catch (error) {
    await handleInteractionError(interaction, error, 'edit item start');
  }
}

// Previously handleEditItemCategorySelect - Removed / Unused
export async function handleEditItemCategorySelect(interaction) {
  // Deprecated redirect
  await handleEditItemStart(interaction);
}

/**
 * Shows the Revoke confirmation screen (in-place message update).
 */
export async function handleRevokeItemStart(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
  try {
    const itemId = interaction.customId.startsWith('shop_item_revoke_')
      ? interaction.customId.slice('shop_item_revoke_'.length)
      : interaction.customId.split('_').pop();
    const item = await getShopItem(itemId, interaction.guildId);
    if (!item) return interaction.followUp({ content: '❌ Item not found.', flags: MessageFlags.Ephemeral });

    const embed = new EmbedBuilder()
      .setTitle('Confirm Revoke')
      .setDescription(
        `You are about to revoke all owned copies of **${item.name}**.\n\n` +
        `This will:\n` +
        `- Remove it from every user's inventory\n` +
        `- Strip the item's role from all members\n\n` +
        `This action cannot be undone.`
      )
      .setColor('#E74C3C');

    const confirmBtn = new ButtonBuilder()
      .setCustomId(`shop_item_revoke_confirm_${itemId}`)
      .setLabel('Confirm Revoke')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Danger);

    const cancelBtn = new ButtonBuilder()
      .setCustomId(`shop_item_tab_users_${itemId}`)
      .setLabel('Back')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder().addComponents(cancelBtn, confirmBtn);
    await interaction.editReply({ files: [], attachments: [], content: null, embeds: [embed], components: [row] });
  } catch (error) {
    await handleInteractionError(interaction, error, 'revoke item start');
  }
}

/**
 * Executes the Revoke: strips roles from all holders and clears inventory records,
 * but keeps the item in shop_items.
 */
export async function handleRevokeItemConfirm(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
  try {
    const itemId = interaction.customId.startsWith('shop_item_revoke_confirm_')
      ? interaction.customId.slice('shop_item_revoke_confirm_'.length)
      : interaction.customId.split('_').pop();

    const item = await getShopItem(itemId, interaction.guildId);
    if (!item) return interaction.followUp({ content: '❌ Item not found.', flags: MessageFlags.Ephemeral });

    const itemName = item.name;

    // 1. Fetch all holders from inventory (including expired records — strip everything)
    const holders = await query(
      `SELECT DISTINCT user_id FROM user_inventory WHERE shop_item_id = $1 AND guild_id = $2`,
      [itemId, interaction.guildId]
    );

    // 2. Strip Discord role from every holder still in the server
    if (item.role_id && holders.rows.length > 0) {
      const roleIds = item.role_id.split(/[,\s]+/).filter(Boolean);
      const holderIds = holders.rows.map(r => r.user_id);
      try {
        const fetchedMembers = await interaction.guild.members.fetch({ user: holderIds });
        const stripPromises = [];
        for (const member of fetchedMembers.values()) {
          for (const rid of roleIds) {
            if (member.roles.cache.has(rid)) {
              stripPromises.push(
                member.roles.remove(rid, `Item Revoked: ${itemName}`).catch(() => null)
              );
            }
          }
        }
        await Promise.allSettled(stripPromises);
      } catch (err) {
        sysError('Revoke Role Strip Failed', err, { guild: interaction.guildId, item: itemId });
      }
    }

    // 3. Clear inventory records for this item (keeps the item in shop_items)
    await query(
      `DELETE FROM user_inventory WHERE shop_item_id = $1 AND guild_id = $2`,
      [itemId, interaction.guildId]
    );

    // 4. Audit log
    sendLog(
      interaction.guild, 'shop', 'red', '⚠️ Item Revoked from Users',
      `Admin **<@${interaction.user.id}>** revoked item **${itemName}** — removed from all user inventories (item remains in shop).`
    );

    // 5. Show success with a back button leading back to the item's edit view
    const successEmbed = new EmbedBuilder()
      .setDescription(`✅ **${itemName}** has been revoked from all users. All inventory records and role assignments have been cleared.`)
      .setColor('#2ECC71');

    const backBtn = new ButtonBuilder()
      .setCustomId(`shop_item_tab_users_${itemId}`)
      .setLabel('Back')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder().addComponents(backBtn);
    await interaction.editReply({ files: [], attachments: [], content: null, embeds: [successEmbed], components: [row] });
  } catch (error) {
    await handleInteractionError(interaction, error, 'revoke item confirm');
  }
}

export async function handleEditItemSelect(interaction, successHeader = null, options = {}) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => { });
  
  let itemId;
  let view = 'details';
  let page = 1;
  let reqPage = 1;

  if (interaction.isAnySelectMenu && interaction.isAnySelectMenu()) {
    itemId = interaction.values[0];
    // Strip 'item_' prefix if present
    if (typeof itemId === 'string' && itemId.startsWith('item_')) {
      itemId = itemId.replace('item_', '');
    }
  } else {
    const cid = interaction.customId || '';

    // Determine view from customId prefix
    if (cid.startsWith('shop_item_tab_details_')) {
      view = 'details';
      itemId = cid.slice('shop_item_tab_details_'.length);
    } else if (cid.startsWith('shop_item_tab_config_')) {
      view = 'config';
      itemId = cid.slice('shop_item_tab_config_'.length);
    } else if (cid.startsWith('shop_item_reqpage_')) {
      view = 'config';
      const raw = cid.slice('shop_item_reqpage_'.length);
      const pageMatch = raw.match(/_p(\d+)$/);
      if (pageMatch) {
        reqPage = parseInt(pageMatch[1], 10);
        itemId = raw.slice(0, raw.lastIndexOf('_p'));
      } else {
        itemId = raw;
      }
    } else if (cid.startsWith('shop_item_tab_users_') || cid.startsWith('shop_item_view_users_')) {
      view = 'users';
      const raw = cid.startsWith('shop_item_tab_users_') ? cid.slice('shop_item_tab_users_'.length) : cid.slice('shop_item_view_users_'.length);
      const pageMatch = raw.match(/_p(\d+)$/);
      if (pageMatch) { page = parseInt(pageMatch[1], 10); itemId = raw.slice(0, raw.lastIndexOf('_p')); }
      else { itemId = raw; }
    } else if (cid.startsWith('shop_item_page_prev_') || cid.startsWith('shop_item_page_next_')) {
      view = 'users';
      const raw = cid.startsWith('shop_item_page_prev_') ? cid.slice('shop_item_page_prev_'.length) : cid.slice('shop_item_page_next_'.length);
      const pageMatch = raw.match(/_p(\d+)$/);
      if (pageMatch) { page = parseInt(pageMatch[1], 10); itemId = raw.slice(0, raw.lastIndexOf('_p')); }
      else { itemId = raw; }
    } else {
      // Fallback for legacy customIds (shop_item_view_details_, shop_item_edit_select_, shop_item_edit_)
      const prefixes = [
        'shop_item_view_details_',
        'shop_item_edit_select_',
        'shop_item_edit_',
      ];
      const matched = prefixes.find(p => cid.startsWith(p));
      if (matched) {
        const raw = cid.slice(matched.length);
        itemId = raw.includes('_p') ? raw.slice(0, raw.lastIndexOf('_p')) : raw;
      } else {
        itemId = cid.split('_').pop();
      }
    }
  }

  // Strip 'item_' prefix if present
  if (typeof itemId === 'string' && itemId.startsWith('item_')) {
    itemId = itemId.replace('item_', '');
  }

  try {
    const item = await getShopItem(itemId, interaction.guildId);
    if (!item) return interaction.followUp({ content: '❌ Item not found.', flags: MessageFlags.Ephemeral });

    if (item.is_pack || item.item_type === 'pack') {
      sysLog('Shop Admin Warning', { guild: interaction.guildId, detail: `Attempted to edit Pack ${item.id} in Item Editor` });
      return interaction.followUp({ content: '❌ This is a pack. Please use "Edit Pack" instead.', flags: MessageFlags.Ephemeral });
    }

    // Embed color: custom hex > rarity fallback
    const embedColor = getItemEmbedColor(item);

    const packCount = await getItemUsageCount(item.id, interaction.guildId);
    const roleMention = item.role_id ? `<@&${item.role_id}>` : 'None';

    let reqItems = item.required_items;
    if (typeof reqItems === 'string') {
      try { reqItems = JSON.parse(reqItems); } catch (e) { reqItems = []; }
    }

    const categories = await getShopCategories(interaction.guildId);
    const itemCategory = categories.find(c => c.id === item.category_id);
    const categoryDisplay = itemCategory ? itemCategory.name : 'None';

    let durationDisplay = 'Permanent';
    if (item.duration_seconds) {
      const days = Math.floor(item.duration_seconds / 86400);
      const hours = Math.floor((item.duration_seconds % 86400) / 3600);
      if (days > 0) {
        durationDisplay = `${days} Day${days !== 1 ? 's' : ''}`;
        if (hours > 0) durationDisplay += ` ${hours} Hour${hours !== 1 ? 's' : ''}`;
      } else if (hours > 0) {
        durationDisplay = `${hours} Hour${hours !== 1 ? 's' : ''}`;
      } else {
        const minutes = Math.floor(item.duration_seconds / 60);
        durationDisplay = `${minutes} Minute${minutes !== 1 ? 's' : ''}`;
      }
    }

    const PAGE_SIZE = 50;
    const dbUsers = await query(
      `SELECT user_id, 
              MAX(CASE WHEN is_active THEN 1 ELSE 0 END) as is_active_db,
              COALESCE(SUM(COALESCE(quantity, 1)), 0) as total_qty
       FROM user_inventory
       WHERE shop_item_id = $1 AND guild_id = $2 AND (expires_at IS NULL OR expires_at > NOW())
       GROUP BY user_id`,
      [item.id, interaction.guildId]
    );

    const dbUserMap = new Map();
    dbUsers.rows.forEach(r => dbUserMap.set(r.user_id, {
      isActive: Number(r.is_active_db),
      qty: parseInt(r.total_qty) || 1
    }));

    const ownedCount = dbUserMap.size;

    const roleIds = item.role_id ? item.role_id.split(/[,\s]+/).filter(Boolean) : [];
    const roleMembersSet = new Set();
    let equippedCount = 0;

    if (roleIds.length > 0) {
      try { await interaction.guild.members.fetch(); } catch (err) { /* proceed with cache */ }
      for (const rid of roleIds) {
        const role = interaction.guild.roles.cache.get(rid);
        if (role) { for (const uid of role.members.keys()) roleMembersSet.add(uid); }
      }
      equippedCount = roleMembersSet.size;
    } else {
      equippedCount = Array.from(dbUserMap.values()).filter(v => v.isActive === 1).length;
    }

    const memberRows = Array.from(dbUserMap.entries()).map(([uid, info]) => ({
      user_id: uid,
      qty: info.qty,
      isEquipped: roleIds.length > 0 ? roleMembersSet.has(uid) : (info.isActive === 1)
    }));
    memberRows.sort((a, b) => (b.isEquipped ? 1 : 0) - (a.isEquipped ? 1 : 0));

    const totalPages = Math.max(1, Math.ceil(memberRows.length / PAGE_SIZE));
    if (page > totalPages) page = totalPages;

    // ── Build Tab Row (Row 1 — always shown on all tabs) ──────────────────────
    const tabRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`shop_item_tab_details_${itemId}`)
        .setLabel('Details')
        .setEmoji('ℹ️')
        .setStyle(view === 'details' ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(view === 'details'),
      new ButtonBuilder()
        .setCustomId(`shop_item_appearance_btn_${itemId}`)
        .setLabel('Appearance')
        .setEmoji('🖼️')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`shop_item_tab_config_${itemId}`)
        .setLabel('Config')
        .setEmoji('⚙️')
        .setStyle(view === 'config' ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(view === 'config'),
      new ButtonBuilder()
        .setCustomId(`shop_item_tab_users_${itemId}`)
        .setLabel('Users')
        .setEmoji('👥')
        .setStyle(view === 'users' ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(view === 'users')
    );

    const backFolderId = item.category_id ? `cat_${item.category_id}` : 'cat_null';
    const backBtn = new ButtonBuilder()
      .setCustomId(`shop_edit_item_back_${backFolderId}`)
      .setLabel('Back')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary);

    // Siblings for arrow navigation across items
    let prevSibling = null, nextSibling = null;
    const siblingItems = await getShopItems(interaction.guildId, item.category_id ? item.category_id : 'null', 'name', true);
    let siblingShopItems = siblingItems.filter(i => !i.is_pack && i.item_type !== 'pack' && i.item_type !== 'loot_box');
    siblingShopItems = await sortItemsByRarity(siblingShopItems, interaction.guild);
    if (siblingShopItems.length > 1) {
      const currIndex = siblingShopItems.findIndex(i => String(i.id) === String(item.id));
      prevSibling = currIndex > 0 ? siblingShopItems[currIndex - 1] : null;
      nextSibling = (currIndex >= 0 && currIndex < siblingShopItems.length - 1) ? siblingShopItems[currIndex + 1] : null;
    }

    let embed;
    let components;

    if (view === 'details') {
      // ── Tab 1: Details ────────────────────────────────────────────────────
      // Prereq display
      let prereqDisplay = '``None``';
      if (reqItems && Array.isArray(reqItems) && reqItems.length > 0) {
        const allItems = await getShopItems(interaction.guildId, null, 'name', true);
        const reqDisplays = reqItems.map(id => {
          if (id === 'REQUIRE_BOOSTER' || (typeof id === 'string' && id.startsWith('booster:'))) return '🚀 **Server Booster**';
          if (id === 'REQUIRE_MVP' || (typeof id === 'string' && id.startsWith('mvp:'))) return '🏆 **Active Server MVP**';
          const match = allItems.find(i => String(i.id) === String(id));
          if (!match || !match.role_id) return null;
          return `<@&${match.role_id}>`;
        }).filter(Boolean);
        prereqDisplay = reqDisplays.length > 0 ? reqDisplays.join(', ') : '``None``';
      }

      embed = new EmbedBuilder()
        .setTitle(`Details — ${item.name}`)
        .setDescription(
          `Role: ${roleMention}\n` +
          `Category: \`${categoryDisplay}\`\n` +
          `In Packs: \`${packCount}\``
        )
        .setColor(embedColor);

      const itemImg = getItemImage(item);
      if (itemImg) embed.setThumbnail(itemImg);

      // Row 2: Role select
      const roleRow = new ActionRowBuilder().addComponents(
        new RoleSelectMenuBuilder()
          .setCustomId(`shop_item_role_swap_${itemId}`)
          .setPlaceholder('Swap role…')
      );

      // Row 3: Category select
      const catOptions = [
        { label: 'No Category', value: 'null', emoji: '🏷️', default: !item.category_id },
        ...categories.slice(0, 24).map(c => ({
          label: ((c.name && c.name.trim().length > 0) ? c.name : `Unnamed Category #${c.id}`).slice(0, 100),
          value: c.id.toString(),
          emoji: '📂',
          default: c.id == item.category_id
        }))
      ];
      if (catOptions.length > 25) catOptions.length = 25;
      const catRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`shop_assign_cat_select_manage_${itemId}`)
          .setPlaceholder('Assign to category…')
          .addOptions(catOptions)
      );

      const prevBtn = new ButtonBuilder()
        .setCustomId(prevSibling ? `shop_item_view_details_${prevSibling.id}` : 'shop_item_nav_noop_prev')
        .setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(!prevSibling);
      const nextBtn = new ButtonBuilder()
        .setCustomId(nextSibling ? `shop_item_view_details_${nextSibling.id}` : 'shop_item_nav_noop_next')
        .setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(!nextSibling);

      const navRow = new ActionRowBuilder().addComponents(backBtn, prevBtn, nextBtn);
      components = [tabRow, roleRow, catRow, navRow];

    } else if (view === 'config') {
      // ── Tab 2: Config ─────────────────────────────────────────────────────
      let prereqDisplay = '`None`';
      if (reqItems && Array.isArray(reqItems) && reqItems.length > 0) {
        const allCatalogItems = await getShopItems(interaction.guildId, null, 'name', true);
        const reqDisplays = reqItems.map(id => {
          if (id === 'REQUIRE_BOOSTER' || (typeof id === 'string' && id.startsWith('booster:'))) return '🚀 `Server Booster`';
          if (id === 'REQUIRE_MVP' || (typeof id === 'string' && id.startsWith('mvp:'))) return '🏆 `Active Server MVP`';
          const match = allCatalogItems.find(i => String(i.id) === String(id));
          return match ? `${getItemRarityEmoji(match)} \`${match.name}\`` : null;
        }).filter(Boolean);
        prereqDisplay = reqDisplays.length > 0 ? reqDisplays.join(', ') : '`None`';
      }

      const formattedRarity = (item.rarity || 'common').charAt(0).toUpperCase() + (item.rarity || 'common').slice(1);
      const isTradable = item.is_tradable !== false;
      const typeLockLabel = isTradable ? '`Tradable` 🔓' : '`UnTradable` 🔒';

      embed = new EmbedBuilder()
        .setTitle(`Config — ${item.name}`)
        .setDescription(
          `Rarity: \`${formattedRarity}\`\n` +
          `Requirements: ${prereqDisplay}\n` +
          `Type: ${typeLockLabel}\n` +
          `Duration: \`${durationDisplay}\``
        )
        .setColor(embedColor);

      const itemImg = getItemImage(item);
      if (itemImg) embed.setThumbnail(itemImg);

      // Row 2: Rarity select
      const itemRarity = item.rarity || 'common';
      const rarityRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`shop_edit_rarity_select_${itemId}`)
          .setPlaceholder('Rarity…')
          .addOptions(RARITY_OPTIONS.map(o => ({ ...o, default: o.value === itemRarity })))
      );

      // Row 3: Requirements multi-select
      const allCatalogForReqs = await getShopItems(interaction.guildId, null, 'name', true);
      let catalogItemsForReqs = allCatalogForReqs
        .filter(i => !i.is_pack && i.item_type !== 'pack' && i.item_type !== 'loot_box' && String(i.id) !== String(item.id));

      // Sort catalog items by rarity
      catalogItemsForReqs = await sortItemsByRarity(catalogItemsForReqs, interaction.guild);

      // Map legacy formats to canonical sentinels for pre-selection
      const normalizedReqs = (reqItems || []).map(r => {
        if (r === 'REQUIRE_BOOSTER' || (typeof r === 'string' && r.startsWith('booster:'))) return 'REQUIRE_BOOSTER';
        if (r === 'REQUIRE_MVP' || (typeof r === 'string' && r.startsWith('mvp:'))) return 'REQUIRE_MVP';
        const parsed = parseInt(r, 10);
        return isNaN(parsed) ? null : parsed;
      }).filter(r => r !== null);

      // Partition catalog into selected (pinned at top) and unselected (paginated)
      const selectedCatalog = catalogItemsForReqs.filter(i => normalizedReqs.some(r => String(r) === String(i.id)));
      const unselectedCatalog = catalogItemsForReqs.filter(i => !normalizedReqs.some(r => String(r) === String(i.id)));

      const hasClearAll = normalizedReqs.length > 0;
      const pinnedSelected = selectedCatalog.slice(0, 18);
      const fixedSlotsCount = (hasClearAll ? 1 : 0) + 2 + pinnedSelected.length;
      const maxNavSlots = 2;
      const availableSlots = Math.max(1, 25 - fixedSlotsCount - maxNavSlots);
      const pageSize = availableSlots;
      const totalReqPages = Math.max(1, Math.ceil(unselectedCatalog.length / pageSize));
      const currentReqPage = Math.min(Math.max(1, reqPage || 1), totalReqPages);

      const hasPrev = currentReqPage > 1;
      const hasNext = currentReqPage < totalReqPages;

      const startIndex = (currentReqPage - 1) * pageSize;
      const unselectedSlice = unselectedCatalog.slice(startIndex, startIndex + pageSize);

      const isBoosterActive = normalizedReqs.includes('REQUIRE_BOOSTER');
      const isMvpActive = normalizedReqs.includes('REQUIRE_MVP');

      const reqOptions = [];
      if (hasPrev) {
        reqOptions.push({
          label: 'Previous Page',
          value: `nav_req_page_${currentReqPage - 1}`,
          emoji: '◀️'
        });
      }

      if (hasClearAll) {
        reqOptions.push({
          label: 'Clear All Requirements',
          value: 'clear_all_reqs',
          emoji: '❌'
        });
      }

      reqOptions.push(
        { label: `${isBoosterActive ? '✅ ' : ''}Server Booster`, value: 'toggle_booster', emoji: '🚀' },
        { label: `${isMvpActive ? '✅ ' : ''}Server MVP`, value: 'toggle_mvp', emoji: '🏆' }
      );

      for (const i of pinnedSelected) {
        reqOptions.push({
          label: `✅ ${(i.name || `Item #${i.id}`).slice(0, 96)}`,
          value: `item_${i.id}`,
          emoji: getItemRarityEmoji(i)
        });
      }

      for (const i of unselectedSlice) {
        reqOptions.push({
          label: (i.name || `Item #${i.id}`).slice(0, 100),
          value: `item_${i.id}`,
          emoji: getItemRarityEmoji(i)
        });
      }

      if (hasNext) {
        reqOptions.push({
          label: 'Next Page',
          value: `nav_req_page_${currentReqPage + 1}`,
          emoji: '▶️'
        });
      }

      const reqRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`shop_item_reqs_select_${itemId}_p${currentReqPage}`)
          .setPlaceholder('❗ Requirements…')
          .addOptions(reqOptions.slice(0, 25))
      );

      // Row 4: Tradable/UnTradable toggle + Duration button
      const tradableBtn = new ButtonBuilder()
        .setCustomId(`shop_item_toggle_lock_${itemId}`)
        .setLabel(isTradable ? 'Tradable' : 'UnTradable')
        .setEmoji(isTradable ? '🔓' : '🔒')
        .setStyle(isTradable ? ButtonStyle.Success : ButtonStyle.Danger);

      const durationBtn = new ButtonBuilder()
        .setCustomId(`shop_item_duration_btn_${itemId}`)
        .setLabel('Duration')
        .setEmoji('⏱️')
        .setStyle(ButtonStyle.Secondary);

      const actionRow = new ActionRowBuilder().addComponents(tradableBtn, durationBtn);

      // Row 5: Nav (Back + Prev/Next item)
      const prevBtn2 = new ButtonBuilder()
        .setCustomId(prevSibling ? `shop_item_tab_config_${prevSibling.id}` : 'shop_item_nav_noop_prev')
        .setEmoji('◀️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!prevSibling);
      const nextBtn2 = new ButtonBuilder()
        .setCustomId(nextSibling ? `shop_item_tab_config_${nextSibling.id}` : 'shop_item_nav_noop_next')
        .setEmoji('▶️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!nextSibling);
      const navRow = new ActionRowBuilder().addComponents(backBtn, prevBtn2, nextBtn2);

      components = [tabRow, rarityRow, reqRow, actionRow, navRow];

    } else {
      // ── Tab 3: Users ──────────────────────────────────────────────────────
      const pageSlice = memberRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
      const userLines = pageSlice.length > 0
        ? pageSlice.map(r => `- ${r.isEquipped ? '✅' : '⬜'} <@${r.user_id}> (x${r.qty})`).join('\n')
        : '*No users on this page.*';

      embed = new EmbedBuilder()
        .setTitle(`Users — ${item.name}`)
        .setDescription(`Owned: \`${ownedCount}\`  •  Equipped: \`${equippedCount}\`\n\n${userLines}`)
        .setFooter({ text: `Page ${page} / ${totalPages}` })
        .setColor(embedColor);

      const itemImg = getItemImage(item);
      if (itemImg) embed.setThumbnail(itemImg);

      // Row 2: Revoke button + user list pagination arrows (left & right)
      const hasPagination = memberRows.length > PAGE_SIZE;
      const prevUserPageBtn = new ButtonBuilder()
        .setCustomId(`shop_item_page_prev_${itemId}_p${Math.max(1, page - 1)}`)
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 1);
      const nextUserPageBtn = new ButtonBuilder()
        .setCustomId(`shop_item_page_next_${itemId}_p${Math.min(totalPages, page + 1)}`)
        .setEmoji('➡️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= totalPages || !hasPagination);

      const revokeRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`shop_item_revoke_${itemId}`)
          .setLabel('Revoke')
          .setEmoji('🗑️')
          .setStyle(ButtonStyle.Danger),
        prevUserPageBtn,
        nextUserPageBtn
      );

      // Row 3: Item navigation (Back + Prev/Next item)
      const prevItemBtn = new ButtonBuilder()
        .setCustomId(prevSibling ? `shop_item_tab_users_${prevSibling.id}` : 'shop_item_nav_noop_prev')
        .setEmoji('◀️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!prevSibling);
      const nextItemBtn = new ButtonBuilder()
        .setCustomId(nextSibling ? `shop_item_tab_users_${nextSibling.id}` : 'shop_item_nav_noop_next')
        .setEmoji('▶️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!nextSibling);

      const navRow = new ActionRowBuilder().addComponents(
        backBtn,
        prevItemBtn,
        nextItemBtn
      );

      components = [tabRow, revokeRow, navRow];
    }

    await interaction.editReply({
      content: null,
      embeds: [embed],
      files: [], attachments: [],
      components
    });
  } catch (error) {
    await handleInteractionError(interaction, error, 'edit item select');
  }
}

// Old handleManageItemCategorySelect removed to prevent duplicate declaration
// The active version is defined earlier in the file.

/**
 * Auto-saves rarity change on the Edit Item panel.
 */
export async function handleEditItemRaritySelect(interaction) {
  await interaction.deferUpdate();
  const itemId = interaction.customId.slice('shop_edit_rarity_select_'.length);
  const rarity = interaction.values[0];

  const item = await getShopItem(itemId, interaction.guildId);
  if (!item) return interaction.followUp({ content: '❌ Item not found.', flags: MessageFlags.Ephemeral });

  await updateShopItem(itemId, { rarity }, interaction.guildId);

  const rarityLabel = RARITY_OPTIONS.find(o => o.value === rarity)?.label ?? rarity;
  const mock = {
    deferred: true, replied: false,
    deferUpdate: async () => {},
    editReply: interaction.editReply.bind(interaction),
    followUp: interaction.followUp.bind(interaction),
    customId: `shop_item_tab_config_${itemId}`,
    values: [String(itemId)],
    isAnySelectMenu: () => false,
    guildId: interaction.guildId,
    user: interaction.user,
    guild: interaction.guild,
    member: interaction.member,
    memberPermissions: interaction.memberPermissions
  };
  await handleEditItemSelect(mock, `✅ Rarity set to **${rarityLabel}**.`);
}

/**
 * Auto-saves tradability change on the Edit Item panel.
 */
export async function handleEditItemTradableSelect(interaction) {
  await interaction.deferUpdate();
  const itemId = interaction.customId.slice('shop_edit_tradable_select_'.length);
  const isTradable = interaction.values[0] === 'tradable';

  const item = await getShopItem(itemId, interaction.guildId);
  if (!item) return interaction.followUp({ content: '❌ Item not found.', flags: MessageFlags.Ephemeral });

  await updateShopItem(itemId, { is_tradable: isTradable }, interaction.guildId);

  const tradableLabel = isTradable ? '🔓 Unlocked' : '🔒 Locked';
  const mock = {
    deferred: true, replied: false,
    deferUpdate: async () => {},
    editReply: interaction.editReply.bind(interaction),
    followUp: interaction.followUp.bind(interaction),
    customId: `shop_item_tab_config_${itemId}`,
    values: [String(itemId)],
    isAnySelectMenu: () => false,
    guildId: interaction.guildId,
    user: interaction.user,
    guild: interaction.guild,
    member: interaction.member,
    memberPermissions: interaction.memberPermissions
  };
  await handleEditItemSelect(mock, `✅ Status set to **${tradableLabel}**.`);
}

export async function handleEditItemDetails(interaction) {
  try {
    const itemId = interaction.customId.startsWith('shop_item_edit_details_')
      ? interaction.customId.slice('shop_item_edit_details_'.length)
      : interaction.customId.split('_').pop();
    const item = await getShopItem(itemId, interaction.guildId);

    if (!item) {
      const error = new Error('Item not found');
      return await handleInteractionError(interaction, error, 'edit item details');
    }

    // Security: Ensure this is NOT a pack
    if (item.is_pack || item.item_type === 'pack') {
      return handleEditPackDetails(interaction);
    }

    const modal = new ModalBuilder()
      .setCustomId(`shop_item_modal_edit_${itemId}_item_${Date.now()}`)
      .setTitle('Edit Shop Item');

    const nameInput = new TextInputBuilder().setCustomId('item_name').setStyle(TextInputStyle.Short).setValue(item.name).setRequired(true);
    const nameLabel = new LabelBuilder().setLabel('Name').setTextInputComponent(nameInput);

    const roleInput = new TextInputBuilder().setCustomId('item_role').setStyle(TextInputStyle.Short).setValue(item.role_id || '').setRequired(true);
    const roleLabel = new LabelBuilder().setLabel('Role ID').setTextInputComponent(roleInput);

    const imageUpload = new FileUploadBuilder()
      .setCustomId('item_image_file')
      .setRequired(false);

    const imageLabel = new LabelBuilder()
      .setLabel('Image')
      .setDescription(formatCurrentImageDescription(item.default_image_url || item.image_url))
      .setFileUploadComponent(imageUpload);

    const durInput = new TextInputBuilder().setCustomId('item_duration').setStyle(TextInputStyle.Short).setValue(item.duration_seconds ? String(Math.floor(item.duration_seconds / 86400)) : '').setPlaceholder('Permanent').setRequired(false);
    const durLabel = new LabelBuilder().setLabel('Duration (Days)').setTextInputComponent(durInput);

    // Source of Truth: Pre-fill with Database IDs for consistency
    let reqPreFill = '';
    let reqItems = item.required_items;
    if (typeof reqItems === 'string') {
      try { reqItems = JSON.parse(reqItems); } catch (e) { reqItems = []; }
    }
    if (reqItems && Array.isArray(reqItems) && reqItems.length > 0) {
      const allItems = await getShopItems(interaction.guildId, null, 'name', true);
      reqPreFill = reqItems.map(id => {
        if (typeof id === 'string' && (id.startsWith('booster:') || id.startsWith('mvp:'))) {
          return id.split(':')[1];
        }
        const match = allItems.find(i => i.id === id);
        return match ? match.role_id : id;
      }).join(' ');
    }

    const reqInput = new TextInputBuilder()
      .setCustomId('item_required')
      .setStyle(TextInputStyle.Short)
      .setValue(reqPreFill)
      .setRequired(false)
      .setPlaceholder('Separate IDs by "-", "," or space');
    const reqLabel = new LabelBuilder()
      .setLabel('Requirements (Role IDs)')
      .setDescription('Separate IDs by "-", "," or space')
      .setTextInputComponent(reqInput);

    modal.addLabelComponents(nameLabel, roleLabel, imageLabel, durLabel, reqLabel);

    await interaction.showModal(modal);
  } catch (error) {
    await handleInteractionError(interaction, error, 'edit item details');
  }
}

/**
 * Dedicated Modal for Packs (Name & Price Only)
 */
export async function handleEditPackDetails(interaction) {
  try {
    const packId = interaction.customId.split('_').pop();
    const pack = await getShopItem(packId, interaction.guildId);

    if (!pack) {
      const error = new Error('Pack not found');
      return await handleInteractionError(interaction, error, 'edit pack details');
    }

    const modal = new ModalBuilder()
      .setCustomId(`shop_pack_modal_edit_${packId}`)
      .setTitle('Edit Pack');

    const nameInput = new TextInputBuilder()
      .setCustomId('item_name')
      .setLabel('Name')
      .setStyle(TextInputStyle.Short)
      .setValue(pack.name)
      .setRequired(true);

    modal.addComponents(
      new ActionRowBuilder().addComponents(nameInput)
    );

    await interaction.showModal(modal);
  } catch (error) {
    await handleInteractionError(interaction, error, 'edit pack details');
  }
}

export async function handleEditPackStart(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
    const context = { action: 'edit_pack', folder: 'root', message: null };
    pendingAdminBrowser.set(getAdminBrowserKey(interaction), context);
    await renderAdminBrowser(interaction, context);
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop edit pack start');
  }
}

export async function handleEditLootBoxStart(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
    const context = { action: 'edit_lootbox', folder: 'root', message: null };
    pendingAdminBrowser.set(getAdminBrowserKey(interaction), context);
    await renderAdminBrowser(interaction, context);
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop edit lootbox start');
  }
}

export async function handleEditPackSelect(interaction, successHeader = null) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => { });
  try {
    // Determine packId from select menu or customId
    let packId;
    if (interaction.isAnySelectMenu()) {
      packId = interaction.values[0];
    } else {
      packId = interaction.customId.split('_').pop();
    }

    const item = await getShopItem(packId, interaction.guildId);
    if (!item) return interaction.followUp({ content: '❌ Pack not found.', flags: MessageFlags.Ephemeral });

    // Resolve Role Mentions for display
    let contentsDisplay = '``None``';
    if (item.role_id) {
      const roles = item.role_id.split(/[,\s]+/).filter(r => r.trim().length > 0);
      if (roles.length > 0) {
        contentsDisplay = roles.map(id => `<@&${id}>`).join(' ');
      }
    }

    const embed = new EmbedBuilder()
      .setTitle(`Edit Pack: ${item.name}`)
      .setDescription(`**Contents:** ${contentsDisplay}`)
      .setColor('#8E44AD'); // Purple for packs

    const actionRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`shop_pack_add_${packId}`)
        .setLabel('Add Items')
        .setEmoji('➕')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`shop_pack_remove_${packId}`)
        .setLabel('Remove Items')
        .setEmoji('➖')
        .setStyle(ButtonStyle.Danger)
    );

    const backRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('shop_edit_pack_start')
        .setLabel('Back')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`shop_pack_edit_${packId}`) // Rename / Price Modal
        .setLabel('Edit')
        .setEmoji('✏️')
        .setStyle(ButtonStyle.Primary)
    );

    await interaction.editReply({ files: [], attachments: [], content: successHeader || null, 
      embeds: [embed], 
      components: [actionRow, backRow] });
  } catch (error) {
    await handleInteractionError(interaction, error, 'edit pack select');
  }
}

export async function handlePackAddContentStart(interaction, layer = 'root', messageStr = null, page = 1) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
    const packId = interaction.customId.split('_').pop();
    const pack = await getShopItem(packId, interaction.guildId);

    // Get items NOT in pack
    let currentContentIds = pack.contents;
    if (typeof currentContentIds === 'string') {
      try { currentContentIds = JSON.parse(currentContentIds); } catch (e) { currentContentIds = []; }
    }
    if (!Array.isArray(currentContentIds)) currentContentIds = [];

    // Fetch all ITEMS (not packs)
    const allItems = await getShopItems(interaction.guildId, null, 'name', true);
    const availableItems = allItems.filter(i => !i.is_pack && i.role_id && !currentContentIds.includes(i.id));

    if (availableItems.length === 0 && layer === 'root') {
      const emptyRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`shop_pack_manage_${packId}`)
          .setLabel('Back')
          .setEmoji('⬅️')
          .setStyle(ButtonStyle.Secondary)
      );

      const emptyEmbed = new EmbedBuilder()
        .setColor('#95A5A6')
        .setDescription('No items found.');

      return interaction.editReply({ files: [], attachments: [], content: (messageStr && (messageStr.startsWith('✅') || messageStr.startsWith('❌'))) ? messageStr : null,
        components: [emptyRow], 
        embeds: [emptyEmbed] });
    }

    let selectMenuToRender = null;
    const pageNum = typeof page === 'number' ? page : (parseInt(page, 10) || 1);

    if (layer === 'root') {
      // --- LAYER 0: ROOT SELECTION ---
      const hasCategorized = availableItems.some(i => i.category_id);
      const hasUncategorized = availableItems.some(i => !i.category_id);
      
      const rootOptions = [];
      if (hasCategorized) rootOptions.push({ label: 'Categorized Items', value: 'layer_browse_categorized', emoji: '📂' });
      if (hasUncategorized) rootOptions.push({ label: 'Uncategorized Items', value: 'layer_browse_uncategorized', emoji: '🏷️' });

      if (rootOptions.length === 0) {
        const emptyEmbed = new EmbedBuilder().setColor('#95A5A6').setDescription('No items found.');
        return interaction.editReply({ 
          content: (messageStr && (messageStr.startsWith('✅') || messageStr.startsWith('❌'))) ? messageStr : null,
          components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`shop_pack_manage_${packId}`).setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary))], 
          embeds: [emptyEmbed] 
        });
      }

      selectMenuToRender = new StringSelectMenuBuilder()
        .setCustomId(`shop_pack_add_content_select_${packId}`)
        .setPlaceholder('Select')
        .addOptions(rootOptions);
    } 
    else if (layer === 'browse_categorized') {
      // --- LAYER 1: CATEGORY LIST ---
      const categories = await getShopCategories(interaction.guildId);
      const activeCats = categories.filter(cat => availableItems.some(i => i.category_id === cat.id));
      
      const { selectMenu } = buildPaginatedSelectMenu({
        items: activeCats,
        page: pageNum,
        customId: `shop_pack_add_content_select_${packId}`,
        placeholder: 'Select',
        backOption: {
          label: 'Back',
          value: 'action_back_root',
          emoji: '⬅️'
        },
        pageNavPrefix: `pack_add_cat_nav_${packId}_`,
        pageSize: 20,
        mapOption: cat => ({
          label: cat.name.slice(0, 100),
          value: `cat_${cat.id}`,
          emoji: '📂'
        })
      });
      selectMenuToRender = selectMenu;
    }
    else if (layer === 'browse_uncategorized') {
      // --- LAYER 1: UN-CATEGORIZED ITEMS ---
      const standaloneItems = availableItems.filter(i => !i.category_id);
      const sortedStandalone = await sortItemsByRarity(standaloneItems, interaction.guild);
      
      const { selectMenu } = buildPaginatedSelectMenu({
        items: sortedStandalone,
        page: pageNum,
        customId: `shop_pack_add_content_select_${packId}`,
        placeholder: 'Select',
        backOption: {
          label: 'Back',
          value: 'action_back_root',
          emoji: '⬅️'
        },
        pageNavPrefix: `pack_add_item_nav_${packId}_uncat_`,
        pageSize: 20,
        mapOption: i => ({
          label: ((i.name && i.name.trim().length > 0) ? i.name : `Unnamed Item #${i.id}`).slice(0, 100), 
          value: `item_${i.id}`,
          emoji: getItemRarityEmoji(i)
        })
      });
      selectMenuToRender = selectMenu;
    }
    else if (typeof layer === 'number' || !isNaN(parseInt(layer))) {
      // --- LAYER 2: ITEMS INSIDE A CATEGORY ---
      const categoryId = parseInt(layer);
      const itemsInCat = availableItems.filter(i => i.category_id === categoryId);
      const sortedInCat = await sortItemsByRarity(itemsInCat, interaction.guild);
      
      const { selectMenu } = buildPaginatedSelectMenu({
        items: sortedInCat,
        page: pageNum,
        customId: `shop_pack_add_content_select_${packId}`,
        placeholder: 'Select',
        backOption: {
          label: 'Back',
          value: 'layer_browse_categorized',
          emoji: '⬅️'
        },
        pageNavPrefix: `pack_add_item_nav_${packId}_${categoryId}_`,
        pageSize: 20,
        mapOption: i => ({ 
          label: ((i.name && i.name.trim().length > 0) ? i.name : `Unnamed Item #${i.id}`).slice(0, 100), 
          value: `item_${i.id}`,
          emoji: getItemRarityEmoji(i)
        })
      });
      selectMenuToRender = selectMenu;
    }

    // External Back button always returns directly to the Pack Manage dashboard
    const packBackCustomId = `shop_pack_manage_${packId}`;

    const rowBack = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(packBackCustomId)
        .setLabel('Back')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary)
    );

    const row = new ActionRowBuilder().addComponents(selectMenuToRender);

    const embedPrompt = new EmbedBuilder()
      .setColor('#3498DB')
      .setTitle('Select Item(s) to Add to Pack');

    await interaction.editReply({ files: [], attachments: [], content: (messageStr && (messageStr.startsWith('✅') || messageStr.startsWith('❌'))) ? messageStr : null,
        components: [row, rowBack],
        embeds: [embedPrompt] });
  } catch (error) {
    console.error('CRITICAL ADMIN ERROR DETAILS:', error);
    await handleInteractionError(interaction, error, 'pack add content start');
  }
}

export async function handlePackAddContentSelect(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
    const packId = interaction.customId.split('_').pop();
    const selection = interaction.values[0];

    if (!packId || isNaN(parseInt(packId))) {
      return interaction.followUp({ content: '❌ Invalid Pack ID.', flags: MessageFlags.Ephemeral });
    }

    // Handle Pagination Navigation
    if (selection.startsWith(`pack_add_cat_nav_${packId}_`)) {
      const page = parseInt(selection.split('_').pop(), 10) || 1;
      return handlePackAddContentStart(interaction, 'browse_categorized', null, page);
    }
    if (selection.startsWith(`pack_add_item_nav_${packId}_uncat_`)) {
      const page = parseInt(selection.split('_').pop(), 10) || 1;
      return handlePackAddContentStart(interaction, 'browse_uncategorized', null, page);
    }
    if (selection.startsWith(`pack_add_item_nav_${packId}_`)) {
      const parts = selection.split('_');
      const catId = parseInt(parts[parts.length - 2], 10);
      const page = parseInt(parts[parts.length - 1], 10) || 1;
      return handlePackAddContentStart(interaction, catId, null, page);
    }

    // Handle Folder Navigation
    if (selection === 'action_back_root') {
      return handlePackAddContentStart(interaction, 'root');
    }
    if (selection.startsWith('layer_')) {
      const layer = selection.replace('layer_', '');
      return handlePackAddContentStart(interaction, layer);
    }
    if (selection.startsWith('cat_')) {
      const categoryId = parseInt(selection.replace('cat_', ''));
      return handlePackAddContentStart(interaction, categoryId);
    }
    if (selection === 'empty_layer') {
      return; // Do nothing
    }

    // Handle Item Selection
    if (!selection.startsWith('item_')) return;
    const itemId = parseInt(selection.replace('item_', ''));

    const item = await getShopItem(itemId, interaction.guildId);
    const pack = await getShopItem(packId, interaction.guildId);

    if (!pack) {
      return interaction.followUp({ content: '❌ Pack not found.', flags: MessageFlags.Ephemeral });
    }

    // Update contents array
    let currentContents = pack.contents;
    if (typeof currentContents === 'string') {
      try { currentContents = JSON.parse(currentContents); } catch (e) { currentContents = []; }
    }
    if (!Array.isArray(currentContents)) currentContents = [];
    const newContents = [...new Set([...currentContents, itemId])];

    // Update role_ids
    let currentRoles = pack.role_id ? pack.role_id.split(/[,\s]+/) : [];
    if (item && item.role_id) {
      const newRoles = item.role_id.split(/[,\s]+/);
      currentRoles = [...new Set([...currentRoles, ...newRoles])];
    }
    const newRoleId = currentRoles.join(' ');

    const addedItemName = item ? item.name : 'Item';
    const packName = pack ? pack.name : 'Pack';

    // EXECUTE UPDATE
    await updateShopItem(packId, { contents: newContents, role_id: newRoleId }, interaction.guildId);

    // Standardized Shop Admin Log
    sendLog(interaction.guild, 'shop', 'blue', '📦 Item Added to Pack', `Admin **<@${interaction.user.id}>** added item **${addedItemName}** to pack **${packName}**`);

    // Call current layer again with success message
    const currentLayer = item.category_id || 'browse_uncategorized';
    return handlePackAddContentStart(interaction, currentLayer, `✅ **${addedItemName}** added to **${packName}**.`);

  } catch (error) {
    console.error('CRITICAL ADMIN ERROR DETAILS:', error);
    await handleInteractionError(interaction, error, 'pack add content select');
  }
}

export async function handlePackRemoveContentStart(interaction, messageStr = null, page = 1) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
    const packId = interaction.customId.split('_').pop();
    const pack = await getShopItem(packId, interaction.guildId);

    let currentContentIds = pack.contents;
    if (typeof currentContentIds === 'string') {
      try { currentContentIds = JSON.parse(currentContentIds); } catch (e) { currentContentIds = []; }
    }
    if (!Array.isArray(currentContentIds)) currentContentIds = [];

    if (currentContentIds.length === 0) {
      const emptyRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`shop_pack_manage_${packId}`)
          .setLabel('Back')
          .setEmoji('⬅️')
          .setStyle(ButtonStyle.Secondary)
      );

      const emptyEmbed = new EmbedBuilder()
        .setColor('#95A5A6')
        .setDescription('No items found.');

      return interaction.editReply({ files: [], attachments: [], content: (messageStr && (messageStr.startsWith('✅') || messageStr.startsWith('❌'))) ? messageStr : null,
        components: [emptyRow], 
        embeds: [emptyEmbed] });
    }

    // Fetch names of items in pack
    const allItems = await getShopItems(interaction.guildId, null, 'name', true);
    const contentIds = currentContentIds.map(id => parseInt(id));
    const packItems = allItems.filter(i => contentIds.includes(i.id));
    const sortedPackItems = await sortItemsByRarity(packItems, interaction.guild);

    const pageNum = typeof page === 'number' ? page : (parseInt(page, 10) || 1);
    const { selectMenu } = buildPaginatedSelectMenu({
      items: sortedPackItems,
      page: pageNum,
      customId: `shop_pack_remove_content_select_${packId}`,
      placeholder: 'Select',
      pageNavPrefix: `pack_rem_nav_${packId}_`,
      pageSize: 20,
      mapOption: i => ({
        label: ((i.name && i.name.trim().length > 0) ? i.name : `Unnamed Item #${i.id}`).slice(0, 100), 
        value: `item_${i.id}`,
        emoji: getItemRarityEmoji(i)
      })
    });

    const row = new ActionRowBuilder().addComponents(selectMenu);
    const rowBack = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`shop_pack_manage_${packId}`)
        .setLabel('Back')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary)
    );

    const embedPrompt = new EmbedBuilder()
      .setColor('#E74C3C')
      .setTitle('Select Item(s) to Remove from Pack');

    await interaction.editReply({ files: [], attachments: [], content: (messageStr && (messageStr.startsWith('✅') || messageStr.startsWith('❌'))) ? messageStr : null,
        components: [row, rowBack],
        embeds: [embedPrompt] });
  } catch (error) {
    console.error('CRITICAL ADMIN ERROR DETAILS:', error);
    await handleInteractionError(interaction, error, 'pack remove content start');
  }
}

export async function handlePackRemoveContentSelect(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
    const packId = interaction.customId.split('_').pop();
    const selection = interaction.values[0];

    // Handle pagination navigation
    if (selection.startsWith(`pack_rem_nav_${packId}_`)) {
      const page = parseInt(selection.split('_').pop(), 10) || 1;
      return handlePackRemoveContentStart(interaction, null, page);
    }

    if (!packId || isNaN(parseInt(packId))) {
      return interaction.followUp({ content: '❌ Invalid Pack ID.', flags: MessageFlags.Ephemeral });
    }

    // Handle Item Selection
    if (!selection.startsWith('item_')) return;
    const itemId = parseInt(selection.replace('item_', ''));

    // 1. Update contents array
    const pack = await getShopItem(packId, interaction.guildId);
    if (!pack) {
      return interaction.followUp({ content: '❌ Pack not found.', flags: MessageFlags.Ephemeral });
    }

    let currentContents = pack.contents;
    if (typeof currentContents === 'string') {
      try { currentContents = JSON.parse(currentContents); } catch (e) { currentContents = []; }
    }
    if (!Array.isArray(currentContents)) currentContents = [];

    const newContents = currentContents.filter(id => id !== itemId);

    // 2. Update role_ids
    const allItems = await getShopItems(interaction.guildId, null, 'name', true);
    const newPackItems = allItems.filter(i => newContents.includes(i.id));
    
    let newRoles = [];
    for (const pItem of newPackItems) {
      if (pItem.role_id) {
        newRoles.push(...pItem.role_id.split(/[,\s]+/));
      }
    }
    const newRoleId = [...new Set(newRoles)].join(' ');

    const itemObj = allItems.find(i => i.id === itemId);
    const removedItemName = itemObj ? itemObj.name : `Item #${itemId}`;
    const packName = pack.name || 'Pack';

    // EXECUTE UPDATE
    await updateShopItem(packId, { contents: newContents, role_id: newRoleId }, interaction.guildId);

    // Standardized Shop Admin Log
    sendLog(interaction.guild, 'shop', 'red', '📦 Item Removed from Pack', `Admin **<@${interaction.user.id}>** removed item **${removedItemName}** from pack **${packName}**`);

    // Re-render the flat list
    return handlePackRemoveContentStart(interaction, `✅ **${removedItemName}** removed from **${packName}**.`);

  } catch (error) {
    console.error('CRITICAL ADMIN ERROR DETAILS:', error);
    await handleInteractionError(interaction, error, 'pack remove content select');
  }
}

// --- GATEWAY INTERSTITIAL PANEL ---
export async function handleShopPostGate(interaction) {
  try {
    const sessionId = getPostSessionId(interaction);
    await deletePendingPostSession(sessionId);

    if (!interaction.deferred && !interaction.replied) {
      if (interaction.isMessageComponent && interaction.isMessageComponent()) {
        await interaction.deferUpdate();
      } else {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      }
    }

    const embed = new EmbedBuilder()
      .setColor('#9B59B6')
      .setTitle('Shop Posting Options')
      .setDescription('Choose to publish a new shop item or edit an existing post.');

    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`shop_admin_home:${sessionId}`)
          .setLabel('Back')
          .setEmoji('⬅️')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`shop_post_edit_layout:${sessionId}`)
          .setLabel('Edit Post')
          .setEmoji('📝')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`shop_post_new_layout:${sessionId}`)
          .setLabel('New Post')
          .setEmoji('➕')
          .setStyle(ButtonStyle.Success)
      );

    await interaction.editReply({ files: [], attachments: [], content: null, embeds: [embed], components: [row] });
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop post gate');
  }
}

export async function handleShopPostNewLayout(interaction) {
  try {
    const sessionId = getPostSessionId(interaction);
    
    // Initialize/Reset session state for New Post
    await setPendingPostSession(sessionId, {
      itemId: null,
      channelId: null,
      sellerId: null,
      payout: null,
      stock: null,
      description: null,
      imageUrl: null,
      overridePrice: 0,
      postStep: 0,
      postFilter: null,
      isEditing: false,
      stockConfigured: false,
      stockModified: false,
      fromGateway: true
    });

    await handleShopPostStart(interaction);
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop post new layout');
  }
}

export async function handleShopPostEditLayout(interaction) {
  try {
    const sessionId = getPostSessionId(interaction);
    await deletePendingPostSession(sessionId);
    const modal = new ModalBuilder()
      .setCustomId(`shop_edit_post_url_modal:${sessionId}`)
      .setTitle('Edit Shop Post');

    const urlInput = new TextInputBuilder()
      .setCustomId('message_url')
      .setLabel('Discord Message URL')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('https://discord.com/channels/123456789012345678/123456789012345678/123456789012345678')
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(urlInput));
    await interaction.showModal(modal);
  } catch (error) {
    await handleInteractionError(interaction, error, 'show edit post modal');
  }
}

export async function handleShopEditPostUrlSubmit(interaction) {
  try {
    // Defer update safely to target the original choice panel message
    if (!await safeDeferUpdate(interaction)) return;

    const url = (interaction.fields.getTextInputValue('message_url') || '').trim();

    // Parse URL: https://discord.com/channels/guildId/channelId/messageId
    const match = url.match(/channels\/(\d+)\/(\d+)\/(\d+)/);
    if (!match) {
      return interaction.followUp({ content: '❌ Invalid Message URL', flags: MessageFlags.Ephemeral });
    }

    const [_, guildId, channelId, messageId] = match;

    // Security Gate: Server validation
    if (guildId !== interaction.guildId) {
      return interaction.followUp({ content: '❌ Invalid Message URL', flags: MessageFlags.Ephemeral });
    }

    // Fetch Channel & Message
    const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      return interaction.followUp({ content: '❌ Invalid Message URL: Channel not found or bot lacks permissions.', flags: MessageFlags.Ephemeral });
    }

    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (!message) {
      return interaction.followUp({ content: '❌ Invalid Message URL: Message could not be found.', flags: MessageFlags.Ephemeral });
    }

    // Author verification
    if (message.author.id !== interaction.client.user.id) {
      return interaction.followUp({ content: '❌ Invalid Message URL: Message was not posted by this bot.', flags: MessageFlags.Ephemeral });
    }

    // Check shop_posts tracking first to ensure resilience even if message components are stripped
    let postRow = null;
    if (messageId) {
      try {
        const spRes = await query(
          `SELECT custom_image_url, post_mode, auto_equip, claim_limit_per_user, restock_interval_seconds, max_stock, current_stock, override_price, last_restocked_at, created_at, item_id, custom_description
           FROM shop_posts WHERE message_id = $1 LIMIT 1`,
          [messageId]
        );
        if (spRes.rows.length > 0) {
          postRow = spRes.rows[0];
        }
      } catch (_) {}
    }

    // Signature verification (Find Buy Button: bank_shop_buy_ or force_buy_)
    let buyButton = null;
    if (Array.isArray(message.components)) {
      for (const row of message.components) {
        if (Array.isArray(row.components)) {
          for (const component of row.components) {
            if (component.type === 2 && component.customId && (component.customId.startsWith('bank_shop_buy_') || component.customId.startsWith('force_buy_'))) {
              buyButton = component;
              break;
            }
          }
        }
        if (buyButton) break;
      }
    }

    if (!buyButton && !postRow) {
      return interaction.followUp({ content: '❌ Invalid Message URL: Not a valid shop post message.', flags: MessageFlags.Ephemeral });
    }

    // Parse customId parts if buyButton is available: bank_shop_buy_[itemId]_[sellerId]_[payout]_[overridePrice]
    let parsedItemId = null;
    let sellerId = null;
    let payout = null;
    let overridePrice = null;

    if (buyButton && buyButton.customId) {
      const parts = buyButton.customId.split('_');
      // bank(0) shop(1) buy(2) [itemId](3) [sellerId](4) [payout](5) [overridePrice](6)
      // OR force(0) buy(1) [itemId](2) [sellerId](3) [payout](4) [overridePrice](5)
      const isForce = buyButton.customId.startsWith('force_buy_');
      const itemIdx = isForce ? 2 : 3;
      const sellerIdx = isForce ? 3 : 4;
      const payoutIdx = isForce ? 4 : 5;
      const priceIdx = isForce ? 5 : 6;

      parsedItemId = parseInt(parts[itemIdx], 10);
      sellerId = parts[sellerIdx] === '0' ? null : parts[sellerIdx];
      payout = parts[payoutIdx] === '0' ? null : parseInt(parts[payoutIdx], 10);
      overridePrice = (parts[priceIdx] !== undefined && parts[priceIdx] !== '' && !isNaN(parseInt(parts[priceIdx], 10))) ? parseInt(parts[priceIdx], 10) : null;
    }

    const resolvedItemId = (postRow && postRow.item_id) ? postRow.item_id : parsedItemId;

    // Verify item exists in DB using resolvedItemId
    const item = await getShopItem(resolvedItemId, guildId);
    if (!item) {
      return interaction.followUp({ content: '❌ Invalid Message URL: Target item no longer exists in shop catalog.', flags: MessageFlags.Ephemeral });
    }

    const firstEmbed = message.embeds[0];
    let embedDescription = firstEmbed?.description || null;
    let embedImageUrl = firstEmbed?.image?.url || postRow?.custom_image_url || null;

    const defaultImage = await resolveItemDefaultImage(item, guildId);
    const imageUrl = (embedImageUrl && !isSameImageUrl(embedImageUrl, defaultImage)) ? embedImageUrl : null;

    // Preserve description priority:
    // 1. Existing embed description (if genuine and not an error message)
    // 2. postRow.custom_description
    // 3. item.description
    const isCorruptedDesc = embedDescription && (
      embedDescription.includes('Action Execution Failed') ||
      embedDescription.includes('❌') ||
      embedDescription.includes('Missing Permissions')
    );
    const cleanEmbedDesc = (embedDescription && !isCorruptedDesc)
      ? embedDescription.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim() || null
      : null;
    const description = cleanEmbedDesc || postRow?.custom_description || item.description || null;

    // Stock priority: postRow.max_stock if tracked in shop_posts (original stock before anyone bought it),
    // then embed scraped stock / max stock, then catalog stock
    let scrapedStock = item.stock;
    let embedMaxStock = null;
    let embedCurrentStock = null;

    if (firstEmbed && firstEmbed.fields) {
      const stockField = firstEmbed.fields.find(f => f.name && (f.name.includes('Stock') || f.name.includes('Out Of Stock') || f.name.includes('Unlimited')));
      if (stockField) {
        const val = stockField.value || '';
        const nameVal = stockField.name || '';
        if (val.includes('Unlimited') || nameVal.includes('Unlimited')) {
          scrapedStock = null;
          embedMaxStock = null;
          embedCurrentStock = null;
        } else if (nameVal.includes('Out Of Stock') || val.includes('Sold Out') || val.includes('All Claimed')) {
          embedCurrentStock = 0;
          scrapedStock = 0;
        } else {
          const slashMatch = nameVal.match(/(\d+)\s*\/\s*(\d+)/) || val.match(/(\d+)\s*\/\s*(\d+)/);
          if (slashMatch) {
            embedCurrentStock = parseInt(slashMatch[1], 10);
            embedMaxStock = parseInt(slashMatch[2], 10);
            scrapedStock = embedMaxStock;
          } else {
            const nameMatch = nameVal.match(/🟢\s*(\d+)(?:\/\d+)?\s*In Stock/i) || val.match(/\*\*(\d+)\*\*/);
            if (nameMatch) {
              embedCurrentStock = parseInt(nameMatch[1], 10);
              scrapedStock = embedCurrentStock;
            }
          }
        }
      }
    }

    // Original stock before anyone bought the item:
    const configuredStock = (postRow && postRow.max_stock !== null && postRow.max_stock !== undefined)
      ? Number(postRow.max_stock)
      : (embedMaxStock ?? scrapedStock ?? null);
    const liveRemainingStock = (postRow && postRow.current_stock !== undefined) ? postRow.current_stock : (embedCurrentStock ?? configuredStock);

    const autoEquip = postRow?.auto_equip === true;
    const claimLimit = postRow?.claim_limit_per_user || null;
    const restockIntervalSeconds = (postRow?.restock_interval_seconds && postRow.restock_interval_seconds > 0) ? postRow.restock_interval_seconds : null;
    const maxStock = configuredStock;
    const postMode = (postRow?.post_mode === 'drop') ? 'drop' : 'normal';

    // Price Resolution Priority:
    // 1. Direct visible truth from the Buy/Claim Button label
    // 2. Tracked database override_price
    // 3. Button customId encoded overridePrice (parts[6])
    // 4. Catalog item.price fallback
    let effectiveEditPrice = null;

    if (buyButton && buyButton.label) {
      const lbl = buyButton.label.trim();
      if (lbl === 'CLAIM' || /free/i.test(lbl)) {
        effectiveEditPrice = 0;
      } else {
        const buyMatch = lbl.match(/BUY\s*\(([\d,]+)\)/i);
        if (buyMatch) {
          effectiveEditPrice = parseInt(buyMatch[1].replace(/,/g, ''), 10);
        }
      }
    }

    if (effectiveEditPrice === null && postRow && postRow.override_price !== null && postRow.override_price !== undefined) {
      effectiveEditPrice = Number(postRow.override_price);
    }

    if (effectiveEditPrice === null && overridePrice !== null && !isNaN(overridePrice)) {
      effectiveEditPrice = overridePrice;
    }

    if (effectiveEditPrice === null) {
      effectiveEditPrice = (item.price !== null && item.price !== undefined) ? Number(item.price) : 0;
    }

    // Initialize state
    const sessionId = getPostSessionId(interaction);
    await deletePendingPostSession(sessionId);
    await setPendingPostSession(sessionId, {
      itemId: resolvedItemId,
      channelId,
      sellerId,
      payout,
      description,
      imageUrl,
      overridePrice: effectiveEditPrice,
      originalPrice: effectiveEditPrice,
      stock: configuredStock,
      originalStock: configuredStock,
      stockConfigured: true,
      stockModified: false,
      isEditing: true,
      fromGateway: true,
      messageId,
      messageUrl: url,
      postStep: 0,
      postFilter: null,
      postMode,
      autoEquip,
      claimLimit,
      restockIntervalSeconds,
      maxStock: configuredStock,
      liveCurrentStock: liveRemainingStock,
      lastRestockedAt: postRow?.last_restocked_at || null,
      createdAt: postRow?.created_at || null,
      originalRestockIntervalSeconds: restockIntervalSeconds,
      originalClaimLimit: claimLimit,
      originalLastRestockedAt: postRow?.last_restocked_at || null,
      originalCreatedAt: postRow?.created_at || null,
      originalPostMode: postMode
    });

    const mock = {
      _postSessionId: sessionId,
      customId: interaction.customId,
      message: interaction.message,
      deferred: true,
      replied: true,
      deferUpdate: async () => {},
      editReply: interaction.editReply.bind(interaction),
      followUp: interaction.followUp.bind(interaction),
      guildId: interaction.guildId,
      guild: interaction.guild,
      user: interaction.user,
      member: interaction.member,
      memberPermissions: interaction.memberPermissions
    };

    await handleShopPostStart(mock);
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop edit post url submit');
  }
}

export async function handleShopPostUpdate(interaction) {
  try {
    const sessionId = getPostSessionId(interaction);
    const state = await getPendingPostSession(sessionId);

    if (!state || !state.itemId || !state.channelId || !state.messageId || !state.isEditing) {
      return handleInteractionError(interaction, new Error('Validation Failed: Missing required parameters for updating'), 'shop post update');
    }

    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

    const { itemId, channelId, messageId, sellerId, imageUrl, description, payout, stock, overridePrice } = state;
    const item = await getShopItem(itemId, interaction.guildId);
    if (!item) {
      return interaction.followUp({ content: '❌ Item not found in database.', flags: MessageFlags.Ephemeral });
    }

    // Price defaults to overridePrice, item.price, or 0 (0 = free)
    const effectivePrice = (overridePrice !== null && overridePrice !== undefined)
      ? Number(overridePrice)
      : (item.price !== null && item.price !== undefined ? Number(item.price) : 0);

    const isFree = effectivePrice === 0;

    const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      return interaction.followUp({ content: '❌ Channel not found.', flags: MessageFlags.Ephemeral });
    }

    const botMember = interaction.guild.members.me;
    const diag = diagnoseChannelPermissions(channel, botMember, [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks
    ]);

    if (!diag.hasAll) {
      return handleInteractionError(
        interaction,
        new Error(`Missing Permissions in <#${channelId}>: ${diag.missing.join(', ')}`),
        `Update Shop Post in <#${channelId}>`,
        { targetChannel: channel }
      );
    }

    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (!message) {
      return interaction.followUp({ content: '❌ Message not found.', flags: MessageFlags.Ephemeral });
    }

    // Fetch live post row from database to avoid overwriting background restocks occurred during editing
    const pool = (await import('../storage/postgres.js')).getPool();
    let livePostRow = null;
    if (messageId) {
      try {
        const liveRes = await pool.query(
          `SELECT restock_interval_seconds, claim_limit_per_user, last_restocked_at, created_at, current_stock, max_stock, post_mode
           FROM shop_posts WHERE message_id = $1 LIMIT 1`,
          [messageId]
        );
        if (liveRes.rows.length > 0) {
          livePostRow = liveRes.rows[0];
        }
      } catch (_) {}
    }

    // Post-level stock and price: isolated per post to prevent cross-channel contamination of catalog items
    // If the administrator did NOT explicitly modify stock during this editing session,
    // preserve live database stock to avoid rolling back concurrent purchases or background restocks.
    const stagedStock = (state.stock !== null && state.stock !== undefined && state.stock > 0) ? state.stock : null;
    const postStock = (!state.stockModified && livePostRow && livePostRow.current_stock !== undefined)
      ? livePostRow.current_stock
      : stagedStock;

    // Build the updated embed
    const embed = new EmbedBuilder()
      .setTitle(item.name)
      .setColor('#3498DB');

    // Image: instance-specific override takes priority, then item's default image
    const defaultImg = await resolveItemDefaultImage(item, interaction.guildId);
    const isCustom = Boolean(imageUrl && !isSameImageUrl(imageUrl, defaultImg));
    const finalImage = isCustom ? imageUrl : defaultImg;
    if (finalImage) {
      embed.setImage(finalImage);
    }

    const finalDescription = description || item.description;
    if (finalDescription) {
      embed.setDescription(finalDescription);
    }

    if (item.item_type === 'pack') {
      const count = item.contents ? item.contents.length : 0;
      embed.addFields({ name: '📦 Contents', value: `**${count}** Items`, inline: true });
    } else if (item.item_type === 'loot_box' || item.loot_box_id) {
      // Loot Box / Chest: Do NOT add 🏷️ Item or ⏳ Duration fields
    } else {
      if (item.role_id) {
        embed.addFields({ name: '🏷️ Item', value: `<@&${item.role_id}>`, inline: true });
      } else {
        embed.addFields({ name: '🏷️ Item', value: item.name, inline: true });
      }

      let durationText = 'Permanent';
      if (item.duration_seconds) {
        const days = Math.floor(item.duration_seconds / 86400);
        const hours = Math.floor((item.duration_seconds % 86400) / 3600);
        if (days > 0) {
          durationText = `${days} Day${days !== 1 ? 's' : ''}`;
          if (hours > 0) durationText += ` ${hours} Hour${hours !== 1 ? 's' : ''}`;
        } else if (hours > 0) {
          durationText = `${hours} Hour${hours !== 1 ? 's' : ''}`;
        } else {
          const minutes = Math.floor(item.duration_seconds / 60);
          durationText = `${minutes} Minute${minutes !== 1 ? 's' : ''}`;
        }
      }
      embed.addFields({ name: '⏳ Duration', value: durationText, inline: true });
    }

    const autoEquip = state.autoEquip === true;
    const hasTimer = Boolean(state.restockIntervalSeconds && state.restockIntervalSeconds > 0);
    const hasLimit = Boolean(state.claimLimit && state.claimLimit > 0);
    const effectivePostMode = hasTimer ? 'auto' : (hasLimit ? 'drop' : 'normal');
    const claimLimit = hasLimit ? state.claimLimit : null;
    const restockIntervalSeconds = hasTimer ? state.restockIntervalSeconds : null;
    const maxStock = (!state.stockModified && livePostRow && livePostRow.max_stock !== undefined)
      ? livePostRow.max_stock
      : (state.stock !== null ? state.stock : null);

    const previousInterval = (state.originalRestockIntervalSeconds !== undefined)
      ? state.originalRestockIntervalSeconds
      : (livePostRow?.restock_interval_seconds || null);
    const currentInterval = hasTimer ? state.restockIntervalSeconds : null;
    const timerChanged = currentInterval !== previousInterval;

    const previousClaimLimit = (state.originalClaimLimit !== undefined)
      ? state.originalClaimLimit
      : (livePostRow?.claim_limit_per_user || null);
    const claimLimitChanged = (claimLimit ?? null) !== (previousClaimLimit ?? null);

    let lastRestockedAt = null;
    if (hasTimer) {
      if (!timerChanged) {
        // Timer was not changed: preserve existing cycle timestamp without resetting
        lastRestockedAt = livePostRow?.last_restocked_at || state.lastRestockedAt || livePostRow?.created_at || state.createdAt || new Date();
      } else {
        // Timer was explicitly modified: start new cycle from update moment
        lastRestockedAt = new Date();
      }
    }

    const isSoldOut = postStock !== null && postStock !== undefined && postStock <= 0;
    let stockHeader = '♾️ Unlimited';
    let stockValue = 'Available';
    if (hasTimer) {
      const baseTime = new Date(lastRestockedAt).getTime();
      let nextRestockMs = baseTime + (restockIntervalSeconds * 1000);
      if (nextRestockMs <= Date.now()) {
        const elapsed = Date.now() - baseTime;
        const cycles = Math.floor(elapsed / (restockIntervalSeconds * 1000)) + 1;
        nextRestockMs = baseTime + (cycles * restockIntervalSeconds * 1000);
      }
      const nextRestockUnix = Math.floor(nextRestockMs / 1000);

      if (postStock === null || postStock === undefined) {
        stockHeader = '♾️ Unlimited';
        stockValue = `Refreshes <t:${nextRestockUnix}:R>`;
      } else if (isSoldOut) {
        stockHeader = '🔴 Out Of Stock';
        stockValue = `Restocks <t:${nextRestockUnix}:R>`;
        embed.setColor('#808080');
      } else {
        stockHeader = `🟢 ${postStock} In Stock`;
        stockValue = `Restocks <t:${nextRestockUnix}:R>`;
      }
    } else {
      if (postStock === null || postStock === undefined) {
        stockHeader = '♾️ Unlimited';
        stockValue = 'Available';
      } else if (isSoldOut) {
        stockHeader = '🔴 Out Of Stock';
        stockValue = 'Sold Out';
        embed.setColor('#808080'); // Gray out sold out items
      } else {
        stockHeader = `🟢 ${postStock} In Stock`;
        stockValue = 'Available';
      }
    }
    embed.addFields({ name: stockHeader, value: stockValue, inline: true });

    // Build Buy / Claim button
    const sellerPart = sellerId || '0';
    const payoutPart = payout || '0';
    const overridePart = (effectivePrice !== null && effectivePrice !== undefined) ? effectivePrice : '';

    let buttonLabel = '';
    if (isSoldOut) {
      buttonLabel = 'SOLD OUT';
    } else if (isFree) {
      buttonLabel = 'CLAIM';
    } else {
      buttonLabel = `BUY (${Number(effectivePrice).toLocaleString()})`;
    }

    const buyButton = new ButtonBuilder()
      .setCustomId(`bank_shop_buy_${itemId}_${sellerPart}_${payoutPart}_${overridePart}`)
      .setLabel(buttonLabel)
      .setEmoji(`${COIN_EMOJI}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(isSoldOut);

    const row = new ActionRowBuilder().addComponents(buyButton);

    await message.edit({ embeds: [embed], components: [row] });
    verifyAndHealMessageImages(message, { expectedImageUrl: finalImage || null });

    try {
      const customDesc = (description && description.trim().length > 0) ? description.trim() : null;
      await pool.query(
        `INSERT INTO shop_posts (
          message_id, guild_id, channel_id, item_id, custom_image_url,
          post_mode, auto_equip, claim_limit_per_user, restock_interval_seconds,
          max_stock, current_stock, override_price, last_restocked_at, custom_description, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
        ON CONFLICT (message_id) DO UPDATE SET
          channel_id = EXCLUDED.channel_id,
          item_id = EXCLUDED.item_id,
          custom_image_url = EXCLUDED.custom_image_url,
          post_mode = EXCLUDED.post_mode,
          auto_equip = EXCLUDED.auto_equip,
          claim_limit_per_user = EXCLUDED.claim_limit_per_user,
          restock_interval_seconds = EXCLUDED.restock_interval_seconds,
          max_stock = EXCLUDED.max_stock,
          current_stock = EXCLUDED.current_stock,
          override_price = EXCLUDED.override_price,
          last_restocked_at = EXCLUDED.last_restocked_at,
          custom_description = EXCLUDED.custom_description,
          updated_at = NOW()`,
        [
          message.id, interaction.guildId, message.channelId || channel.id, itemId, isCustom ? imageUrl : null,
          effectivePostMode, autoEquip, claimLimit, restockIntervalSeconds,
          maxStock, postStock, effectivePrice, lastRestockedAt, customDesc
        ]
      );

      // Only reset claims if the timer interval changed or claim limit was modified
      if (timerChanged || (claimLimitChanged && claimLimit !== null)) {
        await pool.query(
          `DELETE FROM shop_drop_claims WHERE message_id = $1`,
          [message.id]
        );
      }
    } catch (_) {}

    // Log & Cleanup
    if (item.item_type === 'loot_box' || item.loot_box_id) {
      const lootBoxCatName = await getLootBoxCategoryName(interaction.guildId);
      const lootBoxEmoji = await getLootBoxCategoryEmoji(interaction.guildId);
      const singularName = (lootBoxCatName.endsWith('s') || lootBoxCatName.endsWith('S')) 
        ? lootBoxCatName.slice(0, -1) 
        : lootBoxCatName;
      sendLog(
        interaction.guild, 
        'shop', 
        'blue', 
        `📝 ${singularName} Post Updated`, 
        `Admin **<@${interaction.user.id}>** updated posted ${singularName.toLowerCase()} **${item.name}** in <#${channelId}>`
      );
    } else if (item.item_type === 'pack' || item.is_pack) {
      sendLog(
        interaction.guild, 
        'shop', 
        'blue', 
        '📝 Pack Post Updated', 
        `Admin **<@${interaction.user.id}>** updated posted pack **${item.name}** in <#${channelId}>`
      );
    } else {
      sendLog(
        interaction.guild, 
        'shop', 
        'blue', 
        '📝 Shop Post Updated', 
        `Admin **<@${interaction.user.id}>** updated posted item **${item.name}** in <#${channelId}>`
      );
    }

    await deletePendingPostSession(sessionId);

    await interaction.followUp({
      content: `✅ **${item.name}** post updated successfully!`,
      flags: MessageFlags.Ephemeral
    }).catch(() => {});

    await handleShopPostGate(interaction);
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop post update');
  }
}

// ==========================================
// --- LOOT BOX MANAGEMENT DASHBOARD ---
// ==========================================

/**
 * Open Modal to Create a new Loot Box
 */
export async function handleLootBoxCreateModalStart(interaction) {
  const lootBoxCatName = await getLootBoxCategoryName(interaction.guildId);
  const modal = new ModalBuilder()
    .setCustomId('shop_lb_create_modal')
    .setTitle(`Create ${lootBoxCatName.slice(0, 35)}`);

  const nameInput = new TextInputBuilder()
    .setCustomId('name')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Golden Chest')
    .setRequired(true)
    .setMaxLength(100);

  const nameLabel = new LabelBuilder()
    .setLabel('Name')
    .setTextInputComponent(nameInput);

  const closedUpload = new FileUploadBuilder()
    .setCustomId('image_closed_file')
    .setRequired(false);

  const closedLabel = new LabelBuilder()
    .setLabel('Closed Box Image')
    .setDescription('Current: None')
    .setFileUploadComponent(closedUpload);

  const openedUpload = new FileUploadBuilder()
    .setCustomId('image_opened_file')
    .setRequired(false);

  const openedLabel = new LabelBuilder()
    .setLabel('Opened Box Image')
    .setDescription('Current: None')
    .setFileUploadComponent(openedUpload);

  modal.addLabelComponents(nameLabel, closedLabel, openedLabel);

  await interaction.showModal(modal);
}

/**
 * Handle Loot Box Creation Modal Submit
 */
export async function handleLootBoxCreateModalSubmit(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  try {
    const name = (interaction.fields.getTextInputValue('name') || '').trim();

    if (!name || name.length === 0) {
      return interaction.followUp({
        content: '❌ **Invalid Box Name**: Box name cannot be empty.',
        flags: MessageFlags.Ephemeral
      });
    }

    let imageUrl = null;
    let openedImageUrl = null;

    // 1. Process Closed Image (Upload or text fallback)
    const closedFiles = interaction.fields.getUploadedFiles?.('image_closed_file');
    const closedFile = closedFiles?.first?.() || (Array.isArray(closedFiles) ? closedFiles[0] : null);
    if (closedFile) {
      const uploadRes = await uploadHostAsset(interaction.client, 'boxes', interaction.guild, closedFile, {
        filename: closedFile.name,
        label: `📦 Loot Box (Closed): **${name}**`
      });
      imageUrl = uploadRes.url;
    } else {
      let rawClosed = '';
      try { rawClosed = (interaction.fields.getTextInputValue('image_closed') || '').trim(); } catch (_) {}
      if (rawClosed && rawClosed.toLowerCase() !== 'none' && /^https?:\/\/.+\..+/i.test(rawClosed)) {
        imageUrl = rawClosed;
      }
    }

    // 2. Process Opened Image (Upload or text fallback)
    const openedFiles = interaction.fields.getUploadedFiles?.('image_opened_file');
    const openedFile = openedFiles?.first?.() || (Array.isArray(openedFiles) ? openedFiles[0] : null);
    if (openedFile) {
      const uploadRes = await uploadHostAsset(interaction.client, 'boxes', interaction.guild, openedFile, {
        filename: openedFile.name,
        label: `📦 Loot Box (Opened): **${name}**`
      });
      openedImageUrl = uploadRes.url;
    } else {
      let rawOpened = '';
      try { rawOpened = (interaction.fields.getTextInputValue('image_opened') || '').trim(); } catch (_) {}
      if (rawOpened && rawOpened.toLowerCase() !== 'none' && /^https?:\/\/.+\..+/i.test(rawOpened)) {
        openedImageUrl = rawOpened;
      }
    }

    const { getGuildEmojiBlacklist, containsBlacklistedEmoji } = await import('../middleware/emoji-filter.js');
    const emojiConfig = await getGuildEmojiBlacklist(interaction.guildId);
    if (emojiConfig.enabled && containsBlacklistedEmoji(name, emojiConfig.blacklist)) {
      return interaction.followUp({
        content: `❌ Name **${name}** contains a restricted emoji and cannot be used.`,
        flags: MessageFlags.Ephemeral
      });
    }

    const newBox = await createLootBox(interaction.guildId, { name, imageUrl, openedImageUrl });
    const lootBoxCatName = await getLootBoxCategoryName(interaction.guildId);
    const lootBoxEmoji = await getLootBoxCategoryEmoji(interaction.guildId);
    const singularName = (lootBoxCatName.endsWith('s') || lootBoxCatName.endsWith('S')) 
      ? lootBoxCatName.slice(0, -1) 
      : lootBoxCatName;

    sendLog(
      interaction.guild,
      'shop',
      'green',
      `${lootBoxEmoji || '🎁'} ${singularName} Created`,
      `Admin **<@${interaction.user.id}>** created ${singularName.toLowerCase()} **${newBox.name}**`
    );

    await showLootBoxEditorPanel(interaction, newBox.id, `✅ Created ${singularName.toLowerCase()} **${newBox.name}**! Adjust drop chances below:`);
  } catch (error) {
    await handleInteractionError(interaction, error, 'loot box create submit');
  }
}

/**
 * Open Modal to Rename the Global Loot Box Category
 */
export async function handleLootBoxRenameCatStart(interaction) {
  const currentCat = await getLootBoxCategoryName(interaction.guildId);
  const currentEmoji = await getLootBoxCategoryEmoji(interaction.guildId);

  const modal = new ModalBuilder()
    .setCustomId('shop_lb_rename_cat_modal')
    .setTitle('Appearance');

  const catInput = new TextInputBuilder()
    .setCustomId('cat_name')
    .setLabel('Category Display Name')
    .setStyle(TextInputStyle.Short)
    .setValue(currentCat)
    .setPlaceholder('e.g. Chests, Gifts, Loot Boxes')
    .setRequired(true)
    .setMaxLength(32);

  const emojiInput = new TextInputBuilder()
    .setCustomId('cat_emoji')
    .setLabel('Category Emoji')
    .setStyle(TextInputStyle.Short)
    .setValue(currentEmoji || '🎁')
    .setPlaceholder('e.g. 🎁, 📦, 💎 or :custom_emoji: / emoji ID')
    .setRequired(false)
    .setMaxLength(100);

  modal.addComponents(
    new ActionRowBuilder().addComponents(catInput),
    new ActionRowBuilder().addComponents(emojiInput)
  );
  await interaction.showModal(modal);
}

/**
 * Handle Rename Category Modal Submit
 */
export async function handleLootBoxRenameCatSubmit(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  try {
    const newName = (interaction.fields.getTextInputValue('cat_name') || 'Loot Boxes').trim().slice(0, 32);
    let rawEmoji = (interaction.fields.getTextInputValue('cat_emoji') || '🎁').trim();
    if (!rawEmoji) rawEmoji = '🎁';

    if (!newName || newName.length === 0) {
      return interaction.followUp({
        content: '❌ **Invalid Category Name**: Category name cannot be empty.',
        flags: MessageFlags.Ephemeral
      });
    }

    // Refresh guild emojis cache
    await interaction.guild?.emojis.fetch().catch(() => null);

    let resolvedEmoji = null;

    // 1. Formatted Custom Emoji: <:name:id> or <a:name:id> (with optional trailing >)
    const customMatch = rawEmoji.match(/^<(a)?:([a-zA-Z0-9_]+):(\d{17,20})>?$/);
    if (customMatch) {
      const isAnimated = customMatch[1] === 'a';
      const name = customMatch[2];
      const id = customMatch[3];
      const found = interaction.guild?.emojis.cache.get(id) || interaction.client?.emojis.cache.get(id);
      if (found) {
        resolvedEmoji = `<${found.animated ? 'a' : ''}:${found.name}:${found.id}>`;
      } else {
        const fetched = await interaction.guild?.emojis.fetch(id).catch(() => null) ||
                        await interaction.client?.emojis.fetch(id).catch(() => null);
        if (fetched) {
          resolvedEmoji = `<${fetched.animated ? 'a' : ''}:${fetched.name}:${fetched.id}>`;
        } else {
          resolvedEmoji = `<${isAnimated ? 'a' : ''}:${name}:${id}>`;
        }
      }
    } else if (/^\d{17,20}$/.test(rawEmoji)) {
      // 2. Pure Snowflake Emoji ID: 123456789012345678
      const found = interaction.guild?.emojis.cache.get(rawEmoji) || interaction.client?.emojis.cache.get(rawEmoji);
      if (found) {
        resolvedEmoji = `<${found.animated ? 'a' : ''}:${found.name}:${found.id}>`;
      } else {
        const fetched = await interaction.guild?.emojis.fetch(rawEmoji).catch(() => null) ||
                        await interaction.client?.emojis.fetch(rawEmoji).catch(() => null);
        if (fetched) {
          resolvedEmoji = `<${fetched.animated ? 'a' : ''}:${fetched.name}:${fetched.id}>`;
        } else {
          return interaction.followUp({
            content: `❌ **Unreachable Custom Emoji**: The bot cannot find emoji ID \`${rawEmoji}\`. Please upload the emoji to this Discord server or use a standard emoji (e.g. 🎁, 📦, 💎).`,
            flags: MessageFlags.Ephemeral
          });
        }
      }
    } else if (/^:?[a-zA-Z0-9_]{2,32}:?$/.test(rawEmoji)) {
      // 3. Emoji Name lookup (e.g. :minecraftchest: or minecraftchest)
      const cleanName = rawEmoji.replace(/:/g, '').toLowerCase();
      const found = interaction.guild?.emojis.cache.find(e => e.name.toLowerCase() === cleanName) ||
                    interaction.client?.emojis.cache.find(e => e.name.toLowerCase() === cleanName);
      if (found) {
        resolvedEmoji = `<${found.animated ? 'a' : ''}:${found.name}:${found.id}>`;
      }
    }

    // 4. Standard Unicode Emoji
    if (!resolvedEmoji) {
      const emojiRegex = /^(\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Emoji}\uFE0F|\u200D|\p{Emoji_Modifier})+$/u;
      if (emojiRegex.test(rawEmoji)) {
        resolvedEmoji = rawEmoji;
      }
    }

    if (!resolvedEmoji) {
      return interaction.followUp({
        content: `❌ **Invalid Emoji**: Could not validate \`${rawEmoji}\`. Please enter a standard emoji (e.g. 🎁, 📦, 💎) or a valid custom emoji uploaded to this server.`,
        flags: MessageFlags.Ephemeral
      });
    }

    const config = await getGuildConfig(interaction.guildId) || {};
    config.loot_box_category_name = newName;
    config.loot_box_category_emoji = resolvedEmoji;
    await setGuildConfig(interaction.guildId, config);

    sendLog(
      interaction.guild,
      'shop',
      'cyan',
      `⚙️ Category Settings Configured`,
      `Admin **<@${interaction.user.id}>** updated global ${newName} category settings:\n• **Display Name:** \`${newName}\`\n• **Emoji:** ${resolvedEmoji}`
    );

    await handleLootBoxesPage(interaction);
  } catch (error) {
    await handleInteractionError(interaction, error, 'rename lootbox category');
  }
}

export function getLootBoxActiveImages(box) {
  const list = [];
  if (box.image_url) list.push({ key: 'image_url', label: 'Closed Box Image', value: 'clear_closed' });
  if (box.opened_image_url) list.push({ key: 'opened_image_url', label: 'Opened Box Image', value: 'clear_opened' });
  return list;
}

export function buildLootBoxImageActionMenu(box) {
  const activeImages = getLootBoxActiveImages(box);
  if (activeImages.length === 0) return null;

  const options = [
    {
      label: 'Add Images',
      value: 'action_modal',
      emoji: '➕'
    }
  ];

  for (const img of activeImages) {
    options.push({
      label: img.label,
      value: img.value,
      emoji: '❌'
    });
  }

  return new StringSelectMenuBuilder()
    .setCustomId(`shop_lb_image_action_menu_${box.id}`)
    .setPlaceholder('Edit Images...')
    .addOptions(options);
}

/**
 * Unified Loot Box Configuration Panel (Dropdown Config, Feature Toggles, Customize, Delete)
 */
export async function showLootBoxEditorPanel(interaction, boxId, options = {}) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  try {
    const box = await getLootBox(boxId, interaction.guildId);
    if (!box) {
      return interaction.editReply({ files: [], attachments: [], content: '❌ Loot box not found.', embeds: [], components: [] });
    }

    const lootBoxEmoji = await getLootBoxCategoryEmoji(interaction.guildId);
    const lootBoxCatName = await getLootBoxCategoryName(interaction.guildId);
    const config = await getGuildConfig(interaction.guildId);
    const serverCoinEmoji = config?.coin_emoji || DEFAULT_COIN_EMOJI || '🪙';
    const coinName = await getCurrencyName(interaction.guildId);

    const itemsEnabled = box.items_enabled !== false;
    const coinsEnabled = box.coins_enabled !== false;

    // Build description in strict order: 1. Rarity, 2. Prizes, 3. Coins (each with dedicated emojis)
    const sections = [];

    // 1. Rarity (First)
    if (itemsEnabled) {
      const rarityLines = [
        `<:Common:1540257440971366400> **Common**: \`${box.chance_common}%\``,
        `<:Uncommon:1540257439629312010> **Uncommon**: \`${box.chance_uncommon}%\``,
        `<:Rare:1540257438274428928> **Rare**: \`${box.chance_rare}%\``,
        `<:Epic:1540257436890566666> **Epic**: \`${box.chance_epic}%\``,
        `<:Legendary:1540257435560841236> **Legendary**: \`${box.chance_legendary}%\``
      ].join('\n');
      sections.push(rarityLines);
    }

    // 2. Prizes (Second)
    if (itemsEnabled) {
      sections.push(`💎 **Prizes**: \`${box.min_prizes}—${box.max_prizes}\``);
    }

    // 3. Coins (Third)
    if (coinsEnabled) {
      sections.push(`${serverCoinEmoji} **${coinName}**: \`${box.min_coins.toLocaleString()}—${box.max_coins.toLocaleString()}\` \`(${box.chance_coins}%)\``);
    }

    const description = sections.length > 0 ? `\u200b\n${sections.join('\n\n')}` : '';

    const embed = new EmbedBuilder()
      .setColor('#9B59B6')
      .setTitle(box.name)
      .setDescription(description);

    if (box.image_url && box.image_url.trim().startsWith('http')) {
      embed.setThumbnail(box.image_url.trim());
    }

    const components = [];

    // Helper to resolve select emoji
    const getSelectEmoji = (rawEmoji) => {
      if (!rawEmoji) return undefined;
      const customMatch = rawEmoji.match(/^<a?:([a-zA-Z0-9_]+):([0-9]+)>$/);
      if (customMatch) return { name: customMatch[1], id: customMatch[2] };
      const rawIdMatch = rawEmoji.match(/^[0-9]{17,20}$/);
      if (rawIdMatch) return { id: rawIdMatch[0] };
      return rawEmoji;
    };

    // --- Row 1: Configuration Dropdown (Filtered by enabled features) ---
    const dropdownOptions = [];
    if (itemsEnabled) {
      dropdownOptions.push({
        label: 'Rarity',
        value: 'cfg_rarity',
        emoji: '🎲',
        description: 'Configure item rarity drop rates'
      });
      dropdownOptions.push({
        label: 'Prizes',
        value: 'cfg_prizes',
        emoji: '💎',
        description: 'Configure min & max prizes per open'
      });
    }
    if (coinsEnabled) {
      dropdownOptions.push({
        label: coinName,
        value: 'cfg_coins',
        emoji: getSelectEmoji(serverCoinEmoji),
        description: `Configure ${coinName.toLowerCase()} drop chance & range`
      });
    }

    if (dropdownOptions.length > 0) {
      const configSelect = new StringSelectMenuBuilder()
        .setCustomId(`shop_lb_config_menu_${boxId}`)
        .setPlaceholder(`Configure ${lootBoxCatName}`)
        .addOptions(dropdownOptions);
      components.push(new ActionRowBuilder().addComponents(configSelect));
    }

    // --- Row 2: Feature Toggle Buttons (Rarity & Prizes next to each other) ---
    const toggleRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`shop_lb_toggle_items_${boxId}`)
        .setLabel('Rarity')
        .setEmoji('🎲')
        .setStyle(itemsEnabled ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`shop_lb_toggle_prizes_${boxId}`)
        .setLabel('Prizes')
        .setEmoji('💎')
        .setStyle(itemsEnabled ? ButtonStyle.Success : ButtonStyle.Secondary),
      safeSetButtonEmoji(
        new ButtonBuilder()
          .setCustomId(`shop_lb_toggle_coins_${boxId}`)
          .setLabel(coinName)
          .setStyle(coinsEnabled ? ButtonStyle.Success : ButtonStyle.Secondary),
        serverCoinEmoji,
        interaction.guild,
        '🪙'
      )
    );
    components.push(toggleRow);

    if (options.showImageMenu) {
      const imageMenu = buildLootBoxImageActionMenu(box);
      if (imageMenu) {
        components.push(new ActionRowBuilder().addComponents(imageMenu));
      }
    }

    // --- Row 3: Action Buttons (Appearance, Edit Images) ---
    const hasBoxImages = Boolean(box.image_url || box.opened_image_url);
    const actionRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`shop_lb_rename_box_btn_${boxId}`)
        .setLabel('Appearance')
        .setEmoji('🖼️')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`shop_lb_images_btn_${boxId}`)
        .setLabel('Edit Images')
        .setEmoji('🖼️')
        .setStyle(options.showImageMenu ? ButtonStyle.Primary : (hasBoxImages ? ButtonStyle.Primary : ButtonStyle.Secondary))
    );
    components.push(actionRow);

    // --- Row 4: Navigation & Danger Buttons (Back, Delete on their own row at the very bottom) ---
    const bottomRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('shop_lb_home')
        .setLabel('Back')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`shop_lb_delete_start_${boxId}`)
        .setLabel('Delete')
        .setEmoji('🗑️')
        .setStyle(ButtonStyle.Danger)
    );
    components.push(bottomRow);

    await interaction.editReply({
      content: null,
      embeds: [embed],
      files: [], attachments: [],
      components
    });
  } catch (error) {
    await handleInteractionError(interaction, error, 'loot box editor panel');
  }
}

export async function showLootBoxImagesModal(interaction, boxId) {
  const box = await getLootBox(boxId, interaction.guildId);
  if (!box) return;

  const modal = new ModalBuilder()
    .setCustomId(`shop_lb_images_modal_${boxId}_${Date.now()}`)
    .setTitle(`Images: ${box.name.slice(0, 30)}`);

  const closedUpload = new FileUploadBuilder()
    .setCustomId('image_closed_file')
    .setRequired(false);

  const closedLabel = new LabelBuilder()
    .setLabel('Closed Box Image')
    .setDescription(formatCurrentImageDescription(box.image_url))
    .setFileUploadComponent(closedUpload);

  const openedUpload = new FileUploadBuilder()
    .setCustomId('image_opened_file')
    .setRequired(false);

  const openedLabel = new LabelBuilder()
    .setLabel('Opened Box Image')
    .setDescription(formatCurrentImageDescription(box.opened_image_url))
    .setFileUploadComponent(openedUpload);

  modal.addLabelComponents(closedLabel, openedLabel);
  await interaction.showModal(modal);
}

export async function handleLootBoxImagesButton(interaction, boxId) {
  const box = await getLootBox(boxId, interaction.guildId);
  if (!box) return;

  const activeImages = getLootBoxActiveImages(box);
  if (activeImages.length === 0) {
    return showLootBoxImagesModal(interaction, boxId);
  }

  return showLootBoxEditorPanel(interaction, boxId, { showImageMenu: true });
}

export async function handleLootBoxImageActionSelect(interaction, boxId) {
  const selectedValue = interaction.values[0];
  const box = await getLootBox(boxId, interaction.guildId);
  if (!box) return;

  if (selectedValue === 'action_modal') {
    return showLootBoxImagesModal(interaction, boxId);
  }

  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferUpdate().catch(() => {});
  }

  const updates = {};
  if (selectedValue === 'clear_closed') updates.imageUrl = null;
  if (selectedValue === 'clear_opened') updates.openedImageUrl = null;

  await updateLootBox(boxId, interaction.guildId, updates);
  const updatedBox = await getLootBox(boxId, interaction.guildId);
  const remaining = updatedBox ? getLootBoxActiveImages(updatedBox) : [];

  return showLootBoxEditorPanel(interaction, boxId, { showImageMenu: remaining.length > 0 });
}

export async function handleLootBoxImagesSubmit(interaction, boxId) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  try {
    const box = await getLootBox(boxId, interaction.guildId);
    if (!box) return;

    let imageUrl = box.image_url || null;
    let openedImageUrl = box.opened_image_url || null;

    // 1. Process Closed Image
    const closedFiles = interaction.fields.getUploadedFiles?.('image_closed_file');
    const closedFile = closedFiles?.first?.() || (Array.isArray(closedFiles) ? closedFiles[0] : null);
    if (closedFile) {
      const uploadRes = await uploadHostAsset(interaction.client, 'boxes', interaction.guild, closedFile, {
        filename: closedFile.name,
        label: `📦 Loot Box (Closed): **${box.name}**`
      });
      imageUrl = uploadRes.url;
    }

    // 2. Process Opened Image
    const openedFiles = interaction.fields.getUploadedFiles?.('image_opened_file');
    const openedFile = openedFiles?.first?.() || (Array.isArray(openedFiles) ? openedFiles[0] : null);
    if (openedFile) {
      const uploadRes = await uploadHostAsset(interaction.client, 'boxes', interaction.guild, openedFile, {
        filename: openedFile.name,
        label: `📦 Loot Box (Opened): **${box.name}**`
      });
      openedImageUrl = uploadRes.url;
    }

    await updateLootBox(boxId, interaction.guildId, { imageUrl, openedImageUrl });
    await showLootBoxEditorPanel(interaction, boxId);
  } catch (error) {
    await handleInteractionError(interaction, error, 'loot box images submit');
  }
}

/**
 * Handle Feature Toggling (Items or Coins) with Empty Box Failsafe
 */
export async function handleLootBoxToggleFeature(interaction, boxId, featureType) {
  try {
    const result = await toggleLootBoxFeature(boxId, interaction.guildId, featureType);
    if (!result.success) {
      if (!interaction.deferred && !interaction.replied) {
        return interaction.reply({
          content: `⚠️ ${result.error}`,
          flags: MessageFlags.Ephemeral
        });
      } else {
        return interaction.followUp({
          content: `⚠️ ${result.error}`,
          flags: MessageFlags.Ephemeral
        });
      }
    }
    const box = await getLootBox(boxId, interaction.guildId);
    const lootBoxCatName = await getLootBoxCategoryName(interaction.guildId);
    const singularName = (lootBoxCatName.endsWith('s') || lootBoxCatName.endsWith('S')) 
      ? lootBoxCatName.slice(0, -1) 
      : lootBoxCatName;
    const isCoins = featureType === 'coins';
    const coinName = await getCurrencyName(interaction.guildId);
    const featureLabel = isCoins ? `${coinName} Reward` : 'Item Prizes & Rarity';
    const isEnabled = isCoins ? box?.coins_enabled : box?.items_enabled;

    sendLog(
      interaction.guild,
      'shop',
      'blue',
      `⚙️ ${singularName} Feature Toggled`,
      `Admin **<@${interaction.user.id}>** toggled **${featureLabel}** for ${singularName.toLowerCase()} **${box?.name || `#${boxId}`}** ➡️ **${isEnabled ? 'ENABLED' : 'DISABLED'}**`
    );

    await showLootBoxEditorPanel(interaction, boxId);
  } catch (error) {
    await handleInteractionError(interaction, error, 'toggle loot box feature');
  }
}

/**
 * Handle Option Selected in Loot Box Configuration Dropdown Menu
 */
export async function handleLootBoxConfigMenuSelect(interaction) {
  try {
    const customId = interaction.customId; // shop_lb_config_menu_${boxId}
    const boxId = parseInt(customId.replace('shop_lb_config_menu_', ''), 10);
    const selected = interaction.values[0];

    if (selected === 'cfg_rarity') {
      return handleLootBoxRarityRatesModal(interaction, boxId);
    }
    if (selected === 'cfg_prizes') {
      return handleLootBoxPrizeCountModal(interaction, boxId);
    }
    if (selected === 'cfg_coins') {
      return handleLootBoxCoinsConfigModal(interaction, boxId);
    }
  } catch (error) {
    await handleInteractionError(interaction, error, 'loot box config menu');
  }
}

/**
 * Open Modal to Configure Item Rarity Drop Rates
 */
export async function handleLootBoxRarityRatesModal(interaction, boxId) {
  const box = await getLootBox(boxId, interaction.guildId);
  if (!box) return;

  const modal = new ModalBuilder()
    .setCustomId(`shop_lb_rates_modal_${boxId}`)
    .setTitle('Configure Rarity Rates');

  const commonInput = new TextInputBuilder()
    .setCustomId('common')
    .setLabel('Common Chance (%)')
    .setStyle(TextInputStyle.Short)
    .setValue(box.chance_common.toString())
    .setPlaceholder('e.g. 70')
    .setRequired(true);

  const uncommonInput = new TextInputBuilder()
    .setCustomId('uncommon')
    .setLabel('Uncommon Chance (%)')
    .setStyle(TextInputStyle.Short)
    .setValue(box.chance_uncommon.toString())
    .setPlaceholder('e.g. 20')
    .setRequired(true);

  const rareInput = new TextInputBuilder()
    .setCustomId('rare')
    .setLabel('Rare Chance (%)')
    .setStyle(TextInputStyle.Short)
    .setValue(box.chance_rare.toString())
    .setPlaceholder('e.g. 5')
    .setRequired(true);

  const epicInput = new TextInputBuilder()
    .setCustomId('epic')
    .setLabel('Epic Chance (%)')
    .setStyle(TextInputStyle.Short)
    .setValue(box.chance_epic.toString())
    .setPlaceholder('e.g. 0')
    .setRequired(true);

  const legendaryInput = new TextInputBuilder()
    .setCustomId('legendary')
    .setLabel('Legendary Chance (%)')
    .setStyle(TextInputStyle.Short)
    .setValue(box.chance_legendary.toString())
    .setPlaceholder('e.g. 0')
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(commonInput),
    new ActionRowBuilder().addComponents(uncommonInput),
    new ActionRowBuilder().addComponents(rareInput),
    new ActionRowBuilder().addComponents(epicInput),
    new ActionRowBuilder().addComponents(legendaryInput)
  );

  await interaction.showModal(modal);
}

/**
 * Handle Rarity Rates Modal Submit
 */
export async function handleLootBoxRarityRatesSubmit(interaction, boxId) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  try {
    const commonVal = interaction.fields.getTextInputValue('common').trim();
    const uncommonVal = interaction.fields.getTextInputValue('uncommon').trim();
    const rareVal = interaction.fields.getTextInputValue('rare').trim();
    const epicVal = interaction.fields.getTextInputValue('epic').trim();
    const legendaryVal = interaction.fields.getTextInputValue('legendary').trim();

    if (
      !/^\d+(\.\d+)?$/.test(commonVal) ||
      !/^\d+(\.\d+)?$/.test(uncommonVal) ||
      !/^\d+(\.\d+)?$/.test(rareVal) ||
      !/^\d+(\.\d+)?$/.test(epicVal) ||
      !/^\d+(\.\d+)?$/.test(legendaryVal)
    ) {
      return interaction.followUp({
        content: '❌ **Invalid Input**: All rarity chance fields must be valid non-negative numbers.',
        flags: MessageFlags.Ephemeral
      });
    }

    const chanceCommon = parseFloat(commonVal);
    const chanceUncommon = parseFloat(uncommonVal);
    const chanceRare = parseFloat(rareVal);
    const chanceEpic = parseFloat(epicVal);
    const chanceLegendary = parseFloat(legendaryVal);

    const total = parseFloat((chanceCommon + chanceUncommon + chanceRare + chanceEpic + chanceLegendary).toFixed(2));

    if (total !== 100) {
      return interaction.followUp({
        content: `❌ **Invalid Rarity Percentages**: Total must add up to exactly **100%**.\nYour current sum is **${total}%** (Common: ${chanceCommon}%, Uncommon: ${chanceUncommon}%, Rare: ${chanceRare}%, Epic: ${chanceEpic}%, Legendary: ${chanceLegendary}%).\nChanges were not saved.`,
        flags: MessageFlags.Ephemeral
      });
    }

    await updateLootBoxRarityRates(boxId, interaction.guildId, {
      chanceCommon,
      chanceUncommon,
      chanceRare,
      chanceEpic,
      chanceLegendary
    });

    const box = await getLootBox(boxId, interaction.guildId);
    const lootBoxCatName = await getLootBoxCategoryName(interaction.guildId);
    const singularName = (lootBoxCatName.endsWith('s') || lootBoxCatName.endsWith('S')) 
      ? lootBoxCatName.slice(0, -1) 
      : lootBoxCatName;

    sendLog(
      interaction.guild,
      'shop',
      'blue',
      `🎲 ${singularName} Rarity Rates Updated`,
      `Admin **<@${interaction.user.id}>** updated rarity drop rates for ${singularName.toLowerCase()} **${box?.name || `#${boxId}`}**:\n` +
      `• <:Common:1540257440971366400> Common: **${chanceCommon}%**\n` +
      `• <:Uncommon:1540257439629312010> Uncommon: **${chanceUncommon}%**\n` +
      `• <:Rare:1540257438274428928> Rare: **${chanceRare}%**\n` +
      `• <:Epic:1540257436890566666> Epic: **${chanceEpic}%**\n` +
      `• <:Legendary:1540257435560841236> Legendary: **${chanceLegendary}%**`
    );

    await showLootBoxEditorPanel(interaction, boxId);
  } catch (error) {
    await handleInteractionError(interaction, error, 'loot box rarity rates submit');
  }
}

/**
 * Open Modal to Configure Coins Drop Rate & Amount Range
 */
export async function handleLootBoxCoinsConfigModal(interaction, boxId) {
  const box = await getLootBox(boxId, interaction.guildId);
  if (!box) return;

  const coinName = await getCurrencyName(interaction.guildId);
  const modal = new ModalBuilder()
    .setCustomId(`shop_lb_coins_modal_${boxId}`)
    .setTitle(`Configure ${coinName} Reward`.slice(0, 45));

  const chanceInput = new TextInputBuilder()
    .setCustomId('chance_coins')
    .setLabel(`${coinName} Drop Weight / Chance (%)`.slice(0, 45))
    .setStyle(TextInputStyle.Short)
    .setValue(box.chance_coins.toString())
    .setPlaceholder('e.g. 25')
    .setRequired(true);

  const minCoinsInput = new TextInputBuilder()
    .setCustomId('min_coins')
    .setLabel(`Minimum ${coinName} Won`.slice(0, 45))
    .setStyle(TextInputStyle.Short)
    .setValue(box.min_coins.toString())
    .setPlaceholder('e.g. 100')
    .setRequired(true);

  const maxCoinsInput = new TextInputBuilder()
    .setCustomId('max_coins')
    .setLabel(`Maximum ${coinName} Won`.slice(0, 45))
    .setStyle(TextInputStyle.Short)
    .setValue(box.max_coins.toString())
    .setPlaceholder('e.g. 500')
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(chanceInput),
    new ActionRowBuilder().addComponents(minCoinsInput),
    new ActionRowBuilder().addComponents(maxCoinsInput)
  );

  await interaction.showModal(modal);
}

/**
 * Handle Coins Config Modal Submit
 */
export async function handleLootBoxCoinsConfigSubmit(interaction, boxId) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  try {
    const coinName = await getCurrencyName(interaction.guildId);
    const chanceVal = interaction.fields.getTextInputValue('chance_coins').trim();
    const minCoinsVal = interaction.fields.getTextInputValue('min_coins').trim();
    const maxCoinsVal = interaction.fields.getTextInputValue('max_coins').trim();

    if (!/^\d+(\.\d+)?$/.test(chanceVal) || !/^\d+$/.test(minCoinsVal) || !/^\d+$/.test(maxCoinsVal)) {
      return interaction.followUp({
        content: `❌ **Invalid Input**: ${coinName} chance must be a valid number, and ${coinName.toLowerCase()} amounts must be whole numbers.`,
        flags: MessageFlags.Ephemeral
      });
    }

    const chanceCoins = parseFloat(chanceVal);
    const minCoins = parseInt(minCoinsVal, 10);
    const maxCoins = parseInt(maxCoinsVal, 10);

    if (chanceCoins < 0) {
      return interaction.followUp({
        content: `❌ **Invalid ${coinName} Chance**: Chance percentage cannot be negative.`,
        flags: MessageFlags.Ephemeral
      });
    }

    if (minCoins < 0) {
      return interaction.followUp({
        content: `❌ **Invalid ${coinName} Amount**: Minimum ${coinName.toLowerCase()} cannot be negative.`,
        flags: MessageFlags.Ephemeral
      });
    }

    if (maxCoins < minCoins) {
      return interaction.followUp({
        content: `❌ **Invalid ${coinName} Range**: Minimum ${coinName.toLowerCase()} (\`${minCoins.toLocaleString()}\`) cannot be greater than Maximum ${coinName.toLowerCase()} (\`${maxCoins.toLocaleString()}\`).`,
        flags: MessageFlags.Ephemeral
      });
    }

    if (maxCoins > 1000000000) {
      return interaction.followUp({
        content: `❌ **Maximum ${coinName} Limit**: Maximum ${coinName.toLowerCase()} cannot exceed 1,000,000,000.`,
        flags: MessageFlags.Ephemeral
      });
    }

    await updateLootBoxCoinsConfig(boxId, interaction.guildId, {
      chanceCoins,
      minCoins,
      maxCoins
    });

    const box = await getLootBox(boxId, interaction.guildId);
    const lootBoxCatName = await getLootBoxCategoryName(interaction.guildId);
    const singularName = (lootBoxCatName.endsWith('s') || lootBoxCatName.endsWith('S')) 
      ? lootBoxCatName.slice(0, -1) 
      : lootBoxCatName;
    const config = await getGuildConfig(interaction.guildId);
    const coinEmoji = config?.coin_emoji || DEFAULT_COIN_EMOJI || '🪙';

    sendLog(
      interaction.guild,
      'shop',
      'blue',
      `${coinEmoji} ${singularName} ${coinName} Config Updated`,
      `Admin **<@${interaction.user.id}>** updated ${coinName.toLowerCase()} rewards for ${singularName.toLowerCase()} **${box?.name || `#${boxId}`}**:\n` +
      `• **Drop Chance:** \`${chanceCoins}%\`\n` +
      `• **Reward Range:** ${coinEmoji} \`${minCoins.toLocaleString()}—${maxCoins.toLocaleString()}\``
    );

    await showLootBoxEditorPanel(interaction, boxId);
  } catch (error) {
    await handleInteractionError(interaction, error, 'loot box coins config submit');
  }
}

/**
 * Open Modal to Configure Prize Count (Min/Max prizes per open)
 */
export async function handleLootBoxPrizeCountModal(interaction, boxId) {
  const box = await getLootBox(boxId, interaction.guildId);
  if (!box) return;

  const modal = new ModalBuilder()
    .setCustomId(`shop_lb_prizes_modal_${boxId}`)
    .setTitle('Configure Prize Count');

  const minPrizesInput = new TextInputBuilder()
    .setCustomId('min_prizes')
    .setLabel('Minimum Prizes Per Open')
    .setStyle(TextInputStyle.Short)
    .setValue(box.min_prizes.toString())
    .setPlaceholder('e.g. 1')
    .setRequired(true);

  const maxPrizesInput = new TextInputBuilder()
    .setCustomId('max_prizes')
    .setLabel('Maximum Prizes Per Open')
    .setStyle(TextInputStyle.Short)
    .setValue(box.max_prizes.toString())
    .setPlaceholder('e.g. 3')
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(minPrizesInput),
    new ActionRowBuilder().addComponents(maxPrizesInput)
  );

  await interaction.showModal(modal);
}

/**
 * Handle Prize Count Modal Submit
 */
export async function handleLootBoxPrizeCountSubmit(interaction, boxId) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  try {
    const minPrizesVal = interaction.fields.getTextInputValue('min_prizes').trim();
    const maxPrizesVal = interaction.fields.getTextInputValue('max_prizes').trim();

    if (!/^\d+$/.test(minPrizesVal) || !/^\d+$/.test(maxPrizesVal)) {
      return interaction.followUp({
        content: '❌ **Invalid Input**: Minimum and Maximum prizes must be positive whole numbers.',
        flags: MessageFlags.Ephemeral
      });
    }

    const minPrizes = parseInt(minPrizesVal, 10);
    const maxPrizes = parseInt(maxPrizesVal, 10);

    if (minPrizes < 1) {
      return interaction.followUp({
        content: '❌ **Invalid Minimum Prizes**: A loot box must award at least 1 prize (Minimum Prizes cannot be 0).',
        flags: MessageFlags.Ephemeral
      });
    }

    if (maxPrizes < minPrizes) {
      return interaction.followUp({
        content: `❌ **Invalid Prize Range**: Minimum prizes (\`${minPrizes}\`) cannot be greater than Maximum prizes (\`${maxPrizes}\`).`,
        flags: MessageFlags.Ephemeral
      });
    }

    if (maxPrizes > 50) {
      return interaction.followUp({
        content: '❌ **Maximum Prize Limit**: A loot box cannot award more than 50 prizes per open.',
        flags: MessageFlags.Ephemeral
      });
    }

    await updateLootBoxPrizeCount(boxId, interaction.guildId, {
      minPrizes,
      maxPrizes
    });

    const box = await getLootBox(boxId, interaction.guildId);
    const lootBoxCatName = await getLootBoxCategoryName(interaction.guildId);
    const singularName = (lootBoxCatName.endsWith('s') || lootBoxCatName.endsWith('S')) 
      ? lootBoxCatName.slice(0, -1) 
      : lootBoxCatName;

    sendLog(
      interaction.guild,
      'shop',
      'blue',
      `💎 ${singularName} Prize Count Updated`,
      `Admin **<@${interaction.user.id}>** updated item prize count for ${singularName.toLowerCase()} **${box?.name || `#${boxId}`}**:\n` +
      `• **Item Prizes:** \`${minPrizes}—${maxPrizes}\` items per open`
    );

    await showLootBoxEditorPanel(interaction, boxId);
  } catch (error) {
    await handleInteractionError(interaction, error, 'loot box prize count submit');
  }
}

/**
 * Open Modal to Rename Loot Box or Update Image URL
 */
export async function handleLootBoxRenameModal(interaction, boxId) {
  const box = await getLootBox(boxId, interaction.guildId);
  if (!box) return;

  const modal = new ModalBuilder()
    .setCustomId(`shop_lb_rename_modal_${boxId}`)
    .setTitle('Appearance');

  const nameInput = new TextInputBuilder()
    .setCustomId('name')
    .setStyle(TextInputStyle.Short)
    .setValue(box.name)
    .setPlaceholder('Golden Chest')
    .setRequired(true)
    .setMaxLength(100);

  const nameLabel = new LabelBuilder()
    .setLabel('Name')
    .setTextInputComponent(nameInput);

  const closedUpload = new FileUploadBuilder()
    .setCustomId('image_closed_file')
    .setRequired(false);

  const closedLabel = new LabelBuilder()
    .setLabel('Closed Box Image')
    .setDescription(formatCurrentImageDescription(box.image_url))
    .setFileUploadComponent(closedUpload);

  const openedUpload = new FileUploadBuilder()
    .setCustomId('image_opened_file')
    .setRequired(false);

  const openedLabel = new LabelBuilder()
    .setLabel('Opened Box Image')
    .setDescription(formatCurrentImageDescription(box.opened_image_url))
    .setFileUploadComponent(openedUpload);

  modal.addLabelComponents(nameLabel, closedLabel, openedLabel);

  await interaction.showModal(modal);
}

/**
 * Handle Rename Modal Submit
 */
export async function handleLootBoxRenameSubmit(interaction, boxId) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  try {
    const name = (interaction.fields.getTextInputValue('name') || '').trim();

    if (!name || name.length === 0) {
      return interaction.followUp({
        content: '❌ **Invalid Box Name**: Name cannot be empty.',
        flags: MessageFlags.Ephemeral
      });
    }

    const oldBox = await getLootBox(boxId, interaction.guildId);
    let imageUrl = oldBox?.image_url || null;
    let openedImageUrl = oldBox?.opened_image_url || null;

    // 1. Process Closed Image (Upload or text fallback)
    const closedFiles = interaction.fields.getUploadedFiles?.('image_closed_file');
    const closedFile = closedFiles?.first?.() || (Array.isArray(closedFiles) ? closedFiles[0] : null);
    if (closedFile) {
      const uploadRes = await uploadHostAsset(interaction.client, 'boxes', interaction.guild, closedFile, {
        filename: closedFile.name,
        label: `📦 Loot Box (Closed): **${name}**`
      });
      imageUrl = uploadRes.url;
    } else {
      let rawClosed = '';
      try { rawClosed = (interaction.fields.getTextInputValue('image_closed') || '').trim(); } catch (_) {}
      if (rawClosed && rawClosed.toLowerCase() !== 'none') {
        imageUrl = cleanImageUrl(rawClosed);
      }
    }

    // 2. Process Opened Image (Upload or text fallback)
    const openedFiles = interaction.fields.getUploadedFiles?.('image_opened_file');
    const openedFile = openedFiles?.first?.() || (Array.isArray(openedFiles) ? openedFiles[0] : null);
    if (openedFile) {
      const uploadRes = await uploadHostAsset(interaction.client, 'boxes', interaction.guild, openedFile, {
        filename: openedFile.name,
        label: `📦 Loot Box (Opened): **${name}**`
      });
      openedImageUrl = uploadRes.url;
    } else {
      let rawOpened = '';
      try { rawOpened = (interaction.fields.getTextInputValue('image_opened') || '').trim(); } catch (_) {}
      if (rawOpened && rawOpened.toLowerCase() !== 'none') {
        openedImageUrl = cleanImageUrl(rawOpened);
      }
    }

    // Mutual fallback: If only one is entered, use for both
    await updateLootBox(boxId, interaction.guildId, { name, imageUrl, openedImageUrl });

    const lootBoxCatName = await getLootBoxCategoryName(interaction.guildId);
    const singularName = (lootBoxCatName.endsWith('s') || lootBoxCatName.endsWith('S')) 
      ? lootBoxCatName.slice(0, -1) 
      : lootBoxCatName;

    const diff = [];
    if (oldBox && oldBox.name !== name) diff.push(`• **Name:** ${oldBox.name} ➡️ ${name}`);
    if (oldBox && (oldBox.image_url || null) !== imageUrl) diff.push(`• **Image (Closed):** ${oldBox.image_url || 'None'} ➡️ ${imageUrl || 'None'}`);
    if (oldBox && (oldBox.opened_image_url || null) !== openedImageUrl) diff.push(`• **Image (Opened):** ${oldBox.opened_image_url || 'None'} ➡️ ${openedImageUrl || 'None'}`);

    sendLog(
      interaction.guild,
      'shop',
      'blue',
      `✏️ ${singularName} Customized`,
      `Admin **<@${interaction.user.id}>** customized ${singularName.toLowerCase()} **${name}**:\n${diff.length > 0 ? diff.join('\n') : '• Details saved'}`
    );

    await showLootBoxEditorPanel(interaction, boxId);
  } catch (error) {
    await handleInteractionError(interaction, error, 'loot box rename submit');
  }
}

/**
 * Show Confirmation to Delete Loot Box
 */
export async function showLootBoxDeleteConfirm(interaction, boxId) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  try {
    const box = await getLootBox(boxId, interaction.guildId);
    if (!box) {
      return interaction.editReply({ files: [], attachments: [], content: '❌ Loot box not found.', embeds: [], components: [] });
    }

    const lootBoxCatName = await getLootBoxCategoryName(interaction.guildId);
    const singularName = (lootBoxCatName.endsWith('s') || lootBoxCatName.endsWith('S')) 
      ? lootBoxCatName.slice(0, -1) 
      : lootBoxCatName;

    const embed = new EmbedBuilder()
      .setColor('#E74C3C')
      .setTitle(`Delete ${singularName}: ${box.name}`)
      .setDescription(
        `⚠️ **Warning**: Deleting this ${singularName.toLowerCase()} will:\n` +
        `• Remove this ${singularName.toLowerCase()} from the shop\n` +
        `• **Instantly purge all unopened copies** from all users' inventories\n\n` +
        `Are you sure you want to proceed?`
      );

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`shop_lb_view_${boxId}`)
        .setLabel('Cancel')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`shop_delete_lootbox_confirm_${boxId}`)
        .setLabel('Confirm Delete')
        .setEmoji('🗑️')
        .setStyle(ButtonStyle.Danger)
    );

    await interaction.editReply({ files: [], attachments: [], content: null, embeds: [embed], components: [row] });
  } catch (error) {
    await handleInteractionError(interaction, error, 'loot box delete confirm view');
  }
}

/**
 * Execute Loot Box Deletion
 */
export async function handleLootBoxDeleteConfirm(interaction, boxId) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  try {
    const box = await getLootBox(boxId, interaction.guildId);
    const boxName = box?.name || `#${boxId}`;
    const lootBoxCatName = await getLootBoxCategoryName(interaction.guildId);
    const singularName = (lootBoxCatName.endsWith('s') || lootBoxCatName.endsWith('S')) 
      ? lootBoxCatName.slice(0, -1) 
      : lootBoxCatName;

    await deleteLootBox(boxId, interaction.guildId);

    sendLog(
      interaction.guild,
      'shop',
      'red',
      `🗑️ ${singularName} Deleted`,
      `Admin **<@${interaction.user.id}>** deleted ${singularName.toLowerCase()} **${boxName}** and purged all unopened copies from player inventories.`
    );

    await handleLootBoxesPage(interaction);
    await interaction.followUp({ 
      content: `✅ **${singularName}** and all unopened inventory copies successfully deleted.`, 
      flags: MessageFlags.Ephemeral 
    }).catch(() => {});
  } catch (error) {
    await handleInteractionError(interaction, error, 'loot box delete execute');
  }
}





