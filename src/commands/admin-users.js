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
import { getShopCategories, getUserInventory, syncInventoryWithDiscord, getSynthesizedInventory } from '../economy/shop.js';
import { sendLog, sysLog, sysError } from '../utils/logger.js';
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

        // Fetch synthesized inventory to get accurate item count (summing quantities)
        const inventory = await getSynthesizedInventory(targetUserId, guildId, targetMember);
        const activeItems = inventory.filter(i => !(i.item_type === 'pack' || i.is_pack));
        const itemCount = activeItems.reduce((sum, i) => sum + (parseInt(i.quantity) || 1), 0);

        sysLog('Interaction Audit', { user: interaction.user.id, guild: guildId, detail: `Building management UI for ${targetUserId}` });

        const embed = new EmbedBuilder()
            .setTitle(safeTruncate(`⚙️ Managing: ${displayName}`, 256))
            .setDescription(`Balance: **${balance.toLocaleString()}** ${COIN_EMOJI} ｜ Streak: **${streak}** 🔥 ｜ Items: **${itemCount}**`)
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
 * Show user inventory (items)
 */
export async function showUserItems(interaction, targetUserId, categoryId = null) {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
    const guildId = interaction.guildId;
    const isOther = categoryId === 'null';
    const catId = isOther ? null : (categoryId ? parseInt(categoryId) : null);

    const targetMember = await interaction.guild.members.fetch(targetUserId).catch(() => null);
    if (!targetMember) return interaction.followUp({ content: '❌ Member not found.', flags: MessageFlags.Ephemeral });

    // Sync and fetch inventory for target user (including synthesized admin items)
    const inventory = await getSynthesizedInventory(targetUserId, guildId, targetMember);
    const categories = await getShopCategories(guildId);

    // List of visible items (no packs)
    const visibleItems = inventory.filter(i => !(i.item_type === 'pack' || i.is_pack));

    if (categoryId === null) {
        // Show category selection view
        const [userBal] = await Promise.all([
            getUserBalance(guildId, targetUserId)
        ]);
        const currentBalance = parseInt(userBal?.balance || 0);
        const totalCount = visibleItems.reduce((sum, i) => sum + (parseInt(i.quantity) || 1), 0);

        const embed = new EmbedBuilder()
            .setTitle(safeTruncate(`🎒 Managing Inventory: ${targetMember.displayName}`, 256))
            .setColor(0x2ECC71)
            .setDescription(`${COIN_EMOJI} **Balance:** ${currentBalance.toLocaleString()}   📦 **Total Items:** ${totalCount}\n\nSelect a category to view and revoke items.`);

        const categoryCounts = {};
        let otherCount = 0;
        for (const item of visibleItems) {
            const itemQty = parseInt(item.quantity) || 1;
            if (item.category_id) {
                categoryCounts[item.category_id] = (categoryCounts[item.category_id] || 0) + itemQty;
            } else {
                otherCount += itemQty;
            }
        }

        const validCategories = categories.filter(c => categoryCounts[c.id] > 0);
        const buttons = validCategories.slice(0, 4).map(c => 
            new ButtonBuilder()
                .setCustomId(`admin_user_icat_${targetUserId}_${c.id}`)
                .setLabel(c.name)
                .setStyle(ButtonStyle.Primary)
        );

        if (otherCount > 0) {
            buttons.push(
                new ButtonBuilder()
                    .setCustomId(`admin_user_icat_${targetUserId}_null`)
                    .setLabel('Other')
                    .setStyle(ButtonStyle.Primary)
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
        if (buttons.length > 0) rows.push(new ActionRowBuilder().addComponents(buttons));
        rows.push(backRow);

        const responseMethod = interaction.deferred || interaction.replied ? 'editReply' : (interaction.isButton() || interaction.isAnySelectMenu() ? 'update' : 'editReply');
        await interaction[responseMethod]({ embeds: [embed], components: rows });
    } else {
        // Show items in specific category
        let items = visibleItems.filter(i => isOther ? i.category_id === null : i.category_id === catId);
        
        // Standardize: Sort by role position (match user view)
        items = await sortItemsByRolePosition(items, interaction.guild);

        let catName = isOther ? 'Other' : (categories.find(c => c.id === catId)?.name || 'Items');
        const listLines = items.map(i => formatInventoryItemLine(i));

        const embed = new EmbedBuilder()
            .setTitle(safeTruncate(`📂 ${catName}: ${targetMember.displayName}`, 256))
            .setColor(0x2ECC71)
            .setDescription(listLines.length > 0 ? listLines.slice(0, 20).join('\n') + (listLines.length > 20 ? `\n...and ${listLines.length - 20} more` : '') : 'No items found in this category.');

        const rows = [];
        if (items.length > 0) {
            const selectOptions = [
                {
                    label: 'Back',
                    value: 'back_to_categories',
                    emoji: '⬅️'
                },
                ...items.slice(0, 24).map((i, idx) => {
                    const isAdminIdentified = i.source === 'SYNC';
                    const isTemp = !!(i.expires_at || 
                                   (i.duration_seconds && i.duration_seconds > 0) || 
                                   (i.duration_hours && i.duration_hours > 0));
                    
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
                    const qtyBadge = (!isAdminIdentified && itemQty > 1) ? ` (x${itemQty})` : '';
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
                .setCustomId(`admin_user_isel_${targetUserId}_${categoryId}`)
                .setPlaceholder('Select an Item to Manage')
                .addOptions(selectOptions);

            rows.push(new ActionRowBuilder().addComponents(select));
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
 * Handle single item management (Revoke view)
 */
export async function showItemRevokePanel(interaction, targetUserId, invId, categoryId) {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
    const guildId = interaction.guildId;
    const isOther = categoryId === 'null';
    const catId = isOther ? null : (categoryId ? parseInt(categoryId) : null);

    const targetMember = await interaction.guild.members.fetch(targetUserId).catch(() => null);
    if (!targetMember) return interaction.followUp({ content: '❌ Member not found.', flags: MessageFlags.Ephemeral });

    const inventory = await getSynthesizedInventory(targetUserId, guildId, targetMember);
    const visibleItems = inventory.filter(i => !(i.item_type === 'pack' || i.is_pack));
    let items = visibleItems.filter(i => isOther ? i.category_id === null : i.category_id === catId);
    items = await sortItemsByRolePosition(items, interaction.guild);

    const item = items.find(i => String(i.id) === String(invId)) || items[0];
    if (!item) {
        return showUserItems(interaction, targetUserId, categoryId);
    }

    const isAdminGranted = item.source === 'SYNC' || String(item.id).startsWith('admin_');
    const firstRoleId = item.role_id ? item.role_id.split(/[,\s]+/)[0] : null;
    const displayQty = parseInt(item.quantity) || 1;
    const isTemp = !!(item.expires_at || (item.duration_seconds && item.duration_seconds > 0) || (item.duration_hours && item.duration_hours > 0));

    const RARITY_DISPLAY = {
      common: '⚪ Common',
      uncommon: '🟢 Uncommon',
      rare: '🔵 Rare',
      epic: '🟣 Epic',
      legendary: '🟡 Legendary'
    };
    const rarityText = RARITY_DISPLAY[item.rarity] || '⚪ Common';

    let desc = `**Item:** ${firstRoleId ? `<@&${firstRoleId}>` : item.name}`;
    desc += `\n**Quantity:** ${displayQty}`;
    desc += `\n**Rarity:** ${rarityText}`;

    if (isAdminGranted) {
      const joinDate = targetMember.joinedAt || new Date();
      desc += `\n**Acquired:** <t:${Math.floor(joinDate.getTime() / 1000)}:D>`;
      desc += `\n**Status:** 🛡️ Admin Granted`;
      desc += `\n\n*This item was granted directly via Discord roles. To remove it, manage the member's Discord roles directly.*`;
    } else {
      const purchasedAt = item.purchased_at ? new Date(item.purchased_at) : new Date();
      desc += `\n**Acquired:** <t:${Math.floor(purchasedAt.getTime() / 1000)}:D>`;
      if (isTemp) {
        desc += `\n**Status:** ${item.is_active ? '✅ Active' : '⏸️ Inactive'}`;
      } else {
        desc += `\n**Status:** ${item.is_active ? '✅ Equipped' : '⚪ Unequipped'}`;
      }
    }

    let embedColor = '#3498DB';
    if (firstRoleId) {
      const role = interaction.guild.roles.cache.get(firstRoleId);
      if (role && role.color) embedColor = role.hexColor;
    }

    const embed = new EmbedBuilder()
        .setTitle(safeTruncate(`Manage: ${item.name}`, 256))
        .setColor(embedColor)
        .setDescription(desc);

    const itemImg = getItemImage(item);
    if (itemImg) embed.setThumbnail(itemImg);

    const actionRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`admin_user_revoke_${targetUserId}_${item.id}_${categoryId}`)
            .setLabel('Revoke')
            .setEmoji('🗑️')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(isAdminGranted)
    );

    const selectOptions = [
        {
            label: 'Back',
            value: 'back_to_categories',
            emoji: '⬅️'
        },
        ...items.slice(0, 24).map((i, idx) => {
            const isItemTemp = !!(i.expires_at || 
                           (i.duration_seconds && i.duration_seconds > 0) || 
                           (i.duration_hours && i.duration_hours > 0));
            const isAdminIdent = i.source === 'SYNC';

            let statusEmoji = '⬜';
            let statusText = 'Unknown';

            if (isAdminIdent) {
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
            const qtyBadge = (!isAdminIdent && itemQty > 1) ? ` (x${itemQty})` : '';
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
        .setCustomId(`admin_user_isel_${targetUserId}_${categoryId}`)
        .setPlaceholder('Select an Item to Manage')
        .addOptions(selectOptions);

    const selectRow = new ActionRowBuilder().addComponents(itemSelect);

    const responseMethod = interaction.deferred || interaction.replied ? 'editReply' : 'update';
    await interaction[responseMethod]({ embeds: [embed], components: [actionRow, selectRow] });
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
                const lastUnderscore = selectedVal.lastIndexOf('_');
                const invId = (lastUnderscore !== -1) ? selectedVal.slice(0, lastUnderscore) : selectedVal;
                await showItemRevokePanel(interaction, targetUserId, invId, catId);
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

