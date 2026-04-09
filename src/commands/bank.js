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
import { logServerEvent, sendLog } from '../utils/logger.js';
import { claimDaily } from '../economy/service.js';
import { isMemberBooster } from './colors.js';
import { hasClaimedToday, isStreakValid, getNextCairoMidnight } from '../utils/time.js';
import { getUserDisplayName, getUserLogName, COIN_EMOJI, sanitizeError } from '../shared.js';
import {
  getShopCategories,
  getShopItems,
  getShopItem,
  purchaseItem,
  getUserInventory,
  syncInventoryWithDiscord,
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

/**
 * Unified Helper: Fetch DB inventory and synthesize live Admin-Granted items (State C)
 * Ensures consistency between Main Menu counts, Category Lists, and Item Management.
 */
async function getSynthesizedInventory(userId, guildId, member) {
  if (!member) return [];

  // 1. Fetch DB Items (Owned/Purchased)
  const dbInventory = await syncInventoryWithDiscord(userId, guildId, member);
  const dbShopIds = new Set(dbInventory.map(i => i.shop_item_id));

  // 2. Fetch Shop Items to check for live Role-based items (Admin Granted)
  const allShopItems = await getShopItems(guildId, null, 'name', true);
  const adminItems = [];

  for (const shopItem of allShopItems) {
    if (!shopItem.role_id) continue;
    const firstRoleId = shopItem.role_id.split(/[,\s]+/)[0];

    // State C: User has the role in Discord but doesn't own it in the DB
    if (member.roles.cache.has(firstRoleId) && !dbShopIds.has(shopItem.id)) {
      adminItems.push({
        ...shopItem,
        id: `admin_${shopItem.id}`, // Virtual ID for State Anchoring
        shop_item_id: shopItem.id,
        source: 'SYNC',
        is_active: true, // Always active for roles
        price: 0,
        purchased_at: new Date()
      });
    }
  }

  // Final Merged List
  return [...dbInventory, ...adminItems];
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
    .setTitle('🏛️ OverKill Bank')
    .setDescription(`Welcome to your personal bank account, <@${member.id}>!`)
    .setThumbnail(BANK_THUMBNAIL_URL)
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

  const row = new ActionRowBuilder()
    .addComponents(dailyButton, historyButton);

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
    console.error('Error in /bank command:', error);
    await interaction.editReply({ content: '❌ An error occurred.' });
  }
}

export async function handleBankDaily(interaction) {
  // FORCE REFRESH: Ensuring interaction is deferred immediately to prevent 'InteractionNotReplied' errors.
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => {});
    }
  } catch (err) {
    console.log('[System] DeferUpdate failed (ignoring):', err.message);
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
    sendLog(interaction.guild, 'economy', 'orange', '🎁 Rewards Claimed', 
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
    console.error('Error processing daily claim:', error);
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
    console.error('Shop error:', error);
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
    console.error('Shop cat select error:', error);
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
      .setEmoji('1490666813501997076')
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
    console.error('Item view error:', error);
  }
}

export async function handleShopBuyButton(interaction) {
  try {
    // 1. Defer Ephemeral (This is a private response to a public button)
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Parse customId: bank_shop_buy_[itemId]_[sellerId]_[payout]
    const parts = interaction.customId.split('_');
    const itemId = parseInt(parts[3]);
    const sellerId = parts[4] || '0';
    const payoutStr = parts[5] || '0';
    const customPayout = parseInt(payoutStr) || 0;

    const guildId = interaction.guildId;
    const userId = interaction.user.id;
    const member = interaction.member;
    const guildName = interaction.guild.name;
    const buyerName = interaction.user.username;

    // ===========================================
    // STEP 1: Calculate Seller Payout (Pre-check)
    // ===========================================
    const isSelfPurchase = sellerId !== '0' && sellerId === userId;
    const hasSeller = sellerId !== '0' && !isSelfPurchase;
    const itemForPrice = await getShopItem(itemId);
    const itemPrice = itemForPrice?.price || 0;

    let payoutAmount = 0;
    if (hasSeller) {
      const maxPayout = Math.floor(itemPrice * 0.5);
      payoutAmount = customPayout > 0 ? Math.min(customPayout, maxPayout) : maxPayout;
    }

    // ===========================================
    // STEP 2: Call purchaseItem (handles ALL validation + item granting + payout)
    // ===========================================
    const result = await purchaseItem(userId, guildId, itemId, member, { 
      sellerId, 
      payoutAmount 
    });

    // ===========================================
    // STEP 3: Live UI Refresh (Update original message on EVERY click)
    // ===========================================
    try {
      const updatedItem = await getShopItem(itemId, guildId);
      if (updatedItem && interaction.message) {
        const embed = EmbedBuilder.from(interaction.message.embeds[0]);
        
        // Update Stock field
        let stockHeader = '📦 Stock';
        let stockValue = 'Unlimited';
        if (updatedItem.stock !== null) {
          if (updatedItem.stock <= 0) {
            stockHeader = '🔴 Stock';
            stockValue = 'Sold Out';
            embed.setColor('#808080'); // Dark Grey for Sold Out
          } else {
            stockHeader = '🟢 Stock';
            stockValue = `**${updatedItem.stock}** Left`;
          }
        }
        
        // Update fields array while preserving others
        const updatedFields = (embed.data.fields || []).map(f => {
          if (f.name.includes('Stock')) {
            return { name: stockHeader, value: stockValue, inline: true };
          }
          return f;
        });
        embed.setFields(updatedFields);

        // Update Button State
        const isSoldOut = updatedItem.stock !== null && updatedItem.stock <= 0;
        const row = ActionRowBuilder.from(interaction.message.components[0]);
        const buyBtn = ButtonBuilder.from(row.components[0]);
        
        buyBtn.setDisabled(isSoldOut);
        if (isSoldOut) {
          buyBtn.setLabel('SOLD OUT').setStyle(ButtonStyle.Secondary).setEmoji('📦');
        }

        await interaction.message.edit({ 
          embeds: [embed], 
          components: [row] 
        }).catch(() => { /* original message might be deleted */ });
      }
    } catch (refreshErr) {
      console.error('[System] Live UI Refresh failed:', refreshErr);
    }

    if (!result.success) {
      // Handle specific errors with user-friendly messages
      if (result.error === 'Insufficient balance') {
        const userBalData = await getUserBalance(guildId, userId);
        const currentBal = parseInt(userBalData?.balance || 0);
        const missing = itemPrice - currentBal;
        return interaction.editReply({ content: `❌ You need **${missing}** ${COIN_EMOJI} more to buy this.` });
      } else if (result.error.includes('higher than my highest role')) {
        return interaction.editReply({ content: '❌ Error: I cannot assign this role. Please contact an admin.' });
      } else if (result.error.includes('already') || result.error.includes('expire')) {
        return interaction.editReply({ content: `❕ ${result.error}` });
      } else {
        return interaction.editReply({ content: `❌ ${result.error}` });
      }
    }

    // ===========================================
    // STEP 4: Success message
    // ===========================================
    let msg;
    if (result.packInfo && result.packInfo.ownedCount > 0) {
      msg = `✅ Bought ${result.packInfo.newCount} missing items from **${result.item.name}**! new balance: **${result.newBalance}** ${COIN_EMOJI}`;
    } else {
      msg = `✅ Bought **${result.item.name}**! new balance: **${result.newBalance}** ${COIN_EMOJI}`;
    }
    await interaction.editReply({ content: msg });

  } catch (error) {
    console.error('[System] Buy handler error:', error);
    await interaction.editReply({ content: '❌ An unexpected error occurred. Please try again.' }).catch(() => { });
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

    // ========== TWO-WAY SYNC (Admin Actions) ==========
    // 1. CLEANUP: Delete items where user lost the Discord role (Admin removed)
    // 2. DISCOVERY: Add items where user has Discord role but no DB entry (Admin added)
    // 3. Returns FRESH inventory after sync
    // Unified Fetch: Includes DB items + Live synthesis of admin roles
    const [inventory, categories, userBal] = await Promise.all([
      getSynthesizedInventory(userId, guildId, interaction.member),
      getShopCategories(guildId),
      getUserBalance(guildId, userId)
    ]);

    // ========== FILTER VISIBLE ITEMS ==========
    // Exclude packs (hidden from inventory view)
    const items = inventory.filter(i => i.item_type !== 'pack' && !i.is_pack);
    const totalCount = items.length;
    const currentBalance = parseInt(userBal.balance);

    // Count items per category (including admin-granted ones)
    const categoryCounts = {};
    let otherCount = 0;
    for (const item of items) {
      if (item.category_id) {
        categoryCounts[item.category_id] = (categoryCounts[item.category_id] || 0) + 1;
      } else {
        otherCount++;
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

    // 6. Build Category Buttons (All Blue/Primary, including "Other")
    const validCategories = categories.filter(c => validCategoryIds.includes(c.id));

    // Create button definitions - all categories are Blue
    const buttonDefs = validCategories.map(c => ({
      id: `bank_inv_cat_${c.id}`,
      label: c.name
    }));

    // "Other" is also Blue, treated like a category
    if (otherCount > 0) {
      buttonDefs.push({
        id: 'bank_inv_cat_null',
        label: 'Other'
      });
    }

    // Pagination Logic
    // Extract page from customId (e.g., bank_inv_page_1 or bank_inventory)
    // For slash commands, customId is undefined - default to page 0
    let page = 0;
    const customId = interaction.customId || '';
    if (customId.startsWith('bank_inv_page_')) {
      page = parseInt(customId.split('_').pop()) || 0;
    }

    const CATS_PER_PAGE = 4; // 4 categories per page (fits with arrows)
    const totalPages = Math.ceil(buttonDefs.length / CATS_PER_PAGE);

    // Ensure page is within bounds
    if (page < 0) page = 0;
    if (page >= totalPages && totalPages > 0) page = totalPages - 1;

    const startIdx = page * CATS_PER_PAGE;
    const pageButtons = buttonDefs.slice(startIdx, startIdx + CATS_PER_PAGE);

    // Build Single Row: [◀️?] [Cat1] [Cat2] [Cat3] [Cat4] [▶️?]
    const row = new ActionRowBuilder();

    // 1. Left Arrow - only if page > 0
    if (page > 0) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`bank_inv_page_${page - 1}`)
          .setEmoji('◀️')
          .setStyle(ButtonStyle.Secondary)
      );
    }

    // 2. Category Buttons - all Blue
    pageButtons.forEach(btn => {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(btn.id)
          .setLabel(btn.label)
          .setStyle(ButtonStyle.Primary)
      );
    });

    // 3. Right Arrow - only if more pages exist
    if (page < totalPages - 1) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`bank_inv_page_${page + 1}`)
          .setEmoji('▶️')
          .setStyle(ButtonStyle.Secondary)
      );
    }

    const rows = [];
    if (row.components.length > 0) rows.push(row);

    await interaction.editReply({
      content: null,
      embeds: [embed],
      components: rows
    });

  } catch (error) {
    console.error('Inventory Home Error:', error);
    if (!interaction.replied) await interaction.editReply({ content: '❌ Error loading inventory.' });
  }
}

/**
 * Helper: Sort inventory items by Discord role position (highest first)
 * Falls back to name sort for non-role items
 */
async function sortItemsByRolePosition(items, guild) {
  // Fetch all roles from cache
  const roleCache = guild.roles.cache;

  // Map items with their role position
  const itemsWithPosition = items.map(item => {
    let position = -1; // Default for non-role items
    if (item.role_id) {
      // Handle multi-role items (take first role's position)
      const firstRoleId = item.role_id.split(/[,\s]+/)[0];
      const role = roleCache.get(firstRoleId);
      if (role) {
        position = role.position;
      }
    }
    return { ...item, _rolePosition: position };
  });

  // Sort: highest role position first, then by name for non-roles
  itemsWithPosition.sort((a, b) => {
    // Both have roles - sort by position (higher first)
    if (a._rolePosition >= 0 && b._rolePosition >= 0) {
      return b._rolePosition - a._rolePosition;
    }
    // Only one has role - role items first
    if (a._rolePosition >= 0) return -1;
    if (b._rolePosition >= 0) return 1;
    // Neither has role - sort by name
    return (a.name || '').localeCompare(b.name || '');
  });

  // Filter out items with deleted roles (ghost roles)
  return itemsWithPosition.filter(item => {
    if (!item.role_id) return true; // Keep non-role items
    const firstRoleId = item.role_id.split(/[,\s]+/)[0];
    return roleCache.has(firstRoleId); // Only keep if role exists
  });
}

// VIEW 2: Category Content View
export async function handleInventoryCategorySelect(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => {});
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
      // Category is empty - build main inventory directly with fresh data
      const activeItems = inventory.filter(i => i.item_type !== 'pack' && !i.is_pack);
      const totalCount = activeItems.length;
      const userBal = await getUserBalance(interaction.guildId, interaction.user.id);
      const currentBalance = parseInt(userBal.balance);

      // Count items per category
      const categoryCounts = {};
      let otherCount = 0;
      for (const item of activeItems) {
        if (item.category_id) {
          categoryCounts[item.category_id] = (categoryCounts[item.category_id] || 0) + 1;
        } else {
          otherCount++;
        }
      }

      const validCategoryIds = Object.keys(categoryCounts).map(Number);
      const validCategories = categories.filter(c => validCategoryIds.includes(c.id));

      const embed = new EmbedBuilder()
        .setTitle('🎒 Inventory')
        .setColor('#3498DB')
        .setDescription(`${COIN_EMOJI} **Balance:** ${currentBalance.toLocaleString()}   📦 **Total Items:** ${totalCount}`);

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

    // Get Category Name
    let categoryName = 'Other';
    if (!isOther) {
      const cat = categories.find(c => c.id === categoryId);
      if (cat) categoryName = cat.name;
    }

    // Build List with role mentions and correct emojis for temp vs perm
    const listLines = items.map(i => {
      const nameDisplay = i.role_id ? `<@&${i.role_id.split(/[,\s]+/)[0]}>` : `**${i.name}**`;
      const isAdminIdentified = i.source === 'SYNC';
      const isTemp = !!(i.expires_at || 
                      (i.duration_seconds && i.duration_seconds > 0) || 
                      (i.duration_hours && i.duration_hours > 0));
      
      let statusEmoji = '⬜';
      if (isAdminIdentified) {
        statusEmoji = '🛡️';
      } else if (isTemp) {
        statusEmoji = i.is_active ? '🟢' : '⚪';
      } else {
        statusEmoji = i.is_active ? '✅' : '⬜';
      }

      return `${statusEmoji} ${nameDisplay}`;
    });

    const embed = new EmbedBuilder()
      .setTitle(`📂 Category: ${categoryName}`)
      .setColor('#2ECC71')
      .setDescription(listLines.slice(0, 20).join('\n') + (listLines.length > 20 ? `\n...and ${listLines.length - 20} more` : ''));

    const select = new StringSelectMenuBuilder()
      .setCustomId(`bank_inv_item_select_${isOther ? 'null' : categoryId}`)
      .setPlaceholder('Select an Item to Manage')
      .addOptions(items.slice(0, 25).map((i, idx) => {
        // Check if item is temporary (has duration/expiry) or permanent
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
          
        return {
          label: (i.name && i.name.trim().length > 0) ? i.name.slice(0, 80) : `Unnamed Item #${i.id}`,
          value: `${i.id}_${idx}`,
          description: statusText,
          emoji: statusEmoji
        };
      }));

    const row1 = new ActionRowBuilder().addComponents(select);

    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('bank_inventory')
        .setLabel('Back')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('⬅️')
    );

    await interaction.editReply({
      content: null,
      embeds: [embed],
      components: [row1, row2]
    });

  } catch (error) {
    console.error('Category View Error:', error);
    await interaction.editReply({ content: '❌ Error loading category.' });
  }
}

// VIEW 3: Item Management Panel with Carousel Navigation
export async function handleInventoryItemSelect(interaction) {
  try {
    // 1. Force immediate acknowledgment to prevent "Interaction Failed"
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => {});
    }

    // Parse interaction data
    // From select menu: value = "invId_index", customId = "bank_inv_item_select_categoryId"
    // From carousel nav: customId = "inv_nav_categoryId_index_prev/next"

    let categoryId, currentIndex, invId;

    if (interaction.values) {
      // From select menu: value = "invId_index"
      const [itemId, idx] = interaction.values[0].split('_');
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

      const activeItems = [...dbInventory, ...adminItems].filter(i => i.item_type !== 'pack' && !i.is_pack);
      const totalCount = activeItems.length;
      const currentBalance = parseInt(userBal.balance);

      // Count items per category
      const categoryCounts = {};
      let otherCount = 0;
      for (const item of activeItems) {
        if (item.category_id) {
          categoryCounts[item.category_id] = (categoryCounts[item.category_id] || 0) + 1;
        } else {
          otherCount++;
        }
      }

      const validCategoryIds = Object.keys(categoryCounts).map(Number);
      const validCategories = categories.filter(c => validCategoryIds.includes(c.id));

      const embed = new EmbedBuilder()
        .setTitle('🎒 Inventory')
        .setColor('#3498DB')
        .setDescription(`${COIN_EMOJI} **Balance:** ${currentBalance.toLocaleString()}   📦 **Total Items:** ${totalCount}`);

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
        currentIndex = currentIndex <= 0 ? items.length - 1 : currentIndex - 1; // Loop to end
      } else if (direction === 'next') {
        currentIndex = currentIndex >= items.length - 1 ? 0 : currentIndex + 1; // Loop to start
      }
    }

    // Ensure index is valid
    if (currentIndex >= items.length) currentIndex = 0;
    if (currentIndex < 0) currentIndex = items.length - 1;

    const item = items[currentIndex];
    if (!item) return interaction.editReply({ content: '❌ Item not found.' });

    // Get role color for embed
    let embedColor = '#3498DB'; // Default blue
    if (item.role_id) {
      const firstRoleId = item.role_id.split(/[,\s]+/)[0];
      const role = interaction.guild.roles.cache.get(firstRoleId);
      if (role && role.color) {
        embedColor = role.hexColor;
      }
    }

    // Build description
    const firstRoleId = item.role_id ? item.role_id.split(/[,\s]+/)[0] : null;

    // Check source: SHOP = paid, SYNC = admin-granted
    const source = item.source || 'SYNC';
    const isAdminGranted = source === 'SYNC';
    const purchasedAt = new Date(item.purchased_at);

    // Check if item is temporary (has duration/expiry) or permanent
    const isTemp = !!(item.expires_at ||
      (item.duration_seconds && item.duration_seconds > 0) ||
      (item.duration_hours && item.duration_hours > 0));

    let desc = `**Item:** ${firstRoleId ? `<@&${firstRoleId}>` : item.name}\n` +
      `**Value:** ${item.price} ${COIN_EMOJI}`;

    // Show acquisition info (Purchased vs Admin-Granted)
    if (isAdminGranted) {
      const joinDate = interaction.member.joinedAt || new Date();
      desc += `\n**Acquired:** <t:${Math.floor(joinDate.getTime() / 1000)}:D>`;
    } else {
      desc += `\n**Acquired:** <t:${Math.floor(purchasedAt.getTime() / 1000)}:D>`;
    }

    // Show status with dynamic text based on item type and source
    if (isAdminGranted) {
      desc += `\n**Status:** 🛡️ Admin Granted`;
    } else if (isTemp) {
      desc += `\n**Status:** ${item.is_active ? '✅ Active' : '⬜ Inactive'}`;
    } else {
      desc += `\n**Status:** ${item.is_active ? '✅ Equipped' : '⬜ Unequipped'}`;
    }

    // STRICT MODIFIABILITY RULES:
    // 1. Owned Items (non-temp) = Fully Modifiable
    // 2. Admin Granted = Not Modifiable
    // 3. Owned Temporary Items = Half Modifiable (Toggle OK, Drop NO)
    const cannotSell = isAdminGranted || isTemp; // Drop DISABLED for temp
    const cannotToggle = isAdminGranted;        // Toggle ENABLED for temp

    if (item.expires_at) {
      desc += `\n⏳ **Expires:** <t:${Math.floor(new Date(item.expires_at).getTime() / 1000)}:R>`;
    }

    // Title with pagination: "Manage: Name (X / Y)"
    const embed = new EmbedBuilder()
      .setTitle(`Manage: ${item.name} (${currentIndex + 1} / ${items.length})`)
      .setColor(embedColor)
      .setDescription(desc);

    // Description set, footer removed as requested for cleaner UI

    const catIdStr = isOther ? 'null' : categoryId;
    const hasMultipleItems = items.length > 1;

    // ROW 1 (Top): Actions [🗑️ Drop] [✅ Equip/Unequip]
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
    const toggleLabel = isTemp
      ? (item.is_active ? 'Deactivate' : 'Activate')
      : (item.is_active ? 'Unequip' : 'Equip');
    
    // Icon Logic: Use 🛡️ for Admin or 🔒 for locked Drop action
    const lockEmoji = '🛡️'; // Used for fully locked Admin items
    const toggleEmoji = item.is_active ? '⏸️' : '✅';
 
    row1.addComponents(
      new ButtonBuilder()
        .setCustomId(`bank_inv_equip_${item.id}_${catIdStr}_${currentIndex}`)
        .setLabel(toggleLabel)
        .setEmoji(cannotToggle ? lockEmoji : toggleEmoji)
        .setStyle(item.is_active ? ButtonStyle.Secondary : ButtonStyle.Success)
        .setDisabled(cannotToggle)
    );

    // ROW 2 (Bottom): Navigation [Back] [◀️] [▶️]
    const row2 = new ActionRowBuilder();

    // [Back]
    row2.addComponents(
      new ButtonBuilder()
        .setCustomId(`bank_inv_cat_${catIdStr}`)
        .setLabel('Back')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary)
    );

    // [◀️]
    row2.addComponents(
      new ButtonBuilder()
        .setCustomId(`inv_nav_${catIdStr}_${currentIndex}_prev`)
        .setEmoji('◀️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!hasMultipleItems)
    );

    // [▶️]
    row2.addComponents(
      new ButtonBuilder()
        .setCustomId(`inv_nav_${catIdStr}_${currentIndex}_next`)
        .setEmoji('▶️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!hasMultipleItems)
    );

    await interaction.editReply({
      content: null,
      embeds: [embed],
      components: [row1, row2]
    });

  } catch (error) {
    console.error('Item Manage Error:', error);
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

    // --- 1. DROP (Step 1: Ephemeral Confirmation) ---
    if (action === 'drop') {
      const [item] = await query(
        `SELECT si.name, si.duration_seconds, si.duration_hours, ui.expires_at 
         FROM user_inventory ui 
         JOIN shop_items si ON ui.shop_item_id = si.id 
         WHERE ui.id = $1`,
        [invId]
      ).then(r => r.rows);

      if (!item) return interaction.reply({ content: '❌ Item not found.', flags: [64] });

      // STRICT: Block any non-permanent item from being dropped
      const isTemp = !!(item.expires_at || (item.duration_seconds && item.duration_seconds > 0) || (item.duration_hours && item.duration_hours > 0));
      if (isTemp) {
        return interaction.reply({ content: '❌ This item is temporary and cannot be dropped.', flags: [64] });
      }

      const confirmEmbed = new EmbedBuilder()
        .setTitle('⚠️ Confirm Drop')
        .setColor('#E74C3C')
        .setDescription(`Are you sure you want to drop **${item.name}** in this channel?\n\n` +
          `• Anyone will be able to claim it.\n` +
          `• It will be **immediately removed** from your inventory.\n` +
          `• Dropping is permanent (unless you claim it back before others do).`);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`bank_inv_dropcancel_${invId}_${catIdStr}_${currentIndex}`)
          .setLabel('No, Cancel')
          .setEmoji('❌')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`bank_inv_dropconfirm_${invId}_${catIdStr}_${currentIndex}`)
          .setLabel('Yes, Drop it')
          .setEmoji('✅')
          .setStyle(ButtonStyle.Danger)
      );

      return interaction.update({ embeds: [confirmEmbed], components: [row] });
    }

    // --- 1.5. DROP CANCEL (Go back to management) ---
    if (action === 'dropcancel') {
      return handleInventoryItemSelect(interaction);
    }

    // --- 2. DROP CONFIRM (Step 2: Execution & Public Post) ---
    if (action === 'dropconfirm') {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

      // Execute the drop logic (Atomically deletes from DB and removes role)
      const res = await dropItem(interaction.user.id, interaction.guildId, invId, interaction.member);

      if (res.success) {
        // Post PUBLIC claim message
        const expiresUnix = Math.floor((Date.now() + 24 * 60 * 60 * 1000) / 1000);
        const publicEmbed = new EmbedBuilder()
          .setTitle('Item Dropped!')
          .setColor('#F1C40F')
          .setDescription(`**${getUserDisplayName(interaction.user)}** dropped **${res.item.name}** (<@&${res.item.role_id}>)!\n\nExpires: <t:${expiresUnix}:R>`);

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`bank_item_claim_${res.dropId}`)
            .setLabel('Claim Item')
            .setEmoji('🎁')
            .setStyle(ButtonStyle.Success)
        );

        const publicMsg = await interaction.channel.send({ embeds: [publicEmbed], components: [row] });

        // Update the drop record with message IDs for 24h expiration/edits
        await query('UPDATE dropped_items SET message_id = $1, channel_id = $2 WHERE id = $3', 
          [publicMsg.id, interaction.channelId, res.dropId]);

        // Standardized console audit
        console.log(`[${interaction.guild.name}] [Inventory] ${interaction.user.tag} dropped ${res.item.name}`);

        // Cleanup ephemeral confirmation and add Back button
        const backRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('bank_inventory')
            .setLabel('Back to Inventory')
            .setEmoji('🎒')
            .setStyle(ButtonStyle.Secondary)
        );

        await interaction.editReply({ 
          content: '✅ Item dropped successfully!', 
          embeds: [], 
          components: [backRow] 
        });

        // Optional: Send inventory audit log
        sendLog(interaction.guild, 'inventory', 'orange', '🗑️ Item Dropped', `**${getUserLogName(interaction.member)}** dropped **${res.item.name}** in <#${interaction.channelId}>.\nDrop ID: \`${res.dropId}\``);
      }
      return;
    }

    // --- 4. EQUIP / ACTIVATE (Toggle Logic) ---
    if (action === 'equip') {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
      const result = await toggleEquipItem(interaction.user.id, interaction.guildId, invId, interaction.member);
      
      if (!result.success) {
        return interaction.followUp({ content: `❌ ${result.error}`, flags: [64] });
      }

      // Refresh the inventory view to show updated status
      return handleInventoryItemSelect(interaction);
    }

  } catch (error) {
    console.error('Inventory Action Error:', error);
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
    const dropId = interaction.customId.replace('bank_item_claim_', '');

    // 1. Initial acknowledgment (STRICT: Re-acknowledge even if router missed it)
    // Attempt Claim (Atomic Transaction in shop.js)
    const res = await claimItem(interaction.user.id, interaction.guildId, dropId, interaction.member);

    if (res.success) {
      const isSelfClaim = res.item.dropper_id === interaction.user.id;
      const claimerName = getUserDisplayName(interaction.user);

      // 1. Success Message to Claimer
      const successMsg = isSelfClaim 
        ? '✅ You have reclaimed your own dropped item!' 
        : `✅ You have successfully claimed **${res.item.name}**! Check your \`/inventory\` to equip it.`;
      
      await interaction.reply({ content: successMsg, flags: MessageFlags.Ephemeral }).catch(() => {});

      // 2. Update Public Message
      // Format: [Original First Line]\n\n[Resolution Line]
      const originalDesc = interaction.message.embeds[0]?.description || '';
      const firstLine = originalDesc.split('\n')[0];
      
      const resolutionLine = isSelfClaim
        ? `✅ **${claimerName}** changed their mind and claimed their own drop!`
        : `✅ **${claimerName}** claimed the item!`;

      const newDesc = `${firstLine}\n\n${resolutionLine}`;

      const claimedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
        .setColor(isSelfClaim ? '#3498DB' : '#2ECC71')
        .setDescription(newDesc)
        .setFooter({ text: 'Dropped at' });

      claimedEmbed.setTimestamp(new Date(res.dropped_at));

      const lockedRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`bank_item_claimed_locked_${dropId}`)
          .setLabel('Claim Item')
          .setEmoji('🎁')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true)
      );

      await interaction.message.edit({ embeds: [claimedEmbed], components: [lockedRow] });

      // 3. Log Audit
      sendLog(interaction.guild, 'inventory', 'green', '🎁 Item Claimed', `**${getUserLogName(interaction.member)}** claimed **${res.item.name}**.\nDrop ID: \`${dropId}\``);
    }
  } catch (error) {
    console.error('Claim Error:', error);
    const errorMessage = `❌ ${error.message}`;
    
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: errorMessage, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.followUp({ content: errorMessage, flags: MessageFlags.Ephemeral });
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
    const lines = result.rows.map(tx => {
      const d = new Date(tx.created_at);
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const date = `${year}/${month}/${day}`;

      const amountVal = parseInt(tx.amount);
      let amountDisplay;
      if (amountVal > 0) amountDisplay = `**+${amountVal}**`;
      else if (amountVal < 0) amountDisplay = `**${amountVal}**`;
      else amountDisplay = `**0**`;

      // Format IDs to mentions if they look like User IDs (17-19 digits) and aren't already mentioned
      let desc = tx.description.replace(/(?<!<@)(?<!<@&)(\d{17,19})(?!>)/g, '<@$1>');
      // Normalize legacy MVP text to generic form
      desc = desc.replace(/Won MVP of the Day/gi, 'Won the MVP award')
        .replace(/MVP of the Day reward/gi, 'Won the MVP award');
      return `\`${date}\` ${amountDisplay} | ${desc}`;
    });
    const embed = new EmbedBuilder().setColor(0x808080).setTitle('📜 Recent History').setDescription(lines.join('\n')).setFooter({ text: `Page ${page + 1}/${MAX_PAGE + 1}` });
    await interaction.editReply({ content: null, embeds: [embed], components: [navRow, backRow] });
  } catch (error) {
    console.error('History error:', error);
  }
}



export async function handleBackButton(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => {});
    }
    await refreshBankUI(interaction);
  } catch (error) {
    console.error('Back button error:', error);
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
                .setFooter({ text: 'Expired' });

              // Disable the claim button
              const disabledRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                  .setCustomId(`bank_item_expired_${drop.id}`)
                  .setLabel('Expired')
                  .setEmoji('⏰')
                  .setStyle(ButtonStyle.Secondary)
                  .setDisabled(true)
              );

              await message.edit({ embeds: [expiredEmbed], components: [disabledRow] }).catch(() => {});
            }
          }
        }

        // 3. Mark as expired in DB
        await pool.query("UPDATE dropped_items SET status = 'expired' WHERE id = $1", [drop.id]);
        console.log(`[System] [Cleanup] Drop ${drop.id} (${drop.name}) expired.`);

      } catch (err) {
        console.error(`[System] [Cleanup] Failed to expire drop ${drop.id}:`, err);
        // Mark as error so it doesn't loop forever if message is deleted/unreachable
        await pool.query("UPDATE dropped_items SET status = 'expired_error' WHERE id = $1", [drop.id]);
      }
    }
  } catch (error) {
    console.error('[System] cleanupExpiredDrops error:', error);
  }
}

