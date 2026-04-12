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
import { sanitizeError, getUserDisplayName, getUserLogName, sortItemsByRolePosition, formatInventoryItemLine } from '../shared.js';
import { getShopCategories, getUserInventory, syncInventoryWithDiscord, getSynthesizedInventory } from '../economy/shop.js';
import { sendLog } from '../utils/logger.js';

const COIN_EMOJI = '<:OK_COIN:1490666813501997076>';

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

    const backRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('settings_back')
            .setLabel('Back to Settings')
            .setEmoji('⬅️')
            .setStyle(ButtonStyle.Secondary)
    );

    const responseMethod = interaction.isButton() || interaction.isAnySelectMenu() ? 'update' : 'editReply';
    await interaction[responseMethod]({
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(select), backRow]
    });
}

/**
 * Main Management Dashboard for a specific user
 */
export async function showUserDashboard(interaction, targetUserId) {
    const guildId = interaction.guildId;
    const guildName = interaction.guild?.name || 'Unknown Server';
    const pool = getPool();

    const targetMember = await interaction.guild.members.fetch(targetUserId).catch(() => null);
    const displayName = targetMember ? targetMember.displayName : targetUserId;
    const userTag = targetMember ? targetMember.user.username : 'Unknown';

    console.log(`[${guildName}] [Settings] Opening dashboard for ${displayName} (${userTag})`);
    
    // Defer as early as possible if not already
    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate().catch(() => {});
    }

    try {
        // Fetch user basic data
        let userResult = await pool.query(
            'SELECT balance FROM user_balances WHERE guild_id = $1 AND user_id = $2',
            [guildId, targetUserId]
        );

        if (userResult.rowCount === 0) {
            console.log(`[${guildName}] [Database] No balance record for ${displayName}, creating first-time entry.`);
            // Create entry if missing
            userResult = await pool.query(
                'INSERT INTO user_balances (guild_id, user_id, balance) VALUES ($1, $2, 0) RETURNING balance',
                [guildId, targetUserId]
            );
        }

        const balance = parseInt(userResult.rows[0].balance);

        // Fetch synthesized inventory to get accurate item count
        const inventory = await getSynthesizedInventory(targetUserId, guildId, targetMember);
        const itemCount = inventory.filter(i => !(i.item_type === 'pack' || i.is_pack)).length;

        console.log(`[${guildName}] [Economy] Fetched data for ${displayName}: balance=${balance.toLocaleString()}, items=${itemCount}`);
        console.log(`[${guildName}] [Settings] Building UI for ${displayName} (${userTag})`);

        const embed = new EmbedBuilder()
            .setTitle(`⚙️ Managing: ${displayName} (@${userTag})`)
            .setDescription(`> Balance: **${balance.toLocaleString()}** ${COIN_EMOJI} | Items: **${itemCount}**`)
            .setColor(0x5865F2);

        const actionRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`admin_user_balance_${targetUserId}`)
                .setLabel('Balance')
                .setEmoji('💰')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`admin_user_items_${targetUserId}`)
                .setLabel('Items')
                .setEmoji('🎒')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`admin_user_history_${targetUserId}`)
                .setLabel('History')
                .setEmoji('📜')
                .setStyle(ButtonStyle.Primary)
        );

        const backRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('settings_back')
                .setLabel('Back to Settings')
                .setEmoji('⬅️')
                .setStyle(ButtonStyle.Secondary)
        );

    const responseMethod = interaction.deferred || interaction.replied ? 'editReply' : (interaction.isButton() || interaction.isAnySelectMenu() ? 'update' : 'editReply');
    console.log(`[${guildName}] [Settings] Sending response via ${responseMethod}`);
    await interaction[responseMethod]({
        embeds: [embed],
        components: [actionRow, backRow]
    });
    } catch (err) {
        console.error(`[${guildName}] [Error] Failed to show dashboard for ${displayName}:`, err.message);
        throw err; // Propagate to handler
    }
}

/**
 * Handle balance adjustment modal
 */
export async function handleBalanceAction(interaction, targetUserId) {
    const targetMember = await interaction.guild.members.fetch(targetUserId).catch(() => null);
    const displayName = targetMember ? targetMember.displayName : targetUserId;

    const modal = new ModalBuilder()
        .setCustomId(`admin_user_balmod_${targetUserId}`)
        .setTitle(`Adjust Balance: ${displayName}`);

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
    const targetUserId = interaction.customId.split('_').pop();
    const newBalance = parseInt(interaction.fields.getTextInputValue('new_balance'));

    if (isNaN(newBalance) || newBalance < 0) {
        return interaction.reply({ content: '❌ Invalid balance. Please enter a positive number.', flags: MessageFlags.Ephemeral });
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
            sendLog(interaction.guild, 'audit', 'orange', '🎁 Rewards Claimed',
                `**Target:** \`${targetLogName}\`\n` +
                `**Amount:** \`+${delta.toLocaleString()}\` ${COIN_EMOJI}\n` +
                `**Admin:** \`${adminLogName}\` (via User Settings)`
            );
        } else {
            sendLog(interaction.guild, 'audit', 'red', '⚖️ Balance Adjusted',
                `**Target:** \`${targetLogName}\`\n` +
                `**Reduction:** \`${delta.toLocaleString()}\` ${COIN_EMOJI}\n` +
                `**Admin:** \`${adminLogName}\` (via User Settings)`
            );
        }

        await interaction.deferUpdate();
        await showUserDashboard(interaction, targetUserId);
    } catch (error) {
        console.error('Balance adjust error:', error);
        await interaction.reply({ content: '❌ Failed to update balance.', flags: MessageFlags.Ephemeral });
    }
}

/**
 * Show user inventory (items)
 */
export async function showUserItems(interaction, targetUserId, categoryId = null) {
    const guildId = interaction.guildId;
    const isOther = categoryId === 'null';
    const catId = isOther ? null : (categoryId ? parseInt(categoryId) : null);

    const targetMember = await interaction.guild.members.fetch(targetUserId).catch(() => null);
    if (!targetMember) return interaction.reply({ content: '❌ Member not found.', flags: MessageFlags.Ephemeral });

    // Sync and fetch inventory for target user (including synthesized admin items)
    const inventory = await getSynthesizedInventory(targetUserId, guildId, targetMember);
    const categories = await getShopCategories(guildId);

    // List of visible items (no packs)
    const visibleItems = inventory.filter(i => !(i.item_type === 'pack' || i.is_pack));

    if (categoryId === null) {
        // Show category selection view
        const embed = new EmbedBuilder()
            .setTitle(`🎒 Managing Inventory: ${targetMember.displayName}`)
            .setColor(0x2ECC71);

        if (visibleItems.length === 0) {
            embed.setDescription('This user has no items in their inventory.');
        } else {
            embed.setDescription('Select a category to view and revoke items.');
        }

        const categoryCounts = {};
        let otherCount = 0;
        for (const item of visibleItems) {
            if (item.category_id) {
                categoryCounts[item.category_id] = (categoryCounts[item.category_id] || 0) + 1;
            } else {
                otherCount++;
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

        const responseMethod = interaction.deferred || interaction.replied ? 'editReply' : 'update';
        await interaction[responseMethod]({ embeds: [embed], components: rows });
    } else {
        // Show items in specific category
        let items = visibleItems.filter(i => isOther ? i.category_id === null : i.category_id === catId);
        
        // Standardize: Sort by role position (match user view)
        items = await sortItemsByRolePosition(items, interaction.guild);

        let catName = isOther ? 'Other' : (categories.find(c => c.id === catId)?.name || 'Items');
        const embed = new EmbedBuilder()
            .setTitle(`📂 ${catName}: ${targetMember.displayName}`)
            .setColor(0x2ECC71);

        // Standardize: Use shared formatting (removes bullets, matches emojis)
        const listLines = items.map(i => formatInventoryItemLine(i));
        embed.setDescription(listLines.length > 0 ? listLines.join('\n') : 'No items found in this category.');

        const rows = [];
        if (items.length > 0) {
            const select = new StringSelectMenuBuilder()
                .setCustomId(`admin_user_isel_${targetUserId}_${categoryId}`)
                .setPlaceholder('Select an Item to Manage')
                .addOptions(items.slice(0, 25).map((i, idx) => {
                    const isAdminIdentified = i.source === 'SYNC';
                    const isTemp = !!(i.expires_at || 
                                   (i.duration_seconds && i.duration_seconds > 0) || 
                                   (i.duration_hours && i.duration_hours > 0));
                    
                    let statusEmoji = '🔳';
                    let statusText = 'Unknown';

                    if (isAdminIdentified) {
                        statusEmoji = '🛡️';
                        statusText = 'Granted by admin';
                    } else if (isTemp) {
                        statusEmoji = i.is_active ? '✅' : '🔳';
                        statusText = i.is_active ? 'Active' : 'Inactive';
                    } else {
                        statusEmoji = i.is_active ? '✅' : '🔳';
                        statusText = i.is_active ? 'Equipped' : 'Unequipped';
                    }

                    return {
                        label: i.name,
                        value: `${i.id}_${idx}`,
                        description: statusText,
                        emoji: statusEmoji
                    };
                }));
            rows.push(new ActionRowBuilder().addComponents(select));
        }

        const backRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`admin_user_items_${targetUserId}`)
                .setLabel('Back')
                .setEmoji('⬅️')
                .setStyle(ButtonStyle.Secondary)
        );

        const responseMethod = interaction.deferred || interaction.replied ? 'editReply' : 'update';
        await interaction[responseMethod]({ embeds: [embed], components: [...rows, backRow] });
    }
}

/**
 * Handle single item management (Revoke view)
 */
export async function showItemRevokePanel(interaction, targetUserId, invId, categoryId) {
    const pool = getPool();
    const isAdminGranted = invId.toString().startsWith('admin_');

    let item;
    if (isAdminGranted) {
        // Synthesized item: fetch directly from shop_items
        const shopItemId = invId.replace('admin_', '');
        const res = await pool.query('SELECT * FROM shop_items WHERE id = $1', [shopItemId]);
        if (res.rowCount === 0) return interaction.reply({ content: '❌ Shop item not found.', flags: MessageFlags.Ephemeral });
        item = res.rows[0];
    } else {
        // Standard item: fetch from inventory
        const result = await pool.query(
            `SELECT i.*, s.name, s.role_id 
             FROM user_inventory i 
             JOIN shop_items s ON i.shop_item_id = s.id 
             WHERE i.id = $1`, 
            [invId]
        );

        if (result.rowCount === 0) return interaction.reply({ content: '❌ Item not found.', flags: MessageFlags.Ephemeral });
        item = result.rows[0];
    }

    const targetMember = await interaction.guild.members.fetch(targetUserId).catch(() => null);
    const displayName = targetMember ? targetMember.displayName : targetUserId;

    const embed = new EmbedBuilder()
        .setTitle(`Revoke Item: ${item.name}`)
        .setDescription(
            isAdminGranted 
            ? `This is an **Admin-Granted** item (Discord Role).\n\n` +
              `The bot cannot "Revoke" this because it was not purchased through the economy system. It is a direct Discord role granted by an administrator.\n\n` +
              `To remove it, you must remove the role from the user manually in their Discord profile.`
            : `Are you sure you want to permanently revoke this item from **${displayName}**?\n\n` +
              `⚠️ **This will:**\n` +
              `• Delete the item from their database inventory\n` +
              `• Remove the Discord role(s) from the user\n` +
              `• NOT provide a refund\n\n` +
              `The user must buy it again to get it back.`
        )
        .setColor(isAdminGranted ? 0x808080 : 0xED4245);

    const actionRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`admin_user_revoke_${targetUserId}_${invId}_${categoryId}`)
            .setLabel('Permanently Revoke')
            .setEmoji('🗑️')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(isAdminGranted)
    );

    const backRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`admin_user_icat_${targetUserId}_${categoryId}`)
            .setLabel('Back')
            .setEmoji('⬅️')
            .setStyle(ButtonStyle.Secondary)
    );

    await interaction.update({ embeds: [embed], components: [actionRow, backRow] });
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

        // 2. Log in user history
        const adminName = getUserDisplayName(interaction.member);
        const targetMember = await interaction.guild.members.fetch(targetUserId).catch(() => null);
        const targetName = targetMember ? targetMember.displayName : targetUserId;

        if (targetMember && item.role_id) {
            const roles = item.role_id.split(/[,\s]+/);
            for (const rid of roles) {
                try {
                    await targetMember.roles.remove(rid);
                } catch (roleErr) {
                    console.warn(`[Error] Failed to remove role ${rid} from ${targetName}:`, roleErr.message);
                }
            }
        }

        // Discord Log
        const adminLogName = getUserLogName(interaction);
        const targetLogName = targetMember ? getUserLogName(targetMember) : targetUserId;

        sendLog(interaction.guild, 'inventory', 'crimson', '🗑️ Item Revoked',
            `**Target:** \`${targetLogName}\`\n` +
            `**Item:** \`${item.name}\`\n` +
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
        console.error('Revoke error:', error);
        
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
        .setTitle(`📜 History: ${displayName}`)
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

            let description = tx.description.replace(/(?<!<@)(?<!<@&)(\d{17,19})(?!>)/g, '<@$1>');
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

    await interaction.update({ embeds: [embed], components: [navRow, backRow] });
}

/**
 * Component handler for all admin user management interactions
 */
export async function handleAdminUserComponent(interaction) {
    try {
        const customId = interaction.customId;

        if (customId === 'admin_user_select') {
            const targetUserId = interaction.values[0];
            await showUserDashboard(interaction, targetUserId);
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
                const partsValue = interaction.values[0].split('_');
                // Handle cases where ID contains underscores (like admin_123)
                // The last part is the index (from getSynthesizedInventory indexing in display)
                partsValue.pop(); 
                const invId = partsValue.join('_');
                const catId = parts[4];
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
        }
    } catch (error) {
        console.error(`[Error] in handleAdminUserComponent:`, error.message);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: `❌ Error: ${error.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
        } else {
            await interaction.followUp({ content: `❌ Error: ${error.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
        }
    }
}
