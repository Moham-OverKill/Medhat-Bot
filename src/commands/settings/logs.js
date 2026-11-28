import {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    ChannelSelectMenuBuilder,
    ChannelType,
    MessageFlags
} from 'discord.js';
import { getGuildConfig, setGuildConfig } from '../../storage/config.js';
import { sendLog, sysLog, checkChannelPermissions, sysError } from '../../utils/logger.js';
import { getUserLogName, isBackDisabled } from '../../shared.js';
import { handleInteractionError } from '../../utils/errors.js';

export const LOG_CATEGORIES = {
    economy: {
        id: 'economy',
        name: 'Economy',
        emoji: '📈',
        dbId: 'log_eco_channel_id',
        desc: 'Logs balance transfers, claims, and rewards'
    },
    inventory: {
        id: 'inventory',
        name: 'Inventory',
        emoji: '🎒',
        dbId: 'log_inv_channel_id',
        desc: 'Logs item usage, crafting, and trades'
    },
    shop: {
        id: 'shop',
        name: 'Shop',
        emoji: '🛒',
        dbId: 'log_shop_channel_id',
        desc: 'Logs shop purchases and reward item openings'
    },
    audit: {
        id: 'audit',
        name: 'Audit',
        emoji: '🛡️',
        dbId: 'log_audit_channel_id',
        desc: 'Logs administrative and security events'
    }
};

/**
 * Main Logs Settings Panel
 * 4 category select menus with 3 options each + single Back button
 */
export async function handleLogsSettings(interaction, selectedId = null, configOverride = null, warningMessage = null) {
    try {
        const guildId = interaction.guildId;
        let config = configOverride || (await getGuildConfig(guildId)) || {};

        // Verify uncached configured log channels so offline-deleted channels auto-disable cleanly
        if (interaction.guild?.channels && !configOverride) {
            const uncachedCats = Object.values(LOG_CATEGORIES).filter(cat => {
                const chanId = config[cat.dbId];
                return chanId && !interaction.guild.channels.cache?.get?.(chanId);
            });
            if (uncachedCats.length > 0 && typeof interaction.guild.channels.fetch === 'function') {
                if (!interaction.deferred && !interaction.replied && (interaction.isButton?.() || interaction.isAnySelectMenu?.()) && typeof interaction.deferUpdate === 'function') {
                    await interaction.deferUpdate().catch(() => {});
                }
                const staleUpdates = {};
                await Promise.all(uncachedCats.map(async (cat) => {
                    const chanId = config[cat.dbId];
                    try {
                        const fetched = await interaction.guild.channels.fetch(chanId);
                        if (!fetched || (typeof fetched.isTextBased === 'function' && !fetched.isTextBased())) {
                            staleUpdates[cat.dbId] = null;
                        }
                    } catch (err) {
                        if (err?.code === 10003 || err?.status === 404) {
                            staleUpdates[cat.dbId] = null;
                        }
                    }
                }));
                if (Object.keys(staleUpdates).length > 0) {
                    config = (await setGuildConfig(guildId, staleUpdates)) || { ...config, ...staleUpdates };
                }
            }
        }

        let desc = '';
        if (warningMessage) {
            desc += `⚠️ **Notice:** ${warningMessage}\n\n`;
        }

        for (const cat of Object.values(LOG_CATEGORIES)) {
            const chanId = config[cat.dbId];
            let statusLabel = '*Disabled*';
            if (chanId) {
                const targetChan = interaction.guild?.channels?.cache?.get?.(chanId);
                if (targetChan) {
                    const perm = checkChannelPermissions(targetChan);
                    if (!perm.valid) {
                        statusLabel = `<#${chanId}> ⚠️ *(Missing Permissions)*`;
                    } else {
                        statusLabel = `<#${chanId}>`;
                    }
                } else {
                    statusLabel = `<#${chanId}>`;
                }
            }
            desc += `**${cat.emoji} ${cat.name}**\n↳ ${statusLabel}\n\n`;
        }

        const embed = new EmbedBuilder()
            .setTitle('Logs')
            .setDescription(desc)
            .setColor(warningMessage ? 0xE74C3C : (selectedId ? 0xF1C40F : 0x3498DB));

        const components = [];

        // If a category was clicked to "Select A Channel", show channel picker + Back
        if (selectedId && LOG_CATEGORIES[selectedId]) {
            const active = LOG_CATEGORIES[selectedId];

            // Row 1: Channel selection dropdown
            const channelSelect = new ChannelSelectMenuBuilder()
                .setCustomId(`logs_set_channel_${active.id}`)
                .setPlaceholder(`Select a channel for ${active.name}...`)
                .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
            components.push(new ActionRowBuilder().addComponents(channelSelect));

            // Row 2: Single Back button returning to 4-menu view
            const backButton = new ButtonBuilder()
                .setCustomId('settings_logs')
                .setLabel('Back')
                .setEmoji('⬅️')
                .setStyle(ButtonStyle.Secondary);
            components.push(new ActionRowBuilder().addComponents(backButton));
        } else {
            // Main View: 4 Select Menus (Rows 1-4) with 3 options each
            const nonce = Date.now();
            for (const cat of Object.values(LOG_CATEGORIES)) {
                const menu = new StringSelectMenuBuilder()
                    .setCustomId(`logs_menu_${cat.id}_${nonce}`)
                    .setPlaceholder(`${cat.emoji} ${cat.name} Logs...`)
                    .addOptions([
                        {
                            label: 'Select A Channel',
                            value: 'channel',
                            emoji: '💬'
                        },
                        {
                            label: 'Send Test Log',
                            value: 'test',
                            emoji: '🧪'
                        },
                        {
                            label: 'Disable',
                            value: 'disable',
                            emoji: '❌'
                        }
                    ]);
                components.push(new ActionRowBuilder().addComponents(menu));
            }

            // Row 5: Single Back button only
            const backButton = new ButtonBuilder()
                .setCustomId('settings_home')
                .setLabel('Back')
                .setEmoji('⬅️')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(isBackDisabled(interaction));
            components.push(new ActionRowBuilder().addComponents(backButton));
        }

        const msgData = {
            embeds: [embed],
            components,
            flags: MessageFlags.Ephemeral,
            content: '',
            files: [],
            attachments: []
        };

        if (interaction.deferred || interaction.replied) {
            await interaction.editReply(msgData);
        } else if (interaction.isButton?.() || interaction.isAnySelectMenu?.()) {
            await interaction.update(msgData);
        } else {
            await interaction.reply(msgData);
        }
    } catch (error) {
        sysError('Logs settings panel failed', error, { user: interaction.user.id, guild: interaction.guildId });
        const err = { content: '❌ Error loading log settings.', flags: MessageFlags.Ephemeral };
        if (interaction.deferred || interaction.replied) await interaction.followUp(err).catch(() => {});
        else await interaction.reply(err).catch(() => {});
    }
}

/**
 * Handle 3-Option Select Menu actions (Select A Channel, Send Test Log, Disable)
 */
export async function handleLogMenuAction(interaction) {
    try {
        const customId = interaction.customId; // logs_menu_CATEGORY or logs_menu_CATEGORY_NONCE
        const raw = customId.replace('logs_menu_', '');
        const categoryId = raw.split('_')[0];
        const action = interaction.values[0]; // channel | test | disable
        const guildId = interaction.guildId;

        const cat = LOG_CATEGORIES[categoryId];
        if (!cat) return;

        if (action === 'channel') {
            // Open Channel Selection view
            return handleLogsSettings(interaction, cat.id);
        }

        if (action === 'test') {
            if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
            const config = (await getGuildConfig(guildId)) || {};
            const chanId = config[cat.dbId];

            if (!chanId) {
                return handleLogsSettings(interaction, cat.id, config, `Please assign a channel for **${cat.name}** logs first before sending a test log.`);
            }

            let targetChan = interaction.guild?.channels?.cache?.get?.(chanId) || null;
            let channelDeleted = false;
            if (!targetChan && typeof interaction.guild?.channels?.fetch === 'function') {
                try {
                    targetChan = await interaction.guild.channels.fetch(chanId);
                    if (!targetChan || (typeof targetChan.isTextBased === 'function' && !targetChan.isTextBased())) {
                        channelDeleted = true;
                    }
                } catch (fetchErr) {
                    if (fetchErr?.code === 10003 || fetchErr?.status === 404) {
                        channelDeleted = true;
                    } else {
                        return handleLogsSettings(interaction, cat.id, config, `Could not reach <#${chanId}> right now. Please try again.`);
                    }
                }
            } else if (!targetChan) {
                channelDeleted = true;
            }

            if (channelDeleted || !targetChan) {
                const updatedConfig = (await setGuildConfig(guildId, { [cat.dbId]: null })) || { ...config, [cat.dbId]: null };
                return handleLogsSettings(interaction, cat.id, updatedConfig, `The previously configured channel for **${cat.name}** logs was deleted, so **${cat.name}** logging has been disabled. Select a new channel below.`);
            }

            const perm = checkChannelPermissions(targetChan);
            if (!perm.valid) {
                return handleLogsSettings(interaction, cat.id, config, `Cannot send test log to <#${chanId}>: ${perm.error}`);
            }

            const logName = getUserLogName(interaction);
            const testEmbed = new EmbedBuilder()
                .setTitle(`🧪 Test Log: ${cat.name}`)
                .setDescription(`Admin **${logName}** dispatched this test log entry. Logging is functioning properly.`)
                .setColor(0x3498DB)
                .setFooter({ text: `${interaction.guild.name} • ${new Date().toLocaleString()}` });

            try {
                await targetChan.send({ embeds: [testEmbed] });
            } catch (sendErr) {
                if (sendErr?.code === 10003 || sendErr?.status === 404) {
                    const updatedConfig = (await setGuildConfig(guildId, { [cat.dbId]: null })) || { ...config, [cat.dbId]: null };
                    return handleLogsSettings(interaction, cat.id, updatedConfig, `The previously configured channel for **${cat.name}** logs was deleted, so **${cat.name}** logging has been disabled. Select a new channel below.`);
                }
                if (sendErr?.code === 50001 || sendErr?.code === 50013) {
                    return handleLogsSettings(interaction, cat.id, config, `Cannot send test log to <#${chanId}>: missing permissions to send embeds there.`);
                }
                throw sendErr;
            }
            return handleLogsSettings(interaction, null, config);
        }

        if (action === 'disable') {
            if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
            const config = (await getGuildConfig(guildId)) || {};
            const oldChan = config[cat.dbId];

            if (!oldChan) {
                return handleLogsSettings(interaction);
            }

            await setGuildConfig(guildId, { [cat.dbId]: null });

            const logName = getUserLogName(interaction);
            sendLog(interaction.guild, 'audit', 'crimson', '🚫 Log Category Disabled', 
                `**Admin:** \`${logName}\`\n` +
                `**Category:** \`${cat.name}\`\n` +
                `**Action:** Disabled ${cat.name} logging.`
            );

            const updatedConfig = (await getGuildConfig(guildId)) || {};
            return handleLogsSettings(interaction, null, updatedConfig);
        }
    } catch (error) {
        sysError('Log menu action failed', error, { user: interaction.user.id, guild: interaction.guildId });
        return handleInteractionError(interaction, error, 'Log Menu Action');
    }
}

/**
 * Handle log channel assignment for specific categories
 */
export async function handleLogChannelSelect(interaction) {
    try {
        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
        const customId = interaction.customId; // logs_set_channel_CATEGORY or logs_assign_CATEGORY
        const category = customId.replace('logs_set_channel_', '').replace('logs_assign_', '');
        const cat = LOG_CATEGORIES[category];
        if (!cat) return;

        const channelId = interaction.values[0];
        const guildId = interaction.guildId;

        // Validate channel permissions
        const channel = interaction.guild.channels.cache.get(channelId) || await interaction.guild.channels.fetch(channelId).catch(() => null);
        const permissionCheck = checkChannelPermissions(channel);
        if (!permissionCheck.valid) {
            return handleLogsSettings(interaction, cat.id, null, `Cannot assign <#${channelId}>: ${permissionCheck.error}`);
        }

        // Update database and cache using setGuildConfig
        await setGuildConfig(guildId, { [cat.dbId]: channelId });

        const logName = getUserLogName(interaction);
        const guildName = interaction.guild.name;

        // Send confirmation to the NEW channel
        if (channel) {
            const confirmEmbed = new EmbedBuilder()
                .setTitle('Logging System Updated')
                .setDescription(`Admin **${logName}** has assigned this channel for **${cat.name}** logs.`)
                .setColor(0x2ECC71)
                .setFooter({ text: `${guildName} • ${new Date().toLocaleString()}` });
            
            await channel.send({ embeds: [confirmEmbed] }).catch(() => {});

            // Standard Audit Log
            sendLog(interaction.guild, 'audit', 'cyan', '⚙️ Log Settings Changed', 
                `**Admin:** \`${logName}\`\n` +
                `**Category:** \`${cat.name}\`\n` +
                `**Action:** Set log channel to ${channel}`
            );
        }

        // System Audit Log
        sysLog('Log Settings Changed', { user: interaction.user.id, guild: guildId, detail: `Category: ${category} | Channel: ${channelId}` });

        const updatedConfig = (await getGuildConfig(guildId)) || {};
        // Return back to main 4-menu view
        return handleLogsSettings(interaction, null, updatedConfig);
    } catch (error) {
        sysError('Log channel select failed', error, { user: interaction.user.id, guild: interaction.guildId });
        return handleInteractionError(interaction, error, 'Log Channel Select');
    }
}

/**
 * Handle disabling logs (single category or all)
 */
export async function handleLogDisable(interaction) {
    try {
        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
        const guildId = interaction.guildId;
        const logName = getUserLogName(interaction);
        const customId = interaction.customId;
        const target = customId.replace('logs_disable_', '');

        if (target === 'all' || target === 'btn') {
            await setGuildConfig(guildId, {
                log_eco_channel_id: null,
                log_inv_channel_id: null,
                log_shop_channel_id: null,
                log_audit_channel_id: null
            });

            sendLog(interaction.guild, 'audit', 'crimson', '🚫 Logs Disabled', 
                `**Admin:** \`${logName}\`\n` +
                `**Action:** Disabled all Discord logging categories.`
            );

            sysLog('Logs Disabled All', { user: interaction.user.id, guild: guildId });
            return handleLogsSettings(interaction);
        } else if (LOG_CATEGORIES[target]) {
            const cat = LOG_CATEGORIES[target];
            await setGuildConfig(guildId, { [cat.dbId]: null });

            sendLog(interaction.guild, 'audit', 'crimson', '🚫 Log Category Disabled', 
                `**Admin:** \`${logName}\`\n` +
                `**Category:** \`${cat.name}\`\n` +
                `**Action:** Disabled ${cat.name} logging.`
            );

            sysLog('Log Category Disabled', { user: interaction.user.id, guild: guildId, detail: `Category: ${target}` });
            const updatedConfig = (await getGuildConfig(guildId)) || {};
            return handleLogsSettings(interaction, null, updatedConfig);
        }
    } catch (error) {
        sysError('Log disable failed', error, { user: interaction.user.id, guild: interaction.guildId });
        return handleInteractionError(interaction, error, 'Log Disable');
    }
}


/**
 * Handle category selection (backward compatibility)
 */
export async function handleLogCategorySelect(interaction) {
    try {
        const selectedId = interaction.values?.[0] || null;
        return handleLogsSettings(interaction, selectedId);
    } catch (error) {
        sysError('Log category select failed', error, { user: interaction.user?.id, guild: interaction.guildId });
        return handleInteractionError(interaction, error, 'Log Category Select');
    }
}
