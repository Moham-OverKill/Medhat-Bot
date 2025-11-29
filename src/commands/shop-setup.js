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
  StringSelectMenuBuilder
} from 'discord.js';
import { sanitizeError } from '../shared.js';
import { createErrorEmbed, createSuccessEmbed, handleInteractionError } from '../utils/errors.js';
import { query } from '../storage/postgres.js';

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

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    
    const guildId = interaction.guildId;
    
    // Get shop statistics
    const categoriesResult = await query(
      'SELECT COUNT(*) as count FROM shop_categories WHERE guild_id = $1',
      [guildId]
    );
    const itemsResult = await query(
      'SELECT COUNT(*) as count FROM shop_items WHERE guild_id = $1 AND is_active = true',
      [guildId]
    );
    
    const categoriesCount = parseInt(categoriesResult.rows[0].count);
    const itemsCount = parseInt(itemsResult.rows[0].count);
    
    const embed = new EmbedBuilder()
      .setColor('#9B59B6')
      .setTitle('🏪 Shop Management Panel')
      .setDescription('Manage categories and items in your server shop.')
      .addFields(
        { name: '📂 Categories', value: `${categoriesCount}`, inline: true },
        { name: '🎭 Items', value: `${itemsCount}`, inline: true }
      )
      .setFooter({ text: 'Use the buttons below to manage your shop' })
      .setTimestamp();
    
    const row1 = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('shop_add_category')
          .setLabel('Add Category')
          .setEmoji('📂')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('shop_remove_category')
          .setLabel('Remove Category')
          .setEmoji('🗑️')
          .setStyle(ButtonStyle.Danger)
      );
    
    const row2 = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('shop_add_item')
          .setLabel('Add Item (Role)')
          .setEmoji('🎭')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('shop_remove_item')
          .setLabel('Remove Item')
          .setEmoji('❌')
          .setStyle(ButtonStyle.Danger)
      );
    
    const row3 = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('shop_list_items')
          .setLabel('List All Items')
          .setEmoji('📋')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('shop_refresh_roles')
          .setLabel('Refresh Roles')
          .setEmoji('🔄')
          .setStyle(ButtonStyle.Secondary)
      );
    
    await interaction.editReply({ embeds: [embed], components: [row1, row2, row3] });
  } catch (error) {
    await handleInteractionError(interaction, error, 'shop setup');
  }
}

/**
 * Handle Add Category button
 */
export async function handleAddCategory(interaction) {
  try {
    const modal = new ModalBuilder()
      .setCustomId('shop_add_category_modal')
      .setTitle('Add New Category');
    
    const nameInput = new TextInputBuilder()
      .setCustomId('category_name')
      .setLabel('Category Name')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('e.g., Color Roles, VIP Perks')
      .setRequired(true)
      .setMaxLength(50);
    
    const descInput = new TextInputBuilder()
      .setCustomId('category_description')
      .setLabel('Description (Optional)')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('Brief description of this category')
      .setRequired(false)
      .setMaxLength(200);
    
    modal.addComponents(
      new ActionRowBuilder().addComponents(nameInput),
      new ActionRowBuilder().addComponents(descInput)
    );
    
    await interaction.showModal(modal);
  } catch (error) {
    console.error('Error showing add category modal:', sanitizeError(error));
  }
}

/**
 * Handle Add Category modal submission
 */
export async function handleAddCategoryModal(interaction) {
  try {
    await interaction.deferUpdate();
    
    const name = interaction.fields.getTextInputValue('category_name').trim();
    const description = interaction.fields.getTextInputValue('category_description').trim() || null;
    const guildId = interaction.guildId;
    
    // Check if category already exists
    const existingResult = await query(
      'SELECT id FROM shop_categories WHERE guild_id = $1 AND LOWER(name) = LOWER($2)',
      [guildId, name]
    );
    
    if (existingResult.rows.length > 0) {
      const embed = createErrorEmbed(
        'Category Exists',
        `A category named "${name}" already exists.`
      );
      return interaction.editReply({ embeds: [embed], components: [] });
    }
    
    // Insert new category
    const result = await query(
      `INSERT INTO shop_categories (guild_id, name, description, display_order)
       VALUES ($1, $2, $3, (SELECT COALESCE(MAX(display_order), 0) + 1 FROM shop_categories WHERE guild_id = $1))
       RETURNING *`,
      [guildId, name, description]
    );
    
    const embed = createSuccessEmbed(
      'Category Added',
      `Successfully created category: **${name}**`
    );
    
    if (description) {
      embed.addFields({ name: 'Description', value: description });
    }
    
    await interaction.editReply({ embeds: [embed], components: [] });
    
    // Return to main panel after 3 seconds
    setTimeout(async () => {
      try {
        await handleShopSetup(interaction);
      } catch (e) {
        // Ignore if interaction expired
      }
    }, 3000);
  } catch (error) {
    console.error('Error adding category:', sanitizeError(error));
    const embed = createErrorEmbed('Error', 'Failed to add category. Please try again.');
    await interaction.editReply({ embeds: [embed], components: [] });
  }
}

/**
 * Handle Remove Category button
 */
export async function handleRemoveCategory(interaction) {
  try {
    await interaction.deferUpdate();
    
    const guildId = interaction.guildId;
    
    // Get all categories
    const result = await query(
      'SELECT * FROM shop_categories WHERE guild_id = $1 ORDER BY display_order, name',
      [guildId]
    );
    
    if (result.rows.length === 0) {
      const embed = createErrorEmbed(
        'No Categories',
        'There are no categories to remove.'
      );
      return interaction.editReply({ embeds: [embed], components: [] });
    }
    
    const options = result.rows.map(cat => ({
      label: cat.name,
      value: cat.id.toString(),
      description: cat.description ? cat.description.substring(0, 100) : 'No description'
    }));
    
    const embed = new EmbedBuilder()
      .setColor('#FFA500')
      .setTitle('🗑️ Remove Category')
      .setDescription('Select a category to remove. **Warning:** This will also remove all items in this category!');
    
    const row = new ActionRowBuilder()
      .addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('shop_remove_category_select')
          .setPlaceholder('Select category to remove')
          .addOptions(options)
      );
    
    const backRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('shop_back_to_main')
          .setLabel('Back')
          .setEmoji('◀️')
          .setStyle(ButtonStyle.Secondary)
      );
    
    await interaction.editReply({ embeds: [embed], components: [row, backRow] });
  } catch (error) {
    await handleInteractionError(interaction, error, 'remove category');
  }
}

/**
 * Handle category removal selection
 */
export async function handleRemoveCategorySelect(interaction) {
  try {
    await interaction.deferUpdate();
    
    const categoryId = parseInt(interaction.values[0]);
    
    // Get category info
    const catResult = await query(
      'SELECT * FROM shop_categories WHERE id = $1',
      [categoryId]
    );
    
    if (catResult.rows.length === 0) {
      const embed = createErrorEmbed('Error', 'Category not found.');
      return interaction.editReply({ embeds: [embed], components: [] });
    }
    
    const category = catResult.rows[0];
    
    // Count items in category
    const itemsResult = await query(
      'SELECT COUNT(*) as count FROM shop_items WHERE category_id = $1',
      [categoryId]
    );
    
    const itemCount = parseInt(itemsResult.rows[0].count);
    
    // Delete category (CASCADE will delete items)
    await query('DELETE FROM shop_categories WHERE id = $1', [categoryId]);
    
    const embed = createSuccessEmbed(
      'Category Removed',
      `Deleted category: **${category.name}**\n\n${itemCount} item(s) were also removed from the shop (server roles remain intact).`
    );
    
    await interaction.editReply({ embeds: [embed], components: [] });
    
    // Return to main panel
    setTimeout(async () => {
      try {
        await handleShopSetup(interaction);
      } catch (e) {
        // Ignore
      }
    }, 3000);
  } catch (error) {
    await handleInteractionError(interaction, error, 'remove category select');
  }
}

/**
 * Handle Add Item button
 */
export async function handleAddItem(interaction) {
  try {
    await interaction.deferUpdate();
    
    const guildId = interaction.guildId;
    
    // Check if there are categories
    const categoriesResult = await query(
      'SELECT * FROM shop_categories WHERE guild_id = $1 ORDER BY display_order, name',
      [guildId]
    );
    
    if (categoriesResult.rows.length === 0) {
      const embed = createErrorEmbed(
        'No Categories',
        'You need to create at least one category before adding items.'
      );
      return interaction.editReply({ embeds: [embed], components: [] });
    }
    
    // Get server roles
    const roles = await interaction.guild.roles.fetch();
    const roleOptions = roles
      .filter(role => !role.managed && role.id !== interaction.guildId) // Exclude @everyone and managed roles
      .sort((a, b) => b.position - a.position)
      .map(role => ({
        label: role.name.substring(0, 100),
        value: role.id,
        description: `Position: ${role.position}`
      }))
      .slice(0, 25); // Discord limit
    
    if (roleOptions.length === 0) {
      const embed = createErrorEmbed(
        'No Roles Available',
        'There are no assignable roles in this server.'
      );
      return interaction.editReply({ embeds: [embed], components: [] });
    }
    
    const embed = new EmbedBuilder()
      .setColor('#00FF00')
      .setTitle('🎭 Add Item (Role)')
      .setDescription('Step 1: Select the role you want to add to the shop.');
    
    const row = new ActionRowBuilder()
      .addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('shop_add_item_role_select')
          .setPlaceholder('Select a role')
          .addOptions(roleOptions)
      );
    
    const backRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('shop_back_to_main')
          .setLabel('Back')
          .setEmoji('◀️')
          .setStyle(ButtonStyle.Secondary)
      );
    
    await interaction.editReply({ embeds: [embed], components: [row, backRow] });
  } catch (error) {
    await handleInteractionError(interaction, error, 'add item');
  }
}

/**
 * Handle role selection for new item
 */
export async function handleAddItemRoleSelect(interaction) {
  try {
    const roleId = interaction.values[0];
    const role = await interaction.guild.roles.fetch(roleId);
    
    if (!role) {
      const embed = createErrorEmbed('Error', 'Role not found. Please try again.');
      return interaction.update({ embeds: [embed], components: [] });
    }
    
    // Show modal for item details
    const modal = new ModalBuilder()
      .setCustomId(`shop_add_item_modal_${roleId}`)
      .setTitle(`Add Item: ${role.name.substring(0, 40)}`);
    
    const nameInput = new TextInputBuilder()
      .setCustomId('item_name')
      .setLabel('Item Name')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('Leave empty to use role name')
      .setRequired(false)
      .setMaxLength(100);
    
    const priceInput = new TextInputBuilder()
      .setCustomId('item_price')
      .setLabel('Price (OK Coins)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('e.g., 1000')
      .setRequired(true);
    
    const descInput = new TextInputBuilder()
      .setCustomId('item_description')
      .setLabel('Description')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('Describe what this role provides')
      .setRequired(false)
      .setMaxLength(500);
    
    modal.addComponents(
      new ActionRowBuilder().addComponents(nameInput),
      new ActionRowBuilder().addComponents(priceInput),
      new ActionRowBuilder().addComponents(descInput)
    );
    
    await interaction.showModal(modal);
  } catch (error) {
    console.error('Error in role select:', sanitizeError(error));
  }
}

/**
 * Handle Add Item modal submission
 */
export async function handleAddItemModal(interaction) {
  try {
    await interaction.deferUpdate();
    
    // Extract role ID from custom ID
    const roleId = interaction.customId.split('_').pop();
    const role = await interaction.guild.roles.fetch(roleId);
    
    if (!role) {
      const embed = createErrorEmbed('Error', 'Role no longer exists.');
      return interaction.editReply({ embeds: [embed], components: [] });
    }
    
    const itemName = interaction.fields.getTextInputValue('item_name').trim() || role.name;
    const priceStr = interaction.fields.getTextInputValue('item_price').trim();
    const description = interaction.fields.getTextInputValue('item_description').trim() || null;
    
    const price = parseInt(priceStr);
    if (isNaN(price) || price < 1) {
      const embed = createErrorEmbed('Invalid Price', 'Please enter a valid positive number for the price.');
      return interaction.editReply({ embeds: [embed], components: [] });
    }
    
    const guildId = interaction.guildId;
    
    // Get categories for selection
    const categoriesResult = await query(
      'SELECT * FROM shop_categories WHERE guild_id = $1 ORDER BY display_order, name',
      [guildId]
    );
    
    if (categoriesResult.rows.length === 0) {
      const embed = createErrorEmbed('No Categories', 'Please create a category first.');
      return interaction.editReply({ embeds: [embed], components: [] });
    }
    
    const options = categoriesResult.rows.map(cat => ({
      label: cat.name,
      value: cat.id.toString(),
      description: cat.description ? cat.description.substring(0, 100) : 'No description'
    }));
    
    const embed = new EmbedBuilder()
      .setColor('#00FF00')
      .setTitle('🎭 Add Item (Role)')
      .setDescription(`Step 2: Select a category for **${itemName}**`)
      .addFields(
        { name: 'Role', value: role.name, inline: true },
        { name: 'Price', value: `${price.toLocaleString()} 🪙`, inline: true }
      );
    
    if (description) {
      embed.addFields({ name: 'Description', value: description });
    }
    
    const row = new ActionRowBuilder()
      .addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`shop_add_item_category_${roleId}_${price}_${Buffer.from(itemName).toString('base64url')}`)
          .setPlaceholder('Select category')
          .addOptions(options)
      );
    
    const backRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('shop_back_to_main')
          .setLabel('Cancel')
          .setEmoji('❌')
          .setStyle(ButtonStyle.Secondary)
      );
    
    // Store description temporarily in interaction message
    interaction.client.shopTempData = interaction.client.shopTempData || {};
    interaction.client.shopTempData[interaction.user.id] = { description };
    
    await interaction.editReply({ embeds: [embed], components: [row, backRow] });
  } catch (error) {
    await handleInteractionError(interaction, error, 'add item modal');
  }
}

/**
 * Handle category selection for new item (final step)
 */
export async function handleAddItemCategorySelect(interaction) {
  try {
    await interaction.deferUpdate();
    
    const categoryId = parseInt(interaction.values[0]);
    
    // Parse custom ID: shop_add_item_category_{roleId}_{price}_{base64name}
    const parts = interaction.customId.split('_');
    const roleId = parts[4];
    const price = parseInt(parts[5]);
    const itemNameBase64 = parts.slice(6).join('_');
    const itemName = Buffer.from(itemNameBase64, 'base64url').toString();
    
    // Get description from temp storage
    const tempData = interaction.client.shopTempData?.[interaction.user.id] || {};
    const description = tempData.description || null;
    
    const guildId = interaction.guildId;
    const role = await interaction.guild.roles.fetch(roleId);
    
    if (!role) {
      const embed = createErrorEmbed('Error', 'Role no longer exists.');
      return interaction.editReply({ embeds: [embed], components: [] });
    }
    
    // Insert item into database
    const result = await query(
      `INSERT INTO shop_items (guild_id, category_id, role_id, name, description, price, item_type)
       VALUES ($1, $2, $3, $4, $5, $6, 'role')
       RETURNING *`,
      [guildId, categoryId, roleId, itemName, description, price]
    );
    
    // Clean up temp data
    if (interaction.client.shopTempData?.[interaction.user.id]) {
      delete interaction.client.shopTempData[interaction.user.id];
    }
    
    const embed = createSuccessEmbed(
      'Item Added',
      `Successfully added **${itemName}** to the shop!`
    )
      .addFields(
        { name: 'Role', value: role.name, inline: true },
        { name: 'Price', value: `${price.toLocaleString()} 🪙`, inline: true }
      );
    
    if (description) {
      embed.addFields({ name: 'Description', value: description });
    }
    
    await interaction.editReply({ embeds: [embed], components: [] });
    
    // Return to main panel
    setTimeout(async () => {
      try {
        await handleShopSetup(interaction);
      } catch (e) {
        // Ignore
      }
    }, 3000);
  } catch (error) {
    await handleInteractionError(interaction, error, 'add item category select');
  }
}

/**
 * Handle Remove Item button
 */
export async function handleRemoveItem(interaction) {
  try {
    await interaction.deferUpdate();
    
    const guildId = interaction.guildId;
    
    // Get all items with categories
    const result = await query(
      `SELECT si.*, sc.name as category_name 
       FROM shop_items si
       LEFT JOIN shop_categories sc ON si.category_id = sc.id
       WHERE si.guild_id = $1 AND si.is_active = true
       ORDER BY sc.display_order, sc.name, si.name`,
      [guildId]
    );
    
    if (result.rows.length === 0) {
      const embed = createErrorEmbed(
        'No Items',
        'There are no items in the shop to remove.'
      );
      return interaction.editReply({ embeds: [embed], components: [] });
    }
    
    const options = result.rows.map(item => ({
      label: item.name.substring(0, 100),
      value: item.id.toString(),
      description: `${item.category_name || 'No category'} - ${item.price} 🪙`,
      emoji: '🎭'
    })).slice(0, 25); // Discord limit
    
    const embed = new EmbedBuilder()
      .setColor('#FF0000')
      .setTitle('❌ Remove Item')
      .setDescription('Select an item to remove. **Note:** The server role will NOT be deleted.');
    
    const row = new ActionRowBuilder()
      .addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('shop_remove_item_select')
          .setPlaceholder('Select item to remove')
          .addOptions(options)
      );
    
    const backRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('shop_back_to_main')
          .setLabel('Back')
          .setEmoji('◀️')
          .setStyle(ButtonStyle.Secondary)
      );
    
    await interaction.editReply({ embeds: [embed], components: [row, backRow] });
  } catch (error) {
    await handleInteractionError(interaction, error, 'remove item');
  }
}

/**
 * Handle item removal selection
 */
export async function handleRemoveItemSelect(interaction) {
  try {
    await interaction.deferUpdate();
    
    const itemId = parseInt(interaction.values[0]);
    
    // Get item info
    const itemResult = await query(
      'SELECT * FROM shop_items WHERE id = $1',
      [itemId]
    );
    
    if (itemResult.rows.length === 0) {
      const embed = createErrorEmbed('Error', 'Item not found.');
      return interaction.editReply({ embeds: [embed], components: [] });
    }
    
    const item = itemResult.rows[0];
    
    // Check if role still exists
    const role = await interaction.guild.roles.fetch(item.role_id).catch(() => null);
    const roleStatus = role ? `Role: **${role.name}** (still exists on server)` : '⚠️ Linked role no longer exists on server';
    
    // Delete item (soft delete by setting is_active to false)
    await query('UPDATE shop_items SET is_active = false WHERE id = $1', [itemId]);
    
    const embed = createSuccessEmbed(
      'Item Removed',
      `Removed **${item.name}** from the shop.\n\n${roleStatus}`
    );
    
    await interaction.editReply({ embeds: [embed], components: [] });
    
    // Return to main panel
    setTimeout(async () => {
      try {
        await handleShopSetup(interaction);
      } catch (e) {
        // Ignore
      }
    }, 3000);
  } catch (error) {
    await handleInteractionError(interaction, error, 'remove item select');
  }
}

/**
 * Handle List All Items button
 */
export async function handleListItems(interaction) {
  try {
    await interaction.deferUpdate();
    
    const guildId = interaction.guildId;
    
    // Get all items grouped by category
    const result = await query(
      `SELECT si.*, sc.name as category_name, sc.display_order
       FROM shop_items si
       LEFT JOIN shop_categories sc ON si.category_id = sc.id
       WHERE si.guild_id = $1 AND si.is_active = true
       ORDER BY sc.display_order, sc.name, si.price`,
      [guildId]
    );
    
    if (result.rows.length === 0) {
      const embed = createErrorEmbed(
        'No Items',
        'The shop is currently empty.'
      );
      return interaction.editReply({ embeds: [embed], components: [] });
    }
    
    // Group by category
    const byCategory = {};
    for (const item of result.rows) {
      const catName = item.category_name || 'No Category';
      if (!byCategory[catName]) {
        byCategory[catName] = [];
      }
      byCategory[catName].push(item);
    }
    
    const embed = new EmbedBuilder()
      .setColor('#9B59B6')
      .setTitle('🏪 All Shop Items')
      .setFooter({ text: `Total: ${result.rows.length} items` })
      .setTimestamp();
    
    for (const [catName, items] of Object.entries(byCategory)) {
      let itemsList = '';
      for (const item of items) {
        const role = await interaction.guild.roles.fetch(item.role_id).catch(() => null);
        const roleText = role ? role.name : '⚠️ Role Missing';
        itemsList += `🎭 **${item.name}** - ${item.price.toLocaleString()} 🪙\n   └ ${roleText}\n`;
      }
      embed.addFields({ name: `📂 ${catName}`, value: itemsList || 'Empty', inline: false });
    }
    
    const backRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('shop_back_to_main')
          .setLabel('Back')
          .setEmoji('◀️')
          .setStyle(ButtonStyle.Secondary)
      );
    
    await interaction.editReply({ embeds: [embed], components: [backRow] });
  } catch (error) {
    await handleInteractionError(interaction, error, 'list items');
  }
}

/**
 * Handle Refresh Roles button
 */
export async function handleRefreshRoles(interaction) {
  try {
    await interaction.deferUpdate();
    
    const guildId = interaction.guildId;
    
    // Fetch all roles from Discord
    const roles = await interaction.guild.roles.fetch();
    const roleCount = roles.filter(r => !r.managed && r.id !== guildId).size;
    
    // Check shop items for missing roles
    const itemsResult = await query(
      'SELECT * FROM shop_items WHERE guild_id = $1 AND is_active = true',
      [guildId]
    );
    
    let missingCount = 0;
    const missingItems = [];
    
    for (const item of itemsResult.rows) {
      const role = roles.get(item.role_id);
      if (!role) {
        missingCount++;
        missingItems.push(item);
      }
    }
    
    const embed = new EmbedBuilder()
      .setColor(missingCount > 0 ? '#FFA500' : '#00FF00')
      .setTitle('🔄 Roles Refreshed')
      .setDescription(`Found **${roleCount}** assignable roles in this server.`)
      .addFields(
        { name: '🎭 Shop Items', value: `${itemsResult.rows.length}`, inline: true },
        { name: '⚠️ Missing Roles', value: `${missingCount}`, inline: true }
      );
    
    if (missingCount > 0) {
      let missingList = '';
      for (const item of missingItems.slice(0, 10)) {
        missingList += `• **${item.name}** (ID: ${item.role_id})\n`;
      }
      if (missingItems.length > 10) {
        missingList += `... and ${missingItems.length - 10} more`;
      }
      embed.addFields({ name: 'Items with Missing Roles', value: missingList });
      embed.setFooter({ text: 'Consider removing items with missing roles' });
    }
    
    const backRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('shop_back_to_main')
          .setLabel('Back')
          .setEmoji('◀️')
          .setStyle(ButtonStyle.Secondary)
      );
    
    await interaction.editReply({ embeds: [embed], components: [backRow] });
  } catch (error) {
    await handleInteractionError(interaction, error, 'refresh roles');
  }
}

/**
 * Handle Back to Main button
 */
export async function handleBackToMain(interaction) {
  await handleShopSetup(interaction);
}
