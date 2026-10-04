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
    TextInputStyle,
    StringSelectMenuBuilder
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
export const DEFAULT_BLACKLISTED_EMOJIS = Object.freeze(['🖕', '🍆', '🍑', '💦']);

/**
 * Helper to parse ordered reaction emojis from text input.
 * Supports Unicode emojis, <:name:id>, <a:name:id>, snowflake IDs, and :name: lookups.
 */
export function parseReactionEmojis(input, guild = null, client = null, defaultFallback = DEFAULT_REACTIONS) {
    if (!input || !input.trim()) return [...defaultFallback];

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

    return results.length > 0 ? results.slice(0, 20) : [...defaultFallback];
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
            .setCustomId('settings_organize')
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
 * Render the main Organize Hub
 * Row 1: [Filters] [Emojis] [Forums] [Interface]
 * Row 2: [Back]
 */
export async function showOrganizeMenu(interaction) {
    const embed = new EmbedBuilder()
        .setTitle('Organize')
        .setDescription('Manage server channels, automation filters, and interface hubs.')
        .setColor(0x2B2D31);

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('organize_filters')
            .setLabel('Links')
            .setEmoji('🔗')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('organize_emojis')
            .setLabel('Emojis')
            .setEmoji('😵')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('organize_forums')
            .setLabel('Forums')
            .setEmoji('📁')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('organize_interface')
            .setLabel('Interface')
            .setEmoji('🖥️')
            .setStyle(ButtonStyle.Secondary)
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('settings_home')
            .setLabel('Back')
            .setEmoji('⬅️')
            .setStyle(ButtonStyle.Secondary)
    );

    const responseMethod = (interaction.deferred || interaction.replied)
        ? 'editReply'
        : (interaction.isButton() || interaction.isAnySelectMenu() ? 'update' : 'editReply');

    await interaction[responseMethod]({
        content: '',
        embeds: [embed],
        components: [row1, row2]
    });
}

/**
 * Show the main Organize panel (no filter selected)
 */
export async function handleOrganizeSettings(interaction) {
    await showOrganizeMenu(interaction);
}

/**
 * Format active blacklist items cleanly:
 * Standard emojis are separated by commas, and custom emoji IDs are summarized at the end as "and X customs".
 */
function formatBlacklistDisplay(blacklist) {
    if (!Array.isArray(blacklist) || blacklist.length === 0) {
        return '_No emojis blacklisted._';
    }

    const standardEmojis = [];
    let customCount = 0;

    for (const em of blacklist) {
        if (!em) continue;
        const isCustom = typeof em === 'string' && (
            (em.startsWith('<') && em.endsWith('>')) ||
            /^\d{17,20}$/.test(em)
        );

        if (isCustom) {
            customCount++;
        } else {
            standardEmojis.push(em);
        }
    }

    const customText = customCount > 0 ? `${customCount} custom${customCount === 1 ? '' : 's'}` : '';

    if (standardEmojis.length > 0 && customCount > 0) {
        return `${standardEmojis.join(', ')} and ${customText}`;
    } else if (standardEmojis.length > 0) {
        return standardEmojis.join(', ');
    } else if (customCount > 0) {
        return customText;
    }

    return '_No emojis blacklisted._';
}

/**
 * Render the Emoji Moderation / Reaction Blacklist Panel
 */
export async function renderEmojiModerationPanel(interaction) {
    const guildId = interaction.guildId;
    const filters = await getFilters(guildId);

    const blacklist = Array.isArray(filters.reaction_blacklist)
        ? filters.reaction_blacklist
        : [...DEFAULT_BLACKLISTED_EMOJIS];
    const isEnabled = filters.reaction_blacklist_enabled === true;

    const embed = new EmbedBuilder()
        .setTitle('Organize — Emoji Blacklist');

    // Check bot permissions for diagnostics
    const botMember = interaction.guild?.members?.me || await interaction.guild?.members?.fetchMe().catch(() => null);
    const requiredPermissions = [
        { flag: PermissionsBitField.Flags.ManageMessages, name: 'Manage Messages', purpose: 'Messages & Reactions' },
        { flag: PermissionsBitField.Flags.ManageChannels, name: 'Manage Channels', purpose: 'Channel Names & Topics' },
        { flag: PermissionsBitField.Flags.SetVoiceChannelStatus, name: 'Set Voice Channel Status', purpose: 'Call / Voice Status' },
        { flag: PermissionsBitField.Flags.ManageNicknames, name: 'Manage Nicknames', purpose: 'User Display Names' }
    ];

    const missingPermissions = [];
    if (botMember) {
        for (const req of requiredPermissions) {
            if (!botMember.permissions.has(req.flag)) {
                missingPermissions.push(req);
            }
        }
    }

    const statusLine = `• **Status:** ${isEnabled ? 'Enabled 🟢' : 'Disabled 🔴'}`;
    const totalLine = `• **Total Blacklisted:** \`${blacklist.length}\``;
    const listDisplay = formatBlacklistDisplay(blacklist);

    embed.setDescription(
        'Restricted emojis are detected and removed across messages, polls, reactions, user nicknames, channel names, channel topics, and voice statuses.\n\n' +
        `${statusLine}\n` +
        `${totalLine}\n` +
        listDisplay
    );
    embed.setColor(missingPermissions.length > 0 ? 0xE67E22 : 0x2B2D31);

    if (missingPermissions.length > 0) {
        embed.addFields({
            name: '⚠️ Missing Permissions',
            value: 'The bot requires the following permissions to enforce all moderation vectors:\n' +
                missingPermissions.map(p => `• **${p.name}** — _${p.purpose}_`).join('\n') +
                '\n_Please enable these permissions in Server Settings > Roles._',
            inline: false
        });
    }

    const components = [];

    // Row 1: Remove an emoji select menu (if blacklist has items)
    if (blacklist.length > 0) {
        const selectOptions = blacklist.slice(0, 25).map((em, idx) => {
            let label = em;
            if (em.startsWith('<') && em.endsWith('>')) {
                const parts = em.slice(1, -1).split(':');
                label = parts[2] || parts[1] || em;
            } else if (/^\d{17,20}$/.test(em)) {
                label = em;
            } else {
                label = em;
            }
            return {
                label: (label || 'unknown').slice(0, 100),
                value: String(idx)
            };
        });

        const removeSelect = new StringSelectMenuBuilder()
            .setCustomId('organize_emoji_remove_select')
            .setPlaceholder('Select an emoji to remove from blacklist...')
            .addOptions(selectOptions);

        components.push(new ActionRowBuilder().addComponents(removeSelect));
    }

    // Row 1: Action buttons (Add Emojis on left, Disable/Enable on right)
    const actionRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('organize_emoji_add')
            .setLabel('Add Emojis')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId('organize_emoji_toggle')
            .setLabel(isEnabled ? 'Disable' : 'Enable')
            .setStyle(isEnabled ? ButtonStyle.Danger : ButtonStyle.Success)
    );
    components.push(actionRow);

    // Row 2: Navigation (Back to Organize — always on the far left)
    const navRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('settings_organize')
            .setLabel('Back')
            .setEmoji('⬅️')
            .setStyle(ButtonStyle.Secondary)
    );
    components.push(navRow);

    const responseMethod = (interaction.deferred || interaction.replied)
        ? 'editReply'
        : (interaction.isButton() || interaction.isAnySelectMenu() ? 'update' : 'editReply');

    await interaction[responseMethod]({
        content: '',
        embeds: [embed],
        components,
        files: []
    });
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

    // Modal to add blacklisted emojis (DO NOT DEFER)
    if (customId === 'organize_emoji_add') {
        const modal = new ModalBuilder()
            .setCustomId('organize_emoji_add_modal')
            .setTitle('Blacklist Emojis');

        const emojiInput = new TextInputBuilder()
            .setCustomId('organize_emoji_add_input')
            .setLabel('Emojis to Blacklist')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('Enter Emojis/IDs ( 🖕, 🍆, 🍑, 💦 )')
            .setRequired(true)
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

    // Handle modal submit for adding blacklisted emojis
    if (customId === 'organize_emoji_add_modal') {
        const guildId = interaction.guildId;
        const rawInput = interaction.fields.getTextInputValue('organize_emoji_add_input');
        const parsedEmojis = parseReactionEmojis(rawInput, interaction.guild, interaction.client, []);

        if (parsedEmojis.length > 0) {
            const filters = await getFilters(guildId);
            const currentBlacklist = Array.isArray(filters.reaction_blacklist)
                ? filters.reaction_blacklist
                : [...DEFAULT_BLACKLISTED_EMOJIS];

            const updatedBlacklist = [...currentBlacklist];
            for (const em of parsedEmojis) {
                if (!updatedBlacklist.includes(em)) {
                    updatedBlacklist.push(em);
                }
            }

            const updatedFilters = { ...filters, reaction_blacklist: updatedBlacklist };
            const { setGuildConfig } = await import('../../storage/config.js');
            await setGuildConfig(guildId, { channel_filters: updatedFilters });
            invalidateFilterCache(guildId);

            const logName = getUserLogName(interaction);
            sendLog(interaction.guild, 'audit', 'cyan', 'Emoji Blacklist Updated',
                `**Admin:** \`${logName}\`\n` +
                `**Added:** ${parsedEmojis.join(' ')}\n` +
                `**Total:** ${updatedBlacklist.length}`
            );
        }

        return renderEmojiModerationPanel(interaction);
    }

    // Handle emoji removal from blacklist via select menu
    if (customId === 'organize_emoji_remove_select') {
        const guildId = interaction.guildId;
        const removeIdx = parseInt(interaction.values[0], 10);
        const filters = await getFilters(guildId);
        const currentBlacklist = Array.isArray(filters.reaction_blacklist)
            ? filters.reaction_blacklist
            : [...DEFAULT_BLACKLISTED_EMOJIS];

        if (!isNaN(removeIdx) && removeIdx >= 0 && removeIdx < currentBlacklist.length) {
            const removedEmoji = currentBlacklist.splice(removeIdx, 1)[0];
            const updatedFilters = { ...filters, reaction_blacklist: currentBlacklist };
            const { setGuildConfig } = await import('../../storage/config.js');
            await setGuildConfig(guildId, { channel_filters: updatedFilters });
            invalidateFilterCache(guildId);

            const logName = getUserLogName(interaction);
            sendLog(interaction.guild, 'audit', 'cyan', 'Emoji Removed from Blacklist',
                `**Admin:** \`${logName}\`\n**Removed:** ${removedEmoji}`
            );
        }

        return renderEmojiModerationPanel(interaction);
    }

    // Reset emoji blacklist to defaults
    if (customId === 'organize_emoji_reset') {
        const guildId = interaction.guildId;
        const filters = await getFilters(guildId);
        const updatedFilters = { ...filters, reaction_blacklist: [...DEFAULT_BLACKLISTED_EMOJIS] };
        const { setGuildConfig } = await import('../../storage/config.js');
        await setGuildConfig(guildId, { channel_filters: updatedFilters });
        invalidateFilterCache(guildId);

        const logName = getUserLogName(interaction);
        sendLog(interaction.guild, 'audit', 'cyan', 'Emoji Blacklist Reset to Defaults',
            `**Admin:** \`${logName}\`\n**Defaults:** ${DEFAULT_BLACKLISTED_EMOJIS.join(' ')}`
        );

        return renderEmojiModerationPanel(interaction);
    }

    // Toggle emoji blacklist active state
    if (customId === 'organize_emoji_toggle') {
        const guildId = interaction.guildId;
        const filters = await getFilters(guildId);
        const currentlyEnabled = filters.reaction_blacklist_enabled === true;
        const newStatus = !currentlyEnabled;

        const updatedFilters = { ...filters, reaction_blacklist_enabled: newStatus };
        const { setGuildConfig } = await import('../../storage/config.js');
        await setGuildConfig(guildId, { channel_filters: updatedFilters });
        invalidateFilterCache(guildId);

        const logName = getUserLogName(interaction);
        sendLog(interaction.guild, 'audit', 'cyan', `Emoji Blacklist ${newStatus ? 'Enabled' : 'Disabled'}`,
            `**Admin:** \`${logName}\``
        );

        // When enabled, automatically sweep existing server items in the background
        if (newStatus && interaction.guild) {
            import('../../middleware/emoji-filter.js')
                .then(({ sweepServerEmojiViolations }) => sweepServerEmojiViolations(interaction.guild))
                .catch(() => {});
        }

        return renderEmojiModerationPanel(interaction);
    }

    // Open Emoji Blacklist panel
    if (customId === 'organize_emojis') {
        return renderEmojiModerationPanel(interaction);
    }

    // Main Organize Hub
    if (customId === 'settings_organize') {
        return showOrganizeMenu(interaction);
    }

    // Channel Filters panel
    if (customId === 'organize_filters') {
        return renderPanel(interaction, null);
    }

    // Interface navigation
    if (customId === 'organize_interface') {
        const { showInterfaceMainMenu } = await import('../interface.js');
        return showInterfaceMainMenu(interaction);
    }

    // Placeholder modules (Forums)
    if (customId === 'organize_forums') {
        return interaction.followUp({
            content: 'This module is coming soon.',
            flags: MessageFlags.Ephemeral
        });
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
