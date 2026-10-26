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
import { getLeaderboardConfig, setLeaderboardConfig, sendSingleLeaderboard } from '../leaderboard.js';
import { sendLog, checkChannelPermissions, sysError } from '../../utils/logger.js';
import { handleInteractionError } from '../../utils/errors.js';
import { getUserLogName, getCurrencyName, COIN_EMOJI, isBackDisabled } from '../../shared.js';

/**
 * Smart Leaderboard Categories Helper
 */
export async function getCategories(guildId) {
    const coinName = await getCurrencyName(guildId);
    const coinEmoji = COIN_EMOJI.forGuild(guildId);
    const isUnicode = Boolean(coinEmoji && !coinEmoji.startsWith('<'));
    const menuEmoji = isUnicode ? coinEmoji : '🪙';
    return {
        activity: { id: 'activity', name: 'Daily Activity', emoji: '🥈', menuEmoji: '🥈', dbId: 'daily_channel_id', msgId: 'daily_message_id', desc: 'Top active users today' },
        coins: { id: 'coins', name: `Total ${coinName}`, emoji: coinEmoji || '🪙', menuEmoji, dbId: 'coins_channel_id', msgId: 'coins_message_id', desc: 'Richest users in server' },
        streak: { id: 'streak', name: 'Highest Streak', emoji: '🔥', menuEmoji: '🔥', dbId: 'streak_channel_id', msgId: 'streak_message_id', desc: 'Top daily claim streaks' },
        level: { id: 'level', name: 'Highest Level', emoji: '⭐', menuEmoji: '⭐', dbId: 'level_channel_id', msgId: 'level_message_id', desc: 'Top level & XP users' }
    };
}

/**
 * Main Leaderboard Settings Panel
 * 4 category select menus with 3 options each + single Back button
 */
export async function handleLeaderboardSettings(interaction, selectedId = null, configOverride = null, warningMessage = null) {
    try {
        const guildId = interaction.guildId;
        const config = configOverride || await getLeaderboardConfig(guildId) || {};
        const categories = await getCategories(guildId);

        let desc = '';
        if (warningMessage) {
            desc += `⚠️ **Notice:** ${warningMessage}\n\n`;
        }

        for (const cat of Object.values(categories)) {
            const chanId = config[cat.dbId];
            let statusLabel = '*Not Set*';
            if (chanId) {
                const targetChan = interaction.guild?.channels?.cache?.get(chanId);
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
            .setTitle('Leaderboard Configuration')
            .setDescription(desc)
            .setColor(warningMessage ? 0xE74C3C : (selectedId ? 0xF1C40F : 0x3498DB));

        const components = [];

        // If a specific category was clicked to "Select A Channel", show channel picker + Back
        if (selectedId && categories[selectedId]) {
            const active = categories[selectedId];

            // Row 1: Channel selection dropdown
            const channelSelect = new ChannelSelectMenuBuilder()
                .setCustomId(`lb_set_channel_${active.id}`)
                .setPlaceholder(`Select a channel for ${active.name}...`)
                .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
            components.push(new ActionRowBuilder().addComponents(channelSelect));

            // Row 2: Single Back button returning to 4-menu view
            const backButton = new ButtonBuilder()
                .setCustomId('settings_leaderboards')
                .setLabel('Back')
                .setEmoji('⬅️')
                .setStyle(ButtonStyle.Secondary);
            components.push(new ActionRowBuilder().addComponents(backButton));
        } else {
            // Main View: 4 Select Menus (Rows 1-4) with 3 options each
            const nonce = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
            for (const cat of Object.values(categories)) {
                const menu = new StringSelectMenuBuilder()
                    .setCustomId(`lb_menu_${cat.id}_${nonce}`)
                    .setPlaceholder(`${cat.menuEmoji || '📊'} ${cat.name}...`)
                    .addOptions([
                        {
                            label: 'Select A Channel',
                            value: 'channel',
                            emoji: '💬',
                            default: false
                        },
                        {
                            label: 'Force Refresh',
                            value: 'refresh',
                            emoji: '🔁',
                            default: false
                        },
                        {
                            label: 'Disable',
                            value: 'disable',
                            emoji: '❌',
                            default: false
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
        sysError('Leaderboard settings panel failed', error, { user: interaction.user.id, guild: interaction.guildId });
        const err = { content: '❌ Error loading settings.', flags: MessageFlags.Ephemeral };
        if (interaction.deferred || interaction.replied) await interaction.followUp(err).catch(() => {});
        else await interaction.reply(err).catch(() => {});
    }
}

/**
 * Handle 3-Option Select Menu actions (Select A Channel, Force Refresh, Disable)
 */
export async function handleLeaderboardMenuAction(interaction) {
    try {
        const customId = interaction.customId; // lb_menu_CATEGORY or lb_menu_CATEGORY_NONCE
        const raw = customId.replace('lb_menu_', '');
        const categoryId = raw.split('_')[0];
        const action = interaction.values[0]; // channel | refresh | disable
        const guildId = interaction.guildId;

        const categories = await getCategories(guildId);
        const cat = categories[categoryId];
        if (!cat) return;

        if (action === 'channel') {
            // Open Channel Selection view
            return handleLeaderboardSettings(interaction, cat.id);
        }

        if (action === 'refresh') {
            const config = await getLeaderboardConfig(guildId) || {};
            const chanId = config[cat.dbId];

            if (!chanId) {
                return handleLeaderboardSettings(interaction, cat.id, null, `Please assign a channel for **${cat.name}** leaderboard first before refreshing.`);
            }

            // Immediately reset the settings panel UI so the select menu snaps back to placeholder instantly
            await handleLeaderboardSettings(interaction);

            // Synchronize roles and trigger visual leaderboard card update
            await handleLeaderboardRefresh(interaction, cat.id);
            return;
        }

        if (action === 'disable') {
            if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
            let config = await getLeaderboardConfig(guildId) || {};
            const oldChan = config[cat.dbId];
            const oldMsg = config[cat.msgId];

            if (!oldChan) {
                return handleLeaderboardSettings(interaction);
            }

            // Cleanup old message from Discord channel
            if (oldMsg && oldChan) {
                try {
                    const chan = await interaction.guild.channels.fetch(oldChan).catch(() => null);
                    if (chan) {
                        const msg = await chan.messages.fetch(oldMsg).catch(() => null);
                        if (msg) await msg.delete().catch(() => {});
                    }
                } catch {}
            }

            config[cat.dbId] = null;
            config[cat.msgId] = null;
            await setLeaderboardConfig(guildId, config);

            const logName = getUserLogName(interaction);
            sendLog(interaction.guild, 'audit', 'red', '📊 Leaderboard Disabled', 
                `**Admin:** \`${logName}\`\n` +
                `**Action:** Disabled the **${cat.name}** leaderboard.`
            );

            return handleLeaderboardSettings(interaction, null, config);
        }
    } catch (error) {
        sysError('Leaderboard menu action failed', error, { user: interaction.user.id, guild: interaction.guildId });
        return handleInteractionError(interaction, error, 'Leaderboard Menu Action');
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
        const categoryId = interaction.customId
            .replace('lb_set_channel_', '')
            .replace('leaderboard_channel_', '')
            .replace('lb_assign_', '');
        
        const categories = await getCategories(guildId);
        if (!categories[categoryId]) return;
        const cat = categories[categoryId];

        // Proactive Permission Check
        const channel = interaction.guild.channels.cache.get(channelId) || await interaction.guild.channels.fetch(channelId).catch(() => null);
        const permissionCheck = checkChannelPermissions(channel);
        if (!permissionCheck.valid) {
            return handleLeaderboardSettings(interaction, cat.id, null, `Cannot assign <#${channelId}>: ${permissionCheck.error}`);
        }

        let config = await getLeaderboardConfig(guildId) || {};

        // Cleanup old message if reassigning
        const oldChanId = config[cat.dbId];
        const oldMsgId = config[cat.msgId];
        if (oldMsgId && oldChanId) {
            try {
                const oldChan = interaction.guild.channels.cache.get(oldChanId) || await interaction.guild.channels.fetch(oldChanId).catch(() => null);
                if (oldChan) {
                    const oldMsg = await oldChan.messages.fetch(oldMsgId).catch(() => null);
                    if (oldMsg) await oldMsg.delete().catch(() => {});
                }
            } catch {}
        }

        // Send new leaderboard
        const nextMsgId = await sendSingleLeaderboard(interaction.client, guildId, cat.id, channelId);
        if (!nextMsgId) {
            return handleLeaderboardSettings(interaction, cat.id, null, `Could not send message to <#${channelId}>`);
        }
        
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

        // Return back to the main 4-menu view
        return handleLeaderboardSettings(interaction, null, config);
    } catch (error) {
        sysError('Leaderboard channel select failed', error, { user: interaction.user.id, guild: interaction.guildId });
        return handleInteractionError(interaction, error, 'Leaderboard Channel Select');
    }
}

/**
 * Listener: Refresh All or Specific Category
 */
export async function handleLeaderboardRefresh(interaction, targetCategory = null) {
    try {
        // 1. Synchronize MVP roles in Discord immediately without paying extra coins
        const { runKingOfHillCycle } = await import('../../mvp/kingOfHill.js');
        await runKingOfHillCycle(interaction.client, interaction.guildId, { payCoins: false }).catch(err => {
            sysError('KotH Role Sync Error on Refresh', err, { guild: interaction.guildId });
        });

        // 2. Synchronize Richest & Streak roles in Discord
        const { applyRichestRole, applyStreakRole } = await import('../../mvp/role-assignment.js');
        await applyRichestRole(interaction.client, interaction.guildId).catch(() => {});
        await applyStreakRole(interaction.client, interaction.guildId).catch(() => {});

        // 3. Update leaderboard channel embeds
        const { updateLeaderboards } = await import('../leaderboard.js');
        await updateLeaderboards(interaction.client, interaction.guildId, null, []);
        
        // Audit Log
        const logName = getUserLogName(interaction);
        sendLog(interaction.guild, 'audit', 'blue', '🔄 Leaderboards Refreshed', 
            `**Admin:** \`${logName}\`\n` +
            `**Action:** Manually triggered refresh of leaderboard channels and synchronized roles.`
        );
    } catch (error) {
        sysError('Leaderboard manual refresh failed', error, { user: interaction.user.id, guild: interaction.guildId });
        if (!interaction.replied) {
            return handleInteractionError(interaction, error, 'Leaderboard Refresh');
        }
    }
}


/**
 * Listener: Category Select (Legacy compatibility)
 */
export async function handleLeaderboardCategorySelect(interaction) {
    const selectedId = interaction.values[0];
    return handleLeaderboardSettings(interaction, selectedId);
}

/**
 * Listener: Per-Category Disable
 */
export async function handleLeaderboardDisable(interaction, targetCategoryId = null) {
    try {
        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
        const guildId = interaction.guildId;
        const categoryId = targetCategoryId || interaction.customId
            .replace('lb_disable_', '')
            .replace('leaderboard_disable_', '');
        const categories = await getCategories(guildId);
        if (!categories[categoryId]) return;
        const cat = categories[categoryId];

        let config = await getLeaderboardConfig(guildId) || {};
        const oldChan = config[cat.dbId];
        const oldMsg = config[cat.msgId];

        if (oldMsg && oldChan) {
            try {
                const chan = await interaction.guild.channels.fetch(oldChan).catch(() => null);
                if (chan) {
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

        return handleLeaderboardSettings(interaction, null, config);
    } catch (error) {
        sysError('Leaderboard disable failed', error, { user: interaction.user.id, guild: interaction.guildId });
        return handleInteractionError(interaction, error, 'Leaderboard Disable');
    }
}
