import {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    ChannelSelectMenuBuilder,
    ChannelType,
    MessageFlags,
    PermissionFlagsBits
} from 'discord.js';
import { getLeaderboardConfig, setLeaderboardConfig, sendSingleLeaderboard } from '../leaderboard.js';
import { sendLog, checkChannelPermissions, sysError } from '../../utils/logger.js';
import { handleInteractionError } from '../../utils/errors.js';
import { getUserLogName } from '../../shared.js';



/**
 * Smart Leaderboard Categories
 */
const CATEGORIES = {
    activity: { id: 'activity', name: 'Daily Activity', emoji: '🥈', dbId: 'daily_channel_id', msgId: 'daily_message_id', desc: 'Top active users today' },
    coins: { id: 'coins', name: 'Total Coins', emoji: '💰', dbId: 'coins_channel_id', msgId: 'coins_message_id', desc: 'Richest users in server' },
    streak: { id: 'streak', name: 'Highest Streak', emoji: '🔥', dbId: 'streak_channel_id', msgId: 'streak_message_id', desc: 'Top daily claim streaks' },
    level: { id: 'level', name: 'Highest Level', emoji: '⭐', dbId: 'level_channel_id', msgId: 'level_message_id', desc: 'Top level & XP users' }
};

/**
 * Main Leaderboard Settings Panel
 * Mirroring Logs UI style exactly, but preserving Leaderboard logic
 */
export async function handleLeaderboardSettings(interaction, selectedId = null, configOverride = null) {
    try {
        const guildId = interaction.guildId;
        const config = configOverride || await getLeaderboardConfig(guildId) || {};

        // Mirror Logs UI Style
        let desc = '';
        for (const cat of Object.values(CATEGORIES)) {
            const chanId = config[cat.dbId];
            const statusLabel = chanId ? `<#${chanId}>` : '*Not Set*';
            desc += `**${cat.emoji} ${cat.name}**\n↳ ${statusLabel}\n\n`;
        }

        const embed = new EmbedBuilder()
            .setTitle('📊 Leaderboard Configuration')
            .setDescription(desc)
            .setColor(selectedId ? 0xF1C40F : 0x3498DB); // Sync with Logs color (Yellow if selected, Blue if home)

        const components = [];

        // Row 1: The Dropdown (Categorized selection)
        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('lb_type_select')
            .setPlaceholder('1. Select a Leaderboard to configure...')
            .addOptions(Object.values(CATEGORIES).map(cat => ({
                label: cat.name,
                description: cat.desc,
                value: cat.id,
                emoji: cat.emoji,
                default: selectedId === cat.id
            })));
        components.push(new ActionRowBuilder().addComponents(selectMenu));

        // Logic for Category-Specific Controls
        if (selectedId && CATEGORIES[selectedId]) {
            const active = CATEGORIES[selectedId];
            const chan = config[active.dbId];

            // Row 2: Channel Selection
            const channelSelect = new ChannelSelectMenuBuilder()
                .setCustomId(`lb_set_channel_${active.id}`)
                .setPlaceholder(`2. Select a channel for ${active.name}...`)
                .setChannelTypes(ChannelType.GuildText);
            components.push(new ActionRowBuilder().addComponents(channelSelect));

            // Row 3: Navigation & Disable
            const disableButton = new ButtonBuilder()
                .setCustomId(`lb_disable_${active.id}`)
                .setLabel('Disable')
                .setEmoji('✖️')
                .setStyle(ButtonStyle.Danger)
                .setDisabled(!chan);

            const backButton = new ButtonBuilder()
                .setCustomId('settings_leaderboards')
                .setLabel('Back')
                .setEmoji('⬅️')
                .setStyle(ButtonStyle.Secondary);

            components.push(new ActionRowBuilder().addComponents(backButton, disableButton));
        } else {
            // Home Panel Navigation
            const backButton = new ButtonBuilder()
                .setCustomId('settings_other')
                .setLabel('Back')
                .setEmoji('⬅️')
                .setStyle(ButtonStyle.Secondary);

            const refreshButton = new ButtonBuilder()
                .setCustomId('lb_refresh')
                .setLabel('Force Refresh Now')
                .setEmoji('🔄')
                .setStyle(ButtonStyle.Primary);

            components.push(new ActionRowBuilder().addComponents(backButton, refreshButton));
        }

        const method = (interaction.deferred || interaction.replied) ? 'editReply' : 'update';
        await interaction[method]({ embeds: [embed], components, content: '' });
    } catch (error) {
        sysError('Leaderboard settings panel failed', error, { user: interaction.user.id, guild: interaction.guildId });
        const err = { content: '❌ Error loading settings.', flags: MessageFlags.Ephemeral };
        if (interaction.deferred || interaction.replied) await interaction.followUp(err).catch(() => {});
        else await interaction.reply(err).catch(() => {});
    }
}

/**
 * Listener: Category Select
 */
export async function handleLeaderboardCategorySelect(interaction) {
    try {
        const selectedId = interaction.values[0];
        return handleLeaderboardSettings(interaction, selectedId);
    } catch (error) {
        sysError('Leaderboard category select failed', error, { user: interaction.user.id, guild: interaction.guildId });
        return handleInteractionError(interaction, error, 'Leaderboard Category Select');
    }
}

/**
 * Listener: Channel Selection
 */
export async function handleLeaderboardChannelSelect(interaction) {
    try {
        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
        const guildId = interaction.guildId;
        const channelId = interaction.values[0];
        const categoryId = interaction.customId.replace('lb_set_channel_', '');
        
        if (!CATEGORIES[categoryId]) return;
        const cat = CATEGORIES[categoryId];

        // Proactive Permission Check
        const channel = interaction.guild.channels.cache.get(channelId) || await interaction.guild.channels.fetch(channelId).catch(() => null);
        const permissionCheck = checkChannelPermissions(channel);
        if (!permissionCheck.valid) {
            return interaction.followUp({ 
                content: `❌ **I can't use that channel.** ${permissionCheck.error}\nPlease make sure I have permission to **View Channel** and **Send Messages** there.`,
                flags: MessageFlags.Ephemeral
            });
        }

        let config = await getLeaderboardConfig(guildId) || {};

        // Send new leaderboard
        const nextMsgId = await sendSingleLeaderboard(interaction.client, guildId, cat.id, channelId);
        
        // Update DB
        config[cat.dbId] = channelId;
        config[cat.msgId] = nextMsgId;
        await setLeaderboardConfig(guildId, config);

        // Audit Log
        const logName = getUserLogName(interaction);
        sendLog(interaction.guild, 'audit', 'cyan', '📊 Leaderboard Config Changed', 
            `**Admin:** \`${logName}\`\n` +
            `**Type:** \`${cat.name}\`\n` +
            `**Action:** Set channel to ${channel}`
        );

        return handleLeaderboardSettings(interaction, cat.id, config);
    } catch (error) {
        sysError('Leaderboard channel select failed', error, { user: interaction.user.id, guild: interaction.guildId });
        return handleInteractionError(interaction, error, 'Leaderboard Channel Select');
    }
}

/**
 * Listener: Per-Category Disable
 */
export async function handleLeaderboardDisable(interaction) {
    try {
        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
        const guildId = interaction.guildId;
        const categoryId = interaction.customId.replace('lb_disable_', '');
        if (!CATEGORIES[categoryId]) return;
        const cat = CATEGORIES[categoryId];

        let config = await getLeaderboardConfig(guildId) || {};
        const oldChan = config[cat.dbId];
        const oldMsg = config[cat.msgId];

        // Cleanup msg upon disable
        if (oldMsg && oldChan) {
            try {
                const chan = await interaction.guild.channels.fetch(oldChan).catch(() => null);
                if (chan) {
                    const { sweepLeaderboardChannel } = await import('../leaderboard.js');
                    await sweepLeaderboardChannel(chan, cat.name);
                    const msg = await chan.messages.fetch(oldMsg).catch(() => null);
                    if (msg) await msg.delete().catch(() => {});
                }
            } catch {}
        }

        config[cat.dbId] = null;
        config[cat.msgId] = null;
        await setLeaderboardConfig(guildId, config);

        if (oldChan) {
            const logName = getUserLogName(interaction);
            sendLog(interaction.guild, 'audit', 'red', '📊 Leaderboard Disabled', 
                `**Admin:** \`${logName}\`\n` +
                `**Action:** Disabled the **${cat.name}** leaderboard.`
            );
        }

        return handleLeaderboardSettings(interaction, cat.id, config);
    } catch (error) {
        sysError('Leaderboard disable failed', error, { user: interaction.user.id, guild: interaction.guildId });
        return handleInteractionError(interaction, error, 'Leaderboard Disable');
    }
}

/**
 * Listener: Refresh All
 */
export async function handleLeaderboardRefresh(interaction) {
    try {
        // Send immediate ephemeral feedback so admin knows it's happening
        await interaction.reply({ 
            content: '🔄 **Force Refresh Triggered.** Updating all leaderboard channels...', 
            flags: MessageFlags.Ephemeral 
        });

        const { updateLeaderboards } = await import('../leaderboard.js');
        await updateLeaderboards(interaction.client, interaction.guildId, null, []);
        
        // Audit Log
        const logName = getUserLogName(interaction);
        sendLog(interaction.guild, 'audit', 'blue', '🔄 Leaderboards Refreshed', 
            `**Admin:** \`${logName}\`\n` +
            `**Action:** Manually forced a refresh of all leaderboard channels.`
        );

        // Final notification
        return interaction.followUp({ 
            content: '✅ All leaderboard channels have been successfully updated.', 
            flags: MessageFlags.Ephemeral 
        });
    } catch (error) {
        sysError('Leaderboard manual refresh failed', error, { user: interaction.user.id, guild: interaction.guildId });
        return handleInteractionError(interaction, error, 'Leaderboard Refresh');
    }
}

/**
 * Helper: Cairo Next Midnight
 */
function getNextMidnightCairoTimestamp() {
    const now = new Date();
    const cairoFormatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Africa/Cairo',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false
    });
    const parts = cairoFormatter.formatToParts(now);
    const v = {};
    for (const p of parts) v[p.type] = p.value;
    const offset = 2 * 60 * 60 * 1000;
    const midUTCTested = new Date(Date.UTC(parseInt(v.year), parseInt(v.month) - 1, parseInt(v.day), 0, 0, 0, 0));
    let midUTC = new Date(midUTCTested.getTime() - offset);
    if (now >= midUTC) midUTC = new Date(midUTC.getTime() + 24 * 60 * 60 * 1000);
    return Math.floor(midUTC.getTime() / 1000);
}
