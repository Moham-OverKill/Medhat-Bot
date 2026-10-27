import {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelSelectMenuBuilder,
    ChannelType,
    MessageFlags
} from 'discord.js';
import { getLeaderboardConfig, setLeaderboardConfig } from '../leaderboard.js';
import { sendLog, checkLeaderboardPermissions, sysError } from '../../utils/logger.js';
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
        activity: { id: 'activity', name: 'Daily Activity', emoji: '🥈', menuEmoji: '🥈', dbId: 'daily_channel_id', titleMsgId: 'daily_title_message_id', msgId: 'daily_message_id', desc: 'Top active users today' },
        coins: { id: 'coins', name: `Total ${coinName}`, emoji: coinEmoji || '🪙', menuEmoji, dbId: 'coins_channel_id', titleMsgId: 'coins_title_message_id', msgId: 'coins_message_id', desc: 'Richest users in server' },
        streak: { id: 'streak', name: 'Highest Streak', emoji: '🔥', menuEmoji: '🔥', dbId: 'streak_channel_id', titleMsgId: 'streak_title_message_id', msgId: 'streak_message_id', desc: 'Top daily claim streaks' },
        level: { id: 'level', name: 'Highest Level', emoji: '⭐', menuEmoji: '⭐', dbId: 'level_channel_id', titleMsgId: 'level_title_message_id', msgId: 'level_message_id', desc: 'Top level & XP users' }
    };
}

/**
 * Main Leaderboard Settings Panel
 * Rows 1-4: Direct ChannelSelectMenus for each category (first-click assignment, re-select to toggle off)
 * Row 5: Action Buttons ([Send]/[Refresh], [Disable All], [Back])
 */
export async function handleLeaderboardSettings(interaction, configOverride = null, warningMessage = null) {
    try {
        const guildId = interaction.guildId;
        const config = configOverride || await getLeaderboardConfig(guildId) || {};
        const categories = await getCategories(guildId);

        let desc = '';
        if (warningMessage) {
            desc += `⚠️ **Notice:** ${warningMessage}\n\n`;
        }

        // Live verification of existing messages in Discord to detect manual message deletions
        let configChanged = false;
        for (const cat of Object.values(categories)) {
            const chanId = config[cat.dbId];
            if (chanId && config[cat.msgId]) {
                const targetChan = interaction.guild?.channels?.cache?.get(chanId) || await interaction.guild?.channels?.fetch(chanId).catch(() => null);
                if (targetChan) {
                    const existingMsg = targetChan.messages?.cache?.get?.(config[cat.msgId]) || await targetChan.messages?.fetch?.(config[cat.msgId]).catch(() => null);
                    if (!existingMsg) {
                        // Message was manually deleted in Discord; self-heal config so Publish state is restored
                        config[cat.msgId] = null;
                        config[cat.titleMsgId] = null;
                        configChanged = true;
                    }
                } else {
                    config[cat.msgId] = null;
                    config[cat.titleMsgId] = null;
                    configChanged = true;
                }
            }
        }

        if (configChanged) {
            await setLeaderboardConfig(guildId, config);
        }

        for (const cat of Object.values(categories)) {
            const chanId = config[cat.dbId];
            let statusLabel = '*Not Set*';
            if (chanId) {
                const targetChan = interaction.guild?.channels?.cache?.get(chanId);
                if (targetChan) {
                    const perm = checkLeaderboardPermissions(targetChan);
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
            .setTitle('Leaderboards')
            .setDescription(desc)
            .setColor(warningMessage ? 0xE74C3C : 0x3498DB);

        const components = [];
        const nonce = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

        // Rows 1-4: Direct Channel Select Menus (Placeholders strictly use menuEmoji to avoid raw custom emoji strings)
        for (const cat of Object.values(categories)) {
            const chanId = config[cat.dbId];
            const targetChan = chanId ? interaction.guild?.channels?.cache?.get(chanId) : null;
            const placeholderPrefix = cat.menuEmoji || '📊';
            const placeholderText = targetChan 
                ? `${placeholderPrefix} ${cat.name}: #${targetChan.name}`
                : (chanId ? `${placeholderPrefix} ${cat.name}: <#${chanId}>` : `${placeholderPrefix} Select ${cat.name} Channel...`);

            const channelSelect = new ChannelSelectMenuBuilder()
                .setCustomId(`lb_channel_${cat.id}_${nonce}`)
                .setPlaceholder(placeholderText.slice(0, 100))
                .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

            components.push(new ActionRowBuilder().addComponents(channelSelect));
        }

        // Row 5: Action Buttons ([Back], [Publish/Refresh], [Disable])
        const configuredCats = Object.values(categories).filter(c => Boolean(config[c.dbId]));
        const hasAnyConfigured = configuredCats.length > 0;
        // Button is 'Refresh' ONLY if at least 1 channel is configured AND all configured channels have active verified messages
        const isRefresh = hasAnyConfigured && configuredCats.every(c => config[c.msgId] && config[c.titleMsgId]);

        const backBtn = new ButtonBuilder()
            .setCustomId('settings_home')
            .setLabel('Back')
            .setEmoji('⬅️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(isBackDisabled(interaction));

        const sendRefreshBtn = new ButtonBuilder()
            .setCustomId('lb_action_send_refresh')
            .setLabel(isRefresh ? 'Refresh' : 'Publish')
            .setEmoji(isRefresh ? '🔁' : '🚀')
            .setStyle(isRefresh ? ButtonStyle.Primary : ButtonStyle.Success)
            .setDisabled(!hasAnyConfigured);

        const disableAllBtn = new ButtonBuilder()
            .setCustomId('lb_action_disable_all')
            .setLabel('Disable')
            .setEmoji('✖️')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(!hasAnyConfigured);

        // Standard server format: [Back] is strictly on the far left!
        components.push(new ActionRowBuilder().addComponents(backBtn, sendRefreshBtn, disableAllBtn));

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
 * Listener: Direct Channel Selection (Rows 1-4)
 * - If selecting the same channel again: toggles off / unsets that specific category.
 * - If selecting a new channel: updates DB without immediately auto-sending messages.
 */
export async function handleLeaderboardChannelSelect(interaction) {
    try {
        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
        const guildId = interaction.guildId;
        const selectedChannelId = interaction.values[0];

        // CustomId format: lb_channel_<categoryId>_<nonce> or lb_set_channel_<categoryId>
        const parts = interaction.customId.split('_');
        let categoryId = parts[2];
        if (!categoryId || categoryId === 'channel' || categoryId === 'set') {
            categoryId = parts[3];
        }

        const categories = await getCategories(guildId);
        const cat = categories[categoryId];
        if (!cat) return;

        let config = await getLeaderboardConfig(guildId) || {};
        const currentChannelId = config[cat.dbId];

        // TOGGLE REMOVAL: Selecting the same channel again removes/disables only this category
        if (selectedChannelId === currentChannelId) {
            if (currentChannelId) {
                try {
                    const chan = interaction.guild?.channels?.cache?.get(currentChannelId) || await interaction.guild?.channels?.fetch(currentChannelId).catch(() => null);
                    if (chan) {
                        if (config[cat.titleMsgId]) {
                            const titleMsg = await chan.messages.fetch(config[cat.titleMsgId]).catch(() => null);
                            if (titleMsg) await titleMsg.delete().catch(() => {});
                        }
                        if (config[cat.msgId]) {
                            const cardMsg = await chan.messages.fetch(config[cat.msgId]).catch(() => null);
                            if (cardMsg) await cardMsg.delete().catch(() => {});
                        }
                    }
                } catch (_) {}
            }

            config[cat.dbId] = null;
            config[cat.titleMsgId] = null;
            config[cat.msgId] = null;
            await setLeaderboardConfig(guildId, config);

            const logName = getUserLogName(interaction);
            sendLog(interaction.guild, 'audit', 'red', '📊 Leaderboard Disabled', 
                `**Admin:** \`${logName}\`\n` +
                `**Action:** Disabled the **${cat.name}** leaderboard.`
            );

            return handleLeaderboardSettings(interaction, config);
        }

        // NEW CHANNEL ASSIGNMENT: Proactive Permission Validation
        const channel = interaction.guild?.channels?.cache?.get(selectedChannelId) || await interaction.guild?.channels?.fetch(selectedChannelId).catch(() => null);
        const permissionCheck = checkLeaderboardPermissions(channel);
        if (!permissionCheck.valid) {
            return handleLeaderboardSettings(interaction, config, `Cannot assign <#${selectedChannelId}>: ${permissionCheck.error}`);
        }

        // Cleanup old channel messages if moving this category from a different channel
        if (currentChannelId && currentChannelId !== selectedChannelId) {
            try {
                const oldChan = interaction.guild?.channels?.cache?.get(currentChannelId) || await interaction.guild?.channels?.fetch(currentChannelId).catch(() => null);
                if (oldChan) {
                    if (config[cat.titleMsgId]) {
                        const oldTitleMsg = await oldChan.messages.fetch(config[cat.titleMsgId]).catch(() => null);
                        if (oldTitleMsg) await oldTitleMsg.delete().catch(() => {});
                    }
                    if (config[cat.msgId]) {
                        const oldCardMsg = await oldChan.messages.fetch(config[cat.msgId]).catch(() => null);
                        if (oldCardMsg) await oldCardMsg.delete().catch(() => {});
                    }
                }
            } catch (_) {}
        }

        // Update DB with the new channel assignment (Do NOT auto-send messages yet)
        config[cat.dbId] = selectedChannelId;
        config[cat.titleMsgId] = null;
        config[cat.msgId] = null;
        await setLeaderboardConfig(guildId, config);

        const logName = getUserLogName(interaction);
        sendLog(interaction.guild, 'audit', 'cyan', '📊 Leaderboard Config Changed', 
            `**Admin:** \`${logName}\`\n` +
            `**Type:** \`${cat.name}\`\n` +
            `**Action:** Set channel to ${channel || `<#${selectedChannelId}>`}`
        );

        return handleLeaderboardSettings(interaction, config);
    } catch (error) {
        sysError('Leaderboard channel select failed', error, { user: interaction.user.id, guild: interaction.guildId });
        return handleInteractionError(interaction, error, 'Leaderboard Channel Select');
    }
}

/**
 * Listener: Batch Send / Refresh Action (Row 5 Button 1)
 * Atomic dispatch: synchronizes roles and sends or refreshes configured channels.
 */
export async function handleLeaderboardBatchSendOrRefresh(interaction) {
    try {
        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
        const guildId = interaction.guildId;
        const config = await getLeaderboardConfig(guildId) || {};
        const categories = await getCategories(guildId);
        const hasConfigured = Object.values(categories).some(c => Boolean(config[c.dbId]));

        if (!hasConfigured) {
            return handleLeaderboardSettings(interaction, config, 'Please assign at least one channel first before sending or refreshing.');
        }

        // 1. Synchronize MVP roles in Discord immediately without paying extra coins
        const { runKingOfHillCycle } = await import('../../mvp/kingOfHill.js');
        await runKingOfHillCycle(interaction.client, guildId, { payCoins: false }).catch(err => {
            sysError('KotH Role Sync Error on Send/Refresh', err, { guild: guildId });
        });

        // 2. Synchronize Richest & Streak roles in Discord
        const { applyRichestRole, applyStreakRole } = await import('../../mvp/role-assignment.js');
        await applyRichestRole(interaction.client, guildId).catch(() => {});
        await applyStreakRole(interaction.client, guildId).catch(() => {});

        // 3. Atomically dispatch missing messages or edit cards in-place
        const { updateLeaderboards } = await import('../leaderboard.js');
        await updateLeaderboards(interaction.client, guildId, null, []);

        // Audit Log
        const logName = getUserLogName(interaction);
        sendLog(interaction.guild, 'audit', 'blue', '🔄 Leaderboards Refreshed', 
            `**Admin:** \`${logName}\`\n` +
            `**Action:** Dispatched / refreshed leaderboard channels and synchronized roles.`
        );

        return handleLeaderboardSettings(interaction);
    } catch (error) {
        sysError('Leaderboard batch send/refresh failed', error, { user: interaction.user.id, guild: interaction.guildId });
        if (!interaction.replied) {
            return handleInteractionError(interaction, error, 'Leaderboard Batch Send/Refresh');
        }
    }
}

/**
 * Listener: Disable All Action (Row 5 Button 2)
 * Cleans up all active messages across all 4 categories from Discord channels and clears DB.
 */
export async function handleLeaderboardDisableAll(interaction) {
    try {
        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
        const guildId = interaction.guildId;
        let config = await getLeaderboardConfig(guildId) || {};
        const categories = await getCategories(guildId);

        for (const cat of Object.values(categories)) {
            const chanId = config[cat.dbId];
            if (chanId) {
                try {
                    const chan = interaction.guild?.channels?.cache?.get(chanId) || await interaction.guild?.channels?.fetch(chanId).catch(() => null);
                    if (chan) {
                        if (config[cat.titleMsgId]) {
                            const titleMsg = await chan.messages.fetch(config[cat.titleMsgId]).catch(() => null);
                            if (titleMsg) await titleMsg.delete().catch(() => {});
                        }
                        if (config[cat.msgId]) {
                            const cardMsg = await chan.messages.fetch(config[cat.msgId]).catch(() => null);
                            if (cardMsg) await cardMsg.delete().catch(() => {});
                        }
                    }
                } catch (_) {}
            }
            config[cat.dbId] = null;
            config[cat.titleMsgId] = null;
            config[cat.msgId] = null;
        }

        await setLeaderboardConfig(guildId, config);

        const logName = getUserLogName(interaction);
        sendLog(interaction.guild, 'audit', 'red', '📊 Leaderboard Disabled', 
            `**Admin:** \`${logName}\`\n` +
            `**Action:** Disabled all leaderboards and cleared channel configurations.`
        );

        return handleLeaderboardSettings(interaction, config);
    } catch (error) {
        sysError('Leaderboard disable all failed', error, { user: interaction.user.id, guild: interaction.guildId });
        return handleInteractionError(interaction, error, 'Leaderboard Disable All');
    }
}

// Backwards-compatible aliases
export const handleLeaderboardRefresh = handleLeaderboardBatchSendOrRefresh;
export const handleLeaderboardDisable = handleLeaderboardDisableAll;
export async function handleLeaderboardMenuAction(interaction) {
    return handleLeaderboardSettings(interaction);
}
export async function handleLeaderboardCategorySelect(interaction) {
    return handleLeaderboardSettings(interaction);
}
