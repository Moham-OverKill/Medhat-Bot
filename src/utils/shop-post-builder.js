import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} from 'discord.js';
import { COIN_EMOJI, safeSetButtonEmoji } from '../shared.js';
import { getItemImage } from '../economy/shop.js';
import { getLootBox } from '../economy/lootbox.js';
import { cleanImageUrl } from './embed-sanitizer.js';

/**
 * Resolves the default image for an item, falling back to loot box image if applicable.
 *
 * @param {Object} item
 * @param {string} [guildId]
 * @returns {Promise<string|null>}
 */
export async function resolveItemDefaultImage(item, guildId = null) {
  if (!item) return null;
  let img = getItemImage(item);
  if (!img && (item.item_type === 'loot_box' || item.loot_box_id)) {
    try {
      const box = await getLootBox(item.loot_box_id || item.id, guildId);
      if (box) img = box.image_url || box.opened_image_url;
    } catch (_) {}
  }
  return cleanImageUrl(img);
}

/**
 * Builds the complete Discord message payload ({ embeds, components }) for a posted shop item.
 * Guarantees a fully reconstructed, valid embed and buy/claim button.
 *
 * @param {Object} params
 * @param {Object} params.item - Shop item data (from shop_items / getShopItem)
 * @param {Object} [params.postRow] - Row from shop_posts table
 * @param {string} [params.guildId] - Guild ID
 * @param {string} [params.customDescription] - Optional custom description override
 * @param {string} [params.existingCustomId] - Existing button customId if available
 * @returns {Promise<{ embeds: EmbedBuilder[], components: ActionRowBuilder[] }>}
 */
export async function buildShopPostPayload({
  item,
  postRow = null,
  guildId = null,
  customDescription = null,
  existingCustomId = null
}) {
  const gId = guildId || postRow?.guild_id || item?.guild_id;

  const embed = new EmbedBuilder()
    .setTitle(item.name)
    .setColor('#3498DB');

  // 1. Image resolution
  let imageUrl = postRow?.custom_image_url || null;
  if (!imageUrl) {
    imageUrl = await resolveItemDefaultImage(item, gId);
  }
  if (imageUrl) {
    embed.setImage(imageUrl);
  }

  // 2. Description
  const finalDesc = customDescription || item.description || null;
  if (finalDesc) {
    embed.setDescription(finalDesc);
  }

  // 3. Fields based on item type
  if (item.item_type === 'pack' || item.is_pack) {
    const count = item.contents ? item.contents.length : 0;
    embed.addFields({ name: '📦 Contents', value: `**${count}** Items`, inline: true });
  } else if (item.item_type === 'loot_box' || item.loot_box_id) {
    // Loot box items do not display Item or Duration fields
  } else {
    // Single Item
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

  // 4. Stock & Countdown calculation
  const effectiveStock = (postRow && postRow.current_stock !== undefined && postRow.current_stock !== null)
    ? postRow.current_stock
    : item.stock;

  const isSoldOut = effectiveStock !== null && effectiveStock !== undefined && effectiveStock <= 0;
  const restockIntervalSeconds = postRow?.restock_interval_seconds;
  const hasTimer = Boolean(restockIntervalSeconds && restockIntervalSeconds > 0);

  let stockHeader = '♾️ Unlimited';
  let stockValue = 'Available';

  if (hasTimer) {
    const baseTime = postRow.last_restocked_at
      ? new Date(postRow.last_restocked_at).getTime()
      : new Date(postRow.created_at || Date.now()).getTime();

    let nextRestockMs = baseTime + (restockIntervalSeconds * 1000);
    if (nextRestockMs <= Date.now()) {
      const elapsed = Date.now() - baseTime;
      const cycles = Math.floor(elapsed / (restockIntervalSeconds * 1000)) + 1;
      nextRestockMs = baseTime + (cycles * restockIntervalSeconds * 1000);
    }
    const nextRestockUnix = Math.floor(nextRestockMs / 1000);

    if (effectiveStock === null || effectiveStock === undefined) {
      stockHeader = '♾️ Unlimited';
      stockValue = `Refreshes <t:${nextRestockUnix}:R>`;
      embed.setColor('#3498DB');
    } else if (isSoldOut) {
      stockHeader = '🔴 Out Of Stock';
      stockValue = `Restocks <t:${nextRestockUnix}:R>`;
      embed.setColor('#808080');
    } else {
      stockHeader = `🟢 ${effectiveStock} In Stock`;
      stockValue = `Restocks <t:${nextRestockUnix}:R>`;
      embed.setColor('#3498DB');
    }
  } else {
    if (effectiveStock === null || effectiveStock === undefined) {
      stockHeader = '♾️ Unlimited';
      stockValue = 'Available';
      embed.setColor('#3498DB');
    } else if (isSoldOut) {
      stockHeader = '🔴 Out Of Stock';
      stockValue = 'Sold Out';
      embed.setColor('#808080');
    } else {
      stockHeader = `🟢 ${effectiveStock} In Stock`;
      stockValue = 'Available';
      embed.setColor('#3498DB');
    }
  }

  embed.addFields({ name: stockHeader, value: stockValue, inline: true });

  // 5. Button construction
  let effectivePrice = (postRow?.override_price !== null && postRow?.override_price !== undefined)
    ? Number(postRow.override_price)
    : (Number(item.price) || 0);

  let sellerPart = '0';
  let payoutPart = '0';
  let overridePart = (postRow?.override_price !== null && postRow?.override_price !== undefined)
    ? postRow.override_price
    : '';

  if (existingCustomId && (existingCustomId.startsWith('bank_shop_buy_') || existingCustomId.startsWith('force_buy_'))) {
    const parts = existingCustomId.split('_');
    const isForce = existingCustomId.startsWith('force_buy_');
    const offset = isForce ? 0 : 1;
    sellerPart = parts[3 + offset] || '0';
    payoutPart = parts[4 + offset] || '0';
    const customOverride = parts[5 + offset];
    if (customOverride !== undefined && customOverride !== '' && !isNaN(Number(customOverride))) {
      overridePart = customOverride;
      effectivePrice = Number(customOverride);
    }
  }

  const isFree = Number(effectivePrice) === 0;

  let buttonLabel = '';
  if (isSoldOut) {
    buttonLabel = 'SOLD OUT';
  } else if (isFree) {
    buttonLabel = 'CLAIM';
  } else {
    buttonLabel = `BUY (${Number(effectivePrice).toLocaleString()})`;
  }

  const buyButton = new ButtonBuilder()
    .setCustomId(`bank_shop_buy_${item.id}_${sellerPart}_${payoutPart}_${overridePart}`)
    .setLabel(buttonLabel)
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(isSoldOut);

  safeSetButtonEmoji(buyButton, COIN_EMOJI.forGuild(gId));

  const row = new ActionRowBuilder().addComponents(buyButton);

  return {
    embeds: [embed],
    components: [row]
  };
}
