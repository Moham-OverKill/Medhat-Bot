import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { getPool } from '../storage/postgres.js';
import { stripLog } from '../shared.js';

// Cache log channel IDs to avoid DB hits on every log (1 min cache, max 500 entries)
const logChannelCache = new Map();
const LOG_CACHE_MAX_SIZE = 500;


/**
 * Failsafe wrapper to send messages only if channel is accessible.
 * Automatically cleans up broken configs.
 */
async function safeSend(guild, channelId, embed, configKey) {
    if (!guild || !channelId) return;

    try {
        const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
        
        if (!channel) return;

        const permissions = channel.permissionsFor(guild.members.me);
        if (!permissions || !permissions.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
            sysWarn('Channel Permission Missing for Log Dispatch', {
                guild,
                channel: channelId,
                detail: `Missing ViewChannel or SendMessages for ${configKey || 'log channel'}`
            });
            return;
        }

        if (!permissions.has(PermissionFlagsBits.EmbedLinks)) {
            sysWarn('Channel Permission Missing: EmbedLinks', {
                guild,
                channel: channelId,
                detail: `Cannot post embeds to ${configKey || 'log channel'}`
            });
            return;
        }

        await channel.send({ embeds: [embed] }).catch(err => {
            sysError('safeSend Failure', err, { guild });
        });
    } catch (err) {
        sysError('safeSend Critical', err, { guild });
    }
}

/**
 * Proactive permission check for settings validation
 */
export function checkChannelPermissions(channel) {
    if (!channel) return { valid: false, error: 'Channel not found.' };
    const me = channel.guild?.members?.me || channel.client?.user;
    if (!me) return { valid: true };
    const permissions = channel.permissionsFor(me);
    if (!permissions || !permissions.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
        return { valid: false, error: 'I need "View Channel", "Send Messages", and "Embed Links" permissions there.' };
    }
    return { valid: true };
}

/**
 * Enhanced logging function for server/guild events with categorized routing
 */
export async function sendLog(guild, category, colorKey, title, description) {
    if (!guild || !guild.id) return;
    
    // Console logging via God-Mode System (ID Only / No Prefix)
    sysLog(`${category.toUpperCase()} Event`, { 
        guild, 
        detail: `${title}${description ? `: ${description}` : ''}` 
    });

    try {
        const pool = getPool();
        if (!pool) return;

        // Cache lookup or DB fetch
        let config = logChannelCache.get(guild.id);
        if (!config) {
            const res = await pool.query('SELECT config FROM guild_configs WHERE guild_id = $1', [guild.id]);
            config = res.rows[0]?.config || {};
            // P-06 FIX: Prevent unbounded cache growth
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

        // Fallback: If specific channel is missing, try the main Audit channel
        if (!channelId && configKey !== 'log_audit_channel_id') {
            channelId = config['log_audit_channel_id'];
        }

        if (channelId) {
            const colors = {
                green: 0x2ECC71,    // Success / Purchase
                red: 0xE74C3C,      // Failure / Delete
                blue: 0x3498DB,     // Info / Move
                gold: 0xF1C40F,     // MVP / Quest
                orange: 0xE67E22,   // Rewards / Claims
                purple: 0x9B59B6,   // Trades / P2P
                cyan: 0x1ABC9C,     // Config / Settings
                grey: 0x95A5A6,     // System
                crimson: 0xC0392B   // Auto-Removal
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
        sysError('Logging failure', err, { guild });
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

// Legacy helpers (wrapped for compatibility)
export async function logServerEvent(guild, username, event) {
    return sendLog(guild, 'audit', 'blue', 'Audit Event', event);
}

export function logServerError(guild, username, error) {
    sysError('Server Error', error, { guild });
}

export function logSystemEvent(event, detail = null) {
    sysLog(event, { detail });
}

export function logSystemError(error, action = 'System Error') {
    sysError(action, error);
}

export const LOG_TAGS = {
    STARTUP: 'STARTUP',
    DATABASE: 'DATABASE',
    SERVER: 'SERVER',
    COMMAND: 'COMMAND',
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
    WARN: 'WARN',
    ERROR: 'ERROR'
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
    if (lower.includes('database') || lower.includes('pool') || lower.includes('postgres') || lower.includes('migration') || lower.includes('schema')) {
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
        return 'COMMAND';
    }
    if (lower.includes('verify') || lower.includes('permission') || lower.includes('validate') || lower.includes('check')) {
        return 'VERIFY';
    }
    if (lower.includes('cron') || lower.includes('scheduler') || lower.includes('midnight') || lower.includes('streak reset')) {
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
        .replace(/^\[[A-Z0-9_\-\s]+\]\s*/i, '') // Remove existing brackets
        .replace(/^(Self-Healing:\s*)/i, '')
        .replace(/^(Phase:\s*)/i, '')
        .replace(/^\[CLEAN\]\s*/i, '')
        .replace(/^(ECONOMY Event\s*)/i, 'Economy Event')
        .trim();
}

/**
 * Unified single-tag console logger
 */
export function sysLog(action, { user, guild, target, role, item, channel, message, detail, tag: explicitTag, duration, latency, amount } = {}) {
    const userId = user?.id || user || 'System';
    const guildId = guild?.id || (guild && guild !== 'Global' ? guild : 'Global');
    
    const tag = resolveTag(action, explicitTag);
    const cleanAction = cleanActionTitle(action);
    const parts = [`[${tag}] ${cleanAction}`, `User: ${userId}`, `Guild: ${guildId}`];
    
    if (target) parts.push(`Target: ${target?.id || target}`);
    if (role) parts.push(`Role: ${role?.id || role}`);
    if (item) parts.push(`Item: ${item?.id || item}`);
    if (channel) parts.push(`Channel: ${channel?.id || channel}`);
    if (amount !== undefined) parts.push(`Amount: ${amount}`);
    if (duration !== undefined) parts.push(`Duration: ${duration}ms`);
    if (latency !== undefined) parts.push(`Latency: ${latency}ms`);
    if (message) parts.push(`Message: ${message?.id || message}`);
    if (detail) parts.push(`Detail: ${stripLog(detail)}`);
    
    console.log(parts.join(' | '));
}

/**
 * Unified single-tag warning logger
 */
export function sysWarn(action, { user, guild, target, role, item, channel, message, detail, duration, latency, amount } = {}) {
    const userId = user?.id || user || 'System';
    const guildId = guild?.id || (guild && guild !== 'Global' ? guild : 'Global');
    
    const cleanAction = cleanActionTitle(action);
    const parts = [`[WARN] ${cleanAction}`, `User: ${userId}`, `Guild: ${guildId}`];
    
    if (target) parts.push(`Target: ${target?.id || target}`);
    if (role) parts.push(`Role: ${role?.id || role}`);
    if (item) parts.push(`Item: ${item?.id || item}`);
    if (channel) parts.push(`Channel: ${channel?.id || channel}`);
    if (amount !== undefined) parts.push(`Amount: ${amount}`);
    if (duration !== undefined) parts.push(`Duration: ${duration}ms`);
    if (latency !== undefined) parts.push(`Latency: ${latency}ms`);
    if (message) parts.push(`Message: ${message?.id || message}`);
    if (detail) parts.push(`Detail: ${stripLog(detail)}`);
    
    console.warn(parts.join(' | '));
}

/**
 * Unified single-tag error logger with indented stack traces
 */
export function sysError(action, error, { user, guild, target, role, item, channel, message, detail, duration } = {}) {
    const userId = user?.id || user || 'System';
    const guildId = guild?.id || (guild && guild !== 'Global' ? guild : 'Global');
    const errorMessage = error?.message || error || 'Unknown Error';
    
    const cleanAction = cleanActionTitle(action);
    const parts = [`[ERROR] ${cleanAction}`, `User: ${userId}`, `Guild: ${guildId}`];
    if (target) parts.push(`Target: ${target?.id || target}`);
    if (role) parts.push(`Role: ${role?.id || role}`);
    if (item) parts.push(`Item: ${item?.id || item}`);
    if (channel) parts.push(`Channel: ${channel?.id || channel}`);
    if (duration !== undefined) parts.push(`Duration: ${duration}ms`);
    if (message) parts.push(`Message: ${message?.id || message}`);
    if (detail) parts.push(`Detail: ${stripLog(detail)}`);
    parts.push(`Error: ${stripLog(errorMessage)}`);
    
    console.error(parts.join(' | '));

    if (error?.stack) {
        const stackFrames = error.stack
            .split('\n')
            .slice(1, 4)
            .map(line => '        ' + line.trim())
            .join('\n');
        if (stackFrames) {
            console.error(stackFrames);
        }
    }
}

/**
 * High-level category-specific log helper
 */
export const log = {
    startup: (action, ctx) => sysLog(action, { ...ctx, tag: 'STARTUP' }),
    database: (action, ctx) => sysLog(action, { ...ctx, tag: 'DATABASE' }),
    server: (action, ctx) => sysLog(action, { ...ctx, tag: 'SERVER' }),
    command: (action, ctx) => sysLog(action, { ...ctx, tag: 'COMMAND' }),
    economy: (action, ctx) => sysLog(action, { ...ctx, tag: 'ECONOMY' }),
    shop: (action, ctx) => sysLog(action, { ...ctx, tag: 'SHOP' }),
    trade: (action, ctx) => sysLog(action, { ...ctx, tag: 'TRADE' }),
    lootbox: (action, ctx) => sysLog(action, { ...ctx, tag: 'LOOTBOX' }),
    level: (action, ctx) => sysLog(action, { ...ctx, tag: 'LEVEL' }),
    quest: (action, ctx) => sysLog(action, { ...ctx, tag: 'QUEST' }),
    voice: (action, ctx) => sysLog(action, { ...ctx, tag: 'VOICE' }),
    chat: (action, ctx) => sysLog(action, { ...ctx, tag: 'CHAT' }),
    render: (action, ctx) => sysLog(action, { ...ctx, tag: 'RENDER' }),
    verify: (action, ctx) => sysLog(action, { ...ctx, tag: 'VERIFY' }),
    selfHealing: (action, ctx) => sysLog(action, { ...ctx, tag: 'SELF-HEALING' }),
    audit: (action, ctx) => sysLog(action, { ...ctx, tag: 'AUDIT' }),
    cron: (action, ctx) => sysLog(action, { ...ctx, tag: 'CRON' }),
    security: (action, ctx) => sysLog(action, { ...ctx, tag: 'SECURITY' }),
    config: (action, ctx) => sysLog(action, { ...ctx, tag: 'CONFIG' }),
    warn: (action, ctx) => sysWarn(action, ctx),
    error: (action, err, ctx) => sysError(action, err, ctx)
};
