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
    links_only: { label: 'Links Only', emoji: '🔗' },
    images_only: { label: 'Media Only', emoji: '🎬' },
    media_only: { label: 'Socials Only', emoji: '🌐' },
    cmd_only: { label: 'CMD Only', emoji: '🤖' },
    auto_react: { label: 'Auto React', emoji: '🎭' }
};

/**
 * Fetch current filter config from DB
 */
async function getFilters(guildId) {
    const { getGuildConfig } = await import('../../storage/config.js');
    const config = await getGuildConfig(guildId);
    return config?.channel_filters || {};
}

/**
 * Render the Organize panel.
 * @param {string|null} activeFilter - Which filter tab is selected (null = none selected)
 */
async function renderPanel(interaction, activeFilter = null) {
    const guildId = interaction.guildId;
    const filters = await getFilters(guildId);

    // Build summary lines for the embed
    const summaryLines = [];
    for (const [key, meta] of Object.entries(FILTER_TYPES)) {
        const channels = Array.isArray(filters[key]) ? filters[key] : [];
        const channelMentions = channels.length > 0
            ? channels.map(id => `<#${id}>`).join(', ')
            : '_None_';
        summaryLines.push(`${meta.emoji} **${meta.label}:** ${channelMentions}`);
    }

    const embed = new EmbedBuilder()
        .setTitle('🧹 Organize — Channel Filters')
        .setDescription(summaryLines.join('\n'))
        .setColor(0x2B2D31);

    // Row 1: Links Only, Media Only, Socials Only
    const row1 = new ActionRowBuilder().addComponents(
        ['links_only', 'images_only', 'media_only'].map(key => {
            const meta = FILTER_TYPES[key];
            return new ButtonBuilder()
                .setCustomId(`organize_${key}`)
                .setLabel(meta.label)
                .setEmoji(meta.emoji)
                .setStyle(activeFilter === key ? ButtonStyle.Primary : ButtonStyle.Secondary);
        })
    );

    // Row 2: Back button, CMD Only, Auto React
    const row2Buttons = [
        new ButtonBuilder()
            .setCustomId('settings_other')
            .setLabel('Back')
            .setEmoji('⬅️')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('organize_cmd_only')
            .setLabel(FILTER_TYPES.cmd_only.label)
            .setEmoji(FILTER_TYPES.cmd_only.emoji)
            .setStyle(activeFilter === 'cmd_only' ? ButtonStyle.Primary : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('organize_auto_react')
            .setLabel(FILTER_TYPES.auto_react.label)
            .setEmoji(FILTER_TYPES.auto_react.emoji)
            .setStyle(activeFilter === 'auto_react' ? ButtonStyle.Primary : ButtonStyle.Secondary)
    ];

    const row2 = new ActionRowBuilder().addComponents(row2Buttons);
    const components = [];

    // Row 1: Channel select menu (above all buttons, directly below the embed)
    if (activeFilter && FILTER_TYPES[activeFilter]) {
        const meta = FILTER_TYPES[activeFilter];
        const channelSelect = new ChannelSelectMenuBuilder()
            .setCustomId(`organize_select_${activeFilter}`)
            .setPlaceholder(`Toggle a channel for ${meta.label}...`)
            .setChannelTypes(
                ChannelType.GuildText,
                ChannelType.GuildAnnouncement,
                ChannelType.GuildVoice,
                ChannelType.PublicThread,
                ChannelType.PrivateThread
            );
        components.push(new ActionRowBuilder().addComponents(channelSelect));
    }

    // Row 2: Category buttons (Links Only, Media Only, Socials Only)
    components.push(row1);

    // Row 3: Control buttons (Back, CMD Only, Auto React)
    components.push(row2);

    const responseMethod = (interaction.deferred || interaction.replied)
        ? 'editReply'
        : (interaction.isButton() || interaction.isAnySelectMenu() ? 'update' : 'editReply');

    await interaction[responseMethod]({
        embeds: [embed],
        components
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
        if (perms) {
            if (!perms.has(PermissionsBitField.Flags.ViewChannel)) {
                return interaction.followUp({
                    content: '❌ I do not have **View Channel** permission in that channel.',
                    flags: MessageFlags.Ephemeral
                });
            }
            if (filterKey !== 'auto_react' && !perms.has(PermissionsBitField.Flags.ManageMessages)) {
                return interaction.followUp({
                    content: '❌ I do not have **Manage Messages** permission in that channel. I need it to delete filtered messages.',
                    flags: MessageFlags.Ephemeral
                });
            }
            if (filterKey === 'auto_react' && !perms.has(PermissionsBitField.Flags.AddReactions)) {
                return interaction.followUp({
                    content: '❌ I do not have **Add Reactions** permission in that channel.',
                    flags: MessageFlags.Ephemeral
                });
            }
        }
    }

    // Fetch current list for this filter
    const filters = await getFilters(guildId);
    const updatedFilters = { ...filters };
    let channels = Array.isArray(updatedFilters[filterKey]) ? [...updatedFilters[filterKey]] : [];

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
    updatedFilters[filterKey] = channels;

    const { setGuildConfig } = await import('../../storage/config.js');
    await setGuildConfig(guildId, { channel_filters: updatedFilters });

    // Invalidate cache so the middleware picks up the change immediately
    invalidateFilterCache(guildId);

    // Audit log
    const logName = getUserLogName(interaction);
    sendLog(interaction.guild, 'audit', 'cyan', `🧹 Organize Filter ${action === 'added' ? 'Added' : 'Removed'}`,
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

    // Re-render with the same filter tab active
    await renderPanel(interaction, filterKey);
}

/**
 * Show the main Organize panel (no filter selected)
 */
export async function handleOrganizeSettings(interaction) {
    await renderPanel(interaction, null);
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

    // Main panel (back from sub-module or initial open)
    if (customId === 'settings_organize') {
        return renderPanel(interaction, null);
    }

    // Filter type buttons — render the same panel with that tab active
    for (const key of Object.keys(FILTER_TYPES)) {
        if (customId === `organize_${key}`) {
            return renderPanel(interaction, key);
        }
    }

    // Channel select menus (toggle)
    if (customId.startsWith('organize_select_')) {
        const filterKey = customId.replace('organize_select_', '');
        return handleChannelToggle(interaction, filterKey);
    }
}
