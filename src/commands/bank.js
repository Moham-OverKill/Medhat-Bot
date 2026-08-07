import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  StringSelectMenuBuilder,
  MessageFlags
} from 'discord.js';
import { getPool } from '../storage/postgres.js';
import { logServerEvent, sendLog, sysLog, sysError } from '../utils/logger.js';
import { handleInteractionError } from '../utils/errors.js';
import { claimDaily } from '../economy/service.js';
import { isMemberBooster } from './colors.js';
import { hasClaimedToday, isStreakValid, getNextCairoMidnight } from '../utils/time.js';
import { getUserDisplayName, getUserLogName, COIN_EMOJI, sanitizeError, sortItemsByRolePosition, formatInventoryItemLine } from '../shared.js';
import {
  getShopCategories,
  getShopItems,
  getShopItem,
  getItemImage,
  purchaseItem,
  getUserInventory,
  syncInventoryWithDiscord,
  getSynthesizedInventory,
  toggleEquipItem,
  calculatePackPrice,
  checkPrerequisites,
  formatPrerequisiteError,
  dropItem,
  claimItem,
  runDependencySweep,
  query
} from '../economy/shop.js';

// --- Constants ---
const DAILY_BASE_REWARD = 25;
const DAILY_STREAK_BONUS = 5;
const BANK_THUMBNAIL_URL = 'https://media.discordapp.net/attachments/487762905551339540/1444320252019343391/Ok_Coin.png?ex=692c478e&is=692af60e&hm=5fee9ed4c93a354d1d06a9c1d411002189fb3c540c02423bde6c2e7f052fcd80&=&format=png&quality=lossless&width=1042&height=1042';
const lockEmoji = '🔒';

// --- Command Definition ---
export const bankCommand = new SlashCommandBuilder()
  .setName('bank')
  .setDescription('Access your personal bank account');

// --- Helper Functions ---

async function getUserBalance(guildId, userId) {
  const pool = getPool();
  const result = await pool.query(
    'SELECT balance, daily_streak, last_daily, last_lost_streak FROM user_balances WHERE guild_id = $1 AND user_id = $2',
    [guildId, userId]
  );
  return result.rows[0] || { balance: 0, daily_streak: 0, last_daily: null, last_lost_streak: 0 };
}

function getCoinThumbnailUrl() {
  const emojiStr = COIN_EMOJI.toString().trim();
  const match = emojiStr.match(/<(a)?:[^:]+:(\d+)>/);
  if (match) {
    const isAnimated = Boolean(match[1]);
    const emojiId = match[2];
    return `https://cdn.discordapp.com/emojis/${emojiId}.${isAnimated ? 'gif' : 'png'}`;
  }

  // Check if it's a standard unicode emoji
  const emojiRegex = /\p{Extended_Pictographic}|\p{Emoji_Presentation}/u;
  if (emojiRegex.test(emojiStr)) {
    try {
      const codePoints = [...emojiStr].map(char => char.codePointAt(0).toString(16));
      const filteredCodePoints = codePoints.filter(cp => cp !== 'fe0f');
      const hex = filteredCodePoints.join('-');
      return `https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/${hex}.png`;
    } catch (e) {
      // Fallback
    }
  }

  return BANK_THUMBNAIL_URL;
}

function buildBankUI(userData, member) {
  const balance = parseInt(userData.balance);
  const dbStreak = parseInt(userData.daily_streak) || 0;
  const lastDaily = userData.last_daily;

  // ========== CAIRO TIME LOGIC ==========
  // Check if daily is available (not claimed today)
  const isDailyAvailable = !hasClaimedToday(lastDaily);

  // Check if streak is still valid (claimed yesterday or today)
  const streakIsValid = isStreakValid(lastDaily);
  const displayStreak = streakIsValid ? dbStreak : 0;

  // Logic:
  // 1. If valid -> Show current streak
  // 2. If invalid but dbStreak > 0 (not reset yet) -> Show old streak crossed out
  // 3. If invalid and dbStreak == 0 (reset happened) -> Check last_lost_streak to show what was lost

  const isStreakLost = !streakIsValid && dbStreak > 0;
  const wasStreakLostRecently = !streakIsValid && dbStreak === 0 && userData.last_lost_streak > 0;

  let streakText = `${displayStreak} day(s)`;
  if (isStreakLost) {
    streakText = `~~${dbStreak} day(s)~~`; // Show old streak crossed out (before reset)
  } else if (wasStreakLostRecently) {
    streakText = `~~${userData.last_lost_streak} day(s)~~`; // Show old streak crossed out (after reset)
  }

  let nextDailyText = "✅ Available Now!";
  if (!isDailyAvailable) {
    // Show countdown to Cairo midnight
    const nextMidnight = getNextCairoMidnight();
    const nextDailyTime = Math.floor(nextMidnight.getTime() / 1000);
    nextDailyText = `<t:${nextDailyTime}:R>`;
  }

  const embed = new EmbedBuilder()
    .setColor(0xFFD700) // Gold
    .setTitle('🏛️ Bank')
    .setDescription(`Welcome to your personal bank account, <@${member.id}>!`)
    .setThumbnail(getCoinThumbnailUrl())
    .addFields(
      { name: `💰 Balance`, value: `${balance.toLocaleString()} ${COIN_EMOJI}`, inline: true },
      { name: '🔥 Daily Streak', value: streakText, inline: true },
      { name: '⏰ Next Daily', value: nextDailyText, inline: true }
    );

  const dailyButton = new ButtonBuilder()
    .setCustomId('bank_daily')
    .setLabel('Daily')
    .setEmoji('🎁')
    .setStyle(isDailyAvailable ? ButtonStyle.Success : ButtonStyle.Secondary)
    .setDisabled(!isDailyAvailable);



  const historyButton = new ButtonBuilder()
    .setCustomId('bank_history')
    .setLabel('History')
    .setEmoji('📜')
    .setStyle(ButtonStyle.Secondary);

  const refreshButton = new ButtonBuilder()
    .setCustomId('bank_refresh')
    .setLabel('Refresh')
    .setEmoji('🔄')
    .setStyle(ButtonStyle.Secondary);

  const row = new ActionRowBuilder()
    .addComponents(dailyButton, historyButton, refreshButton);

  return { embed, components: [row] };
}

async function refreshBankUI(interaction) {
  const userData = await getUserBalance(interaction.guildId, interaction.user.id);
  const { embed, components } = buildBankUI(userData, interaction.member);
  await interaction.editReply({ content: null, embeds: [embed], components });
}

// --- Handlers ---

export async function handleBankCommand(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }
    await refreshBankUI(interaction);
  } catch (error) {
    await handleInteractionError(interaction, error, 'Bank command');
  }
}

export async function handleBankDaily(interaction) {
  // FORCE REFRESH: Ensuring interaction is deferred immediately to prevent 'InteractionNotReplied' errors.
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => { });
    }
  } catch (err) {
    sysLog('Interaction Warning', { detail: `DeferUpdate failed: ${err.message}` });
  }

  try {
    const guildId = interaction.guildId;

    const userId = interaction.user.id;
    const member = interaction.member;
    const isBooster = await isMemberBooster(member);

    const result = await claimDaily(userId, guildId, getUserDisplayName(member), isBooster);

    if (!result.success) {
      if (result.error === 'daily_claimed') {
        // Just refresh the UI if already claimed (button will become disabled)
        const userData = await getUserBalance(guildId, userId);
        const { embed, components } = buildBankUI(userData, member);

        // Update original message immediately
        await interaction.editReply({ content: null, embeds: [embed], components });

        // Optionally tell them why nothing happened
        await interaction.followUp({ content: '❌ You have already claimed your daily reward today.', flags: MessageFlags.Ephemeral });
        return;
      }
      throw new Error(result.error);
    }

    // 2. Update the Bank Panel (Original Message)
    // This updates the balance and disables the Daily button
    const updatedData = await getUserBalance(guildId, userId);
    const { embed, components } = buildBankUI(updatedData, member);

    // Update original message immediately
    await interaction.editReply({ content: null, embeds: [embed], components });

    // 2.5 Log to Discord Logs
    const logUsername = getUserLogName(member);
    const initialBal = result.balance - result.amount;
    sendLog(interaction.guild, 'economy', 'orange', '💰 Daily Claimed',
      `**User:** \`${logUsername}\`\n` +
      `**Reward:** \`${result.amount.toLocaleString()}\` ${COIN_EMOJI} (Daily)\n` +
      `**Streak:** \`${result.streak} days\`\n` +
      `**Balance:** \`${initialBal.toLocaleString()}\` ➡️ \`${result.balance.toLocaleString()}\``
    );

    // 3. Send Success Message (New Ephemeral Reply)
    const { breakdown } = result;
    let msg = `You received **${result.amount}** ${COIN_EMOJI}\n`;
    msg += `> 💰 Base: **+${breakdown.base}**\n`;
    msg += `> 🔥 Streak Bonus: **+${breakdown.streakBonus}**\n`;
    msg += `> 🚀 Boost Bonus: **+${breakdown.boostBonus}**\n`;

    await interaction.followUp({
      content: msg,
      flags: MessageFlags.Ephemeral
    });

  } catch (error) {
    sysError('Daily claim processing failure', error, { user: interaction.user.id, guild: interaction.guildId });
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ Failed to process daily claim.', flags: MessageFlags.Ephemeral });
    } else {
      await interaction.followUp({ content: '❌ Failed to process daily claim.', flags: MessageFlags.Ephemeral });
    }
  }
}

/**
 * SHOP FLOW
 */
export async function handleShopButton(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    const categories = await getShopCategories(interaction.guildId);
    const items = await getShopItems(interaction.guildId);

    const backRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('bank_back').setLabel('Back').setStyle(ButtonStyle.Secondary).setEmoji('⬅️')
    );

    if (categories.length === 0 && items.length === 0) {
      return interaction.editReply({
        content: '🏪 The shop is currently empty.',
        embeds: [],
        components: [backRow]
      });
    }

    const select = new StringSelectMenuBuilder()
      .setCustomId('bank_shop_category')
      .setPlaceholder('Select a Category')
      .addOptions(categories.map(c => ({
        label: (c.name && c.name.trim().length > 0) ? c.name.slice(0, 80) : `Unnamed Category #${c.id}`,
        value: c.id.toString(),
        description: (c.type && c.type.trim().length > 0) ? c.type.slice(0, 100) : undefined
      })));

    await interaction.editReply({
      content: '🏪 **Shop**\nSelect a category to browse items:',
      components: [new ActionRowBuilder().addComponents(select), backRow],
      embeds: []
    });
  } catch (error) {
    await handleInteractionError(interaction, error, 'Shop main menu');
  }
}

export async function handleShopCategorySelect(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    const categoryId = parseInt(interaction.values[0]);
    const items = await getShopItems(interaction.guildId, categoryId);

    if (items.length === 0) {
      return interaction.editReply({ content: 'This category is empty.' });
    }

    // Build embed listing items
    const embed = new EmbedBuilder()
      .setTitle('🏪 Items in Category')
      .setColor('#9B59B6');

    let desc = '';
    for (const item of items.slice(0, 10)) {
      const priceVal = Number(item.price);
      const priceDisplay = priceVal === 0 ? 'FREE' : `${priceVal.toLocaleString()} ${COIN_EMOJI}`;
      desc += `**${item.name}** - ${priceDisplay}\n`;
    }
    if (items.length > 10) desc += `...and ${items.length - 10} more`;
    embed.setDescription(desc);

    const select = new StringSelectMenuBuilder()
      .setCustomId('bank_shop_item')
      .setPlaceholder('Select an Item to View')
      .addOptions(items.slice(0, 25).map(i => ({
        label: (i.name && i.name.trim().length > 0) ? i.name.slice(0, 80) : `Unnamed Item #${i.id}`,
        value: i.id.toString(),
        description: Number(i.price) === 0 ? 'FREE' : `${Number(i.price).toLocaleString()} coins`
      })));

    const backRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('bank_shop').setLabel('Back').setStyle(ButtonStyle.Secondary).setEmoji('⬅️')
    );

    await interaction.editReply({
      content: null,
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(select), backRow]
    });
  } catch (error) {
    await handleInteractionError(interaction, error, 'Shop category select');
  }
}

export async function handleShopItemSelect(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    const itemId = parseInt(interaction.values[0]);
    const item = await getShopItem(itemId);

    if (!item) return interaction.editReply({ content: 'Item not found.' });

    const role = await interaction.guild.roles.fetch(item.role_id).catch(() => null);

    const embed = new EmbedBuilder()
      .setTitle(item.name)
      .setColor('#00FF00')
      .addFields(
        { name: 'Price', value: Number(item.price) === 0 ? 'FREE' : `${Number(item.price).toLocaleString()} ${COIN_EMOJI}`, inline: true },
        { name: 'Role Reward', value: role ? `<@&${role.id}>` : 'Unknown Role', inline: true }
      );

    if (item.description) embed.setDescription(item.description);
    if (item.duration_seconds) {
      const hours = Math.floor(item.duration_seconds / 3600);
      embed.addFields({ name: 'Duration', value: `${hours} hours`, inline: true });
    }

    const priceVal = Number(item.price);
    const buyButtonLabel = priceVal === 0 ? 'BUY (FREE)' : `BUY (${priceVal.toLocaleString()})`;
    const buyButton = new ButtonBuilder()
      .setCustomId(`bank_shop_buy_${itemId}`)
      .setLabel(buyButtonLabel)
      .setEmoji(`${COIN_EMOJI}`)
      .setStyle(ButtonStyle.Secondary);

    const backButton = new ButtonBuilder()
      .setCustomId('bank_shop')
      .setLabel('Back')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('⬅️');

    await interaction.editReply({
      content: null,
      embeds: [embed],
      components: [
        new ActionRowBuilder().addComponents(buyButton),
        new ActionRowBuilder().addComponents(backButton)
      ]
    });
  } catch (error) {
    sysError('Item View Failed', error, { user: interaction.user.id, guild: interaction.guildId });
  }
}

export async function handleShopBuyButton(interaction) {
  try {
    const isForce = interaction.customId.startsWith('force_buy_');

    // Parse customId:
    // bank_shop_buy_[itemId]_[sellerId]_[payout]_[overridePrice] OR
    // force_buy_[itemId]_[sellerId]_[payout]_[overridePrice]
    const parts = interaction.customId.split('_');
    const offset = isForce ? 0 : 1;
    const itemId = parseInt(parts[2 + offset]);
    const sellerId = parts[3 + offset] || '0';
    const payoutStr = parts[4 + offset] || '0';
    const overridePriceStr = parts[5 + offset] || null;
    const overridePrice = (overridePriceStr !== null && overridePriceStr !== '') ? parseInt(overridePriceStr) : null;

    const guildId = interaction.guildId;
    const userId = interaction.user.id;
    const member = interaction.member;

    // STEP 0: Interstitial Prerequisite Check
    if (!isForce) {
      const { getShopItem, checkPrerequisites, formatPrerequisiteError } = await import('../economy/shop.js');
      const item = await getShopItem(itemId, guildId);

      if (item && item.required_items) {
        const prereqs = await checkPrerequisites(member, guildId, item.required_items);
        if (!prereqs.met) {
          const warnRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`force_buy_${itemId}_${sellerId}_${payoutStr}_${overridePriceStr || ''}`)
              .setLabel('Buy Anyway')
              .setEmoji('\u26A0\uFE0F')
              .setStyle(ButtonStyle.Danger)
          );

          sysLog('Prereq Warning Triggered', {
            user: userId,
            guild: guildId,
            detail: `Action: ShopBuy | ItemID: ${itemId}`
          });

          return await interaction.reply({
            content: `\u274C You don't meet the requirements to equip this!`,
            components: [warnRow],
            flags: MessageFlags.Ephemeral
          });
        }
      }

      // ========== LOCKED CHECK: Show modal or bypass? ==========
      // If item is Locked (is_tradable = false), skip the quantity modal and buy directly (1 copy).
      // If item is Unlocked, show a quantity modal so users can buy in bulk.
      if (item) {
        const isLocked = item.is_tradable === false;
        if (!isLocked && !isForce) {
          // Check stock before showing modal
          if (item.stock !== null && item.stock <= 0) {
            return interaction.reply({
              content: '\u274C This item is out of stock.',
              flags: MessageFlags.Ephemeral
            });
          }

          // Fetch current user inventory count for this item
          const pool = getPool();
          const qtyRes = await pool.query(
            `SELECT COALESCE(SUM(COALESCE(quantity, 1)), 0) as total
             FROM user_inventory WHERE user_id = $1 AND guild_id = $2 AND shop_item_id = $3`,
            [userId, guildId, itemId]
          );
          const alreadyOwned = parseInt(qtyRes.rows[0]?.total || 0);
          const remainingCap = 999 - alreadyOwned;

          if (remainingCap <= 0) {
            return interaction.reply({
              content: '\u2755 You have reached the maximum of 999 copies of this item.',
              flags: MessageFlags.Ephemeral
            });
          }

          // Placeholder: "999" if unlimited stock (item.stock === null), otherwise current stock count
          const placeholderText = item.stock !== null ? String(item.stock) : '999';

          // Show quantity modal
          const modal = new ModalBuilder()
            .setCustomId(`shop_buy_qty_modal_${itemId}_${sellerId}_${payoutStr}_${overridePriceStr || ''}`)
            .setTitle(`Buy: ${item.name}`);

          const qtyInput = new TextInputBuilder()
            .setCustomId('buy_quantity')
            .setLabel('Enter the amount you want to buy')
            .setPlaceholder(placeholderText)
            .setMinLength(1)
            .setMaxLength(3)
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

          modal.addComponents(new ActionRowBuilder().addComponents(qtyInput));
          return await interaction.showModal(modal);
        }
      }
    }

    // 1. Defer Update/Reply (for locked / force-buy flow — goes straight to purchase)
    if (isForce) {
      sysLog('Bypass Button Clicked', { user: userId, guild: guildId, detail: `Action: ForceBuy | ItemID: ${itemId}` });
      await interaction.deferUpdate();
    } else {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }

    const guildName = interaction.guild.name;
    const buyerName = interaction.user.username;

    // STEP 1: Calculate Seller Payout
    const isSelfPurchase = sellerId !== '0' && sellerId === userId;
    const hasSeller = sellerId !== '0' && !isSelfPurchase;
    const { getShopItem } = await import('../economy/shop.js');
    const itemForPrice = await getShopItem(itemId);
    const customPayout = parseInt(payoutStr) || 0;
    const payoutAmount = hasSeller ? customPayout : 0;

    // STEP 2: Call purchaseItem (quantity=1 for locked items and force-buy)
    await purgeUserInventory(userId, guildId, member);

    const result = await purchaseItem(userId, guildId, itemId, member, {
      sellerId,
      payoutAmount,
      overridePrice,
      quantity: 1
    });

    if (!result.success) {
      if (result.error === 'Insufficient balance') {
        const userBalData = await getUserBalance(guildId, userId);
        const currentBal = parseInt(userBalData?.balance || 0);
        const missing = itemPrice - currentBal;
        return interaction.editReply({
          content: `\u274C You need **${missing}** ${COIN_EMOJI} more to buy this.`,
          components: []
        });
      } else if (result.error.includes('higher than my highest role')) {
        return interaction.editReply({
          content: '\u274C Error: I cannot assign this role. Please contact an admin.',
          components: []
        });
      } else if (result.error.includes('already') || result.error.includes('expire') || result.error.includes('cap') || result.error.includes('maximum')) {
        return interaction.editReply({
          content: `\u2755 ${result.error}`,
          components: []
        });
      } else {
        return interaction.editReply({
          content: `\u274C ${result.error}`,
          components: []
        });
      }
    }

    // STEP 3: Live UI Refresh (Safely isolated so post-purchase UI updates cannot break success response)
    try {
      await refreshShopMessageUI(interaction, itemId, guildId);
    } catch (uiErr) {
      sysError('Shop UI Refresh Error', uiErr, { user: userId, guild: guildId });
    }

    // STEP 4: Success message
    let msg;
    const boughtQty = result.quantity || 1;
    const boughtLabel = boughtQty > 1 ? `${boughtQty}x **${result.item.name}**` : `**${result.item.name}**`;
    if (result.packInfo && result.packInfo.ownedCount > 0) {
      msg = `\u2705 Bought ${result.packInfo.newCount} missing items from **${result.item.name}**! New balance: **${result.newBalance}** ${COIN_EMOJI}`;
    } else {
      msg = `\u2705 Bought ${boughtLabel}! New balance: **${result.newBalance}** ${COIN_EMOJI}`;
    }
    return interaction.editReply({
      content: msg,
      components: []
    });

  } catch (error) {
    sysError('Transaction Audit Failure', error, { user: interaction.user.id, guild: interaction.guildId, detail: 'Shop purchase handler' });
    const errMsg = `\u274C An error occurred. Please try again.`;
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: errMsg, components: [] });
      } else {
        await interaction.reply({ content: errMsg, flags: MessageFlags.Ephemeral });
      }
    } catch (_) { }
  }
}

/**
 * Live-refreshes the posted shop message embed (stock count & button state) after a purchase.
 */
export async function refreshShopMessageUI(interaction, itemId, guildId) {
  const gId = guildId || interaction?.guildId;
  try {
    if (!interaction.message || !interaction.message.editable) return;
    const { getShopItem } = await import('../economy/shop.js');
    const updatedItem = await getShopItem(itemId, gId);

    if (updatedItem && interaction.message.embeds && interaction.message.embeds.length > 0) {
      const embed = EmbedBuilder.from(interaction.message.embeds[0]);

      let stockHeader = '\u267E\uFE0F Stock';
      let stockValue = 'Unlimited';
      if (updatedItem.stock !== null && updatedItem.stock !== undefined) {
        if (updatedItem.stock <= 0) {
          stockHeader = '\uD83D\uDD34 Stock';
          stockValue = 'Sold Out';
        } else {
          stockHeader = '\uD83D\uDFE2 Stock';
          stockValue = `**${updatedItem.stock}** Left`;
        }
      }

      const updatedFields = (embed.data.fields || []).map(f => {
        if (f.name && f.name.includes('Stock')) {
          return { name: stockHeader, value: stockValue, inline: true };
        }
        return f;
      });
      embed.setFields(updatedFields);

      const isSoldOut = updatedItem.stock !== null && updatedItem.stock <= 0;
      if (interaction.message.components && interaction.message.components.length > 0) {
        const row = ActionRowBuilder.from(interaction.message.components[0]);
        if (row.components && row.components.length > 0) {
          const buyBtn = ButtonBuilder.from(row.components[0]);
          buyBtn.setStyle(ButtonStyle.Secondary).setDisabled(isSoldOut);
          row.setComponents(buyBtn);

          await interaction.message.edit({
            embeds: [embed],
            components: [row]
          }).catch(() => { });
        }
      }
    }
  } catch (refreshErr) {
    sysError('Live UI Refresh Failed', refreshErr, { guild: gId, detail: `ItemID: ${itemId}` });
  }
}

/**
 * Modal submission handler for the shop bulk-buy quantity modal.
 * customId: shop_buy_qty_modal_[itemId]_[sellerId]_[payoutStr]_[overridePrice]
 */
export async function handleShopBuyModalSubmit(interaction) {
  try {
    const parts = interaction.customId.split('_');
    // shop(0) buy(1) qty(2) modal(3) [itemId](4) [sellerId](5) [payoutStr](6) [overridePrice](7)
    const itemId = parseInt(parts[4]);
    const sellerId = parts[5] || '0';
    const payoutStr = parts[6] || '0';
    const overridePriceStr = parts[7] || null;
    const overridePrice = (overridePriceStr !== null && overridePriceStr !== '') ? parseInt(overridePriceStr) : null;

    const rawQty = interaction.fields.getTextInputValue('buy_quantity');
    const qty = parseInt(rawQty, 10);

    if (isNaN(qty) || qty < 1 || qty > 999) {
      return interaction.reply({
        content: '\u274C Please enter a valid quantity between 1 and 999.',
        flags: MessageFlags.Ephemeral
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const userId = interaction.user.id;
    const guildId = interaction.guildId;
    const member = interaction.member;

    const isSelfPurchase = sellerId !== '0' && sellerId === userId;
    const hasSeller = sellerId !== '0' && !isSelfPurchase;
    const customPayout = parseInt(payoutStr) || 0;
    const payoutAmount = hasSeller ? customPayout : 0;

    const { purgeUserInventory } = await import('../economy/shop.js');
    await purgeUserInventory(userId, guildId, member);

    const result = await purchaseItem(userId, guildId, itemId, member, {
      sellerId,
      payoutAmount,
      overridePrice,
      quantity: qty
    });

    if (!result.success) {
      const isCapOrOwned = result.error.includes('already') || result.error.includes('maximum') || result.error.includes('999') || result.error.includes('expire') || result.error.includes('stock');
      return interaction.editReply({
        content: isCapOrOwned ? `\u2755 ${result.error}` : `\u274C ${result.error}`,
        components: []
      });
    }

    // Refresh live shop message embed stock counter upon purchase completion (safely isolated)
    try {
      await refreshShopMessageUI(interaction, itemId, guildId);
    } catch (uiErr) {
      sysError('Shop UI Refresh Error', uiErr, { user: userId, guild: guildId });
    }

    const boughtQty = result.quantity || qty;
    const boughtLabel = boughtQty > 1 ? `${boughtQty}x **${result.item.name}**` : `**${result.item.name}**`;
    let msg;
    if (result.packInfo && result.packInfo.ownedCount > 0) {
      msg = `\u2705 Bought ${result.packInfo.newCount} missing items from **${result.item.name}**! New balance: **${result.newBalance}** ${COIN_EMOJI}`;
    } else {
      msg = `\u2705 Bought ${boughtLabel}! New balance: **${result.newBalance}** ${COIN_EMOJI}`;
    }
    return interaction.editReply({ content: msg, components: [] });

  } catch (error) {
    sysError('BuyModalSubmit Error', error, { user: interaction.user.id, guild: interaction.guildId });
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: '\u274C An error occurred. Please try again.', components: [] });
      } else {
        await interaction.reply({ content: '\u274C An error occurred.', flags: MessageFlags.Ephemeral });
      }
    } catch (_) { }
  }
}

// Deprecated confirmation handlers (kept to prevent import errors if referenced, but unused)

export async function handleShopConfirmBuy(interaction) {
  await interaction.reply({ content: '❌ This interaction is outdated.', flags: MessageFlags.Ephemeral });
}

export async function handleShopCancelBuy(interaction) {
  await interaction.reply({ content: '❌ This interaction is outdated.', flags: MessageFlags.Ephemeral });
}

/**
 * INVENTORY FLOW - REFACTORED
 */

// VIEW 1: Inventory Home (Dashboard)
// Supports both slash command (/inventory) and button interactions
export async function handleInventoryButton(interaction) {
  try {
    // Detect interaction type and defer appropriately
    const isSlashCommand = interaction.isChatInputCommand();
    if (!interaction.deferred && !interaction.replied) {
      if (isSlashCommand) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      } else {
        await interaction.deferUpdate();
      }
    }

    const guildId = interaction.guildId;
    const userId = interaction.user.id;

    // ========== EVENT-DRIVEN PURGE (Lazy Evaluation) ==========
    // We execute the FULL purge here (DB + Discord Roles)
    const { purgeUserInventory } = await import('../economy/shop.js');
    await purgeUserInventory(userId, guildId, interaction.member);

    // Unified Fetch: Includes DB items + Live synthesis of admin roles
    const [inventory, categories, userBal] = await Promise.all([
      getSynthesizedInventory(userId, guildId, interaction.member),
      getShopCategories(guildId),
      getUserBalance(guildId, userId)
    ]);

    // ========== FILTER VISIBLE ITEMS ==========
    // Exclude packs (hidden from inventory view)
    const items = inventory.filter(i => i.item_type !== 'pack' && !i.is_pack);
    const totalCount = items.reduce((sum, i) => sum + (parseInt(i.quantity) || 1), 0);
    const currentBalance = parseInt(userBal.balance);

    // Count items per category (summing quantities)
    const categoryCounts = {};
    let otherCount = 0;
    for (const item of items) {
      const itemQty = parseInt(item.quantity) || 1;
      if (item.category_id) {
        categoryCounts[item.category_id] = (categoryCounts[item.category_id] || 0) + itemQty;
      } else {
        otherCount += itemQty;
      }
    }

    const validCategoryIds = Object.keys(categoryCounts).map(Number);

    // 5. Build Embed
    const embed = new EmbedBuilder()
      .setTitle('🎒 Inventory')
      .setColor('#3498DB')
      .setDescription(
        `${COIN_EMOJI} **Balance:** ${currentBalance.toLocaleString()}   📦 **Total Items:** ${totalCount}`
      );

    // 6. Build Category Buttons (All Secondary/Gray)
    const validCategories = categories.filter(c => validCategoryIds.includes(c.id));

    // Create button definitions - all categories are Secondary (Gray)
    const buttonDefs = validCategories.map(c => ({
      id: `bank_inv_cat_${c.id}`,
      label: c.name
    }));

    // "Other" is also Secondary (Gray), treated like a category
    if (otherCount > 0) {
      buttonDefs.push({
        id: 'bank_inv_cat_null',
        label: 'Other'
      });
    }

    // Pagination & Layout Logic (4 buttons per row max, max 4 rows = 16 categories per page)
    let page = 0;
    const customId = interaction.customId || '';
    if (customId.startsWith('bank_inv_page_')) {
      const pageVal = parseInt(customId.split('_').pop());
      if (!isNaN(pageVal)) page = pageVal;
    }

    const CATS_PER_ROW = 4;
    const MAX_CAT_ROWS = 4;
    const CATS_PER_PAGE = CATS_PER_ROW * MAX_CAT_ROWS; // 16 category buttons per page
    const totalPages = Math.max(1, Math.ceil(buttonDefs.length / CATS_PER_PAGE));

    if (page < 0) page = 0;
    if (page >= totalPages) page = totalPages - 1;

    const startIdx = page * CATS_PER_PAGE;
    const pageButtons = buttonDefs.slice(startIdx, startIdx + CATS_PER_PAGE);

    const rows = [];

    // Build Category Rows (4 buttons each)
    for (let i = 0; i < pageButtons.length; i += CATS_PER_ROW) {
      const chunk = pageButtons.slice(i, i + CATS_PER_ROW);
      const row = new ActionRowBuilder();
      chunk.forEach(btn => {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(btn.id)
            .setLabel(btn.label)
            .setStyle(ButtonStyle.Secondary)
        );
      });
      rows.push(row);
    }

    // Navigation Row (Row 5 - only if totalPages > 1)
    if (totalPages > 1) {
      const navRow = new ActionRowBuilder();
      navRow.addComponents(
        new ButtonBuilder()
          .setCustomId(`bank_inv_page_${page - 1}`)
          .setEmoji('◀️')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page === 0),
        new ButtonBuilder()
          .setCustomId('bank_inv_page_indicator')
          .setLabel(`${page + 1}/${totalPages}`)
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId(`bank_inv_page_${page + 1}`)
          .setEmoji('▶️')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page >= totalPages - 1)
      );
      rows.push(navRow);
    }

    await interaction.editReply({
      content: null,
      embeds: [embed],
      components: rows
    });

  } catch (error) {
    await handleInteractionError(interaction, error, 'Inventory dashboard');
  }
}



// VIEW 2: Category Content View
export async function handleInventoryCategorySelect(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => { });
    }

    const catIdStr = interaction.customId.replace('bank_inv_cat_', '');
    const isOther = catIdStr === 'null';
    const categoryId = isOther ? null : parseInt(catIdStr);

    // Unified Fetch: Includes DB items + Live synthesis of admin roles
    const [inventory, categories] = await Promise.all([
      getSynthesizedInventory(interaction.user.id, interaction.guildId, interaction.member),
      getShopCategories(interaction.guildId)
    ]);

    // Filter Items (no packs, match category, fail-safe for ghost roles)
    let items = inventory.filter(i => {
      if (i.item_type === 'pack' || i.is_pack) return false;
      // Fail-safe: Skip items with missing roles
      if (i.role_id) {
        const firstRoleId = i.role_id.split(/[,\s]+/)[0];
        if (!interaction.guild.roles.cache.has(firstRoleId)) return false;
      }
      return isOther ? i.category_id === null : i.category_id === categoryId;
    });

    // Sort by role position
    items = await sortItemsByRolePosition(items, interaction.guild);

    if (items.length === 0) {
      // Category is empty - return to main inventory dashboard
      return handleInventoryButton(interaction);
    }

    // Get Category Name
    let categoryName = 'Other';
    if (!isOther) {
      const cat = categories.find(c => c.id === categoryId);
      if (cat) categoryName = cat.name;
    }

    // Build List with role mentions and correct emojis for temp vs perm
    const listLines = items.map(i => formatInventoryItemLine(i));

    const embed = new EmbedBuilder()
      .setTitle(`📂 Category: ${categoryName}`)
      .setColor('#2ECC71')
      .setDescription(listLines.slice(0, 20).join('\n') + (listLines.length > 20 ? `\n...and ${listLines.length - 20} more` : ''));

    const itemOptions = [
      {
        label: 'Back',
        value: 'back_to_inventory',
        description: 'Return to main inventory overview',
        emoji: '⬅️'
      },
      ...items.slice(0, 24).map((i, idx) => {
        const isTemp = !!(i.expires_at ||
          (i.duration_seconds && i.duration_seconds > 0) ||
          (i.duration_hours && i.duration_hours > 0));
        const isAdminIdentified = i.source === 'SYNC';

        let statusEmoji = '⬜';
        let statusText = 'Unknown';

        if (isAdminIdentified) {
          statusEmoji = '🛡️';
          statusText = 'Admin Granted';
        } else if (isTemp) {
          statusEmoji = i.is_active ? '✅' : '⬜';
          statusText = i.is_active ? 'Active' : 'Inactive';
        } else {
          statusEmoji = i.is_active ? '✅' : '⬜';
          statusText = i.is_active ? 'Equipped' : 'Unequipped';
        }

        const itemQty = parseInt(i.quantity) || 1;
        const qtyBadge = (!isAdminIdentified && itemQty > 1) ? ` x${itemQty}` : '';
        const baseName = (i.name && i.name.trim().length > 0) ? i.name.slice(0, 70) : `Item #${i.id}`;

        return {
          label: `${baseName}${qtyBadge}`,
          value: `${i.id}_${idx}`,
          description: statusText,
          emoji: statusEmoji
        };
      })
    ];

    const select = new StringSelectMenuBuilder()
      .setCustomId(`bank_inv_item_select_${isOther ? 'null' : categoryId}`)
      .setPlaceholder('Select an Item to Manage')
      .addOptions(itemOptions);

    const row1 = new ActionRowBuilder().addComponents(select);

    await interaction.editReply({
      content: null,
      embeds: [embed],
      components: [row1]
    });

  } catch (error) {
    sysError('Category view expansion failure', error, { user: interaction.user.id, guild: interaction.guildId });
    await interaction.editReply({ content: '❌ Error loading category.' });
  }
}

// VIEW 3: Item Management Panel with Carousel Navigation
export async function handleInventoryItemSelect(interaction) {
  try {
    // 1. Force immediate acknowledgment to prevent "Interaction Failed"
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => { });
    }

    // Parse interaction data
    // From select menu: value = "invId_index", customId = "bank_inv_item_select_categoryId"
    // From carousel nav: customId = "inv_nav_categoryId_index_prev/next"

    let categoryId, currentIndex, invId;

    if (interaction.values) {
      const selectedVal = interaction.values[0];

      // Handle "Back to Inventory" dropdown option selection
      if (selectedVal === 'back_to_inventory') {
        return handleInventoryButton(interaction);
      }

      // From select menu: value = "invId_index"
      const [itemId, idx] = selectedVal.split('_');
      invId = itemId; // Can be string (admin_id) or number
      currentIndex = parseInt(idx) || 0;

      const catPart = interaction.customId.replace('bank_inv_item_select_', '');
      categoryId = catPart === 'null' ? null : parseInt(catPart);
    } else if (interaction.customId.startsWith('inv_nav_')) {
      // From carousel navigation: inv_nav_categoryId_index_direction
      const parts = interaction.customId.split('_');
      const catPart = parts[2];
      categoryId = catPart === 'null' ? null : parseInt(catPart);
      currentIndex = parseInt(parts[3]) || 0;
    } else if (interaction.customId.startsWith('bank_inv_')) {
      // From action buttons: bank_inv_ACTION_invId_categoryId_currentIndex
      const parts = interaction.customId.split('_');
      // [0]bank [1]inv [2]action [3]invId [4]categoryId [5]currentIndex
      invId = parts[3];
      const catPart = parts[4];
      categoryId = (catPart === 'null' || !catPart) ? null : parseInt(catPart);
      currentIndex = parseInt(parts[5]) || 0;
    }

    const isOther = categoryId === null;

    // 1. Fetch Unified Inventory: Includes DB items + Live synthesis of admin roles
    const inventory = await getSynthesizedInventory(interaction.user.id, interaction.guildId, interaction.member);

    // 2. Filter Category Items
    let items = inventory.filter(i => {
      if (i.item_type === 'pack' || i.is_pack) return false;
      return isOther ? i.category_id === null : i.category_id === categoryId;
    });

    // Sort by role position
    items = await sortItemsByRolePosition(items, interaction.guild);

    // STATE ANCHORING: If we have a specific invId (from an action or select),
    // re-calculate the index to ensure we stay on the same item post-sync/sort.
    if (invId) {
      const foundIdx = items.findIndex(i => String(i.id) === String(invId));
      if (foundIdx !== -1) {
        currentIndex = foundIdx;
      }
    }

    if (items.length === 0) {
      // All items sold/deleted - build main inventory directly with fresh data
      const [categories, userBal] = await Promise.all([
        getShopCategories(interaction.guildId),
        getUserBalance(interaction.guildId, interaction.user.id)
      ]);

      const activeItems = inventory.filter(i => i.item_type !== 'pack' && !i.is_pack);
      const totalCount = activeItems.reduce((sum, i) => sum + (parseInt(i.quantity) || 1), 0);
      const currentBalance = parseInt(userBal.balance);

      // Count items per category (summing quantities)
      const categoryCounts = {};
      let otherCount = 0;
      for (const item of activeItems) {
        const itemQty = parseInt(item.quantity) || 1;
        if (item.category_id) {
          categoryCounts[item.category_id] = (categoryCounts[item.category_id] || 0) + itemQty;
        } else {
          otherCount += itemQty;
        }
      }

      const validCategoryIds = Object.keys(categoryCounts).map(Number);
      const validCategories = categories.filter(c => validCategoryIds.includes(c.id));

      const embed = new EmbedBuilder()
        .setTitle('\uD83C\uDF92 Inventory')
        .setColor('#3498DB')
        .setDescription(`${COIN_EMOJI} **Balance:** ${currentBalance.toLocaleString()}   \uD83D\uDCE6 **Total Items:** ${totalCount}`);

      const buttonDefs = validCategories.map(c => ({ id: `bank_inv_cat_${c.id}`, label: c.name }));
      if (otherCount > 0) buttonDefs.push({ id: 'bank_inv_cat_null', label: 'Other' });

      const rows = [];
      if (buttonDefs.length > 0) {
        const row = new ActionRowBuilder();
        buttonDefs.slice(0, 4).forEach(btn => {
          row.addComponents(new ButtonBuilder().setCustomId(btn.id).setLabel(btn.label).setStyle(ButtonStyle.Primary));
        });
        rows.push(row);
      }

      return interaction.editReply({ content: null, embeds: [embed], components: rows });
    }

    // Handle carousel navigation
    if (interaction.customId.startsWith('inv_nav_')) {
      const direction = interaction.customId.split('_').pop();
      if (direction === 'prev') {
        currentIndex = currentIndex <= 0 ? items.length - 1 : currentIndex - 1;
      } else if (direction === 'next') {
        currentIndex = currentIndex >= items.length - 1 ? 0 : currentIndex + 1;
      }
    }

    // Ensure index is valid
    if (currentIndex >= items.length) currentIndex = 0;
    if (currentIndex < 0) currentIndex = items.length - 1;

    const item = items[currentIndex];
    if (!item) return interaction.editReply({ content: '\u274C Item not found.' });

    // Get role color for embed
    let embedColor = '#3498DB';
    if (item.role_id) {
      const firstRoleId = item.role_id.split(/[,\s]+/)[0];
      const role = interaction.guild.roles.cache.get(firstRoleId);
      if (role && role.color) {
        embedColor = role.hexColor;
      }
    }

    // Build description
    const firstRoleId = item.role_id ? item.role_id.split(/[,\s]+/)[0] : null;

    const source = item.source || 'SYNC';
    const isAdminGranted = source === 'SYNC';
    const purchasedAt = new Date(item.purchased_at);

    const isTemp = !!(item.expires_at ||
      (item.duration_seconds && item.duration_seconds > 0) ||
      (item.duration_hours && item.duration_hours > 0));

    // Quantity count
    const displayQty = parseInt(item.quantity) || 1;

    const RARITY_DISPLAY = {
      common: '\u26AA Common',
      uncommon: '\uD83D\uDFE2 Uncommon',
      rare: '\uD83D\uDD35 Rare',
      epic: '\uD83D\uDFE3 Epic',
      legendary: '\uD83D\uDFE1 Legendary'
    };
    const rarityText = RARITY_DISPLAY[item.rarity] || '\u26AA Common';
    let desc = `**Item:** ${firstRoleId ? `<@&${firstRoleId}>` : item.name}`;
    desc += `\n**Quantity:** ${displayQty}`;
    desc += `\n**Rarity:** ${rarityText}`;

    if (isAdminGranted) {
      const joinDate = interaction.member.joinedAt || new Date();
      desc += `\n**Acquired:** <t:${Math.floor(joinDate.getTime() / 1000)}:D>`;
    } else {
      desc += `\n**Acquired:** <t:${Math.floor(purchasedAt.getTime() / 1000)}:D>`;
    }

    if (isAdminGranted) {
      desc += `\n**Status:** \uD83D\uDEE1\uFE0F Admin Granted`;
    } else if (isTemp) {
      if (!item.expires_at) {
        desc += `\n**Status:** \u231B Ready to Activate`;
      } else {
        desc += `\n**Status:** ${item.is_active ? '\u2705 Active' : '\u23F8\uFE0F Inactive (Counting)'}`;
      }
    } else {
      desc += `\n**Status:** ${item.is_active ? '\u2705 Equipped' : '\u2B1C Unequipped'}`;
    }

    const isUntradable = item.is_tradable === false;
    const cannotSell = isAdminGranted || isTemp || isUntradable;
    const cannotToggle = isAdminGranted;

    if (item.expires_at) {
      desc += `\n\u23F3 **Expires:** <t:${Math.floor(new Date(item.expires_at).getTime() / 1000)}:R>`;
    }

    // Embed Title without pagination number
    const embed = new EmbedBuilder()
      .setTitle(`Manage: ${item.name}`)
      .setColor(embedColor)
      .setDescription(desc);

    // Show item image as small thumbnail (corner) in the management embed
    const itemImg = getItemImage(item);
    if (itemImg) embed.setThumbnail(itemImg);

    const catIdStr = isOther ? 'null' : categoryId;
    const hasMultipleItems = items.length > 1;

    // ROW 1: Actions [🗑️ Drop] [✅ Equip/Unequip/Activate]
    const row1 = new ActionRowBuilder();

    // [🗑️ Drop]
    row1.addComponents(
      new ButtonBuilder()
        .setCustomId(`bank_inv_drop_${item.id}_${catIdStr}_${currentIndex}`)
        .setLabel('Drop')
        .setEmoji('🗑️')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(cannotSell)
    );

    // Dynamic button based on item type and state
    let toggleLabel = 'Equip';
    let toggleEmoji = '✅';

    if (isTemp) {
      if (!item.expires_at) {
        toggleLabel = 'Activate';
        toggleEmoji = '⚡';
      } else {
        toggleLabel = item.is_active ? 'Deactivate' : 'Reactivate';
        toggleEmoji = item.is_active ? '⏸️' : '▶️';
      }
    } else {
      toggleLabel = item.is_active ? 'Unequip' : 'Equip';
      toggleEmoji = item.is_active ? '⏸️' : '✅';
    }

    row1.addComponents(
      new ButtonBuilder()
        .setCustomId(`bank_inv_equip_${item.id}_${catIdStr}_${currentIndex}`)
        .setLabel(toggleLabel)
        .setEmoji(cannotToggle ? lockEmoji : toggleEmoji)
        .setStyle(item.is_active ? ButtonStyle.Secondary : ButtonStyle.Success)
        .setDisabled(cannotToggle)
    );

    // ROW 2: Item Selection Dropdown List (Includes Back as Option 0)
    const selectOptions = [
      {
        label: 'Back',
        value: 'back_to_inventory',
        description: 'Return to main inventory overview',
        emoji: '⬅️'
      },
      ...items.slice(0, 24).map((i, idx) => {
        const isItemTemp = !!(i.expires_at ||
          (i.duration_seconds && i.duration_seconds > 0) ||
          (i.duration_hours && i.duration_hours > 0));
        const isAdminIdentified = i.source === 'SYNC';

        let statusEmoji = '⬜';
        let statusText = 'Unknown';

        if (isAdminIdentified) {
          statusEmoji = '🛡️';
          statusText = 'Admin Granted';
        } else if (isItemTemp) {
          statusEmoji = i.is_active ? '✅' : '⬜';
          statusText = i.is_active ? 'Active' : 'Inactive';
        } else {
          statusEmoji = i.is_active ? '✅' : '⬜';
          statusText = i.is_active ? 'Equipped' : 'Unequipped';
        }

        const itemQty = parseInt(i.quantity) || 1;
        const qtyBadge = (!isAdminIdentified && itemQty > 1) ? ` x${itemQty}` : '';
        const baseName = (i.name && i.name.trim().length > 0) ? i.name.slice(0, 70) : `Item #${i.id}`;

        return {
          label: `${baseName}${qtyBadge}`,
          value: `${i.id}_${idx}`,
          description: statusText,
          emoji: statusEmoji,
          default: String(i.id) === String(item.id)
        };
      })
    ];

    const itemSelect = new StringSelectMenuBuilder()
      .setCustomId(`bank_inv_item_select_${catIdStr}`)
      .setPlaceholder('Select an Item to Manage')
      .addOptions(selectOptions);

    const row2 = new ActionRowBuilder().addComponents(itemSelect);

    await interaction.editReply({
      content: null,
      embeds: [embed],
      components: [row1, row2]
    });

  } catch (error) {
    sysError('Item Manage Error', error, { user: interaction.user.id, guild: interaction.guildId });
    if (!interaction.replied) {
      await interaction.editReply({ content: '❌ Error loading item.' });
    }
  }
}

// ACTION HANDLER (Drop / Equip / Confirm)
export async function handleInventoryAction(interaction) {
  try {
    const parts = interaction.customId.split('_');


    const action = parts[2]; // drop, equip, dropconfirm, dropcancel
    const invId = parseInt(parts[3]);
    const catIdStr = parts[4] || 'null';
    const currentIndex = parseInt(parts[5]) || 0;

    // --- SECURITY LOCK: Trade Concurrency ---
    // Prevent dropping items if the user is in a pending trade (prevents duplication/ghost trades)
    if (action === 'drop' || action === 'dropconfirm') {
      const { query } = await import('../storage/postgres.js');
      const tradeCheck = await query(
        `SELECT id, message_url FROM trades WHERE (sender_id = $1 OR target_id = $1) AND status = 'pending' AND expires_at > NOW() AND guild_id = $2`,
        [interaction.user.id, interaction.guildId]
      );
      
      if (tradeCheck.rows.length > 0) {
        const trade = tradeCheck.rows[0];
        const tradeLink = trade.message_url ? `[pending trade](${trade.message_url})` : 'pending trade';
        const lockMsg = `❌ You can't drop items when you have a ${tradeLink}.`;
        if (interaction.deferred || interaction.replied) return interaction.followUp({ content: lockMsg, flags: 64 });
        return interaction.reply({ content: lockMsg, flags: 64 });
      }
    }

    // --- 1. DROP (Step 1: Show quantity modal) ---
    // IMPORTANT: showModal() MUST be called on the original non-deferred interaction.
    // We do NOT defer here — we run our validation synchronously then call showModal.
    if (action === 'drop') {
      // Trade lock check (without deferring)
      // (Already handled above in the combined action guard)

      const [item] = await query(
        `SELECT si.name, si.duration_seconds, si.duration_hours, si.is_tradable, ui.expires_at, COALESCE(ui.quantity, 1) as quantity
         FROM user_inventory ui 
         JOIN shop_items si ON ui.shop_item_id = si.id 
         WHERE ui.id = $1`,
        [invId]
      ).then(r => r.rows);

      if (!item) {
        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => { });
        return interaction.followUp({ content: '\u274C Item not found.', flags: MessageFlags.Ephemeral });
      }

      const isTemp = !!(item.expires_at || (item.duration_seconds && item.duration_seconds > 0) || (item.duration_hours && item.duration_hours > 0));
      if (isTemp) {
        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => { });
        return interaction.followUp({ content: '\u274C This item is temporary and cannot be dropped.', flags: MessageFlags.Ephemeral });
      }

      if (item.is_tradable === false) {
        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => { });
        return interaction.followUp({ content: '\u274C This item is locked and cannot be dropped.', flags: MessageFlags.Ephemeral });
      }

      const currentQty = parseInt(item.quantity) || 1;

      // Show the quantity modal directly on the original interaction (no defer!)
      const modal = new ModalBuilder()
        .setCustomId(`bank_inv_drop_qty_${invId}_${catIdStr}_${currentIndex}`)
        .setTitle(`Drop: ${item.name}`);

      const qtyInput = new TextInputBuilder()
        .setCustomId('drop_quantity')
        .setLabel(`How many? You have ${currentQty} cop${currentQty === 1 ? 'y' : 'ies'}`)
        .setPlaceholder(`Enter 1 to ${currentQty}`)
        .setValue(String(currentQty))
        .setMinLength(1)
        .setMaxLength(3)
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(qtyInput));
      return await interaction.showModal(modal);
    }


    // --- 1.5. DROP CANCEL (Go back to management) ---
    if (action === 'dropcancel') {
      return handleInventoryItemSelect(interaction);
    }

    // --- 2. DROP CONFIRM (Step 2: Execution & Public Post) ---
    // This is now triggered by modal submission (handleInventoryDropModalSubmit), not a button.
    // Kept for backwards compatibility with any in-flight dropconfirm button clicks.
    if (action === 'dropconfirm') {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

      if (interaction.message && interaction.message.editable) {
        const disabledRows = interaction.message.components.map(row => {
          const newRow = ActionRowBuilder.from(row);
          newRow.components.forEach(c => c.setDisabled(true));
          return newRow;
        });
        await interaction.editReply({ components: disabledRows }).catch(() => { });
      }

      // Execute with qty=1 (legacy confirm button path)
      const res = await dropItem(interaction.user.id, interaction.guildId, invId, interaction.member, 1);

      if (res.success) {
        const expiresUnix = Math.floor((Date.now() + 24 * 60 * 60 * 1000) / 1000);
        const droppedShopItem = await getShopItem(res.item.shop_item_id || res.item.id);
        const dropImg = getItemImage(droppedShopItem);
        const droppedQty = res.quantity || 1;
        const droppedLabel = droppedQty > 1 ? `${droppedQty}x ${res.item.name}` : res.item.name;

        const publicEmbed = new EmbedBuilder()
          .setTitle('\uD83D\uDCE6 Item Dropped!')
          .setColor('#F1C40F')
          .setDescription(`${interaction.user} dropped **${droppedLabel}** <@&${res.item.role_id}>!`)
          .setTimestamp();

        if (dropImg) publicEmbed.setImage(dropImg);

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`bank_item_claim_${res.dropId}`)
            .setLabel(droppedQty > 1 ? `Claim All ${droppedQty}x` : 'Claim Item')
            .setEmoji('\uD83C\uDF81')
            .setStyle(ButtonStyle.Success)
        );

        const publicMsg = await interaction.channel.send({ embeds: [publicEmbed], components: [row] });
        await query('UPDATE dropped_items SET message_id = $1, channel_id = $2 WHERE id = $3',
          [publicMsg.id, interaction.channelId, res.dropId]);

        sysLog('Item Dropped', { user: interaction.user.id, guild: interaction.guildId, detail: `Item: ${droppedLabel} | DropID: ${res.dropId}` });

        const backRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('bank_inventory')
            .setLabel('Back to Inventory')
            .setEmoji('\uD83C\uDF92')
            .setStyle(ButtonStyle.Secondary)
        );

        await interaction.editReply({
          content: `\u2705 **${droppedLabel}** dropped successfully!`,
          embeds: [],
          components: [backRow]
        });

        sendLog(interaction.guild, 'inventory', 'orange', '\uD83D\uDDD1\uFE0F Item Dropped',
          `**${getUserLogName(interaction.member)}** dropped **${droppedLabel}** in <#${interaction.channelId}>.\nDrop ID: \`${res.dropId}\``);
      }
      return;
    }

    // --- 4. EQUIP / ACTIVATE (Toggle Logic) ---
    if (action === 'equip') {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
      const result = await toggleEquipItem(interaction.user.id, interaction.guildId, invId, interaction.member);

      if (!result.success) {
        return interaction.followUp({ content: `❌ ${result.error}`, flags: MessageFlags.Ephemeral });
      }

      // Refresh the inventory view to show updated status
      return handleInventoryItemSelect(interaction);
    }

  } catch (error) {
    sysError('Inventory Action Error', error, { user: interaction.user.id, guild: interaction.guildId });
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: `❌ Error: ${error.message}`, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.followUp({ content: `❌ Error: ${error.message}`, flags: MessageFlags.Ephemeral });
    }
  }
}

/**
 * Handle public Claim button clicking
 */
export async function handleItemClaim(interaction) {
  try {
    const parts = interaction.customId.split('_');
    const isForce = interaction.customId.startsWith('force_claim_');
    const dropId = isForce ? parts[2] : parts[3];

    // ===========================================
    // STEP 0: Interstitial Prerequisite Check
    // ===========================================
    if (!isForce) {
      const { checkPrerequisites } = await import('../economy/shop.js');
      const dropRes = await query('SELECT shop_item_id FROM dropped_items WHERE id = $1', [dropId]);

      if (dropRes.rows.length > 0) {
        const itemRes = await query('SELECT required_items FROM shop_items WHERE id = $1', [dropRes.rows[0].shop_item_id]);
        if (itemRes.rows.length > 0 && itemRes.rows[0].required_items) {
          const prereqs = await checkPrerequisites(interaction.member, interaction.guildId, itemRes.rows[0].required_items);
          if (!prereqs.met) {
            const warnRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`force_claim_${dropId}`)
                .setLabel('Claim Anyway')
                .setEmoji('\u26A0\uFE0F')
                .setStyle(ButtonStyle.Danger)
            );

            sysLog('Prereq Warning Triggered', {
              user: interaction.user.id,
              guild: interaction.guildId,
              detail: `Action: ItemClaim | DropID: ${dropId}`
            });

            return await interaction.reply({
              content: `\u274C You don't meet the requirements to equip this!`,
              components: [warnRow],
              flags: MessageFlags.Ephemeral
            });
          }
        }
      }
    }

    // 1. Initial acknowledgment (STRICT: Ephemeral-first to protect public messages)
    if (isForce) {
      await interaction.deferUpdate();
    } else if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }

    // Attempt Claim (Atomic Transaction in shop.js)
    let res;
    try {
        res = await claimItem(interaction.user.id, interaction.guildId, dropId, interaction.member);
    } catch (err) {
        // We let the original error flow handle the ephemeral message to the user.
        // We do NOT disable or modify the public button here. That happens only on success.
        throw err;
    }

    if (res.success) {
      const isSelfClaim = res.item.dropper_id === interaction.user.id;
      const claimerName = getUserDisplayName(interaction.user);
      const claimedQty = res.quantity || 1;
      const claimLabel = claimedQty > 1 ? `${claimedQty}x ${res.item.name}` : res.item.name;

      // 1. Success Message to Claimer (PRIVATE)
      const successMsg = isSelfClaim
        ? `\u2705 You have reclaimed your own dropped **${claimLabel}**!`
        : `\u2705 You have successfully claimed **${claimLabel}**!`;
      
      await interaction.editReply({ content: successMsg }).catch(() => { });

      // 2. Update Public Message
      // Find the public message (even if we're on a private warning interaction)
      let publicMsg = null;
      if (!isForce && interaction.message) {
        publicMsg = interaction.message;
      } else if (res.item.channel_id && res.item.message_id) {
        const channel = await interaction.guild.channels.fetch(res.item.channel_id).catch(() => null);
        if (channel) {
          publicMsg = await channel.messages.fetch(res.item.message_id).catch(() => null);
        }
      }

      if (publicMsg && publicMsg.embeds && publicMsg.embeds.length > 0) {
        const originalDesc = publicMsg.embeds[0].description || '';
        const firstLine = originalDesc.split('\n')[0];

        const resolutionLine = isSelfClaim
          ? `\u2705 ${interaction.user} changed their mind and claimed their own drop of **${claimLabel}**!`
          : `\u2705 ${interaction.user} claimed **${claimLabel}**!`;

        const newDesc = `${firstLine}\n\n${resolutionLine}`;

        const claimedEmbed = EmbedBuilder.from(publicMsg.embeds[0])
          .setColor(isSelfClaim ? '#3498DB' : '#2ECC71')
          .setDescription(newDesc)
          .setTimestamp(new Date(res.dropped_at));

        const lockedRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`bank_item_claimed_locked_${dropId}`)
            .setLabel('Claim Item')
            .setEmoji('🎁')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true)
        );

        await publicMsg.edit({ 
            embeds: [claimedEmbed], 
            components: [lockedRow] 
        }).catch(err => {
            sysError('Failed to disable public claim button', err, { guild: interaction.guildId });
        });
      }

      // 3. Log Audit
      sendLog(interaction.guild, 'inventory', 'green', '🎁 Item Picked Up', `**${getUserLogName(interaction.member)}** picked up **${res.item.name}**.\nDrop ID: \`${dropId}\``);
    }
  } catch (error) {
    const errorMsgStr = error.message || '';
    const isAlreadyOwned = errorMsgStr.includes('already own');
    const errorMessage = isAlreadyOwned ? `❕ You already have that item.` : `❌ ${error.message}`;

    // DISTINGUISH: Validation Errors (User fault) vs System Errors (Bot fault)
    const isValidationError = errorMsgStr.includes('server for at least') ||
      errorMsgStr.includes('already been claimed') ||
      isAlreadyOwned;

    if (isValidationError) {
      // Log as moderate warning/info to avoid "Red" logs on Railway for normal user behavior
      sysLog('Claim Denied', { user: interaction.user.id, guild: interaction.guildId, detail: errorMsgStr });
    } else {
      // TRUE System Error: Log as error for investigation
      sysError('Critical Claim Error', error, { user: interaction.user.id, guild: interaction.guildId });
    }

    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: errorMessage, flags: MessageFlags.Ephemeral }).catch(() => { });
    } else {
      // Private error response (Interaction is ephemeral-deferred)
      // Clear components so the "Claim Anyway" button vanishes on error
      await interaction.editReply({ content: errorMessage, components: [] }).catch(() => { });
    }
  }
}


// --- Legacy Handlers from previous file (History, Transfer) ---
// Re-implement or copy them.

export async function handleBankHistory(interaction) {
  try {
    await interaction.deferUpdate();
    let page = 0;
    if (interaction.customId.startsWith('history_page_')) {
      page = parseInt(interaction.customId.replace('history_page_', ''));
      if (isNaN(page)) page = 0;
    }
    const LIMIT = 15;
    const MAX_PAGE = 4;
    const offset = page * LIMIT;
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM transactions 
       WHERE guild_id = $1 AND user_id = $2 
       ORDER BY created_at DESC 
       LIMIT $3 OFFSET $4`,
      [interaction.guildId, interaction.user.id, LIMIT, offset]
    );
    const backRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('bank_back').setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary)
    );
    const navRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`history_page_${page - 1}`).setLabel('Previous').setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
      new ButtonBuilder().setCustomId(`history_page_${page + 1}`).setLabel('Next').setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(page >= MAX_PAGE || result.rowCount < LIMIT)
    );

    if (result.rowCount === 0) {
      const emptyEmbed = new EmbedBuilder().setColor(0x808080).setTitle('📜 Recent History').setDescription('No transactions found.').setFooter({ text: `Page ${page + 1}/${MAX_PAGE + 1}` });
      await interaction.editReply({ content: null, embeds: [emptyEmbed], components: [navRow, backRow] });
      return;
    }
    const { getCairoDateString } = await import('../utils/time.js');
    const lines = result.rows.map(tx => {
      const date = getCairoDateString(new Date(tx.created_at)).replace(/-/g, '/');

      const amountVal = parseInt(tx.amount);
      let amountDisplay;
      if (amountVal > 0) amountDisplay = `**+${amountVal}**`;
      else if (amountVal < 0) amountDisplay = `**${amountVal}**`;
      else amountDisplay = `**0**`;

      // Format IDs to mentions if they look like User IDs (17-19 digits) and aren't already mentioned
      // Added digit boundaries (?<!\d) and (?!\d) to prevent suffix-matching bugs
      let desc = tx.description.replace(/(?<!<@)(?<!<@&)(?<!\d)(\d{17,19})(?!\d)(?!>)/g, '<@$1>');
      // Normalize legacy MVP text to generic form
      desc = desc.replace(/Won MVP of the Day/gi, 'Won the MVP award')
        .replace(/MVP of the Day reward/gi, 'Won the MVP award');
      return `\`${date}\` ${amountDisplay} | ${desc}`;
    });
    const embed = new EmbedBuilder().setColor(0x808080).setTitle('📜 Recent History').setDescription(lines.join('\n')).setFooter({ text: `Page ${page + 1}/${MAX_PAGE + 1}` });
    await interaction.editReply({ content: null, embeds: [embed], components: [navRow, backRow] });
  } catch (error) {
    sysError('History interaction failure', error, { user: interaction.user.id, guild: interaction.guildId });
  }
}



export async function handleBackButton(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => { });
    }
    await refreshBankUI(interaction);
  } catch (error) {
    sysError('Back button interaction failure', error, { user: interaction.user.id, guild: interaction.guildId });
  }
}

export async function handleBankRefresh(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => { });
    }
    await refreshBankUI(interaction);
  } catch (error) {
    await handleInteractionError(interaction, error, 'Bank refresh button');
  }
}

/**
 * Background Expiration Sweeper for Dropped Items
 * Mark items as expired after 24 hours and update Discord messages.
 * Rate-limited to 5 per run to avoid spikes.
 */
export async function cleanupExpiredDrops(client) {
  try {
    const pool = getPool();
    // 1. Fetch expired available drops (older than 24h)
    const expiredRes = await pool.query(
      `SELECT d.*, si.name 
       FROM dropped_items d
       JOIN shop_items si ON d.shop_item_id = si.id
       WHERE d.status = 'available'
         AND d.created_at < NOW() - INTERVAL '24 hours'
       LIMIT 5`
    );

    if (expiredRes.rows.length === 0) return;

    for (const drop of expiredRes.rows) {
      try {
        // 2. Fetch Channel & Message to update UI
        if (drop.channel_id && drop.message_id) {
          const channel = await client.channels.fetch(drop.channel_id).catch(() => null);
          if (channel && channel.isTextBased()) {
            const message = await channel.messages.fetch(drop.message_id).catch(() => null);
            if (message && message.embeds.length > 0) {
              const oldEmbed = message.embeds[0];
              const firstLine = oldEmbed.description?.split('\n')[0] || `An item was dropped.`;

              const expiredEmbed = EmbedBuilder.from(oldEmbed)
                .setColor('#2C2F33') // Dark Grey
                .setDescription(`${firstLine}\n\n⏰ This item has expired and the drop was lost.`)
                .setTimestamp(new Date(drop.created_at));

              // Disable the claim button
              const disabledRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                  .setCustomId(`bank_item_expired_${drop.id}`)
                  .setLabel('Expired')
                  .setEmoji('⏰')
                  .setStyle(ButtonStyle.Secondary)
                  .setDisabled(true)
              );

              await message.edit({ embeds: [expiredEmbed], components: [disabledRow] }).catch(() => { });
            }
          }
        }

        // 3. Mark as expired in DB
        await pool.query("UPDATE dropped_items SET status = 'expired' WHERE id = $1", [drop.id]);
        sysLog('Drop Expired', { guild: drop.guild_id, detail: `DropID: ${drop.id} | Item: ${drop.name}` });

      } catch (err) {
        sysError('Drop expiration processing failure', err, { guild: drop.guild_id, detail: `DropID: ${drop.id}` });
        // Mark as error so it doesn't loop forever if message is deleted/unreachable
        await pool.query("UPDATE dropped_items SET status = 'expired_error' WHERE id = $1", [drop.id]);
      }
    }
  } catch (error) {
    sysError('Background drop cleanup failure', error);
  }
}

/**
 * Modal submission handler for the inventory drop quantity modal.
 * customId: bank_inv_drop_qty_[invId]_[catIdStr]_[currentIndex]
 */
export async function handleInventoryDropModalSubmit(interaction) {
  try {
    const parts = interaction.customId.split('_');
    // bank(0) inv(1) drop(2) qty(3) [invId](4) [catIdStr](5) [currentIndex](6)
    const invId = parseInt(parts[4]);
    const catIdStr = parts[5] || 'null';
    const currentIndex = parseInt(parts[6]) || 0;

    const rawQty = interaction.fields.getTextInputValue('drop_quantity');
    const qty = parseInt(rawQty, 10);

    if (isNaN(qty) || qty < 1 || qty > 999) {
      return interaction.reply({
        content: '\u274C Please enter a valid quantity (1 or more).',
        flags: MessageFlags.Ephemeral
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Trade lock check before executing
    const { query: dbQuery } = await import('../storage/postgres.js');
    const tradeCheck = await dbQuery(
      `SELECT id FROM trades WHERE (sender_id = $1 OR target_id = $1) AND status = 'pending' AND expires_at > NOW() AND guild_id = $2`,
      [interaction.user.id, interaction.guildId]
    );
    if (tradeCheck.rows.length > 0) {
      return interaction.editReply({ content: '\u274C You cannot drop items while you have a pending trade.' });
    }

    const res = await dropItem(interaction.user.id, interaction.guildId, invId, interaction.member, qty);

    if (!res.success) {
      return interaction.editReply({ content: `\u274C ${res.error || 'Drop failed.'}` });
    }

    const droppedQty = res.quantity || qty;
    const droppedLabel = droppedQty > 1 ? `${droppedQty}x ${res.item.name}` : res.item.name;

    // Fetch shop item for image
    const droppedShopItem = await getShopItem(res.item.shop_item_id || res.item.id);
    const dropImg = getItemImage(droppedShopItem);

    const publicEmbed = new EmbedBuilder()
      .setTitle('\uD83D\uDCE6 Item Dropped!')
      .setColor('#F1C40F')
      .setDescription(`${interaction.user} dropped **${droppedLabel}** <@&${res.item.role_id}>!`)
      .setTimestamp();

    if (dropImg) publicEmbed.setImage(dropImg);

    const claimRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`bank_item_claim_${res.dropId}`)
        .setLabel(droppedQty > 1 ? `Claim All ${droppedQty}x` : 'Claim Item')
        .setEmoji('\uD83C\uDF81')
        .setStyle(ButtonStyle.Success)
    );

    const publicMsg = await interaction.channel.send({ embeds: [publicEmbed], components: [claimRow] });
    await query('UPDATE dropped_items SET message_id = $1, channel_id = $2 WHERE id = $3',
      [publicMsg.id, interaction.channelId, res.dropId]);

    sysLog('Item Dropped (Modal)', { user: interaction.user.id, guild: interaction.guildId, detail: `Item: ${droppedLabel} | DropID: ${res.dropId}` });

    sendLog(interaction.guild, 'inventory', 'orange', '\uD83D\uDDD1\uFE0F Item Dropped',
      `**${getUserLogName(interaction.member)}** dropped **${droppedLabel}** in <#${interaction.channelId}>.\nDrop ID: \`${res.dropId}\``);

    const backRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('bank_inventory')
        .setLabel('Back to Inventory')
        .setEmoji('\uD83C\uDF92')
        .setStyle(ButtonStyle.Secondary)
    );

    return interaction.editReply({
      content: `\u2705 **${droppedLabel}** dropped successfully!`,
      components: [backRow]
    });

  } catch (error) {
    sysError('Drop Modal Submit Error', error, { user: interaction.user.id, guild: interaction.guildId });
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: `\u274C Error: ${error.message}` });
      } else {
        await interaction.reply({ content: `\u274C Error: ${error.message}`, flags: MessageFlags.Ephemeral });
      }
    } catch (_) { }
  }
}

