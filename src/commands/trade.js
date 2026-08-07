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
    PermissionFlagsBits,
    InteractionType
} from 'discord.js';
import { query, getPool } from '../storage/postgres.js';
import { sanitizeError, COIN_EMOJI, getUserDisplayName, isValidEconomyAmount, getUserLogName, safeTruncate } from '../shared.js';
import { sendLog, sysLog, sysError } from '../utils/logger.js';
import { getUserBalance } from '../economy/service.js';
import { isMemberBooster } from './colors.js';
import { buildPaginatedSelectMenu } from '../utils/paginator.js';
import { syncInventoryWithDiscord, runDependencySweep, getUserInventory, getShopCategories } from '../economy/shop.js';
import { handleInteractionError } from '../utils/errors.js';
import { getCachedGuildConfig } from '../activity/tracker.js';

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
 * STARTUP JANITOR: Recovers stale trades after a bot restart
 * Also schedules future timeouts for trades that are still alive!
 */
export async function initializeTradeJanitor(client) {
    const sweep = async () => {
        try {
            // 1. Cleanup ALREADY expired trades
            const staleRes = await query(
                `SELECT id, guild_id, message_id, channel_id, sender_id, target_id, expires_at 
                 FROM trades 
                 WHERE status = 'pending' AND expires_at < NOW()`
            );

            if (staleRes.rows.length > 0) {
                sysLog('Trade Janitor: Cleaning up stale trades', { count: staleRes.rows.length });
                for (const trade of staleRes.rows) {
                    await query('UPDATE trades SET status = $1 WHERE id = $2', ['expired', trade.id]).catch(() => {});
                    
                    const channel = await client.channels.fetch(trade.channel_id).catch(() => null);
                    if (channel) {
                        const msg = await channel.messages.fetch(trade.message_id).catch(() => null);
                        if (msg) {
                            const expiredEmbed = EmbedBuilder.from(msg.embeds[0])
                                .setColor(0x95A5A6)
                                .setFooter({ text: 'Trade Expired (Recovery Audit)' })
                                .setTimestamp();

                            await msg.edit({ content: '', embeds: [expiredEmbed], components: [] }).catch(() => {});
                        }
                    }
                }
            }

            // 2. Reschedule FUTURE timeouts for trades that were caught in a restart
            const aliveRes = await query(
                `SELECT id, guild_id, message_id, channel_id, expires_at 
                 FROM trades 
                 WHERE status = 'pending' AND expires_at > NOW()`
            );

            for (const trade of aliveRes.rows) {
                // If we don't already have a timer running for this trade
                if (!TRADE_TIMEOUTS.has(trade.id)) {
                    const remainingMs = new Date(trade.expires_at).getTime() - Date.now();
                    
                    if (remainingMs > 0) {
                        const timeoutId = setTimeout(async () => {
                            await initializeTradeJanitor(client); // Just run a sweep when it's time
                        }, remainingMs);
                        
                        TRADE_TIMEOUTS.set(trade.id, timeoutId);
                    }
                }
            }
        } catch (err) {
            sysError('Trade Janitor Sweep Failure', err);
        }
    };

    // Initial run
    await sweep();

    // Setup periodic sweep every 60 seconds as a final failsafe
    setInterval(sweep, 60000);
}


/**
 * Calculates trade tax (10%)
 * @param {number} amount 
 * @param {boolean} isBooster 
 * @returns {Object} Fee breakdown
 */
function calculateTradeTax(amount, isBooster = false) {
    // Boosters pay 0% fee, others pay 10%
    const rate = isBooster ? 0 : 0.10;
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
 * ─────────────────────────────────────────────────────
 * ANTI-CHEAT / ALT-ACCOUNT DETECTION ENGINE
 * Runs asynchronously AFTER a trade completes. Never blocks.
 * Evaluates 4 heuristic flags. If 2+ fire on either user,
 * a warning is dispatched to the inventory log channel.
 * ─────────────────────────────────────────────────────
 */
async function detectSuspiciousTrade(guild, senderId, targetId, senderDiscordUser, targetDiscordUser) {
    try {
        const now = Date.now();
        const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
        const guildId = guild.id;

        // ── Shared Data Queries (batched to minimize DB round-trips) ──────────

        // 1. Lifetime Clumping: count total trades per user and trades with each other
        const clumpRes = await query(
            `SELECT
                COUNT(*) FILTER (WHERE (sender_id = $1 OR target_id = $1) AND status = 'accepted') AS sender_total,
                COUNT(*) FILTER (WHERE (sender_id = $2 OR target_id = $2) AND status = 'accepted') AS target_total,
                COUNT(*) FILTER (
                    WHERE status = 'accepted'
                    AND sender_id = $1 AND target_id = $2
                ) AS sender_gave_to_target,
                COUNT(*) FILTER (
                    WHERE status = 'accepted'
                    AND sender_id = $2 AND target_id = $1
                ) AS target_gave_to_sender
            FROM trades
            WHERE guild_id = $3`,
            [senderId, targetId, guildId]
        );
        const cl = clumpRes.rows[0];
        const senderTotal = parseInt(cl.sender_total) || 0;
        const targetTotal = parseInt(cl.target_total) || 0;
        const senderGaveToTarget = parseInt(cl.sender_gave_to_target) || 0;
        const targetGaveToSender = parseInt(cl.target_gave_to_sender) || 0;

        // 2. Server-wide average message_count (dynamic baseline)
        const avgRes = await query(
            `SELECT COALESCE(AVG(message_count), 0) AS avg_msgs FROM user_activity WHERE guild_id = $1`,
            [guildId]
        );
        const serverAvgMsgs = parseFloat(avgRes.rows[0]?.avg_msgs) || 0;

        // 3. Individual activity for both users
        const actRes = await query(
            `SELECT user_id, message_count, voice_minutes
             FROM user_activity WHERE guild_id = $1 AND user_id = ANY($2::text[])`,
            [guildId, [senderId, targetId]]
        );
        const actMap = {};
        for (const row of actRes.rows) actMap[row.user_id] = row;

        // 4. Transaction diversity (for Farmer Routine flag)
        const txRes = await query(
            `SELECT user_id,
                COUNT(*) FILTER (WHERE type != 'trade') AS total_txn,
                COUNT(*) FILTER (WHERE type IN ('daily', 'quest')) AS passive_txn
             FROM transactions
             WHERE guild_id = $1 AND user_id = ANY($2::text[])
             GROUP BY user_id`,
            [guildId, [senderId, targetId]]
        );
        const txMap = {};
        for (const row of txRes.rows) txMap[row.user_id] = row;

        // ── Flag Evaluation ───────────────────────────────────────────────────
        const evaluateUser = (userId, discordUser, gaveToOther, userTotal) => {
            const flags = [];
            const act = actMap[userId] || { message_count: 0, voice_minutes: 0 };
            const tx = txMap[userId] || { total_txn: 0, passive_txn: 0 };
            const msgCount = parseInt(act.message_count) || 0;
            const voiceMins = parseInt(act.voice_minutes) || 0;
            const totalTxn = parseInt(tx.total_txn) || 0;
            const passiveTxn = parseInt(tx.passive_txn) || 0;

            // FLAG 1: Lifetime Trade Clumping (directional — only flags givers)
            if (userTotal > 3 && gaveToOther / userTotal > 0.8) {
                const pct = Math.round((gaveToOther / userTotal) * 100);
                flags.push(`${pct}% of lifetime trades are directed to this exact partner (${gaveToOther}/${userTotal} trades)`);
            }

            // FLAG 2: Dynamic Dead Chat Profile
            // Only relevant if the server has some average activity to compare against
            if (serverAvgMsgs > 5 && msgCount < serverAvgMsgs * 0.05) {
                flags.push(`**Dead Profile:** ${msgCount} messages vs. server avg of ${Math.round(serverAvgMsgs)}`);
            }

            // FLAG 3: Farmer Routine (>80% passive income, min 3 transactions to avoid new-user FPs)
            if (totalTxn >= 3 && passiveTxn / totalTxn > 0.8) {
                const pct = Math.round((passiveTxn / totalTxn) * 100);
                flags.push(`**Farmer:** ${pct}% of economy activity is passive (daily/quest only, ${passiveTxn}/${totalTxn} transactions)`);
            }

            // FLAG 4: Young Account (under 12 months old)
            if (discordUser && (now - discordUser.createdAt.getTime()) < ONE_YEAR_MS) {
                const months = Math.floor((now - discordUser.createdAt.getTime()) / (30 * 24 * 60 * 60 * 1000));
                flags.push(`**Young Account:** Discord account is only ${months} month(s) old`);
            }

            return flags;
        };

        const senderFlags = evaluateUser(senderId, senderDiscordUser, senderGaveToTarget, senderTotal);
        const targetFlags = evaluateUser(targetId, targetDiscordUser, targetGaveToSender, targetTotal);

        // ── Dispatch Warnings ─────────────────────────────────────────────────
        const buildWarning = (userId, flags) => {
            if (flags.length < 2) return;

            const description =
                `**Suspected User:** <@${userId}>\n` +
                `**Flags Triggered (${flags.length}/4):**\n` +
                flags.map(f => `• ${f}`).join('\n') +
                `\n\n⚠️ This is an automated warning. Review trading history manually before taking action.`;

            sendLog(guild, 'inventory', 'red', '⚠️ Possible Alt-Account Farming', description);
        };

        buildWarning(senderId, senderFlags);
        buildWarning(targetId, targetFlags);

    } catch (err) {
        // Non-critical — never crashes the trade flow
        sysError('Anti-Cheat Scan Failure', err, { guild: guild.id });
    }
}

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

        // ── Anti-Smurf / Anti-Alt Gate (7-Day Server Membership & 30-Day Discord Age) ──
        // UPDATED: Dynamic toggles via settings. Default to false (OFF) for all servers.
        const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
        const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
        const now = Date.now();
        const isSenderAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);

        // Fetch target member for checks
        const targetMemberForAgeCheck = await interaction.guild.members.fetch(target.id).catch(() => null);
        if (!targetMemberForAgeCheck) {
            return interaction.reply({ content: '❌ Could not fetch the target user.', flags: MessageFlags.Ephemeral });
        }
        const isTargetAdmin = targetMemberForAgeCheck.permissions.has(PermissionFlagsBits.Administrator);

        // Fetch cached config for dynamic toggles (defaulting to false / OFF)
        const guildConfig = await getCachedGuildConfig(guildId) || {};
        const ageGateEnabled = guildConfig.anti_cheat_account_age_gate ?? false;
        const joinGateEnabled = guildConfig.anti_cheat_join_date_gate ?? false;

        // 1. Check Sender Discord Account Age
        if (ageGateEnabled) {
            const senderAccountAge = now - sender.createdAt.getTime();
            if (senderAccountAge < THIRTY_DAYS_MS && !isSenderAdmin) {
                return interaction.reply({
                    content: '❌ Your Discord account must be at least 30 days old to participate in trading.',
                    flags: MessageFlags.Ephemeral
                });
            }
        }

        // 2. Check Sender Server Membership Age
        const senderJoinedAt = interaction.member.joinedAt;
        if (joinGateEnabled) {
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
        }

        // 4. Check Target Discord Account Age
        if (ageGateEnabled) {
            const targetAccountAge = now - target.createdAt.getTime();
            if (targetAccountAge < THIRTY_DAYS_MS && !isTargetAdmin) {
                return interaction.reply({
                    content: '❌ The target user\'s Discord account must be at least 30 days old to participate in trading.',
                    flags: MessageFlags.Ephemeral
                });
            }
        }

        // 5. Check Target Server Membership Age
        const targetJoinedAt = targetMemberForAgeCheck.joinedAt;
        if (joinGateEnabled) {
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
                value: `• **Coins:** ${setup.senderCoins.toLocaleString()} ${COIN_EMOJI}\n• **Items:** ${setup.senderItems.length === 0 ? 'None' : setup.senderItems.map(i => (parseInt(i.quantity || 1) > 1 ? `**${i.quantity}x ${i.name}**` : `**${i.name}**`)).join(', ')}`,
                inline: true
            },
            {
                name: '📥 You Request',
                value: `• **Coins:** ${setup.targetCoins.toLocaleString()} ${COIN_EMOJI}\n• **Items:** ${setup.targetItems.length === 0 ? 'None' : setup.targetItems.map(i => (parseInt(i.quantity || 1) > 1 ? `**${i.quantity}x ${i.name}**` : `**${i.name}**`)).join(', ')}`,
                inline: true
            }
        )
        .setColor(0x3498DB)
        .setFooter({ text: '⚠️ Standard 10% fee applies (0% for Boosters)' });

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

    // Row 3: Finalize (Reset on left, Trade on right)
    const row3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`trade_setup_reset`)
            .setLabel('Reset')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`trade_setup_post`)
            .setLabel('Trade')
            .setStyle(ButtonStyle.Success)
            .setDisabled(setup.senderCoins === 0 && setup.targetCoins === 0 && setup.senderItems.length === 0 && setup.targetItems.length === 0)
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
            const senderBalance = await getUserBalance(setup.senderId, setup.guildId);
            const balanceNum = Number(senderBalance.balance) || 0;

            const modal = new ModalBuilder()
                .setCustomId('trade_modal_give_coins')
                .setTitle('Amount to Give');

            const input = new TextInputBuilder()
                .setCustomId('amount')
                .setLabel('How many coins are you giving?')
                .setPlaceholder(balanceNum.toLocaleString())
                .setStyle(TextInputStyle.Short)
                .setRequired(true);

            modal.addComponents(new ActionRowBuilder().addComponents(input));
            return interaction.showModal(modal);
        }

        // Coins Request Modal
        if (customId === 'trade_setup_request_coins') {
            const targetBalance = await getUserBalance(setup.targetId, setup.guildId);
            const balanceNum = Number(targetBalance.balance) || 0;

            const modal = new ModalBuilder()
                .setCustomId('trade_modal_request_coins')
                .setTitle('Amount to Request');

            const input = new TextInputBuilder()
                .setCustomId('amount')
                .setLabel('How many coins are you requesting?')
                .setPlaceholder(balanceNum.toLocaleString())
                .setStyle(TextInputStyle.Short)
                .setRequired(true);

            modal.addComponents(new ActionRowBuilder().addComponents(input));
            return interaction.showModal(modal);
        }

        // List Inventory to Give (FOLDER SYSTEM)
        if (customId === 'trade_setup_give_item' || customId === 'trade_cat_give_select' || (customId === 'trade_select_give_item' && interaction.values[0]?.startsWith('trade_folder_back_'))) {
            return renderTradeItemMenu(interaction, setup, 'give');
        }

        // List Target Inventory to Request (FOLDER SYSTEM)
        if (customId === 'trade_setup_request_item' || customId === 'trade_cat_req_select' || (customId === 'trade_select_request_item' && interaction.values[0]?.startsWith('trade_folder_back_'))) {
            return renderTradeItemMenu(interaction, setup, 'req');
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
 * Render Item/Category Select Menu for Trade (Preserves folder state across selections)
 */
async function renderTradeItemMenu(interaction, setup, aspect, page = 1) {
    const isGive = aspect === 'give';
    const selectedCatId = isGive ? setup.givingFolder : setup.requestingFolder;
    
    let tradableItems = [];
    if (isGive) {
        const allItems = await getUserInventory(setup.senderId, setup.guildId);
        const targetMember = await interaction.guild.members.fetch(setup.targetId).catch(() => null);
        const targetInv = targetMember ? await getUserInventory(setup.targetId, setup.guildId) : [];

        // Count recipient's current total quantity per shop_item_id
        const targetQtyMap = {};
        for (const item of targetInv) {
            targetQtyMap[item.shop_item_id] = (targetQtyMap[item.shop_item_id] || 0) + (parseInt(item.quantity) || 1);
        }

        tradableItems = allItems.filter(i => {
           const source = (i.purchase_source || '').toLowerCase();
           if (source !== 'shop' || i.item_type === 'pack') return false; 
           if (i.is_tradable === false) return false; // Filter out Locked items
           const rawQty = parseInt(i.quantity) || 1;
           const availToTrade = i.expires_at ? (rawQty - 1) : rawQty;
           if (availToTrade <= 0) return false;

           const recipientTotalQty = targetQtyMap[i.shop_item_id] || 0;
           return recipientTotalQty < 999;
        });

        if (tradableItems.length === 0) {
            if (isGive) setup.givingFolder = null;
            return interaction.followUp({ content: "❌ You don't have any tradable items.", flags: MessageFlags.Ephemeral });
        }
    } else {
        const member = await interaction.guild.members.fetch(setup.targetId).catch(() => null);
        if (!member) return interaction.editReply({ content: '❌ Target member not found.', components: [], embeds: [] });
        
        const allItems = await getUserInventory(setup.targetId, setup.guildId);
        const senderInv = await getUserInventory(setup.senderId, setup.guildId);

        // Count requester's current total quantity per shop_item_id
        const senderQtyMap = {};
        for (const item of senderInv) {
            senderQtyMap[item.shop_item_id] = (senderQtyMap[item.shop_item_id] || 0) + (parseInt(item.quantity) || 1);
        }

        tradableItems = allItems.filter(i => {
            const source = (i.purchase_source || '').toLowerCase();
            if (source !== 'shop' || i.item_type === 'pack') return false;
            if (i.is_tradable === false) return false;
            const rawQty = parseInt(i.quantity) || 1;
            const availToTrade = i.expires_at ? (rawQty - 1) : rawQty;
            if (availToTrade <= 0) return false;

            const requesterTotalQty = senderQtyMap[i.shop_item_id] || 0;
            return requesterTotalQty < 999;
        });

        if (tradableItems.length === 0) {
            if (!isGive) setup.requestingFolder = null;
            return interaction.followUp({ content: "❌ The target user doesn't have any tradable items.", flags: MessageFlags.Ephemeral });
        }
    }

    if (!selectedCatId && selectedCatId !== 0) {
        const categories = await getShopCategories(setup.guildId);
        const validCatIds = new Set(tradableItems.map(i => i.category_id));
        const availableCats = categories.filter(c => validCatIds.has(c.id));

        if (availableCats.length === 0) {
            if (isGive) setup.givingFolder = -1;
            else setup.requestingFolder = -1;
        } else {
            const options = availableCats.map(c => ({ label: `📁 ${c.name}`, value: `trade_cat_${isGive ? 'give' : 'req'}_${c.id}` }));
            if (tradableItems.some(i => !i.category_id)) options.push({ label: '📁 Uncategorized', value: `trade_cat_${isGive ? 'give' : 'req'}_-1` });

            const catSelect = new StringSelectMenuBuilder()
                .setCustomId(`trade_cat_${isGive ? 'give' : 'req'}_select`)
                .setPlaceholder(`Select item(s) to ${isGive ? 'give' : 'request'}`)
                .addOptions(options);

            return showTradeSetup(interaction, setup, new ActionRowBuilder().addComponents(catSelect));
        }
    }

    const currentCatId = isGive ? setup.givingFolder : setup.requestingFolder;
    const finalCatId = (currentCatId === -1 || currentCatId === null) ? null : currentCatId;
    const folderItems = tradableItems.filter(i => (finalCatId === null ? !i.category_id : i.category_id === finalCatId));

    if (folderItems.length === 0) {
        if (isGive) setup.givingFolder = null;
        else setup.requestingFolder = null;
        return renderTradeItemMenu(interaction, setup, aspect);
    }

    const { selectMenu } = buildPaginatedSelectMenu({
        items: folderItems,
        page,
        customId: `trade_select_${isGive ? 'give' : 'req'}_item`,
        placeholder: `Select an item to ${isGive ? 'give' : 'request'}...`,
        backOption: { label: 'Back', value: `trade_folder_back_${isGive ? 'give' : 'req'}`, emoji: '⬅️' },
        pageNavPrefix: `trade_page_${isGive ? 'give' : 'req'}_`,
        pageSize: 20,
        mapOption: row => {
            const qty = parseInt(row.quantity) || 1;
            const qtyLabel = ` (x${qty})`;
            return {
                label: `🏷️ ${row.name}${qtyLabel}`,
                value: row.id.toString()
            };
        }
    });

    if (isGive) setup.givingFolder = finalCatId ?? -1;
    else setup.requestingFolder = finalCatId ?? -1;
    
    return showTradeSetup(interaction, setup, new ActionRowBuilder().addComponents(selectMenu));
}

/**
 * Handle Modal Submissions for coins
 */
export async function handleTradeModal(interaction) {
    const setupId = `${interaction.guildId}_${interaction.user.id}`;
    const setup = ACTIVE_SETUPS.get(setupId);
    if (!setup) {
        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => { });
        return interaction.editReply({ content: '❌ Session expired.', components: [], embeds: [] });
    }

    if (interaction.customId.startsWith('trade_modal_item_qty_')) {
        const parts = interaction.customId.split('_');
        // trade(0) modal(1) item(2) qty(3) aspect(4: give/req) invId(5)
        const aspect = parts[4];
        const isGive = aspect === 'give';
        const invId = parseInt(parts[5], 10);
        const itemOwnerId = isGive ? interaction.user.id : setup.targetId;

        const rawQty = interaction.fields.getTextInputValue('trade_qty');
        const qty = parseInt(rawQty, 10);
        if (isNaN(qty) || qty < 1) {
            if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => { });
            return interaction.followUp({ content: '❌ Please enter a valid quantity of 1 or more.', flags: MessageFlags.Ephemeral });
        }

        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => { });

        const result = await query(
            `SELECT i.id, i.shop_item_id, i.source, i.expires_at, COALESCE(i.quantity, 1) as quantity, s.name, s.duration_hours, s.duration_seconds, s.role_id, s.is_tradable 
             FROM user_inventory i
             JOIN shop_items s ON i.shop_item_id = s.id 
             WHERE i.id = $1 AND i.guild_id = $2 AND i.user_id = $3`,
            [invId, setup.guildId, itemOwnerId]
        );
        if (result.rows.length === 0) return interaction.followUp({ content: '❌ Item not found.', flags: MessageFlags.Ephemeral });
        const item = result.rows[0];

        const recipientId = isGive ? setup.targetId : setup.senderId;
        const recipientRes = await query(
            'SELECT COALESCE(SUM(COALESCE(quantity, 1)), 0) as total FROM user_inventory WHERE user_id = $1 AND shop_item_id = $2 AND guild_id = $3',
            [recipientId, item.shop_item_id, setup.guildId]
        );
        const recipientTotal = parseInt(recipientRes.rows[0]?.total || 0);
        const maxAllowedByCap = 999 - recipientTotal;
        const rawOwned = parseInt(item.quantity) || 1;
        const itemOwnedQty = item.expires_at ? Math.max(0, rawOwned - 1) : rawOwned;
        const availableQty = Math.min(itemOwnedQty, maxAllowedByCap);

        if (qty > availableQty) {
            return interaction.followUp({ content: `❌ You can only trade up to ${availableQty} cop${availableQty === 1 ? 'y' : 'ies'} of this item.`, flags: MessageFlags.Ephemeral });
        }

        const targetList = isGive ? setup.senderItems : setup.targetItems;
        const existingIdx = targetList.findIndex(i => i.id === invId);
        const itemObj = { ...item, quantity: qty };
        if (existingIdx !== -1) {
            targetList[existingIdx] = itemObj;
        } else {
            targetList.push(itemObj);
        }

        return renderTradeItemMenu(interaction, setup, aspect);
    }

    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => { });

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
    if (interaction.values[0]?.startsWith('trade_folder_back_')) {
        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => { });
        return handleTradeSetupInteraction(interaction);
    }

    const setupId = `${interaction.guildId}_${interaction.user.id}`;
    const setup = ACTIVE_SETUPS.get(setupId);
    if (!setup) {
        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => { });
        return interaction.editReply({ content: '❌ Session expired.', components: [], embeds: [] });
    }

    if (interaction.values[0]?.startsWith('trade_page_')) {
        const parts = interaction.values[0].split('_'); // trade_page_[give/req]_[page]
        const aspect = parts[2];
        const targetPage = parseInt(parts[3], 10) || 1;
        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => { });
        return renderTradeItemMenu(interaction, setup, aspect, targetPage);
    }

    const invId = parseInt(interaction.values[0], 10);
    const isGive = interaction.customId === 'trade_select_give_item';
    const itemOwnerId = isGive ? interaction.user.id : setup.targetId;

    const result = await query(
        `SELECT i.id, i.shop_item_id, i.source, i.expires_at, COALESCE(i.quantity, 1) as quantity, s.name, s.duration_hours, s.duration_seconds, s.role_id, s.is_tradable 
         FROM user_inventory i
         JOIN shop_items s ON i.shop_item_id = s.id 
         WHERE i.id = $1 AND i.guild_id = $2 AND i.user_id = $3`,
        [invId, setup.guildId, itemOwnerId]
    );

    if (result.rows.length === 0) {
        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => { });
        return interaction.followUp({ content: '❌ Item not found.', flags: MessageFlags.Ephemeral });
    }

    const item = result.rows[0];

    if (item.source !== 'SHOP') {
        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => { });
        return interaction.followUp({ content: '❌ You cannot trade items granted by admins (Soulbound).', flags: MessageFlags.Ephemeral });
    }

    if (item.is_tradable === false) {
        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => { });
        return interaction.followUp({ content: '❌ This item is locked and cannot be traded.', flags: MessageFlags.Ephemeral });
    }

    const rawOwned = parseInt(item.quantity) || 1;
    const itemOwnedQty = item.expires_at ? Math.max(0, rawOwned - 1) : rawOwned;
    if (itemOwnedQty <= 0) {
        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => { });
        return interaction.followUp({ content: '❌ An active running temporary item cannot be traded.', flags: MessageFlags.Ephemeral });
    }

    const recipientId = isGive ? setup.targetId : setup.senderId;
    const recipientRes = await query(
        'SELECT COALESCE(SUM(COALESCE(quantity, 1)), 0) as total FROM user_inventory WHERE user_id = $1 AND shop_item_id = $2 AND guild_id = $3',
        [recipientId, item.shop_item_id, setup.guildId]
    );
    const recipientTotal = parseInt(recipientRes.rows[0]?.total || 0);
    const maxAllowedByCap = 999 - recipientTotal;
    const availableQty = Math.min(itemOwnedQty, maxAllowedByCap);

    if (availableQty <= 0) {
        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => { });
        return interaction.followUp({ content: '❌ The recipient already has the maximum of 999 copies of this item.', flags: MessageFlags.Ephemeral });
    }

    if (availableQty >= 1) {
        const modalTitle = safeTruncate(`${isGive ? 'Giving' : 'Requesting'} ${item.name}`, 45);
        const modal = new ModalBuilder()
            .setCustomId(`trade_modal_item_qty_${isGive ? 'give' : 'req'}_${invId}`)
            .setTitle(modalTitle);

        const qtyInput = new TextInputBuilder()
            .setCustomId('trade_qty')
            .setLabel(isGive ? 'How many are you giving?' : 'How many are you requesting?')
            .setPlaceholder(String(itemOwnedQty))
            .setMinLength(1)
            .setMaxLength(3)
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(qtyInput));
        return await interaction.showModal(modal);
    } else {
        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => { });
        const targetList = isGive ? setup.senderItems : setup.targetItems;
        const existingIdx = targetList.findIndex(i => i.id === invId);
        const itemObj = { ...item, quantity: 1 };
        if (existingIdx !== -1) {
            targetList[existingIdx] = itemObj;
        } else {
            targetList.push(itemObj);
        }
        return renderTradeItemMenu(interaction, setup, isGive ? 'give' : 'req');
    }
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
                JSON.stringify(setup.senderItems.map(i => ({ id: i.id, shop_item_id: i.shop_item_id, name: i.name, qty: parseInt(i.quantity || 1) }))),
                JSON.stringify(setup.targetItems.map(i => ({ id: i.id, shop_item_id: i.shop_item_id, name: i.name, qty: parseInt(i.quantity || 1) }))),
                expiryDate
            ]
        );

        const tradeId = res.rows[0].id;

        // 2. Build Public Embed
        const embed = new EmbedBuilder()
            .setTitle('🤝 Trade Offer')
            .addFields(
                {
                    name: `📤 ${getUserDisplayName(await interaction.guild.members.fetch(setup.senderId))} Offers`,
                    value: `• **Coins:** ${setup.senderCoins.toLocaleString()} ${COIN_EMOJI}\n• **Items:** ${setup.senderItems.length === 0 ? 'None' : setup.senderItems.map(i => (parseInt(i.quantity || 1) > 1 ? `**${i.quantity}x ${i.name}**` : `**${i.name}**`)).join(', ')}`,
                    inline: false
                },
                {
                    name: `📥 Requested from ${getUserDisplayName(await interaction.guild.members.fetch(setup.targetId))}`,
                    value: `• **Coins:** ${setup.targetCoins.toLocaleString()} ${COIN_EMOJI}\n• **Items:** ${setup.targetItems.length === 0 ? 'None' : setup.targetItems.map(i => (parseInt(i.quantity || 1) > 1 ? `**${i.quantity}x ${i.name}**` : `**${i.name}**`)).join(', ')}`,
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
            content: `<@${setup.senderId}> ↔️ <@${setup.targetId}>\n**Expires:** <t:${Math.floor(expiryDate.getTime() / 1000)}:R>`,
            embeds: [embed],
            components: [row]
        });

        // 4. Record Message ID and Jump URL in DB
        await query(
            'UPDATE trades SET message_id = $1, channel_id = $2, message_url = $3 WHERE id = $4 AND guild_id = $5',
            [publicMsg.id, interaction.channelId, publicMsg.url, tradeId, setup.guildId]
        );

        // 5. Set Expiration Timeout (Garbage Collector)
        const channelId = interaction.channelId;
        const msgId = publicMsg.id;
        
        const timeoutId = setTimeout(async () => {
            try {
                // Check if still pending
                const check = await query('SELECT status FROM trades WHERE id = $1 AND guild_id = $2', [tradeId, setup.guildId]);
                if (check.rows.length > 0 && check.rows[0].status === 'pending') {
                    await query('UPDATE trades SET status = $1 WHERE id = $2 AND guild_id = $3', ['expired', tradeId, setup.guildId]);

                    // Edit original message to show expired state
                    const expiredEmbed = EmbedBuilder.from(embed)
                        .setColor(0x95A5A6) // Gray
                        .setFooter({ text: 'Trade Expired' })
                        .setTimestamp();
                    
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
                    const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
                    if (channel) {
                        const targetMsg = await channel.messages.fetch(msgId).catch(() => null);
                        if (targetMsg) {
                            await targetMsg.edit({
                                content: '',
                                embeds: [expiredEmbed],
                                components: []
                            }).catch((e) => sysError('Trade auto-expire edit fail', e));
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

    // Expiry Check (JIT Cleanup)
    if (new Date() > new Date(trade.expires_at)) {
        await query('UPDATE trades SET status = $1 WHERE id = $2 AND guild_id = $3', ['expired', tradeId, interaction.guildId]);
        
        // Clean up the message visually so it doesn't look like a "Zombie"
        try {
            const expiredEmbed = EmbedBuilder.from(interaction.message.embeds[0])
                .setColor(0x95A5A6)
                .setFooter({ text: 'Trade Expired' })
                .setTimestamp();

            await interaction.update({
                content: '',
                embeds: [expiredEmbed],
                components: []
            }).catch(() => { });
        } catch (e) {
            return interaction.reply({ content: '❌ This trade offer has expired.', flags: MessageFlags.Ephemeral });
        }
        return;
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
            content: '',
            components: [],
            embeds: [declinedEmbed.setFooter({ text: 'Trade Declined' }).setTimestamp()]
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

        // JIT EXPIRATION CHECK: If we missed the timeout due to restart
        if (trade.expires_at && new Date(trade.expires_at) < new Date()) {
            await client.query('UPDATE trades SET status = $1 WHERE id = $2', ['expired', tradeId]);
            await client.query('COMMIT');
            
            await interaction.editReply({
                content: '',
                components: [],
                embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setColor(0x95A5A6).setFooter({ text: 'Trade Expired' }).setTimestamp()]
            });
            return;
        }

        // 2. JIT Verification - Check Balances
        const senderBal = await client.query('SELECT balance FROM user_balances WHERE user_id = $1 AND guild_id = $2 FOR UPDATE', [trade.sender_id, trade.guild_id]);
        const targetBal = await client.query('SELECT balance FROM user_balances WHERE user_id = $1 AND guild_id = $2 FOR UPDATE', [trade.target_id, trade.guild_id]);

        // Pre-fetch members for Display Names and Role Sync
        const senderMember = await interaction.guild.members.fetch(trade.sender_id).catch(() => null);
        const targetMember = await interaction.guild.members.fetch(trade.target_id).catch(() => null);

        const sBal = parseInt(senderBal.rows[0]?.balance || 0);
        const tBal = parseInt(targetBal.rows[0]?.balance || 0);

        if (sBal < parseInt(trade.sender_coins)) throw new Error('Sender has insufficient balance.');
        if (tBal < parseInt(trade.target_coins)) throw new Error('Target has insufficient balance.');

        // Helper to normalize trade item structures (handles both legacy ID arrays and new object arrays)
        const extractTradeItemObjects = (rawItems) => {
            if (!rawItems || !Array.isArray(rawItems)) return [];
            return rawItems.map(item => {
                if (typeof item === 'number' || typeof item === 'string') {
                    const id = parseInt(item, 10);
                    return isNaN(id) ? null : { id, qty: 1 };
                } else if (typeof item === 'object' && item !== null) {
                    const id = parseInt(item.id || item.invId, 10);
                    const qty = parseInt(item.qty || item.quantity, 10) || 1;
                    return isNaN(id) ? null : { id, shop_item_id: item.shop_item_id, qty };
                }
                return null;
            }).filter(Boolean);
        };

        const sItemObjects = extractTradeItemObjects(trade.sender_items);
        const tItemObjects = extractTradeItemObjects(trade.target_items);
        const sItems = sItemObjects.map(i => i.id);
        const tItems = tItemObjects.map(i => i.id);

        // Pre-compute booster status BEFORE entering DB transaction
        const senderIsBooster = senderMember ? await isMemberBooster(senderMember) : false;
        const targetIsBooster = targetMember ? await isMemberBooster(targetMember) : false;

        // ========== JIT (JUST-IN-TIME) VERIFICATION ==========
        const jitVerify = async (senderId, receiverId, itemObjects, roleContextMember) => {
            if (!itemObjects || itemObjects.length === 0) return;
            
            const safeIds = itemObjects.map(i => i.id).filter(n => !isNaN(n));
            if (safeIds.length === 0) return;

            // Lock offered inventory rows and verify sender still owns them (quantity-aware)
            const senderItemsRes = await client.query(`
                SELECT i.id, i.shop_item_id, i.quantity, s.name, s.is_tradable, s.role_id
                FROM user_inventory i
                JOIN shop_items s ON i.shop_item_id = s.id
                WHERE i.id = ANY($1::int[]) AND i.user_id = $2 AND i.guild_id = $3
                FOR UPDATE
            `, [safeIds, senderId, trade.guild_id]);

            if (senderItemsRes.rowCount !== safeIds.length) {
                throw new Error('One or more items you offered are no longer in your inventory.');
            }

            for (const row of senderItemsRes.rows) {
                const offerObj = itemObjects.find(o => o.id === row.id);
                const offerQty = offerObj ? (offerObj.qty || 1) : 1;
                const isLocked = row.is_tradable === false;

                if (isLocked) {
                    const receiverHas = await client.query(
                        `SELECT 1 FROM user_inventory WHERE user_id = $1 AND guild_id = $2 AND shop_item_id = $3 LIMIT 1`,
                        [receiverId, trade.guild_id, row.shop_item_id]
                    );
                    if (receiverHas.rows.length > 0) {
                        throw new Error(`Recipient already owns **${row.name}** (Locked item — only 1 copy allowed).`);
                    }
                    const firstRole = row.role_id?.split(/[,\s]+/)[0];
                    if (firstRole && roleContextMember && roleContextMember.roles.cache.has(firstRole)) {
                        throw new Error(`Recipient already has the role for **${row.name}** (Locked item).`);
                    }
                } else {
                    const receiverQtyRes = await client.query(
                        `SELECT COALESCE(SUM(COALESCE(quantity, 1)), 0) AS total
                         FROM user_inventory WHERE user_id = $1 AND guild_id = $2 AND shop_item_id = $3`,
                        [receiverId, trade.guild_id, row.shop_item_id]
                    );
                    const receiverCurrentQty = parseInt(receiverQtyRes.rows[0]?.total || 0);
                    if (receiverCurrentQty + offerQty > 999) {
                        throw new Error(`Trading **${row.name}** would push recipient over the 999-copy limit.`);
                    }
                }
            }
        };

        await jitVerify(trade.sender_id, trade.target_id, sItemObjects, targetMember);
        await jitVerify(trade.target_id, trade.sender_id, tItemObjects, senderMember);

        // 4. ATOMIC COIN SWAP (FEE-FIRST MODEL)
        if (sItems.length > 0) {
            const res = await client.query(
                `SELECT i.id, i.shop_item_id, s.name, s.duration_hours, s.duration_seconds 
                 FROM user_inventory i 
                 JOIN shop_items s ON i.shop_item_id = s.id 
                 WHERE i.id = ANY($1::int[]) AND i.user_id = $2 AND i.guild_id = $3
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
                 WHERE i.id = ANY($1::int[]) AND i.user_id = $2 AND i.guild_id = $3
                 FOR UPDATE`,
                [tItems, trade.target_id, trade.guild_id]
            );
            if (res.rowCount !== tItems.length) throw new Error('One or more target items are missing or transferred.');
        }

        const processCoinSwap = async (giverId, receiverId, rawAmount, giverMember, receiverMember, isGiverBoosterPrecomputed) => {
            const amount = parseInt(rawAmount, 10) || 0;
            if (amount <= 0) return null;

            const { fee, senderPaysExtra } = calculateTradeTax(amount, isGiverBoosterPrecomputed);

            const gBalRes = await client.query('SELECT balance FROM user_balances WHERE user_id = $1 AND guild_id = $2 FOR UPDATE', [giverId, trade.guild_id]);
            const currentGiverBal = parseInt(gBalRes.rows[0]?.balance ?? 0);

            let finalSenderDeduction = amount;
            let finalRecipientIntake = amount;
            let finalFee = fee;
            let phase = 1;

            if (currentGiverBal >= amount + senderPaysExtra) {
                finalSenderDeduction = amount + senderPaysExtra;
                finalRecipientIntake = amount;
                phase = 1;
            } else if (currentGiverBal >= amount) {
                finalSenderDeduction = amount;
                finalRecipientIntake = amount - fee;
                finalFee = fee;
                phase = 2;
            } else {
                throw new Error('Giver has insufficient balance to cover the base amount.');
            }

            const gName = getUserDisplayName(giverMember) || giverId;
            const rName = getUserDisplayName(receiverMember) || receiverId;

            await client.query(
                `UPDATE user_balances SET balance = balance - $1, total_spent = total_spent + $1, updated_at = NOW()
                 WHERE user_id = $2 AND guild_id = $3`,
                [finalSenderDeduction, giverId, trade.guild_id]
            );

            if (phase === 1 && finalFee > 0) {
                // 1. Insert Trade Tax FIRST (lower ID -> appears below trade line in DESC history)
                await client.query(
                    `INSERT INTO transactions (user_id, guild_id, amount, balance_after, type, description, reference_id)
                     SELECT $1, $2, $3, balance + $5, 'fee', 'Trade taxes', $4 FROM user_balances WHERE user_id = $1 AND guild_id = $2`,
                    [giverId, trade.guild_id, -finalFee, tradeId, amount]
                );
                // 2. Insert Principal Trade SECOND (higher ID -> appears on top line in DESC history)
                await client.query(
                    `INSERT INTO transactions (user_id, guild_id, amount, balance_after, type, description, reference_id)
                     SELECT $1, $2, $3, balance, 'trade', $4, $5 FROM user_balances WHERE user_id = $1 AND guild_id = $2`,
                    [giverId, trade.guild_id, -amount, `P2P Trade to ${rName}`, tradeId]
                );
            } else {
                await client.query(
                    `INSERT INTO transactions (user_id, guild_id, amount, balance_after, type, description, reference_id)
                     SELECT $1, $2, $3, balance, 'trade', $4, $5 FROM user_balances WHERE user_id = $1 AND guild_id = $2`,
                    [giverId, trade.guild_id, -finalSenderDeduction, `P2P Trade to ${rName}`, tradeId]
                );
            }

            await client.query(
                `INSERT INTO user_balances (user_id, guild_id, balance, total_earned)
                 VALUES ($1, $2, $3, $3)
                 ON CONFLICT (user_id, guild_id) DO UPDATE
                 SET balance = user_balances.balance + $3, total_earned = user_balances.total_earned + $3, updated_at = NOW()`,
                [receiverId, trade.guild_id, finalRecipientIntake]
            );

            if (phase === 2 && finalFee > 0) {
                // 1. Insert Trade Tax FIRST (lower ID -> appears below trade line in DESC history)
                await client.query(
                    `INSERT INTO transactions (user_id, guild_id, amount, balance_after, type, description, reference_id)
                     SELECT $1, $2, $3, balance - $5, 'fee', 'Trade taxes', $4 FROM user_balances WHERE user_id = $1 AND guild_id = $2`,
                    [receiverId, trade.guild_id, -finalFee, tradeId, amount]
                );
                // 2. Insert Principal Trade SECOND (higher ID -> appears on top line in DESC history)
                await client.query(
                    `INSERT INTO transactions (user_id, guild_id, amount, balance_after, type, description, reference_id)
                     SELECT $1, $2, $3, balance, 'trade', $4, $5 FROM user_balances WHERE user_id = $1 AND guild_id = $2`,
                    [receiverId, trade.guild_id, amount, `P2P Trade from ${gName}`, tradeId]
                );
            } else {
                await client.query(
                    `INSERT INTO transactions (user_id, guild_id, amount, balance_after, type, description, reference_id)
                     SELECT $1, $2, $3, balance, 'trade', $4, $5 FROM user_balances WHERE user_id = $1 AND guild_id = $2`,
                    [receiverId, trade.guild_id, finalRecipientIntake, `P2P Trade from ${gName}`, tradeId]
                );
            }

            return { senderDeduction: finalSenderDeduction, recipientIntake: finalRecipientIntake, fee: finalFee, phase };
        };

        const initialSenderBal = parseInt(senderBal.rows[0]?.balance || 0);
        const initialTargetBal = parseInt(targetBal.rows[0]?.balance || 0);

        let sOutcome = null;
        if (parseInt(trade.sender_coins) > 0) {
            sOutcome = await processCoinSwap(trade.sender_id, trade.target_id, trade.sender_coins, senderMember, targetMember, senderIsBooster);
        }

        let tOutcome = null;
        if (parseInt(trade.target_coins) > 0) {
            tOutcome = await processCoinSwap(trade.target_id, trade.sender_id, trade.target_coins, targetMember, senderMember, targetIsBooster);
        }

        const finalSenderDetails = await client.query('SELECT balance FROM user_balances WHERE user_id = $1 AND guild_id = $2', [trade.sender_id, trade.guild_id]);
        const finalTargetDetails = await client.query('SELECT balance FROM user_balances WHERE user_id = $1 AND guild_id = $2', [trade.target_id, trade.guild_id]);
        const finalSenderBal = parseInt(finalSenderDetails.rows[0]?.balance || 0);
        const finalTargetBal = parseInt(finalTargetDetails.rows[0]?.balance || 0);

        // 5. ATOMIC SWAP - Items (Quantity-Aware Transfer & UPSERT)
        let senderLostShopItemIds = [];
        let targetLostShopItemIds = [];

        if (sItemObjects.length > 0) {
            for (const offer of sItemObjects) {
                const rowRes = await client.query(
                    `SELECT i.id, i.shop_item_id, COALESCE(i.quantity, 1) as quantity, s.name, s.role_id 
                     FROM user_inventory i JOIN shop_items s ON i.shop_item_id = s.id 
                     WHERE i.id = $1 AND i.user_id = $2 AND i.guild_id = $3 AND i.source = 'SHOP'
                     FOR UPDATE`,
                    [offer.id, trade.sender_id, trade.guild_id]
                );
                if (rowRes.rows.length === 0) continue;
                const row = rowRes.rows[0];
                senderLostShopItemIds.push(row.shop_item_id);

                const currentQty = parseInt(row.quantity) || 1;
                const tradedQty = Math.min(offer.qty || 1, currentQty);

                if (currentQty - tradedQty <= 0) {
                    await client.query('DELETE FROM user_inventory WHERE id = $1', [row.id]);
                } else {
                    await client.query('UPDATE user_inventory SET quantity = quantity - $1 WHERE id = $2', [tradedQty, row.id]);
                }

                const targetCheck = await client.query(
                    `SELECT id FROM user_inventory WHERE user_id = $1 AND shop_item_id = $2 AND guild_id = $3 LIMIT 1 FOR UPDATE`,
                    [trade.target_id, row.shop_item_id, trade.guild_id]
                );
                if (targetCheck.rows.length > 0) {
                    await client.query(
                        `UPDATE user_inventory SET quantity = COALESCE(quantity, 1) + $1 WHERE id = $2`,
                        [tradedQty, targetCheck.rows[0].id]
                    );
                } else {
                    await client.query(
                        `INSERT INTO user_inventory (user_id, guild_id, shop_item_id, role_id, quantity, is_active, source) VALUES ($1, $2, $3, $4, $5, false, 'SHOP')`,
                        [trade.target_id, trade.guild_id, row.shop_item_id, row.role_id || '', tradedQty]
                    );
                }
            }
        }

        if (tItemObjects.length > 0) {
            for (const offer of tItemObjects) {
                const rowRes = await client.query(
                    `SELECT i.id, i.shop_item_id, COALESCE(i.quantity, 1) as quantity, s.name, s.role_id 
                     FROM user_inventory i JOIN shop_items s ON i.shop_item_id = s.id 
                     WHERE i.id = $1 AND i.user_id = $2 AND i.guild_id = $3 AND i.source = 'SHOP'
                     FOR UPDATE`,
                    [offer.id, trade.target_id, trade.guild_id]
                );
                if (rowRes.rows.length === 0) continue;
                const row = rowRes.rows[0];
                targetLostShopItemIds.push(row.shop_item_id);

                const currentQty = parseInt(row.quantity) || 1;
                const tradedQty = Math.min(offer.qty || 1, currentQty);

                if (currentQty - tradedQty <= 0) {
                    await client.query('DELETE FROM user_inventory WHERE id = $1', [row.id]);
                } else {
                    await client.query('UPDATE user_inventory SET quantity = quantity - $1 WHERE id = $2', [tradedQty, row.id]);
                }

                const senderCheck = await client.query(
                    `SELECT id FROM user_inventory WHERE user_id = $1 AND shop_item_id = $2 AND guild_id = $3 LIMIT 1 FOR UPDATE`,
                    [trade.sender_id, row.shop_item_id, trade.guild_id]
                );
                if (senderCheck.rows.length > 0) {
                    await client.query(
                        `UPDATE user_inventory SET quantity = COALESCE(quantity, 1) + $1 WHERE id = $2`,
                        [tradedQty, senderCheck.rows[0].id]
                    );
                } else {
                    await client.query(
                        `INSERT INTO user_inventory (user_id, guild_id, shop_item_id, role_id, quantity, is_active, source) VALUES ($1, $2, $3, $4, $5, false, 'SHOP')`,
                        [trade.sender_id, trade.guild_id, row.shop_item_id, row.role_id || '', tradedQty]
                    );
                }
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
        
        // 7. REAL-TIME ROLE SWAP (Remove role ONLY if user's remaining total quantity === 0)
        try {
            if (senderMember || targetMember) {
                // Items GIVEN (Sender -> Target)
                if (senderLostShopItemIds.length > 0 && senderMember) {
                    const res = await query('SELECT id as shop_item_id, role_id FROM shop_items WHERE id = ANY($1::int[])', [senderLostShopItemIds]);
                    for (const row of res.rows) {
                        if (row.role_id) {
                            const remRes = await query('SELECT COALESCE(SUM(COALESCE(quantity, 1)), 0) as total FROM user_inventory WHERE user_id = $1 AND shop_item_id = $2 AND guild_id = $3', [trade.sender_id, row.shop_item_id, trade.guild_id]);
                            const remQty = parseInt(remRes.rows[0]?.total || 0);
                            if (remQty === 0) {
                                await senderMember.roles.remove(row.role_id).catch(() => null);
                            }
                        }
                    }
                }
                // Items REQUESTED (Target -> Sender)
                if (targetLostShopItemIds.length > 0 && targetMember) {
                    const res = await query('SELECT id as shop_item_id, role_id FROM shop_items WHERE id = ANY($1::int[])', [targetLostShopItemIds]);
                    for (const row of res.rows) {
                        if (row.role_id) {
                            const remRes = await query('SELECT COALESCE(SUM(COALESCE(quantity, 1)), 0) as total FROM user_inventory WHERE user_id = $1 AND shop_item_id = $2 AND guild_id = $3', [trade.target_id, row.shop_item_id, trade.guild_id]);
                            const remQty = parseInt(remRes.rows[0]?.total || 0);
                            if (remQty === 0) {
                                await targetMember.roles.remove(row.role_id).catch(() => null);
                            }
                        }
                    }
                }
            }
        } catch (roleError) {
            sysError('Failed to swap roles after trade', roleError, { guild: interaction.guildId, detail: `TradeID: ${tradeId}` });
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

        await interaction.editReply({
            content: '',
            components: [],
            embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setColor(0x2ECC71).setFooter({ text: 'Trade Successful' }).setTimestamp()]
        });

        // 9. Clear Garbage Collector
        const timeoutId = TRADE_TIMEOUTS.get(tradeId);
        if (timeoutId) {
            clearTimeout(timeoutId);
            TRADE_TIMEOUTS.delete(tradeId);
        }

        // 10. Standardized Economy Log
        // 10. Standardized Economy Log
        try {
            const senderUsername = getUserLogName(senderMember);
            const targetUsername = getUserLogName(targetMember);

            // Build human-readable item lists with quantity labels
            const buildItemList = (rawItems) => {
                if (!rawItems) return null;
                let list = rawItems;
                if (typeof rawItems === 'string') {
                    try { list = JSON.parse(rawItems); } catch (_) { list = []; }
                }
                if (!Array.isArray(list) || list.length === 0) return null;

                const parts = list.map(i => {
                    if (typeof i === 'object' && i !== null) {
                        const q = parseInt(i.qty || i.quantity) || 1;
                        const name = i.name || `Item #${i.shop_item_id || i.id}`;
                        return q > 1 ? `${q}x ${name}` : name;
                    }
                    return `Item #${i}`;
                });
                return parts.join(', ');
            };

            const sItemNames = buildItemList(sItems);
            const tItemNames = buildItemList(tItems);

            const offerText = `${Number(trade.sender_coins) > 0 ? `**${Number(trade.sender_coins).toLocaleString()}** ${COIN_EMOJI}` : ''}${sItemNames ? (Number(trade.sender_coins) > 0 ? ' and ' : '') + `**${sItemNames}**` : ''}` || 'Nothing';
            const requestText = `${Number(trade.target_coins) > 0 ? `**${Number(trade.target_coins).toLocaleString()}** ${COIN_EMOJI}` : ''}${tItemNames ? (Number(trade.target_coins) > 0 ? ' and ' : '') + `**${tItemNames}**` : ''}` || 'Nothing';

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
        } catch (logErr) {
            sysError('Post-trade log error', logErr);
        }

        // 11. Anti-Cheat Scan (non-blocking, runs after trade completes and standard log is sent)
        detectSuspiciousTrade(
            interaction.guild,
            trade.sender_id,
            trade.target_id,
            senderMember?.user ?? null,
            targetMember?.user ?? null
        ).catch(() => {}); // Silenced — failure here must never crash the trade

    } catch (err) {
        // Safe Rollback
        try { if (client) await client.query('ROLLBACK'); } catch (rbErr) { }

        let errorMessage = `❌ Trade Failed: ${err.message.includes('insufficient') || err.message.includes('missing') ? err.message : 'Database error occurred during execution.'}`;
        
        // CATCH: Security Cap Violation
        if (err.message.includes('exceeds the safety cap')) {
            errorMessage = `❌ **Security Error:** ${err.message}`;
        }
        
        sysError('Atomic Swap Failure', err, { user: interaction.user.id, guild: interaction.guildId, detail: `TradeID: ${tradeId}` });

        // Update public message if it's a verification failure
        if (err.message.includes('insufficient') || err.message.includes('missing') || err.message.includes('already')) {
           await query('UPDATE trades SET status = $1 WHERE id = $2 AND guild_id = $3', ['canceled', tradeId, interaction.guildId]).catch(() => {});
           await interaction.editReply({
                content: '',
                components: [],
                embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setColor(0xEE4444).setFooter({ text: 'Trade Canceled: Assets Missing' })]
           }).catch(() => { });
        } else {
            const finalMsg = errorMessage;
            if (interaction.deferred || interaction.replied) await interaction.editReply({ content: finalMsg, components: [], embeds: [] }).catch(() => { });
            else await interaction.reply({ content: finalMsg, flags: MessageFlags.Ephemeral, components: [], embeds: [] }).catch(() => { });
        }
    } finally {
        if (client) client.release();
    }
}
