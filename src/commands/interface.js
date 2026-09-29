import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  StringSelectMenuBuilder,
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

export const SHORTCUT_REGISTRY = {
  level: {
    id: 'level',
    name: 'Level',
    description: 'Check level, XP, and rank progress',
    emoji: '⭐',
    buttonCustomId: 'hub_btn_level'
  },
  quests: {
    id: 'quests',
    name: 'Quests',
    description: 'View active quests and claim rewards',
    emoji: '🎯',
    buttonCustomId: 'hub_btn_quests'
  },
  daily: {
    id: 'daily',
    name: 'Claim Daily',
    description: 'Claim daily coins and streak bonuses',
    emoji: '💰',
    buttonCustomId: 'hub_btn_daily'
  },
  inventory: {
    id: 'inventory',
    name: 'Inventory',
    description: 'Manage items and equipped roles',
    emoji: '🎒',
    buttonCustomId: 'hub_btn_inventory'
  },
  vote: {
    id: 'vote',
    name: 'Vote',
    description: 'Vote for the server and get rewards',
    emoji: '🗳️',
    buttonCustomId: 'hub_btn_vote'
  },
  notifications: {
    id: 'notifications',
    name: 'Notifications',
    description: 'Toggle DM notification preferences',
    emoji: '🔔',
    buttonCustomId: 'hub_btn_notifications'
  },
  bank: {
    id: 'bank',
    name: 'Bank',
    description: 'Open the bank and wallet manager',
    emoji: '🏦',
    buttonCustomId: 'hub_btn_bank'
  },
  items: {
    id: 'items',
    name: 'Shop Items',
    description: 'Browse items available in the shop',
    emoji: '🛒',
    buttonCustomId: 'hub_btn_items'
  },
  profile: {
    id: 'profile',
    name: 'Profile',
    description: 'View your arcane profile card',
    emoji: '👤',
    buttonCustomId: 'hub_btn_profile'
  }
};

export const DEFAULT_SHORTCUT_ORDER = [
  'level',
  'quests',
  'daily',
  'inventory',
  'vote',
  'notifications'
];

export function getShortcutMeta(id) {
  if (id && SHORTCUT_REGISTRY[id]) {
    return SHORTCUT_REGISTRY[id];
  }
  return null;
}

export function normalizeShortcutOrder(order) {
  if (!Array.isArray(order) || order.length === 0) {
    return [...DEFAULT_SHORTCUT_ORDER];
  }

  const result = [];
  const maxSlots = Math.min(order.length, 12);
  for (let i = 0; i < maxSlots; i++) {
    const rawId = order[i];
    if (rawId && SHORTCUT_REGISTRY[rawId]) {
      result.push(rawId);
    } else {
      result.push(DEFAULT_SHORTCUT_ORDER[i % DEFAULT_SHORTCUT_ORDER.length] || 'level');
    }
  }

  if (result.length === 0) {
    return [...DEFAULT_SHORTCUT_ORDER];
  }

  return result;
}

/**
 * Fetch interface configuration for a server from PostgreSQL
 * @param {string} guildId 
 * @returns {Promise<{ guild_id: string, is_enabled: boolean, shortcut_order: string[], target_channel_id: string|null, message_id: string|null }>}
 */
export async function getInterfaceConfig(guildId) {
  try {
    const pool = getPool();
    const res = await pool.query(
      `SELECT guild_id, is_enabled, shortcut_order, target_channel_id, message_id 
       FROM server_interface_config 
       WHERE guild_id = $1`,
      [guildId]
    );

    if (res.rows.length > 0) {
      const row = res.rows[0];
      return {
        guild_id: row.guild_id,
        is_enabled: Boolean(row.is_enabled),
        shortcut_order: normalizeShortcutOrder(row.shortcut_order),
        target_channel_id: row.target_channel_id || null,
        message_id: row.message_id || null
      };
    }

    // Fallback: check legacy guild_configs
    const guildConfig = await getGuildConfig(guildId) || {};
    const fallbackChannel = guildConfig.interface_channel_id || null;
    const fallbackMessage = guildConfig.interface_message_id || null;

    return {
      guild_id: guildId,
      is_enabled: true,
      shortcut_order: [...DEFAULT_SHORTCUT_ORDER],
      target_channel_id: fallbackChannel,
      message_id: fallbackMessage
    };
  } catch (err) {
    sysError('Failed to fetch interface config', err, { guildId });
    return {
      guild_id: guildId,
      is_enabled: true,
      shortcut_order: [...DEFAULT_SHORTCUT_ORDER],
      target_channel_id: null,
      message_id: null
    };
  }
}

/**
 * Save interface configuration for a server to PostgreSQL
 * @param {string} guildId 
 * @param {Object} data 
 * @returns {Promise<{ guild_id: string, is_enabled: boolean, shortcut_order: string[], target_channel_id: string|null, message_id: string|null }>}
 */
export async function saveInterfaceConfig(guildId, data) {
  const pool = getPool();
  try {
    const normalizedOrder = normalizeShortcutOrder(data.shortcut_order);
    const isEnabled = data.is_enabled !== undefined ? Boolean(data.is_enabled) : true;
    const channelId = data.target_channel_id !== undefined ? (data.target_channel_id || null) : null;
    const messageId = data.message_id !== undefined ? (data.message_id || null) : null;

    const res = await pool.query(
      `INSERT INTO server_interface_config (guild_id, is_enabled, shortcut_order, target_channel_id, message_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (guild_id)
       DO UPDATE SET
         is_enabled = EXCLUDED.is_enabled,
         shortcut_order = EXCLUDED.shortcut_order,
         target_channel_id = EXCLUDED.target_channel_id,
         message_id = EXCLUDED.message_id,
         updated_at = NOW()
       RETURNING guild_id, is_enabled, shortcut_order, target_channel_id, message_id`,
      [guildId, isEnabled, JSON.stringify(normalizedOrder), channelId, messageId]
    );

    // Keep legacy guild_configs synchronized for backwards compatibility
    try {
      const guildConfig = await getGuildConfig(guildId) || {};
      guildConfig.interface_channel_id = channelId;
      guildConfig.interface_message_id = messageId;
      await setGuildConfig(guildId, guildConfig);
    } catch (syncErr) {
      sysError('Failed to sync guildConfig interface channel', syncErr, { guildId });
    }

    const row = res.rows[0];
    return {
      guild_id: row.guild_id,
      is_enabled: Boolean(row.is_enabled),
      shortcut_order: normalizeShortcutOrder(row.shortcut_order),
      target_channel_id: row.target_channel_id || null,
      message_id: row.message_id || null
    };
  } catch (err) {
    sysError('Failed to save interface config', err, { guildId });
    throw err;
  }
}

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
 * Build the shortcut buttons for the Hub message
 * Mirrors assets/interface.png (3 buttons per row, matching the image cards, all gray):
 * Row 1: ⭐ Level | 🎯 Quests | 💰 Claim Daily
 * Row 2: 🎒 Inventory | 🗳️ Vote | 🔔 Notifications
 * (Supports up to 12 buttons across up to 4 rows if configured)
 * @param {import('discord.js').Client} [client]
 * @param {string[]} [shortcutOrder]
 * @returns {ActionRowBuilder[]}
 */
export function buildHubButtons(client = null, shortcutOrder = null) {
  const order = normalizeShortcutOrder(shortcutOrder);
  const rows = [];
  const perRow = 3;
  const rowCount = Math.ceil(order.length / perRow);

  for (let r = 0; r < rowCount; r++) {
    const actionRow = new ActionRowBuilder();
    const start = r * perRow;
    const end = Math.min(start + perRow, order.length);

    for (let i = start; i < end; i++) {
      const id = order[i];
      const meta = SHORTCUT_REGISTRY[id] || SHORTCUT_REGISTRY[DEFAULT_SHORTCUT_ORDER[i % DEFAULT_SHORTCUT_ORDER.length]];
      actionRow.addComponents(
        new ButtonBuilder()
          .setCustomId(meta.buttonCustomId)
          .setEmoji(meta.emoji)
          .setStyle(ButtonStyle.Secondary)
      );
    }

    if (actionRow.components.length > 0) {
      rows.push(actionRow);
    }
  }

  return rows;
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
    const interfaceConfig = await getInterfaceConfig(guildId);
    if (!interfaceConfig.is_enabled) {
      return false;
    }

    const channelId = interfaceConfig.target_channel_id;
    if (!channelId) {
      return false;
    }

    // If interface is not published yet and creation is not explicitly requested, do not auto-publish
    if (!interfaceConfig.message_id && !allowCreate) {
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

    const guildConfig = await getGuildConfig(guildId) || {};
    const embed = await buildHubEmbed(guild, guildConfig);
    const buttonRows = buildHubButtons(client, interfaceConfig.shortcut_order);
    const payload = {
      embeds: [embed],
      components: buttonRows,
      files: [attachment]
    };

    // 1. If an existing message exists, edit it in-place
    const oldMsgId = interfaceConfig.message_id;
    if (oldMsgId) {
      const oldMessage = await channel.messages.fetch(oldMsgId).catch(() => null);
      if (oldMessage) {
        await oldMessage.edit(payload).catch(() => null);
        sysLog('Hub Message Updated In-Place', { guild: guildId, channel: channelId, messageId: oldMsgId });
        return true;
      }
    }

    // 2. If message doesn't exist and allowCreate is false, do not create
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
      interfaceConfig.message_id = newMessage.id;
      await saveInterfaceConfig(guildId, interfaceConfig);
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
 * - Row 2: [ Back ] | [ Setup ]
 * @param {import('discord.js').ButtonInteraction|import('discord.js').ModalSubmitInteraction|import('discord.js').ChannelSelectMenuInteraction} interaction 
 */
export async function showInterfaceSettings(interaction) {
  const guildId = interaction.guildId;
  const config = await getInterfaceConfig(guildId);

  const currentChannel = config.target_channel_id ? `<#${config.target_channel_id}>` : '*Not Set*';
  const isPublished = Boolean(config.target_channel_id && config.message_id);

  let statusText = '`🔴 Disabled`';
  if (config.is_enabled) {
    if (isPublished) {
      statusText = '`🟢 Published & Active`';
    } else if (config.target_channel_id) {
      statusText = '`🟡 Pending Deployment`';
    } else {
      statusText = '`🟡 Pending Setup (Channel Required)`';
    }
  }

  const rowCount = Math.ceil(config.shortcut_order.length / 3);
  const rowsSummary = [];
  for (let r = 0; r < rowCount; r++) {
    const rowSlots = config.shortcut_order.slice(r * 3, (r + 1) * 3).map((id, idx) => {
      const globalIdx = r * 3 + idx;
      const meta = getShortcutMeta(id) || SHORTCUT_REGISTRY[DEFAULT_SHORTCUT_ORDER[globalIdx % DEFAULT_SHORTCUT_ORDER.length]];
      return `**${globalIdx + 1}.** ${meta.emoji} ${meta.name}`;
    });
    rowsSummary.push(`• **Row ${r + 1}:** ${rowSlots.join('  |  ')}`);
  }

  const desc = [
    'Configure the public Community Interface message with active quests, countdown timers, and quick shortcuts.\n',
    `• **Target Channel:** ${currentChannel}`,
    `• **Status:** ${statusText}`,
    `• **Active Slots:** ${config.shortcut_order.length} / 12 (3 slots per row)\n`,
    '**Configured Shortcuts:**',
    rowsSummary.join('\n')
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

  if (config.target_channel_id) {
    channelSelect.setDefaultChannels([config.target_channel_id]);
  }

  // Row 1: [ Enable / Disable ] | [ Update ] (all gray)
  const toggleBtn = config.is_enabled
    ? new ButtonBuilder()
        .setCustomId('interface_disable_btn')
        .setLabel('Disable')
        .setEmoji('🔴')
        .setStyle(ButtonStyle.Secondary)
    : new ButtonBuilder()
        .setCustomId('interface_enable_btn')
        .setLabel('Enable')
        .setEmoji('🟢')
        .setStyle(ButtonStyle.Secondary);

  const updateBtn = new ButtonBuilder()
    .setCustomId('interface_publish_btn')
    .setLabel(isPublished ? 'Update' : 'Publish')
    .setEmoji('🔄')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(!config.target_channel_id);

  const row1 = new ActionRowBuilder().addComponents(toggleBtn, updateBtn);

  // Row 2: [ Back ] | [ Setup ] (all gray)
  const backBtn = new ButtonBuilder()
    .setCustomId('settings_users')
    .setLabel('Back')
    .setEmoji('⬅️')
    .setStyle(ButtonStyle.Secondary);

  const setupBtn = new ButtonBuilder()
    .setCustomId('interface_setup_btn')
    .setLabel('Setup')
    .setEmoji('🛠️')
    .setStyle(ButtonStyle.Secondary);

  const row2 = new ActionRowBuilder().addComponents(backBtn, setupBtn);

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
 * Render the Shortcut Setup Overview Panel (Row selection mode)
 * All buttons gray (ButtonStyle.Secondary)
 * @param {import('discord.js').Interaction} interaction 
 */
export async function showInterfaceSetup(interaction) {
  const guildId = interaction.guildId;
  const config = await getInterfaceConfig(guildId);
  const totalSlots = config.shortcut_order.length;
  const perRow = 3;
  const rowCount = Math.max(1, Math.ceil(totalSlots / perRow));

  const rowSections = [];
  for (let r = 0; r < rowCount; r++) {
    const startIdx = r * perRow;
    const endIdx = Math.min(startIdx + perRow, totalSlots);
    const rowSlots = [];

    for (let i = startIdx; i < endIdx; i++) {
      const meta = getShortcutMeta(config.shortcut_order[i]) || SHORTCUT_REGISTRY[DEFAULT_SHORTCUT_ORDER[i % DEFAULT_SHORTCUT_ORDER.length]];
      rowSlots.push(`  • **Slot ${i + 1}:** ${meta.emoji} ${meta.name}`);
    }

    rowSections.push(`**Row ${r + 1} (Slots ${startIdx + 1}–${endIdx}):**\n${rowSlots.join('\n')}`);
  }

  const desc = [
    'Customize up to 12 interactive shortcut tiles organized into 3 slots per row.\n',
    rowSections.join('\n\n'),
    '\nSelect a row below to manage its slots, or adjust the total slot count.'
  ].join('\n');

  const embed = new EmbedBuilder()
    .setTitle('Interface Shortcut Setup')
    .setDescription(desc)
    .setColor(0x5865F2);

  // Row 1: Row Selector Buttons (all gray)
  const rowSelectButtons = [];
  for (let r = 0; r < rowCount; r++) {
    const startIdx = r * perRow + 1;
    const endIdx = Math.min((r + 1) * perRow, totalSlots);
    rowSelectButtons.push(
      new ButtonBuilder()
        .setCustomId(`interface_row_${r}`)
        .setLabel(`Row ${r + 1} (Slots ${startIdx}–${endIdx})`)
        .setStyle(ButtonStyle.Secondary)
    );
  }
  const row1 = new ActionRowBuilder().addComponents(rowSelectButtons);

  // Row 2: Slot Count Adjustments (Add / Remove Slot, all gray)
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('interface_add_slot')
      .setLabel(`Add Slot (${totalSlots}/12)`)
      .setEmoji('➕')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(totalSlots >= 12),
    new ButtonBuilder()
      .setCustomId('interface_remove_slot')
      .setLabel('Remove Slot')
      .setEmoji('➖')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(totalSlots <= 1)
  );

  // Row 3: Navigation and Reset Defaults (all gray)
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('interface_back_to_main')
      .setLabel('Back to Interface')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('interface_reset_defaults')
      .setLabel('Reset Defaults')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary)
  );

  const components = [row1, row2, row3];

  const method = (interaction.deferred || interaction.replied)
    ? 'editReply'
    : (interaction.isButton() || interaction.isAnySelectMenu() ? 'update' : 'editReply');

  await interaction[method]({ embeds: [embed], components, content: '' });
}

/**
 * Render the Slot Manager for a specific Row
 * All buttons gray (ButtonStyle.Secondary)
 * @param {import('discord.js').Interaction} interaction 
 * @param {number} rowIndex 
 */
export async function showInterfaceRow(interaction, rowIndex) {
  const guildId = interaction.guildId;
  const config = await getInterfaceConfig(guildId);
  const totalSlots = config.shortcut_order.length;
  const perRow = 3;

  const startIdx = rowIndex * perRow;
  const endIdx = Math.min(startIdx + perRow, totalSlots);

  const slotLines = [];
  const slotButtons = [];

  for (let i = startIdx; i < endIdx; i++) {
    const meta = getShortcutMeta(config.shortcut_order[i]) || SHORTCUT_REGISTRY[DEFAULT_SHORTCUT_ORDER[i % DEFAULT_SHORTCUT_ORDER.length]];
    slotLines.push(`• **Slot ${i + 1}:** ${meta.emoji} **${meta.name}** — ${meta.description}`);

    slotButtons.push(
      new ButtonBuilder()
        .setCustomId(`interface_slot_${i}`)
        .setLabel(`Slot ${i + 1}: ${meta.name}`)
        .setEmoji(meta.emoji)
        .setStyle(ButtonStyle.Secondary)
    );
  }

  const desc = [
    `Managing **Row ${rowIndex + 1}** (Slots ${startIdx + 1} through ${endIdx}):\n`,
    slotLines.join('\n'),
    '\nClick a slot button below to assign a different feature to that position.'
  ].join('\n');

  const embed = new EmbedBuilder()
    .setTitle(`Row ${rowIndex + 1} Shortcut Management`)
    .setDescription(desc)
    .setColor(0x5865F2);

  const row1 = new ActionRowBuilder().addComponents(slotButtons);

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('interface_setup_btn')
      .setLabel('Back to Setup Overview')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary)
  );

  const components = [row1, row2];

  const method = (interaction.deferred || interaction.replied)
    ? 'editReply'
    : (interaction.isButton() || interaction.isAnySelectMenu() ? 'update' : 'editReply');

  await interaction[method]({ embeds: [embed], components, content: '' });
}

/**
 * Render the Feature Selector for a specific Slot
 * All buttons gray (ButtonStyle.Secondary)
 * @param {import('discord.js').Interaction} interaction 
 * @param {number} slotIndex 
 */
export async function showInterfaceSlotAssign(interaction, slotIndex) {
  const guildId = interaction.guildId;
  const config = await getInterfaceConfig(guildId);
  const perRow = 3;

  const currentShortcutId = config.shortcut_order[slotIndex] || DEFAULT_SHORTCUT_ORDER[slotIndex % DEFAULT_SHORTCUT_ORDER.length];
  const currentMeta = getShortcutMeta(currentShortcutId) || SHORTCUT_REGISTRY[DEFAULT_SHORTCUT_ORDER[slotIndex % DEFAULT_SHORTCUT_ORDER.length]];
  const rowIndex = Math.floor(slotIndex / perRow);

  const desc = [
    `Select a feature from the menu below to place in **Slot ${slotIndex + 1}** (Row ${rowIndex + 1}, Position ${(slotIndex % perRow) + 1}).\n`,
    `• **Current Feature:** ${currentMeta.emoji} **${currentMeta.name}**`,
    `• **Description:** ${currentMeta.description}\n`,
    'Selecting a feature will update the slot immediately and refresh the public Interface.'
  ].join('\n');

  const embed = new EmbedBuilder()
    .setTitle(`Assign Feature — Slot ${slotIndex + 1}`)
    .setDescription(desc)
    .setColor(0x5865F2);

  const selectOptions = Object.values(SHORTCUT_REGISTRY).map(item => ({
    label: item.name,
    value: item.id,
    description: item.description,
    emoji: item.emoji,
    default: item.id === currentShortcutId
  }));

  const featureSelect = new StringSelectMenuBuilder()
    .setCustomId(`interface_set_feature_${slotIndex}`)
    .setPlaceholder(`Choose a feature for Slot ${slotIndex + 1}...`)
    .addOptions(selectOptions);

  const row1 = new ActionRowBuilder().addComponents(featureSelect);

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`interface_row_${rowIndex}`)
      .setLabel(`Back to Row ${rowIndex + 1}`)
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('interface_setup_btn')
      .setLabel('Setup Overview')
      .setStyle(ButtonStyle.Secondary)
  );

  const components = [row1, row2];

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

      const config = await getInterfaceConfig(guildId);
      config.target_channel_id = channelId;
      await saveInterfaceConfig(guildId, config);

      const logName = getUserLogName(interaction);
      sendLog(interaction.guild, 'audit', 'cyan', 'Interface Channel Assigned',
        `**Admin:** \`${logName}\`\n` +
        `**Channel:** <#${channelId}>`
      );

      return showInterfaceSettings(interaction);
    }

    // 2. Open Setup Overview
    if (customId === 'interface_setup_btn') {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
      return showInterfaceSetup(interaction);
    }

    // 3. Back to Main Interface Panel
    if (customId === 'interface_back_to_main') {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
      return showInterfaceSettings(interaction);
    }

    // 4. Select a Row to Manage
    if (customId.startsWith('interface_row_')) {
      const rowIndex = parseInt(customId.replace('interface_row_', ''), 10);
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
      return showInterfaceRow(interaction, rowIndex);
    }

    // 5. Select a Slot to Assign Feature
    if (customId.startsWith('interface_slot_')) {
      const slotIndex = parseInt(customId.replace('interface_slot_', ''), 10);
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
      return showInterfaceSlotAssign(interaction, slotIndex);
    }

    // 6. Select Menu: Assign Feature to Slot
    if (customId.startsWith('interface_set_feature_')) {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
      const slotIndex = parseInt(customId.replace('interface_set_feature_', ''), 10);
      const selectedFeature = interaction.values[0];

      const config = await getInterfaceConfig(guildId);
      config.shortcut_order[slotIndex] = selectedFeature;
      await saveInterfaceConfig(guildId, config);

      if (config.is_enabled && config.target_channel_id && config.message_id) {
        await publishOrUpdateHub(interaction.client, guildId).catch(() => {});
      }

      const meta = getShortcutMeta(selectedFeature);
      await interaction.followUp({
        content: `Slot ${slotIndex + 1} updated to **${meta?.name || selectedFeature}**. The interface layout has been refreshed.`,
        flags: MessageFlags.Ephemeral
      }).catch(() => {});

      const rowIndex = Math.floor(slotIndex / 3);
      return showInterfaceRow(interaction, rowIndex);
    }

    // 7. Add Slot (up to 12)
    if (customId === 'interface_add_slot') {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
      const config = await getInterfaceConfig(guildId);

      if (config.shortcut_order.length >= 12) {
        return interaction.followUp({
          content: 'Maximum limit of 12 slots reached.',
          flags: MessageFlags.Ephemeral
        });
      }

      const allKeys = Object.keys(SHORTCUT_REGISTRY);
      const currentKeys = new Set(config.shortcut_order);
      const unusedKey = allKeys.find(k => !currentKeys.has(k)) || allKeys[config.shortcut_order.length % allKeys.length];

      config.shortcut_order.push(unusedKey);
      await saveInterfaceConfig(guildId, config);

      if (config.is_enabled && config.target_channel_id && config.message_id) {
        await publishOrUpdateHub(interaction.client, guildId).catch(() => {});
      }

      const newMeta = getShortcutMeta(unusedKey);
      await interaction.followUp({
        content: `Added Slot ${config.shortcut_order.length} (**${newMeta?.name || unusedKey}**). Total slots: ${config.shortcut_order.length}/12.`,
        flags: MessageFlags.Ephemeral
      }).catch(() => {});

      return showInterfaceSetup(interaction);
    }

    // 8. Remove Slot (down to 1)
    if (customId === 'interface_remove_slot') {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
      const config = await getInterfaceConfig(guildId);

      if (config.shortcut_order.length <= 1) {
        return interaction.followUp({
          content: 'Minimum of 1 slot required.',
          flags: MessageFlags.Ephemeral
        });
      }

      const removedId = config.shortcut_order.pop();
      await saveInterfaceConfig(guildId, config);

      if (config.is_enabled && config.target_channel_id && config.message_id) {
        await publishOrUpdateHub(interaction.client, guildId).catch(() => {});
      }

      const removedMeta = getShortcutMeta(removedId);
      await interaction.followUp({
        content: `Removed Slot ${config.shortcut_order.length + 1} (**${removedMeta?.name || removedId}**). Total slots: ${config.shortcut_order.length}/12.`,
        flags: MessageFlags.Ephemeral
      }).catch(() => {});

      return showInterfaceSetup(interaction);
    }

    // 9. Reset Defaults
    if (customId === 'interface_reset_defaults') {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
      const config = await getInterfaceConfig(guildId);
      config.shortcut_order = [...DEFAULT_SHORTCUT_ORDER];
      await saveInterfaceConfig(guildId, config);

      if (config.is_enabled && config.target_channel_id && config.message_id) {
        await publishOrUpdateHub(interaction.client, guildId).catch(() => {});
      }

      await interaction.followUp({
        content: 'Interface shortcuts have been reset to default configuration (6 slots, 2 rows).',
        flags: MessageFlags.Ephemeral
      }).catch(() => {});

      return showInterfaceSetup(interaction);
    }

    // 10. Enable Interface
    if (customId === 'interface_enable_btn') {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
      const config = await getInterfaceConfig(guildId);
      config.is_enabled = true;
      await saveInterfaceConfig(guildId, config);

      if (config.target_channel_id) {
        await publishOrUpdateHub(interaction.client, guildId, { allowCreate: true }).catch(() => {});
      }

      await interaction.followUp({
        content: 'Community Interface has been enabled.',
        flags: MessageFlags.Ephemeral
      }).catch(() => {});

      return showInterfaceSettings(interaction);
    }

    // 11. Disable Interface
    if (customId === 'interface_disable_btn') {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
      const config = await getInterfaceConfig(guildId);
      config.is_enabled = false;

      if (config.target_channel_id && config.message_id) {
        const channel = interaction.guild.channels.cache.get(config.target_channel_id) ||
          await interaction.guild.channels.fetch(config.target_channel_id).catch(() => null);
        if (channel?.isTextBased?.()) {
          const oldMsg = await channel.messages.fetch(config.message_id).catch(() => null);
          if (oldMsg) await oldMsg.delete().catch(() => {});
        }
        config.message_id = null;
      }

      await saveInterfaceConfig(guildId, config);

      await interaction.followUp({
        content: 'Community Interface has been disabled and removed from the target channel.',
        flags: MessageFlags.Ephemeral
      }).catch(() => {});

      return showInterfaceSettings(interaction);
    }

    // 12. Publish / Update Hub
    if (customId === 'interface_publish_btn') {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
      const config = await getInterfaceConfig(guildId);

      if (!config.target_channel_id) {
        return interaction.followUp({
          content: 'Please select a target channel first before publishing or updating the Interface.',
          flags: MessageFlags.Ephemeral
        });
      }

      if (!config.is_enabled) {
        config.is_enabled = true;
        await saveInterfaceConfig(guildId, config);
      }

      const success = await publishOrUpdateHub(interaction.client, guildId, { allowCreate: true });
      const freshConfig = await getInterfaceConfig(guildId);

      if (success) {
        const logName = getUserLogName(interaction);
        sendLog(interaction.guild, 'audit', 'cyan', 'Interface Published/Updated',
          `**Admin:** \`${logName}\`\n` +
          `**Channel:** <#${freshConfig.target_channel_id}>`
        );

        await interaction.followUp({
          content: `Interface published successfully to <#${freshConfig.target_channel_id}>!`,
          flags: MessageFlags.Ephemeral
        });
      } else {
        await interaction.followUp({
          content: 'Failed to publish the Interface. Please verify channel permissions and try again.',
          flags: MessageFlags.Ephemeral
        });
      }

      return showInterfaceSettings(interaction);
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

    // 7. Bank Shortcut (🏦)
    if (customId === 'hub_btn_bank') {
      const { handleBankCommand } = await import('./bank.js');
      return handleBankCommand(interaction);
    }

    // 8. Shop Items Shortcut (🛒)
    if (customId === 'hub_btn_items') {
      const { handleItemsCommand } = await import('./items.js');
      return handleItemsCommand(interaction);
    }

    // 9. Profile Shortcut (👤)
    if (customId === 'hub_btn_profile') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const { handleProfileCommand } = await import('./profile.js');
      return handleProfileCommand(interaction);
    }

  } catch (error) {
    await handleInteractionError(interaction, error, 'hub shortcut');
  }
}
