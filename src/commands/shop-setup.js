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
import { handleInteractionError } from '../utils/errors.js';
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
  getItemImage,
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

// Temporary storage for edit/delete flows to isolate state from Post flow.
// (User ID -> action: 'edit_item' | 'edit_pack' | 'delete_item' | 'delete_pack')
export const pendingAdminBrowser = new Map();

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
          return interaction.followUp({ content: "❌ Server Booster Role can't be a shop item. Enter it in the Required Items field instead to make Boosters only items.", flags: MessageFlags.Ephemeral });
        }

        // Block MVP Role as main Item Role
        const { getGuildConfig } = await import('../storage/config.js');
        const guildConfig = await getGuildConfig(interaction.guildId);
        if (guildConfig && guildConfig.mvpRoleId === roleId) {
          return interaction.followUp({ content: "❌ MVP Role can't be a shop item. Enter it in the Required Items field to make MVP only items.", flags: MessageFlags.Ephemeral });
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

        // Success message formatting
        const successHeader = `✅ **Item Created: ${name}**`;
        let successDescription = `Use the **Post** panel to set a price and publish it.`;
        
        if (reqValidation.hasBooster) {
          successDescription += `\n🚀 **Booster Requirement Linked:** This item will now require an active Server Boost to buy/equip.`;
        }
        if (reqValidation.hasMvp) {
          successDescription += `\n🏆 **MVP Requirement Linked:** This item will now require the user to be the active Server MVP.`;
        }

        sendLog(interaction.guild, 'shop', 'green', '🛍️ Item Created', `Admin **<@${interaction.user.id}>** created item **${name}** (Price: Unset — must be set at post time)`);

        const categories = await getShopCategories(interaction.guildId);
        const catOptions = [
          { label: '🏷️ No Category', value: 'null' }, 
          ...categories.slice(0, 24).map(c => ({ 
            label: `📂 ${(c.name && c.name.trim().length > 0) ? c.name.slice(0, 70) : `Unnamed Category #${c.id}`}`, 
            value: c.id.toString() 
          }))
        ];

        const select = new StringSelectMenuBuilder()
          .setCustomId(`shop_assign_cat_select_${item.id}`)
          .setPlaceholder('Add to category')
          .addOptions(catOptions);

        const confirmEmbed = new EmbedBuilder()
          .setColor('#2ECC71')
          .setTitle('Item Created')
          .setDescription(successDescription);
        
        const img = getItemImage(item);
        if (img) confirmEmbed.setThumbnail(img);

        const rowSelect = new ActionRowBuilder().addComponents(select);
        const rowBack = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('shop_admin_add')
            .setLabel('Back')
            .setEmoji('⬅️')
            .setStyle(ButtonStyle.Secondary)
        );

        await interaction.editReply({ 
          content: successHeader, 
          embeds: [confirmEmbed], 
          components: [rowSelect, rowBack] 
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
          } else {
            updates.default_image_url = rawImg;
          }
        } catch (e) { /* field may be absent */ }

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
  if (selectedItem) {
    const previewImg = getItemImage(selectedItem);
    if (previewImg) embed.setThumbnail(previewImg);
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
  
  let itemOptions = [];
  let placeholder = '📦 Select Item/Pack (Required)';

  if (!state.isEditing) {
    if (state.postStep === 0) {
      const hasCategorized = itemsAll.some(i => i.category_id && !i.is_pack && i.item_type !== 'pack');
      const hasUncategorized = itemsAll.some(i => !i.category_id && !i.is_pack && i.item_type !== 'pack');
      const hasPacks = itemsAll.some(i => i.is_pack || i.item_type === 'pack');

      if (hasCategorized) itemOptions.push({ label: '📂 Categorized Items', value: 'folder_categorized' });
      if (hasUncategorized) itemOptions.push({ label: '📂 Uncategorized Items', value: 'folder_standalone' });
      if (hasPacks) itemOptions.push({ label: '📦 Item Packs', value: 'folder_packs' });
      placeholder = '📦 Select Item/Pack (Required)';
      
      // If an item is already selected, show it as a quick-pick at the top
      if (selectedItem) {
        itemOptions.unshift({
          label: `✅ Staged: ${selectedItem.name.slice(0, 50)}`,
          value: selectedItem.id.toString(),
          default: true
        });
      }
    } 
    else if (state.postStep === 1) {
      // Category Folder List - Hide Empty Folders
      const usedCategoryIds = new Set(itemsAll.filter(i => !i.is_pack && i.item_type !== 'pack' && i.category_id).map(i => i.category_id));
      const activeCategories = categories.filter(c => usedCategoryIds.has(c.id));

      itemOptions = activeCategories.map(c => ({
        label: `📂 ${c.name.slice(0, 50)}`,
        value: `filter_cat_${c.id}`
      }));
      itemOptions.unshift({ label: '⬅️ Back', value: 'folder_reset' });
      placeholder = '📂 Choose Category Folder...';
    } 
    else if (state.postStep === 2) {
      // Final Item List (Filtered)
      let filtered = [];
      let groupPrefix = '🏷️';
      let groupName = 'Items';

      if (state.postFilter === 'standalone') {
        filtered = itemsAll.filter(i => !i.category_id && !i.is_pack);
        groupName = 'Uncategorized';
        groupPrefix = '🏷️';
      } else if (state.postFilter === 'packs') {
        filtered = itemsAll.filter(i => i.is_pack);
        groupName = 'Packs';
        groupPrefix = '📦';
      } else if (state.postFilter?.startsWith('cat_')) {
        const catId = parseInt(state.postFilter.split('_').pop());
        filtered = itemsAll.filter(i => i.category_id === catId);
        groupName = categories.find(c => c.id === catId)?.name || 'Category';
        groupPrefix = '🏷️';
      }

      itemOptions = filtered.slice(0, 24).map(i => {
        return {
          label: `${groupPrefix} ${i.name.slice(0, 75)}`,
          value: i.id.toString(),
          default: state.itemId === i.id.toString()
        };
      });

      itemOptions.unshift({ label: '⬅️ Back', value: 'folder_reset' });
      placeholder = `${groupPrefix} ${groupName.slice(0, 20)}: Pick one`;
    }

    // Unified Empty State Fallback
    if (itemOptions.length === 0 || (itemOptions.length === 1 && itemOptions[0].value === 'folder_reset')) {
      const emptyRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('shop_post_start').setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary)
      );
      const emptyEmbed = new EmbedBuilder().setColor('#95A5A6').setDescription('No items found.');
      return interaction.editReply({ content: null, embeds: [emptyEmbed], components: [emptyRow] });
    }
  }

  const itemSelect = !state.isEditing ? new StringSelectMenuBuilder()
    .setCustomId('shop_post_item_select')
    .setPlaceholder(placeholder)
    .addOptions(itemOptions) : null;

  // Row 2: Channel Select
  const channelSelect = !state.isEditing ? new ChannelSelectMenuBuilder()
    .setCustomId('shop_post_channel_select')
    .setPlaceholder('🏪 Select Channel (Required)')
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement) : null;
  if (!state.isEditing && state.channelId) channelSelect.setDefaultChannels([state.channelId]);

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
      .setStyle(state.overridePrice !== null ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(!isItemSelected)
  );

  // Row 5: Action Buttons (4 buttons)
  const actionComponents = [];
  actionComponents.push(
    new ButtonBuilder()
      .setCustomId(state.isEditing ? 'shop_admin_post' : 'shop_admin_home')
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
      .setStyle((state.stock !== null || state.stockConfigured) ? ButtonStyle.Primary : ButtonStyle.Secondary)
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
    components: components
  });
}

// Handle Item Selection in Staging Panel
export async function handleShopPostItemSelect(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
  const userId = interaction.user.id;
  const itemId = interaction.values[0];
  let state = pendingPosts.get(userId) || { itemId: null, channelId: null, sellerId: null, imageUrl: null, description: null, payout: null, postStep: 0, postFilter: null };

  // --- Navigation Routing ---
  if (itemId === 'folder_reset') {
    state.postStep = 0;
    state.postFilter = null;
  } else if (itemId === 'folder_categorized') {
    state.postStep = 1;
    state.postFilter = null;
  } else if (itemId === 'folder_standalone') {
    state.postStep = 2;
    state.postFilter = 'standalone';
  } else if (itemId === 'folder_packs') {
    state.postStep = 2;
    state.postFilter = 'packs';
  } else if (itemId.startsWith('filter_cat_')) {
    state.postStep = 2;
    state.postFilter = itemId.replace('filter_', '');
  } else {
    // Final Item Selection
    state.itemId = itemId;
    state.overridePrice = null;
    state.postStep = 0; // Return to root after selection
    
    const items = await getShopItems(interaction.guildId, null, 'name', true);
    const selectedItem = items.find(i => i.id === parseInt(itemId));

    // Check if selected item is a pack - if so, reset seller/payout (packs are server-only)
    if (selectedItem && selectedItem.item_type === 'pack') {
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

  let state = pendingPosts.get(userId) || { itemId: null, channelId: null, sellerId: null, imageUrl: null };
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

  let state = pendingPosts.get(userId) || { itemId: null, channelId: null, sellerId: null, imageUrl: null, description: null, payout: null };

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
    .setCustomId('shop_post_desc_modal')
    .setTitle('Item Description');

  const descInput = new TextInputBuilder()
    .setCustomId('description')
    .setLabel('Description')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('A very cool item that makes you look even cooler!')
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
    .setTitle('Item Price');

  const priceInput = new TextInputBuilder()
    .setCustomId('price_input')
    .setLabel('Price')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('0000')
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
      .setCustomId('shop_post_payout_modal')
      .setTitle('Seller Payout');

    const payoutInput = new TextInputBuilder()
      .setCustomId('payout')
      .setLabel('Payout (Per purchase)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('0000')
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
    .setCustomId('shop_post_stock_modal')
    .setTitle('Item Stocks');

  const stockInput = new TextInputBuilder()
    .setCustomId('stock')
    .setLabel('Stocks')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('0000')
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
    pendingPosts.set(interaction.user.id, state);
  }
  await handleShopPostStart(interaction);
}

// Handle Image URL Button - Show Modal
export async function handleShopPostImageBtn(interaction) {
  const state = pendingPosts.get(interaction.user.id) || {};

  const modal = new ModalBuilder()
    .setCustomId('shop_post_image_modal')
    .setTitle('Item Image');

  const urlInput = new TextInputBuilder()
    .setCustomId('image_url')
    .setLabel('Image URL (Leave empty to use default)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('https://example.com/image.png')
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

    await channel.send({ embeds: [embed], components: [row] });

    // Standardized Shop Admin Log
    sendLog(interaction.guild, 'shop', 'blue', '📢 Shop Post Created', `Admin **<@${interaction.user.id}>** posted **${item.name}** to <#${channelId}>`);

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
    await handleInteractionError(interaction, error, 'shop post publish');
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

export async function handleEditCategoryStart(interaction) {
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

    const select = new StringSelectMenuBuilder()
      .setCustomId('shop_select_cat_edit_rename')
      .setPlaceholder('Select')
      .addOptions(categories.map(c => ({ 
        label: `📂 ${(c.name && c.name.trim().length > 0) ? c.name.slice(0, 70) : `Unnamed Category #${c.id}`}`, 
        value: c.id.toString() 
      })));

    const embed = new EmbedBuilder()
      .setColor('#3498DB')
      .setTitle('📂 Category Management')
      .setDescription('**Select a category to manage:**');

    const row = new ActionRowBuilder().addComponents(select);

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

export async function handleEditCategoryAddItemsStart(interaction) {
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

    const select = new StringSelectMenuBuilder()
      .setCustomId(`shop_edit_cat_add_select_${categoryId}`)
      .setPlaceholder('Select')
      .addOptions(standalone.slice(0, 25).map(i => ({ 
        label: `🏷️ ${(i.name && i.name.trim().length > 0) ? i.name.slice(0, 70) : `Unnamed Item #${i.id}`}`, 
        value: i.id.toString() 
      })));

    const row = new ActionRowBuilder().addComponents(select);

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
      const select = new StringSelectMenuBuilder()
        .setCustomId(`shop_edit_cat_add_select_${categoryId}`)
        .setPlaceholder('Select')
        .addOptions(standalone.slice(0, 25).map(i => ({ 
          label: `🏷️ ${(i.name && i.name.trim().length > 0) ? i.name.slice(0, 70) : `Unnamed Item #${i.id}`}`, 
          value: i.id.toString()
        })));

      const row = new ActionRowBuilder().addComponents(select);

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

export async function handleEditCategoryRemoveItemsStart(interaction, successHeader = null) {
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

    const select = new StringSelectMenuBuilder()
      .setCustomId(`shop_edit_cat_remove_select_${categoryId}`)
      .setPlaceholder('Select')
      .addOptions(items.slice(0, 25).map(i => ({ 
        label: `🏷️ ${(i.name && i.name.trim().length > 0) ? i.name.slice(0, 70) : `Unnamed Item #${i.id}`}`, 
        value: i.id.toString() 
      })));

    const row = new ActionRowBuilder().addComponents(select);

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
      const select = new StringSelectMenuBuilder()
        .setCustomId(`shop_edit_cat_remove_select_${categoryId}`)
        .setPlaceholder('Select')
        .addOptions(items.slice(0, 25).map(i => ({ 
          label: (i.name && i.name.trim().length > 0) ? i.name.slice(0, 80) : `Unnamed Item #${i.id}`, 
          value: i.id.toString()
        })));

      const row = new ActionRowBuilder().addComponents(select);

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

export async function handleDeleteCategoryStart(interaction) {
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

    const select = new StringSelectMenuBuilder()
      .setCustomId('shop_select_cat_delete_confirm')
      .setPlaceholder('Select')
      .addOptions(categories.map(c => ({ 
        label: `📂 ${(c.name && c.name.trim().length > 0) ? c.name.slice(0, 70) : `Unnamed Category #${c.id}`}`, 
        value: c.id.toString() 
      })));

    const embed = new EmbedBuilder()
      .setColor('#E74C3C')
      .setTitle('🗑️ Delete Category')
      .setDescription('**Select a category to delete:**');

    const row = new ActionRowBuilder().addComponents(select);

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
    const backRoute = isEdit ? 'shop_admin_edit' : 'shop_admin_delete';
    
    const rowBack = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(backRoute).setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary)
    );

    // Dynamic Title
    let titleText = '';
    if (isItem) {
       titleText = folder === 'browse_categories' ? 'Select a category to browse' : `Select an item to ${isEdit ? 'edit' : 'delete'}`;
    } else {
       titleText = `Select a pack to ${isEdit ? 'edit' : 'delete'}`;
    }

    // Standardized Embed Style
    const embed = new EmbedBuilder()
      .setColor(isEdit ? '#3498DB' : '#E74C3C')
      .setTitle(titleText);

    // Fetch items mapping to current folder (if item mode) or just list packs (if pack mode)
    if (isItem) {
      const items = await getShopItems(interaction.guildId, null, 'name', true);
      const singleItems = items.filter(i => !i.is_pack && i.item_type !== 'pack');

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
            label: '📂 Categorized Items', 
            value: 'action_browse_categorized'
          });
        }
        if (hasUncategorized) {
          options.push({ 
            label: '🏷️ Uncategorized Items', 
            value: 'cat_null'
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

        const options = activeCategories.slice(0, 24).map(cat => {
          return { 
            label: `📂 ${cat.name || `Category #${cat.id}`}`.slice(0, 100), 
            value: `cat_${cat.id}`
          };
        });

        const select = new StringSelectMenuBuilder()
          .setCustomId('shop_admin_browser_select')
          .setPlaceholder('Select')
          .addOptions([
            { label: '⬅️ Back', value: 'action_back_root' },
            ...options
          ]);



        return interaction.editReply({
          content: (message && (message.startsWith('✅') || message.startsWith('❌'))) ? message : null,
          components: [new ActionRowBuilder().addComponents(select), rowBack],
          embeds: [embed]
        });
      }

      // 3. ITEM VIEW - List items inside a specific Category or Uncategorized
      const targetCategoryId = folder === 'cat_null' ? null : parseInt(folder.replace('cat_', ''), 10);
      const folderItems = singleItems.filter(i => i.category_id === targetCategoryId);

      if (folderItems.length === 0) {
         pendingAdminBrowser.set(interaction.user.id, { ...contextMap, folder: 'root' });
         return renderAdminBrowser(interaction, pendingAdminBrowser.get(interaction.user.id));
      }

      const itemOptions = folderItems.slice(0, 24).map(i => ({
        label: `🏷️ ${(i.name && i.name.trim().length > 0 ? i.name : `Unnamed Item #${i.id}`).slice(0, 80)}`,
        value: `item_${i.id}`
      }));

      const backValue = folder === 'cat_null' ? 'action_back_root' : 'action_browse_categorized';

      const select = new StringSelectMenuBuilder()
        .setCustomId('shop_admin_browser_select')
        .setPlaceholder('Select')
        .addOptions([
          { label: '⬅️ Back', value: backValue },
          ...itemOptions
        ]);



      return interaction.editReply({
         content: (message && (message.startsWith('✅') || message.startsWith('❌'))) ? message : null,
         components: [new ActionRowBuilder().addComponents(select), rowBack],
         embeds: [embed]
      });
    }

    // PACKS logic (no categories for packs currently, so they display flat)
    if (!isItem) {
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

        const packOptions = packs.slice(0, 25).map(p => ({
           label: `📦 ${(p.name && p.name.trim().length > 0 ? p.name : `Unnamed Pack #${p.id}`).slice(0, 80)}`,
           value: `item_${p.id}`
        }));

        const select = new StringSelectMenuBuilder()
          .setCustomId('shop_admin_browser_select')
          .setPlaceholder('Select')
          .addOptions(packOptions);



        return interaction.editReply({
          content: (message && (message.startsWith('✅') || message.startsWith('❌'))) ? message : null,
          components: [new ActionRowBuilder().addComponents(select), rowBack],
          embeds: [embed]
        });
    }
  } catch (error) {
     await handleInteractionError(interaction, error, 'admin browser render');
  }
}

export async function handleAdminBrowserSelect(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
  const selection = interaction.values[0];
  const context = pendingAdminBrowser.get(interaction.user.id);
  
  if (!context) {
     return interaction.editReply({ content: '❌ Your session expired. Please start over.', embeds: [], components: [] });
  }

  // Handle navigating back up to the root layer
  if (selection === 'action_back_root') {
     context.folder = 'root';
     context.message = null;
     pendingAdminBrowser.set(interaction.user.id, context);
     return renderAdminBrowser(interaction, context);
  }

  // Handle navigating to the categories list
  if (selection === 'action_browse_categorized') {
     context.folder = 'browse_categories';
     context.message = null;
     pendingAdminBrowser.set(interaction.user.id, context);
     return renderAdminBrowser(interaction, context);
  }

  // Handle drilling into a specific Category folder
  if (selection.startsWith('cat_')) {
      context.folder = selection;
      context.message = null;
      pendingAdminBrowser.set(interaction.user.id, context);
      return renderAdminBrowser(interaction, context);
  }

  // Handle selecting the actual item/pack
  if (selection.startsWith('item_')) {
      const itemId = selection.replace('item_', '');
      
      // Clear the map context *before* passing off the flow
      // since the deep handlers don't know about it.
      const action = context.action;
      pendingAdminBrowser.delete(interaction.user.id);
      
      // Inject the choice into the interaction object so the older handlers pick it up correctly
      interaction.values = [itemId];
      
      // Route it to the original handlers exactly as if they clicked a direct menu in the old system
      if (action === 'edit_item') return handleEditItemSelect(interaction);
      if (action === 'delete_item') return handleDeleteItemSelect(interaction);
      if (action === 'edit_pack') return handleEditPackSelect(interaction);
      if (action === 'delete_pack') return handleDeletePackSelect(interaction);
  }
}

// --- Edit Item Handlers ---

export async function handleEditItemStart(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
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

export async function handleEditItemSelect(interaction, successHeader = null) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => { });
  
  // This might come from a select menu (values[0]) or a button (customId split)
  let itemId;
  if (interaction.isAnySelectMenu()) {
    itemId = interaction.values[0];
  } else {
    itemId = interaction.customId.split('_').pop();
  }

  try {
    const item = await getShopItem(itemId, interaction.guildId);
    if (!item) return interaction.followUp({ content: '❌ Item not found.', flags: MessageFlags.Ephemeral });

    // Ensure we are not editing a pack in the item editor
    if (item.is_pack || item.item_type === 'pack') {
      sysLog('Shop Admin Warning', { guild: interaction.guildId, detail: `Attempted to edit Pack ${item.id} in Item Editor` });
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
      .setDescription(`Role: ${roleMention}\nCategory: ${categoryDisplay}\nIn Packs: ${packCount}\nRequired Items: ${prereqDisplay}`)
      .setColor('#3498DB');

    // Show item image as thumbnail if available
    const itemImg = getItemImage(item);
    if (itemImg) embed.setThumbnail(itemImg);

    const catOptions = [
      { label: '🏷️ No Category', value: 'null' }, 
      ...categories.map(c => ({ 
        label: `📂 ${(c.name && c.name.trim().length > 0) ? c.name.slice(0, 70) : `Unnamed Category #${c.id}`}`, 
        value: c.id.toString(), 
        default: c.id == item.category_id 
      }))
    ];

    const catSelect = new StringSelectMenuBuilder()
      .setCustomId(`shop_assign_cat_select_manage_${itemId}`)
      .setPlaceholder('Select')
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
      content: successHeader || null,
      embeds: [embed],
      components: [rowCat, actionRow, backRow]
    });
  } catch (error) {
    await handleInteractionError(interaction, error, 'edit item select');
  }
}

// Old handleManageItemCategorySelect removed to prevent duplicate declaration
// The active version is defined earlier in the file.

export async function handleEditItemDetails(interaction) {
  try {
    const itemId = interaction.customId.split('_').pop();
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
      .setCustomId(`shop_item_modal_edit_${itemId}_item`)
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
      .setLabel('Required Items (Role IDs)')
      .setStyle(TextInputStyle.Short)
      .setValue(reqPreFill)
      .setRequired(false)
      .setPlaceholder('Separate IDs by "-", "," or space');

    modal.addComponents(
      new ActionRowBuilder().addComponents(nameInput),
      new ActionRowBuilder().addComponents(imageInput),
      new ActionRowBuilder().addComponents(roleInput),
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
    let contentsDisplay = '**None**';
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
        .setCustomId('shop_edit_pack_start')
        .setLabel('Back')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary)
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

    let options = [];

    if (layer === 'root') {
      // --- LAYER 0: ROOT SELECTION ---
      const hasCategorized = availableItems.some(i => i.category_id);
      const hasUncategorized = availableItems.some(i => !i.category_id);
      
      if (hasCategorized) options.push({ label: '📂 Categorized Items', value: 'layer_browse_categorized' });
      if (hasUncategorized) options.push({ label: '📂 Uncategorized Items', value: 'layer_browse_uncategorized' });
    } 
    else if (layer === 'browse_categorized') {
      // --- LAYER 1: CATEGORY LIST ---
      const categories = await getShopCategories(interaction.guildId);
      
      options.push({
        label: '⬅️ Back',
        value: 'action_back_root'
      });

      for (const cat of categories) {
        const itemsInCat = availableItems.filter(i => i.category_id === cat.id);
        if (itemsInCat.length > 0) {
          options.push({
            label: `📂 ${cat.name.slice(0, 70)}`,
            value: `cat_${cat.id}`
          });
        }
      }
    }
    else if (layer === 'browse_uncategorized') {
      // --- LAYER 1: UN-CATEGORIZED ITEMS ---
      const standaloneItems = availableItems.filter(i => !i.category_id);
      
      options.push({
        label: '⬅️ Back',
        value: 'action_back_root'
      });

      options.push(...standaloneItems.slice(0, 24).map(i => ({
        label: `🏷️ ${(i.name && i.name.trim().length > 0) ? i.name.slice(0, 70) : `Unnamed Item #${i.id}`}`, 
        value: `item_${i.id}`
      })));
    }
    else if (typeof layer === 'number' || !isNaN(parseInt(layer))) {
      // --- LAYER 2: ITEMS INSIDE A CATEGORY ---
      const categoryId = parseInt(layer);
      const itemsInCat = availableItems.filter(i => i.category_id === categoryId);
      
      options.push({
        label: '⬅️ Back',
        value: 'layer_browse_categorized'
      });

      options.push(...itemsInCat.slice(0, 24).map(i => ({ 
        label: `🏷️ ${(i.name && i.name.trim().length > 0) ? i.name.slice(0, 70) : `Unnamed Item #${i.id}`}`, 
        value: `item_${i.id}`
      })));
    }

    const rowBack = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`shop_pack_manage_${packId}`)
        .setLabel('Back')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary)
    );

    // Unified Empty State Fallback
    if (options.length === 0 || (options.length === 1 && options[0].value.includes('back'))) {
      const emptyEmbed = new EmbedBuilder().setColor('#95A5A6').setDescription('No items found.');
      return interaction.editReply({ 
        content: (messageStr && (messageStr.startsWith('✅') || messageStr.startsWith('❌'))) ? messageStr : null,
        components: [rowBack], 
        embeds: [emptyEmbed] 
      });
    }

    const select = new StringSelectMenuBuilder()
      .setCustomId(`shop_pack_add_content_select_${packId}`)
      .setPlaceholder('Select')
      .addOptions(options.slice(0, 25));

    const row = new ActionRowBuilder().addComponents(select);

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

export async function handlePackRemoveContentStart(interaction, messageStr = null) {
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

    let options = packItems.slice(0, 25).map(i => ({
      label: `🏷️ ${(i.name && i.name.trim().length > 0) ? i.name.slice(0, 70) : `Unnamed Item #${i.id}`}`, 
      value: `item_${i.id}` 
    }));

    // Add fallback for deleted/missing items
    if (options.length < 25 && packItems.length < contentIds.length) {
      const missingIds = contentIds.filter(id => !packItems.some(i => i.id === id));
      options.push(...missingIds.slice(0, 25 - options.length).map(id => ({ 
        label: `🏷️ Unknown Item ${id} (Deleted?)`, 
        value: `item_${id}` 
      })));
    }

    const select = new StringSelectMenuBuilder()
      .setCustomId(`shop_pack_remove_content_select_${packId}`)
      .setPlaceholder('Select')
      .addOptions(options);

    const row = new ActionRowBuilder().addComponents(select);
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
      stockConfigured: false
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
    // Defer reply for modal submission
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const url = (interaction.fields.getTextInputValue('message_url') || '').trim();

    // Parse URL: https://discord.com/channels/guildId/channelId/messageId
    const match = url.match(/channels\/(\d+)\/(\d+)\/(\d+)/);
    if (!match) {
      return interaction.editReply({ content: '❌ Invalid Message URL. Must be a valid Discord message link.' });
    }

    const [_, guildId, channelId, messageId] = match;

    // Security Gate: Server validation
    if (guildId !== interaction.guildId) {
      return interaction.editReply({ content: '❌ The message URL must belong to this server.' });
    }

    // Fetch Channel & Message
    const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      return interaction.editReply({ content: '❌ Channel not found or inaccessible.' });
    }

    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (!message) {
      return interaction.editReply({ content: '❌ Message not found. Make sure the bot has permission to view it.' });
    }

    // Author verification
    if (message.author.id !== interaction.client.user.id) {
      return interaction.editReply({ content: '❌ That message was not posted by this bot.' });
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
      return interaction.editReply({ content: '❌ No valid shop buy button found in the message components.' });
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
      return interaction.editReply({ content: '❌ The item associated with this post could not be found in the database.' });
    }

    // Extract embed contents
    const firstEmbed = message.embeds[0];
    const description = firstEmbed?.description || null;
    const imageUrl = firstEmbed?.image?.url || null;

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
      stock: null,
      stockConfigured: false, // Must be explicitly set
      isEditing: true,
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
    await message.edit({ embeds: [embed], components: [row] });

    // Log & Cleanup
    sendLog(interaction.guild, 'shop', 'blue', '📝 Shop Post Updated', `Admin **<@${interaction.user.id}>** updated posted item **${item.name}** in <#${channelId}>`);

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



