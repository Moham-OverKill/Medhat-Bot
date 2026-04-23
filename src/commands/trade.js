import {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    StringSelectMenuBuilder,
    ComponentType,
    PermissionFlagsBits
} from 'discord.js';
import { query, getPool } from '../storage/postgres.js';
import { sanitizeError, COIN_EMOJI, getUserDisplayName, isValidEconomyAmount } from '../shared.js';
import { sendLog, sysLog, sysError } from '../utils/logger.js';
import { getUserBalance, updateBalance } from '../economy/service.js';
import { isMemberBooster } from './colors.js';
import { syncInventoryWithDiscord, runDependencySweep, getUserInventory, getShopCategories } from '../economy/shop.js';
import { handleInteractionError } from '../utils/errors.js';

/**
 * ============================================================================
 * 🛡️ ARCHITECTURAL CORE: P2P TRADE SAFETY RULES 🛡️
 * ============================================================================
 * 
 * RULE 1: JIT (JUST-IN-TIME) VALIDATION
 * Trade conditions (Balance, Ownership, Permissions) change rapidly. 
 * The bot performs a final "Double Check" inside the SQL transaction 
 * right before the SWAP. If anything changed (user spent coins, sold item),
 * the trade is aborted to prevent duplication or negative balances.
 * 
 * RULE 2: SMART FILTERING (The "Posession" Block)
 * To prevent "Illegal" trades or role stacking:
 * - Users cannot trade items the Recipient already HAS (Role or DB item).
 * - Admin-granted roles (🛡️) are Soulbound and cannot be put in trades.
 * - Temporary items (⏳) are Soulbound and cannot be traded.
 * 
 * RULE 3: TRANSACTIONAL ATOMICITY
 * Swaps are handled as a single unit. If any part fails (Role add/remove), 
 * the entire coin and item movement is rolled back.
 * ============================================================================
 */

// Define single transaction cap limit
const SINGLE_TX_CAP = 100000;


/**
 * Calculates trade tax (e.g. 10%)
 * @param {number} amount 
 * @param {boolean} isBooster 
 * @returns {Object} Fee breakdown
 */
function calculateTradeTax(amount, isBooster = false) {
    // Boosters pay 0% fee, others pay 5%
    const rate = isBooster ? 0 : 0.05;
    const fee = Math.floor(amount * rate);
    return {
        fee: fee,
        recipientGets: amount - fee,
        senderPaysExtra: fee
    };
}

// Memory for active trade SETUPS (ephemeral, pre-posting)
// Key: GuildId_UserId (Sender)
const ACTIVE_SETUPS = new Map();
const TRADE_TIMEOUTS = new Map(); 

/**
 * Command definition for /trade
 */
export const tradeCommand = new SlashCommandBuilder()
    .setName('trade')
    .setDescription('Initiate a P2P trade with another member')
    .addUserOption(option =>
        option.setName('target')
            .setDescription('The user you want to trade with')
            .setRequired(true))
    .setDMPermission(false);

/**
 * Cleanup expired trades (Official Sync)
 */
async function cleanupExpiredTrades(guildId) {
    await query(
        `UPDATE trades SET status = 'expired' 
         WHERE status = 'pending' AND expires_at < NOW() AND guild_id = $1`,
        [guildId]
    );
}

/**
 * Handle /trade command initiation
 */
export async function handleTradeCommand(interaction) {
    try {
        const target = interaction.options.getUser('target');
        const sender = interaction.user;
        const guildId = interaction.guildId;
        
        // 0. Proactive Permission Check: Bot must be able to view and send in this channel
        // NULL-SAFE check for members.me
        const botMember = interaction.guild.members.me;
        if (!botMember) {
             return interaction.reply({ 
                content: '⏳ The bot state is currently syncing with this server. Please try again in 1 minute.',
                flags: MessageFlags.Ephemeral 
            });
        }

        const botPermissions = interaction.channel.permissionsFor(botMember);
        if (!botPermissions || !botPermissions.has(PermissionFlagsBits.ViewChannel) || !botPermissions.has(PermissionFlagsBits.SendMessages)) {
            return interaction.reply({ 
                content: '❌ I do not have permission to **View Channel** or **Send Messages** in this channel. I need these to post trade offers.', 
                flags: MessageFlags.Ephemeral 
            });
        }

        // Official Sync: Cleanup any expired trades to free up locks
        await cleanupExpiredTrades(guildId);

        // Guard: Cannot trade with self or bots
        if (target.id === sender.id) {
            return interaction.reply({ content: '❌ You cannot trade with yourself.', flags: MessageFlags.Ephemeral });
        }
        if (target.bot) {
            return interaction.reply({ content: '❌ You cannot trade with bots.', flags: MessageFlags.Ephemeral });
        }

        // ── Anti-Smurf / Anti-Alt Gate (7-Day Server Membership) ──────────────────
        // UPDATED: Added Administrator bypass and NULL-SAFETY for joinedAt
        const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
        const now = Date.now();
        const isSenderAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);

        // NULL-SAFE check for JoinedAt
        const senderJoinedAt = interaction.member.joinedAt;
        if (!senderJoinedAt) {
             return interaction.reply({ 
                content: '❌ Your server membership data hasn\'t synced yet. Please wait a few minutes before trading.', 
                flags: MessageFlags.Ephemeral 
            });
        }

        const senderAge = now - senderJoinedAt.getTime();
        if (senderAge < SEVEN_DAYS_MS && !isSenderAdmin) {
            return interaction.reply({
                content: '❌ You must be a member in this server for at least 7 days to start trading.',
                flags: MessageFlags.Ephemeral
            });
        }

        const targetMemberForAgeCheck = await interaction.guild.members.fetch(target.id).catch(() => null);
        if (!targetMemberForAgeCheck) {
            return interaction.reply({ content: '❌ Could not fetch the target user.', flags: MessageFlags.Ephemeral });
        }

        const targetJoinedAt = targetMemberForAgeCheck.joinedAt;
        // Target bypass if the target is an admin too (optional, but keep it strict unless they are admin)
        const isTargetAdmin = targetMemberForAgeCheck.permissions.has(PermissionFlagsBits.Administrator);

        if (!targetJoinedAt) {
            return interaction.reply({ 
                content: '❌ The target user\'s membership data hasn\'t synced yet.', 
                flags: MessageFlags.Ephemeral 
            });
        }

        const targetAge = now - targetJoinedAt.getTime();
        if (targetAge < SEVEN_DAYS_MS && !isTargetAdmin) {
            return interaction.reply({
                content: '❌ This user must be a member in the server for at least 7 days.',
                flags: MessageFlags.Ephemeral
            });
        }
        // ── End Gate ───────────────────────────────────────────────────────────────

        // 1. Single Active Trade Lock (Global Concurrency)
        const activeCheck = await query(
            `SELECT sender_id, target_id, message_url FROM trades 
            WHERE (sender_id = $1 OR target_id = $1 OR sender_id = $2 OR target_id = $2) 
            AND status = 'pending' AND guild_id = $3`,
            [sender.id, target.id, guildId]
        );

        if (activeCheck.rows.length > 0) {
            const busyTrade = activeCheck.rows[0];
            const tradeLink = busyTrade.message_url ? `[pending trade](${busyTrade.message_url})` : 'pending trade';

            if (busyTrade.sender_id === sender.id || busyTrade.target_id === sender.id) {
                return interaction.reply({ 
                    content: `❌ You already have a ${tradeLink}.`, 
                    flags: MessageFlags.Ephemeral 
                });
            } else {
                return interaction.reply({ 
                    content: `❌ This user is currently in another ${tradeLink}.`, 
                    flags: MessageFlags.Ephemeral 
                });
            }
        }

        // 2. Decline Cooldown (Anti-Spam Filter)
        const cooldownCheck = await query(
            `SELECT updated_at FROM trades 
            WHERE sender_id = $1 AND target_id = $2 AND status = 'declined' AND guild_id = $3
            ORDER BY updated_at DESC LIMIT 1`,
            [sender.id, target.id, guildId]
        );

        if (cooldownCheck.rows.length > 0) {
            const lastDeclined = new Date(cooldownCheck.rows[0].updated_at);
            const now = new Date();
            const diffSeconds = Math.floor((now - lastDeclined) / 1000);

            if (diffSeconds < 60) {
                return interaction.reply({ 
                    content: `❌ This user recently declined your trade. Please wait ${60 - diffSeconds} seconds before sending another offer to them.`, 
                    flags: MessageFlags.Ephemeral 
                });
            }
        }

        // Initialize state
        const setupId = `${interaction.guildId}_${sender.id}`;
        ACTIVE_SETUPS.set(setupId, {
            senderId: sender.id,
            targetId: target.id,
            guildId: interaction.guildId,
            senderCoins: 0,
            targetCoins: 0,
            senderItems: [], // Array of inventory objects {id, name}
            targetItems: [], // Array of inventory objects {id, name}
            lastMessage: null,
            givingFolder: null,
            requestingFolder: null
        });

        await showTradeSetup(interaction);
    } catch (error) {
        await handleInteractionError(interaction, error, 'trade command initiation');
    }
}

/**
 * Show the ephemeral trade configuration UI
 */
export async function showTradeSetup(interaction, setupInfo = null, ...extraComponents) {
    const setupId = `${interaction.guildId}_${interaction.user.id}`;
    const setup = setupInfo || ACTIVE_SETUPS.get(setupId);

    if (!setup) {
        const errorContent = '❌ Trade session expired or not found.';
        if (!interaction.deferred && !interaction.replied) {
            return interaction.reply({ content: errorContent, flags: MessageFlags.Ephemeral });
        }
        return interaction.editReply({ content: errorContent, components: [], embeds: [] }).catch(() => { });
    }

    // Fetch balances to show current wealth
    const senderBalance = await getUserBalance(setup.senderId, setup.guildId);
    const targetBalance = await getUserBalance(setup.targetId, setup.guildId);

    const targetMember = await interaction.guild.members.fetch(setup.targetId).catch(() => null);
    const targetName = targetMember ? getUserDisplayName(targetMember) : 'User';

    const embed = new EmbedBuilder()
        .setTitle(`Trading with ${targetName}`)
        .addFields(
            {
                name: '📤 You Give',
                value: `• **Coins:** ${setup.senderCoins.toLocaleString()} ${COIN_EMOJI} (Your Balance: ${Number(senderBalance.balance).toLocaleString()})\n• **Items:** ${setup.senderItems.length === 0 ? 'None' : setup.senderItems.map(i => `**${i.name}**`).join(', ')}`,
                inline: true
            },
            {
                name: '📥 You Request',
                value: `• **Coins:** ${setup.targetCoins.toLocaleString()} ${COIN_EMOJI} (Target Balance: ${Number(targetBalance.balance).toLocaleString()})\n• **Items:** ${setup.targetItems.length === 0 ? 'None' : setup.targetItems.map(i => `**${i.name}**`).join(', ')}`,
                inline: true
            }
        )
        .setColor(0x3498DB)
        .setFooter({ text: '⚠️ Standard 5% fee applies (0% for Boosters)' });

    // Row 1: Coins (Give/Request)
    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`trade_setup_give_coins`)
            .setLabel('Give Coins')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId(`trade_setup_request_coins`)
            .setLabel('Request Coins')
            .setStyle(ButtonStyle.Primary)
    );

    // Row 2: Items (Give/Request)
    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`trade_setup_give_item`)
            .setLabel('Give Items')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId(`trade_setup_request_item`)
            .setLabel('Request Items')
            .setStyle(ButtonStyle.Primary)
    );

    // Row 3: Finalize (Green & Gray)
    const row3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`trade_setup_post`)
            .setLabel('Trade')
            .setStyle(ButtonStyle.Success)
            .setDisabled(setup.senderCoins === 0 && setup.targetCoins === 0 && setup.senderItems.length === 0 && setup.targetItems.length === 0),
        new ButtonBuilder()
            .setCustomId(`trade_setup_reset`)
            .setLabel('Reset')
            .setStyle(ButtonStyle.Secondary)
    );

    const components = [row1, row2, row3];
    if (extraComponents && extraComponents.length > 0) {
        // Insert extra components (like select menus or back buttons) above the finalize row
        components.splice(2, 0, ...extraComponents);
    }

    // Smart response handling
    const payload = { embeds: [embed], components: components, flags: MessageFlags.Ephemeral };
    
    try {
        if (interaction.isMessageComponent() || interaction.isModalSubmit()) {
            if (interaction.replied || interaction.deferred) {
                await interaction.editReply(payload);
            } else {
                await interaction.update(payload);
            }
        } else if (interaction.replied || interaction.deferred) {
            await interaction.editReply(payload);
        } else {
            await interaction.reply(payload);
        }
    } catch (err) {
        sysError('UI Refresh failed', err, { user: interaction.user.id, guild: interaction.guildId });
    }
}

/**
 * Handle Trade setup interactions
 */
export async function handleTradeSetupInteraction(interaction) {
    const setupId = `${interaction.guildId}_${interaction.user.id}`;
    const setup = ACTIVE_SETUPS.get(setupId);

    if (!setup) {
        return interaction.reply({ content: '❌ Trade session expired. Restart with /trade.', flags: MessageFlags.Ephemeral });
    }

    const { customId } = interaction;

    try {
        // 1. Immediate Proactive Deferral for all component interactions (except modals)
        if (!customId.includes('_coins')) {
            if (interaction.isButton() || interaction.isAnySelectMenu()) {
                await interaction.deferUpdate().catch(() => {});
            }
        }

        // 2. Routing & State Management (Handles category picking & navigation)
        if (customId === 'trade_cat_give_select' || customId === 'trade_cat_req_select' || 
            customId.startsWith('trade_folder_back_') || (interaction.isAnySelectMenu() && interaction.values[0]?.startsWith('trade_folder_back_'))) {
            
            const isBack = customId.startsWith('trade_folder_back_') || interaction.values[0]?.startsWith('trade_folder_back_');
            const isGive = customId.includes('give') || interaction.values[0]?.includes('give');
            
            if (isBack) {
                if (isGive) setup.givingFolder = null;
                else setup.requestingFolder = null;
                sysLog('Folder Back Navigation', { aspect: isGive ? 'give' : 'req' });
                // If it was a select menu choice, we handle it here, but let the UI rebuild
            } else {
                const val = interaction.values[0]; 
                const catId = val.split('_').pop();
                
                if (isGive) setup.givingFolder = parseInt(catId);
                else setup.requestingFolder = parseInt(catId);
                sysLog('Category Routing Applied', { catId: catId, aspect: isGive ? 'give' : 'req' });
            }
        }

        // --- INTERACTION BRANCHES ---

        // Coins Give Modal
        if (customId === 'trade_setup_give_coins') {
            const modal = new ModalBuilder()
                .setCustomId('trade_modal_give_coins')
                .setTitle('Amount to Give');

            const input = new TextInputBuilder()
                .setCustomId('amount')
                .setLabel('How many coins are you giving?')
                .setPlaceholder('Enter a positive number...')
                .setStyle(TextInputStyle.Short)
                .setRequired(true);

            modal.addComponents(new ActionRowBuilder().addComponents(input));
            return interaction.showModal(modal);
        }

        // Coins Request Modal
        if (customId === 'trade_setup_request_coins') {
            const modal = new ModalBuilder()
                .setCustomId('trade_modal_request_coins')
                .setTitle('Amount to Request');

            const input = new TextInputBuilder()
                .setCustomId('amount')
                .setLabel('How many coins are you requesting?')
                .setPlaceholder('Enter a positive number...')
                .setStyle(TextInputStyle.Short)
                .setRequired(true);

            modal.addComponents(new ActionRowBuilder().addComponents(input));
            return interaction.showModal(modal);
        }

        // List Inventory to Give (FOLDER SYSTEM)
        if (customId === 'trade_setup_give_item' || customId === 'trade_cat_give_select' || (customId === 'trade_select_give_item' && interaction.values[0]?.startsWith('trade_folder_back_'))) {
            const selectedCatId = setup.givingFolder;
            sysLog('Building Give Item List', { folder: selectedCatId });
            
            const allItems = await getUserInventory(setup.senderId, setup.guildId);
            const targetMember = await interaction.guild.members.fetch(setup.targetId).catch(() => null);
            const targetRoleIds = targetMember ? targetMember.roles.cache.map(r => r.id) : [];
            const targetInv = targetMember ? await getUserInventory(setup.targetId, setup.guildId) : [];
            const targetOwnedItemIds = targetInv.map(i => i.shop_item_id);

            const tradableItems = allItems.filter(i => {
               const source = (i.purchase_source || '').toLowerCase();
               if (source !== 'shop' || i.item_type === 'pack') return false; 
               if (i.expires_at || (i.duration_seconds && i.duration_seconds > 0) || (i.duration_hours && i.duration_hours > 0)) return false;

               const firstRole = i.role_id?.split(/[,\s]+/)[0];
               const recipientHasRole = firstRole && targetRoleIds.includes(firstRole);
               const recipientHasItem = targetOwnedItemIds.includes(i.shop_item_id);
               return !recipientHasRole && !recipientHasItem;
            });

            if (tradableItems.length === 0) {
                return interaction.editReply({ content: '❌ You do not have any tradable items that the recipient doesn\'t already own.', components: [], embeds: [] });
            }

            if (!selectedCatId && (customId === 'trade_setup_give_item' || customId === 'trade_cat_give_select' || (customId === 'trade_select_give_item' && interaction.values[0]?.startsWith('trade_folder_back_')))) {
                const categories = await getShopCategories(setup.guildId);
                const validCatIds = new Set(tradableItems.map(i => i.category_id));
                const availableCats = categories.filter(c => validCatIds.has(c.id));

                if (availableCats.length === 0) {
                    setup.givingFolder = -1;
                } else {
                    const options = availableCats.map(c => ({ label: `📁 ${c.name}`, value: `trade_cat_give_${c.id}` }));
                    if (tradableItems.some(i => !i.category_id)) options.push({ label: '📁 Uncategorized', value: 'trade_cat_give_-1' });

                    const catSelect = new StringSelectMenuBuilder()
                        .setCustomId('trade_cat_give_select')
                        .setPlaceholder('Select item(s) to give')
                        .addOptions(options);

                    return showTradeSetup(interaction, setup, new ActionRowBuilder().addComponents(catSelect));
                }
            }

            const finalCatId = selectedCatId === -1 ? null : (selectedCatId || setup.givingFolder);
            const folderItems = tradableItems.filter(i => (finalCatId === -1 ? !i.category_id : i.category_id === finalCatId));

            if (folderItems.length === 0) {
                setup.givingFolder = null;
                return interaction.editReply({ content: '❌ No tradable items found in this folder.', components: [], embeds: [] });
            }

            const options = folderItems.slice(0, 25).map(row => ({
                label: `🏷️ ${row.name}`,
                value: row.id.toString()
            }));

            // Add integrated BACK option at the top of the list
            options.unshift({ label: '⬅️ Back', value: 'trade_folder_back_give' });

            const select = new StringSelectMenuBuilder()
                .setCustomId('trade_select_give_item')
                .setPlaceholder('Select an item to give...')
                .addOptions(options);

            setup.givingFolder = finalCatId;
            return showTradeSetup(interaction, setup, new ActionRowBuilder().addComponents(select));
        }

        // List Target Inventory to Request (FOLDER SYSTEM)
        if (customId === 'trade_setup_request_item' || customId === 'trade_cat_req_select' || (customId === 'trade_select_request_item' && interaction.values[0]?.startsWith('trade_folder_back_'))) {
            const selectedCatId = setup.requestingFolder;
            const member = await interaction.guild.members.fetch(setup.targetId).catch(() => null);
            if (!member) return interaction.editReply({ content: '❌ Target member not found.', components: [], embeds: [] });
            
            const allItems = await getUserInventory(setup.targetId, setup.guildId);
            const senderRoleIds = interaction.member.roles.cache.map(r => r.id);
            const senderInv = await getUserInventory(setup.senderId, setup.guildId);
            const senderOwnedItemIds = senderInv.map(i => i.shop_item_id);

            const tradableItems = allItems.filter(i => {
                const source = (i.purchase_source || '').toLowerCase();
                if (source !== 'shop' || i.item_type === 'pack') return false;
                if (i.expires_at || (i.duration_seconds && i.duration_seconds > 0) || (i.duration_hours && i.duration_hours > 0)) return false;

                const firstRole = i.role_id?.split(/[,\s]+/)[0];
                const requesterHasRole = firstRole && senderRoleIds.includes(firstRole);
                const requesterHasItem = senderOwnedItemIds.includes(i.shop_item_id);
                return !requesterHasRole && !requesterHasItem;
            });

            if (tradableItems.length === 0) {
                return interaction.editReply({ content: '❌ The target user does not have any tradable items that you don\'t already own.', components: [], embeds: [] });
            }

            if (!selectedCatId && (customId === 'trade_setup_request_item' || customId === 'trade_cat_req_select' || (customId === 'trade_select_request_item' && interaction.values[0]?.startsWith('trade_folder_back_')))) {
                const categories = await getShopCategories(setup.guildId);
                const validCatIds = new Set(tradableItems.map(i => i.category_id));
                const availableCats = categories.filter(c => validCatIds.has(c.id));

                if (availableCats.length === 0) {
                    setup.requestingFolder = -1;
                } else {
                    const options = availableCats.map(c => ({ label: `📁 ${c.name}`, value: `trade_cat_req_${c.id}` }));
                    if (tradableItems.some(i => !i.category_id)) options.push({ label: '📁 Uncategorized', value: 'trade_cat_req_-1' });

                    const catSelect = new StringSelectMenuBuilder()
                        .setCustomId('trade_cat_req_select')
                        .setPlaceholder('Select item(s) to request')
                        .addOptions(options);

                    return showTradeSetup(interaction, setup, new ActionRowBuilder().addComponents(catSelect));
                }
            }

            const finalCatId = selectedCatId === -1 ? null : (selectedCatId || setup.requestingFolder);
            const folderItems = tradableItems.filter(i => (finalCatId === -1 ? !i.category_id : i.category_id === finalCatId));

            if (folderItems.length === 0) {
                setup.requestingFolder = null;
                return interaction.editReply({ content: '❌ No tradable items found in this folder.', components: [], embeds: [] });
            }

            const options = folderItems.slice(0, 25).map(row => ({
                label: `🏷️ ${row.name}`,
                value: row.id.toString()
            }));

            // Add integrated BACK option at the top of the list
            options.unshift({ label: '⬅️ Back', value: 'trade_folder_back_req' });

            const select = new StringSelectMenuBuilder()
                .setCustomId('trade_select_request_item')
                .setPlaceholder('Select an item to request...')
                .addOptions(options);

            setup.requestingFolder = finalCatId;
            return showTradeSetup(interaction, setup, new ActionRowBuilder().addComponents(select));
        }

        // Post Trade (Making it public)
        if (customId === 'trade_setup_post') {
            await finalizeTradePosting(interaction, setup);
            ACTIVE_SETUPS.delete(setupId);
            return;
        }

        // Reset
        if (customId === 'trade_setup_reset') {
            setup.senderCoins = 0;
            setup.targetCoins = 0;
            setup.senderItems = [];
            setup.targetItems = [];
            setup.givingFolder = null;
            setup.requestingFolder = null;
            return showTradeSetup(interaction, setup);
        }

    } catch (error) {
        sysError('Trade Setup Interaction Handler Crashed', error, { user: interaction.user.id, guild: interaction.guildId });
        const errorContent = `❌ **Error:** ${error.message || 'An unexpected error occurred during trade setup.'}`;
        
        if (interaction.deferred || interaction.replied) {
            return interaction.editReply({ content: errorContent, components: [], embeds: [] }).catch(() => {});
        } else {
            return interaction.reply({ content: errorContent, flags: MessageFlags.Ephemeral }).catch(() => {});
        }
    }
}

/**
 * Handle Modal Submissions for coins
 */
export async function handleTradeModal(interaction) {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => { });
    const setupId = `${interaction.guildId}_${interaction.user.id}`;
    const setup = ACTIVE_SETUPS.get(setupId);
    if (!setup) return interaction.editReply({ content: '❌ Session expired.', components: [], embeds: [] });

    const amountStr = interaction.fields.getTextInputValue('amount');
    
    if (!isValidEconomyAmount(amountStr, true)) {
        return interaction.followUp({ 
            content: `❌ Please enter a valid non-negative whole number (e.g., 500).`, 
            flags: MessageFlags.Ephemeral 
        });
    }

    const amount = parseInt(amountStr, 10);
    if (amount > SINGLE_TX_CAP) {
        return interaction.followUp({ 
            content: `❌ **Security Limit:** You cannot trade more than **${SINGLE_TX_CAP.toLocaleString()} coins** in a single transaction.`, 
            flags: MessageFlags.Ephemeral 
        });
    }


    if (interaction.customId === 'trade_modal_give_coins') {
        const balance = await getUserBalance(setup.senderId, setup.guildId);
        if (amount > balance.balance) {
            return interaction.followUp({ content: `❌ You only have ${Number(balance.balance).toLocaleString()} coins.`, flags: MessageFlags.Ephemeral });
        }
        setup.senderCoins = amount;
    } else if (interaction.customId === 'trade_modal_request_coins') {
        const balance = await getUserBalance(setup.targetId, setup.guildId);
        if (amount > balance.balance) {
            return interaction.followUp({ content: `❌ This user only has ${Number(balance.balance).toLocaleString()} coins.`, flags: MessageFlags.Ephemeral });
        }
        setup.targetCoins = amount;
    }

    return showTradeSetup(interaction, setup);
}

/**
 * Handle Select Menu for items
 */
export async function handleTradeSelect(interaction) {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => { });

    // INTEGRATED BACK NAVIGATION: If the user picked "Back" from the menu, reroute to setup
    if (interaction.values[0]?.startsWith('trade_folder_back_')) {
        return handleTradeSetupInteraction(interaction);
    }

    const setupId = `${interaction.guildId}_${interaction.user.id}`;
    const setup = ACTIVE_SETUPS.get(setupId);
    if (!setup) return interaction.editReply({ content: '❌ Session expired.', components: [], embeds: [] });

    const invId = parseInt(interaction.values[0], 10);
    
    // Fetch item details (including source and expiry to check if soulbound)
    const result = await query(
        `SELECT i.id, i.shop_item_id, i.source, i.expires_at, s.name, s.duration_hours, s.duration_seconds 
         FROM user_inventory i
         JOIN shop_items s ON i.shop_item_id = s.id 
         WHERE i.id = $1 AND i.guild_id = $2 AND i.user_id = $3`,
        [invId, setup.guildId, interaction.user.id]
    );

    if (result.rows.length === 0) return interaction.followUp({ content: '❌ Item not found.', flags: MessageFlags.Ephemeral });

    const item = result.rows[0];
    const isSoulbound = item.source !== 'SHOP';

    // Layer 2: Selection Check (only block admin-granted items)
    if (isSoulbound) {
        return interaction.followUp({ content: '❌ You cannot trade items granted by admins (Soulbound).', flags: MessageFlags.Ephemeral });
    }

    if (interaction.customId === 'trade_select_give_item') {
        // Prevent duplicates in offer
        if (setup.senderItems.find(i => i.id === invId)) {
            return interaction.followUp({ content: '❌ Item already added to offer.', flags: MessageFlags.Ephemeral });
        }
        
        // Prevent giving permanent items the target already owns
            const targetMember = await interaction.guild.members.fetch(setup.targetId);
            const hasExplicit = targetMember.roles.cache.has(item.role_id?.split(/[,\s]+/)[0]);
            
            const dbCheck = await query(
                'SELECT id FROM user_inventory WHERE user_id = $1 AND shop_item_id = $2 AND guild_id = $3',
                [setup.targetId, item.shop_item_id, setup.guildId]
            );

            if (dbCheck.rows.length > 0 || hasExplicit) {
                return interaction.followUp({ content: `❌ The recipient already has this role (Owned or Admin-Granted).`, flags: MessageFlags.Ephemeral });
            }

        setup.senderItems.push(item);
    } else if (interaction.customId === 'trade_select_request_item') {
        // Prevent duplicates in request
        if (setup.targetItems.find(i => i.id === invId)) {
            return interaction.followUp({ content: '❌ Item already added to request.', flags: MessageFlags.Ephemeral });
        }

        // Prevent requesting permanent items you already own correctly
        const isTemp = (item.expires_at !== null) || (item.duration_seconds && item.duration_seconds > 0) || (item.duration_hours && item.duration_hours > 0);
        if (!isTemp) {
            const senderMember = await interaction.guild.members.fetch(setup.senderId);
            const hasExplicit = senderMember.roles.cache.has(item.role_id?.split(/[,\s]+/)[0]);

            const dbCheck = await query(
                'SELECT id FROM user_inventory WHERE user_id = $1 AND shop_item_id = $2 AND guild_id = $3',
                [setup.senderId, item.shop_item_id, setup.guildId]
            );

            if (dbCheck.rows.length > 0 || hasExplicit) {
                return interaction.followUp({ content: `❌ You already possess this role (Owned or Admin-Granted).`, flags: MessageFlags.Ephemeral });
            }
        }

        setup.targetItems.push(item);
    }

    // Immediately update the UI using the current interaction (StringSelectMenuInteraction)
    return showTradeSetup(interaction, setup);
}

/**
 * Save to DB and post the public trade message
 */
async function finalizeTradePosting(interaction, setup) {
    try {
        const expiryDate = new Date();
        expiryDate.setMinutes(expiryDate.getMinutes() + 5);

        // Layer 3: Pre-Post Verification (The Double Check)
        // Verify no soulbound items snuck into the setup state
        for (const item of setup.senderItems) {
            const isTemp = (item.expires_at !== null) || (item.duration_seconds && item.duration_seconds > 0) || (item.duration_hours && item.duration_hours > 0);
            if (item.source !== 'SHOP' || isTemp) {
                return interaction.followUp({ content: `❌ Restricted item detected in offer: **${item.name}**. Please reset and try again.`, flags: MessageFlags.Ephemeral });
            }
        }
        for (const item of setup.targetItems) {
            const isTemp = (item.expires_at !== null) || (item.duration_seconds && item.duration_seconds > 0) || (item.duration_hours && item.duration_hours > 0);
            if (item.source !== 'SHOP' || isTemp) {
                return interaction.followUp({ content: `❌ Restricted item detected in request: **${item.name}**. Please reset and try again.`, flags: MessageFlags.Ephemeral });
            }
        }

        // 1. Save to Database
        const res = await query(
            `INSERT INTO trades (guild_id, sender_id, target_id, sender_coins, target_coins, sender_items, target_items, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING id`,
            [
                setup.guildId,
                setup.senderId,
                setup.targetId,
                setup.senderCoins,
                setup.targetCoins,
                JSON.stringify(setup.senderItems.map(i => i.id)),
                JSON.stringify(setup.targetItems.map(i => i.id)),
                expiryDate
            ]
        );

        const tradeId = res.rows[0].id;

        // 2. Build Public Embed
        const embed = new EmbedBuilder()
            .addFields(
                {
                    name: `📤 ${getUserDisplayName(await interaction.guild.members.fetch(setup.senderId))} Offers`,
                    value: `• **Coins:** ${setup.senderCoins.toLocaleString()} ${COIN_EMOJI}\n• **Items:** ${setup.senderItems.length === 0 ? 'None' : setup.senderItems.map(i => `**${i.name}**`).join(', ')}`,
                    inline: false
                },
                {
                    name: `📥 Requested from ${getUserDisplayName(await interaction.guild.members.fetch(setup.targetId))}`,
                    value: `• **Coins:** ${setup.targetCoins.toLocaleString()} ${COIN_EMOJI}\n• **Items:** ${setup.targetItems.length === 0 ? 'None' : setup.targetItems.map(i => `**${i.name}**`).join(', ')}`,
                    inline: false
                }
            )
            .setColor(0xF1C40F) // Gold
            .setTimestamp(expiryDate);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`trade_decline_${tradeId}`)
                .setLabel('Decline')
                .setEmoji('✖️')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`trade_accept_${tradeId}`)
                .setLabel('Accept')
                .setEmoji('✅')
                .setStyle(ButtonStyle.Success)
        );
        // Note: Decline is left, Accept is right (matching button order)

        // 3. Post Publicly
        const publicMsg = await interaction.channel.send({
            content: `🤝 **Trade Offer:** <@${setup.senderId}> ↔️ <@${setup.targetId}>\n**Expires:** <t:${Math.floor(expiryDate.getTime() / 1000)}:R>`,
            embeds: [embed],
            components: [row]
        });

        // 4. Record Message ID and Jump URL in DB
        await query(
            'UPDATE trades SET message_id = $1, channel_id = $2, message_url = $3 WHERE id = $4 AND guild_id = $5',
            [publicMsg.id, interaction.channelId, publicMsg.url, tradeId, setup.guildId]
        );

        // 5. Set Expiration Timeout (Garbage Collector)
        const timeoutId = setTimeout(async () => {
            try {
                // Check if still pending
                const check = await query('SELECT status FROM trades WHERE id = $1 AND guild_id = $2', [tradeId, setup.guildId]);
                if (check.rows.length > 0 && check.rows[0].status === 'pending') {
                    await query('UPDATE trades SET status = $1 WHERE id = $2 AND guild_id = $3', ['expired', tradeId, setup.guildId]);

                    // Edit original message to show expired state
                    const expiredEmbed = EmbedBuilder.from(embed)
                        .setColor(0x95A5A6) // Gray
                        .setFooter({ text: 'Trade Expired' });
                    
                    const disabledRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId(`expired_decline_${tradeId}`)
                            .setLabel('Decline')
                            .setEmoji('✖️')
                            .setStyle(ButtonStyle.Danger)
                            .setDisabled(true),
                        new ButtonBuilder()
                            .setCustomId(`expired_accept_${tradeId}`)
                            .setLabel('Accept')
                            .setEmoji('✅')
                            .setStyle(ButtonStyle.Success)
                            .setDisabled(true)
                    );

                    // Fetch fresh message object to ensure edit succeeds
                    const channel = await interaction.client.channels.fetch(interaction.channelId).catch(() => null);
                    if (channel) {
                        const targetMsg = await channel.messages.fetch(publicMsg.id).catch(() => null);
                        if (targetMsg) {
                            await targetMsg.edit({
                                content: `🤝 **Trade Offer:** <@${setup.senderId}> ↔️ <@${setup.targetId}>\n**Expired:** <t:${Math.floor(expiryDate.getTime() / 1000)}:R>`,
                                embeds: [expiredEmbed],
                                components: [disabledRow]
                            }).catch(() => { });
                        }
                    }
                }
            } catch (err) {
                sysError('Trade timeout error', err, { guild: setup.guildId, detail: `TradeID: ${tradeId}` });
            } finally {
                TRADE_TIMEOUTS.delete(tradeId);
            }
        }, 300000); // 5 minutes

        TRADE_TIMEOUTS.set(tradeId, timeoutId);

        // 5. Finalize the ephemeral setup UI
        return interaction.editReply({ content: '✅ Trade offer has been posted to the channel!', embeds: [], components: [] });
    } catch (error) {
        sysError('Finalize post error', error, { user: interaction.user.id, guild: interaction.guildId });
        return interaction.followUp({ content: '❌ Failed to post trade. Check logs.', flags: MessageFlags.Ephemeral });
    }
}

/**
 * Handle Public Trade Button clicks (Accept/Decline)
 */
export async function handleTradeExecution(interaction) {
    const customId = interaction.customId;
    const tradeId = parseInt(customId.split('_')[2], 10);

    // Fetch trade from DB — no deferral yet so we can reply() or update() freely
    const res = await query('SELECT * FROM trades WHERE id = $1 AND guild_id = $2', [tradeId, interaction.guildId]);
    if (res.rows.length === 0) {
        return interaction.reply({ content: '❌ Trade not found.', flags: MessageFlags.Ephemeral });
    }

    const trade = res.rows[0];

    // Status Check
    if (trade.status !== 'pending') {
        return interaction.reply({ content: `❌ This trade has already been ${trade.status}.`, flags: MessageFlags.Ephemeral });
    }

    // Expiry Check
    if (new Date() > new Date(trade.expires_at)) {
        await query('UPDATE trades SET status = $1 WHERE id = $2 AND guild_id = $3', ['expired', tradeId, interaction.guildId]);
        return interaction.reply({ content: '❌ This trade offer has expired.', flags: MessageFlags.Ephemeral });
    }

    // ONLY target can accept/decline
    if (interaction.user.id !== trade.target_id) {
        return interaction.reply({ content: '❌ Only the target user can respond to this offer.', flags: MessageFlags.Ephemeral });
    }

    // DECLINE
    if (customId.startsWith('trade_decline_')) {
        await interaction.deferUpdate().catch(() => { });
        await query('UPDATE trades SET status = $1, updated_at = NOW() WHERE id = $2 AND guild_id = $3', ['declined', tradeId, interaction.guildId]);

        // Clear Garbage Collector
        const timeoutId = TRADE_TIMEOUTS.get(tradeId);
        if (timeoutId) { clearTimeout(timeoutId); TRADE_TIMEOUTS.delete(tradeId); }

        const declinedEmbed = interaction.message.embeds.length > 0
            ? EmbedBuilder.from(interaction.message.embeds[0]).setColor(0xEE4444)
            : new EmbedBuilder().setColor(0xEE4444);

        await interaction.editReply({
            content: `❌ Trade was declined by <@${trade.target_id}>.`,
            components: [],
            embeds: [declinedEmbed]
        });
        return;
    }

    // ACCEPT -> Execute immediately (no modal)
    if (customId.startsWith('trade_accept_')) {
        await interaction.deferUpdate().catch(() => { });
        return handleTradeFinalConfirmation(interaction, trade);
    }
}

/**
 * ATOMIC SWAP EXECUTION (The Fortress)
 * Can be called directly from Accept (no modal) or from modal confirmation.
 */
export async function handleTradeFinalConfirmation(interaction, tradeData = null, tradeIdOverride = null) {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => { });
    const tradeId = tradeIdOverride ?? parseInt(interaction.customId.split('_')[2], 10);

    // If it's a modal, we check the field. Otherwise (direct click), we skip it.
    if (interaction.type === InteractionType.ModalSubmit) {
        const confirmText = interaction.fields.getTextInputValue('confirm');
        if (confirmText.toUpperCase() !== 'CONFIRM') {
            return interaction.editReply({ content: '❌ Trade confirmation failed. You must type "CONFIRM".', components: [], embeds: [] });
        }
    }

    // Fetch trade again to be sure
    const pool = getPool();
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Lock rows to prevent race conditions during JIT check
        const tradeRes = await client.query('SELECT * FROM trades WHERE id = $1 AND guild_id = $2 FOR UPDATE', [tradeId, interaction.guildId]);
        if (tradeRes.rows.length === 0) throw new Error('Trade not found');
        const trade = tradeRes.rows[0];

        if (trade.status !== 'pending') throw new Error(`Trade already ${trade.status}`);

        // 2. JIT Verification - Check Balances
        const senderBal = await client.query('SELECT balance FROM user_balances WHERE user_id = $1 AND guild_id = $2 FOR UPDATE', [trade.sender_id, trade.guild_id]);
        const targetBal = await client.query('SELECT balance FROM user_balances WHERE user_id = $1 AND guild_id = $2 FOR UPDATE', [trade.target_id, trade.guild_id]);

        // Pre-fetch members for Display Names and Role Sync
        const senderMember = await interaction.guild.members.fetch(trade.sender_id).catch(() => null);
        const targetMember = await interaction.guild.members.fetch(trade.target_id).catch(() => null);

        const sBal = parseInt(senderBal.rows[0]?.balance || 0);
        const tBal = parseInt(targetBal.rows[0]?.balance || 0);

        if (sBal < trade.sender_coins) throw new Error('Sender has insufficient balance.');
        if (tBal < trade.target_coins) throw new Error('Target has insufficient balance.');

        const sItems = trade.sender_items || [];
        const tItems = trade.target_items || [];

        // ========== JIT (JUST-IN-TIME) VERIFICATION ==========
        // This is THE most critical security gate. Even if the UI allowed 
        // the setup, we re-verify everything here BEFORE the swap.
        // It prevents race conditions (e.g. user sells item while accepting trade).
        
        // Ensure recipients don't already possess the items they are about to receive
        const jitVerify = async (receiverId, itemIds, roleContextMember) => {
            if (!itemIds || itemIds.length === 0) return;
            
            // Get role info for JIT items
            const res = await client.query(`
                SELECT s.role_id, s.name, s.id as shop_item_id 
                FROM shop_items s 
                WHERE s.id IN (SELECT shop_item_id FROM user_inventory WHERE id = ANY($1))
            `, [itemIds]);
            
            // Get current receiver state
            const receiverInv = await client.query('SELECT shop_item_id FROM user_inventory WHERE user_id = $1 AND guild_id = $2', [receiverId, trade.guild_id]);
            const receiverOwnedItemIds = receiverInv.rows.map(r => r.shop_item_id);
            
            for (const row of res.rows) {
                const firstRole = row.role_id?.split(/[,\s]+/)[0];
                const hasRoleResult = firstRole && roleContextMember && roleContextMember.roles.cache.has(firstRole);
                const hasItemResult = receiverOwnedItemIds.includes(row.shop_item_id);
                
                if (hasRoleResult || hasItemResult) {
                    throw new Error(`Recipient already possesses role/item: **${row.name}**`);
                }
            }
        };

        await jitVerify(trade.target_id, sItems, targetMember); // Verify Target doesn't already have Sender's items
        await jitVerify(trade.sender_id, tItems, senderMember); // Verify Sender doesn't already have Target's items

        // 4. ATOMIC COIN SWAP (FEE-FIRST MODEL)
        if (sItems.length > 0) {
            const res = await client.query(
                `SELECT i.id, i.shop_item_id, s.name, s.duration_hours, s.duration_seconds 
                 FROM user_inventory i 
                 JOIN shop_items s ON i.shop_item_id = s.id 
                 WHERE i.id = ANY($1) AND i.user_id = $2 AND i.guild_id = $3
                 FOR UPDATE`,
                [sItems, trade.sender_id, trade.guild_id]
            );
            if (res.rowCount !== sItems.length) throw new Error('One or more sender items are missing or transferred.');
        }

        if (tItems.length > 0) {
            const res = await client.query(
                `SELECT i.id, i.shop_item_id, s.name, s.duration_hours, s.duration_seconds 
                 FROM user_inventory i 
                 JOIN shop_items s ON i.shop_item_id = s.id 
                 WHERE i.id = ANY($1) AND i.user_id = $2 AND i.guild_id = $3
                 FOR UPDATE`,
                [tItems, trade.target_id, trade.guild_id]
            );
            if (res.rowCount !== tItems.length) throw new Error('One or more target items are missing or transferred.');
        }

        // 4. ATOMIC SWAP - Coins (FEE-FIRST MODEL)
        const processCoinSwap = async (giverId, receiverId, rawAmount, giverMember, receiverMember) => {
            const amount = parseInt(rawAmount, 10) || 0;
            if (amount <= 0) return;

            const isGiverBooster = await isMemberBooster(giverMember);
            const { fee, recipientGets, senderPaysExtra } = calculateTradeTax(amount, isGiverBooster);
            
            const gBalRes = await client.query('SELECT balance FROM user_balances WHERE user_id = $1 AND guild_id = $2 FOR UPDATE', [giverId, trade.guild_id]);
            const currentGiverBal = parseInt(gBalRes.rows[0].balance);

            let finalSenderDeduction = amount;
            let finalRecipientIntake = amount;
            let finalFee = fee;
            let phase = 1;

            if (currentGiverBal >= amount + senderPaysExtra) {
                // PHASE 1: Sender pays the fee
                finalSenderDeduction = amount + senderPaysExtra;
                finalRecipientIntake = amount;
                phase = 1;
            } else if (currentGiverBal >= amount) {
                // PHASE 2: Fallback - Recipient pays the fee
                finalSenderDeduction = amount;
                finalRecipientIntake = amount - fee;
                phase = 2;
            } else {
                throw new Error('Giver has insufficient balance to cover the base amount.');
            }

            // 1. DUAL-ENTRY UPDATE (Giver & Receiver)
            const gName = getUserDisplayName(giverMember);
            const rName = getUserDisplayName(receiverMember);

            // Giver Deduction (Centralized)
            const gRes = await updateBalance(
                giverId, 
                trade.guild_id, 
                -amount, 
                'trade', 
                `P2P Trade to ${rName}`, 
                tradeId
            );

            // Receiver Grant (Centralized)
            const rRes = await updateBalance(
                receiverId, 
                trade.guild_id, 
                finalRecipientIntake, 
                'trade', 
                `P2P Trade from ${gName}${phase === 2 && finalFee > 0 ? ` (after ${finalFee} fee)` : ''}`, 
                tradeId
            );

            // Log for Giver (Fee Entry) if applied to them (Centralized)
            if (finalSenderDeduction > amount) {
                await updateBalance(
                    giverId, 
                    trade.guild_id, 
                    -(finalSenderDeduction - amount), 
                    'fee', 
                    `Trade Service Fee`, 
                    tradeId
                );
            }

            return { senderDeduction: finalSenderDeduction, recipientIntake: finalRecipientIntake, fee: finalFee, phase };

        };

        // Capture pre-trade balances for logging
        const initialSenderBal = parseInt(senderBal.rows[0]?.balance || 0);
        const initialTargetBal = parseInt(targetBal.rows[0]?.balance || 0);

        let sOutcome = null;
        if (trade.sender_coins > 0) {
            sOutcome = await processCoinSwap(trade.sender_id, trade.target_id, trade.sender_coins, senderMember, targetMember);
        }

        let tOutcome = null;
        if (trade.target_coins > 0) {
            tOutcome = await processCoinSwap(trade.target_id, trade.sender_id, trade.target_coins, targetMember, senderMember);
        }

        // Fetch final balances after commission/fee deductions
        const finalSenderDetails = await client.query('SELECT balance FROM user_balances WHERE user_id = $1 AND guild_id = $2', [trade.sender_id, trade.guild_id]);
        const finalTargetDetails = await client.query('SELECT balance FROM user_balances WHERE user_id = $1 AND guild_id = $2', [trade.target_id, trade.guild_id]);
        const finalSenderBal = parseInt(finalSenderDetails.rows[0]?.balance || 0);
        const finalTargetBal = parseInt(finalTargetDetails.rows[0]?.balance || 0);

        // 5. ATOMIC SWAP - Items (Layer 4: Failsafe - only transfer SHOP-sourced items)
        // Capture shop_item_ids BEFORE the swap for Domino Sweep
        let senderLostShopItemIds = [];
        let targetLostShopItemIds = [];

        if (sItems.length > 0) {
            // Re-verify restricted items before swap (STRICT OWNERSHIP CHECK)
            const validSRes = await client.query(
                `SELECT i.id, i.shop_item_id, i.role_id FROM user_inventory i 
                 WHERE i.id = ANY($1) AND i.user_id = $2 AND i.guild_id = $3 AND i.source = 'SHOP'`,
                [sItems, trade.sender_id, trade.guild_id]
            );
            const validSIds = validSRes.rows.map(r => r.id);
            senderLostShopItemIds = validSRes.rows.map(r => r.shop_item_id);
            if (validSIds.length > 0) {
                // Transfer but do NOT auto-equip for target (set is_active = false)
                await client.query('UPDATE user_inventory SET user_id = $1, is_active = false WHERE id = ANY($2) AND guild_id = $3', [trade.target_id, validSIds, trade.guild_id]);
            }
        }

        if (tItems.length > 0) {
            const validTRes = await client.query(
                `SELECT i.id, i.shop_item_id, i.role_id FROM user_inventory i 
                 WHERE i.id = ANY($1) AND i.user_id = $2 AND i.guild_id = $3 AND i.source = 'SHOP'`,
                [tItems, trade.target_id, trade.guild_id]
            );
            const validTIds = validTRes.rows.map(r => r.id);
            targetLostShopItemIds = validTRes.rows.map(r => r.shop_item_id);
            if (validTIds.length > 0) {
                // Transfer but do NOT auto-equip for sender (set is_active = false)
                await client.query('UPDATE user_inventory SET user_id = $1, is_active = false WHERE id = ANY($2) AND guild_id = $3', [trade.sender_id, validTIds, trade.guild_id]);
            }
        }

        // 6. Finalize Trade Status
        await client.query('UPDATE trades SET status = $1 WHERE id = $2 AND guild_id = $3', ['accepted', tradeId, trade.guild_id]);

        await client.query('COMMIT');

        // Step 2: Deep Cleanup Verification (500ms delay)
        if (sItems.length > 0 || tItems.length > 0) {
            setTimeout(async () => {
                try {
                    const freshS = await interaction.guild.members.fetch(trade.sender_id).catch(() => null);
                    const freshT = await interaction.guild.members.fetch(trade.target_id).catch(() => null);
                    
                    if (sItems.length > 0 && freshS) {
                        const sRoleRes = await query('SELECT role_id FROM shop_items WHERE id IN (SELECT shop_item_id FROM user_inventory WHERE id = ANY($1))', [sItems]);
                        for (const row of sRoleRes.rows) {
                             if (row.role_id && freshS.roles.cache.has(row.role_id)) {
                                 sysLog('Admin Role Overlap Detected', { user: trade.sender_id, detail: `Role: ${row.role_id} (Not removed)` });
                             }
                        }
                    }
                    if (tItems.length > 0 && freshT) {
                         const tRoleRes = await query('SELECT role_id FROM shop_items WHERE id IN (SELECT shop_item_id FROM user_inventory WHERE id = ANY($1))', [tItems]);
                         for (const row of tRoleRes.rows) {
                              if (row.role_id && freshT.roles.cache.has(row.role_id)) {
                                  sysLog('Admin Role Overlap Detected', { user: trade.target_id, detail: `Role: ${row.role_id} (Not removed)` });
                              }
                         }
                    }
                } catch (e) { }
            }, 500);
        }
        
        // 7. REAL-TIME ROLE SWAP (Prevent duplication glitches)
        try {
            if (senderMember || targetMember) {
                // Items GIVEN (Sender -> Target)
                if (sItems.length > 0 && senderMember) {
                    const res = await query('SELECT role_id FROM shop_items WHERE id IN (SELECT shop_item_id FROM user_inventory WHERE id = ANY($1))', [sItems]);
                    for (const row of res.rows) {
                        if (row.role_id) {
                            // strictly remove from sender, do NOT add to target (they must manually equip)
                            await senderMember.roles.remove(row.role_id).catch(() => null);
                        }
                    }
                }
                // Items REQUESTED (Target -> Sender)
                if (tItems.length > 0 && targetMember) {
                    const res = await query('SELECT role_id FROM shop_items WHERE id IN (SELECT shop_item_id FROM user_inventory WHERE id = ANY($1))', [tItems]);
                    for (const row of res.rows) {
                        if (row.role_id) {
                            // strictly remove from target, do NOT add to sender (they must manually equip)
                            await targetMember.roles.remove(row.role_id).catch(() => null);
                        }
                    }
                }
            }
        } catch (roleError) {
            sysError('Failed to swap roles after trade', roleError, { guild: interaction.guildId, detail: `TradeID: ${tradeId}` });
            // Non-critical, sync cycle will catch it eventually, but we tried!
        }

        // 7b. DOMINO SWEEP (Post-Trade Cascading Unequip)
        let senderUnequipped = [];
        let targetUnequipped = [];
        try {
            if (senderMember) senderUnequipped = await runDependencySweep(trade.sender_id, trade.guild_id, senderMember);
            if (targetMember) targetUnequipped = await runDependencySweep(trade.target_id, trade.guild_id, targetMember);
        } catch (sweepError) {
            sysError('Post-trade domino sweep error', sweepError, { guild: interaction.guildId, detail: `TradeID: ${tradeId}` });
        }


        // 8. Update UI with Fee Details
        let completionDesc = `✅ Trade Completed! <@${trade.sender_id}> 🤝 <@${trade.target_id}>\n\n`;

        // Prerequisite Alerts (If any items were swept)
        if (senderUnequipped.length > 0) {
            completionDesc += `⚠️ **<@${trade.sender_id}>:** Unequipped **${senderUnequipped.join(', ')}** (Missing prerequisites)\n`;
        }
        if (targetUnequipped.length > 0) {
            completionDesc += `⚠️ **<@${trade.target_id}>:** Unequipped **${targetUnequipped.join(', ')}** (Missing prerequisites)\n`;
        }
        if (senderUnequipped.length > 0 || targetUnequipped.length > 0) completionDesc += '\n';
        
        // Redundant fee details removed from content as per user request (already in embed or not needed)

        await interaction.update({
            content: completionDesc,
            components: [],
            embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setColor(0x2ECC71).setFooter({ text: 'Trade Successful' })]
        });

        // 9. Clear Garbage Collector
        const timeoutId = TRADE_TIMEOUTS.get(tradeId);
        if (timeoutId) {
            clearTimeout(timeoutId);
            TRADE_TIMEOUTS.delete(tradeId);
        }

        // 10. Standardized Economy Log
        const senderUsername = getUserLogName(senderMember);
        const targetUsername = getUserLogName(targetMember);
        const offerText = `${Number(trade.sender_coins) > 0 ? `**${Number(trade.sender_coins).toLocaleString()}** ${COIN_EMOJI}` : ''}${sItems.length > 0 ? (Number(trade.sender_coins) > 0 ? ' and ' : '') + `**${sItems.length} items**` : ''}` || 'Nothing';
        const requestText = `${Number(trade.target_coins) > 0 ? `**${Number(trade.target_coins).toLocaleString()}** ${COIN_EMOJI}` : ''}${tItems.length > 0 ? (Number(trade.target_coins) > 0 ? ' and ' : '') + `**${tItems.length} items**` : ''}` || 'Nothing';

        let impactDetails = `**Financial Impact:**\n` +
          `• **${senderUsername}:** \`${initialSenderBal.toLocaleString()}\` ➡️ \`${finalSenderBal.toLocaleString()}\` ${COIN_EMOJI}`;
        
        if (sOutcome && sOutcome.fee > 0) {
            impactDetails += ` (Incl. \`${sOutcome.fee.toLocaleString()}\` Tax)`;
        }

        impactDetails += `\n• **${targetUsername}:** \`${initialTargetBal.toLocaleString()}\` ➡️ \`${finalTargetBal.toLocaleString()}\` ${COIN_EMOJI}`;
        
        if (tOutcome && tOutcome.fee > 0) {
            impactDetails += ` (Incl. \`${tOutcome.fee.toLocaleString()}\` Tax)`;
        }

        sendLog(interaction.guild, 'inventory', 'purple', '🤝 P2P Trade Completed', 
          `**Participants:** \`${senderUsername}\` 🤝 \`${targetUsername}\`\n\n` +
          `**${senderUsername} Gave:** ${offerText}\n` +
          `**${targetUsername} Gave:** ${requestText}\n\n` +
          impactDetails
        );

    } catch (err) {
        await client.query('ROLLBACK');
        let errorMessage = `❌ Trade Failed: ${err.message.includes('insufficient') || err.message.includes('missing') ? err.message : 'Database error occurred during execution.'}`;
        
        // CATCH: Security Cap Violation (500k limit)
        if (err.message.includes('exceeds the safety cap')) {
            errorMessage = `❌ **Security Error:** ${err.message}`;
        }
        
        // Update public message if it's a verification failure
        if (err.message.includes('insufficient') || err.message.includes('missing') || err.message.includes('already')) {
           await query('UPDATE trades SET status = $1 WHERE id = $2 AND guild_id = $3', ['canceled', tradeId, interaction.guildId]);
           await interaction.update({
                content: `❌ **Trade Canceled: Assets Missing.**\nOne of the participants no longer has the required coins/items.`,
                components: [],
                embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setColor(0xEE4444)]
           });
        } else {
            await interaction.reply({ content: errorMessage, flags: MessageFlags.Ephemeral });
        }
    } finally {
        client.release();
    }
}
