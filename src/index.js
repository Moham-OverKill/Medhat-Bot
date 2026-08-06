import 'dotenv/config';
import { Client, GatewayIntentBits, MessageFlags, Events, Partials, Options } from 'discord.js';
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
import { scheduleCairoMidnightReset } from './mvp/award.js';
import { seedMvpCacheFromDb } from './mvp/mvpCache.js';
import { startQuestScheduler } from './cron/quests.js';
import { startLeaderboardScheduler } from './cron/leaderboards.js';
import { setupComponentHandlers } from './components/handlers.js';
import { sanitizeError, formatGuildForLog, runInGuildContext } from './shared.js';
import { sendLog } from './utils/logger.js';
import { logSystemEvent, sysLog, sysError } from './utils/logger.js';
import { updateBotPresence, startPresenceRotation } from './cron/presence.js';
import { cleanupGhostItems, cleanupDeletedRole, runDependencySweep } from './economy/shop.js';
import { initializeTradeJanitor } from './commands/trade.js';
import pkg from '../package.json' with { type: 'json' };

const isProduction = process.env.NODE_ENV === 'production';

// Use formatGuildForLog from shared.js for consistent guild logging

// ============================================
// GLOBAL ERROR HANDLERS (CRASH PREVENTION)
// ============================================
process.on('unhandledRejection', (reason, promise) => {
  sysError('Unhandled Promise Rejection', reason);
});

process.on('uncaughtException', (error) => {
  sysError('Uncaught Exception', error);
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
  ],
  makeCache: Options.cacheWithLimits({
    MessageManager: 25,
    StageInstanceManager: 0,
    ThreadManager: 0,
    GuildBanManager: 0,
    GuildInviteManager: 0,
    GuildScheduledEventManager: 0,
    PresenceManager: 0,
    ReactionManager: 0
  }),
  sweepers: {
    ...Options.DefaultSweeperSettings,
    messages: {
      interval: 300,
      lifetime: 1800
    },
    users: {
      interval: 3600,
      filter: () => user => !user.bot && user.id !== client.user?.id
    }
  }
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
  
  const details = Object.entries(metadata)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([k, v]) => `${k}: ${v}`)
    .join(' | ');

  sysLog(`Phase: ${message}`, { detail: details || key });
}

function tryEmitDeps() {
  if (!depsState.keepalive || !depsState.storage) return;
  emitPhase('deps', 'Dependencies ready', depsState);
}

const shutdown = async (signal, { exitCode = 0 } = {}) => {
  if (shuttingDown) return;
  shuttingDown = true;
  let resolvedExitCode = exitCode;
  sysLog('Shutdown Sequence Triggered', { detail: `Signal: ${signal}` });

  try {
    cleanupActivityTracking();
  } catch (error) {
    resolvedExitCode = resolvedExitCode || 1;
    sysError('Shutdown Cleanup Failed', error, { detail: 'Activity Tracking' });
  }

  try {
    closeColorsDB();
    sysLog('Database Closed', { detail: 'Colors DB' });
  } catch (error) {
    resolvedExitCode = resolvedExitCode || 1;
    sysError('Shutdown Database Close Failed', error, { detail: 'Colors DB' });
  }

  try {
    await closeDatabase();
  } catch (error) {
    resolvedExitCode = resolvedExitCode || 1;
    sysError('Shutdown Database Close Failed', error, { detail: 'PostgreSQL' });
  }

  if (keepAliveServer) {
    await new Promise((resolve) => {
      keepAliveServer.close((closeError) => {
        if (closeError) {
          resolvedExitCode = resolvedExitCode || 1;
          sysError('Shutdown Server Close Failed', closeError, { detail: 'Keepalive' });
        }
        resolve();
      });
    });
    keepAliveServer = null;
  }

  try {
    client.destroy();
    sysLog('Client Destroyed');
  } catch (error) {
    resolvedExitCode = resolvedExitCode || 1;
    sysError('Shutdown Client Destroy Failed', error);
  }

  process.exit(resolvedExitCode);
};

const appVersion = pkg.version ?? 'dev';
const shortCommit = (process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT)?.slice(0, 7) || 'unknown';
emitPhase('boot', 'Starting bot', {
  ver: appVersion,
  commit: shortCommit
});

keepAliveServer = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/dblwebhook') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', async () => {
      try {
        const authHeader = req.headers['authorization'];
        const webhookAuth = process.env.TOPGG_WEBHOOK_PASSWORD;
        
        const signatureHeader = req.headers['x-topgg-signature'];
        let isAuthorized = false;

        if (!webhookAuth) {
          isAuthorized = process.env.NODE_ENV === 'development';
        } else {
          if (signatureHeader) {
            const parts = signatureHeader.split(',');
            let timestamp = '';
            let receivedSig = '';
            for (const part of parts) {
              const [key, val] = part.split('=');
              if (key === 't') timestamp = val;
              if (key === 'v1') receivedSig = val;
            }

            if (timestamp && receivedSig) {
              const expectedSig = crypto.createHmac('sha256', webhookAuth).update(`${timestamp}.${body}`).digest('hex');
              const bufReceived = Buffer.from(receivedSig, 'hex');
              const bufExpected = Buffer.from(expectedSig, 'hex');
              // Safe timing-safe comparison to prevent timing attacks; length check avoids throwing RangeError
              if (bufReceived.length === bufExpected.length && crypto.timingSafeEqual(bufReceived, bufExpected)) {
                isAuthorized = true;
              }
            }
          } else if (authHeader) {
            isAuthorized = authHeader === webhookAuth;
          }
        }

        if (!isAuthorized) {
          sysError('Webhook unauthorized access attempt', new Error('Auth mismatch or missing'));
          res.writeHead(401, { 'Content-Type': 'text/plain' });
          res.end('Unauthorized');
          return;
        }

        const data = JSON.parse(body);
        const isVoteEvent = data.type === 'vote.create' || data.type === 'upvote';
        const userId = data.data?.user?.platform_id || data.data?.user?.id || data.user?.id || data.user;
        const weight = data.data?.weight || 1;

        sysLog('Received Top.gg webhook payload', { 
          detail: `Type: ${data.type} | User ID: ${userId || 'none'} | Weight: ${weight}` 
        });

        if (isVoteEvent && userId) {
          const { handleVoteWebhook } = await import('./commands/vote.js');
          // Run in background to respond immediately and prevent Top.gg timeouts
          handleVoteWebhook(client, userId, weight).catch(err => {
            sysError('Error executing handleVoteWebhook in background', err);
          });
        }
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
      } catch (err) {
        sysError('Top.gg Webhook processing failure', err);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Error: ${err.message}\nStack: ${err.stack}`);
      }
    });
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ok');
});

keepAliveServer.on('error', (error) => {
  sysError('Keepalive Server Critical Error', error);
  shutdown('KEEPALIVE_SERVER_ERROR', { exitCode: 1 });
});

keepAliveServer.listen(keepalivePort, () => {
  depsState.keepalive = `:${keepalivePort}`;
  depsState.platform = os.platform();
  tryEmitDeps();
});

sysLog('Client Authenticating', { detail: 'Attempting Discord login' });

client.once(Events.ClientReady, async () => {
  sysLog('Client Ready', { user: client.user.id });

  try {
    // Initialize database (MUST BE FIRST)
    await initializeDatabase();
    emitPhase('deps', 'Database ready');

    // Initialize cached configs
    await initializeGuildConfigs();

    // Initialize colors database
    await initializeColorsDB();

    const configs = await loadGuildConfigs();
    const configCount = Object.keys(configs).length;

    emitPhase('config', 'Configs loaded', {
      guilds: configCount
    });
    depsState.storage = 'postgres';
    tryEmitDeps();

    // Register slash commands globally
    const { registered: commandsUpdated } = await registerSlashCommands(client);
    if (commandsUpdated) {
      sysLog('Commands Refreshed', { detail: 'Global sync complete' });
    }

    emitPhase('discord', `Logged in as ${client.user.tag}`);
    
    // Initialize Presence Rotation
    updateBotPresence(client);
    startPresenceRotation(client);
    sysLog('Task Started', { detail: 'Presence Rotation (Hourly)' });

    // Clear stale voice tracking data before starting activity tracking
    // Prevents point spam from timestamps saved before bot restart
    await clearStaleVoiceTracking();

    // Initialize activity tracking
    await initializeActivityTracking(client);

    // Setup component handlers
    setupComponentHandlers(client);

    // Seed the in-memory MVP cache from the database (restores active MVP state after reboot)
    await seedMvpCacheFromDb();
    await initializeTradeJanitor(client);
    sysLog('Task Started', { detail: 'MVP Cache Seeded from DB' });

    // Start background jobs
    startQuestScheduler(client);
    startLeaderboardScheduler(client); // Also runs KotH every hour

    emitPhase('ready', `Startup complete in ${Math.round(performance.now() - startupContext.startedAt)}ms`);

    const initMem = process.memoryUsage();
    sysLog('[CLEAN] Memory Optimization Active', { 
      v8MaxHeap: '384MB', 
      msgCacheCap: '25 per channel', 
      heapUsed: `${Math.round(initMem.heapUsed / 1024 / 1024)}MB`,
      rss: `${Math.round(initMem.rss / 1024 / 1024)}MB`
    });

    // Periodic memory check every 30 minutes
    setInterval(() => {
      const mem = process.memoryUsage();
      sysLog('[CLEAN] Memory Check', {
        heapUsed: `${Math.round(mem.heapUsed / 1024 / 1024)}MB / 384MB`,
        rss: `${Math.round(mem.rss / 1024 / 1024)}MB`
      });
    }, 30 * 60 * 1000);

    // Real-time maintenance is now handled by event listeners (guildRoleDelete, guildChannelDelete)

    // Run booster color audit in background (don't block startup)
    const { auditAllGuilds } = await import('./commands/colors.js');
    auditAllGuilds(client).catch((error) => {
      sysError('Booster Audit Background Error', error);
    });

    // Schedule periodic audit every 8 hours
    setInterval(async () => {
      try {
        await auditAllGuilds(client);
      } catch (error) {
        sysError('Booster Audit Periodic Error', error);
      }
    }, 8 * 60 * 60 * 1000); // 8 hours in milliseconds

    // Reconcile inventory for users who left while the bot was offline.
    // Runs in the background — one guild at a time with a short delay to avoid rate limits.
    (async () => {
      try {
        const { reconcileGuildInventory } = await import('./economy/shop.js');
        for (const guild of client.guilds.cache.values()) {
          await reconcileGuildInventory(guild).catch(err =>
            sysError('Inventory Reconciliation Error', err, { guild: guild.id })
          );
          await new Promise(r => setTimeout(r, 2000)); // 2s between guilds
        }
      } catch (err) {
        sysError('Inventory Reconciliation Startup Error', err);
      }
    })();

    // ========== CAIRO MIDNIGHT STREAK RESET JOB ==========
    // Resets all stale streaks at 00:00 Cairo time (UTC+2)
    scheduleCairoMidnightReset(client);

  } catch (error) {
    sysError('Startup Critical Failure', error);
    await shutdown('STARTUP_FAILURE', { exitCode: 1 });
  }
});

// Handle Discord API errors silently (prevents WebSocket crash)
client.on(Events.Error, (error) => {
  sysError('Discord Client Error', error);
});

// Handle reactions for quest tracking (Optimized Watch-mode)
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  const guildId = reaction.message?.guildId;
  return runInGuildContext(guildId, async () => {
    try {
      if (user.bot) return;

      // Direct check on partial message data to avoid API calls for non-quest channels
      const channelId = reaction.message.channelId;
      if (!guildId || !channelId) return;

      // Get parent ID for threads/posts (Robust lookup)
      let parentId = reaction.message.channel?.parentId;
      if (!parentId && reaction.message.guild) {
          // Attempt cache lookup
          const cached = reaction.message.guild.channels.cache.get(channelId);
          if (cached?.parentId) {
              parentId = cached.parentId;
          } else {
              // Proactive fetch for threads (needed for Forum/Media visibility)
              try {
                const fetched = await client.channels.fetch(channelId).catch(() => null);
                if (fetched?.parentId) parentId = fetched.parentId;
              } catch (err) {}
          }
      }

      const { isQuestChannel } = await import('./activity/index.js');
      if (!await isQuestChannel(guildId, channelId, parentId)) return;

      // This IS a quest channel -> proceed with fetches and tracking
      if (reaction.partial) await reaction.fetch().catch(() => null);
      if (reaction.message?.partial) await reaction.message.fetch().catch(() => null);

      const { checkReactionQuest } = await import('./activity/index.js');
      await checkReactionQuest(reaction, user);
    } catch (error) {
      // STOP SILENT FAIL: Log for debugging if quest tracking crashes
      sysError('Reaction Quest Failure', error, { guild: reaction.message?.guildId, user: user?.id });
    }
  });
});

// ============================================
// REAL-TIME GHOST MANAGEMENT (MAINTENANCE)
// ============================================

// Role Deletion: Purge Shop Items, Inventory, and Color Roles
client.on(Events.GuildRoleDelete, async (role) => {
  return runInGuildContext(role.guild?.id, async () => {
    try {
      const guild = role.guild;
      sysLog('Role Deleted', { guild: guild.id, detail: `RoleID: ${role.id}` });

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
          `• **Shop Items Deactivated:** ${stats.itemsRemoved}\n` +
          `• **History Preserved:** ${stats.inventoryRemoved} inventory entries updated\n` +
          `• **Prerequisites Healed:** YES (Scrubbed deleted item IDs)\n` +
          `• **Color Roles Removed:** ${(normalCleanup.deleted || boosterCleanup.deleted) ? 'Yes' : 'No'}`
        );
      }
    } catch (error) {
      sysError('Role Deletion Cleanup Failed', error, { guild: role.guild.id, detail: `RoleID: ${role.id}` });
    }
  });
});

// Channel Deletion: Update Guild Configuration
client.on(Events.GuildChannelDelete, async (channel) => {
  return runInGuildContext(channel.guild?.id, async () => {
    try {
      if (!channel.guild) return;
      const guild = channel.guild;
      const { getGuildConfig, setGuildConfig } = await import('./storage/config.js');
      const config = await getGuildConfig(guild.id);
      if (!config) return;

      let updated = false;

      const channelKeys = [
        { key: 'log_eco_channel_id', name: 'Economy Log' },
        { key: 'log_inv_channel_id', name: 'Inventory Log' },
        { key: 'log_shop_channel_id', name: 'Shop Log' },
        { key: 'log_audit_channel_id', name: 'Audit Log' },
        { key: 'announceChannelId', name: 'MVP Announcement' },
        { key: 'missions_channel_id', name: 'Quests (Legacy)' }
      ];

      for (const field of channelKeys) {
        if (config[field.key] === channel.id) {
          config[field.key] = null;
          updated = true;
        }
      }

      // Also clean up Organize channel filters
      if (config.channel_filters) {
        const filterKeys = ['links_only', 'images_only', 'media_only', 'cmd_only'];
        for (const key of filterKeys) {
          if (Array.isArray(config.channel_filters[key])) {
            const originalLength = config.channel_filters[key].length;
            config.channel_filters[key] = config.channel_filters[key].filter(id => id !== channel.id);
            if (config.channel_filters[key].length < originalLength) {
              updated = true;
            }
          }
        }
      }

      if (updated) {
        await setGuildConfig(guild.id, config);
        const { invalidateFilterCache } = await import('./middleware/organize.js');
        invalidateFilterCache(guild.id);
        sysLog('Config Updated', { guild: guild.id, detail: 'Deleted linked channel resource' });
      }
    } catch (error) {
      sysError('Channel Deletion Cleanup Failed', error, { guild: channel.guild?.id });
    }
  });
});

client.on(Events.InteractionCreate, async (interaction) => {
  return runInGuildContext(interaction.guildId, async () => {
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
      // Only log if it's not a standard Discord timeout/unknown interaction error bubbling up
      if (error.code !== 10062) {
        sysError('Interaction Processing Failed', error, { user: interaction.user.id, guild: interaction.guildId });
      }

      try {
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
      } catch (fallbackError) {
        // Ignore fallback errors like "Unknown interaction" which just means the token expired
      }
    }
  });
});

// Validate required environment variables
if (!process.env.DISCORD_TOKEN) {
  sysError('Critical Startup Error', 'DISCORD_TOKEN environment variable is required');
  process.exit(1);
}

// Guild leave handler - cleanup config and timers
client.on('guildDelete', async (guild) => {
  return runInGuildContext(guild.id, async () => {
    try {
      const { cancelMvpTimer } = await import('./mvp/award.js');
      const { deleteGuildConfig } = await import('./storage/config.js');
      cancelMvpTimer(guild.id);
      await deleteGuildConfig(guild.id);
      sysLog('Guild Left', { guild: guild.id, detail: 'Cleaned up data and timers' });
    } catch (error) {
      sysError('Guild Leave Cleanup Failed', error, { guild: guild.id });
    }
  });
});

// Deactivate inventory records when a member leaves the server while the bot is online
client.on('guildMemberRemove', async (member) => {
  return runInGuildContext(member.guild?.id, async () => {
    try {
      const { isDatabaseReady } = await import('./storage/postgres.js');
      if (!isDatabaseReady()) return;
      const { cleanupDepartedMember } = await import('./economy/shop.js');
      await cleanupDepartedMember(member.id, member.guild.id);
    } catch (error) {
      sysError('Member Leave Inventory Cleanup Failed', error, { user: member.id, guild: member.guild?.id });
    }
  });
});



// Member update handler - strip booster colors when boost status is lost
client.on('guildMemberUpdate', async (oldMember, newMember) => {
  return runInGuildContext(newMember.guild?.id, async () => {
    try {
      // Early guard: Only process boost-related changes to avoid unnecessary DB queries
      // on every nickname/avatar/role change in the server.
      const boostChanged = oldMember.premiumSince !== newMember.premiumSince;
      const rolesChanged = oldMember.roles.cache.size !== newMember.roles.cache.size;
      if (!boostChanged && !rolesChanged) return;

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
      sysError('Booster Update Processing Failed', error, { user: newMember.id, guild: newMember.guild.id });
    }
  });
});

// B-01 FIX: Duplicate roleDelete listener removed.
// Role deletion cleanup is already handled by Events.GuildRoleDelete (line 299).

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

client.login(process.env.DISCORD_TOKEN);
