import { MessageFlags, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, RoleSelectMenuBuilder, ChannelSelectMenuBuilder, ChannelType, PermissionFlagsBits } from 'discord.js';
import { isValidSnowflake, sanitizeError } from '../shared.js';
import { getGuildConfig, setGuildConfig } from '../storage/config.js';
import { scheduleMvpTimer, cancelMvpTimer, getScheduleIntervalMs } from '../mvp/award.js';
import { invalidateConfigCache } from '../activity/index.js';

// Constants
const LEADERBOARD_SIZE = 10;
const MIN_WINNERS = 1;
const MAX_WINNERS = 5;
const MILLIS_PER_HOUR = 60 * 60 * 1000;

const SCHEDULE_CHOICES = [
  { label: 'Every 1 hour', value: '1h', intervalMs: MILLIS_PER_HOUR, intervalNumber: 1, intervalUnit: 'hours' },
  { label: 'Every 6 hours', value: '6h', intervalMs: 6 * MILLIS_PER_HOUR, intervalNumber: 6, intervalUnit: 'hours' },
  { label: 'Every 12 hours', value: '12h', intervalMs: 12 * MILLIS_PER_HOUR, intervalNumber: 12, intervalUnit: 'hours' },
  { label: 'Every 24 hours', value: '24h', intervalMs: 24 * MILLIS_PER_HOUR, intervalNumber: 24, intervalUnit: 'hours' },
  { label: 'Every 1 week', value: '1w', intervalMs: 7 * 24 * MILLIS_PER_HOUR, intervalNumber: 1, intervalUnit: 'weeks' }
];

const SCHEDULE_BY_VALUE = new Map(SCHEDULE_CHOICES.map((option) => [option.value, option]));

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

function deriveScheduleValue(config) {
  if (!config) return null;
  const storedMs = Number(config.schedule_interval_ms);
  if (Number.isFinite(storedMs)) {
    for (const option of SCHEDULE_CHOICES) {
      if (option.intervalMs === storedMs) {
        return option.value;
      }
    }
  }

  if (config.intervalUnit === 'weeks' && config.intervalNumber === 1) {
    return '1w';
  }

  if (config.intervalUnit === 'hours' && Number.isFinite(config.intervalNumber)) {
    const candidate = `${config.intervalNumber}h`;
    if (SCHEDULE_BY_VALUE.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

function formatScheduleLabel(value) {
  if (!value) return 'unset';
  return SCHEDULE_BY_VALUE.get(value)?.label ?? value;
}

function resolveNextCheck(config) {
  if (!config || config.enabled === false) {
    return { text: '—', iso: null, unix: null };
  }

  const parsedNext = Date.parse(config.next_award_at ?? '');
  if (Number.isFinite(parsedNext)) {
    const unix = Math.floor(parsedNext / 1000);
    return { text: `<t:${unix}:R>`, iso: new Date(parsedNext).toISOString(), unix };
  }

  const intervalMs = getScheduleIntervalMs(config);
  if (!intervalMs) {
    return { text: '—', iso: null, unix: null };
  }

  const lastMs = Date.parse(config.last_award_at ?? '');
  const activatedMs = Date.parse(config.activated_at ?? '');
  const anchor = Number.isFinite(lastMs)
    ? lastMs
    : Number.isFinite(activatedMs)
      ? activatedMs
      : Date.now();
  const nextMs = anchor + intervalMs;
  const unix = Math.floor(nextMs / 1000);
  return { text: `<t:${unix}:R>`, iso: new Date(nextMs).toISOString(), unix };
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
        messages.push(`🔧 System ${config.enabled ? 'enabled' : 'disabled'} by ${actor}`);
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

  if (messages.length) {
    for (const line of messages) {
      console.info(line);
    }
  }
}

/**
 * Validates user has required permissions
 */
async function hasRequiredPermissions(interaction) {
  if (!interaction.member) return false;

  if (interaction.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return true;
  }

  const replyPayload = {
    content: '❌ You need the Manage Roles permission to use this command.',
    flags: MessageFlags.Ephemeral
  };

  if (interaction.deferred || interaction.replied) {
    await interaction.followUp(replyPayload);
  } else {
    await interaction.reply(replyPayload);
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

async function showSetupPanel(interaction, config) {
  const guildId = interaction.guildId;
  const scheduleValue = deriveScheduleValue(config);
  const scheduleLabel = formatScheduleLabel(scheduleValue);
  const { text: nextCheckText, iso: nextCheckIso } = resolveNextCheck(config);

  const isConfigured = Boolean(config.mvpRoleId && scheduleValue && config.winnersCount);
  const statusText = !isConfigured
    ? '⚠️ MVP system not fully configured. Please select all options.'
    : `**Status:** ${config.enabled ? '🟢 Active' : '🔴 Paused'} | **Next check:** ${config.enabled ? nextCheckText : '—'}`;

  const winnersValue = config.winnersCount
    ? `${config.winnersCount} ${config.winnersCount === 1 ? 'winner' : 'winners'}`
    : 'Not set';

  const embed = new EmbedBuilder()
    .setColor(!isConfigured ? 0xFFAA00 : (config.enabled ? 0x00FF00 : 0xFF0000))
    .setDescription(statusText);

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

  // Announcement Channel Selector
  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId('mvp_channel_select')
    .setPlaceholder('Select Announcement Channel')
    .setChannelTypes([
      ChannelType.GuildText,
      ChannelType.GuildAnnouncement,
      ChannelType.GuildPublicThread,
      ChannelType.GuildPrivateThread
    ])
    .setMinValues(1)
    .setMaxValues(1)
    .setDefaultChannels(config.announceChannelId ? [config.announceChannelId] : []);
  
  components.push(
    new ActionRowBuilder().addComponents(channelSelect)
  );

  // Schedule Selector
  const scheduleSelect = new StringSelectMenuBuilder()
    .setCustomId('mvp_schedule_select')
    .setPlaceholder('Select MVP Schedule')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(SCHEDULE_CHOICES.map((option) => ({
      label: option.label,
      value: option.value,
      default: scheduleValue ? option.value === scheduleValue : false
    })));
  
  components.push(
    new ActionRowBuilder().addComponents(scheduleSelect)
  );

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

  // Action Buttons
  const buttonRow = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('mvp_stats_leaderboard')
        .setLabel('🏅 Leaderboard')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('mvp_skip')
        .setLabel('🚀 Skip')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('mvp_toggle')
        .setLabel(config.enabled ? '⚡ ON' : '🔌 OFF')
        .setStyle(config.enabled ? ButtonStyle.Success : ButtonStyle.Danger)
    );
  
  components.push(buttonRow);

  // Use editReply() if already acknowledged, otherwise update() for component interactions
  const responseMethod = (interaction.deferred || interaction.replied)
    ? 'editReply'
    : (interaction.isAnySelectMenu() || interaction.isButton()
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
      case 'mvp_channel_select':
        await handleChannelSelect(interaction, config);
        break;
        
      case 'mvp_schedule_select':
        await handleScheduleSelect(interaction, config);
        break;
        
      case 'mvp_winners_select':
        await handleWinnersSelect(interaction, config);
        break;
        
      case 'mvp_stats_leaderboard':
        await showStatsLeaderboard(interaction, config);
        break;
        
      case 'mvp_skip':
        await handleSkip(interaction, config);
        break;
        
      case 'mvp_toggle':
        await handleToggle(interaction, config);
        break;
        
      case 'mvp_back':
        const latestConfig = await getGuildConfig(guildId);
        await showSetupPanel(interaction, latestConfig);
        break;
    }
  } catch (error) {
    console.error('Error handling MVP component interaction:', sanitizeError(error));
    
    // Try to respond to the interaction if we haven't already
    try {
      const errorMessage = 'An error occurred while processing your request. Please try again.';
      
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: errorMessage, flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: errorMessage, flags: MessageFlags.Ephemeral });
      }
    } catch (replyError) {
      console.error('Failed to send error message:', sanitizeError(replyError));
    }
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
    await showSetupPanel(interaction, config);
    
  } catch (error) {
    console.error('Failed to validate/save role config:', sanitizeError(error));
    await interaction.update({
      content: '❌ Failed to save configuration. Please try again.',
      embeds: [],
      components: []
    });
  }
}

async function handleChannelSelect(interaction, config) {
  const guildId = interaction.guildId;
  const channelId = interaction.values[0];
  
  // Rate limiting
  if (!checkRateLimit(`${guildId}-config`, CONFIG_RATE_LIMIT_MS)) {
    await interaction.update({
      content: '⚠️ Please wait a moment before changing settings again.',
      embeds: [],
      components: []
    });
    return;
  }
  
  // Security: Validate channel
  try {
    const guild = interaction.guild;
    const channel = await guild.channels.fetch(channelId);
    
    if (!channel) {
      await interaction.update({
        content: '❌ Selected channel not found.',
        embeds: [],
        components: []
      });
      return;
    }
    
    // Check if bot can send messages in this channel
    const permissions = channel.permissionsFor(guild.members.me);
    if (!permissions.has('SendMessages') || !permissions.has('EmbedLinks')) {
      await interaction.update({
        content: `❌ Bot cannot send messages or embeds in ${channel.name}. Please grant the necessary permissions.`,
        embeds: [],
        components: []
      });
      return;
    }
    
    config.announceChannelId = channelId;
    await saveConfig(interaction, config, ['announceChannelId']);
    await showSetupPanel(interaction, config);
    
  } catch (error) {
    console.error('Failed to validate/save channel config:', sanitizeError(error));
    await interaction.update({
      content: '❌ Failed to save configuration. Please try again.',
      embeds: [],
      components: []
    });
  }
}

async function handleScheduleSelect(interaction, config) {
  const guildId = interaction.guildId;
  const scheduleValue = interaction.values[0];
  
  // Security: Validate schedule input
  if (!SCHEDULE_BY_VALUE.has(scheduleValue)) {
    await interaction.update({
      content: '❌ Invalid schedule selection.',
      embeds: [],
      components: []
    });
    return;
  }

  const option = SCHEDULE_BY_VALUE.get(scheduleValue);
  const previousValue = deriveScheduleValue(config);
  const actorTag = interaction.user?.tag ?? 'unknown user';

  config.intervalNumber = option.intervalNumber;
  config.intervalUnit = option.intervalUnit;
  config.schedule_interval_ms = option.intervalMs;
  delete config.nextCheckTime;

  try {
    const changedFields = ['intervalNumber', 'intervalUnit', 'schedule_interval_ms'];
    await saveConfig(interaction, config, changedFields);
    console.info(`⏱ schedule changed from ${previousValue ?? 'unset'} to ${scheduleValue} by ${actorTag}`);
    console.info('⏱ pending next check recompute and reschedule');
    // Reschedule timer if enabled (force reschedule since interval changed)
    if (config.enabled) {
      await cancelMvpTimer(guildId);
      await scheduleMvpTimer(interaction.client, guildId, true);
      console.info('⏱ timer rescheduled successfully');
    }

    const latestConfig = await getGuildConfig(guildId);
    const { text: recomputedText, iso: recomputedIso } = resolveNextCheck(latestConfig);
    console.info(`⏱ next check recomputed → ${recomputedText} (utc: ${recomputedIso ?? 'n/a'})`);
    await showSetupPanel(interaction, latestConfig);
  } catch (error) {
    console.error('Failed to save schedule config:', sanitizeError(error));
    await interaction.update({
      content: '❌ Failed to save configuration. Please try again.',
      embeds: [],
      components: []
    });
  }
}

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
    await showSetupPanel(interaction, config);
  } catch (error) {
    console.error('Failed to save winners config:', sanitizeError(error));
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
  config.enabled = newState;
  const actorTag = interaction.user?.tag ?? 'unknown user';
  delete config.nextCheckTime;
  if (!newState) {
    delete config.next_award_at;
  }

  try {
    await setGuildConfig(guildId, config);
    invalidateConfigCache(guildId);
    if (newState) {
      console.info(`🟢 MVP scheduler enabled by ${actorTag}`);
      await scheduleMvpTimer(interaction.client, guildId, true);
    } else {
      console.info(`🔴 MVP scheduler paused by ${actorTag}`);
      await cancelMvpTimer(guildId);
      const { getGuildActivity, endVoiceSession } = await import('../activity/tracker.js');
      const activity = getGuildActivity(guildId);
      for (const [userId] of activity.voiceSessions) {
        endVoiceSession(guildId, userId);
      }
    }

    const latestConfig = await getGuildConfig(guildId);
    if (newState) {
      const { text: nextText, iso: nextIso } = resolveNextCheck(latestConfig);
      console.info(`⏱ next check recomputed → ${nextText} (utc: ${nextIso ?? 'n/a'})`);
    }

    await showSetupPanel(interaction, latestConfig);
  } catch (error) {
    console.error('Failed to toggle MVP:', sanitizeError(error));
    await interaction.update({
      content: '❌ Failed to toggle MVP. Please try again.',
      embeds: [],
      components: []
    });
  }
}

async function showStatsLeaderboard(interaction, config) {
  const guildId = interaction.guildId;
  const { getGuildActivity } = await import('../activity/tracker.js');
  const guild = getGuildActivity(guildId);
  
  const embed = new EmbedBuilder()
    .setTitle('🏅 Leaderboard')
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
        .setLabel('⬅️ Back')
        .setStyle(ButtonStyle.Secondary)
    );

  await interaction.update({
    embeds: [embed],
    components: [backButton]
  });
}

async function handleSkip(interaction, config) {
  const guildId = interaction.guildId;
  
  // Rate limiting: Prevent test spam (more restrictive)
  if (!checkRateLimit(`${guildId}-skip`, TEST_RATE_LIMIT_MS)) {
    const embed = new EmbedBuilder()
      .setTitle('⚠️ Rate Limited')
      .setDescription('Please wait before triggering another skip. Skips can only be started every 10 seconds.')
      .setColor(0xFFAA00);

    const backButton = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('mvp_back')
          .setLabel('⬅️ Back')
          .setStyle(ButtonStyle.Secondary)
      );

    await interaction.update({
      embeds: [embed],
      components: [backButton]
    });
    return;
  }
  
  // Validate configuration (announcement channel is optional)
  if (!config.mvpRoleId || !config.intervalNumber || !config.winnersCount) {
    const embed = new EmbedBuilder()
      .setTitle('❌ Cannot Skip MVP Timer')
      .setDescription('Please configure the MVP role, schedule, and number of winners first.')
      .setColor(0xFF0000);

    const backButton = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('mvp_back')
          .setLabel('⬅️ Back')
          .setStyle(ButtonStyle.Secondary)
      );

    await interaction.update({
      embeds: [embed],
      components: [backButton]
    });
    return;
  }

  // Show loading state
  await interaction.update({
    content: '🔄 Skipping wait and running MVP cycle...',
    embeds: [],
    components: []
  });

  try {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`⚡ MVP skip triggered in guild ${interaction.guildId}`);
    }
    
    const { awardMvp } = await import('../mvp/award.js');
    const result = await awardMvp(interaction.client, interaction.guildId, false);

    // Reschedule timer to start next cycle fresh
    await scheduleMvpTimer(interaction.client, guildId, true);

    const updatedConfig = await getGuildConfig(guildId);
    const nextCheckInfo = resolveNextCheck(updatedConfig);
    console.info(`⏱ next check recomputed → ${nextCheckInfo.text} (utc: ${nextCheckInfo.iso ?? 'n/a'})`);
    
    // Build results embed
    const embed = new EmbedBuilder()
      .setTitle('🏆 MVP Skip Results')
      .setColor(0x00FF00);

    if (!result.winners || result.winners.length === 0) {
      embed.setDescription('No activity recorded. No MVPs were awarded this round.');
    } else {
      const mentions = result.winners.map(w => `<@${w.userId}>`).join(' ');

      const maxUsernameLength = Math.max(...result.winners.map(w => w.username?.length || 10));
      const userPad = Math.max(16, maxUsernameLength + 2);

      const header = `${'User'.padEnd(userPad)}Msg   Voice(min)   Score`;
      const tableLines = result.winners.map(winner => {
        const username = winner.username || `User${winner.userId.slice(-4)}`;
        const msgs = winner.messages.toString().padStart(3);
        const voice = winner.voiceMinutes.toString().padStart(4);
        const score = winner.score.toString().padStart(5);
        return `${username.padEnd(userPad)}${msgs}   ${voice}        ${score}`;
      });

      const table = `\`\`\`\n${header}\n${tableLines.join('\n')}\n\`\`\``;

      embed.setDescription(`${mentions}\n\n${table}`);
      embed.setFooter({ text: 'MVP role(s) awarded and scores reset for the next round.' });

      if (process.env.NODE_ENV !== 'production') {
        console.log(`✅ MVP skip completed: ${result.winners.length} winner(s)`);
      }
    }

    embed.addFields({
      name: 'Next check',
      value: nextCheckInfo.text === '—'
        ? '—'
        : `${nextCheckInfo.text}${nextCheckInfo.iso ? ` (UTC: ${nextCheckInfo.iso})` : ''}`,
      inline: false
    });

    const backButton = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('mvp_back')
          .setLabel('⬅️ Back')
          .setStyle(ButtonStyle.Secondary)
      );

    await interaction.editReply({
      content: null,
      embeds: [embed],
      components: [backButton]
    });
  } catch (error) {
    console.error('MVP skip failed:', sanitizeError(error));
    
    const embed = new EmbedBuilder()
      .setTitle('❌ Skip Failed')
      .setDescription(`Error: ${error.message}`)
      .setColor(0xFF0000);

    const backButton = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('mvp_back')
          .setLabel('⬅️ Back')
          .setStyle(ButtonStyle.Secondary)
      );

    await interaction.editReply({
      content: null,
      embeds: [embed],
      components: [backButton]
    });
  }
}
