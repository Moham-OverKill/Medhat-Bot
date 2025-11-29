import { Client, GatewayIntentBits, MessageFlags, Events } from 'discord.js';
import { createServer } from 'http';
import crypto from 'crypto';
import os from 'os';
import { performance } from 'node:perf_hooks';
import { registerSlashCommands } from './commands/register.js';
import { handleSlashCommand } from './commands/handler.js';
import { initializeGuildConfigs, loadGuildConfigs } from './storage/config.js';
import { initializeColorsDB } from './storage/colors.js';
import { initializeDatabase, closeDatabase } from './storage/postgres.js';
import { initializeActivityTracking, cleanup as cleanupActivityTracking } from './activity/index.js';
import { scheduleAllMvpTimers } from './mvp/award.js';
import { setupComponentHandlers } from './components/handlers.js';
import { sanitizeError, formatGuildForLog } from './shared.js';
import pkg from '../package.json' with { type: 'json' };

const isProduction = process.env.NODE_ENV === 'production';

// Use formatGuildForLog from shared.js for consistent guild logging

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers
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

function emitPhase(key, emoji, message, metadata = {}) {
  if (startupContext.emittedPhases.has(key)) return;
  startupContext.emittedPhases.add(key);
  const meta = Object.entries(metadata)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([k, value]) => `${k}=${value}`)
    .join(' ');
  const suffix = meta ? ` ${meta}` : '';
  console.log(`${emoji} ${message}${suffix}`);
}

function tryEmitDeps() {
  if (!depsState.keepalive || !depsState.storage) return;
  emitPhase('deps', '📦', 'Dependencies ready', depsState);
}

const shutdown = async (signal, { exitCode = 0 } = {}) => {
  if (shuttingDown) return;
  shuttingDown = true;
  let resolvedExitCode = exitCode;
  console.log(`\n${signal} received. Starting graceful shutdown...`);

  try {
    cleanupActivityTracking();
  } catch (error) {
    resolvedExitCode = resolvedExitCode || 1;
    console.error('Error during shutdown cleanup:', sanitizeError(error));
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
    console.log('✅ Client destroyed');
  } catch (error) {
    resolvedExitCode = resolvedExitCode || 1;
    console.error('Error destroying client:', sanitizeError(error));
  }

  process.exit(resolvedExitCode);
};

const appVersion = pkg.version ?? 'dev';
const shortCommit = process.env.GIT_COMMIT?.slice(0, 7) || 'unknown';
emitPhase('boot', '🚀', 'Booting bot', {
  app: pkg.name,
  ver: appVersion,
  commit: shortCommit,
  run: startupRunId
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

client.once(Events.ClientReady, async () => {
  
  try {
    // Initialize PostgreSQL database first
    await initializeDatabase();
    
    // Initialize storage and load configs
    await initializeGuildConfigs();
    initializeColorsDB();
    const configs = await loadGuildConfigs();
    const configCount = Object.keys(configs).length;
    const shardsInfo = client.options.shards && client.options.shards.length
      ? client.options.shards.length
      : 1;
    emitPhase('config', '🗂️', 'Configs ready', {
      mode: process.env.NODE_ENV || 'development',
      shards: shardsInfo,
      guilds: configCount
    });
    depsState.storage = 'postgres';
    tryEmitDeps();
    
    // Register slash commands globally
    const { registered: commandsUpdated } = await registerSlashCommands(client);
    const slashStatus = commandsUpdated ? 'commands refreshed' : 'commands unchanged';
    console.log(`📝 Slash commands ${slashStatus}`);

    emitPhase('discord', '🟢', `Logged in as ${client.user.tag}`);
    
    // Initialize activity tracking
    await initializeActivityTracking(client);
    
    // Setup component handlers
    setupComponentHandlers(client);
    
    // Schedule MVP timers for all configured guilds
    await scheduleAllMvpTimers(client);
    
    emitPhase('ready', '🏁', `Startup complete in ${Math.round(performance.now() - startupContext.startedAt)}ms`);
    
    // Run booster color audit in background (don't block startup)
    const { auditAllGuilds } = await import('./commands/colors.js');
    console.log('[Colors] Starting initial booster color audit in background...');
    auditAllGuilds(client).catch((error) => {
      console.error('Error in initial booster color audit:', sanitizeError(error));
    });
    
    // Schedule periodic audit every 8 hours
    setInterval(async () => {
      try {
        await auditAllGuilds(client);
      } catch (error) {
        console.error('Error in periodic booster color audit:', sanitizeError(error));
      }
    }, 8 * 60 * 60 * 1000); // 8 hours in milliseconds
  } catch (error) {
    console.error('Startup initialization failed:', sanitizeError(error));
    await shutdown('STARTUP_FAILURE', { exitCode: 1 });
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  
  try {
    await handleSlashCommand(interaction);
  } catch (error) {
    console.error('Error handling interaction:', sanitizeError(error));
    
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: '❌ An error occurred while handling this command.',
        flags: MessageFlags.Ephemeral
      });
    } else if (interaction.deferred) {
      await interaction.followUp({
        content: '❌ An error occurred while processing this command.',
        flags: MessageFlags.Ephemeral
      });
    }
  }
});

// Validate required environment variables
if (!process.env.DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN environment variable is required');
  process.exit(1);
}

// Guild leave handler - cleanup config and timers
client.on('guildDelete', async (guild) => {
  if (process.env.NODE_ENV !== 'production') {
    console.log(`🚪 Bot removed from guild: ${formatGuildForLog(guild)}`);
  }
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
      if (!(await isMemberBooster(newMember, newMember.guild.id))) {
        await stripBoosterColorsFromMember(newMember, newMember.guild.id);
      }
    }
  } catch (error) {
    console.error('Error handling member update:', sanitizeError(error));
  }
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

client.login(process.env.DISCORD_TOKEN);
