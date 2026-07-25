import {
    SlashCommandBuilder,
    MessageFlags,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    PermissionFlagsBits,
    ChannelSelectMenuBuilder,
    ChannelType,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} from 'discord.js';
import { getGuildConfig, setGuildConfig } from '../storage/config.js';
import { sendLog, sysLog, sysError } from '../utils/logger.js';
import { showSetupPanel as showMvpPanel, handleMvpComponent } from './mvp.js';
import { handleShopSetup as showShopPanel } from './shop-setup.js';
import { handleRewardsSetup as showRewardsPanel, handleRewardsComponent } from './rewards.js';
import { showColorPanel as showColorsPanel, handleColorsComponent } from './colors.js';
import { getLeaderboardConfig, setLeaderboardConfig, sendSingleLeaderboard } from './leaderboard.js';
import { 
    handleLeaderboardSettings, 
    handleLeaderboardCategorySelect, 
    handleLeaderboardChannelSelect as handleLeaderboardChannelSelectV2,
    handleLeaderboardRefresh as handleLeaderboardRefreshV2,
    handleLeaderboardDisable
} from './settings/leaderboards.js';
import { showUserSelector, handleAdminUserComponent } from './admin-users.js';
import { showRoleRewardsMenu, handleRoleRewardsComponent } from './settings/role-rewards.js';
import { handleLogsSettings, handleLogCategorySelect, handleLogChannelSelect, handleLogDisable } from './settings/logs.js';
import { handleEconomySettings } from './settings/economy.js';
import { handleOrganizeComponent } from './settings/organize.js';
import { handleQuestsComponent } from './quests-dashboard.js';
import { handleInteractionError } from '../utils/errors.js';
import { COIN_EMOJI, getUserLogName } from '../shared.js';

// /settings command - unified control panel
export const settingsCommand = new SlashCommandBuilder()
    .setName('settings')
    .setDescription('Open the server control panel')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false);

/**
 * Handle /settings command
 */
export async function handleSettingsCommand(interaction) {
  const guildName = interaction.guild?.name || 'Unknown Server';
  sysLog('Settings Dashboard opened', { user: interaction.user.id, guild: interaction.guildId });

    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({
            content: '🚫 You do not have permission to view the dashboard.',
            flags: MessageFlags.Ephemeral
        });
    }
    if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await showMainMenu(interaction);
}

/**
 * Show the main settings menu
 */
export async function showMainMenu(interaction) {
    const embed = new EmbedBuilder()
        .setTitle('⚙️ Control Panel')
        .setDescription('Select a module to configure.')
        .setColor(0x2F3136);

    // Row 1: Colors - Shop - Coins
    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('settings_colors')
            .setLabel('Colors')
            .setEmoji('🎨')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('settings_shop')
            .setLabel('Shop')
            .setEmoji('🛒')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('settings_coins')
            .setLabel('Coins')
            .setEmoji(`${COIN_EMOJI}`)
            .setStyle(ButtonStyle.Secondary)
    );

    // Row 2: Users - Leaderboard - Other
    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('settings_users')
            .setLabel('Users')
            .setEmoji('👥')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('settings_leaderboards')
            .setLabel('Leaderboard')
            .setEmoji('📊')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('settings_other')
            .setLabel('Other')
            .setEmoji('⚙️')
            .setStyle(ButtonStyle.Secondary)
    );

    const responseMethod = (interaction.deferred || interaction.replied)
        ? 'editReply'
        : (interaction.isButton() ? 'update' : 'editReply');

    await interaction[responseMethod]({
        content: '',
        embeds: [embed],
        components: [row1, row2]
    });
}

/**
 * Show the Coins Sub-Menu (Daily & Rewards Modules)
 */
export async function showCoinsSubMenu(interaction) {
    const embed = new EmbedBuilder()
        .setTitle('🪙 Coins Management')
        .setDescription('Manage your server\'s daily claims and reward modules.')
        .setColor(0x2F3136);

    // Row 1: Daily, Quests, Give Coins
    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('settings_daily')
            .setLabel('Daily')
            .setEmoji('📅')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('quests_dashboard')
            .setLabel('Quests')
            .setEmoji('🎯')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('rewards_give_btn')
            .setLabel('Give Coins')
            .setEmoji('💸')
            .setStyle(ButtonStyle.Success)
    );

    // Row 2: Back, Vote, Tag
    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('settings_home')
            .setLabel('Back')
            .setEmoji('⬅️')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('settings_vote_reward')
            .setLabel('Vote')
            .setEmoji('🗳️')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('settings_tag_reward')
            .setLabel('Tag')
            .setEmoji('🏷️')
            .setStyle(ButtonStyle.Secondary)
    );

    const responseMethod = interaction.isButton() ? 'update' : 'editReply';
    await interaction[responseMethod]({
        content: '',
        embeds: [embed],
        components: [row1, row2]
    });
}

/**
 * Show the Other Sub-Menu (Logs, Economy, Organize, Customize)
 */
export async function showOtherSubMenu(interaction) {
    const embed = new EmbedBuilder()
        .setTitle('⚙️ Other Settings')
        .setDescription('Configure additional server utilities.')
        .setColor(0x2F3136);

    // Row 1: Logs - Economy
    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('settings_logs')
            .setLabel('Logs')
            .setEmoji('📜')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('settings_economy')
            .setLabel('Economy')
            .setEmoji('📈')
            .setStyle(ButtonStyle.Secondary)
    );

    // Row 2: Organize - Customize
    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('settings_organize')
            .setLabel('Organize')
            .setEmoji('🧹')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('settings_customize')
            .setLabel('Customize')
            .setEmoji('✨')
            .setStyle(ButtonStyle.Secondary)
    );

    // Row 3: Back
    const row3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('settings_home')
            .setLabel('Back')
            .setEmoji('⬅️')
            .setStyle(ButtonStyle.Secondary)
    );

    const responseMethod = interaction.isButton() ? 'update' : 'editReply';
    await interaction[responseMethod]({
        content: '',
        embeds: [embed],
        components: [row1, row2, row3]
    });
}

/**
 * Handle settings component interactions (navigation)
 */
export async function handleSettingsComponent(interaction) {
    try {
        // Runtime guard: verify Administrator permission in THIS guild
        if (!interaction.member?.permissions.has(PermissionFlagsBits.Administrator)) {
            const deny = { content: '⛔ Administrator permission required.', flags: MessageFlags.Ephemeral };
            if (interaction.deferred || interaction.replied) return interaction.followUp(deny);
            return interaction.reply(deny);
        }

        const customId = interaction.customId;

        // Handle back button from any module
        if (customId === 'settings_back' || customId === 'settings_home') {
            await showMainMenu(interaction);
            return;
        }

        // Navigation to main modules
        if (customId === 'settings_coins') {
            await showCoinsSubMenu(interaction);
            return;
        }


        if (customId === 'settings_other') {
            await showOtherSubMenu(interaction);
            return;
        }

        if (customId === 'settings_customize') {
            const { getGuildConfig } = await import('../storage/config.js');
            const config = await getGuildConfig(interaction.guildId) || {};
            
            const currentEmoji = config.coin_emoji;
            let initialValue = '';
            if (currentEmoji) {
                const currentEmojiStr = typeof currentEmoji === 'string' ? currentEmoji : currentEmoji.toString();
                const match = currentEmojiStr.match(/:(\d+)>$/);
                initialValue = match ? match[1] : currentEmojiStr;
            }

            const botMember = interaction.guild.members.me || await interaction.guild.members.fetch(interaction.client.user.id).catch(() => null);
            const currentNickname = config.bot_nickname !== undefined ? (config.bot_nickname || '') : (botMember ? (botMember.nickname || '') : '');
            const currentServerAvatar = config.bot_avatar !== undefined ? (config.bot_avatar || '') : '';

            const modal = new ModalBuilder().setCustomId('settings_customize_modal').setTitle('Customize Bot');
            
            const nameInput = new TextInputBuilder()
                .setCustomId('bot_name')
                .setLabel('Bot Server Nickname')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('Enter bot nickname for this server')
                .setValue(currentNickname)
                .setRequired(false);

            const avatarInput = new TextInputBuilder()
                .setCustomId('bot_avatar')
                .setLabel('Bot Server Avatar URL')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('Enter profile image URL for this server')
                .setValue(currentServerAvatar)
                .setRequired(false);

            const emojiInput = new TextInputBuilder()
                .setCustomId('coin_emoji')
                .setLabel('Coin Emoji ID')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('Enter server emoji ID (e.g. 1343686075385647164)')
                .setValue(initialValue)
                .setRequired(false);

            modal.addComponents(
                new ActionRowBuilder().addComponents(nameInput),
                new ActionRowBuilder().addComponents(avatarInput),
                new ActionRowBuilder().addComponents(emojiInput)
            );
            await interaction.showModal(modal);
            return;
        }

        if (customId === 'settings_daily') {
            await showRewardsPanel(interaction);
            return;
        }

        if (customId === 'settings_vote_reward') {
            const { getGuildConfig } = await import('../storage/config.js');
            const config = await getGuildConfig(interaction.guildId) || {};
            const modal = new ModalBuilder().setCustomId('settings_vote_modal').setTitle('Vote Reward');
            const input = new TextInputBuilder()
                .setCustomId('amount')
                .setLabel('Reward members for voting Medhat on Top.gg')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('Coins Per Vote')
                .setValue(String(config.vote_reward_amount !== undefined ? config.vote_reward_amount : '100'))
                .setRequired(false);
            modal.addComponents(new ActionRowBuilder().addComponents(input));
            await interaction.showModal(modal);
            return;
        }

        if (customId === 'settings_tag_reward') {
            const { getGuildConfig } = await import('../storage/config.js');
            const config = await getGuildConfig(interaction.guildId) || {};
            const modal = new ModalBuilder().setCustomId('settings_tag_modal').setTitle('Tag Reward');
            const input = new TextInputBuilder()
                .setCustomId('amount')
                .setLabel('Reward members for using your server tag')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('Coins per day')
                .setValue(String(config.tag_reward_amount !== undefined ? config.tag_reward_amount : ''))
                .setRequired(false);
            modal.addComponents(new ActionRowBuilder().addComponents(input));
            await interaction.showModal(modal);
            return;
        }

        if (customId === 'settings_vote_modal') {
            if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
            const amountStr = interaction.fields.getTextInputValue('amount');
            const amount = amountStr ? Math.max(0, parseInt(amountStr, 10)) : 0;
            if (amountStr && isNaN(amount)) {
                return interaction.followUp({ content: '❌ Invalid amount.', flags: MessageFlags.Ephemeral });
            }
            const { getGuildConfig, setGuildConfig } = await import('../storage/config.js');
            const guildId = interaction.guildId;
            const config = await getGuildConfig(guildId) || {};
            config.vote_reward_amount = amount;
            await setGuildConfig(guildId, config);

            const { getUserLogName } = await import('../shared.js');
            const logName = getUserLogName(interaction);
            sendLog(interaction.guild, 'audit', 'cyan', '⚙️ Vote Reward Config Changed',
                `**Admin:** \`${logName}\`\n` +
                `**Setting:** Coins Per Vote\n` +
                `**New Value:** \`${amount.toLocaleString()}\` coins`
            );

            await showCoinsSubMenu(interaction);
            return;
        }

        if (customId === 'settings_tag_modal') {
            if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
            const amountStr = interaction.fields.getTextInputValue('amount');
            const amount = amountStr ? Math.max(0, parseInt(amountStr, 10)) : 0;
            if (amountStr && isNaN(amount)) {
                return interaction.followUp({ content: '❌ Invalid amount.', flags: MessageFlags.Ephemeral });
            }
            const { getGuildConfig, setGuildConfig } = await import('../storage/config.js');
            const guildId = interaction.guildId;
            const config = await getGuildConfig(guildId) || {};
            config.tag_reward_amount = amount;
            await setGuildConfig(guildId, config);

            const { getUserLogName } = await import('../shared.js');
            const logName = getUserLogName(interaction);
            sendLog(interaction.guild, 'audit', 'cyan', '⚙️ Tag Reward Config Changed',
                `**Admin:** \`${logName}\`\n` +
                `**Setting:** Coins per day\n` +
                `**New Value:** \`${amount.toLocaleString()}\` coins`
            );

            await showCoinsSubMenu(interaction);
            return;
        }

        if (customId === 'settings_customize_modal') {
            if (!interaction.deferred && !interaction.replied) {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
            }
            
            const { getGuildConfig, setGuildConfig } = await import('../storage/config.js');
            const guildId = interaction.guildId;
            const config = await getGuildConfig(guildId) || {};
            
            const botName = interaction.fields.getTextInputValue('bot_name');
            const botAvatar = interaction.fields.getTextInputValue('bot_avatar');
            const coinEmoji = interaction.fields.getTextInputValue('coin_emoji');

            // --- 1. Emoji Status ---
            let emojiStatus = 'Default ⏪';
            let formattedEmoji = null;

            if (coinEmoji && coinEmoji.trim()) {
                const input = coinEmoji.trim();

                // Check for custom emoji format first
                const customMatch = input.match(/<a?:(\w+):(\d+)>/);
                let emojiId = null;
                if (customMatch) {
                    emojiId = customMatch[2];
                } else {
                    // Check if it's a numeric ID
                    const numMatch = input.match(/\b\d+\b/);
                    if (numMatch) {
                        emojiId = numMatch[0];
                    }
                }

                if (emojiId) {
                    const emoji = await interaction.guild.emojis.fetch(emojiId).catch(() => null);
                    if (emoji) {
                        formattedEmoji = emoji.animated ? `<a:${emoji.name}:${emoji.id}>` : `<:${emoji.name}:${emoji.id}>`;
                        emojiStatus = 'Updated ✅';
                    } else {
                        emojiStatus = 'Failed ❌';
                    }
                } else {
                    // Check for standard Unicode emoji
                    const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
                    const segments = Array.from(segmenter.segment(input));
                    const emojiRegex = /\p{Extended_Pictographic}|\p{Emoji_Presentation}/u;
                    const emojiSegments = segments.filter(s => emojiRegex.test(s.segment));

                    if (emojiSegments.length > 0) {
                        // Pick the first unicode emoji found
                        formattedEmoji = emojiSegments[0].segment;
                        emojiStatus = 'Updated ✅';
                    } else {
                        emojiStatus = 'Failed ❌';
                    }
                }
            }

            // --- 2. Nickname Status ---
            const client = interaction.client;
            const botMember = interaction.guild.members.me || await interaction.guild.members.fetch(client.user.id).catch(() => null);
            const newNickname = botName && botName.trim() ? botName.trim() : null;
            let nicknameStatus = newNickname === null ? 'Default ⏪' : 'Updated ✅';

            const promises = [];

            if (botMember) {
                const currentNickname = botMember.nickname || null;
                const nickChanged = newNickname !== currentNickname;

                if (nickChanged) {
                    promises.push(
                        botMember.setNickname(newNickname)
                            .then(() => {
                                nicknameStatus = newNickname === null ? 'Default ⏪' : 'Updated ✅';
                            })
                            .catch((err) => {
                                nicknameStatus = 'Failed ❌';
                                sysError('Failed to update bot server nickname', err);
                            })
                    );
                }
            } else {
                nicknameStatus = 'Failed ❌';
            }

            // --- 3. Avatar Status ---
            const newAvatar = botAvatar && botAvatar.trim() ? botAvatar.trim() : null;
            let avatarStatus = newAvatar === null ? 'Default ⏪' : 'Updated ✅';

            if (botMember) {
                const hasServerAvatar = botMember.avatar !== null;
                const avatarChanged = hasServerAvatar 
                    ? (newAvatar === null || newAvatar !== botMember.avatarURL()) 
                    : (newAvatar !== null);

                if (avatarChanged) {
                    promises.push((async () => {
                        try {
                            let avatarBuffer = null;
                            if (newAvatar) {
                                if (newAvatar.startsWith('http://') || newAvatar.startsWith('https://')) {
                                    const res = await fetch(newAvatar);
                                    if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
                                    const contentType = res.headers.get('content-type') || 'image/png';
                                    const arrayBuffer = await res.arrayBuffer();
                                    const buffer = Buffer.from(arrayBuffer);
                                    avatarBuffer = `data:${contentType};base64,${buffer.toString('base64')}`;
                                } else {
                                    avatarBuffer = newAvatar;
                                }
                            }
                            await interaction.guild.members.editMe({ avatar: avatarBuffer });
                            avatarStatus = newAvatar === null ? 'Default ⏪' : 'Updated ✅';
                        } catch (err) {
                            avatarStatus = 'Failed ❌';
                            sysError('Failed to update bot server avatar', err);
                        }
                    })());
                }
            } else {
                avatarStatus = 'Failed ❌';
            }

            // Wait for Discord API updates to settle
            if (promises.length > 0) {
                await Promise.all(promises);
            }

            // --- 4. Save to Database ---
            if (nicknameStatus === 'Updated ✅') {
                config.bot_nickname = newNickname;
            } else if (nicknameStatus === 'Default ⏪') {
                config.bot_nickname = null;
            }

            if (avatarStatus === 'Updated ✅') {
                config.bot_avatar = newAvatar;
            } else if (avatarStatus === 'Default ⏪') {
                config.bot_avatar = null;
            }

            if (emojiStatus === 'Updated ✅') {
                config.coin_emoji = formattedEmoji;
            } else if (emojiStatus === 'Default ⏪') {
                config.coin_emoji = null;
            }

            await setGuildConfig(guildId, config).catch((err) => {
                sysError('Failed to save customization config', err);
            });

            // --- 5. Audit Logging ---
            const { getUserLogName } = await import('../shared.js');
            const logName = getUserLogName(interaction);
            sendLog(interaction.guild, 'audit', 'cyan', '⚙️ Bot Customized',
                `**Admin:** \`${logName}\`\n` +
                `**Nickname:** ${nicknameStatus}\n` +
                `**Avatar:** ${avatarStatus}\n` +
                `**Emoji:** ${emojiStatus}`
            );

            // --- 6. Send Response ---
            const responseContent = 
                `Nickname: ${nicknameStatus}\n` +
                `Avatar: ${avatarStatus}\n` +
                `Emoji: ${emojiStatus}`;

            await interaction.followUp({ content: responseContent, flags: MessageFlags.Ephemeral });
            return;
        }

        if (customId === 'settings_users_roles') {
            await showRoleRewardsMenu(interaction);
            return;
        }

        if (customId.startsWith('role_rewards_')) {
            await handleRoleRewardsComponent(interaction);
            return;
        }

        if (customId === 'settings_shop') {
            await showShopPanel(interaction);
            return;
        }

        if (customId === 'settings_colors') {
            await showColorsPanel(interaction);
            return;
        }

        if (customId === 'settings_leaderboards') {
            await handleLeaderboardSettings(interaction);
            return;
        }

        if (customId === 'settings_users') {
            await showUserSelector(interaction);
            return;
        }

        if (customId === 'settings_logs') {
            await handleLogsSettings(interaction);
            return;
        }

        if (customId === 'settings_economy' || customId.startsWith('economy_') || customId.startsWith('eco_')) {
            await handleEconomySettings(interaction);
            return;
        }

        if (customId === 'settings_organize' || customId.startsWith('organize_')) {
            await handleOrganizeComponent(interaction);
            return;
        }

        if (customId === 'quests_dashboard' || customId.startsWith('quests_')) {
            await handleQuestsComponent(interaction);
            return;
        }

        if (customId === 'logs_category_select') {
            await handleLogCategorySelect(interaction);
            return;
        }

        if (customId.startsWith('logs_channel_select_')) {
            await handleLogChannelSelect(interaction);
            return;
        }

        if (customId.startsWith('logs_disable_btn_')) {
            await handleLogDisable(interaction);
            return;
        }

        if (customId === 'lb_type_select') {
            await handleLeaderboardCategorySelect(interaction);
            return;
        }

        if (customId.startsWith('lb_set_channel_')) {
            await handleLeaderboardChannelSelectV2(interaction);
            return;
        }

        if (customId.startsWith('lb_disable_')) {
            await handleLeaderboardDisable(interaction);
            return;
        }

        if (customId === 'lb_refresh') {
            await handleLeaderboardRefreshV2(interaction);
            return;
        }

        // Route module-specific components to their handlers
        if (customId.startsWith('mvp_')) {
            await handleMvpComponent(interaction);
            return;
        }

        if (customId === 'rewards_give_btn' || customId.startsWith('rewards_')) {
            await handleRewardsComponent(interaction);
            return;
        }

        if (customId.startsWith('colors_') || customId.startsWith('color_')) {
            await handleColorsComponent(interaction);
            return;
        }

        if (customId.startsWith('admin_user_')) {
            await handleAdminUserComponent(interaction);
            return;
        }

        // Default: Return to main menu if no module matches (or unknown interaction)
        await showMainMenu(interaction);
    } catch (error) {
        sysError('Settings fatal component error', error, { 
            user: interaction.user.id, 
            guild: interaction.guildId,
            id: interaction.customId,
            deferred: interaction.deferred,
            replied: interaction.replied,
            stack: error.stack 
        });

        // Fallback: If it's not deferred, try to reply to stop the "Interaction Failed" red text
        try {
          if (!interaction.deferred && !interaction.replied) {
              await interaction.reply({ content: '❌ **Dashboard Error:** Internal routing failure. Try /settings again.', flags: MessageFlags.Ephemeral }).catch(() => {});
          } else {
              await interaction.followUp({ content: '❌ **Dashboard Error:** Something went wrong while loading this module.', flags: MessageFlags.Ephemeral }).catch(() => {});
          }
        } catch (e) {
          // Final safety if even the reply fails
          sysError('Critical: Settings fallback failed', e);
        }
    }
}
