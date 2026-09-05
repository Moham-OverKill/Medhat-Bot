import {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelSelectMenuBuilder,
    ChannelType,
    PermissionsBitField,
    MessageFlags,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} from 'discord.js';
import { getPool } from '../../storage/postgres.js';
import { sendLog, sysLog, sysError } from '../../utils/logger.js';
import { getUserLogName } from '../../shared.js';
import { invalidateFilterCache } from '../../middleware/organize.js';
import { createErrorEmbed } from '../../utils/errors.js';

// Filter type definitions
const FILTER_TYPES = {
    links_only: { label: 'Links Only', emoji: '🔗' },
    images_only: { label: 'Media Only', emoji: '🎬' },
    media_only: { label: 'Socials Only', emoji: '🌐' },
    cmd_only: { label: 'CMD Only', emoji: '🤖' },
    auto_react: { label: 'Auto React', emoji: '🎭' }
};

const DEFAULT_REACTIONS = ['👍', '❤️', '😂', '😭'];

/**
 * Helper to parse ordered reaction emojis from text input.
 * Supports Unicode emojis, <:name:id>, <a:name:id>, snowflake IDs, and :name: lookups.
 */
export function parseReactionEmojis(input, guild = null, client = null) {
    if (!input || !input.trim()) return [...DEFAULT_REACTIONS];

    const tokenRegex = /(<a?:[a-zA-Z0-9_]+:\d{17,20}>)|(\b\d{17,20}\b)|(:[a-zA-Z0-9_]+:)|(\p{Extended_Pictographic}(?:\u200D\p{Extended_Pictographic}|\uFE0F|\p{Emoji_Modifier})*)/gu;

    const results = [];
    let match;
    while ((match = tokenRegex.exec(input)) !== null) {
        const [full, customFormatted, snowflake, colonName, unicode] = match;
        if (customFormatted) {
            results.push(customFormatted);
        } else if (snowflake) {
            const found = guild?.emojis?.cache?.get(snowflake) || client?.emojis?.cache?.get(snowflake);
            if (found) {
                results.push(`<${found.animated ? 'a' : ''}:${found.name}:${found.id}>`);
            } else {
                results.push(`<:custom:${snowflake}>`);
            }
        } else if (colonName) {
            const name = colonName.replace(/:/g, '').toLowerCase();
            const found = guild?.emojis?.cache?.find(e => e.name.toLowerCase() === name) || client?.emojis?.cache?.find(e => e.name.toLowerCase() === name);
            if (found) {
                results.push(`<${found.animated ? 'a' : ''}:${found.name}:${found.id}>`);
            }
        } else if (unicode) {
            results.push(unicode);
        }
    }

    return results.length > 0 ? results.slice(0, 20) : [...DEFAULT_REACTIONS];
}

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
    const autoReactEmojis = Array.isArray(filters.auto_react_emojis) && filters.auto_react_emojis.length > 0
        ? filters.auto_react_emojis
        : DEFAULT_REACTIONS;

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
        .setTitle('Organize — Channel Filters')
        .setDescription(summaryLines.join('\n'))
        .setColor(0x2B2D31);

    const components = [];

    // Row 1: Channel select menu (when a filter tab is active)
    if (activeFilter && FILTER_TYPES[activeFilter]) {
        const meta = FILTER_TYPES[activeFilter];
        const channelTypes = [
            ChannelType.GuildText,
            ChannelType.GuildAnnouncement,
            ChannelType.GuildVoice,
            ChannelType.PublicThread,
            ChannelType.PrivateThread
        ];

        // Only allow Forum & Media channels when managing Auto React
        if (activeFilter === 'auto_react') {
            channelTypes.push(ChannelType.GuildForum);
            if (ChannelType.GuildMedia) {
                channelTypes.push(ChannelType.GuildMedia);
            }
        }

        const channelSelect = new ChannelSelectMenuBuilder()
            .setCustomId(`organize_select_${activeFilter}`)
            .setPlaceholder(`Toggle a channel for ${meta.label}...`)
            .setChannelTypes(channelTypes);
        components.push(new ActionRowBuilder().addComponents(channelSelect));
    }

    // Row 2: Emoji settings for Auto React (when active tab is auto_react)
    if (activeFilter === 'auto_react') {
        const emojiRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('organize_set_reactions')
                .setLabel('Set Reactions')
                .setEmoji('🎭')
                .setStyle(ButtonStyle.Success)
        );
        components.push(emojiRow);
    }

    // Row 3: Filter type buttons (Links Only, Media Only, Socials Only)
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
    components.push(row1);

    // Row 4: Control buttons (Back, CMD Only, Auto React)
    const row2Buttons = [
        new ButtonBuilder()
            .setCustomId('settings_home')
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
    components.push(new ActionRowBuilder().addComponents(row2Buttons));

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
        const errorEmbed = createErrorEmbed('Channel Not Found', 'The selected channel could not be found.');
        await interaction.followUp({
            embeds: [errorEmbed],
            flags: MessageFlags.Ephemeral
        });
        return renderPanel(interaction, filterKey);
    }

    const isForumChannel = channel.type === ChannelType.GuildForum ||
        channel.type === ChannelType.GuildMedia ||
        channel.type === 15 ||
        channel.type === 16;

    if (filterKey !== 'auto_react' && isForumChannel) {
        const errorEmbed = createErrorEmbed(
            'Invalid Channel Type',
            'Forum channels can only be configured for the **Auto React** filter.'
        );
        await interaction.followUp({
            embeds: [errorEmbed],
            flags: MessageFlags.Ephemeral
        });
        return renderPanel(interaction, filterKey);
    }

    const botMember = interaction.guild.members.me;
    if (botMember) {
        const perms = channel.permissionsFor(botMember);
        if (perms) {
            if (!perms.has(PermissionsBitField.Flags.ViewChannel)) {
                const errorEmbed = createErrorEmbed(
                    'Missing Permissions',
                    'I do not have **View Channel** permission in that channel.'
                );
                await interaction.followUp({
                    embeds: [errorEmbed],
                    flags: MessageFlags.Ephemeral
                });
                return renderPanel(interaction, filterKey);
            }
            if (filterKey !== 'auto_react' && !perms.has(PermissionsBitField.Flags.ManageMessages)) {
                const errorEmbed = createErrorEmbed(
                    'Missing Permissions',
                    'I do not have **Manage Messages** permission in that channel. I need it to delete filtered messages.'
                );
                await interaction.followUp({
                    embeds: [errorEmbed],
                    flags: MessageFlags.Ephemeral
                });
                return renderPanel(interaction, filterKey);
            }
            if (filterKey === 'auto_react') {
                if (!perms.has(PermissionsBitField.Flags.AddReactions)) {
                    const errorEmbed = createErrorEmbed(
                        'Missing Permissions',
                        'I do not have **Add Reactions** permission in that channel.'
                    );
                    await interaction.followUp({
                        embeds: [errorEmbed],
                        flags: MessageFlags.Ephemeral
                    });
                    return renderPanel(interaction, filterKey);
                }
                if (!perms.has(PermissionsBitField.Flags.ReadMessageHistory)) {
                    const errorEmbed = createErrorEmbed(
                        'Missing Permissions',
                        'I do not have **Read Message History** permission in that channel. Discord requires this permission to add reactions.'
                    );
                    await interaction.followUp({
                        embeds: [errorEmbed],
                        flags: MessageFlags.Ephemeral
                    });
                    return renderPanel(interaction, filterKey);
                }
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

    // 1. Show modal to set custom emojis in order (DO NOT DEFER)
    if (customId === 'organize_set_reactions') {
        const guildId = interaction.guildId;
        const filters = await getFilters(guildId);
        const autoReactEmojis = Array.isArray(filters.auto_react_emojis) && filters.auto_react_emojis.length > 0
            ? filters.auto_react_emojis
            : DEFAULT_REACTIONS;

        const modal = new ModalBuilder()
            .setCustomId('organize_auto_react_modal')
            .setTitle('Auto React Emojis');

        const emojiInput = new TextInputBuilder()
            .setCustomId('organize_auto_react_input')
            .setLabel('Emojis in Order')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('e.g. 👍 ❤️ 😂 😭 or custom :emojis: / IDs')
            .setValue(autoReactEmojis.join(' '))
            .setRequired(false)
            .setMaxLength(1000);

        modal.addComponents(new ActionRowBuilder().addComponents(emojiInput));
        return interaction.showModal(modal);
    }

    // Defer update for buttons, selects, and modals to acknowledge instantly
    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate().catch(() => {});
    }

    // 2. Handle modal submit
    if (customId === 'organize_auto_react_modal') {
        const guildId = interaction.guildId;
        const rawInput = interaction.fields.getTextInputValue('organize_auto_react_input');
        const parsedEmojis = parseReactionEmojis(rawInput, interaction.guild, interaction.client);

        const filters = await getFilters(guildId);
        const updatedFilters = { ...filters, auto_react_emojis: parsedEmojis };

        const { setGuildConfig } = await import('../../storage/config.js');
        await setGuildConfig(guildId, { channel_filters: updatedFilters });

        invalidateFilterCache(guildId);

        const logName = getUserLogName(interaction);
        sendLog(interaction.guild, 'audit', 'cyan', 'Auto React Emojis Updated',
            `**Admin:** \`${logName}\`\n` +
            `**Reactions:** ${parsedEmojis.join(' ')}`
        );

        sysLog('Auto React Emojis Updated', {
            user: interaction.user.id,
            guild: guildId,
            detail: `Emojis: ${parsedEmojis.join(' ')}`
        });

        // Re-render panel with updated configuration
        return renderPanel(interaction, 'auto_react');
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
