import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags
} from 'discord.js';
import {
  NOTIFICATION_KEYS,
  getUserNotificationSettings,
  toggleUserNotificationSetting
} from '../storage/notifications.js';
import { handleInteractionError } from '../utils/errors.js';

export const notificationsCommand = new SlashCommandBuilder()
  .setName('notifications')
  .setDescription('Configure your direct message (DM) notifications for this server');

/**
 * Build the ephemeral dashboard payload for notification settings
 * @param {import('discord.js').Guild} guild
 * @param {Object} settings
 * @returns {{ embeds: EmbedBuilder[], components: ActionRowBuilder[], flags: number }}
 */
export function buildNotificationsPayload(guild, settings) {
  const guildName = guild?.name || 'Discord Server';

  const desc = [
    `Customize which direct message (DM) notifications you receive for **${guildName}**.\n`,
    `• **Level-Up Rewards:** ${settings.notif_level_up ? '`🟢 Enabled`' : '`🔴 Disabled`'}`,
    `↳ *Receive a DM when you reach a new level and unlock rewards.*`,
    ``,
    `• **Daily Claim Reminder:** ${settings.notif_daily_claim ? '`🟢 Enabled`' : '`🔴 Disabled`'}`,
    `↳ *Receive a DM reminder when your daily reward is ready to claim.*`,
    ``,
    `• **Trade Requests:** ${settings.notif_trades ? '`🟢 Enabled`' : '`🔴 Disabled`'}`,
    `↳ *Receive a DM when another member sends you an incoming trade offer.*`,
    ``,
    `• **Daily MVP Winner:** ${settings.notif_mvp_win ? '`🟢 Enabled`' : '`🔴 Disabled`'}`,
    `↳ *Receive a DM if you are selected as one of the daily server MVPs.*`,
    ``,
    `• **Quest Rotations:** ${settings.notif_quests_refresh ? '`🟢 Enabled`' : '`🔴 Disabled`'}`,
    `↳ *Receive a DM whenever server quests rotate with new tasks.*`
  ].join('\n');

  const embed = new EmbedBuilder()
    .setTitle(`🔔 DM Notifications`)
    .setDescription(desc)
    .setColor(0x5865F2);

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`notif_toggle_${NOTIFICATION_KEYS.LEVEL_UP}`)
      .setLabel('Level Up')
      .setEmoji('⭐')
      .setStyle(settings.notif_level_up ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`notif_toggle_${NOTIFICATION_KEYS.DAILY_CLAIM}`)
      .setLabel('Daily Claim')
      .setEmoji('💰')
      .setStyle(settings.notif_daily_claim ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`notif_toggle_${NOTIFICATION_KEYS.TRADES}`)
      .setLabel('Trades')
      .setEmoji('🤝')
      .setStyle(settings.notif_trades ? ButtonStyle.Success : ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`notif_toggle_${NOTIFICATION_KEYS.MVP_WIN}`)
      .setLabel('MVP Winner')
      .setEmoji('🏆')
      .setStyle(settings.notif_mvp_win ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`notif_toggle_${NOTIFICATION_KEYS.QUESTS_REFRESH}`)
      .setLabel('Quest Rotations')
      .setEmoji('🎯')
      .setStyle(settings.notif_quests_refresh ? ButtonStyle.Success : ButtonStyle.Secondary)
  );

  return {
    embeds: [embed],
    components: [row1, row2],
    flags: MessageFlags.Ephemeral
  };
}

/**
 * Handle /notifications Slash Command
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function handleNotificationsCommand(interaction) {
  try {
    const guild = interaction.guild;
    if (!guild) {
      return interaction.reply({ content: '❌ This command can only be used inside a server.', flags: MessageFlags.Ephemeral });
    }

    const settings = await getUserNotificationSettings(guild.id, interaction.user.id);
    const payload = buildNotificationsPayload(guild, settings);

    await interaction.reply(payload);
  } catch (error) {
    await handleInteractionError(interaction, error, 'notifications command');
  }
}

/**
 * Handle notification toggle button components
 * @param {import('discord.js').ButtonInteraction} interaction
 */
export async function handleNotificationsComponent(interaction) {
  try {
    const guild = interaction.guild;
    const customId = interaction.customId;

    if (!guild) {
      return interaction.reply({ content: '❌ This action can only be performed inside a server.', flags: MessageFlags.Ephemeral });
    }

    if (customId.startsWith('notif_toggle_')) {
      const key = customId.replace('notif_toggle_', '');
      const updatedSettings = await toggleUserNotificationSetting(guild.id, interaction.user.id, key);
      const payload = buildNotificationsPayload(guild, updatedSettings);

      await interaction.update(payload);
    }
  } catch (error) {
    await handleInteractionError(interaction, error, 'notifications component');
  }
}
