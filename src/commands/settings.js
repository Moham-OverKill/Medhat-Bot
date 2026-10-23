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
    TextInputStyle,
    FileUploadBuilder,
    LabelBuilder,
    StringSelectMenuBuilder
} from 'discord.js';
import { getGuildConfig, setGuildConfig } from '../storage/config.js';
import { sendLog, sysLog, sysError } from '../utils/logger.js';
import { uploadHostAsset } from '../utils/image-host.js';
import { showSetupPanel as showMvpPanel, handleMvpComponent } from './mvp.js';
import { handleShopSetup as showShopPanel } from './shop-setup.js';
import { handleRewardsSetup as showRewardsPanel, handleRewardsComponent } from './rewards.js';
import { showColorPanel as showColorsPanel, handleColorsComponent } from './colors.js';
import { getLeaderboardConfig, setLeaderboardConfig, sendSingleLeaderboard } from './leaderboard.js';
import { 
    handleLeaderboardSettings, 
    handleLeaderboardMenuAction,
    handleLeaderboardCategorySelect, 
    handleLeaderboardChannelSelect as handleLeaderboardChannelSelectV2,
    handleLeaderboardRefresh as handleLeaderboardRefreshV2,
    handleLeaderboardDisable
} from './settings/leaderboards.js';
import { showUserSelector, handleAdminUserComponent } from './admin-users.js';
import { showRolesMenu, showSelfRolesDashboard, showRoleRewardsMenu, handleRoleRewardsComponent } from './settings/role-rewards.js';
import { handleLogsSettings, handleLogMenuAction, handleLogCategorySelect, handleLogChannelSelect, handleLogDisable } from './settings/logs.js';
import { handleEconomySettings } from './settings/economy.js';
import { handleOrganizeComponent, handleOrganizeSettings } from './settings/organize.js';
import { handleQuestsComponent } from './quests-dashboard.js';
import { handleInteractionError } from '../utils/errors.js';
import { COIN_EMOJI, COIN_NAME, getCurrencyName, getUserLogName, resolveComponentEmoji, formatCurrentImageDescription, isBackDisabled } from '../shared.js';

// /settings command - unified control panel
export const settingsCommand = new SlashCommandBuilder()
    .setName('settings')
    .setDescription('Open the server control panel')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

/**
 * Handle /settings command
 */
export async function handleSettingsCommand(interaction) {
  const guildName = interaction.guild?.name || 'Unknown Server';
  sysLog('Settings Dashboard opened', { user: interaction.user.id, guild: interaction.guildId });

    const { verifyAdminAccess } = await import('../storage/admins.js');
    if (!(await verifyAdminAccess(interaction))) return;

    if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await showMainMenu(interaction);
}

/**
 * Show the main settings menu
 */
export async function showMainMenu(interaction) {
    const coinName = await getCurrencyName(interaction.guildId);

    const embed = new EmbedBuilder()
        .setTitle('Control Panel')
        .setDescription('Select a module to configure.')
        .setColor(0x2F3136);

    const nonce = Date.now();

    // Row 1: SHOP Select Menu (Coins, Items, Market, Economy)
    const shopSelect = new StringSelectMenuBuilder()
        .setCustomId(`settings_menu_market_${nonce}`)
        .setPlaceholder('🛒 Shop')
        .addOptions([
            {
                label: coinName,
                value: 'market_coins',
                emoji: resolveComponentEmoji(COIN_EMOJI.forGuild(interaction.guildId), interaction.guild, '🪙')
            },
            {
                label: 'Items',
                value: 'market_shop',
                emoji: '🏷️'
            },
            {
                label: 'Market',
                value: 'market_market',
                description: 'Coming soon',
                emoji: '🛒'
            },
            {
                label: 'Economy',
                value: 'market_economy',
                emoji: '📈'
            }
        ]);
    const row1 = new ActionRowBuilder().addComponents(shopSelect);

    // Row 2: FUN Select Menu (Colors, Levels, Roles, Leaderboard)
    const funSelect = new StringSelectMenuBuilder()
        .setCustomId(`settings_menu_fun_${nonce}`)
        .setPlaceholder('🎮 Fun')
        .addOptions([
            { label: 'Colors', value: 'fun_colors', emoji: '🎨' },
            { label: 'Levels', value: 'fun_levels', emoji: '⭐' },
            { label: 'Roles', value: 'fun_roles', emoji: '🎭' },
            { label: 'Leaderboard', value: 'fun_leaderboards', emoji: '📊' }
        ]);
    const row2 = new ActionRowBuilder().addComponents(funSelect);

    // Row 3: MODERATE Select Menu (Users, Anti Cheat, Auto Mod, Admins, Dashboard, Logs)
    const { hasAdminManagerAccess } = await import('../storage/admins.js');
    const canManageAdmins = await hasAdminManagerAccess(interaction);

    const moderateOptions = [
        { label: 'Users', value: 'mod_users', emoji: '👥' },
        { label: 'Anti Cheat', value: 'mod_anticheat', emoji: '🚫' },
        { label: 'Auto Mod', value: 'mod_automod', emoji: '🛡️' }
    ];

    if (canManageAdmins) {
        moderateOptions.push({ label: 'Admins', value: 'mod_admins', emoji: '💼' });
    }

    moderateOptions.push(
        { label: 'Logs', value: 'mod_logs', emoji: '📜' }
    );

    const moderateSelect = new StringSelectMenuBuilder()
        .setCustomId(`settings_menu_moderate_${nonce}`)
        .setPlaceholder('🛡️ Moderate')
        .addOptions(moderateOptions);
    const row3 = new ActionRowBuilder().addComponents(moderateSelect);

    // Row 4: OTHER Select Menu (Customize, Shortcuts, Dashboard, Embeds)
    const otherSelect = new StringSelectMenuBuilder()
        .setCustomId(`settings_menu_other_${nonce}`)
        .setPlaceholder('⚙️ Other')
        .addOptions([
            { label: 'Customize', value: 'other_customize', emoji: '✨' },
            { label: 'Shortcuts', value: 'other_shortcuts', emoji: '⚡' },
            { label: 'Dashboard', value: 'other_dashboard', emoji: '🎛️' },
            { label: 'Embeds', value: 'other_embeds', emoji: '📰' }
        ]);
    const row4 = new ActionRowBuilder().addComponents(otherSelect);

    const responseMethod = (interaction.deferred || interaction.replied)
        ? 'editReply'
        : (interaction.isButton() || interaction.isAnySelectMenu() ? 'update' : 'editReply');

    await interaction[responseMethod]({
        content: '',
        embeds: [embed],
        components: [row1, row2, row3, row4],
        files: [],
        attachments: []
    });
}

/**
 * Show the Coins Sub-Menu (Daily & Rewards Modules)
 */
export async function showCoinsSubMenu(interaction) {
    const coinName = await getCurrencyName(interaction.guildId);

    const embed = new EmbedBuilder()
        .setTitle(`${coinName} Management`)
        .setDescription('Manage your server\'s daily claims and reward modules.')
        .setColor(0x2F3136);

    // Row 1: Daily, Quests, Tag, Vote
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
            .setCustomId('settings_tag_reward')
            .setLabel('Tag')
            .setEmoji('🏷️')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('settings_vote_reward')
            .setLabel('Vote')
            .setEmoji('🗳️')
            .setStyle(ButtonStyle.Secondary)
    );

    // Row 2: Back, Customize, Give Coins
    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('settings_home')
            .setLabel('Back')
            .setEmoji('⬅️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(isBackDisabled(interaction)),
        new ButtonBuilder()
            .setCustomId('settings_coins_customize')
            .setLabel('Customize')
            .setEmoji('⚙️')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('rewards_give_btn')
            .setLabel(`Give ${coinName}`)
            .setEmoji('💸')
            .setStyle(ButtonStyle.Success)
    );

    const responseMethod = (interaction.deferred || interaction.replied)
        ? 'editReply'
        : (interaction.isButton() || interaction.isAnySelectMenu() ? 'update' : 'editReply');
    await interaction[responseMethod]({
        content: '',
        embeds: [embed],
        components: [row1, row2],
        files: [],
        attachments: []
    });
}

/**
 * Show the Market Panel (Coming Soon)
 */
export async function showMarketPanel(interaction) {
    const embed = new EmbedBuilder()
        .setTitle('Market')
        .setDescription('Coming soon.')
        .setColor(0x2F3136);

    const backRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('settings_home')
            .setLabel('Back')
            .setEmoji('⬅️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(isBackDisabled(interaction))
    );

    const responseMethod = (interaction.deferred || interaction.replied)
        ? 'editReply'
        : (interaction.isButton() || interaction.isAnySelectMenu() ? 'update' : 'editReply');
    await interaction[responseMethod]({
        content: '',
        embeds: [embed],
        components: [backRow],
        files: [],
        attachments: []
    });
}

/**
 * Open the Bot Customization modal directly (modal cannot be deferred)
 * @param {import('discord.js').Interaction} interaction 
 */
export async function showCustomizeModal(interaction, source = 'settings') {
    const { getGuildConfig } = await import('../storage/config.js');
    const config = await getGuildConfig(interaction.guildId) || {};

    const botMember = interaction.guild.members.me || await interaction.guild.members.fetch(interaction.client.user.id).catch(() => null);
    const currentNickname = config.bot_nickname !== undefined ? (config.bot_nickname || '') : (botMember ? (botMember.nickname || '') : '');
    const currentServerAvatar = config.bot_avatar !== undefined ? (config.bot_avatar || '') : '';

    const modal = new ModalBuilder().setCustomId(`settings_customize_modal_${source}_${Date.now()}`).setTitle('Customize Bot');
    
    const nameInput = new TextInputBuilder()
        .setCustomId('bot_name')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Enter bot nickname')
        .setRequired(false);
    if (currentNickname) nameInput.setValue(currentNickname);

    const nameLabel = new LabelBuilder()
        .setLabel('Bot Server Nickname')
        .setTextInputComponent(nameInput);

    const avatarUpload = new FileUploadBuilder()
        .setCustomId('bot_avatar_file')
        .setRequired(false);

    const avatarLabel = new LabelBuilder()
        .setLabel('Bot Server Avatar')
        .setDescription(formatCurrentImageDescription(currentServerAvatar))
        .setFileUploadComponent(avatarUpload);

    modal.addLabelComponents(nameLabel, avatarLabel);
    await interaction.showModal(modal);
    if (source === 'settings' && interaction.webhook) {
        try {
            await showMainMenu({
                ...interaction,
                deferred: false,
                replied: true,
                editReply: async (payload) => {
                    return interaction.webhook.editMessage('@original', payload).catch(async () => {
                        if (interaction.message?.id) {
                            return interaction.webhook.editMessage(interaction.message.id, payload).catch(() => {});
                        }
                    });
                }
            });
        } catch (_) {}
    }
}

/**
 * Open the Coins Customization modal directly (modal cannot be deferred)
 * @param {import('discord.js').Interaction} interaction 
 */
export async function showCoinsCustomizeModal(interaction) {
    const { getGuildConfig } = await import('../storage/config.js');
    const config = await getGuildConfig(interaction.guildId) || {};

    const currentCoinName = config.coin_name || '';
    const currentCoinEmoji = config.coin_emoji || '';
    const modal = new ModalBuilder()
        .setCustomId(`settings_coins_customize_modal_${Date.now()}`)
        .setTitle('Coins Name');

    const nameInput = new TextInputBuilder()
        .setCustomId('coin_name')
        .setLabel('Coins Name')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Coins')
        .setRequired(false);
    if (currentCoinName && currentCoinName !== 'Coins') {
        nameInput.setValue(currentCoinName);
    }

    const emojiInput = new TextInputBuilder()
        .setCustomId('coin_emoji')
        .setLabel('Coins Emoji')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('🪙')
        .setRequired(false);
    if (currentCoinEmoji && currentCoinEmoji !== '🪙') {
        const emojiStr = typeof currentCoinEmoji === 'string' ? currentCoinEmoji : currentCoinEmoji.toString();
        emojiInput.setValue(emojiStr);
    }

    modal.addComponents(
        new ActionRowBuilder().addComponents(nameInput),
        new ActionRowBuilder().addComponents(emojiInput)
    );
    await interaction.showModal(modal);
}

/**
 * Handle settings component interactions (navigation)
 */
export async function handleSettingsComponent(interaction) {
    try {
        const { verifyAdminAccess } = await import('../storage/admins.js');
        if (!(await verifyAdminAccess(interaction))) return;

        const customId = interaction.customId;

        // Handle back button from any module
        if (customId === 'settings_back' || customId === 'settings_home') {
            if (!interaction.deferred && !interaction.replied) {
                await interaction.deferUpdate().catch(() => {});
            }
            await showMainMenu(interaction);
            return;
        }

        // Handle categorized select menus from the main settings control panel
        if (customId.startsWith('settings_menu_')) {
            const selected = interaction.values?.[0];
            if (!selected) return;

            switch (selected) {
                // 1. SHOP / MARKET
                case 'market_coins':
                    return showCoinsSubMenu(interaction);
                case 'market_shop':
                case 'market_items':
                    return showShopPanel(interaction);
                case 'market_market':
                case 'market_coming_soon':
                    return showMarketPanel(interaction);
                case 'market_economy':
                    return handleEconomySettings(interaction);

                // 2. FUN
                case 'fun_colors':
                    return showColorsPanel(interaction, 'normal');
                case 'fun_levels': {
                    const { handlePassSetup } = await import('./settings/pass.js');
                    return handlePassSetup(interaction);
                }
                case 'fun_roles': {
                    const { showRolesMenu } = await import('./settings/role-rewards.js');
                    return showRolesMenu(interaction);
                }
                case 'fun_leaderboards': {
                    const { handleLeaderboardSettings } = await import('./settings/leaderboards.js');
                    return handleLeaderboardSettings(interaction);
                }

                // 3. MODERATE
                case 'mod_users':
                    return showUserSelector(interaction);
                case 'mod_anticheat': {
                    const { showAntiCheatHub } = await import('./admin-users.js');
                    return showAntiCheatHub(interaction, true);
                }
                case 'mod_automod':
                    return handleOrganizeSettings(interaction);
                case 'mod_admins': {
                    const { showAdminManagement } = await import('./admin-users.js');
                    return showAdminManagement(interaction, true);
                }
                case 'other_dashboard':
                case 'mod_dashboard': {
                    const { showAdminInterfaceSettings } = await import('./interface.js');
                    return showAdminInterfaceSettings(interaction);
                }
                case 'mod_logs':
                    return handleLogsSettings(interaction);

                // 4. OTHER
                case 'other_customize':
                    return showCustomizeModal(interaction);
                case 'other_embeds': {
                    const { renderRootEmbedMenu } = await import('./settings/embeds.js');
                    return renderRootEmbedMenu(interaction);
                }
                case 'other_shortcuts':
                case 'fun_shortcuts': {
                    const { showInterfaceSettings } = await import('./interface.js');
                    return showInterfaceSettings(interaction);
                }
                default:
                    return;
            }
        }

        // Navigation to main modules
        if (customId === 'settings_coins') {
            await showCoinsSubMenu(interaction);
            return;
        }


        if (customId === 'settings_other') {
            if (!interaction.deferred && !interaction.replied) {
                await interaction.deferUpdate().catch(() => {});
            }
            await showMainMenu(interaction);
            return;
        }

        if (customId === 'settings_embed') {
            const { renderRootEmbedMenu } = await import('./settings/embeds.js');
            await renderRootEmbedMenu(interaction);
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
            await showCustomizeModal(interaction);
            return;
        }

        if (customId === 'settings_coins_customize') {
            await showCoinsCustomizeModal(interaction);
            return;
        }

        if (customId === 'settings_daily') {
            await showRewardsPanel(interaction);
            return;
        }

        if (customId === 'settings_vote_reward') {
            const { getGuildConfig } = await import('../storage/config.js');
            const config = await getGuildConfig(interaction.guildId) || {};
            const coinName = await getCurrencyName(interaction.guildId);
            const modal = new ModalBuilder().setCustomId(`settings_vote_modal_${Date.now()}`).setTitle('Vote Reward');
            const input = new TextInputBuilder()
                .setCustomId('amount')
                .setLabel('Reward members for voting Medhat on Top.gg')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder(`${coinName} Per Vote`)
                .setValue(String(config.vote_reward_amount !== undefined ? config.vote_reward_amount : '100'))
                .setRequired(false);
            modal.addComponents(new ActionRowBuilder().addComponents(input));
            await interaction.showModal(modal);
            return;
        }

        if (customId === 'settings_tag_reward') {
            const { getGuildConfig } = await import('../storage/config.js');
            const config = await getGuildConfig(interaction.guildId) || {};
            const coinName = await getCurrencyName(interaction.guildId);
            const modal = new ModalBuilder().setCustomId(`settings_tag_modal_${Date.now()}`).setTitle('Tag Reward');
            const input = new TextInputBuilder()
                .setCustomId('amount')
                .setLabel('Reward members for using your server tag')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder(`${coinName} per day`)
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
            const coinName = await getCurrencyName(guildId);
            sendLog(interaction.guild, 'audit', 'cyan', '⚙️ Vote Reward Config Changed',
                `**Admin:** \`${logName}\`\n` +
                `**Setting:** ${coinName} Per Vote\n` +
                `**New Value:** \`${amount.toLocaleString()}\` ${coinName.toLowerCase()}`
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
            const coinName = await getCurrencyName(guildId);
            sendLog(interaction.guild, 'audit', 'cyan', '⚙️ Tag Reward Config Changed',
                `**Admin:** \`${logName}\`\n` +
                `**Setting:** ${coinName} per day\n` +
                `**New Value:** \`${amount.toLocaleString()}\` ${coinName.toLowerCase()}`
            );

            await showCoinsSubMenu(interaction);
            return;
        }

        if (customId.startsWith('settings_customize_modal')) {
            const isSettingsSource = !customId.includes('_admin_hub_');
            const isFromMsg = typeof interaction.isFromMessage === 'function' ? interaction.isFromMessage() : Boolean(interaction.message);
            const shouldResetSettings = isSettingsSource && isFromMsg;

            if (!interaction.deferred && !interaction.replied) {
                if (shouldResetSettings) {
                    try {
                        await interaction.deferUpdate();
                    } catch (_) {
                        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
                    }
                } else {
                    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
                }
            }
            
            const { getGuildConfig, setGuildConfig } = await import('../storage/config.js');
            const guildId = interaction.guildId;
            const config = await getGuildConfig(guildId) || {};
            
            const botName = interaction.fields.getTextInputValue('bot_name');

            let newAvatar = null;
            const avatarFiles = interaction.fields.getUploadedFiles?.('bot_avatar_file');
            const avatarFile = avatarFiles?.first?.() || (Array.isArray(avatarFiles) ? avatarFiles[0] : null);
            if (avatarFile) {
                const uploadRes = await uploadHostAsset(interaction.client, 'avatars', interaction.guild, avatarFile, {
                    filename: avatarFile.name,
                    label: `🖼️ Server Bot Avatar: **${interaction.guild.name}**`
                });
                newAvatar = uploadRes.url;
            } else {
                let rawAvatar = null;
                try { rawAvatar = interaction.fields.getTextInputValue('bot_avatar')?.trim(); } catch (_) {}
                if (rawAvatar && rawAvatar.toLowerCase() !== 'none') {
                    newAvatar = rawAvatar;
                } else if (rawAvatar === '' || rawAvatar?.toLowerCase() === 'clear') {
                    newAvatar = null;
                } else {
                    newAvatar = config.bot_avatar || null;
                }
            }

            // --- 1. Nickname Status & Update ---
            const client = interaction.client;
            const botMember = interaction.guild.members.me || await interaction.guild.members.fetch(client.user.id).catch(() => null);
            const newNickname = botName && botName.trim() ? botName.trim() : null;
            let nicknameStatus = newNickname === null ? 'Default ⏪' : 'Updated ✅';
            let nicknameReason = null;

            const promises = [];

            if (botMember) {
                const currentNickname = botMember.nickname || null;
                const nickChanged = newNickname !== currentNickname;

                if (nickChanged) {
                    if (newNickname !== null && newNickname.length > 32) {
                        nicknameStatus = 'Failed ❌';
                        nicknameReason = 'Nickname cannot be longer than 32 letters.';
                    } else {
                        promises.push(
                            botMember.setNickname(newNickname)
                                .then(() => {
                                    nicknameStatus = newNickname === null ? 'Default ⏪' : 'Updated ✅';
                                })
                                .catch((err) => {
                                    nicknameStatus = 'Failed ❌';
                                    if (err.code === 50013 || err.message?.toLowerCase().includes('permission')) {
                                        nicknameReason = 'Bot is missing permission to change its nickname.';
                                    } else {
                                        nicknameReason = 'Could not update nickname.';
                                    }
                                    sysError('Failed to update bot server nickname', err);
                                })
                        );
                    }
                }
            } else {
                nicknameStatus = 'Failed ❌';
                nicknameReason = 'Could not find bot member in server.';
            }

            // --- 3. Avatar Status & Update ---
            let avatarStatus = newAvatar === null ? 'Default ⏪' : 'Updated ✅';
            let avatarReason = null;

            if (botMember) {
                const hasServerAvatar = botMember.avatar !== null;
                const avatarChanged = hasServerAvatar 
                    ? (newAvatar === null || newAvatar !== botMember.avatarURL()) 
                    : (newAvatar !== null);

                if (avatarChanged) {
                    if (newAvatar !== null && !newAvatar.startsWith('http://') && !newAvatar.startsWith('https://') && !newAvatar.startsWith('data:image/')) {
                        avatarStatus = 'Failed ❌';
                        avatarReason = 'The image link is invalid. Use a direct image URL.';
                    } else {
                        promises.push((async () => {
                            try {
                                let avatarBuffer = null;
                                if (newAvatar) {
                                    if (newAvatar.startsWith('http://') || newAvatar.startsWith('https://')) {
                                        const res = await fetch(newAvatar);
                                        if (!res.ok) throw new Error(`HTTP download failed (${res.status})`);
                                        const contentType = res.headers.get('content-type') || 'image/png';
                                        if (!contentType.includes('image') && !contentType.includes('octet-stream')) {
                                            throw new Error(`URL is not an image (${contentType})`);
                                        }
                                        const arrayBuffer = await res.arrayBuffer();
                                        const buffer = Buffer.from(arrayBuffer);
                                        if (buffer.length > 10 * 1024 * 1024) {
                                            throw new Error('Image exceeds 10MB limit');
                                        }
                                        avatarBuffer = `data:${contentType};base64,${buffer.toString('base64')}`;
                                    } else {
                                        avatarBuffer = newAvatar;
                                    }
                                }
                                await interaction.guild.members.editMe({ avatar: avatarBuffer });
                                avatarStatus = newAvatar === null ? 'Default ⏪' : 'Updated ✅';
                            } catch (err) {
                                avatarStatus = 'Failed ❌';
                                const msg = String(err?.message || '');
                                if (msg.includes('AVATAR_RATE_LIMIT') || msg.toLowerCase().includes('too fast')) {
                                    avatarReason = 'You are changing the avatar too fast, try again later.';
                                } else if (err.code === 50013 || msg.includes('feature') || msg.includes('tier') || msg.includes('COMMUNITY')) {
                                    avatarReason = 'Server must be Boost Level 2 to change bot avatar.';
                                } else if (msg.includes('HTTP download') || msg.includes('Could not download')) {
                                    avatarReason = 'Could not download image from that link.';
                                } else if (msg.includes('not an image') || msg.includes('not a valid image')) {
                                    avatarReason = 'The link does not point to a valid image.';
                                } else if (msg.includes('10MB') || msg.includes('too large')) {
                                    avatarReason = 'Image file is too large (must be under 10MB).';
                                } else {
                                    avatarReason = 'Could not update avatar.';
                                }
                                sysError('Failed to update bot server avatar', err);
                            }
                        })());
                    }
                }
            } else {
                avatarStatus = 'Failed ❌';
                avatarReason = 'Could not find bot member in server.';
            }

            // Wait for Discord API updates to settle
            if (promises.length > 0) {
                await Promise.all(promises);
            }

            // --- 4. Save to Database ---
            if (nicknameStatus.startsWith('Updated ✅')) {
                config.bot_nickname = newNickname;
            } else if (nicknameStatus.startsWith('Default ⏪')) {
                config.bot_nickname = null;
            }

            if (avatarStatus.startsWith('Updated ✅')) {
                config.bot_avatar = newAvatar;
            } else if (avatarStatus.startsWith('Default ⏪')) {
                config.bot_avatar = null;
            }

            await setGuildConfig(guildId, config).catch((err) => {
                sysError('Failed to save customization config', err);
            });

            // Helper to format each field with clean line separation
            const formatField = (name, status, reason) => {
                if (reason) {
                    return `${name}: ${status}\n↳ *${reason}*`;
                }
                return `${name}: ${status}`;
            };

            // --- 5. Audit Logging ---
            const { getUserLogName } = await import('../shared.js');
            const logName = getUserLogName(interaction);
            sendLog(interaction.guild, 'audit', 'cyan', 'Bot Customized',
                `**Admin:** \`${logName}\`\n\n` +
                formatField('**Nickname**', nicknameStatus, nicknameReason) + '\n\n' +
                formatField('**Avatar**', avatarStatus, avatarReason)
            );

            // --- 6. Send Response ---
            const responseContent = [
                formatField('Nickname', nicknameStatus, nicknameReason),
                formatField('Avatar', avatarStatus, avatarReason)
            ].join('\n\n');

            if (shouldResetSettings && interaction.deferred) {
                await showMainMenu(interaction).catch(err => {
                    sysError('Failed to reset main menu after modal submit', err);
                });
                await interaction.followUp({ content: responseContent, flags: MessageFlags.Ephemeral });
            } else if (interaction.deferred) {
                await interaction.editReply({ content: responseContent });
            } else {
                await interaction.reply({ content: responseContent, flags: MessageFlags.Ephemeral });
            }
            return;
        }

        if (customId.startsWith('settings_coins_customize_modal')) {
            if (!interaction.deferred && !interaction.replied) {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
            }

            const { getGuildConfig, setGuildConfig } = await import('../storage/config.js');
            const guildId = interaction.guildId;
            const config = await getGuildConfig(guildId) || {};

            const coinName = interaction.fields.getTextInputValue('coin_name');
            const coinEmoji = interaction.fields.getTextInputValue('coin_emoji');

            // --- 1. Coin Name Status & Parsing ---
            let nameStatus = 'Default ⏪';
            let nameReason = null;
            let newCoinName = null;

            if (coinName && coinName.trim()) {
                const input = coinName.trim();
                if (input.length > 32) {
                    nameStatus = 'Failed ❌';
                    nameReason = 'Currency name cannot be longer than 32 characters.';
                } else {
                    newCoinName = input;
                    nameStatus = input.toLowerCase() === 'coins' ? 'Default ⏪' : 'Updated ✅';
                }
            } else {
                newCoinName = 'Coins';
                nameStatus = 'Default ⏪';
            }

            // --- 2. Coin Emoji Status & Parsing ---
            let emojiStatus = 'Default ⏪';
            let emojiReason = null;
            let formattedEmoji = null;

            if (coinEmoji && coinEmoji.trim()) {
                const input = coinEmoji.trim();

                // Case A: Formatted Custom Emoji: <:name:id> or <a:name:id>
                const customMatch = input.match(/^<(a)?:([a-zA-Z0-9_]+):(\d{17,20})>$/);
                if (customMatch) {
                    const isAnimated = Boolean(customMatch[1]);
                    const name = customMatch[2];
                    const id = customMatch[3];
                    const found = interaction.guild?.emojis.cache.get(id) || interaction.client?.emojis.cache.get(id);
                    if (found) {
                        formattedEmoji = `<${found.animated ? 'a' : ''}:${found.name}:${found.id}>`;
                    } else {
                        const fetched = await interaction.guild?.emojis.fetch(id).catch(() => null) ||
                                        await interaction.client?.emojis.fetch(id).catch(() => null);
                        if (fetched) {
                            formattedEmoji = `<${fetched.animated ? 'a' : ''}:${fetched.name}:${fetched.id}>`;
                        } else {
                            formattedEmoji = `<${isAnimated ? 'a' : ''}:${name}:${id}>`;
                        }
                    }
                    emojiStatus = 'Updated ✅';
                }
                // Case B: Pure Snowflake ID: 17-20 digits
                else if (/^\d{17,20}$/.test(input)) {
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
                            formattedEmoji = `<:coin:${input}>`;
                            emojiStatus = 'Updated ✅';
                        }
                    }
                }
                // Case C: Emoji Name: e.g. :coin: or coin
                else if (/^:?[a-zA-Z0-9_]+:?$/.test(input) && !/^(\p{Extended_Pictographic}|\p{Emoji_Presentation})/u.test(input)) {
                    const cleanName = input.replace(/:/g, '').toLowerCase();
                    const found = interaction.guild?.emojis.cache.find(e => e.name.toLowerCase() === cleanName) ||
                                  interaction.client?.emojis.cache.find(e => e.name.toLowerCase() === cleanName);
                    if (found) {
                        formattedEmoji = `<${found.animated ? 'a' : ''}:${found.name}:${found.id}>`;
                        emojiStatus = 'Updated ✅';
                    } else {
                        emojiStatus = 'Failed ❌';
                        emojiReason = `Could not find emoji ":${cleanName}:" in this server.`;
                    }
                }
                // Case D: Standard Unicode Emoji (e.g. 🪙, 💰, 💎, 🔥)
                else {
                    const emojiRegex = /^(\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Emoji}\uFE0F|\u200D|\p{Emoji_Modifier})+$/u;
                    if (emojiRegex.test(input) && input.length <= 16) {
                        formattedEmoji = input;
                        emojiStatus = input === '🪙' ? 'Default ⏪' : 'Updated ✅';
                    } else {
                        emojiStatus = 'Failed ❌';
                        emojiReason = 'Could not recognize that emoji.';
                    }
                }
            } else {
                formattedEmoji = null;
                emojiStatus = 'Default ⏪';
            }

            // --- 3. Save to Database ---
            if (nameStatus.startsWith('Updated ✅')) {
                config.coin_name = newCoinName;
            } else if (nameStatus.startsWith('Default ⏪')) {
                config.coin_name = 'Coins';
            }

            if (emojiStatus.startsWith('Updated ✅')) {
                config.coin_emoji = formattedEmoji;
            } else if (emojiStatus.startsWith('Default ⏪')) {
                config.coin_emoji = null;
            }

            await setGuildConfig(guildId, config).catch((err) => {
                sysError('Failed to save coins customization config', err);
            });

            const formatField = (name, status, reason) => {
                if (reason) {
                    return `${name}: ${status}\n↳ *${reason}*`;
                }
                return `${name}: ${status}`;
            };

            // --- 4. Audit Logging ---
            const { getUserLogName } = await import('../shared.js');
            const logName = getUserLogName(interaction);
            const finalCoinName = config.coin_name || 'Coins';
            sendLog(interaction.guild, 'audit', 'cyan', `${finalCoinName} Customized`,
                `**Admin:** \`${logName}\`\n\n` +
                formatField(`**${finalCoinName} Name**`, nameStatus, nameReason) + '\n\n' +
                formatField(`**${finalCoinName} Emoji**`, emojiStatus, emojiReason)
            );

            // --- 5. Send Response ---
            const responseContent = [
                formatField(`${finalCoinName} Name`, nameStatus, nameReason),
                formatField(`${finalCoinName} Emoji`, emojiStatus, emojiReason)
            ].join('\n\n');

            await interaction.followUp({ content: responseContent, flags: MessageFlags.Ephemeral });
            return;
        }

        if (customId === 'settings_roles') {
            await showRolesMenu(interaction);
            return;
        }

        if (customId === 'settings_roles_auto' || customId === 'settings_users_roles') {
            await showRoleRewardsMenu(interaction);
            return;
        }

        if (customId === 'settings_roles_self') {
            await showSelfRolesDashboard(interaction);
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

        if (customId === 'settings_users_interface') {
            const { showInterfaceMainMenu } = await import('./interface.js');
            await showInterfaceMainMenu(interaction);
            return;
        }

        if (customId.startsWith('interface_') || customId.startsWith('admin_interface_')) {
            if (interaction.isModalSubmit && interaction.isModalSubmit()) {
                const { handleInterfaceModal } = await import('./interface.js');
                await handleInterfaceModal(interaction);
            } else {
                const { handleInterfaceComponent } = await import('./interface.js');
                await handleInterfaceComponent(interaction);
            }
            return;
        }

        if (customId.startsWith('admin_hub_')) {
            const { handleAdminHubComponent } = await import('./interface.js');
            await handleAdminHubComponent(interaction);
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

        if (customId.startsWith('logs_menu_')) {
            await handleLogMenuAction(interaction);
            return;
        }

        if (customId === 'logs_type_select' || customId === 'logs_category_select') {
            await handleLogCategorySelect(interaction);
            return;
        }

        if (customId.startsWith('logs_set_channel_') || customId.startsWith('logs_assign_')) {
            await handleLogChannelSelect(interaction);
            return;
        }

        if (customId.startsWith('logs_disable_')) {
            await handleLogDisable(interaction);
            return;
        }

        if (customId.startsWith('lb_menu_')) {
            await handleLeaderboardMenuAction(interaction);
            return;
        }

        if (customId === 'lb_type_select' || customId === 'leaderboard_type_select') {
            await handleLeaderboardCategorySelect(interaction);
            return;
        }

        if (customId.startsWith('lb_set_channel_') || customId.startsWith('leaderboard_channel_') || customId.startsWith('lb_assign_')) {
            await handleLeaderboardChannelSelectV2(interaction);
            return;
        }

        if (customId.startsWith('lb_disable_') || customId.startsWith('leaderboard_disable_')) {
            await handleLeaderboardDisable(interaction);
            return;
        }

        if (customId === 'lb_refresh' || customId === 'leaderboard_refresh') {
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

        if (customId.startsWith('admin_user_') || customId.startsWith('admin_manage_')) {
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
