import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  PermissionFlagsBits
} from 'discord.js';
import { getGuildConfig, setGuildConfig } from '../storage/config.js';
import { getNextQuestRefresh, getNextCairoMidnight } from '../utils/time.js';
import { formatCompactQuest } from '../quests/quests.js';
import { claimDaily } from '../economy/service.js';
import { getLevelViewPayload } from './pass.js';
import { buildNotificationsPayload } from './notifications.js';
import { getUserNotificationSettings } from '../storage/notifications.js';
import { handleInventoryButton } from './bank.js';
import { isMemberBooster } from './colors.js';
import { COIN_EMOJI, getUserDisplayName, getUserLogName } from '../shared.js';
import { sendLog, sysLog, sysError, checkChannelPermissions } from '../utils/logger.js';
import { handleInteractionError } from '../utils/errors.js';

/**
 * Validate and parse a hex color string into an integer
 * @param {string} colorStr 
 * @param {number} fallback 
 * @returns {number}
 */
export function parseColor(colorStr, fallback = 0x5865F2) {
  if (!colorStr) return fallback;
  const clean = colorStr.trim().replace(/^#/, '').replace(/^0x/i, '');
  const parsed = parseInt(clean, 16);
  if (isNaN(parsed) || parsed < 0 || parsed > 0xFFFFFF) return fallback;
  return parsed;
}

/**
 * Build the public Hub embed for a guild
 * @param {import('discord.js').Guild} guild 
 * @param {Object} config 
 * @returns {Promise<EmbedBuilder>}
 */
export async function buildHubEmbed(guild, config = null) {
  const guildId = guild.id;
  const guildConfig = config || await getGuildConfig(guildId) || {};
  const coinEmoji = COIN_EMOJI.forGuild(guildId);

  const rawTitle = (guildConfig.interface_title || 'Server Hub').trim();
  const rawEmoji = (guildConfig.interface_emoji || '🖥️').trim();
  const rawColor = guildConfig.interface_color || '#5865F2';
  const embedColor = parseColor(rawColor, 0x5865F2);

  const titleWithEmoji = rawEmoji ? `${rawEmoji} ${rawTitle}` : rawTitle;

  // Active Quests Section
  const questsEnabled = guildConfig.quests_enabled ?? guildConfig.missions_enabled ?? false;
  const activeQuests = guildConfig.active_quest_snapshot || [];
  const refreshesPerDay = guildConfig.quests_refreshes_per_day || 1;
  const nextQuestDate = getNextQuestRefresh(refreshesPerDay);
  const nextQuestTs = Math.floor(nextQuestDate.getTime() / 1000);
  const nextMidnightDate = getNextCairoMidnight();
  const nextMidnightTs = Math.floor(nextMidnightDate.getTime() / 1000);

  let questContent = '';
  if (questsEnabled && activeQuests.length > 0) {
    const questLines = activeQuests.map(q => {
      const taskText = formatCompactQuest(q);
      const reward = parseInt(q.reward_coins, 10) || 0;
      return `• ${taskText}: +**${reward.toLocaleString()}** ${coinEmoji}`;
    });
    questContent = questLines.join('\n') + `\n\nNext Quests <t:${nextQuestTs}:R>\nNext Daily <t:${nextMidnightTs}:R>`;
  } else if (questsEnabled) {
    questContent = `_No active quests currently._\n\nNext Quests <t:${nextQuestTs}:R>\nNext Daily <t:${nextMidnightTs}:R>`;
  } else {
    questContent = `_Daily quests are currently paused._\n\nNext Daily <t:${nextMidnightTs}:R>`;
  }

  const embed = new EmbedBuilder()
    .setTitle(titleWithEmoji)
    .setColor(embedColor)
    .addFields({
      name: '🎯 Active Quests',
      value: questContent,
      inline: false
    });

  return embed;
}

/**
 * Build the 5 shortcut buttons for the Hub message
 * @param {import('discord.js').Client} client 
 * @returns {ActionRowBuilder}
 */
export function buildHubButtons(client) {
  const botId = client?.user?.id || 'bot';

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('hub_btn_level')
      .setLabel('Level')
      .setEmoji('⭐')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('hub_btn_daily')
      .setLabel('Daily')
      .setEmoji('💰')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('hub_btn_inventory')
      .setLabel('Inventory')
      .setEmoji('🎒')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setLabel('Vote')
      .setEmoji('🗳️')
      .setStyle(ButtonStyle.Link)
      .setURL(`https://top.gg/bot/${botId}/vote`),
    new ButtonBuilder()
      .setCustomId('hub_btn_notifications')
      .setLabel('Notifications')
      .setEmoji('🔔')
      .setStyle(ButtonStyle.Secondary)
  );

  return row;
}

/**
 * Publish or update the public Hub message in the designated channel
 * Self-healing: if the previous message was deleted, it sends a new one and updates DB.
 * @param {import('discord.js').Client} client 
 * @param {string} guildId 
 * @returns {Promise<boolean>}
 */
export async function publishOrUpdateHub(client, guildId) {
  try {
    const config = await getGuildConfig(guildId) || {};
    const channelId = config.interface_channel_id;
    if (!channelId) return false;

    const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return false;

    const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      sysLog('Hub Channel Inaccessible', { guild: guildId, channel: channelId });
      return false;
    }

    const embed = await buildHubEmbed(guild, config);
    const buttonsRow = buildHubButtons(client);
    const payload = { embeds: [embed], components: [buttonsRow] };

    const oldMsgId = config.interface_message_id;
    let messageUpdated = false;

    if (oldMsgId) {
      const oldMessage = await channel.messages.fetch(oldMsgId).catch(() => null);
      if (oldMessage) {
        await oldMessage.edit(payload).catch(() => null);
        messageUpdated = true;
      }
    }

    // If message was deleted or not found, send a fresh one and save the new ID
    if (!messageUpdated) {
      const newMessage = await channel.send(payload).catch((err) => {
        sysError('Hub Message Send Failed', err, { guild: guildId, channel: channelId });
        return null;
      });

      if (newMessage) {
        config.interface_message_id = newMessage.id;
        await setGuildConfig(guildId, config);
        sysLog('Hub Message Published', { guild: guildId, channel: channelId, messageId: newMessage.id });
      }
    }

    return true;
  } catch (error) {
    sysError('Hub Publish/Update Error', error, { guild: guildId });
    return false;
  }
}

/**
 * Render the Admin Interface Configuration Panel in /settings -> Users -> Interface
 * @param {import('discord.js').ButtonInteraction|import('discord.js').ModalSubmitInteraction|import('discord.js').ChannelSelectMenuInteraction} interaction 
 * @param {Object} [configOverride]
 */
export async function showInterfaceSettings(interaction, configOverride = null) {
  const guildId = interaction.guildId;
  const config = configOverride || await getGuildConfig(guildId) || {};

  const currentChannel = config.interface_channel_id ? `<#${config.interface_channel_id}>` : '*Not Set*';
  const currentTitle = (config.interface_title || 'Server Hub').trim();
  const currentEmoji = (config.interface_emoji || '🖥️').trim();
  const currentColor = config.interface_color || '#5865F2';
  const isPublished = Boolean(config.interface_channel_id && config.interface_message_id);

  const desc = [
    'Configure the public Community Interface (Server Hub) message with live active quests, countdown timers, and shortcut buttons.\n',
    `• **Target Channel:** ${currentChannel}`,
    `• **Title:** \`${currentEmoji} ${currentTitle}\``,
    `• **Embed Color:** \`${currentColor}\``,
    `• **Status:** ${isPublished ? '`🟢 Published & Active`' : config.interface_channel_id ? '`🟡 Pending Deployment`' : '`🔴 Not Configured`'}`
  ].join('\n');

  const embed = new EmbedBuilder()
    .setTitle('🖥️ Interface Configuration')
    .setDescription(desc)
    .setColor(0x5865F2);

  // Row 1: Channel Selector
  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId('interface_set_channel')
    .setPlaceholder('Select target channel for the Interface...')
    .setChannelTypes(ChannelType.GuildText);

  if (config.interface_channel_id) {
    channelSelect.setDefaultChannels([config.interface_channel_id]);
  }

  // Row 2: Action Buttons
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('settings_users')
      .setLabel('Back')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('interface_edit_modal_btn')
      .setLabel('Edit Appearance')
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('interface_publish_btn')
      .setLabel(isPublished ? 'Force Update' : 'Publish')
      .setEmoji('🚀')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!config.interface_channel_id),
    new ButtonBuilder()
      .setCustomId('interface_disable_btn')
      .setLabel('Disable')
      .setEmoji('✖️')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!config.interface_channel_id)
  );

  const components = [
    new ActionRowBuilder().addComponents(channelSelect),
    row2
  ];

  const method = (interaction.deferred || interaction.replied) ? 'editReply' : (interaction.isButton() || interaction.isAnySelectMenu() ? 'update' : 'editReply');
  await interaction[method]({ embeds: [embed], components, content: '' });
}

/**
 * Handle Interface setup component interactions
 * @param {import('discord.js').Interaction} interaction 
 */
export async function handleInterfaceComponent(interaction) {
  const guildId = interaction.guildId;
  const customId = interaction.customId;

  // Runtime Admin check
  if (!interaction.member?.permissions.has(PermissionFlagsBits.Administrator)) {
    const deny = { content: '⛔ Administrator permission required.', flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) return interaction.followUp(deny);
    return interaction.reply(deny);
  }

  try {
    // 1. Channel Select
    if (customId === 'interface_set_channel') {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
      const channelId = interaction.values[0];

      const channel = interaction.guild.channels.cache.get(channelId) || await interaction.guild.channels.fetch(channelId).catch(() => null);
      const permCheck = checkChannelPermissions(channel);
      if (!permCheck.valid) {
        return interaction.followUp({
          content: `❌ **Cannot use that channel.** ${permCheck.error}\nPlease ensure the bot has **View Channel**, **Send Messages**, and **Embed Links** permissions there.`,
          flags: MessageFlags.Ephemeral
        });
      }

      const config = await getGuildConfig(guildId) || {};
      config.interface_channel_id = channelId;
      await setGuildConfig(guildId, config);

      const logName = getUserLogName(interaction);
      sendLog(interaction.guild, 'audit', 'cyan', '🖥️ Interface Channel Assigned',
        `**Admin:** \`${logName}\`\n` +
        `**Channel:** <#${channelId}>`
      );

      return showInterfaceSettings(interaction, config);
    }

    // 2. Open Edit Appearance Modal
    if (customId === 'interface_edit_modal_btn') {
      const config = await getGuildConfig(guildId) || {};
      const currentTitle = config.interface_title || 'Server Hub';
      const currentEmoji = config.interface_emoji || '🖥️';
      const currentColor = config.interface_color || '#5865F2';

      const modal = new ModalBuilder()
        .setCustomId('interface_edit_modal')
        .setTitle('Edit Interface Appearance');

      const titleInput = new TextInputBuilder()
        .setCustomId('interface_title_input')
        .setLabel('Embed Title')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Server Hub')
        .setValue(config.interface_title ? currentTitle : '')
        .setMaxLength(64)
        .setRequired(false);

      const emojiInput = new TextInputBuilder()
        .setCustomId('interface_emoji_input')
        .setLabel('Title Emoji (Unicode or Custom <:name:id>)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('🖥️')
        .setValue(config.interface_emoji ? currentEmoji : '')
        .setMaxLength(64)
        .setRequired(false);

      const colorInput = new TextInputBuilder()
        .setCustomId('interface_color_input')
        .setLabel('Embed Color Code (e.g. #5865F2, #2F3136)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('#5865F2')
        .setValue(config.interface_color ? currentColor : '')
        .setMaxLength(10)
        .setRequired(false);

      modal.addComponents(
        new ActionRowBuilder().addComponents(titleInput),
        new ActionRowBuilder().addComponents(emojiInput),
        new ActionRowBuilder().addComponents(colorInput)
      );

      return interaction.showModal(modal);
    }

    // 3. Publish / Force Update
    if (customId === 'interface_publish_btn') {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});

      const success = await publishOrUpdateHub(interaction.client, guildId);
      const config = await getGuildConfig(guildId) || {};

      if (success) {
        const logName = getUserLogName(interaction);
        sendLog(interaction.guild, 'audit', 'cyan', '🖥️ Interface Published/Updated',
          `**Admin:** \`${logName}\`\n` +
          `**Channel:** <#${config.interface_channel_id}>`
        );

        await interaction.followUp({
          content: `✅ Interface published successfully to <#${config.interface_channel_id}>!`,
          flags: MessageFlags.Ephemeral
        });
      } else {
        await interaction.followUp({
          content: '❌ Failed to publish the Interface. Please verify channel permissions and try again.',
          flags: MessageFlags.Ephemeral
        });
      }

      return showInterfaceSettings(interaction, config);
    }

    // 4. Disable / Unbind
    if (customId === 'interface_disable_btn') {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});

      const config = await getGuildConfig(guildId) || {};
      const oldChanId = config.interface_channel_id;
      const oldMsgId = config.interface_message_id;

      if (oldChanId && oldMsgId) {
        const channel = interaction.guild.channels.cache.get(oldChanId) || await interaction.guild.channels.fetch(oldChanId).catch(() => null);
        if (channel && channel.isTextBased()) {
          const oldMsg = await channel.messages.fetch(oldMsgId).catch(() => null);
          if (oldMsg) await oldMsg.delete().catch(() => {});
        }
      }

      config.interface_channel_id = null;
      config.interface_message_id = null;
      await setGuildConfig(guildId, config);

      const logName = getUserLogName(interaction);
      sendLog(interaction.guild, 'audit', 'red', '🖥️ Interface Disabled',
        `**Admin:** \`${logName}\`\n` +
        `**Action:** Disabled the published interface.`
      );

      return showInterfaceSettings(interaction, config);
    }

  } catch (error) {
    await handleInteractionError(interaction, error, 'interface component');
  }
}

/**
 * Handle Modal Submit for Interface appearance
 * @param {import('discord.js').ModalSubmitInteraction} interaction 
 */
export async function handleInterfaceModal(interaction) {
  const guildId = interaction.guildId;

  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});

    const title = (interaction.fields.getTextInputValue('interface_title_input') || '').trim() || 'Server Hub';
    const emoji = (interaction.fields.getTextInputValue('interface_emoji_input') || '').trim() || '🖥️';
    const color = (interaction.fields.getTextInputValue('interface_color_input') || '').trim() || '#5865F2';

    const config = await getGuildConfig(guildId) || {};
    config.interface_title = title;
    config.interface_emoji = emoji;
    config.interface_color = color;
    await setGuildConfig(guildId, config);

    // If already published, auto-update the live message
    if (config.interface_channel_id) {
      await publishOrUpdateHub(interaction.client, guildId);
    }

    const logName = getUserLogName(interaction);
    sendLog(interaction.guild, 'audit', 'cyan', '🖥️ Interface Appearance Updated',
      `**Admin:** \`${logName}\`\n` +
      `**Title:** \`${emoji} ${title}\`\n` +
      `**Color:** \`${color}\``
    );

    return showInterfaceSettings(interaction, config);
  } catch (error) {
    await handleInteractionError(interaction, error, 'interface modal');
  }
}

/**
 * Handle the 4 active ephemeral Hub shortcut buttons
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
export async function handleHubShortcut(interaction) {
  const customId = interaction.customId;
  const guildId = interaction.guildId;
  const userId = interaction.user.id;

  try {
    // 1. Level Shortcut
    if (customId === 'hub_btn_level') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const payload = await getLevelViewPayload(guildId, userId, 'level');
      return interaction.editReply(payload);
    }

    // 2. Daily Shortcut
    if (customId === 'hub_btn_daily') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const member = interaction.member;
      const isBooster = await isMemberBooster(member);
      const coinEmoji = COIN_EMOJI.forGuild(guildId);
      const result = await claimDaily(userId, guildId, getUserDisplayName(member), isBooster);

      if (!result.success) {
        if (result.error === 'daily_claimed') {
          const nextMidnight = getNextCairoMidnight();
          const nextMidnightTs = Math.floor(nextMidnight.getTime() / 1000);

          const alreadyClaimedEmbed = new EmbedBuilder()
            .setTitle('⏳ Daily Already Claimed')
            .setColor(0xE74C3C)
            .setDescription(`You have already claimed your daily reward today.\nYour next claim will be available **<t:${nextMidnightTs}:R>**.`);

          return interaction.editReply({ embeds: [alreadyClaimedEmbed] });
        }

        throw new Error(result.error);
      }

      const logUsername = getUserLogName(member);
      const initialBal = result.balance - result.amount;
      sendLog(interaction.guild, 'economy', 'orange', '💰 Daily Claimed',
        `**User:** \`${logUsername}\`\n` +
        `**Reward:** \`${result.amount.toLocaleString()}\` ${coinEmoji} (Daily)\n` +
        `**Streak:** \`${result.streak} days\`\n` +
        `**Balance:** \`${initialBal.toLocaleString()}\` ➡️ \`${result.balance.toLocaleString()}\``
      );

      const successEmbed = new EmbedBuilder()
        .setTitle('💰 Daily Reward Claimed!')
        .setColor(0x2ECC71)
        .setDescription([
          `• **Earned:** **+${result.amount.toLocaleString()}** ${coinEmoji}`,
          `• **Daily Streak:** **${result.streak} days** 🔥`,
          `• **New Balance:** **${result.balance.toLocaleString()}** ${coinEmoji}`
        ].join('\n'));

      return interaction.editReply({ embeds: [successEmbed] });
    }

    // 3. Inventory Shortcut
    if (customId === 'hub_btn_inventory') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      return handleInventoryButton(interaction);
    }

    // 4. Notifications Shortcut
    if (customId === 'hub_btn_notifications') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const settings = await getUserNotificationSettings(guildId, userId);
      const payload = buildNotificationsPayload(interaction.guild, settings);
      return interaction.editReply(payload);
    }

  } catch (error) {
    await handleInteractionError(interaction, error, 'hub shortcut');
  }
}
