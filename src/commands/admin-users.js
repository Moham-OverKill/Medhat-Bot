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
    MessageFlags
} from 'discord.js';
import { getPool } from '../storage/postgres.js';
import { sanitizeError, getUserDisplayName, getUserLogName, sortItemsByRolePosition, formatInventoryItemLine, safeTruncate, COIN_EMOJI } from '../shared.js';
import { getShopCategories, getUserInventory, syncInventoryWithDiscord, getSynthesizedInventory, getItemImage } from '../economy/shop.js';
import { sendLog, sysLog, sysError } from '../utils/logger.js';
import { buildPaginatedSelectMenu } from '../utils/paginator.js';
import { handleInteractionError } from '../utils/errors.js';

/**
 * Show user selector dropdown
 */
export async function showUserSelector(interaction) {
    const embed = new EmbedBuilder()
        .setTitle('👥 User Management')
        .setDescription('Select a user to manage their balance or inventory')
        .setColor(0x2F3136);

    const select = new UserSelectMenuBuilder()
        .setCustomId('admin_user_select')
        .setPlaceholder('Select a user...')
        .setMinValues(1)
        .setMaxValues(1);

    // Row 2: Back, Roles, Anti-Cheat
    const actionRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('settings_back')
            .setLabel('Back')
            .setEmoji('⬅️')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('settings_users_roles')
            .setLabel('Roles')
            .setEmoji('🎭')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('admin_user_anticheat')
            .setLabel('Anti Cheat')
            .setEmoji('🛡️')
            .setStyle(ButtonStyle.Primary)
    );

    const responseMethod = interaction.isButton() || interaction.isAnySelectMenu() ? 'update' : 'editReply';
    await interaction[responseMethod]({
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(select), actionRow]
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
                'INSERT INTO user_balances (guild_id, user_id, balance, daily_streak) VALUES ($1, $2, 0, 0) RETURNING balance, daily_streak',
                [guildId, targetUserId]
            );
        }

        const balance = parseInt(userResult.rows[0].balance);
        const streak = parseInt(userResult.rows[0].daily_streak) || 0;

        // Fetch user level from user_activity
        let userLevel = 0;
        try {
            const actRes = await pool.query(
                'SELECT battlepass_xp FROM user_activity WHERE guild_id = $1 AND user_id = $2',
                [guildId, targetUserId]
            );
            const totalXp = parseInt(actRes.rows[0]?.battlepass_xp || 0, 10);
            const { getGuildConfig } = await import('../storage/config.js');
            const config = await getGuildConfig(guildId) || {};
            const baseXp = parseInt(config.battlepass_base_xp ?? config.battlepass_xp_per_level ?? 20, 10);
            const incrementXp = parseInt(config.battlepass_xp_increment ?? 10, 10);
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
            .setTitle(safeTruncate(`⚙️ Managing: ${displayName}`, 256))
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
                .setCustomId('settings_back')
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
    const newBalance = parseInt(interaction.fields.getTextInputValue('new_balance'));

    if (isNaN(newBalance) || newBalance < 0) {
        return interaction.followUp({ content: '❌ Invalid balance. Please enter a positive number.', flags: MessageFlags.Ephemeral });
    }

    const guildId = interaction.guildId;
    const pool = getPool();

    try {
        const targetMember = await interaction.guild.members.fetch(targetUserId).catch(() => null);

        // Get old balance for history logging
        const oldRes = await pool.query('SELECT balance FROM user_balances WHERE guild_id = $1 AND user_id = $2', [guildId, targetUserId]);
        const oldBalance = oldRes.rowCount > 0 ? parseInt(oldRes.rows[0].balance) : 0;
        const delta = newBalance - oldBalance;

        // Update balance
        await pool.query(
            `INSERT INTO user_balances (guild_id, user_id, balance) VALUES ($1, $2, $3)
             ON CONFLICT (guild_id, user_id) DO UPDATE SET balance = $3, updated_at = NOW()`,
            [guildId, targetUserId, newBalance]
        );

        // Log transaction (DB)
        const adminName = getUserDisplayName(interaction.member);
        await pool.query(
            `INSERT INTO transactions (guild_id, user_id, amount, balance_after, type, description)
             VALUES ($1, $2, $3, $4, 'admin_adjust', $5)`,
            [guildId, targetUserId, delta, newBalance, `${adminName} adjusted balance to ${newBalance}`]
        );

        // Discord Log
        const adminLogName = getUserLogName(interaction);
        const targetLogName = targetMember ? getUserLogName(targetMember) : targetUserId;
        
        if (delta > 0) {
            sendLog(interaction.guild, 'economy', 'green', '💰 Balance Adjusted',
                `**Target:** \`${targetLogName}\`\n` +
                `**Addition:** \`+${delta.toLocaleString()}\` ${COIN_EMOJI}\n` +
                `**Admin:** \`${adminLogName}\` (via User Settings)`
            );
        } else {
            sendLog(interaction.guild, 'audit', 'red', '⚖️ Balance Adjusted',
                `**Target:** \`${targetLogName}\`\n` +
                `**Reduction:** \`${delta.toLocaleString()}\` ${COIN_EMOJI}\n` +
                `**Admin:** \`${adminLogName}\` (via User Settings)`
            );
        }

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
            `INSERT INTO user_balances (guild_id, user_id, daily_streak, last_daily, balance) VALUES ($1, $2, $3, $4, 0)
             ON CONFLICT (guild_id, user_id) DO UPDATE SET daily_streak = $3, last_daily = $4, updated_at = NOW()`,
            [guildId, targetUserId, newStreak, targetLastDaily]
        );

        // Discord Log
        const adminLogName = getUserLogName(interaction);
        const targetLogName = targetMember ? getUserLogName(targetMember) : targetUserId;

        sendLog(interaction.guild, 'audit', 'orange', '🔥 Streak Adjusted',
            `**Target:** \`${targetLogName}\`\n` +
            `**Streak Changed:** \`${oldStreak}\` ➜ \`${newStreak}\`\n` +
            `**Admin:** \`${adminLogName}\` (via User Settings)`
        );

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
    const baseXp = parseInt(config.battlepass_base_xp ?? config.battlepass_xp_per_level ?? 20, 10);
    const incrementXp = parseInt(config.battlepass_xp_increment ?? 10, 10);
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
        const baseXp = parseInt(config.battlepass_base_xp ?? config.battlepass_xp_per_level ?? 20, 10);
        const incrementXp = parseInt(config.battlepass_xp_increment ?? 10, 10);
        const { getTotalXpForLevel } = await import('./settings/pass-engine.js');
        const targetXp = getTotalXpForLevel(newLevel, baseXp, incrementXp);

        const targetMember = await interaction.guild.members.fetch(targetUserId).catch(() => null);

        await pool.query(
            `INSERT INTO user_activity (guild_id, user_id, username, battlepass_xp)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (guild_id, user_id)
             DO UPDATE SET battlepass_xp = $4`,
            [guildId, targetUserId, targetMember?.user?.username || 'User', targetXp]
        );

        if (newLevel > 0) {
            const { syncUserLevelRewards } = await import('./settings/pass-engine.js');
            await syncUserLevelRewards(guildId, targetUserId, targetMember?.user?.username || 'User', interaction.client);
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
            `**Target:** \`${targetLogName}\`\n` +
            `**Level Changed To:** **Level ${newLevel}** (${targetXp.toLocaleString()} XP)\n` +
            `**Admin:** \`${adminLogName}\` (via User Settings)`
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
export async function showUserItems(interaction, targetUserId, categoryId = null, page = 1) {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
    const guildId = interaction.guildId;
    const isLootBox = categoryId === 'lootboxes';
    const isOther = categoryId === 'null';
    const catId = (isOther || isLootBox) ? null : (categoryId ? parseInt(categoryId) : null);

    const targetMember = await interaction.guild.members.fetch(targetUserId).catch(() => null);
    if (!targetMember) return interaction.followUp({ content: '❌ Member not found.', flags: MessageFlags.Ephemeral });

    // Sync and fetch inventory for target user (including synthesized admin items)
    const inventory = await getSynthesizedInventory(targetUserId, guildId, targetMember);
    const categories = await getShopCategories(guildId);

    // List of visible items (no packs)
    const visibleItems = inventory.filter(i => !(i.item_type === 'pack' || i.is_pack));
    const lootBoxItems = visibleItems.filter(i => i.item_type === 'loot_box');
    const standardItems = visibleItems.filter(i => i.item_type !== 'loot_box');
    const lootBoxCount = lootBoxItems.reduce((sum, i) => sum + (parseInt(i.quantity) || 1), 0);

    if (categoryId === null) {
        const pool = getPool();
        const userBalRes = await pool.query(
            'SELECT balance FROM user_balances WHERE guild_id = $1 AND user_id = $2',
            [guildId, targetUserId]
        );
        const currentBalance = parseInt(userBalRes.rows[0]?.balance || 0);
        const totalCount = visibleItems.reduce((sum, i) => sum + (parseInt(i.quantity) || 1), 0);

        const embed = new EmbedBuilder()
            .setTitle(safeTruncate(`🎒 Managing Inventory: ${targetMember.displayName}`, 256))
            .setColor(0x2ECC71)
            .setDescription(`${COIN_EMOJI} **Balance:** ${currentBalance.toLocaleString()}   📦 **Total Items:** ${totalCount}`);

        const categoryCounts = {};
        let otherCount = 0;
        for (const item of standardItems) {
            const itemQty = parseInt(item.quantity) || 1;
            if (item.category_id) {
                categoryCounts[item.category_id] = (categoryCounts[item.category_id] || 0) + itemQty;
            } else {
                otherCount += itemQty;
            }
        }

        const validCategories = categories.filter(c => categoryCounts[c.id] > 0);
        const buttons = validCategories.map(c => 
            new ButtonBuilder()
                .setCustomId(`admin_user_icat_${targetUserId}_${c.id}`)
                .setLabel(c.name)
                .setStyle(ButtonStyle.Secondary)
        );

        if (otherCount > 0) {
            buttons.push(
                new ButtonBuilder()
                    .setCustomId(`admin_user_icat_${targetUserId}_null`)
                    .setLabel('Other')
                    .setStyle(ButtonStyle.Secondary)
            );
        }

        if (lootBoxCount > 0) {
            const { getLootBoxCategoryName, getLootBoxCategoryEmoji } = await import('../economy/lootbox.js');
            const lootBoxCatName = await getLootBoxCategoryName(guildId);
            const lootBoxEmoji = await getLootBoxCategoryEmoji(guildId);
            buttons.push(
                new ButtonBuilder()
                    .setCustomId(`admin_user_icat_${targetUserId}_lootboxes`)
                    .setLabel(lootBoxCatName)
                    .setEmoji(lootBoxEmoji)
                    .setStyle(ButtonStyle.Secondary)
            );
        }

        const backRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`admin_user_dash_${targetUserId}`)
                .setLabel('Back')
                .setEmoji('⬅️')
                .setStyle(ButtonStyle.Secondary)
        );

        const rows = [];
        if (buttons.length > 0) {
            for (let i = 0; i < buttons.length; i += 4) {
                rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 4)));
            }
        }
        rows.push(backRow);

        const responseMethod = interaction.deferred || interaction.replied ? 'editReply' : (interaction.isButton() || interaction.isAnySelectMenu() ? 'update' : 'editReply');
        await interaction[responseMethod]({ embeds: [embed], components: rows });
    } else {
        // Show items in specific category or loot boxes
        let items;
        let catName;

        if (isLootBox) {
            items = lootBoxItems;
            const { getLootBoxCategoryName } = await import('../economy/lootbox.js');
            catName = await getLootBoxCategoryName(guildId);
            items.sort((a, b) => (parseInt(a.loot_box_id) || a.id) - (parseInt(b.loot_box_id) || b.id));
        } else {
            items = standardItems.filter(i => isOther ? i.category_id === null : i.category_id === catId);
            catName = isOther ? 'Other' : (categories.find(c => c.id === catId)?.name || 'Items');
            items = await sortItemsByRolePosition(items, interaction.guild);
        }

        const listLines = isLootBox
            ? items.map(i => {
                const qty = parseInt(i.quantity) || 1;
                const baseName = (i.name && i.name.trim().length > 0) ? i.name : `Loot Box #${i.id}`;
                return `• 🎁 **${baseName}** (x${qty})`;
              })
            : items.map(i => formatInventoryItemLine(i));

        const embed = new EmbedBuilder()
            .setTitle(safeTruncate(`📂 ${catName}: ${targetMember.displayName}`, 256))
            .setColor(0x2ECC71)
            .setDescription(listLines.length > 0 ? listLines.slice(0, 20).join('\n') + (listLines.length > 20 ? `\n...and ${listLines.length - 20} more` : '') : 'No items found in this category.');

        const rows = [];
        if (items.length > 0) {
            const { selectMenu } = buildPaginatedSelectMenu({
                items,
                page,
                customId: `admin_user_isel_${targetUserId}_${categoryId}`,
                placeholder: isLootBox ? 'Select a Loot Box to Manage' : 'Select an Item to Manage',
                backOption: { label: 'Back', value: 'back_to_categories', emoji: '⬅️' },
                pageNavPrefix: 'admin_page_',
                pageSize: 20,
                mapOption: (i, idx) => {
                    const isAdminIdentified = i.source === 'SYNC';
                    const isTemp = !!(i.expires_at || 
                                   (i.duration_seconds && i.duration_seconds > 0) || 
                                   (i.duration_hours && i.duration_hours > 0));
                    let statusEmoji = isLootBox ? '🎁' : (isAdminIdentified ? '🛡️' : (isTemp ? (i.is_active ? '✅' : '⬜') : (i.is_active ? '✅' : '⬜')));
                    let statusText = isLootBox ? 'Unopened Loot Box' : (isAdminIdentified ? 'Admin Granted' : (isTemp ? (i.is_active ? 'Active' : 'Inactive') : (i.is_active ? 'Equipped' : 'Unequipped')));
                    const itemQty = parseInt(i.quantity) || 1;
                    const qtyBadge = !isAdminIdentified ? ` (x${itemQty})` : '';
                    const baseName = (i.name && i.name.trim().length > 0) ? i.name.slice(0, 70) : (isLootBox ? `Loot Box #${i.id}` : `Item #${i.id}`);
                    return {
                        label: `${baseName}${qtyBadge}`,
                        value: `${i.id}_${idx}`,
                        description: statusText,
                        emoji: statusEmoji
                    };
                }
            });

            rows.push(new ActionRowBuilder().addComponents(selectMenu));
        } else {
            rows.push(new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`admin_user_items_${targetUserId}`)
                    .setLabel('Back')
                    .setEmoji('⬅️')
                    .setStyle(ButtonStyle.Secondary)
            ));
        }

        const responseMethod = interaction.deferred || interaction.replied ? 'editReply' : (interaction.isButton() || interaction.isAnySelectMenu() ? 'update' : 'editReply');
        await interaction[responseMethod]({ embeds: [embed], components: rows });
    }
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
                `**${getUserLogName(interaction.member)}** set **${item.name}** quantity to 0 (revoked ${oldQty} copy/copies) for <@${targetUserId}>.`);
        } else {
            // Update quantity
            await client.query('UPDATE user_inventory SET quantity = $1 WHERE id = $2', [newQty, invId]);

            sysLog('Admin Item Quantity Set', { user: interaction.user.id, guild: guildId, detail: `Changed ${item.name} quantity from ${oldQty} to ${newQty} for ${targetUserId}` });
            sendLog(interaction.guild, 'inventory', 'blue', '⚙️ Item Quantity Updated (Admin)',
                `**${getUserLogName(interaction.member)}** changed **${item.name}** quantity from ${oldQty} to **${newQty}** for <@${targetUserId}>.`);
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
            `**Target:** \`${targetLogName}\`\n` +
            `**Item:** \`${itemLabel}\`\n` +
            `**Admin:** \`${adminLogName}\`\n` +
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

    const result = await pool.query(
        `SELECT * FROM transactions 
         WHERE guild_id = $1 AND user_id = $2 
         ORDER BY created_at DESC 
         LIMIT $3 OFFSET $4`,
        [interaction.guildId, targetUserId, LIMIT, offset]
    );

    const targetMember = await interaction.guild.members.fetch(targetUserId).catch(() => null);
    const displayName = targetMember ? targetMember.displayName : targetUserId;

    const embed = new EmbedBuilder()
        .setTitle(safeTruncate(`📜 History: ${displayName}`, 256))
        .setColor(0x808080)
        .setFooter({ text: `Page ${page + 1}` });

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
            .setDisabled(result.rowCount < LIMIT)
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
        // Runtime guard: verify Administrator permission in THIS guild
        if (!interaction.member?.permissions.has('Administrator')) {
            const deny = { content: '⛔ Administrator permission required.', flags: 64 };
            if (interaction.deferred || interaction.replied) return interaction.followUp(deny);
            return interaction.reply(deny);
        }

        const customId = interaction.customId;

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

        const parts = customId.split('_');
        const action = parts[2];
        const targetUserId = parts[3];

        switch (action) {
            case 'dash':
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
                await showUserItems(interaction, targetUserId);
                break;
            case 'history':
                await showUserHistory(interaction, targetUserId);
                break;
            case 'icat': {
                const catId = parts[4];
                await showUserItems(interaction, targetUserId, catId);
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
                if (!subAction) {
                    await showAntiCheatDashboard(interaction);
                } else if (subAction === 'age') {
                    await handleToggleAntiCheat(interaction, 'age');
                } else if (subAction === 'join') {
                    await handleToggleAntiCheat(interaction, 'join');
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
 * Show the anti-cheat settings dashboard
 */
export async function showAntiCheatDashboard(interaction) {
    const { getGuildConfig } = await import('../storage/config.js');
    const guildId = interaction.guildId;
    const config = await getGuildConfig(guildId) || {};
    
    // Default to false (Disabled) as per user request
    const ageGate = config.anti_cheat_account_age_gate ?? false;
    const joinGate = config.anti_cheat_join_date_gate ?? false;
    
    const embed = new EmbedBuilder()
        .setTitle('🛡️ Anti-Cheat')
        .addFields(
            {
                name: '📅 Account Age Gate',
                value: 'Requires a (30-day) old Discord account to trade.',
                inline: false
            },
            {
                name: '⏳ Join Date Gate',
                value: 'Requires (7-days) of server membership to trade.',
                inline: false
            }
        )
        .setColor(0x3498DB);

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('admin_user_anticheat_age')
            .setLabel(`Account Age Gate: ${ageGate ? 'ON' : 'OFF'}`)
            .setEmoji(ageGate ? '🟢' : '🔴')
            .setStyle(ageGate ? ButtonStyle.Success : ButtonStyle.Danger)
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('admin_user_anticheat_join')
            .setLabel(`Join Date Gate: ${joinGate ? 'ON' : 'OFF'}`)
            .setEmoji(joinGate ? '🟢' : '🔴')
            .setStyle(joinGate ? ButtonStyle.Success : ButtonStyle.Danger)
    );

    const row3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('admin_user_anticheat_back')
            .setLabel('Back')
            .setEmoji('◀️')
            .setStyle(ButtonStyle.Secondary)
    );

    const responseMethod = interaction.isButton() || interaction.isAnySelectMenu() ? 'update' : 'editReply';
    await interaction[responseMethod]({
        embeds: [embed],
        components: [row1, row2, row3]
    });
}

/**
 * Handle toggle action for anti-cheat gates
 */
export async function handleToggleAntiCheat(interaction, gateType) {
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
    
    await showAntiCheatDashboard(interaction);
}

