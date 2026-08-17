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
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  UserSelectMenuBuilder,
  ChannelType,
  MessageFlags
} from 'discord.js';
import { sendLog, formatDiff, sendBulkLog, sysLog, sysError } from '../utils/logger.js';
import { handleInteractionError, diagnoseChannelPermissions } from '../utils/errors.js';
import { sanitizeError, COIN_EMOJI, isValidEconomyAmount, getUserLogName, parseSelectEmoji } from '../shared.js';

import { query } from '../storage/postgres.js';
import { resolveImageAttachment, invalidateImageCache } from '../utils/image-cache.js';
import {
  addShopCategory,
  addShopItem,
  updateShopItem,
  deleteShopItem,
  getShopCategories,
  getShopItems,
  getShopItem,
  getItemImage,
  getItemTiers,
  addItemTier,
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
import { RARITY_DISPLAY, RARITY_EMOJIS, DEFAULT_COIN_EMOJI } from '../shared.js';

// Temporary storage for post item flow (User ID -> { itemId, channelId, sellerId, imageUrl, description, payout })
const pendingPosts = new Map();

// Temporary storage for edit/delete flows to isolate state from Post flow.
// (User ID -> action: 'edit_item' | 'edit_pack' | 'delete_item' | 'delete_pack')
export const pendingAdminBrowser = new Map();

// Temporary storage for new-item attribute selection (itemId -> { categoryId, rarity, is_tradable })
// State is held in memory until the admin clicks Save on the Item Created panel.
const pendingItemAttrs = new Map();

// Define the /shop setup command
export const shopSetupCommand = new SlashCommandBuilder()
  .setName('shop')
  .setDescription('Admin: Manage the server shop')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
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
    // Permission check
    if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
      return handleInteractionError(interaction, new Error('Permission Denied: Administrator required'), 'shop setup');
    }

    // Defer if not already deferred
    if (!interaction.deferred && !interaction.replied) {
      if (interaction.isMessageComponent && interaction.isMessageComponent()) {
        await interaction.deferUpdate();
      } else {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      }
    }

    const guildId = interaction.guildId;

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
    const categoriesCount = parseInt(categoriesResult.rows[0].count);
    const packCount = parseInt(itemsResult.rows[0].pack_count || 0);
    const itemsCount = parseInt(itemsResult.rows[0].item_count || 0);
    const lootBoxesCount = parseInt(itemsResult.rows[0].lootbox_count || 0);

    const embed = new EmbedBuilder()
      .setColor('#9B59B6')
      .setTitle('🏪 Shop Configuration')
      .setDescription('Manage categories and items in your server shop.')
      .addFields(
        { name: '📂 Categories', value: `${categoriesCount}`, inline: true },
        { name: '📦 Packs', value: `${packCount}`, inline: true },
        { name: '🎭 Items', value: `${itemsCount}`, inline: true }
      );

    const row1 = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('shop_admin_add')
          .setLabel('Create')
          .setEmoji('➕')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('shop_admin_edit')
          .setLabel('Edit')
          .setEmoji('✏️')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('shop_admin_delete')
          .setLabel('Delete')
          .setEmoji('🗑️')
          .setStyle(ButtonStyle.Danger)
      );

    // Row 2: Back (left), Loot Boxes (center), Post (right)
    const row2 = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('settings_back')
          .setLabel('Back')
          .setEmoji('⬅️')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('shop_lb_home')
          .setLabel(lootBoxCatName.slice(0, 50))
          .setEmoji(lootBoxEmoji)
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('shop_admin_post')
          .setLabel('Post')
          .setEmoji('📢')
          .setStyle(ButtonStyle.Secondary)
      );

    // Always use editReply since we likely deferred
    await interaction.editReply({ content: null, embeds: [embed], components: [row1, row2] });
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop setup');
  }
}

// --- Main Menu Handlers ---

export async function handleShopAdminAdd(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

  const embed = new EmbedBuilder()
    .setColor('#2ECC71')
    .setTitle('➕ Add Content')
    .setDescription('Select what you want to add:');

  const actionRow = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('shop_add_type_cat')
        .setLabel('Category')
        .setEmoji('📂')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('shop_add_type_pack')
        .setLabel('Pack')
        .setEmoji('📦')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('shop_add_type_item')
        .setLabel('Item')
        .setEmoji('🎭')
        .setStyle(ButtonStyle.Success)
    );

  const backRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('shop_admin_home')
      .setLabel('Back')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary)
  );

  await interaction.editReply({ content: null, embeds: [embed], components: [actionRow, backRow] });
}

export async function handleShopAdminEdit(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

  const embed = new EmbedBuilder()
    .setColor('#3498DB')
    .setTitle('✏️ Edit Content')
    .setDescription('What would you like to edit?');

  const actionRow = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('shop_edit_category_start')
        .setLabel('Category')
        .setEmoji('📂')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('shop_edit_pack_start')
        .setLabel('Pack')
        .setEmoji('📦')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('shop_edit_item')
        .setLabel('Item')
        .setEmoji('🎭')
        .setStyle(ButtonStyle.Primary)
    );

  const backRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('shop_admin_home')
      .setLabel('Back')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary)
  );

  await interaction.editReply({ content: null, embeds: [embed], components: [actionRow, backRow] });
}

export async function handleShopAdminDelete(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

  const embed = new EmbedBuilder()
    .setColor('#E74C3C')
    .setTitle('🗑️ Delete Content')
    .setDescription('What would you like to delete?');

  const actionRow = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('shop_delete_category_start')
        .setLabel('Category')
        .setEmoji('📂')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('shop_delete_pack')
        .setLabel('Pack')
        .setEmoji('📦')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('shop_delete_item')
        .setLabel('Item')
        .setEmoji('🎭')
        .setStyle(ButtonStyle.Danger)
    );

  const backRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('shop_admin_home')
      .setLabel('Back')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary)
  );

  await interaction.editReply({ content: null, embeds: [embed], components: [actionRow, backRow] });
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
      ? `**Configured Boxes (${lootBoxes.length}):**\n` + lootBoxes.map((b, idx) => `${idx + 1}. ${lootBoxEmoji} **${b.name}** — 💎 \`${b.min_prizes || 1}—${b.max_prizes || 1}\` | ${serverCoinEmoji} \`${(parseInt(b.min_coins) || 100).toLocaleString()}—${(parseInt(b.max_coins) || 500).toLocaleString()}\``).join('\n')
      : `*No ${lootBoxCatName.toLowerCase()} created yet. Click Create below to add one!*`;

    const embed = new EmbedBuilder()
      .setColor('#9B59B6')
      .setTitle(`${lootBoxEmoji} ${lootBoxCatName} Management`)
      .setDescription(desc);

    const components = [];

    // Helper for select menu option emoji
    const emojiMatch = lootBoxEmoji ? lootBoxEmoji.match(/:(\d+)>$/) : null;
    const selectOptEmoji = emojiMatch ? emojiMatch[1] : lootBoxEmoji;

    // 1. Dropdown select menu directly in the main menu
    if (lootBoxes.length > 0) {
      const select = new StringSelectMenuBuilder()
        .setCustomId('shop_lb_select_box')
        .setPlaceholder(`Select ${lootBoxCatName}`)
        .addOptions(lootBoxes.slice(0, 25).map(b => ({
          label: (b.name || `Unnamed Box #${b.id}`).slice(0, 80),
          value: `lb_${b.id}`,
          emoji: selectOptEmoji
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
        .setCustomId('shop_admin_home')
        .setLabel('Back')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('shop_lb_rename_cat')
        .setLabel('Config')
        .setEmoji('⚙️')
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
      components
    });
  } catch (error) {
    await handleInteractionError(interaction, error, 'loot boxes page');
  }
}

export async function handleAddTypeSelect(interaction) {
  const type = interaction.customId.split('_').pop(); // item, pack, cat

  if (type === 'cat') {
    await handleCreateCategory(interaction);
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`shop_item_modal_add_new_${type}_${Date.now()}`)
    .setTitle(type === 'pack' ? 'Create Item Pack' : 'Create Item');

  const nameInput = new TextInputBuilder()
    .setCustomId('item_name')
    .setLabel('Name')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(nameInput));

  if (type === 'item') {
    const roleInput = new TextInputBuilder()
      .setCustomId('item_role')
      .setLabel('Role ID')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('123456789012345678')
      .setRequired(true);

    const imageInput = new TextInputBuilder()
      .setCustomId('item_image_url')
      .setLabel('Image URL')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('https://example.com/image.png')
      .setRequired(false);

    const durInput = new TextInputBuilder()
      .setCustomId('item_duration')
      .setLabel('Duration (Days)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('Leave empty for permanent')
      .setRequired(false);

    const reqInput = new TextInputBuilder()
      .setCustomId('item_required')
      .setLabel('Required Roles (Role IDs)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('separate IDs by "-" or "," or space')
      .setRequired(false);

    modal.addComponents(
      new ActionRowBuilder().addComponents(roleInput),
      new ActionRowBuilder().addComponents(imageInput),
      new ActionRowBuilder().addComponents(durInput),
      new ActionRowBuilder().addComponents(reqInput)
    );
  }
  // Pack no longer has price field here - set at post time

  await interaction.showModal(modal);
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

  const { getGuildConfig } = await import('../storage/config.js');
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
        const roleId = interaction.fields.getTextInputValue('item_role').trim();
        const durationRaw = interaction.fields.getTextInputValue('item_duration');
        // Read image URL (new field replacing Price)
        let itemImageUrl = null;
        try {
          const rawImg = interaction.fields.getTextInputValue('item_image_url').trim();
          if (rawImg && rawImg.toLowerCase() !== 'none') {
            // Basic URL validation to prevent Discord API errors (one or more errors)
            if (/^https?:\/\/.+\..+/i.test(rawImg)) {
              itemImageUrl = rawImg;
            } else {
              return interaction.followUp({ content: '❌ Invalid Image URL. Please provide a valid http/https link or leave it empty.', flags: MessageFlags.Ephemeral });
            }
          }
        } catch (e) { /* field may be absent on old interactions */ }

        if (!/^\d{17,20}$/.test(roleId)) {
          return interaction.editReply({ 
            content: '❌ Invalid Role ID.', 
            embeds: [],
            components: [
              new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('shop_admin_add').setLabel('Back').setStyle(ButtonStyle.Secondary)
              )
            ]
          });
        }
        
        // Block Booster Role as main Item Role
        const boosterRoleId = interaction.guild.roles.premiumSubscriberRole?.id;
        if (boosterRoleId && roleId === boosterRoleId) {
          return interaction.followUp({ content: "❌ Server Booster Role can't be a shop item. Enter it in the Requirements field instead to make Boosters only items.", flags: MessageFlags.Ephemeral });
        }

        // Block MVP Role as main Item Role
        const { getGuildConfig } = await import('../storage/config.js');
        const guildConfig = await getGuildConfig(interaction.guildId);
        if (guildConfig && guildConfig.mvpRoleId === roleId) {
          return interaction.followUp({ content: "❌ MVP Role can't be a shop item. Enter it in the Requirements field to make MVP only items.", flags: MessageFlags.Ephemeral });
        }

        if (!interaction.guild.roles.cache.has(roleId)) {
          return interaction.editReply({ 
            content: '❌ Role not found in server.', 
            embeds: [],
            components: [
              new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('shop_admin_add').setLabel('Back').setStyle(ButtonStyle.Secondary)
              )
            ]
          });
        }

        const uniqueCheck = await validateRoleUniqueness(interaction.guildId, roleId);
        if (!uniqueCheck.valid) {
          return interaction.editReply({ 
            content: `❌ Role already linked to **${uniqueCheck.existingItem?.name || roleId}**.`, 
            embeds: [], 
            components: [
              new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('shop_admin_add').setLabel('Back').setStyle(ButtonStyle.Secondary)
              )
            ]
          });
        }

        let durationSeconds = null;
        if (durationRaw && durationRaw.trim() !== '') {
          const days = parseInt(durationRaw.trim(), 10);
          if (days > 0) durationSeconds = days * 86400;
        }

        let requiredItems = [];
        let reqValidation = { resolved: [], errors: [], hasBooster: false, hasMvp: false };
        try {
          const reqRaw = interaction.fields.getTextInputValue('item_required');
          reqValidation = await resolvePrerequisiteIds(interaction.guild, reqRaw);
          
          if (reqValidation.errors.length > 0) {
            return interaction.followUp({ 
              content: `❌ Role(s) **${reqValidation.errors.join(', ')}** are not connected to any item in the shop.\nItems must be created in the shop first before they can be used as a requirement.`, 
              flags: MessageFlags.Ephemeral 
            });
          }
          requiredItems = reqValidation.resolved;
        } catch (e) {
          sysError('Shop Admin Failure', e, { guild: interaction.guildId, detail: 'Resolving prerequisites during add' });
        }

        const item = await addShopItem(interaction.guildId, null, roleId, name, '', null, durationSeconds, null, 'role', [], requiredItems, itemImageUrl);
        
        if (!item) {
          throw new Error('Database failed to return created item record.');
        }

        // Format Item Created embed description
        const roleMention = roleId ? `<@&${roleId}>` : '_None_';
        const descLines = [
          `**Name:** ${name}`,
          `**Role:** ${roleMention}`
        ];
        
        if (reqValidation.hasBooster) {
          descLines.push(`🚀 **Booster Requirement Linked:** This item will now require an active Server Boost to buy/equip.`);
        }
        if (reqValidation.hasMvp) {
          descLines.push(`🏆 **MVP Requirement Linked:** This item will now require the user to be the active Server MVP.`);
        }

        sendLog(interaction.guild, 'shop', 'green', '🛍️ Item Created', `Admin **<@${interaction.user.id}>** created item **${name}** (Price: Unset — must be set at post time)`);

        // Initialise pending attrs state for this new item (nothing is saved until Save is clicked)
        pendingItemAttrs.set(String(item.id), { categoryId: null, rarity: 'common', is_tradable: true });

        const categories = await getShopCategories(interaction.guildId);
        const catOptions = [
          { label: 'No Category', value: 'null', emoji: '🏷️', default: true },
          ...categories.slice(0, 24).map(c => ({
            label: ((c.name && c.name.trim().length > 0) ? c.name : `Unnamed Category #${c.id}`).slice(0, 100),
            value: c.id.toString(),
            emoji: '📂'
          }))
        ];

        const confirmEmbed = new EmbedBuilder()
          .setColor('#2ECC71')
          .setTitle('Item Created')
          .setDescription(descLines.join('\n'));

        const img = getItemImage(item);
        const imgResolved = img ? await resolveImageAttachment(img, 'item_thumb.png') : null;
        if (imgResolved) confirmEmbed.setThumbnail(imgResolved.uri);
        else if (img) confirmEmbed.setThumbnail(img);

        const rowCat = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`shop_new_cat_select_${item.id}`)
            .setPlaceholder('Category')
            .addOptions(catOptions)
        );

        const rowRarity = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`shop_new_rarity_select_${item.id}`)
            .setPlaceholder('Rarity')
            .addOptions(RARITY_OPTIONS.map(o => ({ ...o, default: o.value === 'common' })))
        );

        const lootBoxCatName = await getLootBoxCategoryName(interaction.guildId);
        const tradableOpts = getTradableOptions(lootBoxCatName);
        const rowTradable = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`shop_new_tradable_select_${item.id}`)
            .setPlaceholder('Status')
            .addOptions(tradableOpts.map(o => ({ ...o, default: o.value === 'tradable' })))
        );

        const rowActions = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('shop_admin_add')
            .setLabel('Back')
            .setEmoji('⬅️')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId(`shop_new_save_${item.id}`)
            .setLabel('Save')
            .setEmoji('💾')
            .setStyle(ButtonStyle.Success)
        );

        await interaction.editReply({
          content: null,
          embeds: [confirmEmbed],
          files: imgResolved ? [imgResolved.attachment] : [],
          components: [rowCat, rowRarity, rowTradable, rowActions]
        });
        return;

      } else if (type === 'pack') {
        // Packs price is set at post time (default to 0 if not provided)
        await addShopItem(interaction.guildId, null, '', name, '', 0, null, null, 'pack');
        sendLog(interaction.guild, 'shop', 'green', '📦 Pack Created', `Admin **<@${interaction.user.id}>** created pack **${name}** (Price: Unset — must be set at post time)`);
        await interaction.followUp({ content: `✅ Pack items created!`, flags: MessageFlags.Ephemeral });
        await handleShopAdminAdd(interaction);
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
        // Read image URL (new field replacing Price)
        try {
          const rawImg = interaction.fields.getTextInputValue('item_image_url').trim();
          // Empty string or 'none' = clear image
          if (rawImg === '' || rawImg.toLowerCase() === 'none' || rawImg.toLowerCase() === 'clear') {
            updates.default_image_url = null;
            if (oldItem.default_image_url) invalidateImageCache(oldItem.default_image_url);
          } else {
            updates.default_image_url = rawImg;
            if (oldItem.default_image_url && oldItem.default_image_url !== rawImg) {
              invalidateImageCache(oldItem.default_image_url);
            }
          }
        } catch (e) { /* field may be absent */ }

        if (roleId && roleId.toLowerCase() !== 'none') {
          // Block Booster Role as main Item Role
          const boosterRoleId = interaction.guild.roles.premiumSubscriberRole?.id;
          if (boosterRoleId && roleId === boosterRoleId) {
            return interaction.followUp({ content: "❌ Server Booster Role can't be a shop item. Enter it in the Requirements field instead to make Boosters only items.", flags: MessageFlags.Ephemeral });
          }

          // Block MVP Role as main Item Role
          const { getGuildConfig } = await import('../storage/config.js');
          const guildConfig = await getGuildConfig(interaction.guildId);
          if (guildConfig && guildConfig.mvpRoleId === roleId) {
            return interaction.followUp({ content: "❌ MVP Role can't be a shop item. Enter it in the Requirements field to make MVP only items.", flags: MessageFlags.Ephemeral });
          }

          if (!interaction.guild.roles.cache.has(roleId.split(/[,\s]+/)[0])) {
            return interaction.followUp({ content: '❌ Invalid Role ID.', flags: MessageFlags.Ephemeral });
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

      await updateShopItem(itemId, updates);
      const updatedRecord = await getShopItem(itemId);

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
  
  await updateShopItem(itemId, { category_id: categoryId });

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

const RARITY_OPTIONS = [
  { label: 'Common',    value: 'common',    emoji: '⚪' },
  { label: 'Uncommon',  value: 'uncommon',  emoji: '🟢' },
  { label: 'Rare',      value: 'rare',      emoji: '🔵' },
  { label: 'Epic',      value: 'epic',      emoji: '🟣' },
  { label: 'Legendary', value: 'legendary', emoji: '🟡' }
];

export function getTradableOptions(lootBoxName = 'loot boxes') {
  const name = (lootBoxName && lootBoxName.trim().length > 0) ? lootBoxName.trim() : 'Loot Boxes';
  return [
    { label: 'Unlocked', value: 'tradable',   emoji: '🔓', description: `Can be traded, dropped, or found in ${name.toLowerCase()}` },
    { label: 'Locked',   value: 'untradable', emoji: '🔒', description: `Cannot be traded, dropped, or found in ${name.toLowerCase()}` }
  ];
}

/**
 * Handles select menu changes on the Item Created panel.
 * Updates the in-memory pendingItemAttrs state and re-renders the panel.
 * Nothing is written to the DB here.
 */
export async function handleNewItemAttrSelect(interaction) {
  await interaction.deferUpdate();
  const cid = interaction.customId;
  const itemId = cid.split('_').pop();
  const value = interaction.values[0];

  const item = await getShopItem(itemId, interaction.guildId);
  if (!item) return interaction.followUp({ content: '❌ Item not found.', flags: MessageFlags.Ephemeral });

  // Retrieve or create pending state
  const state = pendingItemAttrs.get(String(itemId)) || { categoryId: null, rarity: 'common', is_tradable: true };

  if (cid.startsWith('shop_new_cat_select_')) {
    state.categoryId = value === 'null' ? null : value;
  } else if (cid.startsWith('shop_new_rarity_select_')) {
    state.rarity = value;
  } else if (cid.startsWith('shop_new_tradable_select_')) {
    state.is_tradable = value === 'tradable';
  }
  pendingItemAttrs.set(String(itemId), state);

  // Re-render the panel with updated default selections
  const categories = await getShopCategories(interaction.guildId);
  const catOptions = [
    { label: 'No Category', value: 'null', emoji: '🏷️', default: state.categoryId === null },
    ...categories.slice(0, 24).map(c => ({
      label: ((c.name && c.name.trim().length > 0) ? c.name : `Unnamed Category #${c.id}`).slice(0, 100),
      value: c.id.toString(),
      emoji: '📂',
      default: String(c.id) === String(state.categoryId)
    }))
  ];

  const img = getItemImage(item);
  const imgResolved = img ? await resolveImageAttachment(img, 'item_thumb.png') : null;
  const roleMention = item.role_id ? `<@&${item.role_id}>` : '_None_';
  const descLines = [
    `**Name:** ${item.name}`,
    `**Role:** ${roleMention}`
  ];

  const embed = new EmbedBuilder()
    .setColor('#2ECC71')
    .setTitle('Item Created')
    .setDescription(descLines.join('\n'));
  if (imgResolved) embed.setThumbnail(imgResolved.uri);
  else if (img) embed.setThumbnail(img);

  const rowCat = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`shop_new_cat_select_${itemId}`)
      .setPlaceholder('Category')
      .addOptions(catOptions)
  );

  const rowRarity = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`shop_new_rarity_select_${itemId}`)
      .setPlaceholder('Rarity')
      .addOptions(RARITY_OPTIONS.map(o => ({ ...o, default: o.value === state.rarity })))
  );

  const lootBoxCatName = await getLootBoxCategoryName(interaction.guildId);
  const tradableOpts = getTradableOptions(lootBoxCatName);
  const rowTradable = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`shop_new_tradable_select_${itemId}`)
      .setPlaceholder('Status')
      .addOptions(tradableOpts.map(o => ({ ...o, default: (o.value === 'tradable') === state.is_tradable })))
  );

  const rowActions = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('shop_admin_add')
      .setLabel('Back')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`shop_new_save_${itemId}`)
      .setLabel('Save')
      .setEmoji('💾')
      .setStyle(ButtonStyle.Success)
  );

  await interaction.editReply({
    content: null,
    embeds: [embed],
    files: imgResolved ? [imgResolved.attachment] : [],
    components: [rowCat, rowRarity, rowTradable, rowActions]
  });
}

/**
 * Handles the Save button on the Item Created panel.
 * Persists category, rarity, and is_tradable to the DB.
 */
export async function handleNewItemSave(interaction) {
  await interaction.deferUpdate();
  const itemId = interaction.customId.slice('shop_new_save_'.length);

  const state = pendingItemAttrs.get(String(itemId)) || { categoryId: null, rarity: 'common', is_tradable: true };
  pendingItemAttrs.delete(String(itemId));

  const item = await getShopItem(itemId, interaction.guildId);
  if (!item) return interaction.followUp({ content: '❌ Item not found.', flags: MessageFlags.Ephemeral });

  const catId = (state.categoryId !== null && state.categoryId !== 'null') ? parseInt(state.categoryId) : null;

  await updateShopItem(itemId, {
    category_id: catId,
    rarity: state.rarity,
    is_tradable: state.is_tradable
  }, interaction.guildId);

  if (catId) {
    const catName = (await query('SELECT name FROM shop_categories WHERE id = $1 AND guild_id = $2', [catId, interaction.guildId])).rows[0]?.name ?? catId;
    sendLog(interaction.guild, 'shop', 'blue', '📂 Category Assigned', `Admin **<@${interaction.user.id}>** assigned item **${item.name}** to category **${catName}**.`);
  }

  await handleShopAdminAdd(interaction);
}



// Updated Post Item Handlers - Staging Panel
export async function handleShopPostStart(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

  const userId = interaction.user.id;
  const guildId = interaction.guildId;

  // Fetch ALL items/packs
  const items = await getShopItems(guildId, null, 'name', true);

  if (items.length === 0) {
    const emptyRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('shop_admin_home').setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary)
    );
    const emptyEmbed = new EmbedBuilder().setColor('#95A5A6').setDescription('No items found.');
    return interaction.editReply({ content: null, embeds: [emptyEmbed], components: [emptyRow] });
  }

  // Get current pending state or initialize
  let state = pendingPosts.get(userId) || {};
  
  // Enforce defaults for missing keys (critical for Post-Publish re-render)
  state.itemId = state.itemId ?? null;
  state.channelId = state.channelId ?? null;
  state.sellerId = state.sellerId ?? null;
  state.imageUrl = state.imageUrl ?? null;
  state.description = state.description ?? null;
  state.payout = state.payout ?? null;
  state.stock = state.stock ?? null;
  state.overridePrice = state.overridePrice ?? null;
  state.postStep = (state.postStep === undefined || state.postStep === null) ? 0 : state.postStep;
  state.postFilter = state.postFilter ?? null;
  state.isEditing = state.isEditing ?? false;
  state.stockConfigured = state.stockConfigured ?? false;

  pendingPosts.set(userId, state);

  // Build embed with current selections
  const selectedItem = state.itemId ? items.find(i => i.id === parseInt(state.itemId)) : null;
  const isPack = selectedItem && (selectedItem.item_type === 'pack' || selectedItem.is_pack);

  // Validation for button states
  const canPublish = state.itemId && state.channelId && state.overridePrice !== null;
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

  const embed = new EmbedBuilder()
    .setTitle(state.isEditing ? '📢 Edit Shop Post' : '📢 Post an Item/Pack To The Shop!')
    .setColor(0x9B59B6);

  // Show item image as small thumbnail preview in the staging embed
  let previewImgResolved = null;
  if (selectedItem) {
    const previewImg = state.imageUrl || getItemImage(selectedItem);
    if (previewImg) {
      previewImgResolved = await resolveImageAttachment(previewImg, 'item_preview.png');
      if (previewImgResolved) embed.setThumbnail(previewImgResolved.uri);
      else embed.setThumbnail(previewImg);
    }
  }

  // Prioritized status description
  let statusDesc = '';
  if (state.isEditing) {
    if (state.overridePrice === null) {
      statusDesc = '⚠️ Set a price for that item';
    } else if (!state.stockConfigured) {
      statusDesc = '⚠️ Configure the stock using the Set Stocks button first';
    }
  } else {
    if (!state.itemId) {
      statusDesc = '⚠️ Select an Item to post';
    } else if (!state.channelId) {
      statusDesc = '⚠️ Set a channel to post the item to';
    } else if (!isPack && state.overridePrice === null) {
      statusDesc = '⚠️ Set a price for that item';
    }
  }
  
  embed.setDescription(statusDesc || null);

  // --- Item Navigation Wizard ---
  const categories = await getShopCategories(guildId);
  const itemsAll = await getShopItems(guildId, null, 'name', false); // Post flow: Active items only
  const lootBoxCatName = await getLootBoxCategoryName(guildId);
  const lootBoxEmoji = await getLootBoxCategoryEmoji(guildId);
  
  let itemOptions = [];
  let placeholder = '📦 Select Item/Pack (Required)';

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
        customId: 'shop_post_item_select',
        placeholder: '📂 Choose Category Folder...',
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
        groupName = categories.find(c => c.id === catId)?.name || 'Category';
        groupPrefix = '🏷️';
      }

      if (filtered.length === 0) {
        const emptyRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('shop_post_back_folder').setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary)
        );
        const emptyEmbed = new EmbedBuilder().setColor('#95A5A6').setDescription('No items found.');
        return interaction.editReply({ content: null, embeds: [emptyEmbed], components: [emptyRow] });
      }

      const page = state.postPage || 1;
      const { selectMenu } = buildPaginatedSelectMenu({
        items: filtered,
        page,
        customId: 'shop_post_item_select',
        placeholder: `${groupPrefix} ${groupName.slice(0, 20)}: Pick one`,
        pageNavPrefix: 'shop_post_page_',
        pageSize: 20,
        mapOption: i => ({
          label: i.name.slice(0, 100),
          value: i.id.toString(),
          emoji: parseSelectEmoji(groupPrefix),
          default: state.itemId === i.id.toString()
        })
      });

      itemSelect = !state.isEditing ? selectMenu : null;
    }

    // Unified Empty State Fallback for step 0
    if (state.postStep === 0 && itemOptions.length === 0) {
      const emptyRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId((state.isEditing || state.fromGateway) ? 'shop_admin_post' : 'shop_admin_home')
          .setLabel('Back')
          .setEmoji('⬅️')
          .setStyle(ButtonStyle.Secondary)
      );
      const emptyEmbed = new EmbedBuilder()
        .setColor('#95A5A6')
        .setDescription('No items found.');
      return interaction.editReply({ content: null, embeds: [emptyEmbed], components: [emptyRow] });
    }

    if (state.postStep === 0) {
      const placeholder = '📦 Select Item/Pack (Required)';
      itemSelect = !state.isEditing ? new StringSelectMenuBuilder()
        .setCustomId('shop_post_item_select')
        .setPlaceholder(placeholder)
        .addOptions(itemOptions) : null;
    }
  }

  // Row 2: Channel Select
  const channelSelect = !state.isEditing ? new ChannelSelectMenuBuilder()
    .setCustomId('shop_post_channel_select')
    .setPlaceholder('🏪 Select Channel (Required)')
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement) : null;
  if (!state.isEditing && state.channelId) channelSelect.setDefaultChannels([state.channelId]);

  // Row 3: User Select (Seller - Optional, disabled for packs and loot boxes)
  const isServerManaged = isPack || (selectedItem && selectedItem.item_type === 'loot_box');
  const userSelect = new UserSelectMenuBuilder()
    .setCustomId('shop_post_seller_select')
    .setPlaceholder(isServerManaged ? '👤 Seller disabled for this type' : '👤 Select Seller (Optional)')
    .setDisabled(isServerManaged === true);
  if (state.sellerId && !isServerManaged) userSelect.setDefaultUsers([state.sellerId]);

  const isItemSelected = !!state.itemId;
  const isModified = state.itemId !== null || 
                     state.channelId !== null || 
                     state.sellerId !== null || 
                     state.description !== null || 
                     state.imageUrl !== null || 
                     state.payout !== null || 
                     state.stock !== null || 
                     state.overridePrice !== null;

  // Row 4: Config Buttons (4 buttons)
  const configRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('shop_post_desc_btn')
      .setLabel('Set Desc')
      .setEmoji('📝')
      .setStyle(state.description ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(!isItemSelected),
    new ButtonBuilder()
      .setCustomId('shop_post_image_btn')
      .setLabel('Set Image')
      .setEmoji('🖼️')
      .setStyle(state.imageUrl ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(!isItemSelected),
    new ButtonBuilder()
      .setCustomId('shop_post_payout_btn')
      .setLabel('Set Payout')
      .setEmoji('💰')
      .setStyle(state.payout ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(!canSetPayout || !isItemSelected || isServerManaged),
    new ButtonBuilder()
      .setCustomId('shop_post_price_btn')
      .setLabel('Set Price')
      .setEmoji('🏷️')
      .setStyle((state.overridePrice !== null && state.overridePrice !== 0) ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(!isItemSelected)
  );

  // Row 5: Action Buttons (4 buttons)
  let postBackCustomId;
  if (state.postStep > 0) {
    postBackCustomId = 'shop_post_back_folder';
  } else {
    postBackCustomId = (state.isEditing || state.fromGateway) ? 'shop_admin_post' : 'shop_admin_home';
  }

  const actionComponents = [];
  actionComponents.push(
    new ButtonBuilder()
      .setCustomId(postBackCustomId)
      .setLabel('Back')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary)
  );

  if (!state.isEditing) {
    actionComponents.push(
      new ButtonBuilder()
        .setCustomId('shop_post_reset')
        .setLabel('Reset')
        .setEmoji('🔄')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!isModified)
    );
  }

  actionComponents.push(
    new ButtonBuilder()
      .setCustomId('shop_post_stock_btn')
      .setLabel('Set Stocks')
      .setEmoji('⏳')
      .setStyle((state.stock !== null && state.stock !== 0) ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(!isItemSelected)
  );

  const confirmBtn = new ButtonBuilder()
    .setCustomId(state.isEditing ? 'shop_post_update' : 'shop_post_publish')
    .setLabel(state.isEditing ? 'Update' : 'Publish')
    .setEmoji('🚀')
    .setStyle(ButtonStyle.Success);

  let canSubmit = false;
  if (state.isEditing) {
    canSubmit = state.overridePrice !== null && state.stockConfigured === true;
  } else {
    canSubmit = canPublish;
  }
  confirmBtn.setDisabled(!canSubmit);
  actionComponents.push(confirmBtn);

  const actionRow = new ActionRowBuilder().addComponents(actionComponents);

  const components = [];
  if (!state.isEditing) {
    components.push(new ActionRowBuilder().addComponents(itemSelect));
    components.push(new ActionRowBuilder().addComponents(channelSelect));
  }
  components.push(new ActionRowBuilder().addComponents(userSelect));
  components.push(configRow);
  components.push(actionRow);

  await interaction.editReply({
    content: null,
    embeds: [embed],
    files: previewImgResolved ? [previewImgResolved.attachment] : [],
    components: components
  });
}

export async function handleShopPostBackFolder(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
    const userId = interaction.user.id;
    let state = pendingPosts.get(userId);
    if (!state) return handleShopPostStart(interaction);

    if (state.postStep === 2) {
      state.postStep = state.postFilter?.startsWith('cat_') ? 1 : 0;
      state.postPage = 1;
    } else if (state.postStep === 1) {
      state.postStep = 0;
      state.postPage = 1;
    }
    pendingPosts.set(userId, state);
    return handleShopPostStart(interaction);
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop post back folder');
  }
}

// Handle Item Selection in Staging Panel
export async function handleShopPostItemSelect(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
  const userId = interaction.user.id;
  const itemId = interaction.values[0];
  let state = pendingPosts.get(userId);
  if (!state) {
    state = {
      itemId: null, channelId: null, sellerId: null,
      imageUrl: null, description: null, payout: null, stock: null,
      overridePrice: null, postStep: 0, postFilter: null,
      isEditing: false, stockConfigured: false, fromGateway: false
    };
  }

  // --- Page Navigation Routing ---
  if (itemId.startsWith('shop_post_page_')) {
    state.postPage = parseInt(itemId.replace('shop_post_page_', ''), 10) || 1;
    pendingPosts.set(userId, state);
    return handleShopPostStart(interaction);
  }

  // --- Folder Navigation Routing ---
  if (itemId === 'folder_reset') {
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

    // For new posts, everything must start over as null/unconfigured
    state.overridePrice = null;
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

  pendingPosts.set(userId, state);

  // Re-render panel
  await handleShopPostStart(interaction);
}

// Handle Channel Selection in Staging Panel
export async function handleShopPostChannelSelect(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
  const userId = interaction.user.id;
  const channelId = interaction.values[0];

  let state = pendingPosts.get(userId);
  if (!state) {
    state = {
      itemId: null, channelId: null, sellerId: null,
      imageUrl: null, description: null, payout: null, stock: null,
      overridePrice: null, postStep: 0, postFilter: null,
      isEditing: false, stockConfigured: false, fromGateway: false
    };
  }
  state.channelId = channelId;
  pendingPosts.set(userId, state);

  // Re-render panel
  await handleShopPostStart(interaction);
}

// Handle Seller Selection in Staging Panel
export async function handleShopPostSellerSelect(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
  const userId = interaction.user.id;
  const selectedUserId = interaction.values[0];
  const guildOwnerId = interaction.guild.ownerId;

  let state = pendingPosts.get(userId);
  if (!state) {
    state = {
      itemId: null, channelId: null, sellerId: null,
      imageUrl: null, description: null, payout: null, stock: null,
      overridePrice: null, postStep: 0, postFilter: null,
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

  pendingPosts.set(userId, state);

  // Re-render panel
  await handleShopPostStart(interaction);
}

// Handle Description Button - Show Modal
export async function handleShopPostDescBtn(interaction) {
  const state = pendingPosts.get(interaction.user.id) || {};

  const modal = new ModalBuilder()
    .setCustomId(`shop_post_desc_modal_${Date.now()}`)
    .setTitle('Item Description');

  // state.description holds: the embed-scraped text (edit flow) or user-entered text (create flow)
  let descValue = (state.description ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Safety: truncate to 1000 chars to prevent Discord.js validation errors on old posts
  if (descValue.length > 1000) descValue = descValue.substring(0, 1000);

  const descInput = new TextInputBuilder()
    .setCustomId('description')
    .setLabel('Description')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('A very cool item that makes you look even cooler!')
    .setValue(descValue)
    .setRequired(false)
    .setMaxLength(1000);

  modal.addComponents(new ActionRowBuilder().addComponents(descInput));
  await interaction.showModal(modal);
}

// Handle Price Button - Show Modal
export async function handleShopPostPriceBtn(interaction) {
  const userId = interaction.user.id;
  const state = pendingPosts.get(userId);
  if (!state) return;

  const modal = new ModalBuilder()
    .setCustomId(`shop_post_price_modal_${Date.now()}`)
    .setTitle('Item Price');

  const priceInput = new TextInputBuilder()
    .setCustomId('price_input')
    .setLabel('Price')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('0 = Free')
    .setValue((state.overridePrice !== null && state.overridePrice !== undefined) ? state.overridePrice.toString() : '')
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(priceInput));
  await interaction.showModal(modal);
}

export async function handleShopPostPayoutBtn(interaction) {
  const userId = interaction.user.id;
  const state = pendingPosts.get(userId);
  if (!state) return;
  
  // Calculate recommended 50%
  try {
    let suggestedCut = 0;
      // Suggested cut is based on overridePrice (the post-time price), not the stored null price
      if (state.itemId && state.overridePrice !== null) {
        suggestedCut = Math.floor(Number(state.overridePrice) * 0.5);
      }

    const modal = new ModalBuilder()
      .setCustomId(`shop_post_payout_modal_${Date.now()}`)
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

// Handle Stock Button - Show Modal
export async function handleShopPostStockBtn(interaction) {
  const state = pendingPosts.get(interaction.user.id) || {};

  const modal = new ModalBuilder()
    .setCustomId(`shop_post_stock_modal_${Date.now()}`)
    .setTitle('Item Stocks');

  const stockInput = new TextInputBuilder()
    .setCustomId('stock')
    .setLabel('Stocks')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('0 = Unlimited')
    .setValue((state.stock !== null && state.stock !== undefined) ? String(state.stock) : '')
    .setRequired(false);

  modal.addComponents(new ActionRowBuilder().addComponents(stockInput));
  await interaction.showModal(modal);
}

// Handle Reset Button
export async function handleShopPostReset(interaction) {
  await interaction.deferUpdate();
  const state = pendingPosts.get(interaction.user.id);
  if (state) {
    state.itemId = null;
    state.channelId = null;
    state.sellerId = null;
    state.payout = null;
    state.stock = null;
    state.description = null;
    state.imageUrl = null;
    state.overridePrice = null;
    state.postStep = 0;
    state.postFilter = null;
    state.stockConfigured = false;
    pendingPosts.set(interaction.user.id, state);
  }
  await handleShopPostStart(interaction);
}

// Handle Image URL Button - Show Modal
export async function handleShopPostImageBtn(interaction) {
  const state = pendingPosts.get(interaction.user.id) || {};

  const modal = new ModalBuilder()
    .setCustomId(`shop_post_image_modal_${Date.now()}`)
    .setTitle('Item Image');

  const urlInput = new TextInputBuilder()
    .setCustomId('image_url')
    .setLabel('Image URL')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Empty = Default')
    .setValue(state.imageUrl || '')
    .setRequired(false);

  modal.addComponents(new ActionRowBuilder().addComponents(urlInput));
  await interaction.showModal(modal);
}

// Handle All Post Modal Submits (Image, Desc, Payout)
export async function handleShopPostModalSubmit(interaction) {
  try {
    await interaction.deferUpdate();
    const userId = interaction.user.id;
    const rawCustomId = interaction.customId;
    const customId = rawCustomId.includes('_modal')
      ? rawCustomId.substring(0, rawCustomId.indexOf('_modal') + 6)
      : rawCustomId;

    let state = pendingPosts.get(userId);
    if (!state) {
      state = {
        itemId: null, channelId: null, sellerId: null,
        imageUrl: null, description: null, payout: null, stock: null,
        overridePrice: null, postStep: 0, postFilter: null,
        isEditing: false, stockConfigured: false, fromGateway: false
      };
    }

    if (customId === 'shop_post_image_modal') {
      const oldVal = state.imageUrl;
      const val = (interaction.fields.getTextInputValue('image_url') || '').trim().toLowerCase();
      state.imageUrl = (val === '' || val === 'none' || val === 'default') ? null : interaction.fields.getTextInputValue('image_url');
      if (oldVal && oldVal !== state.imageUrl) invalidateImageCache(oldVal);
    } else if (customId === 'shop_post_desc_modal') {
      const val = (interaction.fields.getTextInputValue('description') || '').trim();
      state.description = val === '' ? null : val;
    } else if (customId === 'shop_post_payout_modal') {
      const val = (interaction.fields.getTextInputValue('payout') || '').trim();
      let inputAmount = 0; // Default to 0
      if (val !== '') {
        if (!/^\d+$/.test(val)) {
          return interaction.followUp({ content: '❌ Invalid payout. Please enter a valid positive whole number.', flags: MessageFlags.Ephemeral });
        }
        inputAmount = parseInt(val, 10);
      }

      state.payout = (inputAmount > 0) ? inputAmount : null;
    } else if (customId === 'shop_post_stock_modal') {
      const val = (interaction.fields.getTextInputValue('stock') || '').trim().toLowerCase();
      // 0 or empty or 'unlimited' all mean Unlimited
      if (val === '' || val === '0' || val === 'unlimited') {
        state.stock = null; // Infinite stock
      } else {
        if (!/^\d+$/.test(val)) {
          return interaction.followUp({ content: '❌ Invalid stock. Please enter a valid positive whole number.', flags: MessageFlags.Ephemeral });
        }
        const num = parseInt(val, 10);
        state.stock = num <= 0 ? null : num; // Double check: 0 or less = Unlimited
      }
      state.stockConfigured = true;
    } else if (customId === 'shop_post_price_modal') {
      const val = (interaction.fields.getTextInputValue('price_input') || '').trim();
      
      if (val === '') {
        // User cleared the price field — keep existing or null
        // Do not allow clearing once required
        return interaction.followUp({ content: '❌ Price is required. Please enter a valid price (0 for free).', flags: MessageFlags.Ephemeral });
      }

      const newPrice = /^\d+$/.test(val) ? parseInt(val, 10) : -1;
      if (newPrice < 0) {
        return interaction.followUp({ content: '❌ Please enter a valid non-negative whole number.', flags: MessageFlags.Ephemeral });
      }
      state.overridePrice = newPrice;
    }

    pendingPosts.set(userId, state);

    // Re-render panel
    await handleShopPostStart(interaction);
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop post modal submit');
  }
}

// Handle Publish Button - Actually post the item
export async function handleShopPostPublish(interaction) {
  try {
    const userId = interaction.user.id;
    const state = pendingPosts.get(userId);

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
        return interaction.followUp({
          content: '❌ This loot box has neither item drop rates nor coin rewards enabled. Please configure rewards in Chests Management before publishing.',
          flags: MessageFlags.Ephemeral
        });
      }
    }

    // Price is now always provided via overridePrice (required before publishing)
    const effectivePrice = state.overridePrice !== null && state.overridePrice !== undefined
      ? Number(state.overridePrice)
      : null;

    if (effectivePrice === null) {
      return interaction.followUp({ content: '❌ You must set a price using the **Set Price** button before publishing.', flags: MessageFlags.Ephemeral });
    }

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

    // JIT Sync: Always update global price and stock in DB before publishing to ensure state consistency
    await updateShopItem(itemId, { price: effectivePrice, stock }); 
    item.price = effectivePrice;
    item.stock = stock;

    // Image: instance-specific override takes priority, then item's default image
    const finalImage = imageUrl || getItemImage(item);
    const finalImageResolved = finalImage ? await resolveImageAttachment(finalImage, 'shop_item.png') : null;
    if (finalImageResolved) {
      embed.setImage(finalImageResolved.uri); // LARGE banner image for publicly posted shop embeds
    } else if (finalImage) {
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

    // Stock Field (Visual)
    let stockHeader = '♾️ Stock';
    let stockValue = 'Unlimited';

    if (item.stock === null || item.stock === undefined) {
      stockHeader = '♾️ Stock';
      stockValue = 'Unlimited';
    } else if (item.stock <= 0) {
      stockHeader = '🔴 Stock';
      stockValue = 'Sold Out';
      embed.setColor('#3498DB'); // Always Blue (even if Sold Out)
    } else {
      stockHeader = '🟢 Stock';
      stockValue = `**${item.stock}** Left`;
    }
    
    embed.addFields({ name: stockHeader, value: stockValue, inline: true });

    // Create Buy Button with Seller ID, Payout, and Override Price encoded
    // Format: bank_shop_buy_[itemId]_[sellerId]_[payout]_[overridePrice]
    const sellerPart = sellerId || '0';
    const payoutPart = payout || '0';
    const overridePart = state.overridePrice !== null ? state.overridePrice : ''; // Empty means use default
    
    const isSoldOut = item.stock !== null && item.stock <= 0;
    
    const buyButton = new ButtonBuilder()
      .setCustomId(`bank_shop_buy_${itemId}_${sellerPart}_${payoutPart}_${overridePart}`)
      .setLabel(isFree ? 'BUY (FREE)' : `BUY (${effectivePrice.toLocaleString()})`)
      .setEmoji(`${COIN_EMOJI}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(isSoldOut);

    const row = new ActionRowBuilder().addComponents(buyButton);

    await channel.send({ embeds: [embed], files: finalImageResolved ? [finalImageResolved.attachment] : [], components: [row] });

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

    // Reset session state for this user (Keep channelId/sellerId for convenience)
    pendingPosts.set(userId, { 
      channelId, 
      sellerId,
      itemId: null,
      imageUrl: null,
      description: null,
      payout: null,
      stock: null,
      overridePrice: null,
      postStep: 0,
      postFilter: null
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
    const state = pendingPosts.get(interaction.user.id);
    const targetChannel = state?.channelId ? interaction.guild?.channels?.cache?.get(state.channelId) : interaction.channel;
    await handleInteractionError(interaction, error, 'Publish Shop Post', { targetChannel });
  }
}

// --- Tier Management ---
export async function handleManageTiers(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    const itemId = interaction.customId.split('_').pop();
    const tiers = await getItemTiers(itemId, interaction.guildId);
    const item = await getShopItem(itemId, interaction.guildId);

    if (!item) {
      return interaction.editReply({ content: '❌ Item not found.', embeds: [], components: [] });
    }

    const embed = new EmbedBuilder()
      .setTitle(`📶 Tiers for ${item.name}`)
      .setDescription(tiers.length === 0 ? 'No tiers configured.' : 'Current Tiers:')
      .setColor('#F1C40F');

    if (tiers.length > 0) {
      const tierDesc = tiers.map(t => `**Level ${t.tier_level}**: ${t.upgrade_price === 0 ? 'FREE' : t.upgrade_price.toLocaleString() + ' coins'} (Role: <@&${t.role_id}>)`).join('\n');
      embed.addFields({ name: 'Upgrades', value: tierDesc });
    }

    const actionRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`shop_tier_add_${itemId}`)
          .setLabel('Add Tier')
          .setEmoji('➕')
          .setStyle(ButtonStyle.Success)
      );

    const backRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`shop_item_edit_${itemId}`) // Go back to item manage 
        .setLabel('Back')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.editReply({ embeds: [embed], components: [actionRow, backRow] });
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop manage tiers');
  }
}

export async function handleAddTierModal(interaction) {
  try {
    const itemId = interaction.customId.split('_').pop();

    const modal = new ModalBuilder()
      .setCustomId(`shop_tier_modal_add_${itemId}`)
      .setTitle('Add Upgrade Tier');

    const levelInput = new TextInputBuilder()
      .setCustomId('tier_level')
      .setLabel('Tier Level (e.g. 2)')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const priceInput = new TextInputBuilder()
      .setCustomId('tier_price')
      .setLabel('Upgrade Price')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('5000')
      .setRequired(true);

    const roleInput = new TextInputBuilder()
      .setCustomId('tier_role')
      .setLabel('Role ID for this Tier')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(
      new ActionRowBuilder().addComponents(levelInput),
      new ActionRowBuilder().addComponents(priceInput),
      new ActionRowBuilder().addComponents(roleInput)
    );

    await interaction.showModal(modal);
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop add tier modal');
  }
}

export async function handleTierModalSubmit(interaction) {
  try {
    await interaction.deferUpdate();
    const itemId = interaction.customId.split('_').pop();

    const level = parseInt(interaction.fields.getTextInputValue('tier_level'));
    const price = parseInt(interaction.fields.getTextInputValue('tier_price'));
    const roleId = interaction.fields.getTextInputValue('tier_role');

    await addItemTier(itemId, interaction.guildId, level, roleId, price);

    // Standardized Shop Admin Log
    const item = await getShopItem(itemId, interaction.guildId);
    sendLog(interaction.guild, 'shop', 'green', '📶 Tier Added', `Admin **<@${interaction.user.id}>** added Tier **${level}** to **${item?.name || itemId}** (Price: **${price.toLocaleString()}** ${COIN_EMOJI})`);

    await interaction.followUp({ content: `✅ Tier ${level} added!`, flags: MessageFlags.Ephemeral });

    // Refresh Tier View
    const mockInteraction = {
      deferred: true,
      replied: false,
      deferUpdate: async () => { },
      editReply: interaction.editReply.bind(interaction),
      customId: `shop_manage_tiers_${itemId}`,
      guildId: interaction.guildId,
      user: interaction.user
    };
    await handleManageTiers(mockInteraction);

  } catch (error) {
    await handleInteractionError(interaction, error, 'Tier modal submit');
  }
}

// --- Delete Item Handlers ---

export async function handleDeleteItemStart(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    const context = { action: 'delete_item', folder: 'root', message: null };
    pendingAdminBrowser.set(interaction.user.id, context);
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
    pendingAdminBrowser.set(interaction.user.id, context);
    await renderAdminBrowser(interaction, context);
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop delete item select');
  }
}

export async function handleDeletePackStart(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    const context = { action: 'delete_pack', folder: 'root', message: null };
    pendingAdminBrowser.set(interaction.user.id, context);
    await renderAdminBrowser(interaction, context);
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop delete pack start');
  }
}

export async function handleDeleteLootBoxStart(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    const context = { action: 'delete_lootbox', folder: 'root', message: null };
    pendingAdminBrowser.set(interaction.user.id, context);
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
    pendingAdminBrowser.set(interaction.user.id, context);
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

    if (isEdit) {
      // ========== EDIT FLOW ==========
      const res = await query('UPDATE shop_categories SET name = $1, category_type = $2 WHERE id = $3 AND guild_id = $4 RETURNING *', [name, type, categoryId, interaction.guildId]);
      
      if (res.rowCount > 0) {
        sendLog(interaction.guild, 'shop', 'blue', '📂 Category Updated', `Admin **<@${interaction.user.id}>** updated category **${name}** (ID: ${categoryId})`);
        
        // Re-render dashboard with success header
        const mock = {
          deferred: true, replied: false,
          deferUpdate: async () => {},
          editReply: interaction.editReply.bind(interaction),
          followUp: interaction.followUp.bind(interaction),
          customId: `shop_cat_manage_${categoryId}`,
          values: [String(categoryId)],
          isAnySelectMenu: () => false,
          guildId: interaction.guildId,
          user: interaction.user,
          guild: interaction.guild
        };
        await handleEditCategorySelect(mock, `✅ Category **${name}** updated!`);
      } else {
        await interaction.followUp({ content: '❌ Category not found.', flags: MessageFlags.Ephemeral });
      }
    } else {
      // ========== ADD FLOW ==========
      await addShopCategory(interaction.guildId, name, 0, type);
      sendLog(interaction.guild, 'shop', 'green', '📂 Category Created', `Admin **<@${interaction.user.id}>** created shop category **${name}**`);
      
      await handleShopAdminAdd(interaction); // Return to Add Menu
      await interaction.followUp({ content: `✅ Category **${name}** created!`, flags: MessageFlags.Ephemeral });
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
      new ButtonBuilder().setCustomId('shop_admin_edit').setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary)
    );

    if (categories.length === 0) {
      const emptyEmbed = new EmbedBuilder().setColor('#95A5A6').setDescription('No items found.');
      return interaction.editReply({ content: null, embeds: [emptyEmbed], components: [rowBack] });
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
      .setTitle('📂 Category Management')
      .setDescription('**Select a category to manage:**');

    const row = new ActionRowBuilder().addComponents(selectMenu);

    await interaction.editReply({ content: null, embeds: [embed], components: [row, rowBack] });
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop edit category start');
  }
}

export async function handleEditCategorySelect(interaction, successHeader = null) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

    // Determine categoryId: from select menu (values[0]) or from back button (customId)
    let categoryId;
    if (interaction.isAnySelectMenu()) {
      categoryId = interaction.values[0];
    } else {
      categoryId = interaction.customId.split('_').pop();
    }

    if (categoryId.startsWith('cat_edit_rename_page_')) {
      const page = parseInt(categoryId.replace('cat_edit_rename_page_', ''), 10) || 1;
      return handleEditCategoryStart(interaction, page);
    }

    const categories = await getShopCategories(interaction.guildId);
    const category = categories.find(c => c.id.toString() === categoryId);

    if (!category) {
      return interaction.editReply({ content: '❌ Category not found.', embeds: [], components: [] });
    }

    // NEW: Fetch items to show count in dashboard
    const items = await getShopItems(interaction.guildId, parseInt(categoryId), 'price', true);
    const count = items.length;
    const typeLabel = category.category_type === 1 ? 'Single (Swap)' : 'Multi (Stack)';

    const embed = new EmbedBuilder()
      .setTitle(`📂 Category: ${category.name}`)
      .setDescription(`Manage items and settings for this category.\n\n**Type:** \`${typeLabel}\`\n**Items:** \`${count}\``)
      .setColor('#9B59B6');

    const actionRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`shop_cat_add_${categoryId}`)
          .setLabel('Add Items')
          .setEmoji('➕')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`shop_cat_remove_${categoryId}`)
          .setLabel('Remove Items')
          .setEmoji('➖')
          .setStyle(ButtonStyle.Danger)
      );

    const backRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('shop_edit_category_start') // Back to list
        .setLabel('Back')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`shop_cat_settings_${categoryId}`)
        .setLabel('Edit')
        .setEmoji('✏️')
        .setStyle(ButtonStyle.Primary)
    );

    await interaction.editReply({ content: successHeader || null, embeds: [embed], components: [actionRow, backRow] });
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop edit category select');
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

    const rowBack = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`shop_cat_manage_${categoryId}`) // Back to category management
        .setLabel('Back')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary)
    );

    if (standalone.length === 0) {
      const emptyEmbed = new EmbedBuilder().setColor('#95A5A6').setDescription('No items found.');
      return interaction.editReply({ content: null, embeds: [emptyEmbed], components: [rowBack] });
    }

    const pageNum = typeof page === 'number' ? page : (parseInt(page, 10) || 1);
    const { selectMenu } = buildPaginatedSelectMenu({
      items: standalone,
      page: pageNum,
      customId: `shop_edit_cat_add_select_${categoryId}`,
      placeholder: 'Select',
      pageNavPrefix: `cat_add_nav_${categoryId}_`,
      pageSize: 20,
      mapOption: i => ({
        label: ((i.name && i.name.trim().length > 0) ? i.name : `Unnamed Item #${i.id}`).slice(0, 100),
        value: i.id.toString(),
        emoji: '🏷️'
      })
    });

    const row = new ActionRowBuilder().addComponents(selectMenu);

    const embedPrompt = new EmbedBuilder()
      .setColor('#2ECC71')
      .setTitle('Select Item(s) to Add to Category');

    await interaction.editReply({ 
        content: null, 
        components: [row, rowBack], 
        embeds: [embedPrompt] 
    });
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

    await updateShopItem(itemId, { category_id: parseInt(categoryId) });

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

    const rowBack = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`shop_cat_manage_${categoryId}`)
        .setLabel('Back')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary)
    );

    if (standalone.length === 0) {
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
        items: standalone,
        page: 1,
        customId: `shop_edit_cat_add_select_${categoryId}`,
        placeholder: 'Select',
        pageNavPrefix: `cat_add_nav_${categoryId}_`,
        pageSize: 20,
        mapOption: i => ({
          label: ((i.name && i.name.trim().length > 0) ? i.name : `Unnamed Item #${i.id}`).slice(0, 100),
          value: i.id.toString(),
          emoji: '🏷️'
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

    const rowBack = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`shop_cat_manage_${categoryId}`) // Back to category management
        .setLabel('Back')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary)
    );

    if (items.length === 0) {
      const emptyEmbed = new EmbedBuilder().setColor('#95A5A6').setDescription('No items found.');
      return interaction.editReply({ content: null, embeds: [emptyEmbed], components: [rowBack] });
    }

    const pageNum = typeof page === 'number' ? page : (parseInt(page, 10) || 1);
    const { selectMenu } = buildPaginatedSelectMenu({
      items,
      page: pageNum,
      customId: `shop_edit_cat_remove_select_${categoryId}`,
      placeholder: 'Select',
      pageNavPrefix: `cat_remove_nav_${categoryId}_`,
      pageSize: 20,
      mapOption: i => ({
        label: ((i.name && i.name.trim().length > 0) ? i.name : `Unnamed Item #${i.id}`).slice(0, 100),
        value: i.id.toString(),
        emoji: '🏷️'
      })
    });

    const row = new ActionRowBuilder().addComponents(selectMenu);

    const embedPrompt = new EmbedBuilder()
      .setColor('#3498DB')
      .setTitle('Select Item(s) to Remove from Category');

    await interaction.editReply({ 
        content: successHeader || null, 
        components: [row, rowBack], 
        embeds: [embedPrompt] 
    });
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

    await updateShopItem(itemId, { category_id: null });

    // Standardized Shop Admin Log
    sendLog(interaction.guild, 'shop', 'blue', '📂 Item Removed from Category', `Admin **<@${interaction.user.id}>** removed item **${removedItemName}** from category **${categoryName}**`);


    // --- Persistent Menu Logic ---

    // 3. Fetch remaining items in this category
    const items = await getShopItems(interaction.guildId, parseInt(categoryId), 'price', true);

    const rowBack = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`shop_cat_manage_${categoryId}`)
        .setLabel('Back')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary)
    );

    if (items.length === 0) {
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
        items,
        page: 1,
        customId: `shop_edit_cat_remove_select_${categoryId}`,
        placeholder: 'Select',
        pageNavPrefix: `cat_remove_nav_${categoryId}_`,
        pageSize: 20,
        mapOption: i => ({
          label: ((i.name && i.name.trim().length > 0) ? i.name : `Unnamed Item #${i.id}`).slice(0, 100),
          value: i.id.toString(),
          emoji: '🏷️'
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

    await updateShopCategory(categoryId, { name, category_type: type });

    // Standardized Shop Admin Log (Smart Diffing)
    const diff = formatDiff(oldCat, { ...oldCat, name, category_type: type }, ['name', 'category_type']);
    if (diff) {
      sendLog(interaction.guild, 'shop', 'blue', '📂 Category Updated', `Admin **<@${interaction.user.id}>** updated shop category **${name}**\n${diff}`);
    }


    await interaction.followUp({ content: `✅ Category **${name}** updated!`, flags: MessageFlags.Ephemeral });

    // Reload Category Management View
    const mock = {
      deferred: true, replied: false, deferUpdate: async () => { }, editReply: interaction.editReply.bind(interaction), followUp: interaction.followUp.bind(interaction),
      customId: `shop_cat_manage_${categoryId}`, // Updated to use consistent management ID
      values: [categoryId],
      isAnySelectMenu: () => true,
      guildId: interaction.guildId
    };
    await handleEditCategorySelect(mock);
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop edit category modal submit');
  }
}

export async function handleDeleteCategoryStart(interaction, page = 1) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    const categories = await getShopCategories(interaction.guildId);

    const rowBack = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('shop_admin_delete').setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary)
    );

    if (categories.length === 0) {
      const emptyEmbed = new EmbedBuilder().setColor('#95A5A6').setDescription('No items found.');
      return interaction.editReply({ content: null, embeds: [emptyEmbed], components: [rowBack] });
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
      .setTitle('🗑️ Delete Category')
      .setDescription('**Select a category to delete:**');

    const row = new ActionRowBuilder().addComponents(selectMenu);

    await interaction.editReply({
      content: null,
      embeds: [embed],
      components: [row, rowBack]
    });
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
    const categoryName = category ? category.name : 'Category';

    // Step 1: Detach items (Make them standalone)
    const detachResult = await detachItemsFromCategory(categoryId);

    // Step 2: Delete Category
    await deleteShopCategory(categoryId);

    // Bulk Audit Log
    sendBulkLog(
      interaction.guild, 
      'shop', 
      'red', 
      'Category Deleted', 
      `Admin **${getUserLogName(interaction.member)}** deleted category **'${categoryName}'**.\n• **Status:** Removed successfully.\n• **Items Affected:** **${detachResult.count}** items were made standalone.`
    );

    // Step 3: Fetch remaining categories
    const categories = await getShopCategories(interaction.guildId);

    const rowBack = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('shop_admin_delete').setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary)
    );

    if (categories.length === 0) {
      const emptyEmbed = new EmbedBuilder().setColor('#95A5A6').setDescription('No items found.');
      return interaction.editReply({
        content: `✅ Category **${categoryName}** deleted.`,
        components: [rowBack],
        embeds: [emptyEmbed]
      });
    } else {
      const { selectMenu } = buildPaginatedSelectMenu({
        items: categories,
        page: 1,
        customId: 'shop_select_cat_delete_confirm',
        placeholder: 'Select Category to Delete',
        pageNavPrefix: 'cat_del_nav_',
        pageSize: 20,
        mapOption: c => ({
          label: ((c.name && c.name.trim().length > 0) ? c.name : `Unnamed Category #${c.id}`).slice(0, 100),
          value: c.id.toString(),
          emoji: '📂'
        })
      });

      const row = new ActionRowBuilder().addComponents(selectMenu);

      await interaction.editReply({
        content: `✅ Category **${categoryName}** deleted. Select another to delete:`,
        components: [row, rowBack],
        embeds: []
      });
    }
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
    
    // Smart hierarchical Back button routing:
    let backRoute;
    if (folder === 'root') {
      backRoute = isLootBox ? 'shop_lb_home' : (isEdit ? 'shop_admin_edit' : 'shop_admin_delete');
    } else if (folder === 'browse_categories' || folder === 'cat_null') {
      backRoute = 'shop_admin_browser_back_root';
    } else {
      // inside a specific category (e.g. cat_5)
      backRoute = 'shop_admin_browser_back_cat';
    }
    
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

      return interaction.editReply({
        content: (message && (message.startsWith('✅') || message.startsWith('❌'))) ? message : null,
        components: [new ActionRowBuilder().addComponents(selectMenu), rowBack],
        embeds: [embed]
      });
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

        return interaction.editReply({
          content: (message && (message.startsWith('✅') || message.startsWith('❌'))) ? message : null,
          components: [new ActionRowBuilder().addComponents(select), rowBack],
          embeds: [embed]
        });
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
          pageNavPrefix: 'admin_browser_page_',
          pageSize: 20,
          mapOption: cat => ({
            label: (cat.name || `Category #${cat.id}`).slice(0, 100),
            value: `cat_${cat.id}`,
            emoji: '📂'
          })
        });

        return interaction.editReply({
          content: (message && (message.startsWith('✅') || message.startsWith('❌'))) ? message : null,
          components: [new ActionRowBuilder().addComponents(selectMenu), rowBack],
          embeds: [embed]
        });
      }

      // 3. ITEM VIEW - List items inside a specific Category or Uncategorized
      const targetCategoryId = folder === 'cat_null' ? null : parseInt(folder.replace('cat_', ''), 10);
      const folderItems = singleItems.filter(i => i.category_id === targetCategoryId);

      if (folderItems.length === 0) {
         pendingAdminBrowser.set(interaction.user.id, { ...contextMap, folder: 'root', page: 1 });
         return renderAdminBrowser(interaction, pendingAdminBrowser.get(interaction.user.id));
      }

      const page = contextMap.page || 1;

      const { selectMenu } = buildPaginatedSelectMenu({
        items: folderItems,
        page,
        customId: 'shop_admin_browser_select',
        placeholder: 'Select',
        pageNavPrefix: 'admin_browser_page_',
        pageSize: 20,
        mapOption: i => ({
          label: (i.name && i.name.trim().length > 0 ? i.name : `Unnamed Item #${i.id}`).slice(0, 100),
          value: `item_${i.id}`,
          emoji: '🏷️'
        })
      });

      return interaction.editReply({
         content: (message && (message.startsWith('✅') || message.startsWith('❌'))) ? message : null,
         components: [new ActionRowBuilder().addComponents(selectMenu), rowBack],
         embeds: [embed]
      });
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

        return interaction.editReply({
          content: (message && (message.startsWith('✅') || message.startsWith('❌'))) ? message : null,
          components: [new ActionRowBuilder().addComponents(selectMenu), rowBack],
          embeds: [embed]
        });
    }
  } catch (error) {
     await handleInteractionError(interaction, error, 'admin browser render');
  }
}

export async function handleAdminBrowserBackRoot(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    let context = pendingAdminBrowser.get(interaction.user.id) || { action: 'edit_item', folder: 'root', page: 1, message: null };
    context.folder = 'root';
    context.page = 1;
    context.message = null;
    pendingAdminBrowser.set(interaction.user.id, context);
    return renderAdminBrowser(interaction, context);
  } catch (error) {
    await handleInteractionError(interaction, error, 'admin browser back root');
  }
}

export async function handleAdminBrowserBackCat(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    let context = pendingAdminBrowser.get(interaction.user.id) || { action: 'edit_item', folder: 'browse_categories', page: 1, message: null };
    context.folder = 'browse_categories';
    context.page = 1;
    context.message = null;
    pendingAdminBrowser.set(interaction.user.id, context);
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
    let context = pendingAdminBrowser.get(interaction.user.id);

    if (!context) {
      context = { action: 'edit_item', folder: 'root', page: 1, message: null };
      pendingAdminBrowser.set(interaction.user.id, context);
    }

    // Handle pagination page change
    if (selection.startsWith('admin_browser_page_')) {
      context.page = parseInt(selection.replace('admin_browser_page_', ''), 10) || 1;
      pendingAdminBrowser.set(interaction.user.id, context);
      return renderAdminBrowser(interaction, context);
    }

    // Handle navigating back up to the root layer
    if (selection === 'action_back_root') {
      context.folder = 'root';
      context.page = 1;
      context.message = null;
      pendingAdminBrowser.set(interaction.user.id, context);
      return renderAdminBrowser(interaction, context);
    }

    // Handle navigating to the categories list
    if (selection === 'action_browse_categorized') {
      context.folder = 'browse_categories';
      context.page = 1;
      context.message = null;
      pendingAdminBrowser.set(interaction.user.id, context);
      return renderAdminBrowser(interaction, context);
    }

    // Handle drilling into a specific Category folder
    if (selection.startsWith('cat_')) {
      context.folder = selection;
      context.page = 1;
      context.message = null;
      pendingAdminBrowser.set(interaction.user.id, context);
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
      pendingAdminBrowser.set(interaction.user.id, context);
      return renderAdminBrowser(interaction, context);
    }

    // Fresh entry — always start from root
    const context = { action: 'edit_item', folder: 'root', message: null };
    pendingAdminBrowser.set(interaction.user.id, context);
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
      .setTitle('⚠️ Confirm Revoke')
      .setDescription(
        `You are about to revoke all owned copies of **${item.name}**.\n\n` +
        `**This will:**\n` +
        `• Remove it from every user's inventory\n` +
        `• Strip the item's role from all members who currently have it\n` +
        `• Keep the item in the shop database for future purchases or assignments\n\n` +
        `After confirmation, **0 users** will own or hold this item. This action cannot be undone.`
      )
      .setColor('#E74C3C');

    const confirmBtn = new ButtonBuilder()
      .setCustomId(`shop_item_revoke_confirm_${itemId}`)
      .setLabel('Confirm Revoke')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Danger);

    const cancelBtn = new ButtonBuilder()
      .setCustomId(`shop_item_edit_select_${itemId}`)
      .setLabel('Back')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder().addComponents(cancelBtn, confirmBtn);
    await interaction.editReply({ content: null, embeds: [embed], components: [row] });
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
      .setCustomId(`shop_item_edit_select_${itemId}`)
      .setLabel('Back')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder().addComponents(backBtn);
    await interaction.editReply({ content: null, embeds: [successEmbed], components: [row] });
  } catch (error) {
    await handleInteractionError(interaction, error, 'revoke item confirm');
  }
}

export async function handleEditItemSelect(interaction, successHeader = null) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => { });
  
  let itemId;
  if (interaction.isAnySelectMenu()) {
    itemId = interaction.values[0];
  } else {
    const cid = interaction.customId;
    // Strip known prefixes so the remaining value is always the full itemId (UUID-safe)
    const prefixes = [
      'shop_item_view_details_',
      'shop_item_view_users_',
      'shop_item_page_prev_',
      'shop_item_page_next_',
      'shop_item_edit_select_',
    ];
    const matched = prefixes.find(p => cid.startsWith(p));
    if (matched) {
      // For pagination buttons the format is: prefix{itemId}_p{page} — strip the page suffix
      const raw = cid.slice(matched.length);
      itemId = raw.includes('_p') ? raw.slice(0, raw.lastIndexOf('_p')) : raw;
    } else {
      itemId = cid.split('_').pop();
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

    const packCount = await getItemUsageCount(item.id, interaction.guildId);
    const roleMention = item.role_id ? `<@&${item.role_id}>` : 'None';

    let prereqDisplay = '``None``';
    let reqItems = item.required_items;
    if (typeof reqItems === 'string') {
      try { reqItems = JSON.parse(reqItems); } catch (e) { reqItems = []; }
    }
    if (reqItems && Array.isArray(reqItems) && reqItems.length > 0) {
      const allItems = await getShopItems(interaction.guildId, null, 'name', true);
      const reqDisplays = reqItems
        .map(id => {
            if (typeof id === 'string' && id.startsWith('booster:')) return '🚀 **Server Booster**';
            if (typeof id === 'string' && id.startsWith('mvp:')) return '🏆 **Active Server MVP**';
            const match = allItems.find(i => i.id === id);
            if (!match || !match.role_id) return null;
            return `<@&${match.role_id}>`;
        })
        .filter(Boolean);
      prereqDisplay = reqDisplays.length > 0 ? reqDisplays.join(', ') : '``None``';
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

    const customId = interaction.customId || '';
    let view = 'details';
    let page = 1;

    if (customId.startsWith('shop_item_view_users_') || customId.startsWith('shop_item_page_')) {
      view = 'users';
      const pageMatch = customId.match(/_p(\d+)$/);
      if (pageMatch) page = parseInt(pageMatch[1], 10);
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

    // Owned = unique users with this item in their inventory (DB is source of truth)
    const ownedCount = dbUserMap.size;

    const roleIds = item.role_id ? item.role_id.split(/[,\s]+/).filter(Boolean) : [];
    const roleMembersSet = new Set();
    let equippedCount = 0;

    if (roleIds.length > 0) {
      // Full guild member fetch populates cache via WebSocket gateway chunks (not per-user HTTP).
      // For a 1500-member server this is ~2 gateway events — fast and accurate.
      try {
        await interaction.guild.members.fetch();
      } catch (err) { /* proceed with whatever is cached */ }

      // After cache is populated, role.members is accurate
      for (const rid of roleIds) {
        const role = interaction.guild.roles.cache.get(rid);
        if (role) {
          for (const uid of role.members.keys()) roleMembersSet.add(uid);
        }
      }
      equippedCount = roleMembersSet.size;
    } else {
      // No role linked — use DB is_active as equipped proxy
      equippedCount = Array.from(dbUserMap.values()).filter(v => v.isActive === 1).length;
    }

    // User list: DB owners, equipped (role holders) sorted first
    const memberRows = Array.from(dbUserMap.entries()).map(([uid, info]) => ({
      user_id: uid,
      qty: info.qty,
      isEquipped: roleIds.length > 0 ? roleMembersSet.has(uid) : (info.isActive === 1)
    }));
    memberRows.sort((a, b) => (b.isEquipped ? 1 : 0) - (a.isEquipped ? 1 : 0));

    const totalPages = Math.max(1, Math.ceil(memberRows.length / PAGE_SIZE));
    if (page > totalPages) page = totalPages;

    let embed;
    if (view === 'details') {
      embed = new EmbedBuilder()
        .setTitle(`⚙️ Edit Item: ${item.name}`)
        .setDescription(
          `Role: ${roleMention}\nDuration: \`\`${durationDisplay}\`\`\nIn Packs: \`\`${packCount}\`\`\nRequirements: ${prereqDisplay}`
        )
        .setColor('#3498DB');
    } else {
      const pageSlice = memberRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
      const userLines = pageSlice.length > 0
        ? pageSlice.map(r => `- ${r.isEquipped ? '✅' : '⬜'} <@${r.user_id}> (x${r.qty})`).join('\n')
        : '*No users on this page.*';

      embed = new EmbedBuilder()
        .setTitle(`👥 Users: ${item.name}`)
        .setDescription(`Owned: \`\`${ownedCount}\`\`  •  Equipped: \`\`${equippedCount}\`\`\n\n${userLines}`)
        .setFooter({ text: `Page ${page} / ${totalPages}` })
        .setColor('#3498DB');
    }

    const itemImg = getItemImage(item);
    const itemImgResolved = itemImg ? await resolveImageAttachment(itemImg, 'item_thumb.png') : null;
    if (itemImgResolved) embed.setThumbnail(itemImgResolved.uri);
    else if (itemImg) embed.setThumbnail(itemImg);

    const catOptions = [
      { label: 'No Category', value: 'null', emoji: '🏷️', default: !item.category_id },
      ...categories.map(c => ({
        label: ((c.name && c.name.trim().length > 0) ? c.name : `Unnamed Category #${c.id}`).slice(0, 100),
        value: c.id.toString(),
        emoji: '📂',
        default: c.id == item.category_id
      }))
    ];
    const catSelect = new StringSelectMenuBuilder()
      .setCustomId(`shop_assign_cat_select_manage_${itemId}`)
      .setPlaceholder('Select')
      .addOptions(catOptions);
    const rowCat = new ActionRowBuilder().addComponents(catSelect);

    // Rarity select (auto-saves on change)
    const itemRarity = item.rarity || 'common';
    const rowRarity = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`shop_edit_rarity_select_${itemId}`)
        .setPlaceholder('Rarity')
        .addOptions(RARITY_OPTIONS.map(o => ({ ...o, default: o.value === itemRarity })))
    );

    // Tradability select (auto-saves on change)
    const itemTradable = item.is_tradable !== false; // default true for existing items
    const lootBoxCatName = await getLootBoxCategoryName(interaction.guildId);
    const tradableOpts = getTradableOptions(lootBoxCatName);
    const rowTradable = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`shop_edit_tradable_select_${itemId}`)
        .setPlaceholder('Status')
        .addOptions(tradableOpts.map(o => ({ ...o, default: (o.value === 'tradable') === itemTradable })))
    );

    const isOnUsers = view === 'users';
    const hasPagination = memberRows.length > PAGE_SIZE;

    let prevBtn, nextBtn;

    if (view === 'details') {
      // On Details view: ◀️ and ▶️ navigate between sibling items in the same category or uncategorized folder.
      let prevSibling = null;
      let nextSibling = null;

      const siblingItems = await getShopItems(
        interaction.guildId, 
        item.category_id ? item.category_id : 'null', 
        'name', 
        true
      );
      const siblingShopItems = siblingItems.filter(i => !i.is_pack && i.item_type !== 'pack' && i.item_type !== 'loot_box');
      if (siblingShopItems.length > 1) {
        const currIndex = siblingShopItems.findIndex(i => String(i.id) === String(item.id));
        prevSibling = currIndex > 0 ? siblingShopItems[currIndex - 1] : null;
        nextSibling = (currIndex >= 0 && currIndex < siblingShopItems.length - 1) ? siblingShopItems[currIndex + 1] : null;
      }

      prevBtn = new ButtonBuilder()
        .setCustomId(prevSibling ? `shop_item_view_details_${prevSibling.id}` : `shop_item_nav_noop_prev`)
        .setEmoji('◀️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!prevSibling);

      nextBtn = new ButtonBuilder()
        .setCustomId(nextSibling ? `shop_item_view_details_${nextSibling.id}` : `shop_item_nav_noop_next`)
        .setEmoji('▶️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!nextSibling);
    } else {
      // On Users view: ⬅️ and ➡️ navigate between pages of users
      prevBtn = new ButtonBuilder()
        .setCustomId(`shop_item_page_prev_${itemId}_p${Math.max(1, page - 1)}`)
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 1);

      nextBtn = new ButtonBuilder()
        .setCustomId(`shop_item_page_next_${itemId}_p${Math.min(totalPages, page + 1)}`)
        .setEmoji('➡️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= totalPages || !hasPagination);
    }

    const detailsBtn = new ButtonBuilder()
      .setCustomId(`shop_item_view_details_${itemId}`)
      .setLabel('Details')
      .setStyle(view === 'details' ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(view === 'details');

    const usersBtn = new ButtonBuilder()
      .setCustomId(`shop_item_view_users_${itemId}_p${page}`)
      .setLabel('Users')
      .setStyle(view === 'users' ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(view === 'users');

    const revokeBtn = new ButtonBuilder()
      .setCustomId(`shop_item_revoke_${itemId}`)
      .setLabel('Revoke')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Danger);

    const rowNav = new ActionRowBuilder().addComponents(prevBtn, usersBtn, revokeBtn, nextBtn);

    const backFolderId = item.category_id ? `cat_${item.category_id}` : 'cat_null';
    const backBtn = new ButtonBuilder()
      .setCustomId(`shop_edit_item_back_${backFolderId}`)
      .setLabel('Back')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary);

    const editDetailsBtn = new ButtonBuilder()
      .setCustomId(`shop_item_edit_details_${itemId}`)
      .setLabel('Edit')
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Secondary);

    const rowActions = new ActionRowBuilder().addComponents(backBtn, detailsBtn, editDetailsBtn);

    // Only show the 3 attribute dropdowns on the Details view — hide them on the Users page
    const components = view === 'details'
      ? [rowCat, rowRarity, rowTradable, rowNav, rowActions]
      : [rowNav, rowActions];

    await interaction.editReply({
      content: successHeader || null,
      embeds: [embed],
      files: itemImgResolved ? [itemImgResolved.attachment] : [],
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
    customId: `shop_item_edit_select_${itemId}`,
    values: [String(itemId)],
    isAnySelectMenu: () => true,
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
    customId: `shop_item_edit_select_${itemId}`,
    values: [String(itemId)],
    isAnySelectMenu: () => true,
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

    const nameInput = new TextInputBuilder().setCustomId('item_name').setLabel('Name').setStyle(TextInputStyle.Short).setValue(item.name).setRequired(true);
    const imageInput = new TextInputBuilder()
      .setCustomId('item_image_url')
      .setLabel('Image URL')
      .setStyle(TextInputStyle.Short)
      .setValue(item.default_image_url || '')
      .setPlaceholder('https://example.com/image.png')
      .setRequired(false);
    const roleInput = new TextInputBuilder().setCustomId('item_role').setLabel('Role ID').setStyle(TextInputStyle.Short).setValue(item.role_id || '').setRequired(true);
    const durInput = new TextInputBuilder().setCustomId('item_duration').setLabel('Duration (Days)').setStyle(TextInputStyle.Short).setValue(item.duration_seconds ? String(Math.floor(item.duration_seconds / 86400)) : '').setPlaceholder('Leave empty for permanent').setRequired(false);

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
      .setLabel('Requirements (Role IDs)')
      .setStyle(TextInputStyle.Short)
      .setValue(reqPreFill)
      .setRequired(false)
      .setPlaceholder('Separate IDs by "-", "," or space');

    modal.addComponents(
      new ActionRowBuilder().addComponents(nameInput),
      new ActionRowBuilder().addComponents(roleInput),
      new ActionRowBuilder().addComponents(imageInput),
      new ActionRowBuilder().addComponents(durInput),
      new ActionRowBuilder().addComponents(reqInput)
    );

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
    pendingAdminBrowser.set(interaction.user.id, context);
    await renderAdminBrowser(interaction, context);
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop edit pack start');
  }
}

export async function handleEditLootBoxStart(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
    const context = { action: 'edit_lootbox', folder: 'root', message: null };
    pendingAdminBrowser.set(interaction.user.id, context);
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
      .setTitle(`📦 Edit Pack: ${item.name}`)
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

    await interaction.editReply({ 
      content: successHeader || null, 
      embeds: [embed], 
      components: [actionRow, backRow] 
    });
  } catch (error) {
    await handleInteractionError(interaction, error, 'edit pack select');
  }
}

export async function handlePackAddContentStart(interaction, layer = 'root', messageStr = null) {
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

      return interaction.editReply({ 
        content: (messageStr && (messageStr.startsWith('✅') || messageStr.startsWith('❌'))) ? messageStr : null,
        components: [emptyRow], 
        embeds: [emptyEmbed] 
      });
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
      
      const { selectMenu } = buildPaginatedSelectMenu({
        items: standaloneItems,
        page: pageNum,
        customId: `shop_pack_add_content_select_${packId}`,
        placeholder: 'Select',
        pageNavPrefix: `pack_add_item_nav_${packId}_uncat_`,
        pageSize: 20,
        mapOption: i => ({
          label: ((i.name && i.name.trim().length > 0) ? i.name : `Unnamed Item #${i.id}`).slice(0, 100), 
          value: `item_${i.id}`,
          emoji: '🏷️'
        })
      });
      selectMenuToRender = selectMenu;
    }
    else if (typeof layer === 'number' || !isNaN(parseInt(layer))) {
      // --- LAYER 2: ITEMS INSIDE A CATEGORY ---
      const categoryId = parseInt(layer);
      const itemsInCat = availableItems.filter(i => i.category_id === categoryId);
      
      const { selectMenu } = buildPaginatedSelectMenu({
        items: itemsInCat,
        page: pageNum,
        customId: `shop_pack_add_content_select_${packId}`,
        placeholder: 'Select',
        pageNavPrefix: `pack_add_item_nav_${packId}_${categoryId}_`,
        pageSize: 20,
        mapOption: i => ({ 
          label: ((i.name && i.name.trim().length > 0) ? i.name : `Unnamed Item #${i.id}`).slice(0, 100), 
          value: `item_${i.id}`,
          emoji: '🏷️'
        })
      });
      selectMenuToRender = selectMenu;
    }

    let packBackCustomId;
    if (layer === 'root') {
      packBackCustomId = `shop_pack_manage_${packId}`;
    } else if (layer === 'browse_categorized' || layer === 'browse_uncategorized') {
      packBackCustomId = `shop_pack_add_back_root_${packId}`;
    } else {
      packBackCustomId = `shop_pack_add_back_cat_${packId}`;
    }

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

    await interaction.editReply({
        content: (messageStr && (messageStr.startsWith('✅') || messageStr.startsWith('❌'))) ? messageStr : null,
        components: [row, rowBack],
        embeds: [embedPrompt]
    });
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
    await updateShopItem(packId, { contents: newContents, role_id: newRoleId });

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

      return interaction.editReply({ 
        content: (messageStr && (messageStr.startsWith('✅') || messageStr.startsWith('❌'))) ? messageStr : null,
        components: [emptyRow], 
        embeds: [emptyEmbed] 
      });
    }

    // Fetch names of items in pack
    const allItems = await getShopItems(interaction.guildId, null, 'name', true);
    const contentIds = currentContentIds.map(id => parseInt(id));
    const packItems = allItems.filter(i => contentIds.includes(i.id));

    const pageNum = typeof page === 'number' ? page : (parseInt(page, 10) || 1);
    const { selectMenu } = buildPaginatedSelectMenu({
      items: packItems,
      page: pageNum,
      customId: `shop_pack_remove_content_select_${packId}`,
      placeholder: 'Select',
      pageNavPrefix: `pack_rem_nav_${packId}_`,
      pageSize: 20,
      mapOption: i => ({
        label: ((i.name && i.name.trim().length > 0) ? i.name : `Unnamed Item #${i.id}`).slice(0, 100), 
        value: `item_${i.id}`,
        emoji: '🏷️'
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

    await interaction.editReply({
        content: (messageStr && (messageStr.startsWith('✅') || messageStr.startsWith('❌'))) ? messageStr : null,
        components: [row, rowBack],
        embeds: [embedPrompt]
    });
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
    await updateShopItem(packId, { contents: newContents, role_id: newRoleId });

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
    if (!interaction.deferred && !interaction.replied) {
      if (interaction.isMessageComponent && interaction.isMessageComponent()) {
        await interaction.deferUpdate();
      } else {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      }
    }

    const embed = new EmbedBuilder()
      .setColor('#9B59B6')
      .setTitle('📢 Shop Posting Options')
      .setDescription('Choose to publish a new shop item or edit an existing post.');

    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('shop_admin_home')
          .setLabel('Back')
          .setEmoji('⬅️')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('shop_post_new_layout')
          .setLabel('New Post')
          .setEmoji('➕')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('shop_post_edit_layout')
          .setLabel('Edit Post')
          .setEmoji('📝')
          .setStyle(ButtonStyle.Primary)
      );

    await interaction.editReply({ content: null, embeds: [embed], components: [row] });
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop post gate');
  }
}

export async function handleShopPostNewLayout(interaction) {
  try {
    const userId = interaction.user.id;
    
    // Initialize/Reset session state for New Post
    pendingPosts.set(userId, {
      itemId: null,
      channelId: null,
      sellerId: null,
      payout: null,
      stock: null,
      description: null,
      imageUrl: null,
      overridePrice: null,
      postStep: 0,
      postFilter: null,
      isEditing: false,
      stockConfigured: false,
      fromGateway: true
    });

    await handleShopPostStart(interaction);
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop post new layout');
  }
}

export async function handleShopPostEditLayout(interaction) {
  try {
    const modal = new ModalBuilder()
      .setCustomId('shop_edit_post_url_modal')
      .setTitle('Edit Shop Post');

    const urlInput = new TextInputBuilder()
      .setCustomId('message_url')
      .setLabel('Discord Message URL')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('https://discord.com/channels/...')
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(urlInput));
    await interaction.showModal(modal);
  } catch (error) {
    await handleInteractionError(interaction, error, 'show edit post modal');
  }
}

export async function handleShopEditPostUrlSubmit(interaction) {
  try {
    // Defer update to target the original choice panel message
    await interaction.deferUpdate();

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
      return interaction.followUp({ content: '❌ Invalid Message URL', flags: MessageFlags.Ephemeral });
    }

    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (!message) {
      return interaction.followUp({ content: '❌ Invalid Message URL', flags: MessageFlags.Ephemeral });
    }

    // Author verification
    if (message.author.id !== interaction.client.user.id) {
      return interaction.followUp({ content: '❌ Invalid Message URL', flags: MessageFlags.Ephemeral });
    }

    // Signature verification (Find Buy Button)
    let buyButton = null;
    for (const row of message.components) {
      for (const component of row.components) {
        if (component.type === 2 && component.customId && component.customId.startsWith('bank_shop_buy_')) {
          buyButton = component;
          break;
        }
      }
      if (buyButton) break;
    }

    if (!buyButton) {
      return interaction.followUp({ content: '❌ Invalid Message URL', flags: MessageFlags.Ephemeral });
    }

    // Parse customId parts: bank_shop_buy_[itemId]_[sellerId]_[payout]_[overridePrice]
    const parts = buyButton.customId.split('_');
    const itemId = parseInt(parts[3], 10);
    const sellerId = parts[4] === '0' ? null : parts[4];
    const payout = parts[5] === '0' ? null : parseInt(parts[5], 10);
    const overridePrice = (parts[6] !== undefined && parts[6] !== '') ? parseInt(parts[6], 10) : null;

    // Verify item exists in DB
    const item = await getShopItem(itemId, guildId);
    if (!item) {
      return interaction.followUp({ content: '❌ Invalid Message URL', flags: MessageFlags.Ephemeral });
    }

    // Extract embed contents
    const firstEmbed = message.embeds[0];
    let embedDescription = firstEmbed?.description || null;
    const embedImageUrl = firstEmbed?.image?.url || null;

    // The message embed is the source of truth for description — always use what's visible on the post
    // No database comparison needed; the user wants to edit what they see
    const defaultImage = getItemImage(item);
    const imageUrl = embedImageUrl === defaultImage ? null : embedImageUrl;

    // Clean the embed description: strip carriage returns and trim
    const description = embedDescription
      ? embedDescription.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim() || null
      : null;

    // Scrape stock from embed field if present, falling back to DB stock
    let scrapedStock = item.stock;
    if (firstEmbed && firstEmbed.fields) {
      const stockField = firstEmbed.fields.find(f => f.name && f.name.includes('Stock'));
      if (stockField) {
        const val = stockField.value;
        if (val.includes('Unlimited')) {
          scrapedStock = null;
        } else if (val.includes('Sold Out')) {
          scrapedStock = 0;
        } else {
          const matchNum = val.match(/\*\*(\d+)\*\*/);
          if (matchNum) {
            scrapedStock = parseInt(matchNum[1], 10);
          }
        }
      }
    }

    // Initialize state
    const userId = interaction.user.id;
    pendingPosts.set(userId, {
      itemId,
      channelId,
      sellerId,
      payout,
      description,
      imageUrl,
      overridePrice: overridePrice !== null ? overridePrice : item.price,
      stock: scrapedStock,
      stockConfigured: true,
      isEditing: true,
      fromGateway: true,
      messageId,
      messageUrl: url,
      postStep: 0,
      postFilter: null
    });

    const mock = {
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
    const userId = interaction.user.id;
    const state = pendingPosts.get(userId);

    if (!state || !state.itemId || !state.channelId || !state.messageId || !state.isEditing) {
      return handleInteractionError(interaction, new Error('Validation Failed: Missing required parameters for updating'), 'shop post update');
    }

    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

    const { itemId, channelId, messageId, sellerId, imageUrl, description, payout, stock, overridePrice } = state;
    const item = await getShopItem(itemId, interaction.guildId);
    if (!item) {
      return interaction.followUp({ content: '❌ Item not found in database.', flags: MessageFlags.Ephemeral });
    }

    const effectivePrice = overridePrice !== null && overridePrice !== undefined ? Number(overridePrice) : null;
    if (effectivePrice === null) {
      return interaction.followUp({ content: '❌ You must set a price before updating.', flags: MessageFlags.Ephemeral });
    }

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

    // JIT DB Update
    await updateShopItem(itemId, { price: effectivePrice, stock });
    item.price = effectivePrice;
    item.stock = stock;

    // Build the updated embed
    const embed = new EmbedBuilder()
      .setTitle(item.name)
      .setColor('#3498DB');

    const finalImage = imageUrl || getItemImage(item);
    const finalImageResolved = finalImage ? await resolveImageAttachment(finalImage, 'shop_item.png') : null;
    if (finalImageResolved) {
      embed.setImage(finalImageResolved.uri);
    } else if (finalImage) {
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

    let stockHeader = '♾️ Stock';
    let stockValue = 'Unlimited';
    if (item.stock === null || item.stock === undefined) {
      stockHeader = '♾️ Stock';
      stockValue = 'Unlimited';
    } else if (item.stock <= 0) {
      stockHeader = '🔴 Stock';
      stockValue = 'Sold Out';
      embed.setColor('#808080'); // Gray out sold out items
    } else {
      stockHeader = '🟢 Stock';
      stockValue = `**${item.stock}** Left`;
    }
    embed.addFields({ name: stockHeader, value: stockValue, inline: true });

    // Build Buy button
    const sellerPart = sellerId || '0';
    const payoutPart = payout || '0';
    const overridePart = overridePrice !== null ? overridePrice : '';
    const isSoldOut = item.stock !== null && item.stock <= 0;

    const buyButton = new ButtonBuilder()
      .setCustomId(`bank_shop_buy_${itemId}_${sellerPart}_${payoutPart}_${overridePart}`)
      .setLabel(isFree ? 'BUY (FREE)' : `BUY (${effectivePrice.toLocaleString()})`)
      .setEmoji(`${COIN_EMOJI}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(isSoldOut);

    const row = new ActionRowBuilder().addComponents(buyButton);

    // Edit message live
    await message.edit({ embeds: [embed], files: finalImageResolved ? [finalImageResolved.attachment] : [], components: [row] });

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

    pendingPosts.delete(userId);

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
    .setLabel('Name')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Golden Chest')
    .setRequired(true)
    .setMaxLength(100);

  const imgClosedInput = new TextInputBuilder()
    .setCustomId('image_closed')
    .setLabel('Image (Closed)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('https://example.com/chest_closed.png')
    .setRequired(false);

  const imgOpenedInput = new TextInputBuilder()
    .setCustomId('image_opened')
    .setLabel('Image (Opened)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('https://example.com/chest_opened.png')
    .setRequired(false);

  modal.addComponents(
    new ActionRowBuilder().addComponents(nameInput),
    new ActionRowBuilder().addComponents(imgClosedInput),
    new ActionRowBuilder().addComponents(imgOpenedInput)
  );

  await interaction.showModal(modal);
}

/**
 * Handle Loot Box Creation Modal Submit
 */
export async function handleLootBoxCreateModalSubmit(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  try {
    const name = (interaction.fields.getTextInputValue('name') || '').trim();
    const rawClosed = (interaction.fields.getTextInputValue('image_closed') || '').trim();
    const rawOpened = (interaction.fields.getTextInputValue('image_opened') || '').trim();

    if (!name || name.length === 0) {
      return interaction.followUp({
        content: '❌ **Invalid Box Name**: Box name cannot be empty.',
        flags: MessageFlags.Ephemeral
      });
    }

    let imageUrl = null;
    let openedImageUrl = null;

    if (rawClosed && rawClosed.toLowerCase() !== 'none') {
      if (!/^https?:\/\/.+\..+/i.test(rawClosed)) {
        return interaction.followUp({
          content: '❌ **Invalid Closed Image URL**: Please provide a valid HTTP/HTTPS link or leave it empty.',
          flags: MessageFlags.Ephemeral
        });
      }
      imageUrl = rawClosed;
    }

    if (rawOpened && rawOpened.toLowerCase() !== 'none') {
      if (!/^https?:\/\/.+\..+/i.test(rawOpened)) {
        return interaction.followUp({
          content: '❌ **Invalid Opened Image URL**: Please provide a valid HTTP/HTTPS link or leave it empty.',
          flags: MessageFlags.Ephemeral
        });
      }
      openedImageUrl = rawOpened;
    }

    // Mutual fallback: If only one is entered, use for both
    if (imageUrl && !openedImageUrl) openedImageUrl = imageUrl;
    if (openedImageUrl && !imageUrl) imageUrl = openedImageUrl;

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
    .setTitle('Configure Category');

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
    .setPlaceholder('e.g. 🎁, 📦, 💎, 🏆')
    .setRequired(false)
    .setMaxLength(32);

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

    let resolvedEmoji = null;

    // 1. Formatted Custom Emoji: <:name:id> or <a:name:id>
    const customMatch = rawEmoji.match(/^<(a)?:([a-zA-Z0-9_]+):(\d{17,20})>$/);
    if (customMatch) {
      const isAnimated = Boolean(customMatch[1]);
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
        }
      }
    } else {
      // 3. Unicode Emoji
      const emojiRegex = /^(\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Emoji}\uFE0F|\u200D|\p{Emoji_Modifier})+$/u;
      if (emojiRegex.test(rawEmoji) && rawEmoji.length <= 16) {
        resolvedEmoji = rawEmoji;
      }
    }

    if (!resolvedEmoji) {
      return interaction.followUp({
        content: `❌ **Invalid Emoji**: Could not validate \`${rawEmoji}\`. Please enter a standard emoji (e.g. 🎁, 📦, 💎) or a valid custom emoji / emoji ID available to this bot.`,
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

/**
 * Unified Loot Box Configuration Panel (Dropdown Config, Feature Toggles, Customize, Delete)
 */
export async function showLootBoxEditorPanel(interaction, boxId) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  try {
    const box = await getLootBox(boxId, interaction.guildId);
    if (!box) {
      return interaction.editReply({ content: '❌ Loot box not found.', embeds: [], components: [] });
    }

    const lootBoxEmoji = await getLootBoxCategoryEmoji(interaction.guildId);
    const lootBoxCatName = await getLootBoxCategoryName(interaction.guildId);
    const config = await getGuildConfig(interaction.guildId);
    const serverCoinEmoji = config?.coin_emoji || DEFAULT_COIN_EMOJI || '🪙';

    const itemsEnabled = box.items_enabled !== false;
    const coinsEnabled = box.coins_enabled !== false;

    // Build description in strict order: 1. Rarity, 2. Prizes, 3. Coins (each with dedicated emojis)
    const sections = [];

    // 1. Rarity (First)
    if (itemsEnabled) {
      const rarityLines = [
        `⚪ **Common**: \`${box.chance_common}%\``,
        `🟢 **Uncommon**: \`${box.chance_uncommon}%\``,
        `🔵 **Rare**: \`${box.chance_rare}%\``,
        `🟣 **Epic**: \`${box.chance_epic}%\``,
        `🟡 **Legendary**: \`${box.chance_legendary}%\``
      ].join('\n');
      sections.push(rarityLines);
    }

    // 2. Prizes (Second)
    if (itemsEnabled) {
      sections.push(`💎 **Prizes**: \`${box.min_prizes}—${box.max_prizes}\``);
    }

    // 3. Coins (Third)
    if (coinsEnabled) {
      sections.push(`${serverCoinEmoji} **Coins**: \`${box.min_coins.toLocaleString()}—${box.max_coins.toLocaleString()}\` \`(${box.chance_coins}%)\``);
    }

    const description = sections.length > 0 ? `\u200b\n${sections.join('\n\n')}` : '';

    const embed = new EmbedBuilder()
      .setColor('#9B59B6')
      .setTitle(box.name)
      .setDescription(description);

    let boxImgResolved = null;
    if (box.image_url && box.image_url.trim().startsWith('http')) {
      boxImgResolved = await resolveImageAttachment(box.image_url.trim(), 'chest_thumb.png');
      if (boxImgResolved) {
        embed.setThumbnail(boxImgResolved.uri);
      } else {
        embed.setThumbnail(box.image_url.trim());
      }
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
        label: 'Coins',
        value: 'cfg_coins',
        emoji: getSelectEmoji(serverCoinEmoji),
        description: 'Configure coins drop chance & range'
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
      new ButtonBuilder()
        .setCustomId(`shop_lb_toggle_coins_${boxId}`)
        .setLabel('Coins')
        .setEmoji(serverCoinEmoji)
        .setStyle(coinsEnabled ? ButtonStyle.Success : ButtonStyle.Secondary)
    );
    components.push(toggleRow);

    // --- Row 3: Action Buttons (Back, Customize, Delete) ---
    const actionRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('shop_lb_home')
        .setLabel('Back')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`shop_lb_rename_box_btn_${boxId}`)
        .setLabel('Customize')
        .setEmoji('✏️')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`shop_lb_delete_start_${boxId}`)
        .setLabel('Delete')
        .setEmoji('🗑️')
        .setStyle(ButtonStyle.Danger)
    );
    components.push(actionRow);

    await interaction.editReply({
      content: null,
      embeds: [embed],
      files: boxImgResolved ? [boxImgResolved.attachment] : [],
      components
    });
  } catch (error) {
    await handleInteractionError(interaction, error, 'loot box editor panel');
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
    const featureLabel = isCoins ? 'Coins Reward' : 'Item Prizes & Rarity';
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
      `• ⚪ Common: **${chanceCommon}%**\n` +
      `• 🟢 Uncommon: **${chanceUncommon}%**\n` +
      `• 🔵 Rare: **${chanceRare}%**\n` +
      `• 🟣 Epic: **${chanceEpic}%**\n` +
      `• 🟡 Legendary: **${chanceLegendary}%**`
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

  const modal = new ModalBuilder()
    .setCustomId(`shop_lb_coins_modal_${boxId}`)
    .setTitle('Configure Coins Reward');

  const chanceInput = new TextInputBuilder()
    .setCustomId('chance_coins')
    .setLabel('Coins Drop Weight / Chance (%)')
    .setStyle(TextInputStyle.Short)
    .setValue(box.chance_coins.toString())
    .setPlaceholder('e.g. 25')
    .setRequired(true);

  const minCoinsInput = new TextInputBuilder()
    .setCustomId('min_coins')
    .setLabel('Minimum Coins Won')
    .setStyle(TextInputStyle.Short)
    .setValue(box.min_coins.toString())
    .setPlaceholder('e.g. 100')
    .setRequired(true);

  const maxCoinsInput = new TextInputBuilder()
    .setCustomId('max_coins')
    .setLabel('Maximum Coins Won')
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
    const chanceVal = interaction.fields.getTextInputValue('chance_coins').trim();
    const minCoinsVal = interaction.fields.getTextInputValue('min_coins').trim();
    const maxCoinsVal = interaction.fields.getTextInputValue('max_coins').trim();

    if (!/^\d+(\.\d+)?$/.test(chanceVal) || !/^\d+$/.test(minCoinsVal) || !/^\d+$/.test(maxCoinsVal)) {
      return interaction.followUp({
        content: '❌ **Invalid Input**: Coins chance must be a valid number, and coin amounts must be whole numbers.',
        flags: MessageFlags.Ephemeral
      });
    }

    const chanceCoins = parseFloat(chanceVal);
    const minCoins = parseInt(minCoinsVal, 10);
    const maxCoins = parseInt(maxCoinsVal, 10);

    if (chanceCoins < 0) {
      return interaction.followUp({
        content: '❌ **Invalid Coins Chance**: Chance percentage cannot be negative.',
        flags: MessageFlags.Ephemeral
      });
    }

    if (minCoins < 0) {
      return interaction.followUp({
        content: '❌ **Invalid Coins Amount**: Minimum coins cannot be negative.',
        flags: MessageFlags.Ephemeral
      });
    }

    if (maxCoins < minCoins) {
      return interaction.followUp({
        content: `❌ **Invalid Coins Range**: Minimum coins (\`${minCoins.toLocaleString()}\`) cannot be greater than Maximum coins (\`${maxCoins.toLocaleString()}\`).`,
        flags: MessageFlags.Ephemeral
      });
    }

    if (maxCoins > 1000000000) {
      return interaction.followUp({
        content: '❌ **Maximum Coins Limit**: Maximum coins cannot exceed 1,000,000,000.',
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
      `🪙 ${singularName} Coins Config Updated`,
      `Admin **<@${interaction.user.id}>** updated coin rewards for ${singularName.toLowerCase()} **${box?.name || `#${boxId}`}**:\n` +
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
    .setTitle(`Customize: ${box.name.slice(0, 30)}`);

  const nameInput = new TextInputBuilder()
    .setCustomId('name')
    .setLabel('Name')
    .setStyle(TextInputStyle.Short)
    .setValue(box.name)
    .setPlaceholder('Golden Chest')
    .setRequired(true)
    .setMaxLength(100);

  const imgClosedInput = new TextInputBuilder()
    .setCustomId('image_closed')
    .setLabel('Image (Closed)')
    .setStyle(TextInputStyle.Short)
    .setValue(box.image_url || '')
    .setPlaceholder('https://example.com/chest_closed.png')
    .setRequired(false);

  const imgOpenedInput = new TextInputBuilder()
    .setCustomId('image_opened')
    .setLabel('Image (Opened)')
    .setStyle(TextInputStyle.Short)
    .setValue(box.opened_image_url || '')
    .setPlaceholder('https://example.com/chest_opened.png')
    .setRequired(false);

  modal.addComponents(
    new ActionRowBuilder().addComponents(nameInput),
    new ActionRowBuilder().addComponents(imgClosedInput),
    new ActionRowBuilder().addComponents(imgOpenedInput)
  );

  await interaction.showModal(modal);
}

/**
 * Handle Rename Modal Submit
 */
export async function handleLootBoxRenameSubmit(interaction, boxId) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  try {
    const name = (interaction.fields.getTextInputValue('name') || '').trim();
    const rawClosed = (interaction.fields.getTextInputValue('image_closed') || '').trim();
    const rawOpened = (interaction.fields.getTextInputValue('image_opened') || '').trim();

    if (!name || name.length === 0) {
      return interaction.followUp({
        content: '❌ **Invalid Box Name**: Name cannot be empty.',
        flags: MessageFlags.Ephemeral
      });
    }

    let imageUrl = null;
    let openedImageUrl = null;

    if (rawClosed && rawClosed.toLowerCase() !== 'none') {
      if (!/^https?:\/\/.+\..+/i.test(rawClosed)) {
        return interaction.followUp({
          content: '❌ **Invalid Closed Image URL**: Please provide a valid HTTP/HTTPS link or leave it empty.',
          flags: MessageFlags.Ephemeral
        });
      }
      imageUrl = rawClosed;
    }

    if (rawOpened && rawOpened.toLowerCase() !== 'none') {
      if (!/^https?:\/\/.+\..+/i.test(rawOpened)) {
        return interaction.followUp({
          content: '❌ **Invalid Opened Image URL**: Please provide a valid HTTP/HTTPS link or leave it empty.',
          flags: MessageFlags.Ephemeral
        });
      }
      openedImageUrl = rawOpened;
    }

    // Mutual fallback: If only one is entered, use for both
    if (imageUrl && !openedImageUrl) openedImageUrl = imageUrl;
    if (openedImageUrl && !imageUrl) imageUrl = openedImageUrl;

    const oldBox = await getLootBox(boxId, interaction.guildId);
    if (oldBox) {
      if (oldBox.image_url && oldBox.image_url !== imageUrl) invalidateImageCache(oldBox.image_url);
      if (oldBox.opened_image_url && oldBox.opened_image_url !== openedImageUrl) invalidateImageCache(oldBox.opened_image_url);
    }
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
      return interaction.editReply({ content: '❌ Loot box not found.', embeds: [], components: [] });
    }

    const lootBoxCatName = await getLootBoxCategoryName(interaction.guildId);
    const singularName = (lootBoxCatName.endsWith('s') || lootBoxCatName.endsWith('S')) 
      ? lootBoxCatName.slice(0, -1) 
      : lootBoxCatName;

    const embed = new EmbedBuilder()
      .setColor('#E74C3C')
      .setTitle(`🗑️ Delete ${singularName}: ${box.name}`)
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

    await interaction.editReply({ content: null, embeds: [embed], components: [row] });
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





