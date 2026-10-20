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
import { getUserLogName } from '../../shared.js';
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
        desc: 'Logs shop purchases and box openings'
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
 * Handle the Logs configuration panel
 */
export async function handleLogsSettings(interaction, selectedId = null, configOverride = null) {
    try {
        const guildId = interaction.guildId;
        const config = configOverride || (await getGuildConfig(guildId)) || {};

        let desc = '';
        for (const cat of Object.values(LOG_CATEGORIES)) {
            const chanId = config[cat.dbId];
            const statusLabel = chanId ? `<#${chanId}>` : '*Disabled*';
            desc += `**${cat.emoji} ${cat.name}**\n↳ ${statusLabel}\n\n`;
        }

        const embed = new EmbedBuilder()
            .setTitle('Logs Configuration')
            .setDescription(desc)
            .setColor(selectedId ? 0xF1C40F : 0x3498DB);

        const components = [];

        // Row 1: Category selection dropdown
        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('logs_type_select')
            .setPlaceholder('1. Select a Log Category to configure...')
            .addOptions(Object.values(LOG_CATEGORIES).map(cat => ({
                label: cat.name,
                description: cat.desc,
                value: cat.id,
                emoji: cat.emoji,
                default: selectedId === cat.id
            })));
        components.push(new ActionRowBuilder().addComponents(selectMenu));

        if (selectedId && LOG_CATEGORIES[selectedId]) {
            const active = LOG_CATEGORIES[selectedId];
            const chan = config[active.dbId];

            // Row 2: Channel selection dropdown
            const channelSelect = new ChannelSelectMenuBuilder()
                .setCustomId(`logs_set_channel_${active.id}`)
                .setPlaceholder(`2. Select a channel for ${active.name}...`)
                .setChannelTypes(ChannelType.GuildText);
            components.push(new ActionRowBuilder().addComponents(channelSelect));

            // Row 3: Navigation & Disable
            const disableButton = new ButtonBuilder()
                .setCustomId(`logs_disable_${active.id}`)
                .setLabel('Disable')
                .setEmoji('✖️')
                .setStyle(ButtonStyle.Danger)
                .setDisabled(!chan);

            const backButton = new ButtonBuilder()
                .setCustomId('settings_logs')
                .setLabel('Back')
                .setEmoji('⬅️')
                .setStyle(ButtonStyle.Secondary);

            components.push(new ActionRowBuilder().addComponents(backButton, disableButton));
        } else {
            // Home Panel Navigation
            const backButton = new ButtonBuilder()
                .setCustomId('settings_home')
                .setLabel('Back')
                .setEmoji('⬅️')
                .setStyle(ButtonStyle.Secondary);

            const disableAllButton = new ButtonBuilder()
                .setCustomId('logs_disable_all')
                .setLabel('Disable All')
                .setEmoji('✖️')
                .setStyle(ButtonStyle.Danger);

            components.push(new ActionRowBuilder().addComponents(backButton, disableAllButton));
        }

        const msgData = {
            embeds: [embed],
            components,
            flags: MessageFlags.Ephemeral,
            content: ''
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
 * Handle category selection from StringSelectMenu
 */
export async function handleLogCategorySelect(interaction) {
    try {
        const selectedId = interaction.values[0];
        return handleLogsSettings(interaction, selectedId);
    } catch (error) {
        sysError('Log category select failed', error, { user: interaction.user.id, guild: interaction.guildId });
        return handleInteractionError(interaction, error, 'Log Category Select');
    }
}

/**
 * Handle log channel assignment for specific categories
 */
export async function handleLogChannelSelect(interaction) {
    try {
        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
        const customId = interaction.customId; // logs_set_channel_CATEGORY
        const category = customId.replace('logs_set_channel_', '');
        const cat = LOG_CATEGORIES[category];
        if (!cat) return;

        const channelId = interaction.values[0];
        const guildId = interaction.guildId;

        // Validate channel permissions
        const channel = interaction.guild.channels.cache.get(channelId) || await interaction.guild.channels.fetch(channelId).catch(() => null);
        const permissionCheck = checkChannelPermissions(channel);
        if (!permissionCheck.valid) {
            return interaction.followUp({ 
                content: `❌ **I can't use that channel.** ${permissionCheck.error}\nPlease make sure I have permission to **View Channel** and **Send Messages** there.`,
                flags: MessageFlags.Ephemeral
            });
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
        return handleLogsSettings(interaction, cat.id, updatedConfig);
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

        if (target === 'all') {
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
            return handleLogsSettings(interaction, cat.id, updatedConfig);
        }
    } catch (error) {
        sysError('Log disable failed', error, { user: interaction.user.id, guild: interaction.guildId });
        return handleInteractionError(interaction, error, 'Log Disable');
    }
}
