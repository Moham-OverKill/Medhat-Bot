import {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    UserSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    StringSelectMenuBuilder,
    MessageFlags,
    PermissionFlagsBits
} from 'discord.js';
import { getPool } from '../storage/postgres.js';
import { sanitizeError, getUserDisplayName, getUserLogName, sortItemsByRolePosition, formatInventoryItemLine, safeTruncate, COIN_EMOJI, parseSelectEmoji, safeSetButtonEmoji, getItemRarityEmoji } from '../shared.js';
import { getShopCategories, getUserInventory, syncInventoryWithDiscord, getSynthesizedInventory, getItemImage, getShopItems } from '../economy/shop.js';
import { getLootBoxes, getLootBoxCategoryName, getLootBoxCategoryEmoji } from '../economy/lootbox.js';
import { sendLog, sysLog, sysError } from '../utils/logger.js';
import { buildPaginatedSelectMenu } from '../utils/paginator.js';
import { handleInteractionError } from '../utils/errors.js';

// State map for hierarchical admin give & remove items select menus: keyed by `${adminUserId}_${targetUserId}`
const pendingAdminGive = new Map();
const pendingAdminRemove = new Map();

/**
 * Show user selector dropdown
 */
export async function showUserSelector(interaction) {
    const embed = new EmbedBuilder()
        .setTitle('User Management')
        .setDescription('Select a user to manage their balance or inventory')
        .setColor(0x2F3136);

    const select = new UserSelectMenuBuilder()
        .setCustomId('admin_user_select')
        .setPlaceholder('Select a user...')
        .setMinValues(1)
        .setMaxValues(1);

    // Button Row 1: Anti Cheat | Admins (Owner & Discord Admins only)
    const { hasAdminManagerAccess } = await import('../storage/admins.js');
    const canManageAdmins = await hasAdminManagerAccess(interaction);

    const row1Buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('admin_user_anticheat')
            .setLabel('Anti Cheat')
            .setEmoji('🚫')
            .setStyle(ButtonStyle.Secondary)
    );

    row1Buttons.addComponents(
        new ButtonBuilder()
            .setCustomId('admin_user_admins')
            .setLabel('Admins')
            .setEmoji('💼')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!canManageAdmins)
    );

    // Button Row 2: Back
    const row2Buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('settings_back')
            .setLabel('Back')
            .setEmoji('⬅️')
            .setStyle(ButtonStyle.Secondary)
    );

    const responseMethod = (interaction.deferred || interaction.replied)
        ? 'editReply'
        : (interaction.isButton() || interaction.isAnySelectMenu() ? 'update' : 'editReply');
    await interaction[responseMethod]({
        embeds: [embed],
        components: [
            new ActionRowBuilder().addComponents(select),
            row1Buttons,
            row2Buttons
        ]
    });
}

/**
 * Main Management Dashboard for a specific user
 */
export async function showUserDashboard(interaction, targetUserId) {
    const guildId = interaction.guildId;
    const pool = getPool();

    const targetMember = await interaction.guild.members.fetch(targetUserId).catch(() => null);
    const rawName = targetMember ? targetMember.displayName : targetUserId;
    const displayName = safeTruncate(rawName, 30);

    sysLog('Interaction Audit', { user: interaction.user.id, guild: guildId, detail: `Opening user management dashboard for ${targetUserId}` });
    
    // Defer as early as possible if not already
    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate().catch(() => {});
    }

    try {
        // Fetch user basic data
        let userResult = await pool.query(
            'SELECT balance, daily_streak FROM user_balances WHERE guild_id = $1 AND user_id = $2',
            [guildId, targetUserId]
        );

        if (userResult.rowCount === 0) {
            sysLog('Infrastructure Audit', { guild: guildId, detail: `Creating first-time balance entry for ${targetUserId}` });
            // Create entry if missing
            userResult = await pool.query(
                `INSERT INTO user_balances (user_id, guild_id, balance, daily_streak)
                 VALUES ($1, $2, 0, 0)
                 ON CONFLICT (user_id, guild_id)
                 DO UPDATE SET updated_at = NOW()
                 RETURNING balance, daily_streak`,
                [targetUserId, guildId]
            );
        }

        const balance = parseInt(userResult.rows[0]?.balance || 0, 10);
        const streak = parseInt(userResult.rows[0]?.daily_streak || 0, 10);

        // Fetch user level from user_activity
        let userLevel = 0;
        try {
            const { flushMessageBatch } = await import('../activity/tracker.js');
            await flushMessageBatch().catch(() => {});
            const actRes = await pool.query(
                'SELECT battlepass_xp FROM user_activity WHERE guild_id = $1 AND user_id = $2',
                [guildId, targetUserId]
            );
            const totalXp = parseInt(actRes.rows[0]?.battlepass_xp || 0, 10);
            const { getGuildConfig } = await import('../storage/config.js');
            const config = await getGuildConfig(guildId) || {};
            const baseXp = Math.max(1, parseInt(config.battlepass_base_xp ?? config.battlepass_xp_per_level, 10) || 100);
            const incrementXp = Math.max(1, parseInt(config.battlepass_xp_increment, 10) > 0 ? parseInt(config.battlepass_xp_increment, 10) : 50);
            const { calculateLevelFromXp } = await import('./settings/pass-engine.js');
            const calc = calculateLevelFromXp(totalXp, baseXp, incrementXp);
            userLevel = calc.level;
        } catch {}

        // Fetch synthesized inventory to get accurate item count (summing quantities)
        const inventory = await getSynthesizedInventory(targetUserId, guildId, targetMember);
        const activeItems = inventory.filter(i => !(i.item_type === 'pack' || i.is_pack));
        const itemCount = activeItems.reduce((sum, i) => sum + (parseInt(i.quantity) || 1), 0);

        sysLog('Interaction Audit', { user: interaction.user.id, guild: guildId, detail: `Building management UI for ${targetUserId}` });

        const embed = new EmbedBuilder()
            .setTitle(safeTruncate(`Managing: ${displayName}`, 256))
            .setDescription(`Balance: **${balance.toLocaleString()}** ${COIN_EMOJI} ｜ Streak: **${streak}** 🔥 ｜ Level: **${userLevel}** ⭐ ｜ Items: **${itemCount}** 📦`)
            .setColor(0x5865F2);

        const actionRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`admin_user_balance_${targetUserId}`)
                .setLabel('Balance')
                .setEmoji('💰')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`admin_user_streak_${targetUserId}`)
                .setLabel('Streak')
                .setEmoji('🔥')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`admin_user_level_${targetUserId}`)
                .setLabel('Level')
                .setEmoji('⭐')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`admin_user_items_${targetUserId}`)
                .setLabel('Items')
                .setEmoji('🎒')
                .setStyle(ButtonStyle.Secondary)
        );

        const backRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('settings_users')
                .setLabel('Back')
                .setEmoji('⬅️')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`admin_user_history_${targetUserId}`)
                .setLabel('History')
                .setEmoji('📜')
                .setStyle(ButtonStyle.Secondary)
        );

    const responseMethod = interaction.deferred || interaction.replied ? 'editReply' : (interaction.isButton() || interaction.isAnySelectMenu() ? 'update' : 'editReply');
    await interaction[responseMethod]({
        embeds: [embed],
        components: [actionRow, backRow]
    });
    } catch (err) {
        sysError('UI Update Failed', err, { user: interaction.user.id, guild: guildId, detail: `Failed to show dashboard for ${targetUserId}` });
        throw err;
    }
}

/**
 * Handle balance adjustment modal
 */
export async function handleBalanceAction(interaction, targetUserId) {
    const targetMember = await interaction.guild.members.fetch(targetUserId).catch(() => null);
    const displayName = targetMember ? targetMember.displayName : targetUserId;

    // Use a safer title for modals. Some Unicode characters (like mathematical script) 
    // can cause serialization issues in specific Discord API versions for Modals.
    const safeTitle = `Adjust Balance: ${targetMember?.user.username || targetUserId}`;

    const modal = new ModalBuilder()
        .setCustomId(`admin_user_balmod_${targetUserId}`)
        .setTitle(safeTruncate(safeTitle, 45));

    const input = new TextInputBuilder()
        .setCustomId('new_balance')
        .setLabel('New Exact Balance')
        .setPlaceholder('Enter total coins user should have...')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
}

/**
 * Process balance modal submission
 */
export async function handleBalanceModal(interaction) {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
    const targetUserId = interaction.customId.split('_').pop();
    const newBalance = parseInt(interaction.fields.getTextInputValue('new_balance'), 10);

    if (!Number.isSafeInteger(newBalance) || newBalance < 0) {
        return interaction.followUp({ content: '❌ Invalid balance. Please enter a valid non-negative integer.', flags: MessageFlags.Ephemeral });
    }

    const guildId = interaction.guildId;
    const pool = getPool();

    try {
        const targetMember = await interaction.guild.members.fetch(targetUserId).catch(() => null);

        // Get old balance for history logging
        const oldRes = await pool.query('SELECT balance FROM user_balances WHERE guild_id = $1 AND user_id = $2', [guildId, targetUserId]);
        const oldBalance = oldRes.rowCount > 0 ? parseInt(oldRes.rows[0].balance, 10) : 0;
        const delta = newBalance - oldBalance;

        // Update balance
        await pool.query(
            `INSERT INTO user_balances (user_id, guild_id, balance) VALUES ($1, $2, $3)
             ON CONFLICT (user_id, guild_id) DO UPDATE SET balance = $3, updated_at = NOW()`,
            [targetUserId, guildId, newBalance]
        );

        // Log transaction (DB)
        const adminName = getUserDisplayName(interaction.member);
        await pool.query(
            `INSERT INTO transactions (user_id, guild_id, amount, balance_after, type, description)
             VALUES ($1, $2, $3, $4, 'admin_adjust', $5)`,
            [targetUserId, guildId, delta, newBalance, `${adminName} adjusted balance to ${newBalance}`]
        );

        // Discord Log
        const adminLogName = getUserLogName(interaction);
        const targetLogName = targetMember ? getUserLogName(targetMember) : targetUserId;
        
        if (delta > 0) {
            sendLog(interaction.guild, 'economy', 'green', '💰 Balance Adjusted',
                `**Target:** ${targetLogName}\n` +
                `**Addition:** \`+${delta.toLocaleString()}\` ${COIN_EMOJI}\n` +
                `**Admin:** ${adminLogName} (via User Settings)`
            );
        } else {
            sendLog(interaction.guild, 'audit', 'red', '⚖️ Balance Adjusted',
                `**Target:** ${targetLogName}\n` +
                `**Reduction:** \`${delta.toLocaleString()}\` ${COIN_EMOJI}\n` +
                `**Admin:** ${adminLogName} (via User Settings)`
            );
        }

        sysLog('Admin Balance Override', {
            tag: 'SECURITY',
            user: interaction.user.id,
            target: targetUserId,
            guild: guildId,
            amount: delta,
            detail: `Admin ${interaction.user.id} modified balance by ${delta > 0 ? '+' : ''}${delta} coins for user ${targetUserId}`
        });

        await showUserDashboard(interaction, targetUserId);

        // Real-time role re-evaluation for Richest Role
        import('../mvp/role-assignment.js').then(({ applyRichestRole }) => {
            applyRichestRole(interaction.client, guildId).catch(err => {
                sysError('Richest Role Auto-update Failed', err, { guild: guildId });
            });
        }).catch(() => {});
    } catch (error) {
        sysError('Infrastructure Audit Failure', error, { user: interaction.user.id, guild: guildId, detail: `Balance adjust: ${targetUserId}` });
        await interaction.followUp({ content: '❌ Failed to update balance.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
}

/**
 * Handle streak adjustment button click
 */
export async function handleStreakAction(interaction, targetUserId) {
    const pool = getPool();
    const res = await pool.query(
        'SELECT daily_streak FROM user_balances WHERE guild_id = $1 AND user_id = $2',
        [interaction.guildId, targetUserId]
    );
    const currentStreak = res.rows.length > 0 ? (parseInt(res.rows[0].daily_streak) || 0) : 0;

    const modal = new ModalBuilder()
        .setCustomId(`admin_user_stkmod_${targetUserId}`)
        .setTitle('Edit User Streak');

    const input = new TextInputBuilder()
        .setCustomId('new_streak')
        .setLabel('Current Streak Days')
        .setPlaceholder('Enter total streak days...')
        .setValue(String(currentStreak))
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
}

/**
 * Process streak modal submission
 */
export async function handleStreakModal(interaction) {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
    const targetUserId = interaction.customId.split('_').pop();
    const newStreakText = interaction.fields.getTextInputValue('new_streak');

    if (!/^\d+$/.test(newStreakText)) {
        return interaction.followUp({ content: '❌ Invalid input. Streak must be a positive number.', flags: MessageFlags.Ephemeral });
    }

    const newStreak = parseInt(newStreakText, 10);
    const guildId = interaction.guildId;
    const pool = getPool();

    try {
        const targetMember = await interaction.guild.members.fetch(targetUserId).catch(() => null);

        // Get old streak and last_daily for continuity logic
        const oldRes = await pool.query(
            'SELECT daily_streak, last_daily FROM user_balances WHERE guild_id = $1 AND user_id = $2',
            [guildId, targetUserId]
        );
        const oldStreak = oldRes.rowCount > 0 ? (parseInt(oldRes.rows[0].daily_streak) || 0) : 0;
        const lastDaily = oldRes.rowCount > 0 ? oldRes.rows[0].last_daily : null;

        // Next-Day Continuity:
        // Set last_daily to yesterday in Cairo timezone if the current last_daily is expired/null.
        // This ensures the next claim increments the new streak normally instead of resetting to 1.
        const { isStreakValid, getYesterdayCairo } = await import('../utils/time.js');
        let targetLastDaily = lastDaily;
        if (!lastDaily || !isStreakValid(new Date(lastDaily))) {
            const yesterdayStr = getYesterdayCairo();
            targetLastDaily = new Date(yesterdayStr + 'T12:00:00Z');
        }

        // Upsert database entry
        await pool.query(
            `INSERT INTO user_balances (user_id, guild_id, daily_streak, last_daily, balance) VALUES ($1, $2, $3, $4, 0)
             ON CONFLICT (user_id, guild_id) DO UPDATE SET daily_streak = $3, last_daily = $4, updated_at = NOW()`,
            [targetUserId, guildId, newStreak, targetLastDaily]
        );

        // Discord Log
        const adminLogName = getUserLogName(interaction);
        const targetLogName = targetMember ? getUserLogName(targetMember) : targetUserId;

        sendLog(interaction.guild, 'audit', 'orange', '🔥 Streak Adjusted',
            `**Target:** ${targetLogName}\n` +
            `**Streak Changed:** \`${oldStreak}\` ➜ \`${newStreak}\`\n` +
            `**Admin:** ${adminLogName} (via User Settings)`
        );

        sysLog('Admin Streak Override', {
            tag: 'SECURITY',
            user: interaction.user.id,
            target: targetUserId,
            guild: guildId,
            detail: `Admin ${interaction.user.id} changed streak from ${oldStreak} to ${newStreak} for user ${targetUserId}`
        });

        await showUserDashboard(interaction, targetUserId);

        // Real-time role re-evaluation for Streak Role
        import('../mvp/role-assignment.js').then(({ applyStreakRole }) => {
            applyStreakRole(interaction.client, guildId).catch(err => {
                sysError('Streak Role Auto-update Failed', err, { guild: guildId });
            });
        }).catch(() => {});
    } catch (error) {
        sysError('Infrastructure Audit Failure', error, { user: interaction.user.id, target: targetUserId, guild: guildId, detail: `Streak adjust: ${targetUserId}` });
        await interaction.followUp({ content: '❌ Failed to update streak.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
}

/**
 * Handle level adjustment button click
 */
export async function handleLevelAction(interaction, targetUserId) {
    const targetMember = await interaction.guild.members.fetch(targetUserId).catch(() => null);
    const safeTitle = `Set Level: ${targetMember?.user.username || targetUserId}`;

    const pool = getPool();
    const actRes = await pool.query(
        'SELECT battlepass_xp FROM user_activity WHERE guild_id = $1 AND user_id = $2',
        [interaction.guildId, targetUserId]
    );
    const totalXp = parseInt(actRes.rows[0]?.battlepass_xp || 0, 10);
    const { getGuildConfig } = await import('../storage/config.js');
    const config = await getGuildConfig(interaction.guildId) || {};
    const baseXp = Math.max(1, parseInt(config.battlepass_base_xp ?? config.battlepass_xp_per_level, 10) || 100);
    const incrementXp = Math.max(1, parseInt(config.battlepass_xp_increment, 10) > 0 ? parseInt(config.battlepass_xp_increment, 10) : 50);
    const { calculateLevelFromXp } = await import('./settings/pass-engine.js');
    const { level: userLevel } = calculateLevelFromXp(totalXp, baseXp, incrementXp);

    const modal = new ModalBuilder()
        .setCustomId(`admin_user_lvlmod_${targetUserId}`)
        .setTitle(safeTruncate(safeTitle, 45));

    const input = new TextInputBuilder()
        .setCustomId('new_level')
        .setLabel('New Level')
        .setPlaceholder(String(userLevel))
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
}

/**
 * Process level modal submission
 */
export async function handleLevelModal(interaction) {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
    const targetUserId = interaction.customId.split('_').pop();
    const newLevel = parseInt(interaction.fields.getTextInputValue('new_level'), 10);

    if (isNaN(newLevel) || newLevel < 0) {
        return interaction.followUp({ content: '❌ Invalid level. Please enter a valid non-negative number.', flags: MessageFlags.Ephemeral });
    }

    const guildId = interaction.guildId;
    const pool = getPool();

    try {
        const { getGuildConfig } = await import('../storage/config.js');
        const config = await getGuildConfig(guildId) || {};
        const baseXp = Math.max(1, parseInt(config.battlepass_base_xp ?? config.battlepass_xp_per_level, 10) || 100);
        const incrementXp = Math.max(1, parseInt(config.battlepass_xp_increment, 10) > 0 ? parseInt(config.battlepass_xp_increment, 10) : 50);
        const { getTotalXpForLevel } = await import('./settings/pass-engine.js');
        const targetXp = getTotalXpForLevel(newLevel, baseXp, incrementXp);

        const targetMember = await interaction.guild.members.fetch(targetUserId).catch(() => null);

        await pool.query(
            `INSERT INTO user_activity (user_id, guild_id, username, battlepass_xp)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (user_id, guild_id)
             DO UPDATE SET battlepass_xp = $4`,
            [targetUserId, guildId, targetMember?.user?.username || 'User', targetXp]
        );

        if (newLevel > 0) {
            const { syncUserLevelRewards, reconcileMissingLevelRewards } = await import('./settings/pass-engine.js');
            await syncUserLevelRewards(guildId, targetUserId, targetMember?.user?.username || 'User', interaction.client);
            await reconcileMissingLevelRewards(guildId, targetUserId).catch(() => {});
        }

        sysLog('Admin Action', {
            admin: interaction.user.id,
            guild: guildId,
            target: targetUserId,
            detail: `Set level to ${newLevel} (${targetXp} XP)`
        });

        const adminLogName = getUserLogName(interaction);
        const targetLogName = targetMember ? getUserLogName(targetMember) : targetUserId;

        sendLog(interaction.guild, 'audit', 'blue', '⭐ Level Adjusted',
            `**Target:** ${targetLogName}\n` +
            `**Level Changed To:** **Level ${newLevel}** (${targetXp.toLocaleString()} XP)\n` +
            `**Admin:** ${adminLogName} (via User Settings)`
        );

        await showUserDashboard(interaction, targetUserId);
    } catch (err) {
        sysError('Level Adjustment Failed', err, { user: interaction.user.id, guild: guildId });
        await interaction.followUp({ content: '❌ An error occurred while adjusting user level.', flags: MessageFlags.Ephemeral });
    }
}

/**
 * Show user inventory (items & chests)
 */
export async function showUserItems(interaction, targetUserId, _ignoredCatId = null, _ignoredPage = 1) {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
    const guildId = interaction.guildId;

    const targetMember = await interaction.guild.members.fetch(targetUserId).catch(() => null);
    if (!targetMember) return interaction.followUp({ content: '❌ Member not found.', flags: MessageFlags.Ephemeral });

    // Sync and fetch inventory for target user (including synthesized admin items)
    const inventory = await getSynthesizedInventory(targetUserId, guildId, targetMember);

    const stateKey = `${interaction.user.id}_${targetUserId}`;
    const giveState = pendingAdminGive.get(stateKey) || { folder: 'root', page: 1 };
    const remState = pendingAdminRemove.get(stateKey) || { folder: 'root', page: 1 };

    // Reconcile and clamp remove state against current inventory
    const visibleItems = inventory.filter(i => !(i.item_type === 'pack' || i.is_pack));
    const lootBoxItems = visibleItems.filter(i => i.item_type === 'loot_box');
    const standardItems = visibleItems.filter(i => i.item_type !== 'loot_box');
    const categorizedItems = standardItems.filter(i => i.category_id !== null);
    const uncategorizedItems = standardItems.filter(i => i.category_id === null);

    const hasCategorized = categorizedItems.length > 0;
    const hasUncategorized = uncategorizedItems.length > 0;
    const hasLootBoxes = lootBoxItems.length > 0;

    let remFolderItemsCount = 0;
    if (remState.folder === 'standalone') {
        if (!hasUncategorized) {
            remState.folder = 'root';
            remState.page = 1;
        } else {
            remFolderItemsCount = uncategorizedItems.length;
        }
    } else if (remState.folder === 'lootboxes') {
        if (!hasLootBoxes) {
            remState.folder = 'root';
            remState.page = 1;
        } else {
            remFolderItemsCount = lootBoxItems.length;
        }
    } else if (remState.folder.startsWith('cat_')) {
        const catId = parseInt(remState.folder.replace('cat_', ''), 10);
        const catItems = categorizedItems.filter(i => i.category_id === catId);
        if (catItems.length === 0) {
            remState.folder = hasCategorized ? 'categories' : 'root';
            remState.page = 1;
        } else {
            remFolderItemsCount = catItems.length;
        }
    } else if (remState.folder === 'categories') {
        if (!hasCategorized) {
            remState.folder = 'root';
            remState.page = 1;
        }
    }

    if (remFolderItemsCount > 0) {
        const totalPages = Math.max(1, Math.ceil(remFolderItemsCount / 20));
        remState.page = Math.min(Math.max(1, remState.page || 1), totalPages);
    }
    pendingAdminRemove.set(stateKey, remState);

    const embed = new EmbedBuilder()
        .setTitle(safeTruncate(`Inventory: ${targetMember.displayName}`, 256))
        .setColor('#3498DB');

    const [removeSelectMenu, giveSelectMenu] = await Promise.all([
        buildAdminRemoveSelectMenu(
            guildId,
            targetUserId,
            remState.folder,
            remState.page,
            interaction.guild,
            inventory
        ),
        buildAdminGiveSelectMenu(
            guildId,
            targetUserId,
            giveState.folder,
            giveState.page,
            interaction.guild
        )
    ]);

    const backRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`admin_user_dash_${targetUserId}`)
            .setLabel('Back')
            .setEmoji('⬅️')
            .setStyle(ButtonStyle.Secondary)
    );

    const rows = [
        new ActionRowBuilder().addComponents(removeSelectMenu),
        new ActionRowBuilder().addComponents(giveSelectMenu),
        backRow
    ];

    const responseMethod = interaction.deferred || interaction.replied ? 'editReply' : (interaction.isButton() || interaction.isAnySelectMenu() ? 'update' : 'editReply');
    await interaction[responseMethod]({ embeds: [embed], components: rows });
}

/**
 * Modal submission handler for setting a member's item quantity as an Admin.
 * customId: admin_user_setqty_[targetUserId]_[invId]_[catId]
 */
export async function handleAdminSetQuantity(interaction) {
    const customId = interaction.customId;
    const parts = customId.split('_');
    const targetUserId = parts[3];
    const invId = parts[4];
    const categoryId = parts[5];

    const rawQty = interaction.fields.getTextInputValue('new_quantity');
    const newQty = parseInt(rawQty, 10);

    if (isNaN(newQty) || newQty < 0 || newQty > 999) {
        return interaction.reply({
            content: '❌ Please enter a valid quantity between 0 and 999.',
            flags: MessageFlags.Ephemeral
        });
    }

    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate().catch(() => {});
    }

    const pool = getPool();
    const client = await pool.connect();
    const guildId = interaction.guildId;

    try {
        await client.query('BEGIN');

        const itemRes = await client.query(
            `SELECT i.*, s.name, s.role_id 
             FROM user_inventory i 
             JOIN shop_items s ON i.shop_item_id = s.id 
             WHERE i.id = $1 AND i.user_id = $2 AND i.guild_id = $3`,
            [invId, targetUserId, guildId]
        );

        if (itemRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return showUserItems(interaction, targetUserId, categoryId);
        }

        const item = itemRes.rows[0];
        const oldQty = parseInt(item.quantity) || 1;

        if (newQty === 0) {
            // Delete inventory item
            await client.query('DELETE FROM user_inventory WHERE id = $1', [invId]);

            // Check if total remaining quantity across all rows hits 0
            const totalRemainingRes = await client.query(
                `SELECT COALESCE(SUM(COALESCE(quantity, 1)), 0) as remaining
                 FROM user_inventory
                 WHERE user_id = $1 AND guild_id = $2 AND shop_item_id = $3`,
                [targetUserId, guildId, item.shop_item_id]
            );
            const totalRemaining = parseInt(totalRemainingRes.rows[0]?.remaining || 0);

            if (totalRemaining <= 0 && item.role_id) {
                const targetMember = await interaction.guild.members.fetch(targetUserId).catch(() => null);
                if (targetMember) {
                    const rIds = item.role_id.split(/[,\s]+/);
                    const botMember = interaction.guild.members.me;
                    for (const rId of rIds) {
                        const role = interaction.guild.roles.cache.get(rId);
                        if (role && role.comparePositionTo(botMember.roles.highest) < 0) {
                            await targetMember.roles.remove(role).catch(() => {});
                        }
                    }
                    const { runDependencySweep } = await import('../economy/shop.js');
                    await runDependencySweep(targetUserId, guildId, targetMember, client);
                }
            }

            sysLog('Admin Item Revoked', { user: interaction.user.id, guild: guildId, detail: `Set ${item.name} quantity to 0 for ${targetUserId}` });
            sendLog(interaction.guild, 'inventory', 'red', '🗑️ Item Revoked (Admin)',
                `${getUserLogName(interaction.member)} set **${item.name}** quantity to 0 (revoked ${oldQty} copy/copies) for <@${targetUserId}>.`);
        } else {
            // Update quantity
            await client.query('UPDATE user_inventory SET quantity = $1 WHERE id = $2', [newQty, invId]);

            sysLog('Admin Item Quantity Set', { user: interaction.user.id, guild: guildId, detail: `Changed ${item.name} quantity from ${oldQty} to ${newQty} for ${targetUserId}` });
            sendLog(interaction.guild, 'inventory', 'blue', '⚙️ Item Quantity Updated (Admin)',
                `${getUserLogName(interaction.member)} changed **${item.name}** quantity from ${oldQty} to **${newQty}** for <@${targetUserId}>.`);
        }

        await client.query('COMMIT');

        // Refresh category inventory view directly in place
        return showUserItems(interaction, targetUserId, categoryId);

    } catch (err) {
        await client.query('ROLLBACK');
        sysError('Admin Set Quantity Error', err, { user: interaction.user.id, guild: guildId });
        if (interaction.deferred || interaction.replied) {
            await interaction.followUp({ content: `❌ Error: ${err.message}`, flags: MessageFlags.Ephemeral });
        } else {
            await interaction.reply({ content: `❌ Error: ${err.message}`, flags: MessageFlags.Ephemeral });
        }
    } finally {
        client.release();
    }
}

/**
 * Builds the hierarchical folder select menu for removing items from a user.
 * Replicates the standard folder navigation pattern from item editing/deleting, p2p trading, and shop posting.
 *
 * @param {string} guildId
 * @param {string} targetUserId
 * @param {string} currentFolder - 'root' | 'categories' | 'standalone' | 'lootboxes' | 'cat_<id>'
 * @param {number} page
 * @param {Guild} guild
 * @param {Array} inventory - Target user's synthesized inventory items
 * @returns {Promise<StringSelectMenuBuilder>}
 */
export async function buildAdminRemoveSelectMenu(guildId, targetUserId, currentFolder = 'root', page = 1, guild = null, inventory = []) {
    const [categories, lootBoxCatName, lootBoxEmoji] = await Promise.all([
        getShopCategories(guildId),
        getLootBoxCategoryName(guildId),
        getLootBoxCategoryEmoji(guildId)
    ]);

    const visibleItems = inventory.filter(i => !(i.item_type === 'pack' || i.is_pack));
    const lootBoxItems = visibleItems.filter(i => i.item_type === 'loot_box');
    const standardItems = visibleItems.filter(i => i.item_type !== 'loot_box');
    const categorizedItems = standardItems.filter(i => i.category_id !== null);
    const uncategorizedItems = standardItems.filter(i => i.category_id === null);

    const hasCategorized = categorizedItems.length > 0;
    const hasUncategorized = uncategorizedItems.length > 0;
    const hasLootBoxes = lootBoxItems.length > 0;

    const customId = `admin_user_remsel_${targetUserId}`;

    if (!hasCategorized && !hasUncategorized && !hasLootBoxes) {
        return new StringSelectMenuBuilder()
            .setCustomId(customId)
            .setPlaceholder('No items to remove')
            .setDisabled(true)
            .addOptions([{ label: 'No items in inventory', value: 'rem_none' }]);
    }

    // LEVEL 1: ROOT FOLDERS
    if (currentFolder === 'root' || !currentFolder) {
        const folderOptions = [];
        if (hasCategorized) {
            folderOptions.push({
                label: 'Categorized Items',
                value: 'rem_folder_categorized',
                emoji: '📂'
            });
        }
        if (hasUncategorized) {
            folderOptions.push({
                label: 'Uncategorized Items',
                value: 'rem_folder_standalone',
                emoji: '🏷️'
            });
        }
        if (hasLootBoxes) {
            const lbLabel = safeTruncate(lootBoxCatName || 'Loot Boxes', 50);
            const lbEmoji = parseSelectEmoji(lootBoxEmoji, guild, '🎁') || '🎁';
            folderOptions.push({
                label: lbLabel,
                value: 'rem_folder_lootboxes',
                emoji: lbEmoji
            });
        }

        return new StringSelectMenuBuilder()
            .setCustomId(customId)
            .setPlaceholder('🗑️ Remove Items...')
            .addOptions(folderOptions);
    }

    // LEVEL 2: CATEGORIZED FOLDERS
    if (currentFolder === 'categories') {
        const usedCatIds = new Set(categorizedItems.map(i => i.category_id));
        const activeCats = categories.filter(c => usedCatIds.has(c.id));

        if (activeCats.length === 0) {
            return buildAdminRemoveSelectMenu(guildId, targetUserId, 'root', 1, guild, inventory);
        }

        const { selectMenu } = buildPaginatedSelectMenu({
            items: activeCats,
            page,
            customId,
            placeholder: '🗑️ Remove Items (Categories)',
            backOption: { label: 'Back', value: 'rem_back_root', emoji: '⬅️' },
            pageNavPrefix: 'rem_page_',
            pageSize: 20,
            mapOption: c => ({
                label: safeTruncate(c.name || `Category #${c.id}`, 100),
                value: `rem_cat_${c.id}`,
                emoji: '📂'
            })
        });

        return selectMenu;
    }

    // LEVEL 3: ITEMS LIST (Inside specific category, standalone, or loot boxes)
    let folderItems = [];
    let backValue = 'rem_back_root';
    let placeholder = '🗑️ Remove Items...';

    if (currentFolder === 'standalone') {
        folderItems = await sortItemsByRolePosition(uncategorizedItems, guild);
        placeholder = '🗑️ Remove Items (Uncategorized)';
        backValue = 'rem_back_root';
    } else if (currentFolder === 'lootboxes') {
        folderItems = lootBoxItems;
        folderItems.sort((a, b) => (parseInt(a.id) || 0) - (parseInt(b.id) || 0));
        const boxName = lootBoxCatName || 'Loot Boxes';
        placeholder = safeTruncate(`🗑️ Remove Items (${boxName})`, 100);
        backValue = 'rem_back_root';
    } else if (currentFolder.startsWith('cat_')) {
        const catId = parseInt(currentFolder.replace('cat_', ''), 10);
        const catItems = categorizedItems.filter(i => i.category_id === catId);
        folderItems = await sortItemsByRolePosition(catItems, guild);
        const catObj = categories.find(c => parseInt(c.id, 10) === catId);
        const catName = catObj?.name || 'Category';
        placeholder = safeTruncate(`🗑️ Remove Items (${catName})`, 100);
        backValue = 'rem_back_categories';
    }

    if (folderItems.length === 0) {
        if (currentFolder.startsWith('cat_') && hasCategorized) {
            return buildAdminRemoveSelectMenu(guildId, targetUserId, 'categories', 1, guild, inventory);
        }
        return buildAdminRemoveSelectMenu(guildId, targetUserId, 'root', 1, guild, inventory);
    }

    const { selectMenu } = buildPaginatedSelectMenu({
        items: folderItems,
        page,
        customId,
        placeholder,
        backOption: { label: 'Back', value: backValue, emoji: '⬅️' },
        pageNavPrefix: 'rem_page_',
        pageSize: 20,
        mapOption: i => {
            const isAdminIdentified = i.source === 'SYNC';
            const isChest = i.item_type === 'loot_box';
            const emoji = isChest
                ? (parseSelectEmoji(lootBoxEmoji, guild, '🎁') || '🎁')
                : (isAdminIdentified ? '🛡️' : getItemRarityEmoji(i));
            
            const isTemp = !!(i.expires_at || 
                           (i.duration_seconds && i.duration_seconds > 0) || 
                           (i.duration_hours && i.duration_hours > 0));
            const statusText = isChest
                ? 'Loot Box'
                : (isAdminIdentified ? 'Admin Granted' : (isTemp ? (i.is_active ? 'Active' : 'Inactive') : (i.is_active ? 'Equipped' : 'Unequipped')));
            
            const itemQty = parseInt(i.quantity) || 1;
            const qtyBadge = !isAdminIdentified ? ` (x${itemQty})` : '';
            const baseName = (i.name && i.name.trim().length > 0) ? i.name.slice(0, 70) : (isChest ? `Loot Box #${i.id}` : `Item #${i.id}`);

            return {
                label: `${baseName}${qtyBadge}`,
                value: `rem_item_${i.id}`,
                description: statusText,
                emoji
            };
        }
    });

    return selectMenu;
}

/**
 * Handle selection in the hierarchical Remove Items select menu.
 * Supports navigation (folders, categories, pages, back) and triggers the quantity removal modal on item selection.
 */
export async function handleAdminRemoveSelect(interaction) {
    const selection = interaction.values[0];
    if (selection === 'rem_none') return;

    const customId = interaction.customId;
    const parts = customId.split('_');
    const targetUserId = parts[3];
    const stateKey = `${interaction.user.id}_${targetUserId}`;
    let state = pendingAdminRemove.get(stateKey) || { folder: 'root', page: 1 };

    // 1. Pagination navigation
    if (selection.startsWith('rem_page_')) {
        state.page = parseInt(selection.replace('rem_page_', ''), 10) || 1;
        pendingAdminRemove.set(stateKey, state);
        return showUserItems(interaction, targetUserId);
    }

    // 2. Back navigation
    if (selection === 'rem_back_root') {
        state.folder = 'root';
        state.page = 1;
        pendingAdminRemove.set(stateKey, state);
        return showUserItems(interaction, targetUserId);
    }
    if (selection === 'rem_back_categories') {
        state.folder = 'categories';
        state.page = 1;
        pendingAdminRemove.set(stateKey, state);
        return showUserItems(interaction, targetUserId);
    }

    // 3. Folder navigation
    if (selection === 'rem_folder_categorized') {
        state.folder = 'categories';
        state.page = 1;
        pendingAdminRemove.set(stateKey, state);
        return showUserItems(interaction, targetUserId);
    }
    if (selection === 'rem_folder_standalone') {
        state.folder = 'standalone';
        state.page = 1;
        pendingAdminRemove.set(stateKey, state);
        return showUserItems(interaction, targetUserId);
    }
    if (selection === 'rem_folder_lootboxes') {
        state.folder = 'lootboxes';
        state.page = 1;
        pendingAdminRemove.set(stateKey, state);
        return showUserItems(interaction, targetUserId);
    }

    // 4. Drill into category
    if (selection.startsWith('rem_cat_')) {
        const catId = selection.replace('rem_cat_', '');
        state.folder = `cat_${catId}`;
        state.page = 1;
        pendingAdminRemove.set(stateKey, state);
        return showUserItems(interaction, targetUserId);
    }

    // 5. Item selection -> Check if SYNC role or open Modal
    if (selection.startsWith('rem_item_')) {
        const rawId = selection.replace('rem_item_', '');

        if (String(rawId).startsWith('admin_')) {
            return interaction.reply({
                content: '❌ **Admin-Granted Item:** This item is linked to a Discord role. Please remove the role directly from the user in Discord.',
                flags: MessageFlags.Ephemeral
            });
        }

        const invId = parseInt(rawId, 10);
        if (isNaN(invId)) {
            return interaction.reply({ content: '❌ Invalid item selection.', flags: MessageFlags.Ephemeral });
        }

        const pool = getPool();
        const itemRes = await pool.query(
            `SELECT ui.id, ui.quantity, COALESCE(si.name, lb.name, 'Item') as name
             FROM user_inventory ui
             LEFT JOIN shop_items si ON ui.shop_item_id = si.id
             LEFT JOIN loot_boxes lb ON (ui.role_id LIKE 'CHEST_%' AND lb.id = NULLIF(SUBSTRING(ui.role_id FROM 7), '')::INTEGER)
                 OR (ui.role_id LIKE 'LOOT_BOX_%' AND lb.id = NULLIF(SUBSTRING(ui.role_id FROM 10), '')::INTEGER)
             WHERE ui.id = $1 AND ui.user_id = $2 AND ui.guild_id = $3`,
            [invId, targetUserId, interaction.guildId]
        );

        if (itemRes.rowCount === 0) {
            return interaction.reply({ content: '❌ Item not found in user inventory.', flags: MessageFlags.Ephemeral });
        }

        const currentQty = parseInt(itemRes.rows[0].quantity) || 1;
        const itemName = itemRes.rows[0].name || 'Item';

        const modal = new ModalBuilder()
            .setCustomId(`admin_user_remmod_${targetUserId}_${invId}`)
            .setTitle(safeTruncate(`Edit Quantity: ${itemName}`, 45));

        const qtyInput = new TextInputBuilder()
            .setCustomId('new_quantity')
            .setLabel('Enter new quantity (0 to remove)')
            .setPlaceholder(String(currentQty))
            .setValue(String(currentQty))
            .setMinLength(1)
            .setMaxLength(6)
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(qtyInput));
        return interaction.showModal(modal);
    }
}

/**
 * Handle submission of the Remove Items quantity modal.
 * Sets the exact new quantity for the user or deletes the item if 0 is entered.
 * Executes an atomic transaction with row-level locking (FOR UPDATE) and audit logging.
 */
export async function handleAdminRemoveModal(interaction) {
    const customId = interaction.customId;
    const parts = customId.split('_');
    const targetUserId = parts[3];
    const invId = parseInt(parts[4], 10);

    const rawQty = (interaction.fields.getTextInputValue('new_quantity') || interaction.fields.getTextInputValue('remove_quantity'))?.trim();
    const newQty = parseInt(rawQty, 10);

    // Validate non-negative whole number (0 to remove all)
    if (isNaN(newQty) || newQty < 0 || !/^\d+$/.test(rawQty)) {
        return interaction.reply({
            content: '❌ Invalid quantity. Please enter a valid number (0 to remove all).',
            flags: MessageFlags.Ephemeral
        });
    }

    if (newQty > 1000000) {
        return interaction.reply({
            content: '❌ Quantity is too large. Maximum allowed is 1,000,000.',
            flags: MessageFlags.Ephemeral
        });
    }

    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate().catch(() => {});
    }

    const guildId = interaction.guildId;
    const pool = getPool();
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Concurrency Protection: Lock the specific user_inventory row directly (no outer joins on FOR UPDATE)
        const itemRes = await client.query(
            `SELECT * FROM user_inventory 
             WHERE id = $1 AND user_id = $2 AND guild_id = $3
             FOR UPDATE`,
            [invId, targetUserId, guildId]
        );

        if (itemRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return showUserItems(interaction, targetUserId);
        }

        const item = itemRes.rows[0];
        let itemName = 'Item';
        let shopRoleId = null;

        if (item.shop_item_id) {
            const siRes = await client.query(
                `SELECT name, role_id FROM shop_items WHERE id = $1`,
                [item.shop_item_id]
            );
            if (siRes.rows.length > 0) {
                itemName = siRes.rows[0].name;
                shopRoleId = siRes.rows[0].role_id;
            }
        }

        if ((!item.shop_item_id || itemName === 'Item') && item.role_id && (item.role_id.startsWith('CHEST_') || item.role_id.startsWith('LOOT_BOX_'))) {
            const rawBoxId = item.role_id.startsWith('CHEST_')
                ? item.role_id.slice(6)
                : item.role_id.slice(9);
            const boxId = parseInt(rawBoxId, 10);
            if (!isNaN(boxId)) {
                const lbRes = await client.query(
                    `SELECT name FROM loot_boxes WHERE id = $1`,
                    [boxId]
                );
                if (lbRes.rows.length > 0) {
                    itemName = lbRes.rows[0].name;
                }
            }
        }

        const oldQty = parseInt(item.quantity) || 1;
        const roleIdToRevoke = item.role_id || shopRoleId;
        const shopItemId = item.shop_item_id;

        const adminLogName = getUserLogName(interaction);
        const targetMember = await interaction.guild.members.fetch(targetUserId).catch(() => null);
        const targetLogName = targetMember ? getUserLogName(targetMember) : targetUserId;

        if (newQty === 0) {
            // Delete the inventory row
            await client.query('DELETE FROM user_inventory WHERE id = $1', [invId]);

            // Check if user still has any remaining rows of this shop_item_id
            if (shopItemId) {
                const totalRemainingRes = await client.query(
                    `SELECT COALESCE(SUM(COALESCE(quantity, 1)), 0) as remaining
                     FROM user_inventory
                     WHERE user_id = $1 AND guild_id = $2 AND shop_item_id = $3`,
                    [targetUserId, guildId, shopItemId]
                );
                const totalRemaining = parseInt(totalRemainingRes.rows[0]?.remaining || 0, 10);

                if (totalRemaining <= 0 && roleIdToRevoke && !roleIdToRevoke.startsWith('CHEST_') && !roleIdToRevoke.startsWith('LOOT_BOX_')) {
                    if (targetMember) {
                        const rIds = roleIdToRevoke.split(/[,\s]+/);
                        const botMember = interaction.guild.members.me;
                        for (const rId of rIds) {
                            const role = interaction.guild.roles.cache.get(rId);
                            if (role && botMember && role.comparePositionTo(botMember.roles.highest) < 0) {
                                await targetMember.roles.remove(role).catch(err => {
                                    sysError('Role Removal Failed on Admin Remove', err, { user: targetUserId, roleId: rId });
                                });
                            }
                        }
                        const { runDependencySweep } = await import('../economy/shop.js');
                        await runDependencySweep(targetUserId, guildId, targetMember, client).catch(() => {});
                    }
                }
            }

            // Audit Logging in audit_logs table
            await client.query(
                `INSERT INTO audit_logs (guild_id, user_id, action_type, target_type, target_id, details)
                 VALUES ($1, $2, 'ADMIN_REMOVE_ITEM', 'user', $3, $4)`,
                [guildId, interaction.user.id, targetUserId, JSON.stringify({
                    inventory_id: invId,
                    shop_item_id: shopItemId,
                    item_name: itemName,
                    previous_quantity: oldQty,
                    new_quantity: 0,
                    timestamp: new Date().toISOString()
                })]
            );

            await client.query('COMMIT');

            sysLog('Admin Item Revoked', {
                tag: 'SECURITY',
                user: interaction.user.id,
                target: targetUserId,
                guild: guildId,
                detail: `Admin ${interaction.user.id} set ${itemName} quantity to 0 (revoked ${oldQty} copies) for ${targetUserId}`
            });

            sendLog(interaction.guild, 'inventory', 'red', '🗑️ Item Revoked (Admin)',
                `**Item:** **${itemName}** \`(all ${oldQty} removed)\`\n` +
                `**Target:** <@${targetUserId}> (${targetLogName})\n` +
                `**Admin:** ${adminLogName} (via User Inventory Settings)`
            );
        } else {
            // Update quantity directly to requested amount
            await client.query('UPDATE user_inventory SET quantity = $1 WHERE id = $2', [newQty, invId]);

            // Audit Logging in audit_logs table
            await client.query(
                `INSERT INTO audit_logs (guild_id, user_id, action_type, target_type, target_id, details)
                 VALUES ($1, $2, 'ADMIN_SET_QUANTITY', 'user', $3, $4)`,
                [guildId, interaction.user.id, targetUserId, JSON.stringify({
                    inventory_id: invId,
                    shop_item_id: shopItemId,
                    item_name: itemName,
                    previous_quantity: oldQty,
                    new_quantity: newQty,
                    timestamp: new Date().toISOString()
                })]
            );

            await client.query('COMMIT');

            sysLog('Admin Item Quantity Set', {
                tag: 'SECURITY',
                user: interaction.user.id,
                target: targetUserId,
                guild: guildId,
                detail: `Admin ${interaction.user.id} changed ${itemName} quantity from ${oldQty} to ${newQty} for ${targetUserId}`
            });

            sendLog(interaction.guild, 'inventory', 'blue', '⚙️ Item Quantity Updated (Admin)',
                `**Item:** **${itemName}**\n` +
                `**Quantity Changed:** \`${oldQty}\` ➜ \`${newQty}\`\n` +
                `**Target:** <@${targetUserId}> (${targetLogName})\n` +
                `**Admin:** ${adminLogName} (via User Inventory Settings)`
            );
        }

        return showUserItems(interaction, targetUserId);

    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        sysError('Admin Remove Item Error', err, { user: interaction.user.id, guild: guildId, targetUserId });
        if (interaction.deferred || interaction.replied) {
            return interaction.followUp({ content: `❌ Error setting item quantity: ${err.message}`, flags: MessageFlags.Ephemeral });
        } else {
            return interaction.reply({ content: `❌ Error setting item quantity: ${err.message}`, flags: MessageFlags.Ephemeral });
        }
    } finally {
        client.release();
    }
}

/**
 * Builds the hierarchical folder select menu for granting items to a user.
 * Replicates the standard folder navigation pattern from item editing/deleting, p2p trading, and shop posting.
 *
 * @param {string} guildId
 * @param {string} targetUserId
 * @param {string} currentFolder - 'root' | 'categories' | 'standalone' | 'lootboxes' | 'cat_<id>'
 * @param {number} page
 * @param {Guild} guild
 * @returns {Promise<StringSelectMenuBuilder>}
 */
export async function buildAdminGiveSelectMenu(guildId, targetUserId, currentFolder = 'root', page = 1, guild = null) {
    const [categories, rawItems, lootBoxes, lootBoxCatName, lootBoxEmoji] = await Promise.all([
        getShopCategories(guildId),
        getShopItems(guildId, null, 'name', false, false),
        getLootBoxes(guildId),
        getLootBoxCategoryName(guildId),
        getLootBoxCategoryEmoji(guildId)
    ]);

    const nonPackItems = rawItems.filter(i => !i.is_pack && i.item_type !== 'pack');
    const standardItems = nonPackItems.filter(i => i.item_type !== 'loot_box');
    const categorizedItems = standardItems.filter(i => i.category_id !== null);
    const uncategorizedItems = standardItems.filter(i => i.category_id === null);

    const hasCategorized = categorizedItems.length > 0;
    const hasUncategorized = uncategorizedItems.length > 0;
    const hasLootBoxes = lootBoxes.length > 0;

    const customId = `admin_user_givesel_${targetUserId}`;

    if (!hasCategorized && !hasUncategorized && !hasLootBoxes) {
        return new StringSelectMenuBuilder()
            .setCustomId(customId)
            .setPlaceholder('No items available to give')
            .setDisabled(true)
            .addOptions([{ label: 'No items available', value: 'give_none' }]);
    }

    // LEVEL 1: ROOT FOLDERS
    if (currentFolder === 'root' || !currentFolder) {
        const folderOptions = [];
        if (hasCategorized) {
            folderOptions.push({
                label: 'Categorized Items',
                value: 'give_folder_categorized',
                emoji: '📂'
            });
        }
        if (hasUncategorized) {
            folderOptions.push({
                label: 'Uncategorized Items',
                value: 'give_folder_standalone',
                emoji: '🏷️'
            });
        }
        if (hasLootBoxes) {
            const lbLabel = safeTruncate(lootBoxCatName || 'Loot Boxes', 50);
            const lbEmoji = parseSelectEmoji(lootBoxEmoji, guild, '🎁') || '🎁';
            folderOptions.push({
                label: lbLabel,
                value: 'give_folder_lootboxes',
                emoji: lbEmoji
            });
        }

        return new StringSelectMenuBuilder()
            .setCustomId(customId)
            .setPlaceholder('🎁 Give Items...')
            .addOptions(folderOptions);
    }

    // LEVEL 2: CATEGORIZED FOLDERS
    if (currentFolder === 'categories') {
        const usedCatIds = new Set(categorizedItems.map(i => i.category_id));
        const activeCats = categories.filter(c => usedCatIds.has(c.id));

        if (activeCats.length === 0) {
            return buildAdminGiveSelectMenu(guildId, targetUserId, 'root', 1, guild);
        }

        const { selectMenu } = buildPaginatedSelectMenu({
            items: activeCats,
            page,
            customId,
            placeholder: '🎁 Give Items (Categories)',
            backOption: { label: 'Back', value: 'give_back_root', emoji: '⬅️' },
            pageNavPrefix: 'give_page_',
            pageSize: 20,
            mapOption: c => ({
                label: safeTruncate(c.name || `Category #${c.id}`, 100),
                value: `give_cat_${c.id}`,
                emoji: '📂'
            })
        });

        return selectMenu;
    }

    // LEVEL 3: ITEMS LIST (Inside specific category, standalone, or loot boxes)
    let folderItems = [];
    let backValue = 'give_back_root';
    let placeholder = '🎁 Give Items...';

    if (currentFolder === 'standalone') {
        folderItems = await sortItemsByRolePosition(uncategorizedItems, guild);
        placeholder = '🎁 Give Items (Uncategorized)';
        backValue = 'give_back_root';
    } else if (currentFolder === 'lootboxes') {
        folderItems = lootBoxes.map(b => ({ ...b, isChest: true }));
        folderItems.sort((a, b) => (parseInt(a.id) || 0) - (parseInt(b.id) || 0));
        const boxName = lootBoxCatName || 'Loot Boxes';
        placeholder = safeTruncate(`🎁 Give Items (${boxName})`, 100);
        backValue = 'give_back_root';
    } else if (currentFolder.startsWith('cat_')) {
        const catId = parseInt(currentFolder.replace('cat_', ''), 10);
        const catItems = categorizedItems.filter(i => i.category_id === catId);
        folderItems = await sortItemsByRolePosition(catItems, guild);
        const catObj = categories.find(c => parseInt(c.id, 10) === catId);
        const catName = catObj?.name || 'Category';
        placeholder = safeTruncate(`🎁 Give Items (${catName})`, 100);
        backValue = 'give_back_categories';
    }

    if (folderItems.length === 0) {
        return buildAdminGiveSelectMenu(guildId, targetUserId, 'root', 1, guild);
    }

    const { selectMenu } = buildPaginatedSelectMenu({
        items: folderItems,
        page,
        customId,
        placeholder,
        backOption: { label: 'Back', value: backValue, emoji: '⬅️' },
        pageNavPrefix: 'give_page_',
        pageSize: 20,
        mapOption: i => {
            const isChest = i.isChest || i.item_type === 'loot_box';
            const emoji = isChest
                ? (parseSelectEmoji(lootBoxEmoji, guild, '🎁') || '🎁')
                : getItemRarityEmoji(i);
            const desc = isChest ? 'Loot Box / Chest' : (i.role_id ? 'Role Item' : 'Inventory Item');
            return {
                label: safeTruncate(i.name || (isChest ? `Loot Box #${i.id}` : `Item #${i.id}`), 100),
                value: isChest ? `give_chest_${i.id}` : `give_item_${i.id}`,
                description: desc,
                emoji
            };
        }
    });

    return selectMenu;
}

/**
 * Handle selection in the hierarchical Give Items select menu.
 * Supports navigation (folders, categories, pages, back) and triggers the quantity modal on item selection.
 */
export async function handleAdminGiveSelect(interaction) {
    const selection = interaction.values[0];
    if (selection === 'give_none') return;

    const customId = interaction.customId;
    const parts = customId.split('_');
    const targetUserId = parts[3];
    const stateKey = `${interaction.user.id}_${targetUserId}`;
    let state = pendingAdminGive.get(stateKey) || { folder: 'root', page: 1 };

    // 1. Pagination navigation
    if (selection.startsWith('give_page_')) {
        state.page = parseInt(selection.replace('give_page_', ''), 10) || 1;
        pendingAdminGive.set(stateKey, state);
        return showUserItems(interaction, targetUserId);
    }

    // 2. Back navigation
    if (selection === 'give_back_root') {
        state.folder = 'root';
        state.page = 1;
        pendingAdminGive.set(stateKey, state);
        return showUserItems(interaction, targetUserId);
    }
    if (selection === 'give_back_categories') {
        state.folder = 'categories';
        state.page = 1;
        pendingAdminGive.set(stateKey, state);
        return showUserItems(interaction, targetUserId);
    }

    // 3. Folder navigation
    if (selection === 'give_folder_categorized') {
        state.folder = 'categories';
        state.page = 1;
        pendingAdminGive.set(stateKey, state);
        return showUserItems(interaction, targetUserId);
    }
    if (selection === 'give_folder_standalone') {
        state.folder = 'standalone';
        state.page = 1;
        pendingAdminGive.set(stateKey, state);
        return showUserItems(interaction, targetUserId);
    }
    if (selection === 'give_folder_lootboxes') {
        state.folder = 'lootboxes';
        state.page = 1;
        pendingAdminGive.set(stateKey, state);
        return showUserItems(interaction, targetUserId);
    }

    // 4. Drill into category
    if (selection.startsWith('give_cat_')) {
        const catId = selection.replace('give_cat_', '');
        state.folder = `cat_${catId}`;
        state.page = 1;
        pendingAdminGive.set(stateKey, state);
        return showUserItems(interaction, targetUserId);
    }

    // 5. Item / Chest selection -> Discord Modal
    if (selection.startsWith('give_item_') || selection.startsWith('give_chest_')) {
        const isChest = selection.startsWith('give_chest_');
        const typePrefix = isChest ? 'chest' : 'item';
        const rawId = selection.replace(isChest ? 'give_chest_' : 'give_item_', '');
        const itemId = parseInt(rawId, 10);

        if (isNaN(itemId)) {
            return interaction.reply({ content: '❌ Invalid item selection.', flags: MessageFlags.Ephemeral });
        }

        const pool = getPool();
        let itemName = 'Item';
        if (isChest) {
            const boxRes = await pool.query('SELECT name FROM loot_boxes WHERE id = $1', [itemId]);
            itemName = boxRes.rows[0]?.name || 'Chest';
        } else {
            const itemRes = await pool.query('SELECT name FROM shop_items WHERE id = $1', [itemId]);
            itemName = itemRes.rows[0]?.name || 'Item';
        }

        const modal = new ModalBuilder()
            .setCustomId(`admin_user_givemod_${targetUserId}_${typePrefix}_${itemId}`)
            .setTitle(safeTruncate(`Give ${itemName}`, 45));

        const qtyInput = new TextInputBuilder()
            .setCustomId('give_quantity')
            .setLabel('Enter quantity to give:')
            .setPlaceholder('1')
            .setValue('1')
            .setMinLength(1)
            .setMaxLength(6)
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(qtyInput));
        return interaction.showModal(modal);
    }
}

/**
 * Handle submission of the Give Items quantity modal.
 * Executes an atomic transaction with row-level locking (FOR UPDATE) and audit logging.
 */
export async function handleAdminGiveModal(interaction) {
    const customId = interaction.customId;
    const parts = customId.split('_');
    const targetUserId = parts[3];
    const itemType = parts[4]; // 'item' or 'chest'
    const itemId = parseInt(parts[5], 10);

    const rawQty = interaction.fields.getTextInputValue('give_quantity')?.trim();
    const inputQty = parseInt(rawQty, 10);

    // Strict positive integer validation
    if (isNaN(inputQty) || inputQty <= 0 || !/^\d+$/.test(rawQty)) {
        return interaction.reply({
            content: '❌ Invalid quantity. Please enter a positive whole number greater than 0.',
            flags: MessageFlags.Ephemeral
        });
    }

    if (inputQty > 1000000) {
        return interaction.reply({
            content: '❌ Quantity is too large. Maximum allowed is 1,000,000.',
            flags: MessageFlags.Ephemeral
        });
    }

    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate().catch(() => {});
    }

    const guildId = interaction.guildId;
    const pool = getPool();
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        let shopItemId = null;
        let roleId = null;
        let itemName = 'Item';

        if (itemType === 'chest') {
            const boxRes = await client.query(
                `SELECT * FROM loot_boxes WHERE id = $1 AND guild_id = $2 FOR UPDATE`,
                [itemId, guildId]
            );
            if (boxRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return interaction.followUp({ content: '❌ Loot box not found.', flags: MessageFlags.Ephemeral });
            }
            const box = boxRes.rows[0];
            itemName = box.name;

            // Ensure a shop_items entry exists for this loot box
            const shopItemRes = await client.query(
                `SELECT id, role_id FROM shop_items WHERE loot_box_id = $1 AND guild_id = $2 LIMIT 1 FOR UPDATE`,
                [itemId, guildId]
            );

            if (shopItemRes.rows.length > 0) {
                shopItemId = shopItemRes.rows[0].id;
                roleId = shopItemRes.rows[0].role_id || `LOOT_BOX_${itemId}`;
            } else {
                const newShopItem = await client.query(
                    `INSERT INTO shop_items (guild_id, name, item_type, role_id, is_pack, is_tradable, rarity, loot_box_id, is_active)
                     VALUES ($1, $2, 'loot_box', $3, false, true, 'common', $4, true)
                     RETURNING id, role_id`,
                    [guildId, box.name, `LOOT_BOX_${itemId}`, itemId]
                );
                shopItemId = newShopItem.rows[0].id;
                roleId = newShopItem.rows[0].role_id;
            }
        } else {
            // Standard shop item
            const itemRes = await client.query(
                `SELECT * FROM shop_items WHERE id = $1 AND guild_id = $2 FOR UPDATE`,
                [itemId, guildId]
            );
            if (itemRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return interaction.followUp({ content: '❌ Shop item not found.', flags: MessageFlags.Ephemeral });
            }
            const item = itemRes.rows[0];
            shopItemId = item.id;
            roleId = item.role_id || '';
            itemName = item.name;
        }

        // Concurrency Protection: Lock existing inventory row(s) for this user and item
        const existingInv = await client.query(
            `SELECT id, quantity, is_active, role_id 
             FROM user_inventory 
             WHERE user_id = $1 AND guild_id = $2 AND shop_item_id = $3
             ORDER BY is_active DESC, id ASC 
             FOR UPDATE`,
            [targetUserId, guildId, shopItemId]
        );

        let newTotal = 0;
        let oldTotal = 0;

        if (existingInv.rows.length > 0) {
            // Atomically add to existing stack on the first row
            const targetRow = existingInv.rows[0];
            oldTotal = parseInt(targetRow.quantity || 1, 10);
            newTotal = oldTotal + inputQty;

            await client.query(
                `UPDATE user_inventory 
                 SET quantity = quantity + $1, 
                     source = CASE WHEN source IN ('SYNC', 'ADMIN', 'ADMIN_GRANT') THEN 'TRADE' ELSE COALESCE(source, 'TRADE') END,
                     purchase_source = CASE WHEN purchase_source IN ('sync', 'admin') THEN 'trade' ELSE COALESCE(purchase_source, 'trade') END
                 WHERE id = $2`,
                [inputQty, targetRow.id]
            );
        } else {
            // Insert new inventory row
            newTotal = inputQty;
            await client.query(
                `INSERT INTO user_inventory (
                    user_id, guild_id, shop_item_id, role_id, is_active, source, purchase_source, quantity
                 ) VALUES ($1, $2, $3, $4, false, 'TRADE', 'trade', $5)`,
                [targetUserId, guildId, shopItemId, roleId, inputQty]
            );
        }

        // Audit Logging in audit_logs table
        await client.query(
            `INSERT INTO audit_logs (guild_id, user_id, action_type, target_type, target_id, details)
             VALUES ($1, $2, 'ADMIN_GIVE_ITEM', 'user', $3, $4)`,
            [guildId, interaction.user.id, targetUserId, JSON.stringify({
                item_type: itemType,
                shop_item_id: shopItemId,
                item_name: itemName,
                quantity_given: inputQty,
                previous_quantity: oldTotal,
                new_quantity: newTotal,
                timestamp: new Date().toISOString()
            })]
        );

        await client.query('COMMIT');

        // Audit logs to Discord audit channel and system logger
        const adminLogName = getUserLogName(interaction);
        const targetMember = await interaction.guild.members.fetch(targetUserId).catch(() => null);
        const targetLogName = targetMember ? getUserLogName(targetMember) : targetUserId;

        sysLog('Admin Gave Items', {
            tag: 'SECURITY',
            user: interaction.user.id,
            target: targetUserId,
            guild: guildId,
            detail: `Admin ${interaction.user.id} gave ${inputQty}x "${itemName}" to ${targetUserId} (New Total: ${newTotal})`
        });

        sendLog(interaction.guild, 'inventory', 'green', '🎁 Items Granted (Admin)',
            `**Item:** **${itemName}** \`(x${inputQty})\`\n` +
            `**Target:** <@${targetUserId}> (${targetLogName})\n` +
            `**New Stack Total:** \`${newTotal}\`\n` +
            `**Admin:** ${adminLogName} (via User Inventory Settings)`
        );

        // Safe Discord role assignment for role items if applicable
        if (targetMember && roleId && !roleId.startsWith('LOOT_BOX_') && !roleId.startsWith('CHEST_')) {
            const roleIds = roleId.split(/[,\s]+/);
            const botMember = interaction.guild.members.me;
            for (const rId of roleIds) {
                const role = interaction.guild.roles.cache.get(rId);
                if (role && botMember && role.comparePositionTo(botMember.roles.highest) < 0) {
                    await targetMember.roles.add(role).catch(err => {
                        sysError('Role Assignment Failed on Admin Give', err, { user: targetUserId, roleId: rId });
                    });
                }
            }
        }

        // Return admin directly to the user's updated inventory screen
        return showUserItems(interaction, targetUserId);

    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        sysError('Admin Give Item Error', err, { user: interaction.user.id, guild: guildId, targetUserId });
        if (interaction.deferred || interaction.replied) {
            return interaction.followUp({ content: `❌ Error granting items: ${err.message}`, flags: MessageFlags.Ephemeral });
        } else {
            return interaction.reply({ content: `❌ Error granting items: ${err.message}`, flags: MessageFlags.Ephemeral });
        }
    } finally {
        client.release();
    }
}

/**
 * Permanently revoke an item
 */
export async function handleRevokeItem(interaction, targetUserId, invId, categoryId) {
    if (invId.toString().startsWith('admin_')) {
        return interaction.reply({ content: '❌ Admin-granted items cannot be revoked via the economy system.', flags: MessageFlags.Ephemeral });
    }

    // 1. Defer immediately to avoid timeout and allow followUp
    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate().catch(() => {});
    }

    const pool = getPool();
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Fetch item details before deleting
        const itemRes = await client.query(
            `SELECT i.*, s.name, s.role_id 
             FROM user_inventory i 
             JOIN shop_items s ON i.shop_item_id = s.id 
             WHERE i.id = $1`, 
            [invId]
        );

        if (itemRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return interaction.followUp({ content: '❌ Item already removed.', flags: MessageFlags.Ephemeral });
        }

        const item = itemRes.rows[0];

        // 1. Delete from DB
        await client.query('DELETE FROM user_inventory WHERE id = $1', [invId]);

        // 2. Check remaining quantity for this item type across all inventory rows
        const remainingRes = await client.query(
            `SELECT COALESCE(SUM(COALESCE(quantity, 1)), 0) as total 
             FROM user_inventory 
             WHERE user_id = $1 AND shop_item_id = $2 AND guild_id = $3`,
            [targetUserId, item.shop_item_id, interaction.guildId]
        );
        const remainingQty = parseInt(remainingRes.rows[0]?.total || 0);

        // 3. Strip roles ONLY if total remaining quantity across all rows hits 0
        const targetMember = await interaction.guild.members.fetch(targetUserId).catch(() => null);

        if (targetMember && item.role_id && remainingQty === 0) {
            const roles = item.role_id.split(/[,\s]+/);
            for (const rid of roles) {
                try {
                    await targetMember.roles.remove(rid);
                } catch (roleErr) {
                    sysError('Infrastructure Audit Failure', roleErr, { user: targetUserId, guild: interaction.guildId, detail: `Revoke role: ${rid}` });
                }
            }
        }

        // Discord Log
        const adminLogName = getUserLogName(interaction);
        const targetLogName = targetMember ? getUserLogName(targetMember) : targetUserId;
        const itemQty = parseInt(item.quantity) || 1;
        const itemLabel = itemQty > 1 ? `${itemQty}x ${item.name}` : item.name;

        sendLog(interaction.guild, 'inventory', 'crimson', '🗑️ Item Revoked',
            `**Target:** ${targetLogName}\n` +
            `**Item:** \`${itemLabel}\`\n` +
            `**Admin:** ${adminLogName}\n` +
            `**Action:** Admin Force Revoke`
        );

        await client.query('COMMIT');

        // 4. Send success confirmation
        await interaction.followUp({ content: `✅ Permanently revoked **${item.name}** from <@${targetUserId}>.`, flags: MessageFlags.Ephemeral });
        
        // 5. Update the main inventory view
        await showUserItems(interaction, targetUserId, categoryId);
    } catch (error) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        sysError('Infrastructure Audit Failure', error, { user: interaction.user.id, target: targetUserId, guild: interaction.guildId, detail: 'Revoke item' });
        
        const errorMsg = '❌ Failed to revoke item properly.';
        if (interaction.deferred || interaction.replied) {
            await interaction.followUp({ content: errorMsg, flags: MessageFlags.Ephemeral }).catch(() => {});
        } else {
            await interaction.reply({ content: errorMsg, flags: MessageFlags.Ephemeral }).catch(() => {});
        }
    } finally {
        if (client) client.release();
    }
}

/**
 * Show transaction history for the target user
 */
export async function showUserHistory(interaction, targetUserId, page = 0) {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
    const LIMIT = 15;
    const offset = page * LIMIT;
    const pool = getPool();

    const [result, countRes] = await Promise.all([
        pool.query(
            `SELECT * FROM transactions 
             WHERE guild_id = $1 AND user_id = $2 
             ORDER BY created_at DESC 
             LIMIT $3 OFFSET $4`,
            [interaction.guildId, targetUserId, LIMIT, offset]
        ),
        pool.query(
            `SELECT COUNT(*) as total FROM transactions 
             WHERE guild_id = $1 AND user_id = $2`,
            [interaction.guildId, targetUserId]
        )
    ]);

    const totalCount = parseInt(countRes.rows[0]?.total || 0, 10);
    const totalPages = Math.max(1, Math.ceil(totalCount / LIMIT));

    const targetMember = await interaction.guild.members.fetch(targetUserId).catch(() => null);
    const displayName = targetMember ? targetMember.displayName : targetUserId;

    const embed = new EmbedBuilder()
        .setTitle(safeTruncate(`History: ${displayName}`, 256))
        .setColor(0x808080)
        .setFooter({ text: `Page ${page + 1} / ${totalPages}` });

    if (result.rowCount === 0) {
        embed.setDescription('No transactions found.');
    } else {
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

            // Fallback matching without lookbehinds to prevent string length/surrogate pair crash
            let description = tx.description.replace(/(^|[^<@&\d])(\d{17,19})(?!\d|>)/g, '$1<@$2>');
            // Normalize legacy MVP text to generic form
            description = description.replace(/Won MVP of the Day/gi, 'Won the MVP award')
                .replace(/MVP of the Day reward/gi, 'Won the MVP award');

            return `\`${date}\` ${amountDisplay} | ${description}`;
        });
        embed.setDescription(lines.join('\n'));
    }

    const navRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`admin_user_hpage_${targetUserId}_${page - 1}`)
            .setLabel('Previous')
            .setEmoji('◀️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page <= 0),
        new ButtonBuilder()
            .setCustomId(`admin_user_hpage_${targetUserId}_${page + 1}`)
            .setLabel('Next')
            .setEmoji('▶️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page >= totalPages - 1 || result.rowCount < LIMIT)
    );

    const backRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`admin_user_dash_${targetUserId}`)
            .setLabel('Back')
            .setEmoji('⬅️')
            .setStyle(ButtonStyle.Secondary)
    );

    const responseMethod = interaction.deferred || interaction.replied ? 'editReply' : 'update';
    await interaction[responseMethod]({ embeds: [embed], components: [navRow, backRow] });
}

/**
 * Component handler for all admin user management interactions
 */
export async function handleAdminUserComponent(interaction) {
    try {
        const { verifyAdminAccess, verifyAdminManagerAccess } = await import('../storage/admins.js');
        if (!(await verifyAdminAccess(interaction))) return;

        const customId = interaction.customId;

        if (customId === 'admin_user_admins') {
            if (!(await verifyAdminManagerAccess(interaction))) return;
            if (!interaction.deferred && !interaction.replied) {
                await interaction.deferUpdate().catch(() => {});
            }
            await showAdminManagement(interaction);
            return;
        }

        if (customId === 'admin_manage_toggle_user') {
            if (!(await verifyAdminManagerAccess(interaction))) return;
            await handleToggleAdminUser(interaction);
            return;
        }

        if (customId === 'admin_manage_back') {
            if (!interaction.deferred && !interaction.replied) {
                await interaction.deferUpdate().catch(() => {});
            }
            await showUserSelector(interaction);
            return;
        }

        if (customId === 'admin_user_select') {
            const targetUserId = interaction.values[0];
            await showUserDashboard(interaction, targetUserId);
            return;
        }

        if (customId === 'settings_users_roles') {
            const { showRoleRewardsMenu } = await import('./settings/role-rewards.js');
            await showRoleRewardsMenu(interaction);
            return;
        }

        if (interaction.isModalSubmit() && customId.startsWith('admin_user_setqty_')) {
            await handleAdminSetQuantity(interaction);
            return;
        }

        if (interaction.isModalSubmit() && customId.startsWith('admin_user_givemod_')) {
            await handleAdminGiveModal(interaction);
            return;
        }

        if (interaction.isModalSubmit() && customId.startsWith('admin_user_remmod_')) {
            await handleAdminRemoveModal(interaction);
            return;
        }

        const parts = customId.split('_');
        const action = parts[2];
        const targetUserId = parts[3];

        switch (action) {
            case 'dash':
                pendingAdminGive.delete(`${interaction.user.id}_${targetUserId}`);
                pendingAdminRemove.delete(`${interaction.user.id}_${targetUserId}`);
                await showUserDashboard(interaction, targetUserId);
                break;
            case 'balance':
                await handleBalanceAction(interaction, targetUserId);
                break;
            case 'streak':
                await handleStreakAction(interaction, targetUserId);
                break;
            case 'level':
                await handleLevelAction(interaction, targetUserId);
                break;
            case 'items':
                pendingAdminGive.delete(`${interaction.user.id}_${targetUserId}`);
                pendingAdminRemove.delete(`${interaction.user.id}_${targetUserId}`);
                await showUserItems(interaction, targetUserId);
                break;
            case 'give':
            case 'givecat':
                await showUserItems(interaction, targetUserId);
                break;
            case 'givesel': {
                await handleAdminGiveSelect(interaction);
                break;
            }
            case 'remsel': {
                await handleAdminRemoveSelect(interaction);
                break;
            }
            case 'history':
                await showUserHistory(interaction, targetUserId);
                break;
            case 'icat': {
                const catId = parts[4];
                pendingAdminGive.delete(`${interaction.user.id}_${targetUserId}`);
                pendingAdminRemove.delete(`${interaction.user.id}_${targetUserId}`);
                await showUserItems(interaction, targetUserId);
                break;
            }
            case 'isel': {
                const selectedVal = interaction.values[0];
                const catId = parts[4];
                if (selectedVal === 'back_to_categories') {
                    await showUserItems(interaction, targetUserId, null);
                    break;
                }
                if (selectedVal.startsWith('admin_page_')) {
                    const targetPage = parseInt(selectedVal.replace('admin_page_', ''), 10) || 1;
                    await showUserItems(interaction, targetUserId, catId, targetPage);
                    break;
                }
                const lastUnderscore = selectedVal.lastIndexOf('_');
                const invId = (lastUnderscore !== -1) ? selectedVal.slice(0, lastUnderscore) : selectedVal;

                if (String(invId).startsWith('admin_')) {
                    return interaction.reply({
                        content: '❌ Admin-granted items are managed directly via Discord roles.',
                        flags: MessageFlags.Ephemeral
                    });
                }

                const pool = getPool();
                const itemRes = await pool.query(
                    `SELECT ui.quantity, si.name 
                     FROM user_inventory ui 
                     JOIN shop_items si ON ui.shop_item_id = si.id 
                     WHERE ui.id = $1`,
                    [invId]
                );

                if (itemRes.rowCount === 0) {
                    await showUserItems(interaction, targetUserId, catId);
                    break;
                }

                const currentQty = parseInt(itemRes.rows[0].quantity) || 1;
                const itemName = itemRes.rows[0].name || 'Item';

                const modal = new ModalBuilder()
                    .setCustomId(`admin_user_setqty_${targetUserId}_${invId}_${catId}`)
                    .setTitle(safeTruncate(`Edit Quantity: ${itemName}`, 45));

                const qtyInput = new TextInputBuilder()
                    .setCustomId('new_quantity')
                    .setLabel('Enter new quantity (0 to remove)')
                    .setPlaceholder(String(currentQty))
                    .setValue(String(currentQty))
                    .setMinLength(1)
                    .setMaxLength(3)
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true);

                modal.addComponents(new ActionRowBuilder().addComponents(qtyInput));
                await interaction.showModal(modal);
                break;
            }
            case 'revoke': {
                const invId = parts[4];
                const catId = parts[5];
                await handleRevokeItem(interaction, targetUserId, invId, catId);
                break;
            }
            case 'hpage': {
                const page = parseInt(parts[4]);
                await showUserHistory(interaction, targetUserId, page);
                break;
            }
            case 'anticheat': {
                const subAction = parts[3];
                const gateType = parts.slice(4).join('_');

                if (!subAction || subAction === 'hub') {
                    await showAntiCheatHub(interaction);
                } else if (subAction === 'alt') {
                    if (!gateType) {
                        await showAltFarmingDashboard(interaction);
                    } else if (gateType === 'age') {
                        await handleToggleAltFarmingGate(interaction, 'age');
                    } else if (gateType === 'join') {
                        await handleToggleAltFarmingGate(interaction, 'join');
                    } else if (gateType === 'back') {
                        await showAntiCheatHub(interaction);
                    }
                } else if (subAction === 'voice') {
                    if (!gateType) {
                        await showVoiceAfkDashboard(interaction);
                    } else if (gateType === 'back') {
                        await showAntiCheatHub(interaction);
                    } else {
                        await handleToggleVoiceAfkGate(interaction, gateType);
                    }
                } else if (subAction === 'text') {
                    if (!gateType) {
                        await showTextSpamDashboard(interaction);
                    } else if (gateType === 'back') {
                        await showAntiCheatHub(interaction);
                    } else {
                        await handleToggleTextSpamGate(interaction, gateType);
                    }
                } else if (subAction === 'back') {
                    await showUserSelector(interaction);
                }
                break;
            }
        }
    } catch (error) {
        console.error('CRITICAL ADMIN ERROR DETAILS:', error);
        await handleInteractionError(interaction, error, 'Admin user component handler');
    }
}

/**
 * Show the main Anti-Cheat navigation hub
 */
export async function showAntiCheatHub(interaction) {
    const embed = new EmbedBuilder()
        .setTitle('Anti-Cheat')
        .setDescription(
            'Configure anti-cheat protections and farming gates.\n\n' +
            '• **Text Spam** — Message cooldown and anti-spam gates\n' +
            '• **Voice AFK** — Voice farming prevention\n' +
            '• **Alt Farming** — Account age and join date gates'
        )
        .setColor(0x3498DB);

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('admin_user_anticheat_text')
            .setLabel('Text Spam')
            .setEmoji('💬')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('admin_user_anticheat_voice')
            .setLabel('Voice AFK')
            .setEmoji('🎙️')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('admin_user_anticheat_alt')
            .setLabel('Alt Farming')
            .setEmoji('🎭')
            .setStyle(ButtonStyle.Secondary)
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('admin_user_anticheat_back')
            .setLabel('Back')
            .setEmoji('◀️')
            .setStyle(ButtonStyle.Secondary)
    );

    const responseMethod = (interaction.deferred || interaction.replied)
        ? 'editReply'
        : (interaction.isButton() || interaction.isAnySelectMenu() ? 'update' : 'editReply');
    await interaction[responseMethod]({
        embeds: [embed],
        components: [row1, row2]
    });
}

/**
 * Show the Alt Farming anti-cheat dashboard
 */
export async function showAltFarmingDashboard(interaction) {
    const { getGuildConfig } = await import('../storage/config.js');
    const guildId = interaction.guildId;
    const config = await getGuildConfig(guildId) || {};
    
    const ageGate = config.anti_cheat_account_age_gate ?? false;
    const joinGate = config.anti_cheat_join_date_gate ?? false;
    
    const desc = [
        '📅 **Account Age Gate**',
        'Requires a (30-day) old Discord account to trade.',
        '',
        '⏳ **Join Date Gate**',
        'Requires (7-days) of server membership to trade.'
    ].join('\n');

    const embed = new EmbedBuilder()
        .setTitle('Alt Farming')
        .setDescription(desc)
        .setColor(0x3498DB);

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('admin_user_anticheat_alt_age')
            .setLabel(`Account Age Gate: ${ageGate ? 'ON' : 'OFF'}`)
            .setEmoji(ageGate ? '🟢' : '🔴')
            .setStyle(ageGate ? ButtonStyle.Success : ButtonStyle.Danger)
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('admin_user_anticheat_alt_join')
            .setLabel(`Join Date Gate: ${joinGate ? 'ON' : 'OFF'}`)
            .setEmoji(joinGate ? '🟢' : '🔴')
            .setStyle(joinGate ? ButtonStyle.Success : ButtonStyle.Danger)
    );

    const row3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('admin_user_anticheat_alt_back')
            .setLabel('Back')
            .setEmoji('◀️')
            .setStyle(ButtonStyle.Secondary)
    );

    const responseMethod = (interaction.deferred || interaction.replied)
        ? 'editReply'
        : (interaction.isButton() || interaction.isAnySelectMenu() ? 'update' : 'editReply');
    await interaction[responseMethod]({
        embeds: [embed],
        components: [row1, row2, row3]
    });
}

/**
 * Show the Voice AFK dashboard
 */
export async function showVoiceAfkDashboard(interaction) {
    const { getGuildConfig } = await import('../storage/config.js');
    const guildId = interaction.guildId;
    const config = await getGuildConfig(guildId) || {};

    const minHumans = config.anti_cheat_voice_min_humans ?? true;
    const noMute = config.anti_cheat_voice_no_mute ?? true;
    const noDeafen = config.anti_cheat_voice_no_deafen ?? true;
    const noAfk = config.anti_cheat_voice_no_afk_channel ?? true;

    const desc = [
        '👥 **Minimum 2 Humans**',
        'Requires at least 2 non-bot users in call to earn points.',
        '',
        '🔇 **Mute Filter**',
        'Pauses point accumulation while self-muted or server-muted.',
        '',
        '🎧 **Deafen Filter**',
        'Pauses point accumulation while self-deafened or server-deafened.',
        '',
        '⛔ **AFK Channel Blacklist**',
        'Blocks point accumulation inside Discord\'s official AFK channel.'
    ].join('\n');

    const embed = new EmbedBuilder()
        .setTitle('Voice AFK')
        .setDescription(desc)
        .setColor(0x3498DB);

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('admin_user_anticheat_voice_min_humans')
            .setLabel(`Min 2 Humans: ${minHumans ? 'ON' : 'OFF'}`)
            .setEmoji(minHumans ? '🟢' : '🔴')
            .setStyle(minHumans ? ButtonStyle.Success : ButtonStyle.Danger)
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('admin_user_anticheat_voice_no_mute')
            .setLabel(`Mute Filter: ${noMute ? 'ON' : 'OFF'}`)
            .setEmoji(noMute ? '🟢' : '🔴')
            .setStyle(noMute ? ButtonStyle.Success : ButtonStyle.Danger)
    );

    const row3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('admin_user_anticheat_voice_no_deafen')
            .setLabel(`Deafen Filter: ${noDeafen ? 'ON' : 'OFF'}`)
            .setEmoji(noDeafen ? '🟢' : '🔴')
            .setStyle(noDeafen ? ButtonStyle.Success : ButtonStyle.Danger)
    );

    const row4 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('admin_user_anticheat_voice_no_afk')
            .setLabel(`AFK Channel: ${noAfk ? 'ON' : 'OFF'}`)
            .setEmoji(noAfk ? '🟢' : '🔴')
            .setStyle(noAfk ? ButtonStyle.Success : ButtonStyle.Danger)
    );

    const row5 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('admin_user_anticheat_voice_back')
            .setLabel('Back')
            .setEmoji('◀️')
            .setStyle(ButtonStyle.Secondary)
    );

    const responseMethod = (interaction.deferred || interaction.replied)
        ? 'editReply'
        : (interaction.isButton() || interaction.isAnySelectMenu() ? 'update' : 'editReply');
    await interaction[responseMethod]({
        embeds: [embed],
        components: [row1, row2, row3, row4, row5]
    });
}

/**
 * Handle toggle action for Voice AFK gates
 */
export async function handleToggleVoiceAfkGate(interaction, gateType) {
    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate().catch(() => {});
    }
    const { getGuildConfig, setGuildConfig } = await import('../storage/config.js');
    const { invalidateConfigCache } = await import('../activity/index.js');
    const guildId = interaction.guildId;
    let config = await getGuildConfig(guildId) || {};

    if (gateType === 'min_humans') {
        const current = config.anti_cheat_voice_min_humans ?? true;
        config.anti_cheat_voice_min_humans = !current;
    } else if (gateType === 'no_mute') {
        const current = config.anti_cheat_voice_no_mute ?? true;
        config.anti_cheat_voice_no_mute = !current;
    } else if (gateType === 'no_deafen') {
        const current = config.anti_cheat_voice_no_deafen ?? true;
        config.anti_cheat_voice_no_deafen = !current;
    } else if (gateType === 'no_afk') {
        const current = config.anti_cheat_voice_no_afk_channel ?? true;
        config.anti_cheat_voice_no_afk_channel = !current;
    }

    await setGuildConfig(guildId, config);
    invalidateConfigCache(guildId);

    await showVoiceAfkDashboard(interaction);
}

/**
 * Show the Text Spam dashboard
 */
export async function showTextSpamDashboard(interaction) {
    const { getGuildConfig } = await import('../storage/config.js');
    const guildId = interaction.guildId;
    const config = await getGuildConfig(guildId) || {};

    const cooldown = config.anti_cheat_text_cooldown ?? true;
    const minLength = config.anti_cheat_text_min_length ?? true;
    const noDuplicates = config.anti_cheat_text_no_duplicates ?? true;
    const noPrefixes = config.anti_cheat_text_no_prefixes ?? true;

    const desc = [
        '⏱️ **5-Second Cooldown**',
        'Limits point accumulation to one message every 5 seconds.',
        '',
        '📏 **Minimum Length**',
        'Requires at least 5 characters to earn points (attachments bypass).',
        '',
        '🔁 **Duplicate Filter**',
        'Blocks points for sending the same message twice in a row.',
        '',
        '⌨️ **Command Prefix Filter**',
        'Blocks points for messages starting with bot command prefixes.'
    ].join('\n');

    const embed = new EmbedBuilder()
        .setTitle('Text Spam')
        .setDescription(desc)
        .setColor(0x3498DB);

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('admin_user_anticheat_text_cooldown')
            .setLabel(`Cooldown (5s): ${cooldown ? 'ON' : 'OFF'}`)
            .setEmoji(cooldown ? '🟢' : '🔴')
            .setStyle(cooldown ? ButtonStyle.Success : ButtonStyle.Danger)
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('admin_user_anticheat_text_min_length')
            .setLabel(`Min Length: ${minLength ? 'ON' : 'OFF'}`)
            .setEmoji(minLength ? '🟢' : '🔴')
            .setStyle(minLength ? ButtonStyle.Success : ButtonStyle.Danger)
    );

    const row3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('admin_user_anticheat_text_no_duplicates')
            .setLabel(`Duplicate Filter: ${noDuplicates ? 'ON' : 'OFF'}`)
            .setEmoji(noDuplicates ? '🟢' : '🔴')
            .setStyle(noDuplicates ? ButtonStyle.Success : ButtonStyle.Danger)
    );

    const row4 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('admin_user_anticheat_text_no_prefixes')
            .setLabel(`Command Filter: ${noPrefixes ? 'ON' : 'OFF'}`)
            .setEmoji(noPrefixes ? '🟢' : '🔴')
            .setStyle(noPrefixes ? ButtonStyle.Success : ButtonStyle.Danger)
    );

    const row5 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('admin_user_anticheat_text_back')
            .setLabel('Back')
            .setEmoji('◀️')
            .setStyle(ButtonStyle.Secondary)
    );

    const responseMethod = (interaction.deferred || interaction.replied)
        ? 'editReply'
        : (interaction.isButton() || interaction.isAnySelectMenu() ? 'update' : 'editReply');
    await interaction[responseMethod]({
        embeds: [embed],
        components: [row1, row2, row3, row4, row5]
    });
}

/**
 * Handle toggle action for Text Spam gates
 */
export async function handleToggleTextSpamGate(interaction, gateType) {
    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate().catch(() => {});
    }
    const { getGuildConfig, setGuildConfig } = await import('../storage/config.js');
    const { invalidateConfigCache } = await import('../activity/index.js');
    const guildId = interaction.guildId;
    let config = await getGuildConfig(guildId) || {};

    if (gateType === 'cooldown') {
        const current = config.anti_cheat_text_cooldown ?? true;
        config.anti_cheat_text_cooldown = !current;
    } else if (gateType === 'min_length') {
        const current = config.anti_cheat_text_min_length ?? true;
        config.anti_cheat_text_min_length = !current;
    } else if (gateType === 'no_duplicates') {
        const current = config.anti_cheat_text_no_duplicates ?? true;
        config.anti_cheat_text_no_duplicates = !current;
    } else if (gateType === 'no_prefixes') {
        const current = config.anti_cheat_text_no_prefixes ?? true;
        config.anti_cheat_text_no_prefixes = !current;
    }

    await setGuildConfig(guildId, config);
    invalidateConfigCache(guildId);

    await showTextSpamDashboard(interaction);
}

/**
 * Handle toggle action for Alt Farming gates
 */
export async function handleToggleAltFarmingGate(interaction, gateType) {
    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate().catch(() => {});
    }
    const { getGuildConfig, setGuildConfig } = await import('../storage/config.js');
    const { invalidateConfigCache } = await import('../activity/index.js');
    const guildId = interaction.guildId;
    let config = await getGuildConfig(guildId) || {};
    
    if (gateType === 'age') {
        const current = config.anti_cheat_account_age_gate ?? false;
        config.anti_cheat_account_age_gate = !current;
    } else if (gateType === 'join') {
        const current = config.anti_cheat_join_date_gate ?? false;
        config.anti_cheat_join_date_gate = !current;
    }
    
    await setGuildConfig(guildId, config);
    invalidateConfigCache(guildId);
    
    await showAltFarmingDashboard(interaction);
}

// Backward compatibility alias
export const showAntiCheatDashboard = showAntiCheatHub;
export const handleToggleAntiCheat = handleToggleAltFarmingGate;

/**
 * Render the Bot Admin Management panel
 * Shows server owner, list of authorized bot admins, and UserSelectMenu to toggle admin status
 * @param {import('discord.js').Interaction} interaction
 */
export async function showAdminManagement(interaction) {
    const { verifyAdminManagerAccess } = await import('../storage/admins.js');
    if (!(await verifyAdminManagerAccess(interaction))) return;

    const guildId = interaction.guildId;
    let guild = interaction.guild;
    if (!guild && interaction.client) {
        guild = await interaction.client.guilds.fetch(guildId).catch(() => null);
    }
    let ownerId = guild?.ownerId;

    if (!ownerId && guild?.fetch) {
        try {
            const g = await guild.fetch();
            ownerId = g.ownerId;
        } catch {}
    }
    if (!ownerId && interaction.client) {
        try {
            const g = await interaction.client.guilds.fetch(guildId).catch(() => null);
            ownerId = g?.ownerId;
        } catch {}
    }

    const { getServerAdmins } = await import('../storage/admins.js');
    const admins = await getServerAdmins(guildId);

    // Fetch members with Discord Administrator permission
    const discordAdminIds = new Set();
    if (guild) {
        try {
            await guild.members.fetch().catch(() => {});
            for (const member of guild.members.cache.values()) {
                if (!member.user.bot && member.id !== ownerId && member.permissions?.has(PermissionFlagsBits.Administrator)) {
                    discordAdminIds.add(member.id);
                }
            }
        } catch (err) {
            sysError('Failed to fetch Discord administrators for admin panel', err, { guildId });
        }
    }

    const userLines = [];
    if (ownerId) {
        userLines.push(`• <@${ownerId}> (Owner)`);
    }
    for (const adminId of discordAdminIds) {
        userLines.push(`• <@${adminId}> (Admin)`);
    }
    for (const a of admins) {
        if (!discordAdminIds.has(a.user_id) && a.user_id !== ownerId) {
            let member = guild?.members?.cache?.get(a.user_id);
            if (!member && guild) {
                member = await guild.members.fetch(a.user_id).catch(() => null);
            }
            if (!member) {
                const { removeServerAdmin } = await import('../storage/admins.js');
                await removeServerAdmin(guildId, a.user_id).catch(() => {});
                continue;
            }
            userLines.push(`• <@${a.user_id}>`);
        }
    }

    const desc = userLines.join('\n') + '\n\n' +
        '———————————————————————\n' +
        'Users in this list can use `/settings` or `/mass` commands\n' +
        'And interact with the **Admin Interface**.';

    const embed = new EmbedBuilder()
        .setTitle('Authorized Users')
        .setDescription(desc)
        .setColor(0x5865F2);

    const userSelect = new UserSelectMenuBuilder()
        .setCustomId('admin_manage_toggle_user')
        .setPlaceholder('Select a user to add or remove...')
        .setMinValues(1)
        .setMaxValues(1);

    const backButton = new ButtonBuilder()
        .setCustomId('admin_manage_back')
        .setLabel('Back')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary);

    const row1 = new ActionRowBuilder().addComponents(userSelect);
    const row2 = new ActionRowBuilder().addComponents(backButton);

    const responseMethod = (interaction.deferred || interaction.replied)
        ? 'editReply'
        : (interaction.isButton() || interaction.isAnySelectMenu() ? 'update' : 'editReply');

    await interaction[responseMethod]({
        content: '',
        embeds: [embed],
        components: [row1, row2]
    });
}

/**
 * Handle adding or removing a user from server_admins (toggle logic)
 * @param {import('discord.js').Interaction} interaction
 */
export async function handleToggleAdminUser(interaction) {
    const { verifyAdminManagerAccess } = await import('../storage/admins.js');
    if (!(await verifyAdminManagerAccess(interaction))) return;

    const guildId = interaction.guildId;
    const targetUserId = interaction.values[0];
    let guild = interaction.guild;
    if (!guild && interaction.client) {
        guild = await interaction.client.guilds.fetch(guildId).catch(() => null);
    }
    let ownerId = guild?.ownerId;

    if (!ownerId && guild?.fetch) {
        try {
            const g = await guild.fetch();
            ownerId = g.ownerId;
        } catch {}
    }
    if (!ownerId && interaction.client) {
        try {
            const g = await interaction.client.guilds.fetch(guildId).catch(() => null);
            ownerId = g?.ownerId;
        } catch {}
    }

    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate().catch(() => {});
    }

    if (ownerId && targetUserId === ownerId) {
        await interaction.followUp({
            content: '❌ **Action Prohibited**: The server owner is permanently an administrator and cannot be modified.',
            flags: MessageFlags.Ephemeral
        });
        return showAdminManagement(interaction);
    }

    // Check target user validity and membership
    let targetMember = guild?.members?.cache?.get(targetUserId);
    if (!targetMember && guild) {
        targetMember = await guild.members.fetch(targetUserId).catch(() => null);
    }

    if (!targetMember) {
        const { isServerAdmin, removeServerAdmin } = await import('../storage/admins.js');
        const isCurrentlyAdmin = await isServerAdmin(guildId, targetUserId);
        if (isCurrentlyAdmin) {
            await removeServerAdmin(guildId, targetUserId);
            return showAdminManagement(interaction);
        }
        await interaction.followUp({
            content: '❌ **Action Prohibited**: Target user was not found in this server.',
            flags: MessageFlags.Ephemeral
        });
        return showAdminManagement(interaction);
    }

    if (targetMember.user?.bot) {
        await interaction.followUp({
            content: '❌ **Action Prohibited**: Bots cannot be designated as administrators.',
            flags: MessageFlags.Ephemeral
        });
        return showAdminManagement(interaction);
    }

    if (targetMember.permissions?.has(PermissionFlagsBits.Administrator)) {
        await interaction.followUp({
            content: `❌ **Action Prohibited**: <@${targetUserId}> has the Discord **Administrator** permission and is automatically an administrator. To remove their access, remove their Administrator role in Discord Server Settings.`,
            flags: MessageFlags.Ephemeral
        });
        return showAdminManagement(interaction);
    }

    const { toggleServerAdmin } = await import('../storage/admins.js');
    const result = await toggleServerAdmin(guildId, targetUserId);

    const logName = getUserLogName(interaction);
    if (result.action === 'added') {
        sendLog(interaction.guild, 'audit', 'cyan', '🛡️ Bot Admin Added',
            `**Admin:** \`${logName}\`\n` +
            `**Target:** <@${targetUserId}>\n` +
            `**Action:** Added to bot administrators`
        );
        sysLog('Bot Admin Added', { user: interaction.user.id, guild: guildId, target: targetUserId });
        await interaction.followUp({
            content: `✅ Successfully added <@${targetUserId}> as a bot administrator.`,
            flags: MessageFlags.Ephemeral
        });
    } else {
        sendLog(interaction.guild, 'audit', 'yellow', '🛡️ Bot Admin Removed',
            `**Admin:** \`${logName}\`\n` +
            `**Target:** <@${targetUserId}>\n` +
            `**Action:** Removed from bot administrators`
        );
        sysLog('Bot Admin Removed', { user: interaction.user.id, guild: guildId, target: targetUserId });
        await interaction.followUp({
            content: `🗑️ Successfully removed <@${targetUserId}> from bot administrators.`,
            flags: MessageFlags.Ephemeral
        });
    }

    return showAdminManagement(interaction);
}


