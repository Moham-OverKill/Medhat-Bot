import {
  SlashCommandBuilder,
  MessageFlags,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  RoleSelectMenuBuilder,
  PermissionFlagsBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} from 'discord.js';
import { isValidSnowflake, sanitizeError, getUserDisplayName, getUserLogName, COIN_EMOJI } from '../shared.js';
import { getGuildConfig, setGuildConfig } from '../storage/config.js';
import { cancelMvpTimer, scheduleMvpTimer } from '../mvp/award.js';
import { getNextCairoHourTimestamp } from '../utils/time.js';
import { invalidateConfigCache } from '../activity/index.js';
import { sendLog, sysLog, sysError } from '../utils/logger.js';
import { handleInteractionError } from '../utils/errors.js';

// Command Definition
export const mvpCommand = new SlashCommandBuilder()
  .setName('mvp')
  .setDescription('MVP system management')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false)
  .addSubcommand(subcommand =>
    subcommand
      .setName('setup')
      .setDescription('Open the MVP control panel to configure and manage the MVP system')
  );

// Constants
const LEADERBOARD_SIZE = 10;
const MIN_WINNERS = 1;
const MAX_WINNERS = 5;
const MILLIS_PER_HOUR = 60 * 60 * 1000;
const MILLIS_PER_DAY = 24 * MILLIS_PER_HOUR;

// MVP is now hardcoded to run every 24 hours at 00:00 Cairo time
// Schedule selector removed - no more 6h/12h/weekly options

/**
 * Rate limiting cache for config changes and test/skip actions
 * Key format: `${guildId}-config` or `${guildId}-skip`
 * Value: timestamp (ms)
 * TTL: 2s for config changes, 10s for skip actions
 * Cleanup: Automatic when size > 1000, removes entries older than max TTL
 */
const configChangeRateLimit = new Map();
const CONFIG_RATE_LIMIT_MS = 2000; // 2 seconds between config changes
const TEST_RATE_LIMIT_MS = 10000; // 10 seconds between test runs
const RATE_LIMIT_MAX_AGE_MS = 15 * 60 * 1000; // 15 minutes

// deriveScheduleValue removed - MVP is now hardcoded to 24h
// formatScheduleLabel removed - no longer needed

function resolveNextCheck(config) {
  if (!config || config.enabled !== true) {
    return { text: '—', iso: null, unix: null };
  }

  const unix = getNextCairoHourTimestamp();
  return { text: `<t:${unix}:R>`, iso: new Date(unix * 1000).toISOString(), unix };
}

async function saveConfig(interaction, config, fieldsChanged = []) {
  const guildId = interaction.guildId;
  await setGuildConfig(guildId, config);
  invalidateConfigCache(guildId);

  if (!fieldsChanged.length) return;

  const actor = interaction.user?.tag ?? 'unknown';
  if (!interaction.client.mvpConfigPrevious) {
    interaction.client.mvpConfigPrevious = new Map();
  }
  const configSnapshots = interaction.client.mvpConfigPrevious;
  const previous = configSnapshots.get(guildId) ?? {};
  const previousSnapshot = { ...previous };
  const messages = [];
  let scheduleTouched = false;

  for (const field of fieldsChanged) {
    const before = previous[field];
    const after = config[field];
    const hadValue = before !== undefined && before !== null;
    const hasValue = after !== undefined && after !== null;

    const action = hadValue && hasValue ? 'updated' : 'set';

    switch (field) {
      case 'mvpRoleId':
        messages.push(`🔧 MVP role ${action} by ${actor}`);
        break;
      case 'announceChannelId':
        messages.push(`🔧 Announcement channel ${action} by ${actor}`);
        break;
      case 'intervalNumber':
      case 'intervalUnit':
        scheduleTouched = true;
        break;
      case 'winnersCount':
        messages.push(`🔧 Winner count ${action} by ${actor}`);
        break;
      case 'enabled':
        messages.push(`🔧 MVP mode changed to ${config.enabled ? 'Auto' : 'Manual'} by ${actor}`);
        break;
      case 'mvpRewardAmount':
        messages.push(`🔧 MVP reward amount ${action} by ${actor}`);
        break;
      default:
        messages.push(`🔧 ${field} ${action} by ${actor}`);
        break;
    }

    previous[field] = after;
  }

  if (scheduleTouched) {
    const hadSchedule = previousSnapshot.intervalNumber !== undefined && previousSnapshot.intervalUnit !== undefined;
    const hasSchedule = config.intervalNumber !== undefined && config.intervalUnit !== undefined;
    const scheduleAction = hadSchedule && hasSchedule ? 'updated' : 'set';
    messages.push(`🔧 Schedule ${scheduleAction} by ${actor}`);
  }

  configSnapshots.set(guildId, previous);

  // Removed noisy config save messages
}

/**
 * Validates user has required permissions
 */
async function hasRequiredPermissions(interaction) {
  if (!interaction.member) return false;

  if (interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
    return true;
  }

  const replyPayload = {
    content: '❌ You need the Administrator permission to use this command.',
    flags: MessageFlags.Ephemeral
  };

  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(replyPayload);
    } else {
      await interaction.reply(replyPayload);
    }
  } catch (e) {
    sysError('Permission Check Error', e, { user: interaction.user.id });
  }

  return false;
}

/**
 * Rate limiter check
 */
function checkRateLimit(key, limitMs) {
  const now = Date.now();
  const lastTime = configChangeRateLimit.get(key);

  if (lastTime && (now - lastTime) < limitMs) {
    return false; // Rate limited
  }

  configChangeRateLimit.set(key, now);

  // Cleanup old entries (keep map size manageable)
  // Remove entries older than 15 minutes to prevent unbounded growth
  if (configChangeRateLimit.size > 1000) {
    const cutoff = now - RATE_LIMIT_MAX_AGE_MS;
    for (const [k, time] of configChangeRateLimit.entries()) {
      if (time < cutoff) configChangeRateLimit.delete(k);
    }
  }

  return true; // Allowed
}

export async function handleMvpCommand(interaction) {
  // Security: Verify user has required permissions before deferring
  if (!(await hasRequiredPermissions(interaction))) {
    return;
  }

  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'setup') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const guildId = interaction.guildId;
    let config = await getGuildConfig(guildId);

    // Initialize config if not exists
    if (!config) {
      config = { enabled: true };
      await setGuildConfig(guildId, config);
    }

    // Show setup panel
    await showSetupPanel(interaction, config);
  }
}

export async function showSetupPanel(interaction, config) {
  const guildId = interaction.guildId;
  const { text: nextCheckText, iso: nextCheckIso } = resolveNextCheck(config);

  // Configuration state checks - MVP is now hardcoded to 24h, only need Role + Winners
  const hasRole = Boolean(config.mvpRoleId);
  const hasWinners = Boolean(config.winnersCount);

  // Run button and Auto mode both require: Role + Winners (no schedule needed)
  const canRun = hasRole && hasWinners;
  const canEnableAuto = canRun; // Same requirement now
  const isConfigured = canRun;

  // Build status overview
  const statusEmoji = config.enabled ? '🟢' : '🔴';
  const statusText = config.enabled ? 'Auto' : 'Disabled';
  const rewardAmount = config.mvpRewardAmount !== undefined ? config.mvpRewardAmount : 100;
  const roleMention = config.mvpRoleId ? `<@&${config.mvpRoleId}>` : '`Not Set`';

  const embed = new EmbedBuilder()
    .setTitle('⭐ MVP Configuration')
    .setColor(!isConfigured ? 0xFFAA00 : (config.enabled ? 0x00FF00 : 0xFF0000))
    .addFields(
      { name: `${statusEmoji} Status`, value: statusText, inline: true },
      { name: '⏳ Next Award', value: nextCheckText, inline: true },
      { name: '\u200B', value: '\u200B', inline: true },
      { name: '👤 Role', value: roleMention, inline: true },
      { name: `${COIN_EMOJI} Reward`, value: `**${rewardAmount.toLocaleString()}** coins/hr`, inline: true },
      { name: '\u200B', value: '\u200B', inline: true }
    );

  // If not configured, show warning message
  if (!canRun) {
    embed.setDescription('⚠️ Set MVP Role and Winner Count to enable controls.');
  }

  const components = [];

  // MVP Role Selector
  const roleSelect = new RoleSelectMenuBuilder()
    .setCustomId('mvp_role_select')
    .setPlaceholder('Select MVP Role')
    .setMinValues(1)
    .setMaxValues(1)
    .setDefaultRoles(config.mvpRoleId ? [config.mvpRoleId] : []);

  components.push(
    new ActionRowBuilder().addComponents(roleSelect)
  );

  // Schedule Selector REMOVED - MVP is hardcoded to 24h at 00:00 Cairo

  // Winners Count Selector
  const winnersOptions = Array.from({ length: 5 }, (_, i) => {
    const count = i + 1;
    return {
      label: count === 1 ? '1 Winner' : `${count} Winners`,
      value: String(count),
      default: config.winnersCount ? config.winnersCount === count : false
    };
  });

  const winnersSelect = new StringSelectMenuBuilder()
    .setCustomId('mvp_winners_select')
    .setPlaceholder('Select How Many Winners')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(winnersOptions);

  components.push(
    new ActionRowBuilder().addComponents(winnersSelect)
  );

  const actionRow = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('mvp_stats_leaderboard')
        .setLabel('Progress')
        .setEmoji('📊')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('mvp_reward_config_btn')
        .setLabel('Reward')
        .setEmoji(`${COIN_EMOJI}`)
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('mvp_toggle')
        .setLabel(config.enabled ? 'Disable' : 'Enable')
        .setEmoji(config.enabled ? '✖️' : '▶️')
        .setStyle(config.enabled ? ButtonStyle.Danger : ButtonStyle.Success)
        .setDisabled(!canEnableAuto && !config.enabled)
    );

  const backRow = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('settings_users_roles')
        .setLabel('Back')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary)
    );

  components.push(actionRow, backRow);

  // Use editReply() if already acknowledged, otherwise update() for component interactions
  const responseMethod = (interaction.deferred || interaction.replied)
    ? 'editReply'
    : (interaction.isAnySelectMenu() || interaction.isButton() || interaction.isModalSubmit()
      ? 'update'
      : 'editReply');

  await interaction[responseMethod]({
    embeds: [embed],
    components: components
  });
}

// Handle component interactions
export async function handleMvpComponent(interaction) {
  try {

    // Security: Verify user has required permissions for component interactions
    if (!(await hasRequiredPermissions(interaction))) {
      return;
    }

    const guildId = interaction.guildId;
    const customId = interaction.customId;

    let config = await getGuildConfig(guildId);
    if (!config) {
      config = { enabled: true };
    }

    switch (customId) {
      case 'mvp_role_select':
        await handleRoleSelect(interaction, config);
        break;

      // Schedule select REMOVED - MVP is hardcoded to 24h

      case 'mvp_winners_select':
        await handleWinnersSelect(interaction, config);
        break;

      case 'mvp_stats_leaderboard':
        await showStatsLeaderboard(interaction, config);
        break;

      // mvp_skip case REMOVED - Skip button no longer exists

      case 'mvp_toggle':
        await handleToggle(interaction, config);
        break;

      case 'mvp_reward_config_btn':
        const modal = new ModalBuilder().setCustomId('rewards_mvp_modal').setTitle('MVP Reward Settings');
        const input = new TextInputBuilder()
          .setCustomId('amount')
          .setLabel('Coins per hour')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('5')
          .setValue(String(config.mvpRewardAmount || 5))
          .setRequired(false);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
        break;

      case 'mvp_back':
        const latestConfig = await getGuildConfig(guildId);
        await showSetupPanel(interaction, latestConfig);
        break;
    } // end switch
  } catch (error) {
    await handleInteractionError(interaction, error, 'MVP component router');
  }
}

async function handleRoleSelect(interaction, config) {
  const guildId = interaction.guildId;
  const selectedRoleId = interaction.values[0];

  if (!isValidSnowflake(selectedRoleId)) {
    await interaction.update({
      content: '❌ Invalid role selection.',
      embeds: [],
      components: []
    });
    return;
  }

  // Rate limiting: Prevent config spam
  if (!checkRateLimit(`${guildId}-config`, CONFIG_RATE_LIMIT_MS)) {
    await interaction.update({
      content: '⚠️ Please wait a moment before changing settings again.',
      embeds: [],
      components: []
    });
    return;
  }

  // Security: Validate role safety
  try {
    const guild = interaction.guild;
    const role = await guild.roles.fetch(selectedRoleId);

    if (!role) {
      await interaction.update({
        content: '❌ Selected role not found.',
        embeds: [],
        components: []
      });
      return;
    }

    // Prevent selecting @everyone
    if (role.id === guild.id) {
      await interaction.update({
        content: '❌ Cannot use @everyone as MVP role.',
        embeds: [],
        components: []
      });
      return;
    }

    // Prevent selecting managed roles (bot roles, integrations)
    if (role.managed) {
      await interaction.update({
        content: '❌ Cannot use managed roles (bot roles, boosts, etc.) as MVP role.',
        embeds: [],
        components: []
      });
      return;
    }

    // Check if bot can manage this role
    const botMember = await guild.members.fetchMe();
    const botHighestRole = botMember.roles.highest;

    if (role.position >= botHighestRole.position) {
      await interaction.update({
        content: `❌ Cannot use this role. The bot's highest role (${botHighestRole.name}) must be above the MVP role in the role list.`,
        embeds: [],
        components: []
      });
      return;
    }

    // Warn if role has dangerous permissions
    if (role.permissions.has('Administrator') || role.permissions.has('ManageGuild') || role.permissions.has('ManageRoles')) {
      await interaction.update({
        content: '❌ Cannot use this role. MVP role should not have Administrator, Manage Server, or Manage Roles permissions.',
        embeds: [],
        components: []
      });
      return;
    }

    config.mvpRoleId = selectedRoleId;
    await saveConfig(interaction, config, ['mvpRoleId']);

    const logName = getUserLogName(interaction);
    sendLog(interaction.guild, 'audit', 'cyan', '⚙️ MVP Role Updated',
      `**Admin:** \`${logName}\`\n` +
      `**Action:** Set MVP award role to ${role}.`
    );

    await showSetupPanel(interaction, config);

  } catch (error) {
    sysError('Failed to validate/save role config', error, { guild: guildId });
    await interaction.update({
      content: '❌ Failed to save configuration. Please try again.',
      embeds: [],
      components: []
    });
  }
}

// handleChannelSelect removed - announcement channel feature deprecated

async function handleWinnersSelect(interaction, config) {
  const guildId = interaction.guildId;
  const winnersValue = interaction.values[0];

  // Security: Validate input
  const winnersCount = parseInt(winnersValue, 10);
  if (isNaN(winnersCount) || winnersCount < MIN_WINNERS || winnersCount > MAX_WINNERS) {
    await interaction.update({
      content: '❌ Invalid winners count. Must be between 1 and 5.',
      embeds: [],
      components: []
    });
    return;
  }

  config.winnersCount = winnersCount;

  try {
    await saveConfig(interaction, config, ['winnersCount']);

    const logName = getUserLogName(interaction);
    sendLog(interaction.guild, 'audit', 'cyan', '⚙️ MVP Winner Count Updated',
      `**Admin:** \`${logName}\`\n` +
      `**Action:** Set daily MVP winner count to **${winnersCount}**.`
    );

    await showSetupPanel(interaction, config);
  } catch (error) {
    sysError('Failed to save winners config', error, { guild: guildId });
    await interaction.update({
      content: '❌ Failed to save configuration. Please try again.',
      embeds: [],
      components: []
    });
  }
}

async function handleToggle(interaction, config) {
  const guildId = interaction.guildId;
  if (!(await hasRequiredPermissions(interaction))) {
    return;
  }

  const newState = !config.enabled;

  // Validation: Cannot turn ON without role and winners (schedule is hardcoded to 24h)
  if (newState === true) {
    if (!config.mvpRoleId || !config.winnersCount) {
      await interaction.reply({
        content: '❌ You must configure the MVP Role and Winner Count first.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    // Hardcode schedule to 24h at 00:00 Cairo
    config.intervalNumber = 24;
    config.intervalUnit = 'hours';
    config.schedule_interval_ms = 24 * 60 * 60 * 1000;
  }

  config.enabled = newState;
  const actorTag = interaction.user?.tag ?? 'unknown user';
  delete config.nextCheckTime;
  if (!newState) {
    delete config.next_award_at;
  }

  try {
    await setGuildConfig(guildId, config);
    invalidateConfigCache(guildId);

    const logName = getUserLogName(interaction);
    if (newState) {
      await scheduleMvpTimer(interaction.client, guildId, true);
      sendLog(interaction.guild, 'audit', 'cyan', '🏆 MVP System Enabled',
        `**Admin:** \`${logName}\`\n` +
        `**Status:** Automated daily MVP selection is now **ON**.`
      );
    } else {
      await cancelMvpTimer(guildId);
      const { stopAllVoiceTracking } = await import('../activity/tracker.js');
      await stopAllVoiceTracking(guildId);
      sendLog(interaction.guild, 'audit', 'crimson', '🏆 MVP System Disabled',
        `**Admin:** \`${logName}\`\n` +
        `**Status:** Automated daily MVP selection is now **OFF**.`
      );
    }

    const latestConfig = await getGuildConfig(guildId);

    await showSetupPanel(interaction, latestConfig);
  } catch (error) {
    await handleInteractionError(interaction, error, 'toggle MVP');
  }
}

async function showStatsLeaderboard(interaction, config) {
  const guildId = interaction.guildId;
  const { getGuildActivity } = await import('../activity/tracker.js');
  const guild = await getGuildActivity(guildId);

  const embed = new EmbedBuilder()
    .setTitle('📊 Progress')
    .setColor(0x0099FF);

  if (guild.users.size === 0) {
    embed.setDescription('No activity yet. Start chatting and join voice channels!');
  } else {
    // Get top users by score
    const leaderboard = Array.from(guild.users.entries())
      .map(([userId, data]) => {
        const score = data.messages + data.voiceMinutes;
        return { userId, score, ...data };
      })
      .filter(user => user.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return new Date(b.lastActive || 0) - new Date(a.lastActive || 0);
      })
      .slice(0, LEADERBOARD_SIZE);

    if (leaderboard.length === 0) {
      embed.setDescription('No activity yet. Start chatting and join voice channels!');
    } else {
      const lines = leaderboard.map((entry, index) => {
        return `- ${index + 1} — <@${entry.userId}> **${entry.score}** (Msg:${entry.messages} | Voice:${entry.voiceMinutes})`;
      });

      embed.setDescription(lines.join('\n'));
    }
  }

  const backButton = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('mvp_back')
        .setLabel('Back')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary)
    );

  try {
    await interaction.update({
      embeds: [embed],
      components: [backButton]
    });
  } catch (error) {
    await handleInteractionError(interaction, error, 'MVP stats leaderboard');
  }
}

// handleSkip function REMOVED - Skip button no longer exists in UI
