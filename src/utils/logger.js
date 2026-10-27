import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { getPool } from '../storage/postgres.js';
import { stripLog } from '../shared.js';

// Cache log channel IDs to avoid DB hits on every log (1 min cache, max 500 entries)
const logChannelCache = new Map();
const LOG_CACHE_MAX_SIZE = 500;

/**
 * Standardized Log Levels and Severity Weights
 */
export const LogLevel = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
  FATAL: 50
};

const LOG_LEVEL_NAMES = {
  [LogLevel.DEBUG]: 'DEBUG',
  [LogLevel.INFO]: 'INFO',
  [LogLevel.WARN]: 'WARN',
  [LogLevel.ERROR]: 'ERROR',
  [LogLevel.FATAL]: 'FATAL'
};

const ANSI = {
  RESET: '\x1b[0m',
  DEBUG: '\x1b[36m',        // Cyan
  INFO: '\x1b[32m',         // Green
  WARN: '\x1b[33m',         // Yellow
  ERROR: '\x1b[1;31m',      // Bold Red
  FATAL: '\x1b[41;1;37m',   // White on Red background
  GRAY: '\x1b[90m',
  BOLD: '\x1b[1m'
};

/**
 * Determine active log level based on environment
 */
function resolveInitialLogLevel() {
  const envLevel = process.env.LOG_LEVEL?.toUpperCase();
  if (envLevel && LogLevel[envLevel] !== undefined) {
    return LogLevel[envLevel];
  }
  if (process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development') {
    return LogLevel.DEBUG;
  }
  return LogLevel.INFO;
}

let currentLogLevel = resolveInitialLogLevel();

/**
 * Format timestamp as YYYY-MM-DD HH:mm:ss.SSS
 */
export function formatTimestamp(date = new Date()) {
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  const millis = pad(date.getMilliseconds(), 3);
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${millis}`;
}

/**
 * Sensitive Data Sanitizer & Redaction Filter
 */
export function redactSensitiveData(data, depth = 0) {
  if (depth > 6 || data === null || data === undefined) return data;

  if (typeof data === 'string') {
    return data
      .replace(/([a-zA-Z]+:\/\/[^:]+):[^@]+@/g, '$1:****@')
      .replace(/Bearer\s+[A-Za-z0-9._\-~+/]+=*/gi, 'Bearer ****')
      .replace(/(mfa\.[a-z0-9_-]{20,}|[a-z0-9_-]{23,28}\.[a-z0-9_-]{6,7}\.[a-z0-9_-]{27,})/gi, '****');
  }

  if (typeof data !== 'object') return data;

  if (Array.isArray(data)) {
    return data.map(item => redactSensitiveData(item, depth + 1));
  }

  const sanitized = {};
  for (const [key, value] of Object.entries(data)) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey.includes('password') ||
      lowerKey.includes('token') ||
      lowerKey.includes('secret') ||
      lowerKey.includes('authorization') ||
      lowerKey.includes('cookie') ||
      lowerKey.includes('webhook_password')
    ) {
      sanitized[key] = '****';
    } else {
      sanitized[key] = redactSensitiveData(value, depth + 1);
    }
  }
  return sanitized;
}

/**
 * Serialize context payload cleanly
 */
function serializeContext(context) {
  if (!context || typeof context !== 'object') return '';
  const entries = Object.entries(context).filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return '';

  const sanitizedObj = redactSensitiveData(Object.fromEntries(entries));
  try {
    return JSON.stringify(sanitizedObj);
  } catch {
    return '[Unserializable Context]';
  }
}

/**
 * Write log entry to deployment stdout / stderr stream
 */
function writeLog(level, moduleName, message, context = null, error = null) {
  if (level < currentLogLevel) return;

  const levelName = LOG_LEVEL_NAMES[level] || 'INFO';
  const timestamp = formatTimestamp();
  const cleanModule = (moduleName || 'SYSTEM').toUpperCase().replace(/[\s_]+/g, '-');
  let cleanMsg = typeof message === 'string' ? stripLog(message) : String(message);

  const supportsColor = !process.env.NO_COLOR && (process.stdout.isTTY || process.env.FORCE_COLOR);
  const color = supportsColor ? (ANSI[levelName] || ANSI.INFO) : '';
  const reset = supportsColor ? ANSI.RESET : '';
  const gray = supportsColor ? ANSI.GRAY : '';

  const targetError = error || (context && context.error instanceof Error ? context.error : (typeof context?.error === 'string' ? new Error(context.error) : null));

  if (targetError) {
    const rawErrMsg = targetError.message || String(targetError);
    if (rawErrMsg && rawErrMsg !== 'Error' && !cleanMsg.includes(rawErrMsg)) {
      cleanMsg += `: ${stripLog(rawErrMsg)}`;
    }
  }

  cleanMsg = cleanMsg.replace(/^(\[[A-Za-z0-9_\-\s:]+\]\s*)+/g, '').trim();

  let contextStr = '';
  if (context && typeof context === 'object') {
    const serialized = serializeContext(context);
    if (serialized) {
      contextStr = ` | Context: ${serialized}`;
    }
  }

  const logLine = `${timestamp} ${color}${levelName}${reset} ${cleanModule}: ${cleanMsg}${contextStr}\n`;

  if (level >= LogLevel.ERROR) {
    process.stderr.write(logLine);
  } else {
    process.stdout.write(logLine);
  }

  // Handle stack trace if error exists
  if (targetError && targetError.stack) {
    const stackFrames = targetError.stack
      .split('\n')
      .slice(1, 6)
      .map(line => `        ${gray}${line.trim()}${reset}`)
      .join('\n');
    if (stackFrames) {
      process.stderr.write(`${stackFrames}\n`);
    }
  }
}

/**
 * Centralized Production-Grade Logger
 */
export const logger = {
  LogLevel,
  getLevel: () => currentLogLevel,
  setLevel: (level) => {
    if (typeof level === 'string') {
      const parsed = LogLevel[level.toUpperCase()];
      if (parsed !== undefined) currentLogLevel = parsed;
    } else if (typeof level === 'number') {
      currentLogLevel = level;
    }
  },
  debug: (module, message, context) => writeLog(LogLevel.DEBUG, module, message, context),
  info: (module, message, context) => writeLog(LogLevel.INFO, module, message, context),
  warn: (module, message, context) => writeLog(LogLevel.WARN, module, message, context),
  error: (module, message, context, error) => {
    if (context instanceof Error && !error) {
      writeLog(LogLevel.ERROR, module, message, null, context);
    } else {
      writeLog(LogLevel.ERROR, module, message, context, error);
    }
  },
  fatal: (module, message, context, error) => {
    if (context instanceof Error && !error) {
      writeLog(LogLevel.FATAL, module, message, null, context);
    } else {
      writeLog(LogLevel.FATAL, module, message, context, error);
    }
  }
};

/**
 * Auto-heals stale or deleted log channels by pruning the configuration key from the database and cache.
 */
async function pruneStaleLogChannel(guildId, configKey, channelId) {
  if (!guildId) return;
  logChannelCache.delete(guildId);
  if (!configKey) return;

  try {
    const pool = getPool();
    if (pool) {
      await pool.query(
        `UPDATE guild_configs 
         SET config = config - $1 
         WHERE guild_id = $2`,
        [configKey, guildId]
      ).catch(() => {});
      logger.info('CONFIG', 'Auto-healed deleted log channel from config', {
        guildId,
        configKey,
        channelId
      });
    }
  } catch (err) {
    logger.error('CONFIG', 'Failed to prune stale log channel', { guildId, configKey }, err);
  }
}

/**
 * Fallback dispatcher to ensure critical audit logs are delivered to guild.systemChannel if configured channel is dead.
 */
async function fallbackDispatch(guild, embed, excludeChannelId) {
  if (!guild || !embed) return;
  try {
    const systemChannel = guild.systemChannel;
    if (systemChannel && systemChannel.id !== excludeChannelId) {
      const me = guild.members?.me;
      if (me) {
        const perms = systemChannel.permissionsFor(me);
        if (perms && perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
          await systemChannel.send({ embeds: [embed] }).catch(() => {});
        }
      }
    }
  } catch (_) {}
}

/**
 * Failsafe wrapper to send messages only if channel is accessible.
 * Automatically cleans up broken configs and falls back to system channel.
 */
async function safeSend(guild, channelId, embed, configKey) {
  if (!guild || !channelId) return;

  try {
    const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);

    if (!channel) {
      await pruneStaleLogChannel(guild.id, configKey, channelId);
      await fallbackDispatch(guild, embed, channelId);
      return;
    }

    const permissions = channel.permissionsFor(guild.members.me);
    if (!permissions || !permissions.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
      logger.warn('VERIFY', 'Channel permission missing for log dispatch', {
        guildId: guild.id,
        channelId,
        detail: `Missing ViewChannel or SendMessages for ${configKey || 'log channel'}`
      });
      await fallbackDispatch(guild, embed, channelId);
      return;
    }

    if (!permissions.has(PermissionFlagsBits.EmbedLinks)) {
      logger.warn('VERIFY', 'Channel permission missing: EmbedLinks', {
        guildId: guild.id,
        channelId,
        detail: `Cannot post embeds to ${configKey || 'log channel'}`
      });
      await fallbackDispatch(guild, embed, channelId);
      return;
    }

    await channel.send({ embeds: [embed] }).catch(async (err) => {
      if (err?.code === 10003 || err?.code === 50001) {
        await pruneStaleLogChannel(guild.id, configKey, channelId);
        await fallbackDispatch(guild, embed, channelId);
      } else {
        logger.error('DISCORD-REST', 'safeSend Failure', { guildId: guild.id, channelId }, err);
      }
    });
  } catch (err) {
    if (err?.code === 10003 || err?.code === 50001) {
      await pruneStaleLogChannel(guild.id, configKey, channelId);
      await fallbackDispatch(guild, embed, channelId);
    } else {
      logger.error('DISCORD-REST', 'safeSend Critical', { guildId: guild.id, channelId }, err);
    }
  }
}

/**
 * Proactive permission check for settings validation
 */
export function checkChannelPermissions(channel, extraPermissions = []) {
  if (!channel) return { valid: false, error: 'Channel not found.' };
  const me = channel.guild?.members?.me || channel.client?.user;
  if (!me) return { valid: true };
  const permissions = channel.permissionsFor(me);
  if (!permissions) {
    return { valid: false, error: 'Cannot check channel permissions.', missing: ['View Channel'] };
  }

  const required = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    ...extraPermissions
  ];

  const missingFlags = required.filter(flag => !permissions.has(flag));
  if (missingFlags.length > 0) {
    const flagNames = {
      [PermissionFlagsBits.ViewChannel]: 'View Channel',
      [PermissionFlagsBits.SendMessages]: 'Send Messages',
      [PermissionFlagsBits.EmbedLinks]: 'Embed Links',
      [PermissionFlagsBits.AttachFiles]: 'Attach Files',
      [PermissionFlagsBits.ReadMessageHistory]: 'Read Message History',
      [PermissionFlagsBits.ManageMessages]: 'Manage Messages'
    };
    const missingNames = missingFlags.map(f => flagNames[f] || String(f));
    return {
      valid: false,
      error: `I need ${missingNames.map(n => `"${n}"`).join(', ')} permissions there.`,
      missing: missingNames
    };
  }
  return { valid: true };
}

/**
 * Required permissions specifically for visual leaderboard channels
 */
export function checkLeaderboardPermissions(channel) {
  return checkChannelPermissions(channel, [
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.ReadMessageHistory
  ]);
}

/**
 * Enhanced logging function for server/guild events with categorized routing (Discord In-Server Audit)
 */
export async function sendLog(guild, category, colorKey, title, description) {
  if (!guild || !guild.id) return;

  // Terminal logging
  logger.info(category.toUpperCase(), title, {
    guildId: guild.id,
    detail: description ? stripLog(description) : undefined
  });

  try {
    const pool = getPool();
    if (!pool) return;

    let config = logChannelCache.get(guild.id);
    if (!config) {
      const res = await pool.query('SELECT config FROM guild_configs WHERE guild_id = $1', [guild.id]);
      config = res.rows[0]?.config || {};
      if (logChannelCache.size >= LOG_CACHE_MAX_SIZE) logChannelCache.clear();
      logChannelCache.set(guild.id, config);
      setTimeout(() => logChannelCache.delete(guild.id), 60000);
    }

    const categoryMap = {
      economy: 'log_eco_channel_id',
      inventory: 'log_inv_channel_id',
      shop: 'log_shop_channel_id',
      audit: 'log_audit_channel_id',
      system: 'log_audit_channel_id'
    };

    const configKey = categoryMap[category.toLowerCase()];
    let channelId = config[configKey];

    if (!channelId && configKey !== 'log_audit_channel_id') {
      channelId = config['log_audit_channel_id'];
    }

    if (channelId) {
      const colors = {
        green: 0x2ECC71,
        red: 0xE74C3C,
        blue: 0x3498DB,
        gold: 0xF1C40F,
        orange: 0xE67E22,
        purple: 0x9B59B6,
        cyan: 0x1ABC9C,
        grey: 0x95A5A6,
        crimson: 0xC0392B
      };

      const embed = new EmbedBuilder()
        .setTitle(title)
        .setColor(colors[colorKey] || colors.blue)
        .setFooter({
          text: `${guild.name || 'Server'} • ${new Date().toLocaleString()}`,
          iconURL: typeof guild.iconURL === 'function' ? guild.iconURL() : null
        });

      if (description && typeof description === 'string' && description.trim() !== '') {
        embed.setDescription(description);
      }

      await safeSend(guild, channelId, embed, configKey);
    }
  } catch (err) {
    logger.error('DISCORD-AUDIT', 'Logging failure in sendLog', { guildId: guild.id }, err);
  }
}

/**
 * Mass action logger - summarizes bulk events into a single entry
 */
export async function sendBulkLog(guild, category, colorKey, title, description) {
  return sendLog(guild, category, colorKey, `🛡️ Mass Action: ${title}`, description);
}

/**
 * Utility to format a readable "Difference" between two objects for logs
 */
export function formatDiff(oldData, newData, exclude = []) {
  const changes = [];
  const keys = new Set([...Object.keys(oldData), ...Object.keys(newData)]);

  for (const key of keys) {
    if (key === 'updated_at' || key === 'created_at' || exclude.includes(key)) continue;

    const oldVal = oldData[key];
    const newVal = newData[key];

    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      const label = key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      changes.push(`• **${label}:** \`${oldVal ?? 'None'}\` ➡️ \`${newVal ?? 'None'}\``);
    }
  }

  return changes.length > 0 ? changes.join('\n') : null;
}

export async function logServerEvent(guild, username, event) {
  return sendLog(guild, 'audit', 'blue', 'Audit Event', event);
}

export function logServerError(guild, username, error) {
  logger.error('SERVER', 'Server Error', { guildId: guild?.id || guild, username }, error);
}

export function logSystemEvent(event, detail = null) {
  logger.info('SYSTEM', event, { detail });
}

export function logSystemError(error, action = 'System Error') {
  logger.error('SYSTEM', action, null, error);
}

export const LOG_TAGS = {
  STARTUP: 'STARTUP',
  DATABASE: 'DATABASE',
  SERVER: 'SERVER',
  COMMAND: 'COMMAND',
  DISPATCH: 'DISPATCH',
  COMPONENT: 'COMPONENT',
  MODAL: 'MODAL',
  ECONOMY: 'ECONOMY',
  SHOP: 'SHOP',
  TRADE: 'TRADE',
  LOOTBOX: 'LOOTBOX',
  LEVEL: 'LEVEL',
  QUEST: 'QUEST',
  VOICE: 'VOICE',
  CHAT: 'CHAT',
  RENDER: 'RENDER',
  VERIFY: 'VERIFY',
  SELF_HEALING: 'SELF-HEALING',
  AUDIT: 'AUDIT',
  CRON: 'CRON',
  SECURITY: 'SECURITY',
  CONFIG: 'CONFIG',
  EVENT: 'EVENT',
  WARN: 'WARN',
  ERROR: 'ERROR',
  FATAL: 'FATAL'
};

function resolveTag(action, explicitTag) {
  if (explicitTag && typeof explicitTag === 'string') {
    const clean = explicitTag.toUpperCase().replace(/[\s_]+/g, '-');
    if (Object.values(LOG_TAGS).includes(clean)) return clean;
  }
  if (!action || typeof action !== 'string') return 'SERVER';

  const lower = action.toLowerCase();
  if (lower.startsWith('phase:') || lower.includes('client ready') || lower.includes('client authenticat') || lower.includes('starting bot') || lower.includes('startup') || lower.includes('dependencies ready')) {
    return 'STARTUP';
  }
  if (lower.includes('database') || lower.includes('pool') || lower.includes('postgres') || lower.includes('migration') || lower.includes('schema') || lower.includes('query')) {
    return 'DATABASE';
  }
  if (lower.includes('user level audit') || lower.includes('user level inactive') || lower.includes('inventory in-sync') || lower.includes('verified') || lower.includes('audit complete')) {
    return 'AUDIT';
  }
  if (lower.startsWith('self-healing') || lower.includes('reconciled') || lower.includes('rollback') || lower.includes('healed')) {
    return 'SELF-HEALING';
  }
  if (lower.includes('trade')) {
    return 'TRADE';
  }
  if (lower.includes('shop') || lower.includes('inventory') || lower.includes('item purchase') || lower.includes('stock')) {
    return 'SHOP';
  }
  if (lower.includes('lootbox') || lower.includes('chest') || lower.includes('box opened') || lower.includes('drop')) {
    return 'LOOTBOX';
  }
  if (lower.includes('level') || lower.includes('battlepass') || lower.includes('xp') || lower.includes('progression')) {
    return 'LEVEL';
  }
  if (lower.includes('quest') || lower.includes('mission')) {
    return 'QUEST';
  }
  if (lower.includes('voice')) {
    return 'VOICE';
  }
  if (lower.includes('chat') || lower.includes('message point')) {
    return 'CHAT';
  }
  if (lower.includes('render') || lower.includes('profile card') || lower.includes('trade card')) {
    return 'RENDER';
  }
  if (lower.includes('command') || lower.includes('interaction') || lower.startsWith('/')) {
    return 'DISPATCH';
  }
  if (lower.includes('verify') || lower.includes('permission') || lower.includes('validate') || lower.includes('check')) {
    return 'VERIFY';
  }
  if (lower.includes('cron') || lower.includes('scheduler') || lower.includes('midnight') || lower.includes('streak reset') || lower.includes('restock')) {
    return 'CRON';
  }
  if (lower.includes('security') || lower.includes('cooldown') || lower.includes('cheat') || lower.includes('unauthorized') || lower.includes('rate limit')) {
    return 'SECURITY';
  }
  if (lower.includes('config') || lower.includes('setting')) {
    return 'CONFIG';
  }
  if (lower.includes('warn') || lower.includes('warning') || lower.includes('fallback') || lower.includes('anomaly')) {
    return 'WARN';
  }
  if (lower.includes('economy') || lower.includes('coin') || lower.includes('balance') || lower.includes('transfer')) {
    return 'ECONOMY';
  }
  return 'SERVER';
}

function cleanActionTitle(action) {
  if (!action || typeof action !== 'string') return '';
  return stripLog(action)
    .replace(/^(\[[A-Za-z0-9_\-\s:]+\]\s*)+/g, '')
    .replace(/^(Self-Healing:\s*)/i, '')
    .replace(/^(Phase:\s*)/i, '')
    .replace(/^(ECONOMY Event\s*)/i, 'Economy Event')
    .trim();
}

function extractLegacyContext(ctx) {
  if (!ctx || typeof ctx !== 'object') return {};
  const normalized = {};

  if (ctx.user) normalized.userId = ctx.user?.id || ctx.user;
  if (ctx.guild && ctx.guild !== 'Global') normalized.guildId = ctx.guild?.id || ctx.guild;
  if (ctx.target) normalized.targetId = ctx.target?.id || ctx.target;
  if (ctx.role) normalized.roleId = ctx.role?.id || ctx.role;
  if (ctx.item) normalized.itemId = ctx.item?.id || ctx.item;
  if (ctx.channel) normalized.channelId = ctx.channel?.id || ctx.channel;
  if (ctx.amount !== undefined) normalized.amount = ctx.amount;
  if (ctx.duration !== undefined) normalized.durationMs = ctx.duration;
  if (ctx.durationMs !== undefined) normalized.durationMs = ctx.durationMs;
  if (ctx.latency !== undefined) normalized.latencyMs = ctx.latency;
  if (ctx.detail) normalized.detail = stripLog(ctx.detail);

  for (const [k, v] of Object.entries(ctx)) {
    if (['user', 'guild', 'target', 'role', 'item', 'channel', 'amount', 'duration', 'durationMs', 'latency', 'detail', 'tag'].includes(k)) continue;
    normalized[k] = v;
  }

  return normalized;
}

/**
 * Backward-compatible sysLog adapter
 */
export function sysLog(action, ctx = {}) {
  const tag = resolveTag(action, ctx?.tag);
  const cleanAction = cleanActionTitle(action);
  const context = extractLegacyContext(ctx);
  logger.info(tag, cleanAction, Object.keys(context).length > 0 ? context : null);
}

/**
 * Backward-compatible sysWarn adapter
 */
export function sysWarn(action, ctx = {}) {
  const cleanAction = cleanActionTitle(action);
  const tag = resolveTag(action, 'WARN');
  const context = extractLegacyContext(ctx);
  logger.warn(tag === 'WARN' ? 'SYSTEM' : tag, cleanAction, Object.keys(context).length > 0 ? context : null);
}

/**
 * Backward-compatible sysError adapter
 */
export function sysError(action, error, ctx = {}) {
  const cleanAction = cleanActionTitle(action);
  const tag = resolveTag(action, 'ERROR');
  const context = extractLegacyContext(ctx);
  logger.error(tag === 'ERROR' ? 'SYSTEM' : tag, cleanAction, Object.keys(context).length > 0 ? context : null, error);
}

/**
 * High-level category-specific log helper
 */
export const log = {
  startup: (action, ctx) => logger.info('STARTUP', cleanActionTitle(action), extractLegacyContext(ctx)),
  database: (action, ctx) => logger.info('DATABASE', cleanActionTitle(action), extractLegacyContext(ctx)),
  server: (action, ctx) => logger.info('SERVER', cleanActionTitle(action), extractLegacyContext(ctx)),
  command: (action, ctx) => logger.info('DISPATCH', cleanActionTitle(action), extractLegacyContext(ctx)),
  economy: (action, ctx) => logger.info('ECONOMY', cleanActionTitle(action), extractLegacyContext(ctx)),
  shop: (action, ctx) => logger.info('SHOP', cleanActionTitle(action), extractLegacyContext(ctx)),
  trade: (action, ctx) => logger.info('TRADE', cleanActionTitle(action), extractLegacyContext(ctx)),
  lootbox: (action, ctx) => logger.info('LOOTBOX', cleanActionTitle(action), extractLegacyContext(ctx)),
  level: (action, ctx) => logger.info('LEVEL', cleanActionTitle(action), extractLegacyContext(ctx)),
  quest: (action, ctx) => logger.info('QUEST', cleanActionTitle(action), extractLegacyContext(ctx)),
  voice: (action, ctx) => logger.info('VOICE', cleanActionTitle(action), extractLegacyContext(ctx)),
  chat: (action, ctx) => logger.info('CHAT', cleanActionTitle(action), extractLegacyContext(ctx)),
  render: (action, ctx) => logger.info('RENDER', cleanActionTitle(action), extractLegacyContext(ctx)),
  verify: (action, ctx) => logger.info('VERIFY', cleanActionTitle(action), extractLegacyContext(ctx)),
  selfHealing: (action, ctx) => logger.info('SELF-HEALING', cleanActionTitle(action), extractLegacyContext(ctx)),
  audit: (action, ctx) => logger.info('AUDIT', cleanActionTitle(action), extractLegacyContext(ctx)),
  cron: (action, ctx) => logger.info('CRON', cleanActionTitle(action), extractLegacyContext(ctx)),
  security: (action, ctx) => logger.warn('SECURITY', cleanActionTitle(action), extractLegacyContext(ctx)),
  config: (action, ctx) => logger.info('CONFIG', cleanActionTitle(action), extractLegacyContext(ctx)),
  warn: (action, ctx) => sysWarn(action, ctx),
  error: (action, err, ctx) => sysError(action, err, ctx)
};
