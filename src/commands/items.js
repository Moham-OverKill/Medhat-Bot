import {
  SlashCommandBuilder,
  MessageFlags,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} from 'discord.js';
import { getShopCategories, getShopItems } from '../economy/shop.js';
import { getLootBoxes, getLootBoxCategoryName, getLootBoxCategoryEmoji } from '../economy/lootbox.js';
import { getItemRarityEmoji, sortItemsByRolePosition, safeSetButtonEmoji } from '../shared.js';
import { handleInteractionError } from '../utils/errors.js';
import { sysError } from '../utils/logger.js';

// --- Command Definition ---
export const itemsCommand = new SlashCommandBuilder()
  .setName('items')
  .setDescription('View all items available in the shop')
  .setDMPermission(false);

/**
 * Builds the embed and component rows for the /items view
 */
async function buildItemsViewData(guild, targetCatId = null, targetPage = 1) {
  const guildId = guild.id;

  // Refresh role cache to ensure live role positions and filter ghost roles
  await guild.roles.fetch().catch(() => {});

  const [categories, rawItems, lootBoxes, lootBoxCatName, lootBoxEmoji] = await Promise.all([
    getShopCategories(guildId),
    getShopItems(guildId, null, 'price', false, false),
    getLootBoxes(guildId),
    getLootBoxCategoryName(guildId),
    getLootBoxCategoryEmoji(guildId)
  ]);

  // Exclude packs (bundles)
  const nonPackItems = rawItems.filter(i => i.item_type !== 'pack' && !i.is_pack);

  // Filter out ghost roles (items with missing Discord roles)
  const standardItems = nonPackItems.filter(i => {
    if (i.item_type === 'loot_box') return false;
    if (i.role_id) {
      const firstRoleId = i.role_id.split(/[,\s]+/)[0];
      if (!guild.roles.cache.has(firstRoleId)) return false;
    }
    return true;
  });

  const lootBoxItems = nonPackItems.filter(i => i.item_type === 'loot_box');

  // Build available categories list
  const availableCategories = [];

  for (const cat of categories) {
    const catItems = standardItems.filter(i => i.category_id === cat.id);
    if (catItems.length > 0) {
      availableCategories.push({
        id: String(cat.id),
        name: cat.name,
        items: catItems,
        isLootBox: false
      });
    }
  }

  // Items without a category
  const otherItems = standardItems.filter(i => i.category_id === null);
  if (otherItems.length > 0) {
    availableCategories.push({
      id: 'null',
      name: 'Other',
      items: otherItems,
      isLootBox: false
    });
  }

  // Loot box items
  if (lootBoxItems.length > 0) {
    availableCategories.push({
      id: 'lootboxes',
      name: lootBoxCatName || 'Loot Boxes',
      emoji: lootBoxEmoji || '🎁',
      items: lootBoxItems,
      isLootBox: true
    });
  }

  if (availableCategories.length === 0) {
    return { empty: true };
  }

  // Determine active category
  let currentCategory = null;
  if (targetCatId !== null && targetCatId !== undefined) {
    currentCategory = availableCategories.find(c => c.id === String(targetCatId));
  }
  if (!currentCategory) {
    currentCategory = availableCategories[0];
  }

  // Sort items in active category
  if (!currentCategory.isLootBox) {
    currentCategory.items = await sortItemsByRolePosition(currentCategory.items, guild);
  }

  // Pagination for items list
  const pageSize = 20;
  const totalPages = Math.max(1, Math.ceil(currentCategory.items.length / pageSize));
  const page = Math.max(1, Math.min(targetPage || 1, totalPages));
  const startIndex = (page - 1) * pageSize;
  const pagedItems = currentCategory.items.slice(startIndex, startIndex + pageSize);

  // Format item lines: rarity emoji followed by role mention only
  const lines = pagedItems.map(item => {
    if (currentCategory.isLootBox) {
      const emoji = lootBoxEmoji || '🎁';
      return `${emoji} **${item.name}**`;
    }
    const rarityEmoji = getItemRarityEmoji(item);
    const firstRoleId = item.role_id ? item.role_id.split(/[,\s]+/)[0] : null;
    if (firstRoleId) {
      return `${rarityEmoji} <@&${firstRoleId}>`;
    }
    return `${rarityEmoji} **${item.name}**`;
  });

  const desc = lines.length > 0 ? lines.join('\n') : '_No items in this category._';

  const embed = new EmbedBuilder()
    .setTitle(`Category: ${currentCategory.name}${totalPages > 1 ? ` (Page ${page}/${totalPages})` : ''}`)
    .setColor('#3498DB')
    .setDescription(desc);

  // Build category buttons (max 4 per row, max 4-5 rows depending on item pagination)
  const CATS_PER_ROW = 4;
  const maxCatRows = totalPages > 1 ? 4 : 5;
  const maxCategories = maxCatRows * CATS_PER_ROW;
  const visibleCategories = availableCategories.slice(0, maxCategories);

  const rows = [];
  for (let i = 0; i < visibleCategories.length; i += CATS_PER_ROW) {
    const chunk = visibleCategories.slice(i, i + CATS_PER_ROW);
    const row = new ActionRowBuilder();
    chunk.forEach(cat => {
      const btn = new ButtonBuilder()
        .setCustomId(`items_cat_${cat.id}`)
        .setLabel(cat.name.slice(0, 80))
        .setStyle(cat.id === currentCategory.id ? ButtonStyle.Primary : ButtonStyle.Secondary);
      if (cat.emoji) {
        safeSetButtonEmoji(btn, cat.emoji, guild, '🎁');
      }
      row.addComponents(btn);
    });
    rows.push(row);
  }

  // Item pagination navigation row
  if (totalPages > 1) {
    const navRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`items_page_${currentCategory.id}_${page - 1}`)
        .setEmoji('◀️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 1),
      new ButtonBuilder()
        .setCustomId('items_page_indicator')
        .setLabel(`${page}/${totalPages}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`items_page_${currentCategory.id}_${page + 1}`)
        .setEmoji('▶️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= totalPages)
    );
    rows.push(navRow);
  }

  return { empty: false, embed, rows };
}

/**
 * Slash command handler for /items
 */
export async function handleItemsCommand(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }

    const result = await buildItemsViewData(interaction.guild, null, 1);

    if (result.empty) {
      return interaction.editReply({
        content: 'There are currently no items available in the shop.',
        embeds: [],
        components: []
      });
    }

    await interaction.editReply({
      content: null,
      embeds: [result.embed],
      components: result.rows
    });
  } catch (error) {
    await handleInteractionError(interaction, error, 'Items command');
  }
}

/**
 * Component handler for category selection and pagination in /items
 */
export async function handleItemsComponent(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate();
    }

    let targetCatId = null;
    let targetPage = 1;

    if (interaction.customId.startsWith('items_cat_')) {
      targetCatId = interaction.customId.replace('items_cat_', '');
      targetPage = 1;
    } else if (interaction.customId.startsWith('items_page_')) {
      const parts = interaction.customId.split('_');
      targetCatId = parts[2];
      targetPage = parseInt(parts[3], 10) || 1;
    }

    const result = await buildItemsViewData(interaction.guild, targetCatId, targetPage);

    if (result.empty) {
      return interaction.editReply({
        content: 'There are currently no items available in the shop.',
        embeds: [],
        components: []
      });
    }

    await interaction.editReply({
      content: null,
      embeds: [result.embed],
      components: result.rows
    });
  } catch (error) {
    sysError('Items component interaction failure', error, {
      user: interaction.user.id,
      guild: interaction.guildId,
      customId: interaction.customId
    });
    try {
      await interaction.editReply({
        content: 'An error occurred while loading items.',
        embeds: [],
        components: []
      });
    } catch (_) {}
  }
}
