import {
    SlashCommandBuilder,
    MessageFlags,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    PermissionFlagsBits,
    ChannelSelectMenuBuilder,
    ChannelType
} from 'discord.js';
// Config imports moved to dynamic imports within handlers to prevent scope errors
import { sendLog, sysLog, sysError } from '../utils/logger.js';
import { showSetupPanel as showMvpPanel, handleMvpComponent } from './mvp.js';
import { handleShopSetup as showShopPanel } from './shop-setup.js';
import { handleRewardsSetup as showRewardsPanel } from './rewards.js';
import { showColorPanel as showColorsPanel, handleColorsComponent } from './colors.js';
import { getLeaderboardConfig, setLeaderboardConfig, sendSingleLeaderboard } from './leaderboard.js';
import { 
    handleLeaderboardSettings, 
    handleLeaderboardCategorySelect, 
    handleLeaderboardChannelSelect as handleLeaderboardChannelSelectV2,
    handleLeaderboardRefresh as handleLeaderboardRefreshV2
} from './settings/leaderboards.js';
import { handleInteractionError } from '../utils/errors.js';

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

    // Row 1: Colors, Coins, Rewards (NEW Layout)
    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('settings_colors')
            .setLabel('Colors')
            .setEmoji('🎨')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('settings_coins')
            .setLabel('Coins')
            .setEmoji('<:OK_COIN:1490666813501997076>')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('settings_rewards_menu')
            .setLabel('Rewards')
            .setEmoji('🎁')
            .setStyle(ButtonStyle.Secondary)
    );

    // Row 2: Shop, Leaderboard, Logs
    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('settings_shop')
            .setLabel('Shop')
            .setEmoji('🛒')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('settings_leaderboards')
            .setLabel('Leaderboard')
            .setEmoji('📊')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('settings_logs')
            .setLabel('Logs')
            .setEmoji('📜')
            .setStyle(ButtonStyle.Secondary)
    );

    // Row 3: Users, Economy, Organize
    const row3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('settings_users')
            .setLabel('Users')
            .setEmoji('👥')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('settings_economy')
            .setLabel('Economy')
            .setEmoji('📈')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('settings_organize')
            .setLabel('Organize')
            .setEmoji('🧹')
            .setStyle(ButtonStyle.Secondary)
    );

    const responseMethod = (interaction.deferred || interaction.replied)
        ? 'editReply'
        : (interaction.isButton() ? 'update' : 'editReply');

    await interaction[responseMethod]({
        embeds: [embed],
        components: [row1, row2, row3]
    });
}

/**
 * Show the special Rewards Sub-Menu (Nested Hierarchy)
 */
export async function showRewardsSubMenu(interaction) {
    const embed = new EmbedBuilder()
        .setTitle('🎁 Rewards Modules')
        .setDescription('Manage your server\'s reward systems and events.')
        .setColor(0x2F3136);

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('settings_mvp')
            .setLabel('MVP')
            .setEmoji('🏆')
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

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('settings_home')
            .setLabel('Back to Settings')
            .setEmoji('⬅️')
            .setStyle(ButtonStyle.Secondary)
    );

    const responseMethod = interaction.isButton() ? 'update' : 'editReply';
    await interaction[responseMethod]({
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
        if (customId === 'settings_rewards_menu') {
            await showRewardsSubMenu(interaction);
            return;
        }

        if (customId === 'settings_coins') {
            await showRewardsPanel(interaction);
            return;
        }

        if (customId === 'settings_mvp') {
            const { getGuildConfig, setGuildConfig } = await import('../storage/config.js');
            const guildId = interaction.guildId;
            let config = await getGuildConfig(guildId);
            if (!config) {
                config = { enabled: true };
                await setGuildConfig(guildId, config);
            }
            await showMvpPanel(interaction, config);
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
            const { showUserSelector } = await import('./admin-users.js');
            await showUserSelector(interaction);
            return;
        }

        if (customId === 'settings_logs') {
            const { handleLogsSettings } = await import('./settings/logs.js');
            await handleLogsSettings(interaction);
            return;
        }

        if (customId === 'settings_economy' || customId.startsWith('economy_') || customId.startsWith('eco_')) {
            const { handleEconomySettings } = await import('./settings/economy.js');
            await handleEconomySettings(interaction);
            return;
        }

        if (customId === 'settings_organize' || customId.startsWith('organize_')) {
            const { handleOrganizeComponent } = await import('./settings/organize.js');
            await handleOrganizeComponent(interaction);
            return;
        }

        if (customId === 'quests_dashboard' || customId.startsWith('quests_')) {
            const { handleQuestsComponent } = await import('./quests-dashboard.js');
            await handleQuestsComponent(interaction);
            return;
        }

        if (customId === 'logs_category_select') {
            const { handleLogCategorySelect } = await import('./settings/logs.js');
            await handleLogCategorySelect(interaction);
            return;
        }

        if (customId.startsWith('logs_channel_select_')) {
            const { handleLogChannelSelect } = await import('./settings/logs.js');
            await handleLogChannelSelect(interaction);
            return;
        }

        if (customId.startsWith('logs_disable_btn_')) {
            const { handleLogDisable } = await import('./settings/logs.js');
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
            const { handleLeaderboardDisable } = await import('./settings/leaderboards.js');
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
            const { handleRewardsComponent } = await import('./rewards.js');
            await handleRewardsComponent(interaction);
            return;
        }

        if (customId.startsWith('colors_') || customId.startsWith('color_')) {
            await handleColorsComponent(interaction);
            return;
        }

        if (customId.startsWith('admin_user_')) {
            const { handleAdminUserComponent } = await import('./admin-users.js');
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
