import 'dotenv/config';
import { Client, GatewayIntentBits, MessageFlags, Events, Partials } from 'discord.js';
import { createServer } from 'http';
import crypto from 'crypto';
import os from 'os';
import { performance } from 'node:perf_hooks';
import { registerSlashCommands } from './commands/register.js';
import { handleSlashCommand } from './commands/handler.js';
import { initializeGuildConfigs, loadGuildConfigs } from './storage/config.js';
import { initializeColorsDB, closeColorsDB } from './storage/colors.js';
import { initializeDatabase, closeDatabase } from './storage/postgres.js';
import { initializeActivityTracking, cleanup as cleanupActivityTracking, clearStaleVoiceTracking } from './activity/index.js';
import { scheduleAllMvpTimers } from './mvp/award.js';
import { startExpiryJob } from './cron/expiry.js';
import { setupComponentHandlers } from './components/handlers.js';
import { sanitizeError, formatGuildForLog } from './shared.js';
import { logSystemEvent } from './utils/logger.js';
import { cleanupGhostItems, cleanupDeletedRole, runDependencySweep } from './economy/shop.js';
import pkg from '../package.json' with { type: 'json' };

const isProduction = process.env.NODE_ENV === 'production';

// Use formatGuildForLog from shared.js for consistent guild logging

// ============================================
// GLOBAL ERROR HANDLERS (CRASH PREVENTION)
// ============================================
process.on('unhandledRejection', (reason, promise) => {
  console.warn('⚠️ [System] Unhandled Promise Rejection:', reason);
  // Do NOT exit the process. Let it keep running.
});

process.on('uncaughtException', (error) => {
  console.error('🔥 [System] Uncaught Exception:', sanitizeError(error));
  // Keep the bot alive despite synchronous errors
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [
    Partials.Message,
    Partials.Reaction,
    Partials.User
  ]
});

let keepAliveServer = null;
let shuttingDown = false;
const keepalivePort = Number(process.env.PORT) || 3000;
const startupRunId = crypto.randomUUID();
const startupContext = {
  runId: startupRunId,
  startedAt: performance.now(),
  emittedPhases: new Set()
};
const depsState = {
  keepalive: null,
  storage: null,
  cache: 'memory'
};

function emitPhase(key, message, metadata = {}) {
  if (startupContext.emittedPhases.has(key)) return;
  startupContext.emittedPhases.add(key);
  const meta = Object.entries(metadata)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([k, value]) => `${k}=${value}`)
    .join(' ');
  const suffix = meta ? ` ${meta}` : '';
  logSystemEvent(`${message}${suffix}`);
}

function tryEmitDeps() {
  if (!depsState.keepalive || !depsState.storage) return;
  emitPhase('deps', 'Dependencies ready', depsState);
}

const shutdown = async (signal, { exitCode = 0 } = {}) => {
  if (shuttingDown) return;
  shuttingDown = true;
  let resolvedExitCode = exitCode;
  logSystemEvent(`${signal} received - shutting down`);

  try {
    cleanupActivityTracking();
  } catch (error) {
    resolvedExitCode = resolvedExitCode || 1;
    console.error('Error during shutdown cleanup:', sanitizeError(error));
  }

  try {
    closeColorsDB();
    logSystemEvent('Colors database closed');
  } catch (error) {
    resolvedExitCode = resolvedExitCode || 1;
    console.error('Error closing colors database:', sanitizeError(error));
  }

  try {
    await closeDatabase();
  } catch (error) {
    resolvedExitCode = resolvedExitCode || 1;
    console.error('Error closing PostgreSQL database:', sanitizeError(error));
  }

  if (keepAliveServer) {
    await new Promise((resolve) => {
      keepAliveServer.close((closeError) => {
        if (closeError) {
          resolvedExitCode = resolvedExitCode || 1;
          console.error('Error closing keepalive server:', sanitizeError(closeError));
        }
        resolve();
      });
    });
    keepAliveServer = null;
  }

  try {
    client.destroy();
    logSystemEvent('Client destroyed');
  } catch (error) {
    resolvedExitCode = resolvedExitCode || 1;
    console.error('Error destroying client:', sanitizeError(error));
  }

  process.exit(resolvedExitCode);
};

const appVersion = pkg.version ?? 'dev';
const shortCommit = process.env.GIT_COMMIT?.slice(0, 7) || 'unknown';
emitPhase('boot', 'Starting bot', {
  ver: appVersion,
  commit: shortCommit
});

keepAliveServer = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ok');
});

keepAliveServer.on('error', (error) => {
  console.error('Keepalive server error:', sanitizeError(error));
  shutdown('KEEPALIVE_SERVER_ERROR', { exitCode: 1 });
});

keepAliveServer.listen(keepalivePort, () => {
  depsState.keepalive = `:${keepalivePort}`;
  depsState.platform = os.platform();
  tryEmitDeps();
});

logSystemEvent('Attempting to login to Discord...');

client.once(Events.ClientReady, async () => {
  console.log('[System] ClientReady event received');

  try {
    // Initialize database (MUST BE FIRST)
    logSystemEvent('Initializing database...');
    await initializeDatabase();
    emitPhase('deps', 'Database ready');
    logSystemEvent('Database initialized');

    // Initialize cached configs
    logSystemEvent('Initializing guild configs...');
    await initializeGuildConfigs();
    logSystemEvent('Guild configs initialized');

    // Initialize colors database
    logSystemEvent('Initializing colors database...');
    await initializeColorsDB();
    logSystemEvent('Colors database initialized');

    const configs = await loadGuildConfigs();
    console.log('[System] Configs loaded');
    const configCount = Object.keys(configs).length;
    const shardsInfo = client.options.shards && client.options.shards.length
      ? client.options.shards.length
      : 1;
    emitPhase('config', 'Configs loaded', {
      guilds: configCount
    });
    depsState.storage = 'postgres';
    tryEmitDeps();

    // Register slash commands globally
    console.log('[System] Registering slash commands...');
    const { registered: commandsUpdated } = await registerSlashCommands(client);
    console.log('[System] Slash commands registered');
    if (commandsUpdated) {
      logSystemEvent('Commands refreshed');
    }

    emitPhase('discord', `Logged in as ${client.user.tag}`);
    
    // Set Presence and Activity to show as "Online"
    client.user.setPresence({
      status: 'online',
      activities: [{
        name: `${client.guilds.cache.size} servers | Medhat Economy`,
        type: 3 // Watching
      }]
    });
    logSystemEvent(`Presence set: Online | Watching ${client.guilds.cache.size} servers`);

    // Clear stale voice tracking data before starting activity tracking
    // Prevents point spam from timestamps saved before bot restart
    await clearStaleVoiceTracking();

    // Initialize activity tracking
    await initializeActivityTracking(client);

    // Setup component handlers
    setupComponentHandlers(client);

    // Schedule MVP timers for all configured guilds
    await scheduleAllMvpTimers(client);

    // Start background jobs
    startExpiryJob(client);

    emitPhase('ready', `Startup complete in ${Math.round(performance.now() - startupContext.startedAt)}ms`);

    // Real-time maintenance is now handled by event listeners (guildRoleDelete, guildChannelDelete)

    // Run booster color audit in background (don't block startup)
    const { auditAllGuilds } = await import('./commands/colors.js');
    auditAllGuilds(client).catch((error) => {
      console.error('[System] Booster audit error:', sanitizeError(error));
    });

    // Schedule periodic audit every 8 hours
    setInterval(async () => {
      try {
        await auditAllGuilds(client);
      } catch (error) {
        console.error('[System] Booster audit error:', sanitizeError(error));
      }
    }, 8 * 60 * 60 * 1000); // 8 hours in milliseconds

    // ========== CAIRO MIDNIGHT STREAK RESET JOB ==========
    // Resets all stale streaks at 00:00 Cairo time (UTC+2)
    const { scheduleCairoMidnightReset } = await import('./mvp/award.js');
    scheduleCairoMidnightReset(client);

  } catch (error) {
    console.error('[System] Startup failed:', sanitizeError(error));
    await shutdown('STARTUP_FAILURE', { exitCode: 1 });
  }
});

// Handle Discord API errors silently (prevents WebSocket crash)
client.on(Events.Error, (error) => {
  console.error('🌐 [System] Discord Client Error:', sanitizeError(error));
});

// Handle reactions for mission tracking (Optmized Watch-mode)
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    if (user.bot) return;

    // Direct check on partial message data to avoid API calls for non-mission channels
    // reaction.message.channelId and guildId are available without fetching
    const guildId = reaction.message.guildId;
    const channelId = reaction.message.channelId;
    if (!guildId || !channelId) return;

    const { isMissionChannel } = await import('./activity/index.js');
    if (!isMissionChannel(guildId, channelId)) return;

    // This IS the mission channel -> proceed with fetches and tracking
    if (reaction.partial) await reaction.fetch().catch(() => null);
    if (reaction.message?.partial) await reaction.message.fetch().catch(() => null);

    const { checkReactionMission } = await import('./activity/index.js');
    await checkReactionMission(reaction, user);
  } catch (error) {
    // Silent fail
  }
});

// ============================================
// REAL-TIME GHOST MANAGEMENT (MAINTENANCE)
// ============================================

// Role Deletion: Purge Shop Items, Inventory, and Color Roles
client.on(Events.GuildRoleDelete, async (role) => {
  try {
    const guild = role.guild;
    console.log(`[System] 🛡️ Role Deleted: @${role.name} (${role.id}) in ${guild.name}. Cleaning up...`);

    // 1. Cleanup Shop Items & Inventory (standard logic)
    const { cleanupDeletedRole } = await import('./economy/shop.js');
    const stats = await cleanupDeletedRole(guild.id, role.id);

    // 2. Cleanup Color Roles (regular and booster)
    const { removeColorRole } = await import('./storage/colors.js');
    const normalCleanup = await removeColorRole(guild.id, role.id, false);
    const boosterCleanup = await removeColorRole(guild.id, role.id, true);

    // 3. Audit Log
    if (stats.itemsRemoved > 0 || normalCleanup.deleted || boosterCleanup.deleted) {
      sendLog(guild, 'audit', 'crimson', '🛡️ Real-Time Ghost Cleanup', 
        `Role **@${role.name}** was deleted from the server. Maintenance initiated:\n` +
        `• **Shop Items Purged:** ${stats.itemsRemoved}\n` +
        `• **Inventory Entries Removed:** ${stats.inventoryRemoved}\n` +
        `• **Packs Updated:** ${stats.packsUpdated}\n` +
        `• **Color Roles Removed:** ${(normalCleanup.deleted || boosterCleanup.deleted) ? 'Yes' : 'No'}`
      );
    }
  } catch (error) {
    console.error('[System] Error in roleDelete maintenance:', sanitizeError(error));
  }
});

// Channel Deletion: Update Guild Configuration
client.on(Events.GuildChannelDelete, async (channel) => {
  try {
    if (!channel.guild) return;
    const guild = channel.guild;
    const { getGuildConfig, setGuildConfig } = await import('./storage/config.js');
    const config = await getGuildConfig(guild.id);
    if (!config) return;

    let updated = false;
    const logs = [];

    const channelKeys = [
      { key: 'log_eco_channel_id', name: 'Economy Log' },
      { key: 'log_inv_channel_id', name: 'Inventory Log' },
      { key: 'log_shop_channel_id', name: 'Shop Log' },
      { key: 'log_audit_channel_id', name: 'Audit Log' },
      { key: 'announceChannelId', name: 'MVP Announcement' },
      { key: 'missions_channel_id', name: 'Missions' }
    ];

    for (const field of channelKeys) {
      if (config[field.key] === channel.id) {
        config[field.key] = null;
        updated = true;
        logs.push(`• **${field.name}:** Unset (Channel #${channel.name} deleted)`);
      }
    }

    if (updated) {
      await setGuildConfig(guild.id, config);
      console.warn(`[System] 🛡️ Configuration Updated: Deleted channel #${channel.name} was a linked resource in ${guild.name}.`);
      
      // Attempt to log to console and any remaining log channels
      logSystemEvent(`[${guild.name}] Channel #${channel.name} deleted. Cleaned up resource links.`);
    }
  } catch (error) {
    console.error('[System] Error in channelDelete maintenance:', sanitizeError(error));
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // Check if bot is fully ready
  if (!depsState.storage) {
    return interaction.reply({
      content: '⏳ The bot is currently starting up and connecting to the database. Please try again in a few seconds.',
      flags: MessageFlags.Ephemeral
    });
  }

  try {
    await handleSlashCommand(interaction);
  } catch (error) {
    console.error('Interaction error:', sanitizeError(error));

    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: 'An error occurred while handling this command.',
        flags: MessageFlags.Ephemeral
      });
    } else if (interaction.deferred) {
      await interaction.followUp({
        content: 'An error occurred while processing this command.',
        flags: MessageFlags.Ephemeral
      });
    }
  }
});

// Validate required environment variables
if (!process.env.DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN environment variable is required');
  process.exit(1);
}

// Guild leave handler - cleanup config and timers
client.on('guildDelete', async (guild) => {
  try {
    const { cancelMvpTimer } = await import('./mvp/award.js');
    const { deleteGuildConfig } = await import('./storage/config.js');
    cancelMvpTimer(guild.id);
    await deleteGuildConfig(guild.id);
  } catch (error) {
    console.error('Error cleaning up guild data:', sanitizeError(error));
  }
});

// Member update handler - strip booster colors when boost status is lost
client.on('guildMemberUpdate', async (oldMember, newMember) => {
  try {
    // Skip if database isn't ready yet (during startup)
    const { isDatabaseReady } = await import('./storage/postgres.js');
    if (!isDatabaseReady()) return;

    // Check if member lost boost status
    const lostBoost = oldMember.premiumSince && !newMember.premiumSince;

    // Check if member lost custom booster role
    const { getBoosterRole } = await import('./storage/colors.js');
    const customBoosterRoleId = await getBoosterRole(newMember.guild.id);
    const lostBoosterRole = customBoosterRoleId &&
      oldMember.roles.cache.has(customBoosterRoleId) &&
      !newMember.roles.cache.has(customBoosterRoleId);

    if (lostBoost || lostBoosterRole) {
      const { isMemberBooster, stripBoosterColorsFromMember } = await import('./commands/colors.js');

      // Double-check they're not still a booster (in case they have both native and custom role)
      if (!await isMemberBooster(newMember, newMember.guild.id)) {
        await stripBoosterColorsFromMember(newMember, newMember.guild.id);
        
        // Trigger Strict Dependency Sweep for booster-only items
        await runDependencySweep(newMember.user.id, newMember.guild.id, newMember);
      }

    }
  } catch (error) {
    console.error('[System] Member update error:', sanitizeError(error));
  }
});

// Role delete handler - cleanup ghost items when a Discord role is deleted
client.on('roleDelete', async (role) => {
  try {
    const result = await cleanupDeletedRole(role.guild.id, role.id);
    if (result.itemsRemoved > 0) {
      console.log(`[${role.guild.name}] Role Deleted: Purged ${result.itemsRemoved} shop items, ${result.inventoryRemoved} inventory entries, updated ${result.packsUpdated || 0} packs for role "${role.name}"`);
    }
  } catch (error) {
    console.error('[System] Role delete cleanup error:', sanitizeError(error));
  }
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

client.login(process.env.DISCORD_TOKEN);
