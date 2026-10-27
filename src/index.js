import './utils/suppress-warnings.js';
import 'dotenv/config';
import dns from 'node:dns';

// Ensure IPv4 is prioritized in containerized environments where outbound IPv6 is disabled
if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}

import { Client, GatewayIntentBits, MessageFlags, Events, Partials, Options, RESTEvents } from 'discord.js';
import { createServer } from 'http';
import crypto from 'crypto';
import os from 'os';
import { performance } from 'node:perf_hooks';
import { registerSlashCommands } from './commands/register.js';
import { handleSlashCommand } from './commands/handler.js';
import { initializeGuildConfigs, loadGuildConfigs, configCache } from './storage/config.js';
import { initializeColorsDB, closeColorsDB } from './storage/colors.js';
import { initializeDatabase, closeDatabase } from './storage/postgres.js';
import { initializeActivityTracking, cleanup as cleanupActivityTracking, clearStaleVoiceTracking } from './activity/index.js';
import { scheduleCairoMidnightReset } from './mvp/award.js';
import { seedMvpCacheFromDb } from './mvp/mvpCache.js';
import { startQuestScheduler } from './cron/quests.js';
import { startLeaderboardScheduler } from './cron/leaderboards.js';
import { startExpirationScheduler } from './cron/expirations.js';
import { startShopRestockScheduler } from './cron/shop-restock.js';
import { startStartupSelfHealing } from './cron/self-healing.js';
import { startWeeklySummaryScheduler, seedWeeklySummaryActiveGuilds } from './cron/weeklySummary.js';
import { loadAllLeaderboardConfigs } from './commands/leaderboard.js';
import { setupComponentHandlers } from './components/handlers.js';
import { sanitizeError, formatGuildForLog, runInGuildContext, wrapInteractionSafety, safeDeferReply } from './shared.js';
import { handleInteractionError } from './utils/errors.js';
import { logger, sendLog, logSystemEvent, sysLog, sysWarn, sysError } from './utils/logger.js';
import { updateBotPresence, startPresenceRotation } from './cron/presence.js';
import { cleanupGhostItems, cleanupDeletedRole, runDependencySweep, healAllActiveTemporaryItemsOnStartup } from './economy/shop.js';
import { initializeTradeJanitor } from './commands/trade.js';
import { healTruncatedCategoryEmojis } from './economy/lootbox.js';
import pkg from '../package.json' with { type: 'json' };

const isProduction = process.env.NODE_ENV === 'production';

// Use formatGuildForLog from shared.js for consistent guild logging

// ============================================
// RUNTIME ENVIRONMENT AUDIT
// ============================================
logger.info('STARTUP', 'Runtime environment initialized', {
  nodeVersion: process.version,
  platform: os.platform(),
  arch: os.arch(),
  pid: process.pid,
  envMode: process.env.NODE_ENV || 'development',
  execFlags: process.execArgv.join(' ') || 'none'
});

logger.info('STARTUP', 'Environment variable verification', {
  DISCORD_TOKEN: process.env.DISCORD_TOKEN ? 'CONFIRMED (****)' : 'MISSING',
  DATABASE_URL: process.env.DATABASE_URL ? 'CONFIRMED (****)' : (process.env.DB_HOST ? 'CONFIRMED (Host/User)' : 'MISSING'),
  PORT: process.env.PORT || 3000,
  TOPGG_WEBHOOK_PASSWORD: process.env.TOPGG_WEBHOOK_PASSWORD ? 'CONFIRMED (****)' : 'NOT_CONFIGURED'
});

// ============================================
// GLOBAL ERROR HANDLERS (CRASH PREVENTION)
// ============================================
process.on('unhandledRejection', (reason, promise) => {
  logger.error('SYSTEM', 'Unhandled Promise Rejection', {
    memory: process.memoryUsage(),
    uptimeSeconds: Math.round(process.uptime())
  }, reason);
});

process.on('uncaughtException', (error) => {
  logger.fatal('SYSTEM', 'Uncaught Exception detected - initiating safe shutdown', {
    memory: process.memoryUsage(),
    uptimeSeconds: Math.round(process.uptime())
  }, error);
  shutdown('UNCAUGHT_EXCEPTION', { exitCode: 1 });
});

process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning') return;
  logger.warn('SYSTEM', `Process Warning: ${warning.name}`, { detail: warning.message });
});

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildEmojisAndStickers
  ],
  rest: {
    timeout: 15000,
    retries: 3
  },
  partials: [
    Partials.Message,
    Partials.Channel,
    Partials.Reaction,
    Partials.User
  ],
  makeCache: Options.cacheWithLimits({
    MessageManager: 10,
    StageInstanceManager: 0,
    ThreadManager: 200,
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
      lifetime: 900
    },
    users: {
      interval: 3600,
      filter: () => user => !user.bot && user.id !== client.user?.id
    },
    guildMembers: {
      interval: 900,
      filter: () => member => {
        if (member.id === client.user?.id) return false;
        if (member.voice?.channelId) return false;
        return true;
      }
    },
    threadMembers: {
      interval: 900,
      filter: () => member => member.id !== client.user?.id
    }
  }
});

// ============================================
// DISCORD REST API TELEMETRY & OBSERVABILITY
// ============================================
if (client.rest) {
  client.rest.on(RESTEvents.RateLimited, (data) => {
    logger.warn('REST', `Rate limit hit on ${data.method} ${data.route || data.url} in ${data.timeToReset}ms reset window (limit: ${data.limit}, global: ${data.global})`, {
      timeToResetMs: data.timeToReset,
      limit: data.limit,
      method: data.method,
      route: data.route,
      global: data.global,
      scope: data.scope
    });
  });

  client.rest.on(RESTEvents.InvalidRequestWarning, (data) => {
    logger.error('REST', `Discord Invalid Request Warning: ${data.count} invalid requests (remaining window: ${data.remainingTime}ms)`, {
      count: data.count,
      remainingTime: data.remainingTime
    });
  });

  if (typeof client.rest.request === 'function') {
    const origRestRequest = client.rest.request.bind(client.rest);
    client.rest.request = async (options) => {
      const reqStart = performance.now();
      const method = (options?.method || 'GET').toUpperCase();
      const route = options?.fullRoute || options?.route || options?.url || 'unknown';
      try {
        const res = await origRestRequest(options);
        const durationMs = Math.round(performance.now() - reqStart);
        if (durationMs > 1000) {
          logger.warn('REST', `Slow Discord REST ${method} ${route} completed in ${durationMs}ms`, {
            method,
            route,
            durationMs
          });
        } else {
          logger.debug('REST', `Discord REST ${method} ${route} completed in ${durationMs}ms`, {
            method,
            route,
            durationMs
          });
        }
        return res;
      } catch (err) {
        const durationMs = Math.round(performance.now() - reqStart);
        logger.warn('REST', `Discord REST ${method} ${route} failed after ${durationMs}ms`, {
          method,
          route,
          durationMs,
          status: err?.status,
          code: err?.code
        });
        throw err;
      }
    };
  }
}

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

  sysLog(message, { tag: 'STARTUP', detail: details || key });
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
    const { flushWeeklyActivityBatch } = await import('./cron/weeklySummary.js');
    await flushWeeklyActivityBatch();
  } catch (error) {
    sysError('Shutdown Cleanup Failed', error, { detail: 'Weekly Summary Batch' });
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

        let data;
        try {
          data = JSON.parse(body);
        } catch (parseErr) {
          sysError('Invalid JSON in webhook payload', parseErr);
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Bad Request: Invalid JSON');
          return;
        }
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
        res.end('Internal Server Error');
      }
    });
    return;
  }

  if (req.method === 'GET' && (req.url === '/health' || req.url === '/status')) {
    const wsStatusMap = ['READY', 'CONNECTING', 'RECONNECTING', 'IDLE', 'NEARLY', 'DISCONNECTED', 'WAITING_FOR_GUILDS', 'IDENTIFYING', 'RESUMING'];
    const payload = {
      status: client.isReady() ? 'healthy' : 'starting',
      version: appVersion,
      commit: shortCommit,
      ready: client.isReady(),
      wsStatus: wsStatusMap[client.ws?.status] || client.ws?.status,
      ping: client.ws?.ping ?? -1,
      guilds: client.guilds?.cache?.size || 0,
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString()
    };
    res.writeHead(client.isReady() ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
    return;
  }

  if (!client.isReady()) {
    const wsStatusMap = ['READY', 'CONNECTING', 'RECONNECTING', 'IDLE', 'NEARLY', 'DISCONNECTED', 'WAITING_FOR_GUILDS', 'IDENTIFYING', 'RESUMING'];
    const wsState = wsStatusMap[client.ws?.status] || `Status(${client.ws?.status})`;
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'starting', ready: false, wsStatus: wsState }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ok');
});

keepAliveServer.on('error', (error) => {
  sysError('Keepalive Server Critical Error', error);
  shutdown('KEEPALIVE_SERVER_ERROR', { exitCode: 1 });
});

keepAliveServer.listen(keepalivePort, '0.0.0.0', () => {
  depsState.keepalive = `0.0.0.0:${keepalivePort}`;
  depsState.platform = os.platform();
  sysLog('Keepalive Server Listening', { detail: `Port: ${keepalivePort}` });
  tryEmitDeps();
});

client.once(Events.ClientReady, async () => {
  const readyBenchStart = performance.now();
  const totalCachedMembers = client.guilds.cache.reduce((acc, g) => acc + (g.memberCount || g.members?.cache?.size || 0), 0);
  const totalCachedChannels = client.channels.cache.size;

  logger.info('GATEWAY', `Connected to Discord Gateway (Shard ${client.shard?.ids?.[0] ?? 0})`, {
    tag: client.user.tag,
    botId: client.user.id,
    guilds: client.guilds.cache.size,
    cachedMembers: totalCachedMembers,
    cachedChannels: totalCachedChannels,
    wsPingMs: client.ws.ping
  });

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

    // Prime in-memory activity tracking dependency caches (0-overhead fast-path)
    await loadAllLeaderboardConfigs();
    await seedWeeklySummaryActiveGuilds();

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
    await healTruncatedCategoryEmojis(client);
    await healAllActiveTemporaryItemsOnStartup();
    sysLog('Task Started', { detail: 'MVP Cache Seeded from DB' });

    // One-time self-healing rollback for the level inflation bug
    try {
      const { runLevelBugRollback } = await import('./commands/settings/level-rollback.js');
      await runLevelBugRollback(client);
    } catch (rollbackErr) {
      sysError('Level Bug Rollback Failed', rollbackErr);
    }

    // Start background jobs
    startQuestScheduler(client);
    startLeaderboardScheduler(client); // Also runs KotH every hour
    startExpirationScheduler(client);
    startShopRestockScheduler(client);
    startWeeklySummaryScheduler(client);
    startStartupSelfHealing(client);

    // Sweep and purge any departed bot admins across all guilds (runs non-blocking in background)
    import('./storage/admins.js').then(({ auditAndPruneDepartedAdmins, auditAndPruneDepartedAdminRoles }) => {
      auditAndPruneDepartedAdmins(client).catch(err => sysError('Startup Admin Audit Failed', err));
      auditAndPruneDepartedAdminRoles(client).catch(err => sysError('Startup Admin Role Audit Failed', err));
    }).catch(() => {});

    // Ensure image host database table exists on startup (test images disabled)
    import('./utils/image-host.js').then(({ initializeImageHostStartupTest }) => {
      initializeImageHostStartupTest(client).catch(err => sysError('Image Host Startup Init Failed', err));
    }).catch(() => {});

    emitPhase('ready', `Startup complete in ${Math.round(performance.now() - startupContext.startedAt)}ms`);
    const totalBootMs = Math.round(performance.now() - startupContext.startedAt);
    logger.info('STARTUP', `Bot fully booted and operational in ${totalBootMs}ms`, {
      totalBootMs,
      guilds: client.guilds.cache.size,
      nodeVersion: process.version
    });

    const initMem = process.memoryUsage();
    logger.info('SYSTEM', 'Memory Optimization Active', { 
      v8MaxHeap: '384MB', 
      msgCacheCap: '25 per channel', 
      heapUsed: `${Math.round(initMem.heapUsed / 1024 / 1024)}MB`,
      rss: `${Math.round(initMem.rss / 1024 / 1024)}MB`
    });

    // Periodic memory check every 30 minutes
    setInterval(() => {
      const mem = process.memoryUsage();
      logger.info('SYSTEM', 'Memory Check', {
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

    // Reconcile inventory, notifications, and pass level rewards in the background.
    // Runs in the background — one guild at a time with a short delay to avoid rate limits.
    (async () => {
      try {
        const { reconcileGuildInventory } = await import('./economy/shop.js');
        const { reconcileGuildNotifications } = await import('./storage/notifications.js');
        const { reconcileMissingLevelRewards } = await import('./commands/settings/pass-engine.js');
        const { sweepServerEmojiViolations } = await import('./middleware/emoji-filter.js');
        const { sweepOrphanedForumPosts } = await import('./middleware/organize.js');
        for (const guild of client.guilds.cache.values()) {
          await reconcileGuildInventory(guild).catch(err =>
            sysError('Inventory Reconciliation Error', err, { guild: guild.id })
          );
          await reconcileGuildNotifications(guild).catch(err =>
            sysError('Notification Reconciliation Error', err, { guild: guild.id })
          );
          await reconcileMissingLevelRewards(guild.id).catch(err =>
            sysError('Level Rewards Reconciliation Error', err, { guild: guild.id })
          );

          // Only perform sweeps if the corresponding feature is enabled in guild config
          const guildConfig = configCache.get(guild.id);
          const channelFilters = guildConfig?.channel_filters;

          if (channelFilters?.reaction_blacklist_enabled === true) {
            await sweepServerEmojiViolations(guild).catch(err =>
              sysError('Emoji Blacklist Startup Sweep Error', err, { guild: guild.id })
            );
          }
          const isNoOriginalActive = channelFilters?.forum_no_original !== undefined
            ? channelFilters.forum_no_original === true
            : (channelFilters?.no_original !== undefined
                ? channelFilters.no_original === true
                : (channelFilters?.forum_auto_delete_enabled !== undefined ? channelFilters.forum_auto_delete_enabled === true : false));
          if (isNoOriginalActive) {
            await sweepOrphanedForumPosts(guild).catch(err =>
              sysError('Forum Auto-Delete Startup Sweep Error', err, { guild: guild.id })
            );
          }

          await new Promise(r => setTimeout(r, 1000)); // 1s between guilds
        }
      } catch (err) {
        sysError('Reconciliation Startup Error', err);
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

client.on(Events.ShardError, (error, shardId) => {
  sysError('Discord Gateway Shard Error', error, { detail: `Shard ${shardId}` });
});

client.on(Events.ShardDisconnect, (event, shardId) => {
  sysWarn('Discord Gateway Shard Disconnected', { detail: `Shard ${shardId} disconnected (code: ${event.code}, reason: ${event.reason || 'None'})` });
});

client.on(Events.ShardReconnecting, (shardId) => {
  sysLog('Discord Gateway Shard Reconnecting', { detail: `Shard ${shardId}` });
});

// Discord REST rate limits are handled automatically by discord.js (queued + retried).
// No listener needed — logging them at warn level causes Railway to flag them as errors.


// Handle reactions for quest tracking (Optimized Watch-mode)
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  const guildId = reaction.message?.guildId;
  return runInGuildContext(guildId, async () => {
    try {
      if (user.bot) return;
      if (!guildId) return;

      // === EMOJI BLACKLIST CHECK ===
      const { processReactionEmojiFilter } = await import('./middleware/emoji-filter.js');
      const isBlacklisted = await processReactionEmojiFilter(reaction, user);
      if (isBlacklisted) return;

      // Track reaction given toward weekly activity summary
      import('./cron/weeklySummary.js')
        .then(({ recordWeeklyReaction }) => recordWeeklyReaction(guildId, user.id, user.username, 1))
        .catch(() => {});

      // Track reaction received toward weekly activity summary
      const msgAuthorAdd = reaction.message?.author;
      if (msgAuthorAdd && !msgAuthorAdd.bot && msgAuthorAdd.id !== user.id) {
        import('./cron/weeklySummary.js')
          .then(({ recordWeeklyReactionReceived }) => recordWeeklyReactionReceived(guildId, msgAuthorAdd.id, msgAuthorAdd.username, 1))
          .catch(() => {});
      } else if (!msgAuthorAdd && reaction.message) {
        reaction.message.fetch().then(msg => {
          if (msg?.author && !msg.author.bot && msg.author.id !== user.id) {
            import('./cron/weeklySummary.js')
              .then(({ recordWeeklyReactionReceived }) => recordWeeklyReactionReceived(guildId, msg.author.id, msg.author.username, 1))
              .catch(() => {});
          }
        }).catch(() => {});
      }

      // Direct check on partial message data to avoid API calls for non-quest channels
      const channelId = reaction.message.channelId;
      if (!channelId) return;

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

// Handle reaction removal for quest decrement (Optimized Watch-mode)
client.on(Events.MessageReactionRemove, async (reaction, user) => {
  const guildId = reaction.message?.guildId;
  return runInGuildContext(guildId, async () => {
    try {
      if (user.bot) return;
      if (!guildId) return;

      // Decrement reaction given toward weekly activity summary
      import('./cron/weeklySummary.js')
        .then(({ recordWeeklyReaction }) => recordWeeklyReaction(guildId, user.id, user.username, -1))
        .catch(() => {});

      // Decrement reaction received toward weekly activity summary
      const msgAuthorRemove = reaction.message?.author;
      if (msgAuthorRemove && !msgAuthorRemove.bot && msgAuthorRemove.id !== user.id) {
        import('./cron/weeklySummary.js')
          .then(({ recordWeeklyReactionReceived }) => recordWeeklyReactionReceived(guildId, msgAuthorRemove.id, msgAuthorRemove.username, -1))
          .catch(() => {});
      } else if (!msgAuthorRemove && reaction.message) {
        reaction.message.fetch().then(msg => {
          if (msg?.author && !msg.author.bot && msg.author.id !== user.id) {
            import('./cron/weeklySummary.js')
              .then(({ recordWeeklyReactionReceived }) => recordWeeklyReactionReceived(guildId, msg.author.id, msg.author.username, -1))
              .catch(() => {});
          }
        }).catch(() => {});
      }

      const channelId = reaction.message.channelId;
      if (!channelId) return;

      let parentId = reaction.message.channel?.parentId;
      if (!parentId && reaction.message.guild) {
          const cached = reaction.message.guild.channels.cache.get(channelId);
          if (cached?.parentId) {
              parentId = cached.parentId;
          } else {
              try {
                const fetched = await client.channels.fetch(channelId).catch(() => null);
                if (fetched?.parentId) parentId = fetched.parentId;
              } catch (err) {}
          }
      }

      const { isQuestChannel } = await import('./activity/index.js');
      if (!await isQuestChannel(guildId, channelId, parentId)) return;

      if (reaction.partial) await reaction.fetch().catch(() => null);
      if (reaction.message?.partial) await reaction.message.fetch().catch(() => null);

      const { checkReactionRemoveQuest } = await import('./activity/index.js');
      await checkReactionRemoveQuest(reaction, user);
    } catch (error) {
      sysError('Reaction Remove Quest Failure', error, { guild: reaction.message?.guildId, user: user?.id });
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
      const stats = await cleanupDeletedRole(guild.id, role.id);

      // 2. Cleanup Color Roles (regular and booster)
      const { removeColorRole } = await import('./storage/colors.js');
      const normalCleanup = await removeColorRole(guild.id, role.id, false);
      const boosterCleanup = await removeColorRole(guild.id, role.id, true);

      // 3. Cleanup Bot Admin Roles
      const { removeServerAdminRole } = await import('./storage/admins.js');
      const adminRoleRemoved = await removeServerAdminRole(guild.id, role.id);

      // 4. Audit Log
      if (stats.itemsRemoved > 0 || normalCleanup.deleted || boosterCleanup.deleted || adminRoleRemoved) {
        sendLog(guild, 'audit', 'crimson', '🛡️ Real-Time Ghost Cleanup', 
          `Role **@${role.name}** was deleted from the server. Maintenance initiated:\n` +
          `• **Shop Items Deactivated:** ${stats.itemsRemoved}\n` +
          `• **History Preserved:** ${stats.inventoryRemoved} inventory entries updated\n` +
          `• **Prerequisites Healed:** YES (Scrubbed deleted item IDs)\n` +
          `• **Color Roles Removed:** ${(normalCleanup.deleted || boosterCleanup.deleted) ? 'Yes' : 'No'}\n` +
          `• **Admin Role Purged:** ${adminRoleRemoved ? 'Yes' : 'No'}`
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

      // Clean up leaderboard channel references if configured
      try {
        const { getLeaderboardConfig, setLeaderboardConfig } = await import('./commands/leaderboard.js');
        const lbConfig = await getLeaderboardConfig(guild.id);
        if (lbConfig) {
          let lbUpdated = false;
          const lbFields = [
            { chan: 'daily_channel_id', title: 'daily_title_message_id', msg: 'daily_message_id' },
            { chan: 'coins_channel_id', title: 'coins_title_message_id', msg: 'coins_message_id' },
            { chan: 'streak_channel_id', title: 'streak_title_message_id', msg: 'streak_message_id' },
            { chan: 'level_channel_id', title: 'level_title_message_id', msg: 'level_message_id' }
          ];
          for (const f of lbFields) {
            if (lbConfig[f.chan] === channel.id) {
              lbConfig[f.chan] = null;
              lbConfig[f.title] = null;
              lbConfig[f.msg] = null;
              lbUpdated = true;
            }
          }
          if (lbUpdated) {
            await setLeaderboardConfig(guild.id, lbConfig);
            logger.info('SERVER', `Pruned deleted leaderboard channel ${channel.id} from guild ${guild.id}`);
          }
        }
      } catch (lbErr) {
        // Non-blocking
      }
    } catch (error) {
      sysError('Channel Deletion Cleanup Failed', error, { guild: channel.guild?.id });
    }
  });
});

// ============================================
// EMOJI BLACKLIST MODERATION LISTENERS
// ============================================

// Server Name / Metadata Updates (Sync storage threads)
client.on(Events.GuildUpdate, async (oldGuild, newGuild) => {
  return runInGuildContext(newGuild.id, async () => {
    try {
      if (oldGuild && newGuild && oldGuild.name !== newGuild.name) {
        const { syncGuildStorageThreads } = await import('./utils/image-host.js');
        await syncGuildStorageThreads(newGuild.client, newGuild.id, newGuild.name);
      }
    } catch (err) {
      sysError('GuildUpdate Storage Thread Sync Failed', err, {
        guild: newGuild.id,
        oldName: oldGuild?.name,
        newName: newGuild.name
      });
    }
  });
});

// Member Nickname / Role Updates
client.on(Events.GuildMemberUpdate, async (_oldMember, newMember) => {
  return runInGuildContext(newMember.guild?.id, async () => {
    try {
      const { processMemberNicknameEmojiFilter } = await import('./middleware/emoji-filter.js');
      await processMemberNicknameEmojiFilter(newMember);
    } catch (err) {
      sysError('GuildMemberUpdate Emoji Guard Failed', err, { guild: newMember.guild?.id, user: newMember.id });
    }
  });
});

const EMOJI_TEST_REGEX = /(\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Regional_Indicator}|\u20E3|<a?:[a-zA-Z0-9_]+:\d{17,20}>)/u;

// Global User Profile Updates (Username / Display Name changed across Discord)
client.on(Events.UserUpdate, async (oldUser, newUser) => {
  if (newUser.bot) return;

  // Ignore if display/user names did not change (e.g. avatar, banner, or status update)
  const nameChanged = !oldUser ||
                      oldUser.username !== newUser.username ||
                      oldUser.displayName !== newUser.displayName ||
                      oldUser.globalName !== newUser.globalName;
  if (!nameChanged) return;

  // Fast regex guard: if new names contain no emojis, skip iterating across all guilds
  const candidateText = `${newUser.displayName || ''} ${newUser.username || ''} ${newUser.globalName || ''}`;
  if (!EMOJI_TEST_REGEX.test(candidateText)) return;

  try {
    const { processMemberNicknameEmojiFilter } = await import('./middleware/emoji-filter.js');
    for (const guild of client.guilds.cache.values()) {
      const member = guild.members.cache.get(newUser.id);
      if (member) {
        await processMemberNicknameEmojiFilter(member).catch(() => {});
      }
    }
  } catch (err) {
    sysError('UserUpdate Emoji Guard Failed', err, { user: newUser.id });
  }
});

// Member Join
client.on(Events.GuildMemberAdd, async (member) => {
  return runInGuildContext(member.guild?.id, async () => {
    try {
      const { processMemberNicknameEmojiFilter } = await import('./middleware/emoji-filter.js');
      await processMemberNicknameEmojiFilter(member);
    } catch (err) {
      sysError('GuildMemberAdd Emoji Guard Failed', err, { guild: member.guild?.id, user: member.id });
    }
  });
});

// Channel Created (Text, Voice, Forum, Stage, Category, etc.)
client.on(Events.ChannelCreate, async (channel) => {
  if (!channel.guild) return;
  return runInGuildContext(channel.guild.id, async () => {
    try {
      const { processChannelNameEmojiFilter } = await import('./middleware/emoji-filter.js');
      await processChannelNameEmojiFilter(channel);
    } catch (err) {
      sysError('ChannelCreate Emoji Guard Failed', err, { guild: channel.guild?.id, channel: channel.id });
    }
  });
});

// Channel Updated (Renamed, Topic changed, Category changed, etc.)
client.on(Events.ChannelUpdate, async (_oldChannel, newChannel) => {
  if (!newChannel.guild) return;
  return runInGuildContext(newChannel.guild.id, async () => {
    try {
      const { processChannelNameEmojiFilter } = await import('./middleware/emoji-filter.js');
      await processChannelNameEmojiFilter(newChannel);
    } catch (err) {
      sysError('ChannelUpdate Emoji Guard Failed', err, { guild: newChannel.guild?.id, channel: newChannel.id });
    }
  });
});

// Thread / Forum Post Created
client.on(Events.ThreadCreate, async (thread) => {
  if (!thread.guild) return;
  return runInGuildContext(thread.guild.id, async () => {
    try {
      const { processChannelNameEmojiFilter } = await import('./middleware/emoji-filter.js');
      await processChannelNameEmojiFilter(thread);
    } catch (err) {
      sysError('ThreadCreate Emoji Guard Failed', err, { guild: thread.guild?.id, thread: thread.id });
    }
  });
});

// Thread / Forum Post Updated
client.on(Events.ThreadUpdate, async (_oldThread, newThread) => {
  if (!newThread.guild) return;
  return runInGuildContext(newThread.guild.id, async () => {
    try {
      const { processChannelNameEmojiFilter } = await import('./middleware/emoji-filter.js');
      await processChannelNameEmojiFilter(newThread);
    } catch (err) {
      sysError('ThreadUpdate Emoji Guard Failed', err, { guild: newThread.guild?.id, thread: newThread.id });
    }
  });
});

// Voice Channel Status Updates (Raw Gateway dispatch)
client.on(Events.Raw, async (packet) => {
  if (packet.t === 'VOICE_CHANNEL_STATUS_UPDATE' && packet.d) {
    const { guild_id, id, status } = packet.d;
    if (guild_id && id && status) {
      runInGuildContext(guild_id, async () => {
        try {
          const { processVoiceStatusEmojiFilter } = await import('./middleware/emoji-filter.js');
          await processVoiceStatusEmojiFilter(client, guild_id, id, status);
        } catch (err) {
          sysError('Voice Status Emoji Guard Failed', err, { guild: guild_id, channel: id });
        }
      });
    }
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  return runInGuildContext(interaction.guildId, async () => {
    if (!interaction.isChatInputCommand()) return;

    wrapInteractionSafety(interaction);

    const cmdStart = performance.now();
    const cmdName = interaction.commandName;
    const subCmd = interaction.options?.getSubcommand(false);
    const fullCmdName = subCmd ? `/${cmdName} ${subCmd}` : `/${cmdName}`;

    logger.info('DISPATCH', `Command received: ${fullCmdName}`, {
      user: `${interaction.user.username} (${interaction.user.id})`,
      guildId: interaction.guildId || 'DM',
      channelId: interaction.channelId
    });

    // Active 2000ms watchdog for slash commands to prevent Discord's 3.0s hard timeout
    const watchdog = setTimeout(async () => {
      if (!interaction.deferred && !interaction.replied) {
        logger.warn('DISPATCH', 'Slash command watchdog safety triggered: applying emergency deferral', {
          user: interaction.user?.tag || interaction.user?.id,
          guildId: interaction.guildId,
          command: fullCmdName
        });
        await safeDeferReply(interaction, { flags: MessageFlags.Ephemeral });
      }
    }, 2000);

    // Check if bot is fully ready
    if (!depsState.storage) {
      clearTimeout(watchdog);
      logger.warn('DISPATCH', `Command deferred during startup: ${fullCmdName}`, {
        user: interaction.user.id,
        guildId: interaction.guildId
      });
      return interaction.reply({
        content: 'The bot is currently starting up and connecting to the database. Please try again in a few seconds.',
        flags: MessageFlags.Ephemeral
      });
    }

    try {
      await handleSlashCommand(interaction);
      const duration = Math.round(performance.now() - cmdStart);
      if (duration > 1500) {
        logger.warn('DISPATCH', `Slow Command Execution: ${fullCmdName} completed in ${duration}ms`, {
          durationMs: duration,
          user: interaction.user.id,
          guildId: interaction.guildId
        });
      } else {
        logger.info('DISPATCH', `${fullCmdName} completed in ${duration}ms`, {
          durationMs: duration,
          user: interaction.user.id,
          guildId: interaction.guildId
        });
      }
    } catch (error) {
      const duration = Math.round(performance.now() - cmdStart);
      if (error.code !== 10062) {
        logger.error('DISPATCH', `Command Execution Failed: ${fullCmdName} after ${duration}ms`, {
          durationMs: duration,
          user: interaction.user.id,
          guildId: interaction.guildId
        }, error);
      }

      await handleInteractionError(interaction, error, fullCmdName);
    } finally {
      clearTimeout(watchdog);
    }
  });
});

// Validate required environment variables
if (!process.env.DISCORD_TOKEN) {
  sysError('Critical Startup Error', 'DISCORD_TOKEN environment variable is required');
  process.exit(1);
}

// Guild leave handler - cancel timers only, preserve configuration permanently
client.on('guildDelete', async (guild) => {
    logger.info('EVENT', `Removed from guild: ${guild.name || guild.id}`, { guildId: guild.id });
  return runInGuildContext(guild.id, async () => {
    try {
      const { cancelMvpTimer } = await import('./mvp/award.js');
      cancelMvpTimer(guild.id);
      const { deleteLeaderboardConfig } = await import('./commands/leaderboard.js');
      await deleteLeaderboardConfig(guild.id).catch(() => {});
      sysLog('Guild Left', { guild: guild.id, detail: 'Canceled timers and pruned leaderboard configuration' });
    } catch (error) {
      sysError('Guild Leave Cleanup Failed', error, { guild: guild.id });
    }
  });
});

// Deactivate inventory records and disable notification settings when a member leaves the server while the bot is online
client.on('guildMemberRemove', async (member) => {
    logger.info('EVENT', 'Member departed server', { userId: member.id, guildId: member.guild?.id });
  return runInGuildContext(member.guild?.id, async () => {
    try {
      const { isDatabaseReady } = await import('./storage/postgres.js');
      if (!isDatabaseReady()) return;
      const { cleanupDepartedMember } = await import('./economy/shop.js');
      await cleanupDepartedMember(member.id, member.guild.id);
      const { disableUserNotificationsOnLeave } = await import('./storage/notifications.js');
      await disableUserNotificationsOnLeave(member.guild.id, member.id);
      const { removeServerAdmin } = await import('./storage/admins.js');
      await removeServerAdmin(member.guild.id, member.id);
      const { markMemberDeparted } = await import('./commands/leaderboard.js');
      markMemberDeparted(member.guild.id, member.id);
    } catch (error) {
      sysError('Member Leave Cleanup Failed', error, { user: member.id, guild: member.guild?.id });
    }
  });
});

// Ensure any stale admin whitelist entries are purged if a departed user rejoins
client.on('guildMemberAdd', async (member) => {
    logger.info('EVENT', 'Member joined server', { userId: member.id, guildId: member.guild?.id });
  return runInGuildContext(member.guild?.id, async () => {
    try {
      const { isDatabaseReady } = await import('./storage/postgres.js');
      if (!isDatabaseReady()) return;
      const { removeServerAdmin } = await import('./storage/admins.js');
      await removeServerAdmin(member.guild.id, member.id);
      const { clearMemberDeparted } = await import('./commands/leaderboard.js');
      clearMemberDeparted(member.guild.id, member.id);
    } catch (error) {
      sysError('Member Join Stale Admin Cleanup Failed', error, { user: member.id, guild: member.guild?.id });
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

// Sync slash commands when the bot joins a new server
client.on('guildCreate', async (guild) => {
    logger.info('EVENT', `Joined guild: ${guild.name}`, { guildId: guild.id, memberCount: guild.memberCount, ownerId: guild.ownerId });
  try {
    const { syncGuildSlashCommands } = await import('./commands/register.js');
    await syncGuildSlashCommands(guild.id, client);
  } catch (error) {
    sysError('Failed to sync slash commands on guildCreate', error, { guild: guild.id });
  }
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

client.rest.on('rateLimited', (info) => {
  sysLog('Discord REST Rate Limited', {
    detail: `Route: ${info.route} | Retry After: ${info.timeToReset}ms | Global: ${info.global}`
  });
});

client.rest.on('invalidRequestWarning', (info) => {
  sysWarn('Discord REST Invalid Request Warning', {
    detail: `Count: ${info.count} | Remaining: ${info.remainingTime}`
  });
});

client.on(Events.Error, (err) => {
  sysError('Discord Client Error', err);
});

client.on(Events.Warn, (msg) => {
  sysWarn('Discord Client Warning', { detail: msg });
});

client.on(Events.Debug, (msg) => {
  if (!client.isReady()) {
    // During startup handshake, log all non-sensitive gateway and REST activity
    if (!msg.includes('Provided token')) {
      logger.info('STARTUP', `Gateway Startup Debug: ${msg}`);
    }
    return;
  }

  // Heartbeat analysis
  if (msg.includes('Heartbeat acknowledged')) {
    const latMatch = msg.match(/latency of (\d+)ms/);
    const lat = latMatch ? parseInt(latMatch[1], 10) : null;
    if (lat !== null && lat > 250) {
      logger.warn('GATEWAY', `High WebSocket latency detected (${lat}ms)`, { pingMs: lat });
    } else {
      logger.debug('GATEWAY', msg, lat !== null ? { pingMs: lat } : undefined);
    }
    return;
  }

  if (
    msg.includes('[WS =>') ||
    msg.includes('Identify') ||
    msg.includes('Session') ||
    msg.includes('429') ||
    msg.includes('rate limit') ||
    msg.includes('Waiting for') ||
    msg.includes('Invalid session')
  ) {
    logger.debug('GATEWAY', msg);
  }
});

// Gateway Shard Lifecycle Events
client.on(Events.ShardDisconnect, (event, shardId) => {
  logger.warn('GATEWAY', `Shard ${shardId} disconnected from Discord`, {
    shardId,
    code: event?.code,
    reason: event?.reason || 'No reason provided'
  });
});

client.on(Events.ShardReconnecting, (shardId) => {
  logger.info('GATEWAY', `Shard ${shardId} reconnecting to Discord gateway`, { shardId });
});

client.on(Events.ShardResume, (shardId, replayedEvents) => {
  logger.info('GATEWAY', `Shard ${shardId} resumed connection (${replayedEvents} events replayed)`, {
    shardId,
    replayedEvents
  });
});

client.on(Events.ShardError, (error, shardId) => {
  logger.error('GATEWAY', `Shard ${shardId} encountered WebSocket error`, { shardId }, error);
});

// ============================================
// SYSTEM RESOURCE & EVENT LOOP HEALTH WATCHDOG
// ============================================
const MAX_OLD_SPACE_MB = 384;
const MEMORY_WARN_THRESHOLD_MB = Math.round(MAX_OLD_SPACE_MB * 0.80); // 307 MB (80%)

let lastLoopCheck = performance.now();
setInterval(() => {
  const now = performance.now();
  const lagMs = Math.round(now - lastLoopCheck - 1000);
  lastLoopCheck = now;
  if (lagMs > 200) {
    logger.warn('SYSTEM', `Event loop lag spike detected (${lagMs}ms)`, { lagMs });
  }
}, 1000).unref();

setInterval(() => {
  const mem = process.memoryUsage();
  const heapUsedMb = Math.round(mem.heapUsed / (1024 * 1024));
  const heapTotalMb = Math.round(mem.heapTotal / (1024 * 1024));
  const rssMb = Math.round(mem.rss / (1024 * 1024));

  if (heapUsedMb >= MEMORY_WARN_THRESHOLD_MB) {
    logger.warn('SYSTEM', `High memory pressure detected (${heapUsedMb}MB / ${MAX_OLD_SPACE_MB}MB)`, {
      heapUsedMb,
      heapTotalMb,
      rssMb,
      percent: Math.round((heapUsedMb / MAX_OLD_SPACE_MB) * 100)
    });
  } else {
    logger.debug('SYSTEM', 'System resource health check', {
      heapUsedMb,
      heapTotalMb,
      rssMb
    });
  }
}, 60000).unref();

// Diagnostic warning if gateway handshake takes longer than 60s (non-fatal, avoids reboot loops)
const GATEWAY_LOGIN_WARN_MS = 60000;
const gatewayWarnTimer = setTimeout(() => {
  if (client.isReady()) return;
  const wsStatusMap = ['READY', 'CONNECTING', 'RECONNECTING', 'IDLE', 'NEARLY', 'DISCONNECTED', 'WAITING_FOR_GUILDS', 'IDENTIFYING', 'RESUMING'];
  const wsState = wsStatusMap[client.ws?.status] || `Status(${client.ws?.status})`;
  sysWarn('Gateway Connection Delayed', {
    detail: `Handshake pending at ${wsState} after ${GATEWAY_LOGIN_WARN_MS / 1000}s. Discord gateway or REST API may be rate-limited or throttling identify.`
  });
}, GATEWAY_LOGIN_WARN_MS);
if (typeof gatewayWarnTimer.unref === 'function') gatewayWarnTimer.unref();

sysLog('Client Authenticating', { detail: 'Initiating Discord gateway login' });
client.login(process.env.DISCORD_TOKEN).then(() => {
  if (gatewayWarnTimer) clearTimeout(gatewayWarnTimer);
  sysLog('Discord Gateway Login Succeeded');
}).catch((error) => {
  if (gatewayWarnTimer) clearTimeout(gatewayWarnTimer);
  sysError('Discord Login Critical Failure', error);
  process.exit(1);
});
