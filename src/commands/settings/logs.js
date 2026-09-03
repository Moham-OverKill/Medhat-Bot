
import {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    ChannelSelectMenuBuilder,
    ChannelType,
    ComponentType,
    MessageFlags
} from 'discord.js';
import { getGuildConfig, setGuildConfig } from '../../storage/config.js';
import { sendLog, sysLog, checkChannelPermissions } from '../../utils/logger.js';
import { getUserLogName } from '../../shared.js';

/**
 * Handle the Logs configuration panel
 */
export async function handleLogsSettings(interaction) {
    const guildId = interaction.guildId;
    const config = (await getGuildConfig(guildId)) || {};
    
    // Helper to get channel mention
    const getChannelInfo = (id) => {
        if (!id) return 'Disabled';
        return `<#${id}>`;
    };

    const embed = new EmbedBuilder()
        .setTitle('Logs Configuration')
        .setDescription('Configure where the bot logs all server events. You can assign different channels for each category.')
        .addFields(
            { name: '📈 Economy', value: getChannelInfo(config.log_eco_channel_id), inline: true },
            { name: '🎒 Inventory', value: getChannelInfo(config.log_inv_channel_id), inline: true },
            { name: '\u200B', value: '\u200B', inline: true }, // Spacer
            { name: '🛒 Shop', value: getChannelInfo(config.log_shop_channel_id), inline: true },
            { name: '🛡️ Audit', value: getChannelInfo(config.log_audit_channel_id), inline: true },
            { name: '\u200B', value: '\u200B', inline: true } // Spacer
        )
        .setColor(0x2B2D31);

    // Create 4 rows for selection + 1 for navigation
    const ecoSelect = new ChannelSelectMenuBuilder()
        .setCustomId('logs_assign_economy')
        .setPlaceholder('Assign Economy Log Channel...')
        .setChannelTypes(ChannelType.GuildText);

    const invSelect = new ChannelSelectMenuBuilder()
        .setCustomId('logs_assign_inventory')
        .setPlaceholder('Assign Inventory Log Channel...')
        .setChannelTypes(ChannelType.GuildText);

    const shopSelect = new ChannelSelectMenuBuilder()
        .setCustomId('logs_assign_shop')
        .setPlaceholder('Assign Shop Log Channel...')
        .setChannelTypes(ChannelType.GuildText);

    const auditSelect = new ChannelSelectMenuBuilder()
        .setCustomId('logs_assign_audit')
        .setPlaceholder('Assign Audit Log Channel...')
        .setChannelTypes(ChannelType.GuildText);

    const backButton = new ButtonBuilder()
        .setCustomId('settings_home')
        .setLabel('Back')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary);

    const disableButton = new ButtonBuilder()
        .setCustomId('logs_disable_all')
        .setLabel('Disable')
        .setEmoji('✖️')
        .setStyle(ButtonStyle.Danger);

    const row1 = new ActionRowBuilder().addComponents(ecoSelect);
    const row2 = new ActionRowBuilder().addComponents(invSelect);
    const row3 = new ActionRowBuilder().addComponents(shopSelect);
    const row4 = new ActionRowBuilder().addComponents(auditSelect);
    const row5 = new ActionRowBuilder().addComponents(backButton, disableButton);

    const responseMethod = interaction.isCommand?.() || interaction.isModalSubmit?.() ? 'reply' : 'update';
    const msgData = {
        embeds: [embed],
        components: [row1, row2, row3, row4, row5],
        flags: MessageFlags.Ephemeral
    };

    if (responseMethod === 'reply') {
        if (interaction.deferred || interaction.replied) await interaction.editReply(msgData);
        else await interaction.reply(msgData);
    } else {
        await interaction.update(msgData);
    }
}

/**
 * Handle log channel assignment for specific categories
 */
export async function handleLogCategorySelect(interaction) {
    const customId = interaction.customId; // logs_assign_CATEGORY
    const category = customId.split('_')[2]; // economy, inventory, etc


    const channelId = interaction.values[0];
    const guildId = interaction.guildId;

    // Map internal key
    const categoryMap = {
        economy: 'log_eco_channel_id',
        inventory: 'log_inv_channel_id',
        shop: 'log_shop_channel_id',
        audit: 'log_audit_channel_id'
    };

    const configKey = categoryMap[category];
    if (!configKey) return;

    // Validate channel permissions
    const channel = interaction.guild.channels.cache.get(channelId) || await interaction.guild.channels.fetch(channelId).catch(() => null);
    const permissionCheck = checkChannelPermissions(channel);
    if (!permissionCheck.valid) {
        return interaction.reply({ 
            content: `❌ **I can't use that channel.** ${permissionCheck.error}\nPlease make sure I have permission to **View Channel** and **Send Messages** there.`,
            flags: MessageFlags.Ephemeral
        });
    }

    // Update database and cache using setGuildConfig
    await setGuildConfig(guildId, { [configKey]: channelId });

    // Format human-readable name
    const logName = getUserLogName(interaction);
    const guildName = interaction.guild.name;

    // Send confirmation to the NEW channel
    const targetChannel = interaction.guild.channels.cache.get(channelId);
    if (targetChannel) {
        const categoryLabel = category.charAt(0).toUpperCase() + category.slice(1);
        const confirmEmbed = new EmbedBuilder()
            .setTitle('Logging System Updated')
            .setDescription(`Admin **${logName}** has assigned this channel for **${categoryLabel}** logs.`)
            .setColor(0x2ECC71)
            .setFooter({ text: `${guildName} • ${new Date().toLocaleString()}` });
        
        await targetChannel.send({ embeds: [confirmEmbed] }).catch(() => {});

        // Standard Audit Log
        sendLog(interaction.guild, 'audit', 'cyan', '⚙️ Log Settings Changed', 
            `**Admin:** \`${logName}\`\n` +
            `**Category:** \`${categoryLabel}\`\n` +
            `**Action:** Set log channel to ${targetChannel}`
        );
    }

    // System Audit Log
    sysLog('Log Settings Changed', { user: interaction.user.id, guild: guildId, detail: `Category: ${category} | Channel: ${channelId}` });

    // Refresh UI
    return handleLogsSettings(interaction);
}

/**
 * Handle disabling all logs
 */
export async function handleLogDisable(interaction) {
    const guildId = interaction.guildId;
    const logName = getUserLogName(interaction);

    // Remove all log-related keys from config
    await setGuildConfig(guildId, {
        log_eco_channel_id: null,
        log_inv_channel_id: null,
        log_shop_channel_id: null,
        log_audit_channel_id: null
    });

    // Standard Audit Log
    sendLog(interaction.guild, 'audit', 'crimson', '🚫 Logs Disabled', 
        `**Admin:** \`${logName}\`\n` +
        `**Action:** Disabled all Discord logging categories.`
    );

    sysLog('Logs Disabled', { user: interaction.user.id, guild: guildId });

    // Refresh UI
    return handleLogsSettings(interaction);
}
