
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
import { getPool } from '../../storage/postgres.js';
import { sendLog, checkChannelPermissions } from '../../utils/logger.js';
import { getUserLogName } from '../../shared.js';

/**
 * Handle the Logs configuration panel
 */
export async function handleLogsSettings(interaction) {
    const guildId = interaction.guildId;
    const pool = getPool();

    // Fetch current log config
    const result = await pool.query(
        'SELECT config FROM guild_configs WHERE guild_id = $1',
        [guildId]
    );

    const config = result.rows[0]?.config || {};
    
    // Helper to get channel mention
    const getChannelInfo = (id) => {
        if (!id) return 'Disabled';
        const channel = interaction.guild.channels.cache.get(id);
        return channel ? `<#${id}>` : 'Unknown Channel';
    };

    const embed = new EmbedBuilder()
        .setTitle('📜 Logs Configuration')
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
        .setLabel('Back to Settings')
        .setStyle(ButtonStyle.Secondary);

    const disableButton = new ButtonBuilder()
        .setCustomId('logs_disable_all')
        .setLabel('Disable All Logs')
        .setEmoji('🚫')
        .setStyle(ButtonStyle.Danger);

    const row1 = new ActionRowBuilder().addComponents(ecoSelect);
    const row2 = new ActionRowBuilder().addComponents(invSelect);
    const row3 = new ActionRowBuilder().addComponents(shopSelect);
    const row4 = new ActionRowBuilder().addComponents(auditSelect);
    const row5 = new ActionRowBuilder().addComponents(backButton, disableButton);

    const msgData = {
        embeds: [embed],
        components: [row1, row2, row3, row4, row5],
        flags: MessageFlags.Ephemeral
    };

    if (interaction.deferred || interaction.replied) {
        await interaction.editReply(msgData);
    } else {
        await interaction.reply(msgData);
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
    const pool = getPool();

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
        return interaction.editReply({ 
            content: `❌ **I can't use that channel.** ${permissionCheck.error}\nPlease make sure I have permission to **View Channel** and **Send Messages** there.`,
            flags: MessageFlags.Ephemeral
        });
    }

    // Update database using JSONB merge to preserve other keys
    await pool.query(
        `INSERT INTO guild_configs (guild_id, config)
         VALUES ($1, $2::jsonb)
         ON CONFLICT (guild_id)
         DO UPDATE SET config = guild_configs.config || $2::jsonb, updated_at = NOW()`,
        [guildId, JSON.stringify({ [configKey]: channelId })]
    );

    // Format human-readable name
    const logName = getUserLogName(interaction);
    const guildName = interaction.guild.name;

    // Send confirmation to the NEW channel
    const targetChannel = interaction.guild.channels.cache.get(channelId);
    if (targetChannel) {
        const categoryLabel = category.charAt(0).toUpperCase() + category.slice(1);
        const confirmEmbed = new EmbedBuilder()
            .setTitle('🛡️ Logging System Updated')
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

    // Console log the change
    console.log(`[${guildName}] [Audit] ${logName} set ${category} logs to #${targetChannel?.name || channelId}`);

    // Refresh UI
    return handleLogsSettings(interaction);
}

/**
 * Handle disabling all logs
 */
export async function handleLogDisable(interaction) {
    const guildId = interaction.guildId;
    const pool = getPool();
    const guildName = interaction.guild.name;
    const logName = getUserLogName(interaction);

    // Remove all log-related keys from config
    await pool.query(
        `UPDATE guild_configs 
         SET config = config - 'log_eco_channel_id' - 'log_inv_channel_id' - 'log_shop_channel_id' - 'log_audit_channel_id', 
             updated_at = NOW()
         WHERE guild_id = $1`,
        [guildId]
    );

    // Standard Audit Log
    sendLog(interaction.guild, 'audit', 'crimson', '🚫 Logs Disabled', 
        `**Admin:** \`${logName}\`\n` +
        `**Action:** Disabled all Discord logging categories.`
    );

    console.log(`[${guildName}] [Audit] ${logName} disabled all Discord logs.`);

    // Refresh UI
    return handleLogsSettings(interaction);
}
