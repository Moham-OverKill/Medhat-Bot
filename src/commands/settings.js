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
import { handleLogsSettings, handleLogCategorySelect, handleLogDisable } from './settings/logs.js';
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

    // Row 2: Pass - Users - Other
    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('settings_pass')
            .setLabel('Pass')
            .setEmoji('🎟️')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('settings_users')
            .setLabel('Users')
            .setEmoji('👥')
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
 * Show the Other Sub-Menu (Customize, Organize, Logs, Leaderboards, Economy)
 */
export async function showOtherSubMenu(interaction) {
    const embed = new EmbedBuilder()
        .setTitle('⚙️ Other Settings')
        .setDescription('Configure additional server utilities.')
        .setColor(0x2F3136);

    // Row 1: Customize | Organize | Logs
    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('settings_customize')
            .setLabel('Customize')
            .setEmoji('✨')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('settings_organize')
            .setLabel('Organize')
            .setEmoji('🧹')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('settings_logs')
            .setLabel('Logs')
            .setEmoji('📜')
            .setStyle(ButtonStyle.Secondary)
    );

    // Row 2: Back | Leaderboards | Economy
    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('settings_home')
            .setLabel('Back')
            .setEmoji('⬅️')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('settings_leaderboards')
            .setLabel('Leaderboards')
            .setEmoji('📊')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('settings_economy')
            .setLabel('Economy')
            .setEmoji('📈')
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

        if (customId === 'settings_pass' || customId.startsWith('pass_')) {
            const { handlePassSetup, handlePassComponent } = await import('./settings/pass.js');
            if (customId === 'settings_pass') {
                await handlePassSetup(interaction);
            } else {
                await handlePassComponent(interaction);
            }
            return;
        }

        if (customId === 'settings_customize') {
            const { getGuildConfig } = await import('../storage/config.js');
            const config = await getGuildConfig(interaction.guildId) || {};
            
            const currentEmoji = config.coin_emoji;
            let initialValue = '';
            if (currentEmoji) {
                const currentEmojiStr = typeof currentEmoji === 'string' ? currentEmoji : currentEmoji.toString();
                initialValue = currentEmojiStr;
            }

            const botMember = interaction.guild.members.me || await interaction.guild.members.fetch(interaction.client.user.id).catch(() => null);
            const currentNickname = config.bot_nickname !== undefined ? (config.bot_nickname || '') : (botMember ? (botMember.nickname || '') : '');
            const currentServerAvatar = config.bot_avatar !== undefined ? (config.bot_avatar || '') : '';

            const modal = new ModalBuilder().setCustomId(`settings_customize_modal_${Date.now()}`).setTitle('Customize Bot');
            
            const nameInput = new TextInputBuilder()
                .setCustomId('bot_name')
                .setLabel('Bot Server Nickname')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('Enter bot nickname')
                .setRequired(false);
            if (currentNickname) nameInput.setValue(currentNickname);

            const avatarInput = new TextInputBuilder()
                .setCustomId('bot_avatar')
                .setLabel('Bot Server Avatar URL')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('Enter profile image URL')
                .setRequired(false);
            if (currentServerAvatar) avatarInput.setValue(currentServerAvatar);

            const emojiInput = new TextInputBuilder()
                .setCustomId('coin_emoji')
                .setLabel('Coin Emoji')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('Enter an emoji or emoji ID')
                .setRequired(false);
            if (initialValue) emojiInput.setValue(initialValue);

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
            const modal = new ModalBuilder().setCustomId(`settings_vote_modal_${Date.now()}`).setTitle('Vote Reward');
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
            const modal = new ModalBuilder().setCustomId(`settings_tag_modal_${Date.now()}`).setTitle('Tag Reward');
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

        if (customId.startsWith('settings_vote_modal')) {
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

        if (customId.startsWith('settings_tag_modal')) {
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

        if (customId.startsWith('settings_customize_modal')) {
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

                // 1. Formatted Custom Emoji: <:name:id> or <a:name:id>
                const customMatch = input.match(/^<(a)?:([a-zA-Z0-9_]+):(\d{17,20})>$/);
                if (customMatch) {
                    const isAnimated = Boolean(customMatch[1]);
                    const name = customMatch[2];
                    const id = customMatch[3];
                    const found = interaction.guild?.emojis.cache.get(id) || interaction.client?.emojis.cache.get(id);
                    if (found) {
                        formattedEmoji = `<${found.animated ? 'a' : ''}:${found.name}:${found.id}>`;
                        emojiStatus = 'Updated ✅';
                    } else {
                        const fetched = await interaction.guild?.emojis.fetch(id).catch(() => null) ||
                                        await interaction.client?.emojis.fetch(id).catch(() => null);
                        if (fetched) {
                            formattedEmoji = `<${fetched.animated ? 'a' : ''}:${fetched.name}:${fetched.id}>`;
                            emojiStatus = 'Updated ✅';
                        } else {
                            formattedEmoji = `<${isAnimated ? 'a' : ''}:${name}:${id}>`;
                            emojiStatus = 'Updated ✅';
                        }
                    }
                } else if (/^\d{17,20}$/.test(input)) {
                    // 2. Pure Snowflake ID
                    const found = interaction.guild?.emojis.cache.get(input) || interaction.client?.emojis.cache.get(input);
                    if (found) {
                        formattedEmoji = `<${found.animated ? 'a' : ''}:${found.name}:${found.id}>`;
                        emojiStatus = 'Updated ✅';
                    } else {
                        const fetched = await interaction.guild?.emojis.fetch(input).catch(() => null) ||
                                        await interaction.client?.emojis.fetch(input).catch(() => null);
                        if (fetched) {
                            formattedEmoji = `<${fetched.animated ? 'a' : ''}:${fetched.name}:${fetched.id}>`;
                            emojiStatus = 'Updated ✅';
                        } else {
                            emojiStatus = 'Failed ❌';
                        }
                    }
                } else {
                    // 3. Unicode Emoji
                    const emojiRegex = /^(\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Emoji}\uFE0F|\u200D|\p{Emoji_Modifier})+$/u;
                    if (emojiRegex.test(input) && input.length <= 16) {
                        formattedEmoji = input;
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

        if (customId.startsWith('logs_assign_') || customId === 'logs_category_select') {
            await handleLogCategorySelect(interaction);
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
