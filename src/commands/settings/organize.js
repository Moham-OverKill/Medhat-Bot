import {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelSelectMenuBuilder,
    ChannelType,
    PermissionsBitField,
    MessageFlags
} from 'discord.js';
import { getPool } from '../../storage/postgres.js';
import { sendLog, sysLog, sysError } from '../../utils/logger.js';
import { getUserLogName } from '../../shared.js';
import { invalidateFilterCache } from '../../middleware/organize.js';

// Filter type definitions
const FILTER_TYPES = {
    links_only: { label: 'Links Only', emoji: '🔗', description: 'Only allow messages that start with a URL.' },
    images_only: { label: 'Images Only', emoji: '🖼️', description: 'Only allow messages with image/file attachments.' },
    media_only: { label: 'Media Only', emoji: '🎬', description: 'Only allow social media links (YouTube, TikTok, Instagram, Reddit, X, Facebook).' },
    cmd_only: { label: 'CMD Only', emoji: '🤖', description: 'Only allow bot messages. All human messages are deleted.' }
};

/**
 * Show the main Organize panel with 4 filter type buttons
 */
export async function handleOrganizeSettings(interaction) {
    const guildId = interaction.guildId;
    const pool = getPool();

    // Fetch current filter config
    const result = await pool.query(
        `SELECT config->'channel_filters' as filters FROM guild_configs WHERE guild_id = $1`,
        [guildId]
    );
    const filters = result.rows[0]?.filters || {};

    // Build summary
    const summaryLines = [];
    for (const [key, meta] of Object.entries(FILTER_TYPES)) {
        const channels = Array.isArray(filters[key]) ? filters[key] : [];
        const channelMentions = channels.length > 0
            ? channels.map(id => `<#${id}>`).join(', ')
            : '_None_';
        summaryLines.push(`${meta.emoji} **${meta.label}:** ${channelMentions}`);
    }

    const embed = new EmbedBuilder()
        .setTitle('📋 Organize — Channel Filters')
        .setDescription(
            'Enforce content rules on specific channels. Select a filter type to configure.\n\n' +
            summaryLines.join('\n')
        )
        .setColor(0x2B2D31)
        .setFooter({ text: 'Rules stack: if a channel has multiple rules, any matching rule allows the message.' });

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('organize_links_only')
            .setLabel('Links Only')
            .setEmoji('🔗')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('organize_images_only')
            .setLabel('Images Only')
            .setEmoji('🖼️')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('organize_media_only')
            .setLabel('Media Only')
            .setEmoji('🎬')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('organize_cmd_only')
            .setLabel('CMD Only')
            .setEmoji('🤖')
            .setStyle(ButtonStyle.Secondary)
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('settings_home')
            .setLabel('Back to Settings')
            .setEmoji('⬅️')
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
 * Show a specific filter type's sub-panel with channel list and channel selector
 */
async function showFilterPanel(interaction, filterKey) {
    const guildId = interaction.guildId;
    const pool = getPool();
    const meta = FILTER_TYPES[filterKey];

    if (!meta) return;

    // Fetch current channels for this filter
    const result = await pool.query(
        `SELECT config->'channel_filters'->'${filterKey}' as channels FROM guild_configs WHERE guild_id = $1`,
        [guildId]
    );
    const channels = Array.isArray(result.rows[0]?.channels) ? result.rows[0].channels : [];

    // Build channel list
    const channelList = channels.length > 0
        ? channels.map((id, i) => `**${i + 1}.** <#${id}>`).join('\n')
        : '_No channels configured._';

    const embed = new EmbedBuilder()
        .setTitle(`${meta.emoji} ${meta.label}`)
        .setDescription(`${meta.description}\n\n**Configured Channels:**\n${channelList}`)
        .setColor(0x2B2D31)
        .setFooter({ text: 'Select a channel to add it. Select an existing channel to remove it.' });

    const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId(`organize_select_${filterKey}`)
        .setPlaceholder(`Toggle a channel for ${meta.label}...`)
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

    const row1 = new ActionRowBuilder().addComponents(channelSelect);

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('settings_organize')
            .setLabel('Back to Organize')
            .setEmoji('⬅️')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`organize_clear_${filterKey}`)
            .setLabel('Clear All')
            .setEmoji('🗑️')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(channels.length === 0)
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
 * Handle channel selection (toggle logic)
 */
async function handleChannelToggle(interaction, filterKey) {
    const guildId = interaction.guildId;
    const channelId = interaction.values[0];
    const pool = getPool();
    const meta = FILTER_TYPES[filterKey];

    if (!meta) return;

    // Validate bot permissions in the target channel
    const channel = interaction.guild.channels.cache.get(channelId)
        || await interaction.guild.channels.fetch(channelId).catch(() => null);

    if (!channel) {
        return interaction.followUp({
            content: '❌ Channel not found.',
            flags: MessageFlags.Ephemeral
        });
    }

    const botMember = interaction.guild.members.me;
    if (botMember) {
        const perms = channel.permissionsFor(botMember);
        if (!perms || !perms.has(PermissionsBitField.Flags.ViewChannel)) {
            return interaction.followUp({
                content: '❌ I do not have **View Channel** permission in that channel.',
                flags: MessageFlags.Ephemeral
            });
        }
        if (!perms.has(PermissionsBitField.Flags.ManageMessages)) {
            return interaction.followUp({
                content: '❌ I do not have **Manage Messages** permission in that channel. I need it to delete filtered messages.',
                flags: MessageFlags.Ephemeral
            });
        }
    }

    // Fetch current list
    const result = await pool.query(
        `SELECT config->'channel_filters'->'${filterKey}' as channels FROM guild_configs WHERE guild_id = $1`,
        [guildId]
    );
    let channels = Array.isArray(result.rows[0]?.channels) ? [...result.rows[0].channels] : [];

    // Toggle logic
    let action;
    const existingIndex = channels.indexOf(channelId);
    if (existingIndex !== -1) {
        channels.splice(existingIndex, 1);
        action = 'removed';
    } else {
        channels.push(channelId);
        action = 'added';
    }

    // Save using JSONB merge (same pattern as logs.js)
    // First ensure channel_filters object exists, then set the specific key
    await pool.query(
        `INSERT INTO guild_configs (guild_id, config)
         VALUES ($1, jsonb_build_object('channel_filters', jsonb_build_object($2::text, $3::jsonb)))
         ON CONFLICT (guild_id)
         DO UPDATE SET config = jsonb_set(
           COALESCE(guild_configs.config, '{}'::jsonb),
           ARRAY['channel_filters', $2::text],
           $3::jsonb
         ), updated_at = NOW()`,
        [guildId, filterKey, JSON.stringify(channels)]
    );

    // Invalidate cache so the middleware picks up the change immediately
    invalidateFilterCache(guildId);

    // Audit log
    const logName = getUserLogName(interaction);
    sendLog(interaction.guild, 'audit', 'cyan', `📋 Organize Filter ${action === 'added' ? 'Added' : 'Removed'}`,
        `**Admin:** \`${logName}\`\n` +
        `**Filter:** ${meta.emoji} ${meta.label}\n` +
        `**Channel:** <#${channelId}>\n` +
        `**Action:** ${action === 'added' ? 'Added to filter' : 'Removed from filter'}`
    );

    sysLog('Organize Filter Changed', {
        user: interaction.user.id,
        guild: guildId,
        detail: `Filter: ${filterKey} | Channel: ${channelId} | Action: ${action}`
    });

    // Refresh the filter panel
    await showFilterPanel(interaction, filterKey);
}

/**
 * Handle clearing all channels from a filter
 */
async function handleClearFilter(interaction, filterKey) {
    const guildId = interaction.guildId;
    const pool = getPool();
    const meta = FILTER_TYPES[filterKey];

    if (!meta) return;

    // Set the filter to an empty array
    await pool.query(
        `UPDATE guild_configs
         SET config = jsonb_set(
           COALESCE(config, '{}'::jsonb),
           ARRAY['channel_filters', $2::text],
           '[]'::jsonb
         ), updated_at = NOW()
         WHERE guild_id = $1`,
        [guildId, filterKey]
    );

    // Invalidate cache
    invalidateFilterCache(guildId);

    // Audit log
    const logName = getUserLogName(interaction);
    sendLog(interaction.guild, 'audit', 'crimson', '📋 Organize Filter Cleared',
        `**Admin:** \`${logName}\`\n` +
        `**Filter:** ${meta.emoji} ${meta.label}\n` +
        `**Action:** Cleared all channels from this filter.`
    );

    sysLog('Organize Filter Cleared', {
        user: interaction.user.id,
        guild: guildId,
        detail: `Filter: ${filterKey}`
    });

    // Refresh the filter panel
    await showFilterPanel(interaction, filterKey);
}

/**
 * Main component router for all organize_* interactions
 */
export async function handleOrganizeComponent(interaction) {
    const customId = interaction.customId;

    // Defer update to prevent timeout
    if (!interaction.deferred && !interaction.replied) {
        if (interaction.isButton() || interaction.isAnySelectMenu()) {
            await interaction.deferUpdate().catch(() => {});
        }
    }

    // Main panel
    if (customId === 'settings_organize') {
        return handleOrganizeSettings(interaction);
    }

    // Filter type buttons
    for (const key of Object.keys(FILTER_TYPES)) {
        if (customId === `organize_${key}`) {
            return showFilterPanel(interaction, key);
        }
    }

    // Channel select menus (toggle)
    if (customId.startsWith('organize_select_')) {
        const filterKey = customId.replace('organize_select_', '');
        return handleChannelToggle(interaction, filterKey);
    }

    // Clear buttons
    if (customId.startsWith('organize_clear_')) {
        const filterKey = customId.replace('organize_clear_', '');
        return handleClearFilter(interaction, filterKey);
    }
}
