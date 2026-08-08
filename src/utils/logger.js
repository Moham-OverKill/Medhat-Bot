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
        if (!permissions || !permissions.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) return;

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
    const permissions = channel.permissionsFor(channel.guild.members.me);
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

/**
 * Core logging utility for the "God-Mode" Audit System.
 * Enforces NO-PREFIX and ID-ONLY standards for console logs.
 */
export function sysLog(action, { user, guild, target, role, item, channel, message, detail } = {}) {
    const userId = user?.id || user || 'System';
    const guildId = guild?.id || (guild && guild !== 'Global' ? guild : 'Global');
    
    const cleanAction = stripLog(action);
    const parts = [`${cleanAction}`, `User: ${userId}`, `Guild: ${guildId}`];
    
    if (target) parts.push(`Target: ${target?.id || target}`);
    if (role) parts.push(`Role: ${role?.id || role}`);
    if (item) parts.push(`Item: ${item?.id || item}`);
    if (channel) parts.push(`Channel: ${channel?.id || channel}`);
    if (message) parts.push(`Message: ${message?.id || message}`);
    if (detail) parts.push(`Detail: ${stripLog(detail)}`);
    
    console.log(parts.join(' | '));
}

export function sysError(action, error, { user, guild, target, role, item, channel, message } = {}) {
    const userId = user?.id || user || 'System';
    const guildId = guild?.id || (guild && guild !== 'Global' ? guild : 'Global');
    const errorMessage = error?.message || error || 'Unknown Error';
    
    const parts = [`${stripLog(action)}`, `User: ${userId}`, `Guild: ${guildId}`];
    if (target) parts.push(`Target: ${target?.id || target}`);
    if (role) parts.push(`Role: ${role?.id || role}`);
    if (item) parts.push(`Item: ${item?.id || item}`);
    if (channel) parts.push(`Channel: ${channel?.id || channel}`);
    if (message) parts.push(`Message: ${message?.id || message}`);
    parts.push(`Error: ${stripLog(errorMessage)}`);
    
    console.error(parts.join(' | '));
}
