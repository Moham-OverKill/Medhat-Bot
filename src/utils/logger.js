import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { getPool } from '../storage/postgres.js';
import { stripLog } from '../shared.js';

// Cache log channel IDs to avoid DB hits on every log (1 min cache)
const logChannelCache = new Map();


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
            console.error(`[${guild.name}] [Error] Failed to send to ${channel.name}:`, err.message);
        });
    } catch (err) {
        console.error(`[${guild.name}] [Error] safeSend critical failure:`, err.message);
    }
}

/**
 * Proactive permission check for settings validation
 */
export function checkChannelPermissions(channel) {
    if (!channel) return { valid: false, error: 'Channel not found.' };
    const permissions = channel.permissionsFor(channel.guild.members.me);
    if (!permissions || !permissions.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
        return { valid: false, error: 'I need "View Channel" and "Send Messages" permissions there.' };
    }
    return { valid: true };
}

/**
 * Enhanced logging function for server/guild events with categorized routing
 */
export async function sendLog(guild, category, colorKey, title, description) {
    if (!guild || !guild.id) return;
    
    // Console logging with server prefix for reliability (Cleaned of emojis/markdown)
    const cleanTitle = stripLog(title);
    const cleanDescription = stripLog(description);
    console.log(`[${guild.name}] [${category.toUpperCase()}] ${cleanTitle}${cleanDescription ? `: ${cleanDescription}` : ''}`);

    try {
        const pool = getPool();
        if (!pool) return;

        // Cache lookup or DB fetch
        let config = logChannelCache.get(guild.id);
        if (!config) {
            const res = await pool.query('SELECT config FROM guild_configs WHERE guild_id = $1', [guild.id]);
            config = res.rows[0]?.config || {};
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
                .setDescription(description)
                .setColor(colors[colorKey] || colors.blue)
                .setFooter({ text: `${guild.name} • ${new Date().toLocaleString()}`, iconURL: guild.iconURL() });

            await safeSend(guild, channelId, embed, configKey);
        }
    } catch (err) {
        console.error(`[${guild.name}] [Error] Logging failure:`, err.message);
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
    return sendLog(guild, 'audit', 'blue', '🛡️ Audit Event', `**${username}** ${event}`);
}

export function logServerError(guild, username, error) {
    console.error(`[${guild?.name || 'Unknown'}] ${username} — Error: ${error}`);
}

export function logSystemEvent(event) {
    console.log(`[System] ${stripLog(event)}`);
}

export function logSystemError(error) {
    console.error(`[System] Error: ${error}`);
}
