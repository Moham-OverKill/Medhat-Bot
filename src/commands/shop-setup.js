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
import { sendLog, formatDiff, sendBulkLog } from '../utils/logger.js';
import { sanitizeError, COIN_EMOJI, isValidEconomyAmount, getUserLogName } from '../shared.js';

import { query } from '../storage/postgres.js';
import {
  addShopCategory,
  addShopItem,
  updateShopItem,
  deleteShopItem,
  getShopCategories,
  getShopItems,
  getShopItem,
  getItemTiers,
  addItemTier,
  deleteShopCategory,
  updateShopCategory,
  detachItemsFromCategory,
  getItemUsageCount,
  validateRoleUniqueness
} from '../economy/shop.js';

// Temporary storage for post item flow (User ID -> { itemId, channelId, sellerId, imageUrl, description, payout })
const pendingPosts = new Map();

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
    await interaction.reply({ content: '❌ Unknown subcommand', flags: MessageFlags.Ephemeral });
  }
}

/**
 * Main shop setup panel handler
 */
export async function handleShopSetup(interaction) {
  try {
    // Permission check
    if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
      const embed = createErrorEmbed(
        'Permission Denied',
        'You need Administrator permission to manage the shop.'
      );
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
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

    // Get Items and Packs counts
    const itemsResult = await query(
      `SELECT 
        COUNT(*) FILTER (WHERE item_type = 'pack') as pack_count,
        COUNT(*) FILTER (WHERE item_type != 'pack' OR item_type IS NULL) as item_count
       FROM shop_items 
       WHERE guild_id = $1 AND is_active = true`,
      [guildId]
    );

    const categoriesCount = parseInt(categoriesResult.rows[0].count);
    const packCount = parseInt(itemsResult.rows[0].pack_count || 0);
    const itemsCount = parseInt(itemsResult.rows[0].item_count || 0);

    const embed = new EmbedBuilder()
      .setColor('#9B59B6')
      .setTitle('🏪 Shop Configuration')
      .setDescription('Manage categories and items in your server shop.')
      .addFields(
        { name: '📂 Categories', value: `${categoriesCount}`, inline: true },
        { name: '📦 Packs', value: `${packCount}`, inline: true },
        { name: '🎭 Items', value: `${itemsCount}`, inline: true }
      );
    // Removed Footer and Timestamp as requested

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
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId('shop_admin_post')
          .setLabel('Post')
          .setEmoji('📢')
          .setStyle(ButtonStyle.Secondary)
      );

    // Back button to return to settings menu
    const backRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('settings_back')
          .setLabel('Back to Settings')
          .setEmoji('⬅️')
          .setStyle(ButtonStyle.Secondary)
      );

    // Always use editReply since we likely deferred
    await interaction.editReply({ content: null, embeds: [embed], components: [row1, backRow] });
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

export async function handleAddTypeSelect(interaction) {
  const type = interaction.customId.split('_').pop(); // item, pack, cat

  if (type === 'cat') {
    await handleCreateCategory(interaction);
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`shop_item_modal_add_new_${type}`)
    .setTitle(type === 'pack' ? 'Create Item Pack' : 'Create Item');

  const nameInput = new TextInputBuilder()
    .setCustomId('item_name')
    .setLabel('Name')
    .setStyle(TextInputStyle.Short)
    .setRequired(false);

  modal.addComponents(new ActionRowBuilder().addComponents(nameInput));

  if (type === 'item') {
    const roleInput = new TextInputBuilder()
      .setCustomId('item_role')
      .setLabel('Role ID')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('123456789012345678')
      .setRequired(true);

    const priceInput = new TextInputBuilder()
      .setCustomId('item_price')
      .setLabel('Price')
      .setStyle(TextInputStyle.Short)
      .setRequired(false);

    const durInput = new TextInputBuilder()
      .setCustomId('item_duration')
      .setLabel('Duration (Days)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('Leave empty for permanent')
      .setRequired(false);

    const reqInput = new TextInputBuilder()
      .setCustomId('item_required')
      .setLabel('Required Items (Role IDs)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('separate IDs by "-" or "," or space')
      .setRequired(false);

    modal.addComponents(
      new ActionRowBuilder().addComponents(roleInput),
      new ActionRowBuilder().addComponents(priceInput),
      new ActionRowBuilder().addComponents(durInput),
      new ActionRowBuilder().addComponents(reqInput)
    );
  } else {
    // Pack
    const priceInput = new TextInputBuilder()
      .setCustomId('item_price')
      .setLabel('Price')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(
      new ActionRowBuilder().addComponents(priceInput)
    );
  }

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
    const priceRaw = interaction.fields.getTextInputValue('item_price').trim();
    const price = priceRaw ? (/^\d+$/.test(priceRaw) ? Math.floor(Math.abs(Number(priceRaw))) : -1) : 0;

    if (price < 0 || !isValidEconomyAmount(price, true)) {
      return interaction.followUp({ content: '❌ Invalid price. Please enter a valid positive whole number.', flags: MessageFlags.Ephemeral });
    }

    if (action === 'add') {
      // ========== ADD FLOW ==========
      if (type === 'item') {
        const roleId = interaction.fields.getTextInputValue('item_role').trim();
        const durationRaw = interaction.fields.getTextInputValue('item_duration');

        if (!/^\d{17,20}$/.test(roleId)) return interaction.followUp({ content: '❌ Invalid Role ID.', flags: MessageFlags.Ephemeral });
        
        // Block Booster Role as main Item Role
        const boosterRoleId = interaction.guild.roles.premiumSubscriberRole?.id;
        if (boosterRoleId && roleId === boosterRoleId) {
          return interaction.followUp({ content: "❌ Server Booster Role can't be a shop item. Enter it in the Required Items field instead to make Boosters only items.", flags: MessageFlags.Ephemeral });
        }

        // Block MVP Role as main Item Role
        const { getGuildConfig } = await import('../storage/config.js');
        const guildConfig = await getGuildConfig(interaction.guildId);
        if (guildConfig && guildConfig.mvpRoleId === roleId) {
          return interaction.followUp({ content: "❌ MVP Role can't be a shop item. Enter it in the Required Items field to make MVP only items.", flags: MessageFlags.Ephemeral });
        }

        if (!interaction.guild.roles.cache.has(roleId)) return interaction.followUp({ content: '❌ Role not found in server.', flags: MessageFlags.Ephemeral });

        const uniqueCheck = await validateRoleUniqueness(interaction.guild, roleId);
        if (!uniqueCheck.valid) {
          return interaction.followUp({ content: `❌ Role already linked to **${uniqueCheck.existingItem?.name || roleId}**.`, flags: MessageFlags.Ephemeral });
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
          console.error('[System] Error resolving prerequisites during add:', e);
        }

        const item = await addShopItem(interaction.guildId, null, roleId, name, '', price, durationSeconds, null, 'role', [], requiredItems);
        
        let successMsg = `✅ Item **${name}** added!`;
        if (reqValidation.hasBooster) {
          successMsg += `\n🚀 **Booster Requirement Linked:** This item will now require an active Server Boost to buy/equip.`;
        }
        if (reqValidation.hasMvp) {
          successMsg += `\n🏆 **MVP Requirement Linked:** This item will now require the user to be the active Server MVP.`;
        }
        sendLog(interaction.guild, 'shop', 'green', '🛍️ Item Created', `Admin **<@${interaction.user.id}>** created item **${name}** (Price: ${price})`);

        const categories = await getShopCategories(interaction.guildId);
        const select = new StringSelectMenuBuilder().setCustomId(`shop_assign_cat_select_${item.id}`).setPlaceholder('Assign to Category')
          .addOptions([
            { label: 'No Category', value: 'null' }, 
            ...categories.map(c => ({ 
              label: (c.name && c.name.trim().length > 0) ? c.name.slice(0, 80) : `Unnamed Category #${c.id}`, 
              value: c.id.toString() 
            }))
          ]);
        await interaction.editReply({ content: successMsg + (reqValidation.hasBooster ? '' : ' Assign category?'), components: [new ActionRowBuilder().addComponents(select)] });

      } else if (type === 'pack') {
        await addShopItem(interaction.guildId, null, '', name, '', price, null, null, 'pack');
        sendLog(interaction.guild, 'shop', 'green', '📦 Pack Created', `Admin **<@${interaction.user.id}>** created pack **${name}** (Price: ${price})`);
        await interaction.followUp({ content: `✅ Pack **${name}** created!`, flags: MessageFlags.Ephemeral });
        await handleShopAdminAdd(interaction);
      }
    } else if (action === 'edit') {
      // ========== EDIT FLOW ==========
      const oldItem = await getShopItem(itemId, interaction.guildId);
      if (!oldItem) return interaction.followUp({ content: '❌ Item not found.', flags: MessageFlags.Ephemeral });

      let updates = { name, price };
      let reqValidation = { resolved: [], errors: [], hasBooster: false, hasMvp: false };

      if (type === 'item') {
        const roleId = interaction.fields.getTextInputValue('item_role').trim();
        const durationRaw = interaction.fields.getTextInputValue('item_duration').trim();
        const reqRaw = interaction.fields.getTextInputValue('item_required');

        if (roleId && roleId.toLowerCase() !== 'none') {
          // Block Booster Role as main Item Role
          const boosterRoleId = interaction.guild.roles.premiumSubscriberRole?.id;
          if (boosterRoleId && roleId === boosterRoleId) {
            return interaction.followUp({ content: "❌ Server Booster Role can't be a shop item. Enter it in the Required Items field instead to make Boosters only items.", flags: MessageFlags.Ephemeral });
          }

          // Block MVP Role as main Item Role
          const { getGuildConfig } = await import('../storage/config.js');
          const guildConfig = await getGuildConfig(interaction.guildId);
          if (guildConfig && guildConfig.mvpRoleId === roleId) {
            return interaction.followUp({ content: "❌ MVP Role can't be a shop item. Enter it in the Required Items field to make MVP only items.", flags: MessageFlags.Ephemeral });
          }

          if (!interaction.guild.roles.cache.has(roleId.split(/[,\s]+/)[0])) {
            return interaction.followUp({ content: '❌ Invalid Role ID.', flags: MessageFlags.Ephemeral });
          }
          updates.role_id = roleId;
        }

        if (durationRaw !== '') {
          const days = parseInt(durationRaw, 10);
          updates.duration_seconds = isNaN(days) || days === 0 ? null : days * 86400;
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
          console.error('[System] Error resolving prerequisites during edit:', e);
        }
      } else if (type === 'pack') {
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
    console.error('[System] Modal Submit Error:', error);
    if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: '❌ Error saving changes.', flags: MessageFlags.Ephemeral });
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
      guildId: interaction.guildId
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

// --- Shop Post Handlers ---

// Updated Post Item Handlers - Staging Panel
export async function handleShopPostStart(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

  const userId = interaction.user.id;
  const guildId = interaction.guildId;

  // Fetch ALL items/packs
  const items = await getShopItems(guildId, null, 'name', true);

  if (items.length === 0) {
    return interaction.editReply({ content: '❌ No items found in shop. Create items first.', embeds: [], components: [] });
  }

  // Get current pending state or initialize
  let state = pendingPosts.get(userId) || {
    itemId: null,
    channelId: null,
    sellerId: null,
    imageUrl: null,
    description: null,
    payout: null, // null = 100% of price, otherwise specific amount
    stock: null, // null = unlimited
    overridePrice: null // null = use original price
  };
  pendingPosts.set(userId, state);

  // Build embed with current selections
  const selectedItem = state.itemId ? items.find(i => i.id === parseInt(state.itemId)) : null;
  const isPack = selectedItem && (selectedItem.item_type === 'pack' || selectedItem.is_pack);

  // Validation for button states
  const canPublish = state.itemId && state.channelId;
  const canSetPayout = selectedItem && !isPack && state.sellerId;

  // Determine seller display
  let sellerDisplay = 'None (Default)';
  if (isPack) {
    sellerDisplay = 'Server';
  } else if (state.sellerId) {
    sellerDisplay = `<@${state.sellerId}>`;
  }

  // Determine payout display (just the amount, no percentage)
  let payoutDisplay = 'N/A';
  if (!isPack && state.sellerId) {
    const payoutAmount = state.payout !== null ? state.payout : (selectedItem ? Math.floor(selectedItem.price * 0.5) : 0);
    payoutDisplay = payoutAmount.toString();
  }

  const embed = new EmbedBuilder()
    .setTitle('📢 Post an Item/Pack To The Shop!')
    .setColor(0x9B59B6);

  // Row 1: Item Select
  const itemOptions = items.slice(0, 25).map(i => ({
    label: (i.name && i.name.trim().length > 0) ? i.name.slice(0, 80) : `Unnamed ${i.item_type === 'pack' ? 'Pack' : 'Item'} #${i.id}`,
    value: i.id.toString(),
    description: `${i.item_type === 'pack' ? '📦 Pack' : '👤 Item'} - ${i.price === 0 ? 'FREE' : i.price.toLocaleString() + ' coins'}`,
    default: state.itemId === i.id.toString()
  }));

  const itemSelect = new StringSelectMenuBuilder()
    .setCustomId('shop_post_item_select')
    .setPlaceholder('📦 Select Item/Pack (Required)')
    .addOptions(itemOptions);

  // Row 2: Channel Select
  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId('shop_post_channel_select')
    .setPlaceholder('🏪 Select Channel (Required)')
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
  if (state.channelId) channelSelect.setDefaultChannels([state.channelId]);

  // Row 3: User Select (Seller - Optional, disabled for packs)
  const userSelect = new UserSelectMenuBuilder()
    .setCustomId('shop_post_seller_select')
    .setPlaceholder(isPack ? '👤 Seller disabled for Packs' : '👤 Select Seller (Optional)')
    .setDisabled(isPack === true);
  if (state.sellerId && !isPack) userSelect.setDefaultUsers([state.sellerId]);

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
      .setDisabled(!canSetPayout || !isItemSelected),
    new ButtonBuilder()
      .setCustomId('shop_post_price_btn')
      .setLabel('Set Price')
      .setEmoji('🏷️')
      .setStyle((state.overridePrice !== null && selectedItem && state.overridePrice !== Number(selectedItem.price)) ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(!isItemSelected)
  );

  // Row 5: Action Buttons (4 buttons)
  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('shop_admin_home')
      .setLabel('Back')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('shop_post_reset')
      .setLabel('Reset')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!isModified),
    new ButtonBuilder()
      .setCustomId('shop_post_stock_btn')
      .setLabel('Set Stocks')
      .setEmoji('⏳')
      .setStyle(state.stock ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(!isItemSelected),
    new ButtonBuilder()
      .setCustomId('shop_post_publish')
      .setLabel('Publish')
      .setEmoji('🚀')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!canPublish)
  );

  await interaction.editReply({
    content: null,
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(itemSelect),
      new ActionRowBuilder().addComponents(channelSelect),
      new ActionRowBuilder().addComponents(userSelect),
      configRow,
      actionRow
    ]
  });
}

// Handle Item Selection in Staging Panel
export async function handleShopPostItemSelect(interaction) {
  const userId = interaction.user.id;
  const itemId = interaction.values[0];

  let state = pendingPosts.get(userId) || { itemId: null, channelId: null, sellerId: null, imageUrl: null, description: null, payout: null };
  state.itemId = itemId;
  state.overridePrice = null; // Revert override on item change
  
  const items = await getShopItems(interaction.guildId, null, 'name', true);
  const selectedItem = items.find(i => i.id === parseInt(itemId));

  // Check if selected item is a pack - if so, reset seller/payout (packs are server-only)
  if (selectedItem && selectedItem.item_type === 'pack') {
    state.sellerId = null;
    state.payout = null;
  } else if (selectedItem && state.sellerId) {
    // Item changed and seller exists - recalculate payout to 50% of new price
    state.payout = Math.floor(selectedItem.price * 0.5);
  }

  pendingPosts.set(userId, state);

  // Re-render panel
  await handleShopPostStart(interaction);
}

// Handle Channel Selection in Staging Panel
export async function handleShopPostChannelSelect(interaction) {
  const userId = interaction.user.id;
  const channelId = interaction.values[0];

  let state = pendingPosts.get(userId) || { itemId: null, channelId: null, sellerId: null, imageUrl: null };
  state.channelId = channelId;
  pendingPosts.set(userId, state);

  // Re-render panel
  await handleShopPostStart(interaction);
}

// Handle Seller Selection in Staging Panel
export async function handleShopPostSellerSelect(interaction) {
  const userId = interaction.user.id;
  const selectedUserId = interaction.values[0];
  const guildOwnerId = interaction.guild.ownerId;

  let state = pendingPosts.get(userId) || { itemId: null, channelId: null, sellerId: null, imageUrl: null, description: null, payout: null };

  // Owner-as-reset logic: selecting guild owner = reset seller to null
  if (selectedUserId === guildOwnerId) {
    state.sellerId = null;
    state.payout = null;
  } else {
    state.sellerId = selectedUserId;
    if (state.itemId) {
      const items = await getShopItems(interaction.guildId, null, 'name', true);
      const selectedItem = items.find(i => i.id === parseInt(state.itemId));
      if (selectedItem) {
        const maxCap = Math.floor(selectedItem.price * 0.5);

        if (state.payout !== null && state.payout !== undefined && state.payout > 0) {
          // Payout already set - clamp if exceeds max, otherwise keep
          if (state.payout > maxCap) {
            state.payout = maxCap; // Clamp down to max
          }
        } else {
          // Payout not set - default to 0
          state.payout = 0;
        }
      }
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
    .setCustomId('shop_post_desc_modal')
    .setTitle('Set Item Description');

  const descInput = new TextInputBuilder()
    .setCustomId('description')
    .setLabel('Description')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('Leave empty to use default description...')
    .setValue(state.description ?? '')
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
    .setCustomId('shop_post_price_modal')
    .setTitle('🏷️ Set Custom Price');

  const items = await getShopItems(interaction.guildId, null, 'name', true);
  const selectedItem = state.itemId ? items.find(i => i.id === parseInt(state.itemId)) : null;
  const originalPrice = selectedItem ? selectedItem.price : 0;

  const priceInput = new TextInputBuilder()
    .setCustomId('price_input')
    .setLabel('Override Default Price')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder(`Original: ${originalPrice}`)
    .setValue((state.overridePrice !== null && state.overridePrice !== undefined) ? state.overridePrice.toString() : '')
    .setRequired(false);

  modal.addComponents(new ActionRowBuilder().addComponents(priceInput));
  await interaction.showModal(modal);
}

export async function handleShopPostPayoutBtn(interaction) {
  const userId = interaction.user.id;
  const state = pendingPosts.get(userId);
  if (!state) return;
  
  // Calculate recommended 50%
  let suggestedCut = 0;
  if (state.itemId) {
    const items = await getShopItems(interaction.guildId, null, 'name', true);
    const selectedItem = items.find(i => i.id === parseInt(state.itemId));
    if (selectedItem) suggestedCut = Math.floor(selectedItem.price * 0.5);
  }

  const modal = new ModalBuilder()
    .setCustomId('shop_post_payout_modal')
    .setTitle('Seller Earnings Each Sale');

  const payoutInput = new TextInputBuilder()
    .setCustomId('payout')
    .setLabel('Amount')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder(suggestedCut > 0 ? `Max/Suggested cut: ${suggestedCut}` : 'Max 50% of original price')
    .setValue((state.payout !== null && state.payout !== undefined && state.payout > 0) ? state.payout.toString() : '')
    .setRequired(false);

  modal.addComponents(new ActionRowBuilder().addComponents(payoutInput));
  await interaction.showModal(modal);
}

// Handle Stock Button - Show Modal
export async function handleShopPostStockBtn(interaction) {
  const state = pendingPosts.get(interaction.user.id) || {};

  const modal = new ModalBuilder()
    .setCustomId('shop_post_stock_modal')
    .setTitle('Set Stock Limit');

  const stockInput = new TextInputBuilder()
    .setCustomId('stock')
    .setLabel('Total Supply')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Leave empty for unlimited')
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
    pendingPosts.set(interaction.user.id, state);
  }
  await handleShopPostStart(interaction);
}

// Handle Image URL Button - Show Modal
export async function handleShopPostImageBtn(interaction) {
  const state = pendingPosts.get(interaction.user.id) || {};

  const modal = new ModalBuilder()
    .setCustomId('shop_post_image_modal')
    .setTitle('Set Custom Image URL');

  const urlInput = new TextInputBuilder()
    .setCustomId('image_url')
    .setLabel('Image URL (leave empty to use default)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('https://example.com/image.png')
    .setValue(state.imageUrl || '')
    .setRequired(false);

  modal.addComponents(new ActionRowBuilder().addComponents(urlInput));
  await interaction.showModal(modal);
}

// Handle All Post Modal Submits (Image, Desc, Payout)
export async function handleShopPostModalSubmit(interaction) {
  await interaction.deferUpdate();
  const userId = interaction.user.id;
  const customId = interaction.customId;

  let state = pendingPosts.get(userId) || { 
    itemId: null, channelId: null, sellerId: null, 
    imageUrl: null, description: null, payout: null, stock: null 
  };

  if (customId === 'shop_post_image_modal') {
    const val = (interaction.fields.getTextInputValue('image_url') || '').trim().toLowerCase();
    state.imageUrl = (val === '' || val === 'none' || val === 'default') ? null : interaction.fields.getTextInputValue('image_url');
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

    // Validate 50% cap
    if (inputAmount > 0 && state.itemId) {
      const items = await getShopItems(interaction.guildId, null, 'name', true);
      const selectedItem = items.find(i => i.id === parseInt(state.itemId));
      if (selectedItem) {
        const maxPayout = Math.floor(selectedItem.price * 0.5);
        if (inputAmount > maxPayout) {
          return interaction.followUp({
            content: `⛔ Seller earnings cannot exceed 50% of the item price (Max: ${maxPayout}).`,
            flags: MessageFlags.Ephemeral
          });
        }
      }
    }
    state.payout = inputAmount;
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
  } else if (customId === 'shop_post_price_modal') {
    const val = (interaction.fields.getTextInputValue('price_input') || '').trim();
    
    const items = await getShopItems(interaction.guildId, null, 'name', true);
    const selectedItem = state.itemId ? items.find(i => i.id === parseInt(state.itemId)) : null;
    const originalPrice = selectedItem ? selectedItem.price : null;

    if (val === '') {
      state.overridePrice = null; // Revert to Default
    } else {
      const newPrice = /^\d+$/.test(val) ? parseInt(val, 10) : -1;
      
      if (newPrice < 0) {
        return interaction.followUp({ content: '❌ Please enter a valid non-negative whole number.', flags: MessageFlags.Ephemeral });
      }
      
      // If it matches base price, revert state (cleanup)
      state.overridePrice = (newPrice === Number(originalPrice)) ? null : newPrice;
    }
  }

  pendingPosts.set(userId, state);

  // Re-render panel
  await handleShopPostStart(interaction);
}

// Handle Publish Button - Actually post the item
export async function handleShopPostPublish(interaction) {
  const userId = interaction.user.id;
  const state = pendingPosts.get(userId);

  // Validation
  if (!state || !state.itemId || !state.channelId) {
    return interaction.reply({ content: '❌ You must select a channel first!', flags: MessageFlags.Ephemeral });
  }

  await interaction.deferUpdate();

  const { itemId, channelId, sellerId, imageUrl, description, payout, stock, overridePrice } = state;
  const item = await getShopItem(itemId, interaction.guildId);

  if (!item) {
    return interaction.followUp({ content: '❌ Item not found.', flags: MessageFlags.Ephemeral });
  }

  const effectivePrice = Number(overridePrice !== null ? overridePrice : item.price);
  const isFree = effectivePrice === 0;

  const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    return interaction.followUp({ content: '❌ Channel not found.', flags: MessageFlags.Ephemeral });
  }

  // Construct the Embed
  const embed = new EmbedBuilder()
    .setTitle(item.name)
    .setColor('#3498DB'); // Always Blue

  // JIT Sync: Always update global stock in DB before publishing to ensure state consistency
  // (This resets 'Sold Out' status if the user wants Unlimited/Null stock)
  await updateShopItem(itemId, { stock }); 
  item.stock = stock;

  if (imageUrl) {
    embed.setImage(imageUrl);
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
    .setEmoji('1490666813501997076') // OK_COIN
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(isSoldOut);

  const row = new ActionRowBuilder().addComponents(buyButton);

  try {
    await channel.send({ embeds: [embed], components: [row] });

    // Standardized Shop Admin Log
    sendLog(interaction.guild, 'shop', 'blue', '📢 Shop Post Created', `Admin **<@${interaction.user.id}>** posted **${item.name}** to <#${channelId}>`);

    // Reset session state for this user (except channelId/sellerId for convenience)
    pendingPosts.delete(userId);
    pendingPosts.set(userId, { channelId, sellerId });

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
    console.error('Failed to post shop item:', error);
    await interaction.followUp({ content: '❌ Failed to post. Check bot permissions in that channel.', flags: MessageFlags.Ephemeral });
  }
}

// --- Tier Management ---
export async function handleManageTiers(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  const itemId = interaction.customId.split('_').pop();
  const tiers = await getItemTiers(itemId, interaction.guildId);
  const item = await getShopItem(itemId, interaction.guildId);

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
}

export async function handleAddTierModal(interaction) {
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
}

export async function handleTierModalSubmit(interaction) {
  await interaction.deferUpdate();
  const itemId = interaction.customId.split('_').pop();

  const level = parseInt(interaction.fields.getTextInputValue('tier_level'));
  const price = parseInt(interaction.fields.getTextInputValue('tier_price'));
  const roleId = interaction.fields.getTextInputValue('tier_role');

  try {
    await addItemTier(itemId, interaction.guildId, level, roleId, price);

    // Standardized Shop Admin Log
    const item = await getShopItem(itemId, interaction.guildId);
    sendLog(interaction.guild, 'shop', 'green', '📶 Tier Added', `Admin **<@${interaction.user.id}>** added Tier **${level}** to **${item?.name || itemId}** (Price: **${price.toLocaleString()}** ${COIN_EMOJI})`);


    await interaction.followUp({ content: `✅ Tier ${level} added!`, flags: MessageFlags.Ephemeral });

    // Refresh Tier View
    const mockInteraction = {
      deferred: true,
      deferUpdate: async () => { },
      editReply: interaction.editReply.bind(interaction),
      customId: `shop_manage_tiers_${itemId}`,
      guildId: interaction.guildId,
      user: interaction.user
    };
    await handleManageTiers(mockInteraction);

  } catch (error) {
    await interaction.followUp({ content: `❌ Failed to add tier. Ensure level is unique.`, flags: MessageFlags.Ephemeral });
  }
}

// --- Delete Item Handlers ---

export async function handleDeleteItemStart(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

  // Get ALL items directly
  const allItems = await getShopItems(interaction.guildId, null, 'name', true);

  const rowBack = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('shop_admin_delete').setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary)
  );

  if (allItems.length === 0) {
    return interaction.editReply({ content: '❌ No items found to delete.', components: [rowBack], embeds: [] });
  }

  // Filter out packs
  const items = allItems.filter(i => {
    if (i.item_type === 'pack' || i.is_pack) return false;
    return true;
  });

  if (items.length === 0) {
    return interaction.editReply({ content: '❌ No valid items found.', components: [rowBack], embeds: [] });
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId('shop_select_item_delete')
    .setPlaceholder('Select Item to Delete')
    .addOptions(items.slice(0, 25).map(i => ({ 
      label: (i.name && i.name.trim().length > 0) ? i.name.slice(0, 80) : `Unnamed Item #${i.id}`, 
      value: i.id.toString() 
    })));

  const row = new ActionRowBuilder().addComponents(select);

  await interaction.editReply({ content: 'Select item to delete:', components: [row, rowBack], embeds: [] });
}

// Previously handleDeleteItemCategorySelect - Removed as we now list all items directly.
export async function handleDeleteItemCategorySelect(interaction) {
  // Deprecated redirect in case of old interactions
  await handleDeleteItemStart(interaction);
}

export async function handleDeleteItemSelect(interaction) {
  await interaction.deferUpdate();
  const itemId = parseInt(interaction.values[0]);

  // 1. Get name for feedback BEFORE deleting
  const item = await getShopItem(itemId, interaction.guildId);
  const itemName = item ? item.name : 'Unknown Item';

  // 2. Delete
  await deleteShopItem(itemId, interaction.guildId);

  // Standardized Shop Admin Log
  sendLog(interaction.guild, 'shop', 'red', '🗑️ Item Deleted', `Admin **<@${interaction.user.id}>** deleted item **${itemName}** from the Shop.`);


  // 3. Fetch remaining items - filter out packs AND invalid roles
  const allItems = await getShopItems(interaction.guildId, null, 'name', true);
  const remainingItems = allItems.filter(i => {
    if (i.item_type === 'pack' || i.is_pack) return false;
    if (i.id === itemId) return false;
    return true;
  });

  const rowBack = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('shop_admin_delete').setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary)
  );

  if (remainingItems.length === 0) {
    return interaction.editReply({
      content: `✅ Item **${itemName}** deleted.\n\n❌ No items left to delete.`,
      components: [rowBack],
      embeds: []
    });
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId('shop_select_item_delete')
    .setPlaceholder('Select Item to Delete')
    .addOptions(remainingItems.slice(0, 25).map(i => {
      const roleId = i.role_id ? i.role_id.split(/[,\s]+/)[0] : null;
      const isGhost = roleId && !interaction.guild.roles.cache.has(roleId);
      return { 
        label: isGhost ? `[GHOST] ${i.name}` : i.name, 
        value: i.id.toString(),
        description: isGhost ? 'Role was deleted from server' : undefined
      };
    }));

  const row = new ActionRowBuilder().addComponents(select);
  const successHeader = `✅ Item **${itemName}** deleted.`;

  // 4. Update Interface
  await interaction.editReply({
    content: remainingItems.length > 0 ? successHeader : `✅ Item **${itemName}** deleted.\n\n❌ No items left to delete.`,
    components: remainingItems.length > 0 ? [row, rowBack] : [rowBack],
    embeds: []
  });
}

export async function handleDeletePackStart(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  // Fetch all packs
  const items = await getShopItems(interaction.guildId, null, 'name', true);
  const packs = items.filter(i => i.item_type === 'pack' || i.is_pack);

  const rowBack = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('shop_admin_delete').setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary)
  );

  if (packs.length === 0) {
    // If no packs found initially, show message and back button (don't spam new message)
    return interaction.editReply({ content: '❌ No packs found.', components: [rowBack], embeds: [] });
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId('shop_select_pack_delete')
    .setPlaceholder('Select Pack to Delete')
    .addOptions(packs.slice(0, 25).map(p => ({ 
      label: (p.name && p.name.trim().length > 0) ? p.name.slice(0, 80) : `Unnamed Pack #${p.id}`, 
      value: p.id.toString() 
    })));

  const row = new ActionRowBuilder().addComponents(select);

  await interaction.editReply({ content: 'Select pack to delete:', components: [row, rowBack], embeds: [] });
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
    try {
        sendLog(interaction.guild, 'shop', 'red', '📦 Pack Deleted', `Admin **<@${interaction.user.id}>** deleted pack **${packName}**.`);
    } catch (logErr) {
        console.error('[System] ❌ Pack deletion log failed:', logErr.message);
    }

    // Fetch remaining packs
    const allItems = await getShopItems(interaction.guildId, null, 'name', true);
    const packs = allItems.filter(i => i.item_type === 'pack' || i.is_pack);

    const rowBack = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('shop_admin_delete').setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary)
    );

    if (packs.length === 0) {
      await interaction.editReply({
        content: `✅ Pack **${packName}** deleted.\n\n❌ No packs left to delete.`,
        components: [rowBack],
        embeds: []
      });
    } else {
      const select = new StringSelectMenuBuilder()
        .setCustomId('shop_select_pack_delete')
        .setPlaceholder('Select Pack to Delete')
        .addOptions(packs.slice(0, 25).map(p => ({ 
          label: (p.name && p.name.trim().length > 0) ? p.name.slice(0, 80) : `Unnamed Pack #${p.id}`, 
          value: p.id.toString() 
        })));

      const row = new ActionRowBuilder().addComponents(select);

      await interaction.editReply({
        content: `✅ Pack **${packName}** deleted. Select another to delete:`,
        components: [row, rowBack],
        embeds: []
      });
    }
  } catch (error) {
    console.error('[System] ❌ Error in handleDeletePackSelect:', error);
    const msg = '❌ Failed to delete pack.';
    if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
    else await interaction.editReply({ content: msg, components: [], embeds: [] });
  }
}

// --- Category Handlers ---

export async function handleCreateCategory(interaction) {
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
}

export async function handleCategoryModalSubmit(interaction) {
  try {
    await interaction.deferUpdate();
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
    console.error('[System] ❌ Category Modal Error:', error);
    if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: '❌ Error saving category.', flags: MessageFlags.Ephemeral });
  }
}

export async function handleEditCategoryStart(interaction) {
  await interaction.deferUpdate();
  const categories = await getShopCategories(interaction.guildId);

  if (categories.length === 0) {
    return interaction.followUp({ content: '❌ No categories found.', flags: MessageFlags.Ephemeral });
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId('shop_select_cat_edit_rename')
    .setPlaceholder('Select Category to Edit')
    .addOptions(categories.map(c => ({ 
      label: (c.name && c.name.trim().length > 0) ? c.name.slice(0, 80) : `Unnamed Category #${c.id}`, 
      value: c.id.toString() 
    })));

  const row = new ActionRowBuilder().addComponents(select);
  const rowBack = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('shop_admin_edit').setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary)
  );

  await interaction.editReply({ content: '**Choose a category to manage:**', components: [row, rowBack], embeds: [] });
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
      .setColor('#9B59B6')
      .setTimestamp();

    const actionRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`shop_cat_settings_${categoryId}`)
          .setLabel('Edit')
          .setEmoji('⚙️')
          .setStyle(ButtonStyle.Primary),
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
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.editReply({ content: null, embeds: [embed], components: [actionRow, backRow] });
  } catch (error) {
    console.error('[System] ❌ Error in handleEditCategorySelect:', error);
    if (!interaction.replied) await interaction.followUp({ content: '❌ An error occurred.', flags: MessageFlags.Ephemeral });
  }
}

export async function handleEditCategoryRenameStart(interaction) {
  try {
    // DO NOT DEFER - We need to show a modal immediately
    const categoryId = interaction.customId.split('_').pop();
    const categories = await getShopCategories(interaction.guildId);
    const category = categories.find(c => c.id.toString() === categoryId);

    if (!category) {
      return interaction.reply({ content: '❌ Category not found.', flags: MessageFlags.Ephemeral });
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
    console.error('[System] ❌ Error in handleEditCategoryRenameStart:', error);
    // Cannot reply if we failed before showing modal usually, but try
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ Failed to open rename modal.', flags: MessageFlags.Ephemeral });
    }
  }
}

export async function handleEditCategoryAddItemsStart(interaction) {
  try {
    await interaction.deferUpdate();
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

    if (standalone.length === 0) {
      return interaction.followUp({ content: '❌ No available items found to add.', flags: MessageFlags.Ephemeral });
    }

    const select = new StringSelectMenuBuilder()
      .setCustomId(`shop_edit_cat_add_select_${categoryId}`)
      .setPlaceholder('Select Item to Add to Category')
      .addOptions(standalone.slice(0, 25).map(i => ({ 
        label: (i.name && i.name.trim().length > 0) ? i.name.slice(0, 80) : `Unnamed Item #${i.id}`, 
        value: i.id.toString() 
      })));

    const row = new ActionRowBuilder().addComponents(select);
    const rowBack = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`shop_cat_manage_${categoryId}`) // Back to category management
        .setLabel('Back')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.editReply({ content: '**Choose an item to add to this category:**', components: [row, rowBack], embeds: [] });
  } catch (error) {
    console.error(`[System] ❌ Error in handleEditCategoryAddItemsStart:`, error);
    if (!interaction.replied) await interaction.followUp({ content: '❌ Failed to load add items menu.', flags: MessageFlags.Ephemeral });
  }
}

export async function handleEditCategoryAddItemsSelect(interaction) {
  try {
    await interaction.deferUpdate();
    const categoryId = interaction.customId.split('_').pop();
    const itemId = interaction.values[0];

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
    const categories = await getShopCategories(interaction.guildId);
    const category = categories.find(c => c.id.toString() === categoryId);
    const categoryName = category ? category.name : 'Category';

    // 2. Get Added Item Name
    const addedItem = await getShopItem(itemId, interaction.guildId);
    const addedItemName = addedItem ? addedItem.name : 'Item';

    // 3. Fetch remaining standalone items with valid roles
    const items = await getShopItems(interaction.guildId, null, 'name', true);
    const standalone = items.filter(i => {
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
      // No more items
      await interaction.editReply({
        content: `✅ **${addedItemName}** added to **${categoryName}**.\n\nNo more standalone items available to add.`,
        components: [rowBack],
        embeds: []
      });
    } else {
      // Update dropdown
      const select = new StringSelectMenuBuilder()
        .setCustomId(`shop_edit_cat_add_select_${categoryId}`)
        .setPlaceholder('Select Item to Add to Category')
        .addOptions(standalone.slice(0, 25).map(i => ({ 
          label: (i.name && i.name.trim().length > 0) ? i.name.slice(0, 80) : `Unnamed Item #${i.id}`, 
          value: i.id.toString(), 
          description: i.price === 0 ? 'FREE' : `${i.price.toLocaleString()} coins` 
        })));

      const row = new ActionRowBuilder().addComponents(select);

      await interaction.editReply({
        content: `✅ **${addedItemName}** added to **${categoryName}**.\nChoose another item to add:`,
        components: [row, rowBack],
        embeds: []
      });
    }

  } catch (error) {
    console.error(`[System] ❌ Error in handleEditCategoryAddItemsSelect:`, error);
    if (!interaction.replied) await interaction.followUp({ content: '❌ Failed to add item to category.', flags: MessageFlags.Ephemeral });
  }
}

export async function handleEditCategoryRemoveItemsStart(interaction) {
  try {
    await interaction.deferUpdate();
    const categoryId = interaction.customId.split('_').pop();

    const items = await getShopItems(interaction.guildId, parseInt(categoryId), 'price', true);

    if (items.length === 0) {
      return interaction.followUp({ content: '❌ This category is empty.', flags: MessageFlags.Ephemeral });
    }

    const select = new StringSelectMenuBuilder()
      .setCustomId(`shop_edit_cat_remove_select_${categoryId}`)
      .setPlaceholder('Select Item to Remove from Category')
      .addOptions(items.slice(0, 25).map(i => ({ 
        label: (i.name && i.name.trim().length > 0) ? i.name.slice(0, 80) : `Unnamed Item #${i.id}`, 
        value: i.id.toString() 
      })));

    const row = new ActionRowBuilder().addComponents(select);
    const rowBack = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`shop_cat_manage_${categoryId}`) // Back to category management
        .setLabel('Back')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.editReply({ content: '**Choose an item to remove:**', components: [row, rowBack], embeds: [] });
  } catch (error) {
    console.error(`[System] ❌ Error in handleEditCategoryRemoveItemsStart:`, error);
    if (!interaction.replied) await interaction.followUp({ content: '❌ Failed to load remove items menu.', flags: MessageFlags.Ephemeral });
  }
}

export async function handleEditCategoryRemoveItemsSelect(interaction) {
  try {
    await interaction.deferUpdate();
    const categoryId = interaction.customId.split('_').pop();
    const itemId = parseInt(interaction.values[0]);

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
      await interaction.editReply({
        content: `✅ **${removedItemName}** removed from **${categoryName}**.\n\n❌ Category is now empty.`,
        components: [rowBack],
        embeds: []
      });
    } else {
      const select = new StringSelectMenuBuilder()
        .setCustomId(`shop_edit_cat_remove_select_${categoryId}`)
        .setPlaceholder('Select Item to Remove from Category')
        .addOptions(items.slice(0, 25).map(i => ({ 
          label: (i.name && i.name.trim().length > 0) ? i.name.slice(0, 80) : `Unnamed Item #${i.id}`, 
          value: i.id.toString(),
          description: `${i.price.toLocaleString()} coins`
        })));

      const row = new ActionRowBuilder().addComponents(select);

      await interaction.editReply({
        content: `✅ **${removedItemName}** removed from **${categoryName}**.\nChoose another item to remove:`,
        components: [row, rowBack],
        embeds: []
      });
    }

  } catch (error) {
    console.error(`[System] ❌ Error in handleEditCategoryRemoveItemsSelect:`, error);
    if (!interaction.replied) await interaction.followUp({ content: '❌ Failed to remove item from category.', flags: MessageFlags.Ephemeral });
  }
}

export async function handleEditCategoryModalSubmit(interaction) {
  await interaction.deferUpdate();
  const categoryId = interaction.customId.split('_').pop();
  const name = interaction.fields.getTextInputValue('cat_name');
  const typeRaw = interaction.fields.getTextInputValue('cat_type');
  const type = parseInt(typeRaw);

  if (isNaN(type) || (type !== 0 && type !== 1)) {
    return interaction.followUp({ content: '❌ Invalid Category Type. Use 0 for Multi (Stack) or 1 for Single (Swap).', flags: MessageFlags.Ephemeral });
  }

  const categories = await getShopCategories(interaction.guildId);
  const oldCat = categories.find(c => c.id.toString() === categoryId);
  const oldName = oldCat ? oldCat.name : 'Unknown';
  const oldType = oldCat ? (oldCat.category_type === 1 ? 'Single' : 'Multi') : 'Unknown';


  await updateShopCategory(categoryId, { name, category_type: type });

  // Standardized Shop Admin Log (Smart Diffing)
  const diff = formatDiff(oldCat, { ...oldCat, name, category_type: type }, ['name', 'category_type']);
  if (diff) {
    sendLog(interaction.guild, 'shop', 'blue', '📂 Category Updated', `Admin **<@${interaction.user.id}>** updated shop category **${name}**\n${diff}`);
  }


  await interaction.followUp({ content: `✅ Category updated to **${name}**`, flags: MessageFlags.Ephemeral });

  // Reload Category Management View
  const mock = {
    deferred: true, replied: false, deferUpdate: async () => { }, editReply: interaction.editReply.bind(interaction), followUp: interaction.followUp.bind(interaction),
    customId: `shop_cat_manage_${categoryId}`, // Updated to use consistent management ID
    values: [categoryId],
    isAnySelectMenu: () => true,
    guildId: interaction.guildId
  };
  await handleEditCategorySelect(mock);
}

export async function handleDeleteCategoryStart(interaction) {
  await interaction.deferUpdate();
  const categories = await getShopCategories(interaction.guildId);

  const rowBack = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('shop_admin_delete').setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary)
  );

  if (categories.length === 0) {
    return interaction.editReply({ content: '❌ No categories found.', components: [rowBack], embeds: [] });
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId('shop_select_cat_delete_confirm')
    .setPlaceholder('Select Category to Delete')
    .addOptions(categories.map(c => ({ 
      label: (c.name && c.name.trim().length > 0) ? c.name.slice(0, 80) : `Unnamed Category #${c.id}`, 
      value: c.id.toString() 
    })));

  const row = new ActionRowBuilder().addComponents(select);

  await interaction.editReply({
    content: 'Select the category you want to remove.',
    embeds: [],
    components: [row, rowBack]
  });
}

export async function handleDeleteCategoryConfirm(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    const categoryId = interaction.values[0];

    // Get name for feedback
    const categoriesBefore = await getShopCategories(interaction.guildId);
    const category = categoriesBefore.find(c => c.id.toString() === categoryId);
    const categoryName = category ? category.name : 'Category';

    // Step 1: Detach items (Make them standalone)
    const detachResult = await detachItemsFromCategory(categoryId);

    // Step 2: Delete Category
    await deleteShopCategory(categoryId);

    // Bulk Audit Log
    try {
        sendBulkLog(
          interaction.guild, 
          'shop', 
          'red', 
          'Category Deleted', 
          `Admin **${getUserLogName(interaction.member)}** deleted category **'${categoryName}'**.\n• **Status:** Removed successfully.\n• **Items Affected:** **${detachResult.count}** items were made standalone.`
        );
    } catch (logErr) {
        console.error('[System] ❌ Category deletion log failed:', logErr.message);
    }

    // Step 3: Fetch remaining categories
    const categories = await getShopCategories(interaction.guildId);

    const rowBack = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('shop_admin_delete').setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary)
    );

    if (categories.length === 0) {
      await interaction.editReply({
        content: `✅ Category **${categoryName}** deleted.\n\n❌ No categories left to delete.`,
        components: [rowBack],
        embeds: []
      });
    } else {
      const select = new StringSelectMenuBuilder()
        .setCustomId('shop_select_cat_delete_confirm')
        .setPlaceholder('Select Category to Delete')
        .addOptions(categories.map(c => ({ 
          label: (c.name && c.name.trim().length > 0) ? c.name.slice(0, 80) : `Unnamed Category #${c.id}`, 
          value: c.id.toString() 
        })));

      const row = new ActionRowBuilder().addComponents(select);

      await interaction.editReply({
        content: `✅ Category **${categoryName}** deleted. Select another to delete:`,
        components: [row, rowBack],
        embeds: []
      });
    }
  } catch (error) {
    console.error('[System] ❌ Error in handleDeleteCategoryConfirm:', error);
    const msg = '❌ Failed to delete category.';
    if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
    else await interaction.editReply({ content: msg, components: [], embeds: [] });
  }
}

// --- Edit Item Handlers ---

export async function handleEditItemStart(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

  const items = await getShopItems(interaction.guildId, null, 'name', true);

  // Filter OUT packs AND items with invalid/missing roles
  const editItems = items.filter(i => {
    if (i.is_pack || i.item_type === 'pack') return false;
    if (!i.role_id) return false;
    const roleId = i.role_id.split(/[,\s]+/)[0];
    return interaction.guild.roles.cache.has(roleId);
  });

  if (editItems.length === 0) {
    return interaction.followUp({ content: '❌ No valid items found.', flags: MessageFlags.Ephemeral });
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId('shop_edit_item_select')
    .setPlaceholder('Select Item to Edit')
    .addOptions(editItems.slice(0, 25).map(i => ({ 
      label: (i.name && i.name.trim().length > 0) ? i.name.slice(0, 80) : `Unnamed Item #${i.id}`, 
      value: i.id.toString(), 
      description: i.price === 0 ? 'FREE' : `${i.price.toLocaleString()} coins` 
    })));

  const row = new ActionRowBuilder().addComponents(select);
  const rowBack = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('shop_admin_edit').setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary)
  );

  await interaction.editReply({
    content: '**Choose an item to manage:**',
    components: [row, rowBack],
    embeds: []
  });
}

// Previously handleEditItemCategorySelect - Removed / Unused
export async function handleEditItemCategorySelect(interaction) {
  // Deprecated redirect
  await handleEditItemStart(interaction);
}

export async function handleEditItemSelect(interaction, successHeader = null) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

    // This might come from a select menu (values[0]) or a button (customId split)
    let itemId;
    if (interaction.isAnySelectMenu()) {
      itemId = interaction.values[0];
    } else {
      itemId = interaction.customId.split('_').pop();
    }

    const item = await getShopItem(itemId, interaction.guildId);
    if (!item) return interaction.followUp({ content: '❌ Item not found.', flags: MessageFlags.Ephemeral });

    // Ensure we are not editing a pack in the item editor
    if (item.is_pack || item.item_type === 'pack') {
      console.warn(`[System] ⚠️ Attempted to edit Pack ${item.id} in Item Editor`);
      // Redirect or error
      // Since we have handleEditPackSelect, we could redirect, but safer to error
      return interaction.followUp({ content: '❌ This is a pack. Please use "Edit Pack" instead.', flags: MessageFlags.Ephemeral });
    }

    // Calculate Statistics
    const catCount = item.category_id ? 1 : 0;
    const packCount = await getItemUsageCount(item.id, interaction.guildId);
    const roleMention = item.role_id ? `<@&${item.role_id}>` : 'None';

    // Show prerequisites
    let prereqDisplay = 'None';
    let reqItems = item.required_items;
    if (typeof reqItems === 'string') {
      try { reqItems = JSON.parse(reqItems); } catch (e) { reqItems = []; }
    }
    if (reqItems && Array.isArray(reqItems) && reqItems.length > 0) {
      const allItems = await getShopItems(interaction.guildId, null, 'name', true);
      const reqDisplays = reqItems
        .map(id => {
            // Check for Booster & MVP Markers
            if (typeof id === 'string' && id.startsWith('booster:')) {
              return '🚀 **Server Booster**';
            }
            if (typeof id === 'string' && id.startsWith('mvp:')) {
              return '🏆 **Active Server MVP**';
            }
            const match = allItems.find(i => i.id === id);
            if (!match || !match.role_id) return null;
            return `<@&${match.role_id}>`;
        })
        .filter(Boolean);
      prereqDisplay = reqDisplays.length > 0 ? reqDisplays.join(', ') : 'None';
    }

    // Get category name for display
    const categories = await getShopCategories(interaction.guildId);
    const itemCategory = categories.find(c => c.id === item.category_id);
    const categoryDisplay = itemCategory ? itemCategory.name : 'None';

    const embed = new EmbedBuilder()
      .setTitle(`⚙️ Edit Item: ${item.name}`)
      .setDescription(`Price: **${item.price === 0 ? 'FREE' : item.price.toLocaleString() + ' coins'}**\nRole: ${roleMention}\nCategory: ${categoryDisplay}\nIn Packs: ${packCount}\nRequired Items: ${prereqDisplay}`)
      .setColor('#3498DB');

    const catOptions = [
      { label: 'No Category', value: 'null', description: 'Remove from Category' },
      ...categories.map(c => ({ 
        label: (c.name && c.name.trim().length > 0) ? c.name.slice(0, 80) : `Unnamed Category #${c.id}`, 
        value: c.id.toString(), 
        default: c.id == item.category_id 
      }))
    ];

    const catSelect = new StringSelectMenuBuilder()
      .setCustomId(`shop_assign_cat_select_manage_${itemId}`)
      .setPlaceholder('Move to Category')
      .addOptions(catOptions);

    const rowCat = new ActionRowBuilder().addComponents(catSelect);

    const actionRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`shop_item_edit_details_${itemId}`)
          .setLabel('Edit Details')
          .setEmoji('✏️')
          .setStyle(ButtonStyle.Primary)
      );

    const backRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('shop_edit_item') // Back to Item List
        .setLabel('Back')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.editReply({
      content: successHeader || '**Manage items and settings for this item:**',
      embeds: [embed],
      components: [rowCat, actionRow, backRow]
    });
  } catch (error) {
    console.error('[System] ❌ Error in handleEditItemSelect:', error);
    if (!interaction.replied) {
      await interaction.followUp({ content: '❌ An error occurred while loading item details.', flags: MessageFlags.Ephemeral });
    }
  }
}

// Old handleManageItemCategorySelect removed to prevent duplicate declaration
// The active version is defined earlier in the file.

export async function handleEditItemDetails(interaction) {
  try {
    const itemId = interaction.customId.split('_').pop();
    const item = await getShopItem(itemId, interaction.guildId);

    if (!item) return interaction.reply({ content: '❌ Item not found.', flags: MessageFlags.Ephemeral });

    // Security: Ensure this is NOT a pack
    if (item.is_pack || item.item_type === 'pack') {
      return handleEditPackDetails(interaction);
    }

    const modal = new ModalBuilder()
      .setCustomId(`shop_item_modal_edit_${itemId}_item`)
      .setTitle('Edit Shop Item');

    const nameInput = new TextInputBuilder().setCustomId('item_name').setLabel('Name').setStyle(TextInputStyle.Short).setValue(item.name).setRequired(true);
    const priceInput = new TextInputBuilder().setCustomId('item_price').setLabel('Price').setStyle(TextInputStyle.Short).setValue(String(item.price)).setRequired(true);
    const roleInput = new TextInputBuilder().setCustomId('item_role').setLabel('Role ID').setStyle(TextInputStyle.Short).setValue(item.role_id || '').setRequired(true);
    const durInput = new TextInputBuilder().setCustomId('item_duration').setLabel('Duration (Days)').setStyle(TextInputStyle.Short).setValue(item.duration_seconds ? String(Math.floor(item.duration_seconds / 86400)) : '').setRequired(false);

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
      .setLabel('Required Items (Role IDs)')
      .setStyle(TextInputStyle.Short)
      .setValue(reqPreFill)
      .setRequired(false)
      .setPlaceholder('Separate IDs by "-", "," or space');

    modal.addComponents(
      new ActionRowBuilder().addComponents(nameInput),
      new ActionRowBuilder().addComponents(priceInput),
      new ActionRowBuilder().addComponents(roleInput),
      new ActionRowBuilder().addComponents(durInput),
      new ActionRowBuilder().addComponents(reqInput)
    );

    await interaction.showModal(modal);
  } catch (error) {
    console.error('[System] ❌ Error in handleEditItemDetails:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ Failed to open edit details.', flags: MessageFlags.Ephemeral });
    }
  }
}

/**
 * Dedicated Modal for Packs (Name & Price Only)
 */
export async function handleEditPackDetails(interaction) {
  try {
    const packId = interaction.customId.split('_').pop();
    const pack = await getShopItem(packId, interaction.guildId);

    if (!pack) return interaction.reply({ content: '❌ Pack not found.', flags: MessageFlags.Ephemeral });

    const modal = new ModalBuilder()
      .setCustomId(`shop_pack_modal_edit_${packId}`)
      .setTitle('Edit Pack');

    const nameInput = new TextInputBuilder()
      .setCustomId('item_name')
      .setLabel('Name')
      .setStyle(TextInputStyle.Short)
      .setValue(pack.name)
      .setRequired(true);

    const priceInput = new TextInputBuilder()
      .setCustomId('item_price')
      .setLabel('Price')
      .setStyle(TextInputStyle.Short)
      .setValue(String(pack.price))
      .setRequired(true);

    modal.addComponents(
      new ActionRowBuilder().addComponents(nameInput),
      new ActionRowBuilder().addComponents(priceInput)
    );

    await interaction.showModal(modal);
  } catch (error) {
    console.error('[System] ❌ Error in handleEditPackDetails:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ Failed to open pack edit modal.', flags: MessageFlags.Ephemeral });
    }
  }
}

export async function handleEditPackStart(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

    const items = await getShopItems(interaction.guildId, null, 'name', true);
    const packs = items.filter(i => i.item_type === 'pack' || i.is_pack);

    if (packs.length === 0) {
      return interaction.followUp({ content: '❌ No packs found.', flags: MessageFlags.Ephemeral });
    }

    const select = new StringSelectMenuBuilder()
      .setCustomId('shop_select_pack_edit')
      .setPlaceholder('Select Pack to Edit')
      .addOptions(packs.slice(0, 25).map(p => ({ 
        label: (p.name && p.name.trim().length > 0) ? p.name.slice(0, 80) : `Unnamed Pack #${p.id}`, 
        value: p.id.toString() 
      })));

    const row = new ActionRowBuilder().addComponents(select);
    const rowBack = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('shop_admin_edit').setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary)
    );

    await interaction.editReply({ content: '**Choose a pack to manage:**', components: [row, rowBack], embeds: [] });
  } catch (error) {
    console.error('[System] ❌ Error in handleEditPackStart:', error);
    if (!interaction.replied) await interaction.followUp({ content: '❌ An error occurred.', flags: MessageFlags.Ephemeral });
  }
}

export async function handleEditPackSelect(interaction, successHeader = null) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

    // Determine packId from select menu or customId
    let packId;
    if (interaction.isAnySelectMenu()) {
      packId = interaction.values[0];
    } else {
      packId = interaction.customId.split('_').pop();
    }

    const item = await getShopItem(packId, interaction.guildId);
    if (!item) return interaction.followUp({ content: '❌ Pack not found.', flags: MessageFlags.Ephemeral });

    // Resolve Content Names
    let contentsDisplay = 'None';
    let contentIds = item.contents;

    // Robust parsing
    if (typeof contentIds === 'string') {
      try { contentIds = JSON.parse(contentIds); } catch (e) { contentIds = []; }
    }
    if (!Array.isArray(contentIds)) contentIds = [];

    if (contentIds.length > 0) {
      const allItems = await getShopItems(interaction.guildId, null, 'name', true);

      // Filter out ghost/unknown items - only show valid items with names and roles
      const validContents = contentIds
        .map(id => allItems.find(i => i.id === id))
        .filter(item => item && item.name && item.role_id);

      const contentNames = validContents.map(item => item.name);

      if (contentNames.length === 0) {
        contentsDisplay = '**None**';
      } else if (contentNames.length <= 30) {
        contentsDisplay = contentNames.join(', ');
      } else {
        contentsDisplay = contentNames.slice(0, 30).join(', ') + `... and ${contentNames.length - 30} more`;
      }
    } else {
        contentsDisplay = '**None**';
    }

    const embed = new EmbedBuilder()
      .setTitle(`📦 Edit Pack: ${item.name}`)
      .setDescription(`Price: **${item.price === 0 ? 'FREE' : item.price.toLocaleString() + ' coins'}**\nContents: ${contentsDisplay}`)
      .setColor('#8E44AD'); // Purple for packs

    const actionRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`shop_pack_edit_${packId}`) // Rename / Price Modal
        .setLabel('Edit')
        .setEmoji('✏️')
        .setStyle(ButtonStyle.Primary),
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
        .setCustomId('shop_edit_pack_start') // Back to pack list
        .setLabel('Back')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.editReply({ 
      content: successHeader || '**Manage items and settings for this pack:**', 
      embeds: [embed], 
      components: [actionRow, backRow] 
    });
  } catch (error) {
    console.error('[System] ❌ Error in handleEditPackSelect:', error);
    if (!interaction.replied) await interaction.followUp({ content: '❌ Failed to load pack details.', flags: MessageFlags.Ephemeral });
  }
}

export async function handlePackAddContentStart(interaction) {
  try {
    await interaction.deferUpdate();
    const packId = interaction.customId.split('_').pop();
    const pack = await getShopItem(packId, interaction.guildId);

    // Get items NOT in pack
    let currentContentIds = pack.contents;
    if (typeof currentContentIds === 'string') {
      try { currentContentIds = JSON.parse(currentContentIds); } catch (e) { currentContentIds = []; }
    }
    if (!Array.isArray(currentContentIds)) currentContentIds = [];

    // Fetch all ITEMS (not packs), filter out ghost items without valid roles
    const allItems = await getShopItems(interaction.guildId, null, 'name', true);
    const availableItems = allItems.filter(i => !i.is_pack && i.role_id && !currentContentIds.includes(i.id));

    if (availableItems.length === 0) {
      return interaction.followUp({ content: '❌ No available items to add.', flags: MessageFlags.Ephemeral });
    }
    const select = new StringSelectMenuBuilder()
      .setCustomId(`shop_pack_add_content_select_${packId}`)
      .setPlaceholder('Select Item to Add to Pack')
      .addOptions(availableItems.slice(0, 25).map(i => ({ 
        label: (i.name && i.name.trim().length > 0) ? i.name.slice(0, 80) : `Unnamed Item #${i.id}`, 
        value: i.id.toString(), 
        description: i.price === 0 ? 'FREE' : `${i.price.toLocaleString()} coins` 
      })));

    const row = new ActionRowBuilder().addComponents(select);
    const rowBack = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`shop_pack_manage_${packId}`) // Return to Pack Manage
        .setLabel('Back')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.editReply({
        content: `**Choose an item to add to this pack:**`,
        components: [row, rowBack],
        embeds: []
    });
  } catch (error) {
    console.error('[System] ❌ Error in handlePackAddContentStart:', error);
    if (!interaction.replied) await interaction.followUp({ content: '❌ Failed to load add content menu.', flags: MessageFlags.Ephemeral });
  }
}

export async function handlePackAddContentSelect(interaction) {
  try {
    await interaction.deferUpdate();
    // Extract Pack ID from Custom ID: shop_pack_add_content_select_{packId}
    const packId = interaction.customId.split('_').pop();
    const itemId = parseInt(interaction.values[0]);

    if (!packId || isNaN(parseInt(packId))) {
      return interaction.followUp({ content: '❌ Invalid Pack ID.', flags: MessageFlags.Ephemeral });
    }

    const item = await getShopItem(itemId, interaction.guildId);
    const pack = await getShopItem(packId, interaction.guildId);

    if (!pack) {
      return interaction.followUp({ content: '❌ Pack not found.', flags: MessageFlags.Ephemeral });
    }

    // 1. Update contents array
    let currentContents = pack.contents;
    if (typeof currentContents === 'string') {
      try { currentContents = JSON.parse(currentContents); } catch (e) { currentContents = []; }
    }
    if (!Array.isArray(currentContents)) currentContents = [];

    // Ensure uniqueness just in case
    const newContents = [...new Set([...currentContents, itemId])];

    // 2. Update role_ids
    let currentRoles = pack.role_id ? pack.role_id.split(/[,\s]+/) : [];
    if (item && item.role_id) {
      const newRoles = item.role_id.split(/[,\s]+/);
      // Merge unique
      currentRoles = [...new Set([...currentRoles, ...newRoles])];
    }
    const newRoleId = currentRoles.join(' ');

    const itemObj = await getShopItem(itemId, interaction.guildId);
    const packObj = await getShopItem(packId, interaction.guildId);
    const addedItemName = itemObj ? itemObj.name : 'Item';
    const packName = packObj ? packObj.name : 'Pack';

    // EXECUTE UPDATE
    await updateShopItem(packId, { contents: newContents, role_id: newRoleId });

    // Standardized Shop Admin Log
    sendLog(interaction.guild, 'shop', 'blue', '📦 Item Added to Pack', `Admin **<@${interaction.user.id}>** added item **${addedItemName}** to pack **${packName}**`);


    // --- Persistent Menu Logic ---

    // 3. Fetch remaining available items (Items NOT in pack and NOT packs)
    const allItems = await getShopItems(interaction.guildId, null, 'name', true);
    const availableItems = allItems.filter(i => !i.is_pack && !newContents.includes(i.id));

    const rowBack = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`shop_pack_manage_${packId}`)
        .setLabel('Back')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary)
    );

    if (availableItems.length === 0) {
      await interaction.editReply({
        content: `✅ **${addedItemName}** added to **${packName}**.\n\nNo more items available to add.`,
        components: [rowBack],
        embeds: []
      });
    } else {
      const select = new StringSelectMenuBuilder()
        .setCustomId(`shop_pack_add_content_select_${packId}`)
        .setPlaceholder('Select Item to Add to Pack')
        .addOptions(availableItems.slice(0, 25).map(i => ({ 
          label: (i.name && i.name.trim().length > 0) ? i.name.slice(0, 80) : `Unnamed Item #${i.id}`, 
          value: i.id.toString(), 
          description: i.price === 0 ? 'FREE' : `${i.price.toLocaleString()} coins` 
        })));

      const row = new ActionRowBuilder().addComponents(select);

      await interaction.editReply({
        content: `✅ **${addedItemName}** added to **${packName}**.\nChoose another item to add:`,
        components: [row, rowBack],
        embeds: []
      });
    }

  } catch (error) {
    console.error('[System] ❌ Error in handlePackAddContentSelect:', error);
    if (!interaction.replied) await interaction.followUp({ content: '❌ Failed to add item to pack.', flags: MessageFlags.Ephemeral });
  }
}

export async function handlePackRemoveContentStart(interaction) {
  try {
    await interaction.deferUpdate();
    const packId = interaction.customId.split('_').pop();
    const pack = await getShopItem(packId, interaction.guildId);

    let currentContentIds = pack.contents;
    if (typeof currentContentIds === 'string') {
      try { currentContentIds = JSON.parse(currentContentIds); } catch (e) { currentContentIds = []; }
    }
    if (!Array.isArray(currentContentIds)) currentContentIds = [];

    if (currentContentIds.length === 0) {
      return interaction.followUp({ content: '❌ Pack is empty.', flags: MessageFlags.Ephemeral });
    }

    // Need to fetch names of items in pack
    const allItems = await getShopItems(interaction.guildId, null, 'name', true);

    // Ensure type safety for content IDs
    const contentIds = currentContentIds.map(id => parseInt(id));
    const packItems = allItems.filter(i => contentIds.includes(i.id));

    // If items exist in DB but aren't found (deleted?), show raw IDs as fallback options to allow cleanup
    if (packItems.length === 0 && contentIds.length > 0) {
      // This happens if items were deleted but not removed from pack.
      // We should offer them for removal by ID.
    }

    const options = packItems.length > 0
      ? packItems.slice(0, 25).map(i => ({ 
          label: (i.name && i.name.trim().length > 0) ? i.name.slice(0, 80) : `Unnamed Item #${i.id}`, 
          value: i.id.toString() 
        }))
      : contentIds.slice(0, 25).map(id => ({ label: `Unknown Item ${id}`, value: id.toString() }));

    const select = new StringSelectMenuBuilder()
      .setCustomId(`shop_pack_remove_content_select_${packId}`)
      .setPlaceholder('Select Item to Remove from Pack')
      .addOptions(options);

    const row = new ActionRowBuilder().addComponents(select);
    const rowBack = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`shop_pack_manage_${packId}`)
        .setLabel('Back')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.editReply({
        content: `**Choose an item to remove from this pack:**`,
        components: [row, rowBack],
        embeds: []
    });
  } catch (error) {
    console.error('[System] ❌ Error in handlePackRemoveContentStart:', error);
    if (!interaction.replied) await interaction.followUp({ content: '❌ Failed to load remove content menu.', flags: MessageFlags.Ephemeral });
  }
}

export async function handlePackRemoveContentSelect(interaction) {
  try {
    await interaction.deferUpdate();
    // Extract Pack ID from Custom ID: shop_pack_remove_content_select_{packId}
    const packId = interaction.customId.split('_').pop();
    const itemId = parseInt(interaction.values[0]);

    if (!packId || isNaN(parseInt(packId))) {
      return interaction.followUp({ content: '❌ Invalid Pack ID.', flags: MessageFlags.Ephemeral });
    }

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

    // 2. Update role_ids (Safer approach: Rebuild role list from remaining contents)
    let newRoleId = '';
    const allItems = await getShopItems(interaction.guildId, null, 'name', true);
    if (newContents.length > 0) {
      const remainingItems = allItems.filter(i => newContents.includes(i.id));
      const allRoles = new Set();
      remainingItems.forEach(i => {
        if (i.role_id) {
          i.role_id.split(/[,\s]+/).forEach(r => allRoles.add(r));
        }
      });
      newRoleId = Array.from(allRoles).join(' ');
    }

    const itemObj = allItems.find(i => i.id === itemId);
    const packObj = await getShopItem(packId, interaction.guildId);
    const removedItemName = itemObj ? itemObj.name : 'Item';
    const packName = packObj ? packObj.name : 'Pack';

    // EXECUTE UPDATE
    await updateShopItem(packId, { contents: newContents, role_id: newRoleId });

    // Standardized Shop Admin Log
    sendLog(interaction.guild, 'shop', 'red', '📦 Item Removed from Pack', `Admin **<@${interaction.user.id}>** removed item **${removedItemName}** from pack **${packName}**`);

    // --- Persistent Menu Logic ---

    // 3. Fetch remaining pack items
    const remainingPackItems = allItems.filter(i => newContents.includes(i.id));

    const rowBack = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`shop_pack_manage_${packId}`)
        .setLabel('Back')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary)
    );

    if (remainingPackItems.length === 0) {
      await interaction.editReply({
        content: `✅ **${removedItemName}** removed from **${packName}**.\n\n❌ Pack is now empty.`,
        components: [rowBack],
        embeds: []
      });
    } else {
      const options = remainingPackItems.slice(0, 25).map(i => ({ 
        label: (i.name && i.name.trim().length > 0) ? i.name.slice(0, 80) : `Unnamed Item #${i.id}`, 
        value: i.id.toString(),
        description: `${i.price.toLocaleString()} coins`
      }));

      const select = new StringSelectMenuBuilder()
        .setCustomId(`shop_pack_remove_content_select_${packId}`)
        .setPlaceholder('Select Item to Remove from Pack')
        .addOptions(options);

      const row = new ActionRowBuilder().addComponents(select);

      await interaction.editReply({
        content: `✅ **${removedItemName}** removed from **${packName}**.\nChoose another item to remove:`,
        components: [row, rowBack],
        embeds: []
      });
    }
  } catch (error) {
    console.error('[System] ❌ Error in handlePackRemoveContentSelect:', error);
    if (!interaction.replied) await interaction.followUp({ content: '❌ Failed to remove item from pack.', flags: MessageFlags.Ephemeral });
  }
}


