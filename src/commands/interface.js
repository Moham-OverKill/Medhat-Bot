import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  AttachmentBuilder
} from 'discord.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { getGuildConfig, setGuildConfig } from '../storage/config.js';
import { getPool } from '../storage/postgres.js';
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const LOCAL_BANNER_PATH = path.join(__dirname, '../../assets/interface.png');
export const INTERFACE_BANNER_IMAGE = 'https://media.discordapp.net/attachments/1537838869570002994/1538293185070235668/RGWP2LQ.png?ex=6a8226ab&is=6a80d52b&hm=b96ca59f431d7c3a08a1981505efb337516294c4485beb56fe8e783c39e02a5e&animated=true';

export async function buildHubEmbed(guild, config = null) {
  const guildId = guild.id;
  const guildConfig = config || await getGuildConfig(guildId) || {};
  const coinEmoji = COIN_EMOJI.forGuild(guildId);

  // Active Quests Section
  const questsEnabled = guildConfig.quests_enabled ?? guildConfig.missions_enabled ?? false;
  let activeQuests = Array.isArray(guildConfig.active_quest_snapshot) ? guildConfig.active_quest_snapshot : [];
  let poolQuests = [];

  // Self-healing: If pool has available quests but active snapshot has fewer than targetCount, synchronize immediately
  if (questsEnabled) {
    const { getQuests } = await import('../quests/quests.js');
    poolQuests = await getQuests(guildId);
    const targetCount = Math.min(parseInt(guildConfig.quests_per_refresh, 10) || 3, poolQuests.length);
    if (poolQuests.length > 0 && activeQuests.length < targetCount) {
      const { rotateGuildQuests } = await import('../cron/quests.js');
      const { getPool: getPgPool } = await import('../storage/postgres.js');
      await rotateGuildQuests(guildId, guildConfig, getPgPool(), null, { skipNotifications: true });
      const freshConfig = await getGuildConfig(guildId);
      activeQuests = Array.isArray(freshConfig?.active_quest_snapshot) ? freshConfig.active_quest_snapshot : [];
    }
  }

  const refreshesPerDay = guildConfig.quests_refreshes_per_day || 1;
  const nextQuestDate = getNextQuestRefresh(refreshesPerDay);
  const nextQuestTs = Math.floor(nextQuestDate.getTime() / 1000);
  const nextMidnightDate = getNextCairoMidnight();
  const nextMidnightTs = Math.floor(nextMidnightDate.getTime() / 1000);

  const configuredCount = parseInt(guildConfig.quests_per_refresh, 10) || 3;
  const nextCycleCount = poolQuests.length > 0 ? Math.min(configuredCount, poolQuests.length) : configuredCount;
  const nextQuestLabel = nextCycleCount === 1 ? 'Next Quest' : 'Next Quests';

  let questContent = '';
  if (questsEnabled && activeQuests.length > 0) {
    const questLines = activeQuests.map(q => {
      const taskText = formatCompactQuest(q);
      const reward = parseInt(q.reward_coins, 10) || 0;
      return `• ${taskText}: +**${reward.toLocaleString()}** ${coinEmoji}`;
    });
    questContent = questLines.join('\n') + `\n\n${nextQuestLabel} <t:${nextQuestTs}:R>\nNext Daily <t:${nextMidnightTs}:R>`;
  } else if (questsEnabled) {
    questContent = `_No active quests currently._\n\n${nextQuestLabel} <t:${nextQuestTs}:R>\nNext Daily <t:${nextMidnightTs}:R>`;
  } else {
    questContent = `_Daily quests are currently paused._\n\nNext Daily <t:${nextMidnightTs}:R>`;
  }

  const isSingular = activeQuests.length === 1;
  const questFieldName = isSingular ? 'Current Quest' : 'Current Quests';

  const embed = new EmbedBuilder()
    .setTitle('INTERFACE')
    .setColor(0x000000)
    .setImage('attachment://interface.png')
    .addFields({
      name: questFieldName,
      value: questContent,
      inline: false
    });

  return embed;
}

/**
 * Build the 6 shortcut buttons for the Hub message matching the interface image exactly
 * Order and emojis mirror assets/interface.png (2 rows of 3, all gray buttons):
 * Row 1: ⭐ Level | 🎯 Quests | 💰 Claim Daily
 * Row 2: 🎒 Inventory | 🗳️ Vote | 🔔 Notifications
 * @param {import('discord.js').Client} [client]
 * @returns {ActionRowBuilder[]}
 */
export function buildHubButtons(client = null) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('hub_btn_level')
      .setEmoji('⭐')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('hub_btn_quests')
      .setEmoji('🎯')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('hub_btn_daily')
      .setEmoji('💰')
      .setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('hub_btn_inventory')
      .setEmoji('🎒')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('hub_btn_vote')
      .setEmoji('🗳️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('hub_btn_notifications')
      .setEmoji('🔔')
      .setStyle(ButtonStyle.Secondary)
  );

  return [row1, row2];
}

// Mutex lock to prevent concurrent duplicate hub message updates
const hubUpdateLocks = new Set();

/**
 * Publish or update the public Hub message in the designated channel
 * Edits existing message in-place to prevent duplicate messages and channel jumps.
 * @param {import('discord.js').Client} client 
 * @param {string} guildId 
 * @param {{ allowCreate?: boolean }} [options]
 * @returns {Promise<boolean>}
 */
export async function publishOrUpdateHub(client, guildId, options = {}) {
  const { allowCreate = false } = options;

  if (hubUpdateLocks.has(guildId)) {
    return false;
  }
  hubUpdateLocks.add(guildId);

  try {
    const config = await getGuildConfig(guildId) || {};
    const channelId = config.interface_channel_id;
    if (!channelId) return false;

    // If interface is not published yet and creation is not explicitly requested, do not auto-publish
    if (!config.interface_message_id && !allowCreate) {
      return false;
    }

    const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return false;

    const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      sysLog('Hub Channel Inaccessible', { guild: guildId, channel: channelId });
      return false;
    }

    const attachmentSource = fs.existsSync(LOCAL_BANNER_PATH) ? LOCAL_BANNER_PATH : INTERFACE_BANNER_IMAGE;
    const attachment = new AttachmentBuilder(attachmentSource, { name: 'interface.png' });

    const embed = await buildHubEmbed(guild, config);
    const buttonRows = buildHubButtons(client);
    const payload = {
      embeds: [embed],
      components: Array.isArray(buttonRows) ? buttonRows : [buttonRows],
      files: [attachment]
    };

    // 1. If an existing message exists, edit it in-place
    const oldMsgId = config.interface_message_id;
    if (oldMsgId) {
      const oldMessage = await channel.messages.fetch(oldMsgId).catch(() => null);
      if (oldMessage) {
        await oldMessage.edit(payload).catch(() => null);
        sysLog('Hub Message Updated In-Place', { guild: guildId, channel: channelId, messageId: oldMsgId });
        return true;
      }
    }

    // 2. If message doesn't exist and allowCreate is not allowed, do nothing
    if (!allowCreate) {
      return false;
    }

    // 3. Clean up any orphaned hub messages from the channel before creating a new one
    try {
      const recentMessages = await channel.messages.fetch({ limit: 25 }).catch(() => null);
      if (recentMessages) {
        for (const msg of recentMessages.values()) {
          if (msg.author.id === client.user.id) {
            const hasHubButtons = msg.components?.some(row =>
              row.components?.some(btn => btn.customId?.startsWith('hub_btn_'))
            );
            if (hasHubButtons) {
              await msg.delete().catch(() => {});
            }
          }
        }
      }
    } catch {
      // Non-blocking cleanup
    }

    // 4. Send new message
    const newMessage = await channel.send(payload).catch((err) => {
      sysError('Hub Message Send Failed', err, { guild: guildId, channel: channelId });
      return null;
    });

    if (newMessage) {
      config.interface_message_id = newMessage.id;
      await setGuildConfig(guildId, config);
      sysLog('Hub Message Freshly Published', { guild: guildId, channel: channelId, messageId: newMessage.id });
      return true;
    }

    return false;
  } catch (error) {
    sysError('Hub Publish/Update Error', error, { guild: guildId });
    return false;
  } finally {
    hubUpdateLocks.delete(guildId);
  }
}

/**
 * Render the Admin Interface Configuration Panel in /settings -> Users -> Interface
 * All buttons styled in gray (ButtonStyle.Secondary)
 * Layout:
 * - Row 0: Target Channel Selector
 * - Row 1: [ Enable / Disable ] | [ Update ]
 * - Row 2: [ Back ]
 * @param {import('discord.js').ButtonInteraction|import('discord.js').ModalSubmitInteraction|import('discord.js').ChannelSelectMenuInteraction} interaction 
 * @param {Object} [configOverride]
 */
export async function showInterfaceSettings(interaction, configOverride = null) {
  const guildId = interaction.guildId;
  const config = configOverride || await getGuildConfig(guildId) || {};

  const currentChannel = config.interface_channel_id ? `<#${config.interface_channel_id}>` : '*Not Set*';
  const isPublished = Boolean(config.interface_channel_id && config.interface_message_id);

  let statusText = '`🔴 Not Configured`';
  if (isPublished) {
    statusText = '`🟢 Published & Active`';
  } else if (config.interface_channel_id) {
    statusText = '`🟡 Pending Deployment`';
  }

  const desc = [
    'Configure the public Community Interface message with active quests, countdown timers, and quick shortcuts.\n',
    `• **Target Channel:** ${currentChannel}`,
    `• **Status:** ${statusText}\n`,
    '**Interface Shortcuts (Matching Interface Graphic):**',
    '• Row 1: ⭐ Level  •  🎯 Quests  •  💰 Claim Daily',
    '• Row 2: 🎒 Inventory  •  🗳️ Vote  •  🔔 Notifications'
  ].join('\n');

  const embed = new EmbedBuilder()
    .setTitle('Interface Configuration')
    .setDescription(desc)
    .setColor(0x5865F2);

  // Row 0: Channel Selector
  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId('interface_set_channel')
    .setPlaceholder('Select target channel for the Interface...')
    .setChannelTypes(ChannelType.GuildText);

  if (config.interface_channel_id) {
    channelSelect.setDefaultChannels([config.interface_channel_id]);
  }

  // Row 1: [ Enable / Disable ] | [ Update ] (all gray)
  const toggleBtn = isPublished
    ? new ButtonBuilder()
        .setCustomId('interface_disable_btn')
        .setLabel('Disable')
        .setEmoji('🔴')
        .setStyle(ButtonStyle.Secondary)
    : new ButtonBuilder()
        .setCustomId('interface_enable_btn')
        .setLabel('Enable')
        .setEmoji('🟢')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!config.interface_channel_id);

  const updateBtn = new ButtonBuilder()
    .setCustomId('interface_publish_btn')
    .setLabel(isPublished ? 'Update' : 'Publish')
    .setEmoji('🔄')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(!config.interface_channel_id);

  const row1 = new ActionRowBuilder().addComponents(toggleBtn, updateBtn);

  // Row 2: [ Back ] (gray)
  const backBtn = new ButtonBuilder()
    .setCustomId('settings_users')
    .setLabel('Back')
    .setEmoji('⬅️')
    .setStyle(ButtonStyle.Secondary);

  const row2 = new ActionRowBuilder().addComponents(backBtn);

  const components = [
    new ActionRowBuilder().addComponents(channelSelect),
    row1,
    row2
  ];

  const method = (interaction.deferred || interaction.replied)
    ? 'editReply'
    : (interaction.isButton() || interaction.isAnySelectMenu() ? 'update' : 'editReply');

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
    const deny = { content: 'Administrator permission required.', flags: MessageFlags.Ephemeral };
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
          content: `Cannot use that channel. ${permCheck.error}\nPlease ensure the bot has View Channel, Send Messages, and Embed Links permissions there.`,
          flags: MessageFlags.Ephemeral
        });
      }

      const config = await getGuildConfig(guildId) || {};
      config.interface_channel_id = channelId;
      await setGuildConfig(guildId, config);

      const logName = getUserLogName(interaction);
      sendLog(interaction.guild, 'audit', 'cyan', 'Interface Channel Assigned',
        `**Admin:** \`${logName}\`\n` +
        `**Channel:** <#${channelId}>`
      );

      return showInterfaceSettings(interaction, config);
    }

    // 2. Publish / Update
    if (customId === 'interface_publish_btn' || customId === 'interface_enable_btn') {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});

      const config = await getGuildConfig(guildId) || {};
      if (!config.interface_channel_id) {
        return interaction.followUp({
          content: 'Please select a target channel first before publishing the Interface.',
          flags: MessageFlags.Ephemeral
        });
      }

      const success = await publishOrUpdateHub(interaction.client, guildId, { allowCreate: true });
      const freshConfig = await getGuildConfig(guildId) || {};

      if (success) {
        const logName = getUserLogName(interaction);
        sendLog(interaction.guild, 'audit', 'cyan', 'Interface Published/Updated',
          `**Admin:** \`${logName}\`\n` +
          `**Channel:** <#${freshConfig.interface_channel_id}>`
        );

        await interaction.followUp({
          content: `Interface published successfully to <#${freshConfig.interface_channel_id}>!`,
          flags: MessageFlags.Ephemeral
        });
      } else {
        await interaction.followUp({
          content: 'Failed to publish the Interface. Please verify channel permissions and try again.',
          flags: MessageFlags.Ephemeral
        });
      }

      return showInterfaceSettings(interaction, freshConfig);
    }

    // 3. Disable / Unbind
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

      config.interface_message_id = null;
      await setGuildConfig(guildId, config);

      const logName = getUserLogName(interaction);
      sendLog(interaction.guild, 'audit', 'red', 'Interface Disabled',
        `**Admin:** \`${logName}\`\n` +
        `**Action:** Disabled the published interface.`
      );

      return showInterfaceSettings(interaction, config);
    }

  } catch (error) {
    await handleInteractionError(interaction, error, 'interface component');
  }
}

export async function handleInterfaceModal(interaction) {
  // Appearance customization has been deprecated
}

/**
 * Handle interactive ephemeral Hub shortcut buttons
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
export async function handleHubShortcut(interaction) {
  const customId = interaction.customId;
  const guildId = interaction.guildId;
  const userId = interaction.user.id;

  try {
    // 1. Level Shortcut (⭐)
    if (customId === 'hub_btn_level') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const payload = await getLevelViewPayload(guildId, userId, 'level');
      return interaction.editReply(payload);
    }

    // 2. Quests Shortcut (🎯)
    if (customId === 'hub_btn_quests') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const { renderQuests } = await import('./quest.js');
      return renderQuests(interaction, 0);
    }

    // 3. Daily Shortcut (💰)
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

          return interaction.editReply({
            content: `You already claimed your daily! Try again <t:${nextMidnightTs}:R>.`,
            embeds: []
          });
        }

        throw new Error(result.error);
      }

      const logUsername = getUserLogName(member);
      const initialBal = result.balance - result.amount;
      sendLog(interaction.guild, 'economy', 'orange', 'Daily Claimed',
        `**User:** \`${logUsername}\`\n` +
        `**Reward:** \`${result.amount.toLocaleString()}\` ${coinEmoji} (Daily)\n` +
        `**Streak:** \`${result.streak} days\`\n` +
        `**Balance:** \`${initialBal.toLocaleString()}\` ➡️ \`${result.balance.toLocaleString()}\``
      );

      const { breakdown } = result;
      let msg = `You received **${result.amount}** ${coinEmoji}\n`;
      msg += `> Base: **+${breakdown.base}**\n`;
      msg += `> Streak Bonus: **+${breakdown.streakBonus}**\n`;
      msg += `> Boost Bonus: **+${breakdown.boostBonus}**\n`;

      return interaction.editReply({ files: [], content: msg, embeds: [] });
    }

    // 4. Inventory Shortcut (🎒)
    if (customId === 'hub_btn_inventory') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      return handleInventoryButton(interaction);
    }

    // 5. Vote Shortcut (🗳️)
    if (customId === 'hub_btn_vote') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const { handleVoteCommand } = await import('./vote.js');
      return handleVoteCommand(interaction);
    }

    // 6. Notifications Shortcut (🔔)
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
