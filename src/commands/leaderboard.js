import {
    SlashCommandBuilder,
    MessageFlags,
    EmbedBuilder,
    PermissionFlagsBits,
    ChannelType
} from 'discord.js';
import { getPool } from '../storage/postgres.js';
import { sanitizeError, getUserDisplayName, getUserLogName, COIN_EMOJI } from '../shared.js';
import { sendLog, sysError } from '../utils/logger.js';

// Define the /leaderboard command
export const data = new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Leaderboard management commands')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(subcommand =>
        subcommand
            .setName('setup')
            .setDescription('Configure leaderboard channels')
            .addChannelOption(option =>
                option
                    .setName('daily_activity_channel')
                    .setDescription('Channel for daily MVP activity leaderboard')
                    .setRequired(true)
                    .addChannelTypes(ChannelType.GuildText)
            )
            .addChannelOption(option =>
                option
                    .setName('total_coins_channel')
                    .setDescription('Channel for all-time richest members leaderboard')
                    .setRequired(true)
                    .addChannelTypes(ChannelType.GuildText)
            )
            .addChannelOption(option =>
                option
                    .setName('highest_streak_channel')
                    .setDescription('Channel for highest daily claim streak leaderboard')
                    .setRequired(true)
                    .addChannelTypes(ChannelType.GuildText)
            )
            .addChannelOption(option =>
                option
                    .setName('highest_level_channel')
                    .setDescription('Channel for highest level and XP leaderboard')
                    .setRequired(false)
                    .addChannelTypes(ChannelType.GuildText)
            )
    )
    .addSubcommand(subcommand =>
        subcommand
            .setName('status')
            .setDescription('View current leaderboard configuration')
    );

/**
 * Get leaderboard config from database
 */
export async function getLeaderboardConfig(guildId) {
    const pool = getPool();
    const result = await pool.query(
        'SELECT * FROM leaderboard_config WHERE guild_id = $1',
        [guildId]
    );
    return result.rows[0] || null;
}

/**
 * Save leaderboard config to database
 */
export async function setLeaderboardConfig(guildId, config) {
    const pool = getPool();
    await pool.query(`
    INSERT INTO leaderboard_config (
      guild_id, 
      daily_channel_id, daily_message_id,
      coins_channel_id, coins_message_id,
      streak_channel_id, streak_message_id,
      level_channel_id, level_message_id,
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)
    ON CONFLICT (guild_id) DO UPDATE SET
      daily_channel_id = EXCLUDED.daily_channel_id,
      daily_message_id = EXCLUDED.daily_message_id,
      coins_channel_id = EXCLUDED.coins_channel_id,
      coins_message_id = EXCLUDED.coins_message_id,
      streak_channel_id = EXCLUDED.streak_channel_id,
      streak_message_id = EXCLUDED.streak_message_id,
      level_channel_id = EXCLUDED.level_channel_id,
      level_message_id = EXCLUDED.level_message_id,
      updated_at = CURRENT_TIMESTAMP
  `, [
        guildId,
        config.daily_channel_id, config.daily_message_id,
        config.coins_channel_id, config.coins_message_id,
        config.streak_channel_id, config.streak_message_id,
        config.level_channel_id, config.level_message_id
    ]);
}

/**
 * Helper to fetch usernames for leaderboard data
 * Resolves user IDs to display names (or username) for clean text rendering
 */
async function enrichUserData(client, guildId, data, userIdKey = 'user_id') {
    if (!data || data.length === 0) return [];

    // Safety check: slice to 50 just in case query returned more
    const slicedData = data.slice(0, 50);
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return slicedData.map(d => ({ ...d, displayName: d.username || 'Unknown' }));

    // Warm up member cache in bulk
    await guild.members.fetch().catch(() => null);

    const enriched = await Promise.all(slicedData.map(async (item) => {
        const uid = item[userIdKey] || item.userId;
        let name = item.username || 'Unknown';
        try {
            const member = guild.members.cache.get(uid) || await guild.members.fetch(uid).catch(() => null);
            if (member) {
                name = member.displayName;
            } else {
                const user = await client.users.fetch(uid).catch(() => null);
                name = user?.username || item.username || 'Unknown User';
            }
        } catch {
            name = item.username || 'Unknown User';
        }
        // Sanitize name: collapse multiple spaces into one and trim
        const sanitizedName = name.replace(/\s\s+/g, ' ').trim();
        return { ...item, displayName: sanitizedName, userId: uid };
    }));

    return enriched;
}

/**
 * Format a number compactly (1.5k, 2.3M, etc.)
 */
function formatCompactNumber(num) {
    if (num >= 1_000_000_000_000) {
        return (num / 1_000_000_000_000).toFixed(1).replace(/\.0$/, '') + 'T';
    } else if (num >= 1_000_000_000) {
        return (num / 1_000_000_000).toFixed(1).replace(/\.0$/, '') + 'B';
    } else if (num >= 1_000_000) {
        return (num / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
    } else if (num >= 1_000) {
        return (num / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
    }
    return String(num);
}

/**
 * Truncate a name to max length with ellipsis
 */
function truncateName(name, maxLen = 20) {
    if (!name) return 'Unknown';
    const limit = Math.max(4, maxLen);
    if (name.length <= limit) return name;
    return name.substring(0, limit - 3) + '...';
}

// ============================================
// GLOBAL LEADERBOARD SETTINGS
const MOBILE_MAX_LINE_LENGTH = 34; // Strict limit to prevent mobile wrapping

/**
 * Build a compact, mobile-optimized leaderboard table
 */
function buildLeaderboardTable(data, valueKey, unitLabel, mvpRecipients = [], useCompact = true) {
    if (!data || data.length === 0) return null;

    // 1. Format Values & Calculate Dynamic Widths
    let maxValueWidth = 0;
    const formattedRows = data.map(item => {
        const val = Number(item[valueKey]) || 0;
        const valStr = useCompact ? formatCompactNumber(val) : String(val);
        const fullValStr = `${valStr}${unitLabel}`; // Tight value+unit (e.g. 200$)
        if (fullValStr.length > maxValueWidth) maxValueWidth = fullValStr.length;
        return { ...item, fullValStr };
    });

    // 2. Build rows with mobile-optimized widths
    const lines = [];
    formattedRows.forEach((row, index) => {
        const rank = index + 1;
        // Rank format: "01 |"
        const rankStr = String(rank).padStart(2, '0');

        // Value format: Right-aligned to the max value width found in this set
        const valueStr = row.fullValStr.padStart(maxValueWidth, ' ');

        // Name format: Tightly packed, star added for winners
        let userStr = row.displayName;
        if (mvpRecipients && mvpRecipients.includes(row.userId)) {
            userStr += ' 🌟';
        }

        // Final line assembly: Tight formatting to maximize name space
        const baseLine = `${rankStr} | ${valueStr} | `;
        const maxNameLen = MOBILE_MAX_LINE_LENGTH - baseLine.length;
        const finalName = truncateName(userStr, maxNameLen);

        lines.push(`\u200e${baseLine}${finalName}`);

        // Separator after Top 3
        if (index === 2 && data.length > 3) {
            const separatorLen = Math.min(MOBILE_MAX_LINE_LENGTH, baseLine.length + 8);
            lines.push('-'.repeat(separatorLen));
        }
    });

    return `\`\`\`\n${lines.join('\n')}\n\`\`\``;
}

/**
 * Build the Daily Activity leaderboard embed (shows either LIVE progress or YESTERDAY's final results)
 */
export function buildDailyActivityEmbed(activityData, mvpRecipients = [], isLive = false, nextRefreshTimestamp = null) {
    const embed = new EmbedBuilder()
        .setTitle('MVP Champions')
        .setColor(0xFFD700); // Always Gold for the Champions brand

    let description;
    if (!activityData || activityData.length === 0) {
        description = '*📉 No daily activity yet...*\n*Start chatting to climb the live ranks!*';
    } else {
        description = buildLeaderboardTable(activityData, 'score', '', mvpRecipients, true);
    }

    if (nextRefreshTimestamp) {
        description += `\n⏱️ Next Refresh **<t:${nextRefreshTimestamp}:R>**`;
    }

    embed.setDescription(description);
    return embed;
}

/**
 * Build the Total Coins leaderboard embed
 */
export function buildCoinsEmbed(coinsData, nextRefreshTimestamp = null) {
    const embed = new EmbedBuilder()
        .setTitle('Richest Members')
        .setColor(0x2ECC71); // Emerald Green

    let description;
    if (!coinsData || coinsData.length === 0) {
        description = '*💸 The vault is empty...*\n*Be the first to earn coins and claim the top spot!*';
    } else {
        description = buildLeaderboardTable(coinsData, 'balance', '', [], true);
    }

    if (nextRefreshTimestamp) {
        description += `\n⏱️ Next Refresh **<t:${nextRefreshTimestamp}:R>**`;
    }

    embed.setDescription(description);
    return embed;
}

/**
 * Build the Highest Streak leaderboard embed
 */
export function buildStreakEmbed(streakData, nextRefreshTimestamp = null) {
    const embed = new EmbedBuilder()
        .setTitle('Longest Streaks')
        .setColor(0xFF4500); // Fire Orange

    let description;
    if (!streakData || streakData.length === 0) {
        description = '*🕯️ No flames burning yet...*\n*Use `/daily` every day to ignite your streak!*';
    } else {
        description = buildLeaderboardTable(streakData, 'daily_streak', '', [], false);
    }

    if (nextRefreshTimestamp) {
        description += `\n⏱️ Next Refresh **<t:${nextRefreshTimestamp}:R>**`;
    }

    embed.setDescription(description);
    return embed;
}

/**
 * Get top users by coins (Strict Limit 15)
 */
export async function getTopCoinUsers(guildId, limit = 50) {
    const pool = getPool();
    const result = await pool.query(`
    SELECT user_id, balance
    FROM user_balances
    WHERE guild_id = $1 AND balance > 0
    ORDER BY balance DESC, user_id ASC
    LIMIT $2
  `, [guildId, limit]);
    return result.rows;
}

/**
 * Get top users by streak (Strict Limit 15)
 * VALIDATES STREAKS: Users with stale last_daily (older than yesterday) show as 0 Days
 */
export async function getTopStreakUsers(guildId, limit = 50) {
    const pool = getPool();

    // Import Cairo time helpers
    const { isStreakValid } = await import('../utils/time.js');

    // Fetch all users with positive daily_streak to avoid sql LIMIT truncating active streaks before JS validation
    const result = await pool.query(`
        SELECT user_id, daily_streak, last_daily
        FROM user_balances
        WHERE guild_id = $1 AND daily_streak > 0 AND last_daily IS NOT NULL
        ORDER BY daily_streak DESC, user_id ASC
    `, [guildId]);

    // Validate each streak - if stale, filter out
    const validatedRows = result.rows
        .map(row => {
            const isValid = isStreakValid(row.last_daily);
            return {
                user_id: row.user_id,
                daily_streak: isValid ? (parseInt(row.daily_streak, 10) || 0) : 0
            };
        })
        .filter(row => row.daily_streak > 0);

    // Re-sort: valid streaks first (DESC)
    validatedRows.sort((a, b) => b.daily_streak - a.daily_streak);

    return validatedRows.slice(0, limit);
}

/**
 * Build the Highest Level leaderboard embed
 */
export function buildLevelEmbed(levelData, nextRefreshTimestamp = null) {
    const embed = new EmbedBuilder()
        .setTitle('Highest Levels')
        .setColor(0x5865F2); // Blurple / Indigo

    let description;
    if (!levelData || levelData.length === 0) {
        description = '*⭐ No levels earned yet...*\n*Chat and join voice channels to level up and claim the top spot!*';
    } else {
        description = buildLeaderboardTable(levelData, 'level', ' Lv', [], false);
    }

    if (nextRefreshTimestamp) {
        description += `\n⏱️ Next Refresh **<t:${nextRefreshTimestamp}:R>**`;
    }

    embed.setDescription(description);
    return embed;
}

/**
 * Get top users by level & all-time XP (Strict Limit 50)
 */
export async function getTopLevelUsers(guildId, limit = 50) {
    try {
        const { flushMessageBatch } = await import('../activity/tracker.js');
        await flushMessageBatch().catch(() => {});
    } catch {}

    const pool = getPool();
    const { getGuildConfig } = await import('../storage/config.js');
    const config = await getGuildConfig(guildId) || {};
    const baseXp = parseInt(config.battlepass_base_xp ?? config.battlepass_xp_per_level ?? 100, 10);
    const incrementXp = parseInt(config.battlepass_xp_increment ?? 50, 10);
    const { calculateLevelFromXp } = await import('./settings/pass-engine.js');

    const result = await pool.query(`
        SELECT user_id, battlepass_xp
        FROM user_activity
        WHERE guild_id = $1 AND battlepass_xp > 0
        ORDER BY battlepass_xp DESC, user_id ASC
        LIMIT $2
    `, [guildId, limit]);

    return result.rows.map(row => {
        const totalXp = parseInt(row.battlepass_xp || 0, 10);
        const { level } = calculateLevelFromXp(totalXp, baseXp, incrementXp);
        return {
            user_id: row.user_id,
            level,
            battlepass_xp: totalXp
        };
    });
}

/**
 * Send a single leaderboard type immediately (for admin channel selection)
 * This bypasses the DB configuration entirely, just sends a preview to a target channel.
 */
export async function sendLeaderboardPreview(client, channelId, guildId, type) {
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return null;

    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel) return null;

    let embed;

    if (type === 'daily_coins') {
        const { getTopActiveUsers } = await import('../activity/tracker.js');
        const rawData = await getTopActiveUsers(guildId, 50, guild);
        const enrichedData = await enrichUserData(client, guildId, rawData, 'userId');
        const { getGuildConfig } = await import('../storage/config.js');
        const guildConfig = await getGuildConfig(guildId);
        const winnersCount = Math.min(Math.max(1, guildConfig?.winnersCount || 1), 5);
        const liveMvpRecipients = rawData.slice(0, winnersCount).map(u => u.userId);
        embed = buildDailyActivityEmbed(enrichedData, liveMvpRecipients, true); // True for Live Progress preview
    } else if (type === 'coins') {
        const rawData = await getTopCoinUsers(guildId);
        const enrichedData = await enrichUserData(client, guildId, rawData, 'user_id');
        embed = buildCoinsEmbed(enrichedData);
    } else if (type === 'streak') {
        const rawData = await getTopStreakUsers(guildId);
        const enrichedData = await enrichUserData(client, guildId, rawData, 'user_id');
        embed = buildStreakEmbed(enrichedData);
    } else if (type === 'level') {
        const rawData = await getTopLevelUsers(guildId);
        const enrichedData = await enrichUserData(client, guildId, rawData, 'user_id');
        embed = buildLevelEmbed(enrichedData);
    } else {
        return null;
    }

    const msg = await channel.send({ embeds: [embed] });
    return msg.id;
}

/**
 * Update all leaderboard embeds.
 * Tries to edit existing messages in place. If messages are missing or out of order,
 * it sweeps (deletes) all configured messages and re-sends them in the correct order.
 * 
 * @param {Client} client - Discord client
 * @param {string} guildId - Guild ID
 * @param {Array} activityData - Explicit activity data for YESTERDAY's MVP. If null, fetches LIVE today data.
 * @param {Array} mvpRecipients - List of MVP user IDs
 */
export async function updateLeaderboards(client, guildId, activityData = null, mvpRecipients = []) {
    const config = await getLeaderboardConfig(guildId);
    if (!config) return;

    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return;

    // Define the strict order of leaderboard types
    const channelKeys = [
        { type: 'daily_coins', configChannel: 'daily_channel_id', configMsg: 'daily_message_id', name: 'MVP Champions' },
        { type: 'coins', configChannel: 'coins_channel_id', configMsg: 'coins_message_id', name: 'Richest Members' },
        { type: 'streak', configChannel: 'streak_channel_id', configMsg: 'streak_message_id', name: 'Longest Streaks' },
        { type: 'level', configChannel: 'level_channel_id', configMsg: 'level_message_id', name: 'Highest Levels' }
    ];

    // Filter to only configured types
    const configuredTypes = channelKeys.filter(k => config[k.configChannel]);
    if (configuredTypes.length === 0) return;

    // Phase 1: Verify Order & Integrity
    let messagesIntact = true;
    const channelMap = new Map();
    const msgMap = new Map();

    for (const t of configuredTypes) {
        try {
            const chanId = config[t.configChannel];
            const channel = await guild.channels.fetch(chanId).catch(() => null);
            channelMap.set(t.type, channel);
            
            if (!channel) {
                messagesIntact = false;
                break;
            }
            
            if (config[t.configMsg]) {
                const msg = await channel.messages.fetch(config[t.configMsg]).catch(() => null);
                msgMap.set(t.type, msg);
                if (!msg) messagesIntact = false;
            } else {
                messagesIntact = false;
            }
        } catch (err) {
            messagesIntact = false;
        }
    }

    // Strict Sequence Check: Ensure Daily -> Richest -> Streak -> Level
    if (messagesIntact) {
        const msgsByChannel = {};
        for (const t of configuredTypes) {
            const cid = config[t.configChannel];
            if (!msgsByChannel[cid]) msgsByChannel[cid] = [];
            msgsByChannel[cid].push({ type: t.type, msgId: config[t.configMsg] });
        }
        
        for (const cid in msgsByChannel) {
            const channelMsgs = msgsByChannel[cid]; 
            if (channelMsgs.length > 1) {
                // Expected order: daily_coins < coins < streak < level (snowflake comparison)
                const sortedBySnowflake = [...channelMsgs].sort((a, b) => (BigInt(a.msgId) < BigInt(b.msgId) ? -1 : 1));
                const expectedOrder = ['daily_coins', 'coins', 'streak', 'level'].filter(type => channelMsgs.some(cm => cm.type === type));
                
                for (let i = 0; i < sortedBySnowflake.length; i++) {
                    if (sortedBySnowflake[i].type !== expectedOrder[i]) {
                        messagesIntact = false;
                        break;
                    }
                }
            }
        }
    }

    // Phase 2: Sweep if Broken
    if (!messagesIntact) {
        for (const t of configuredTypes) {
            const msg = msgMap.get(t.type);
            if (msg) await msg.delete().catch(() => {});
            config[t.configMsg] = null;
        }
    }

    // Phase 3: Build & Dispatch
    let configUpdated = false;
    for (const t of channelKeys) {
        if (!config[t.configChannel]) continue;
        const channel = channelMap.get(t.type) || await guild.channels.fetch(config[t.configChannel]).catch(() => null);
        if (!channel) continue;

        const { getNextCairoHourTimestamp } = await import('../utils/time.js');
        const nextRefreshTimestamp = getNextCairoHourTimestamp();

        let embed;
        try {
            if (t.type === 'daily_coins') {
                // FORCE LIVE CONTENT: We ignore historical snapshots to keep it "Today's Race" 24/7
                const { getTopActiveUsers } = await import('../activity/tracker.js');
                const rawData = await getTopActiveUsers(guildId, 50, guild);
                const enrichedData = await enrichUserData(client, guildId, rawData, 'userId');
                const { getGuildConfig } = await import('../storage/config.js');
                const guildConfig = await getGuildConfig(guildId);
                const winnersCount = Math.min(Math.max(1, guildConfig?.winnersCount || 1), 5);
                const liveMvpRecipients = rawData.slice(0, winnersCount).map(u => u.userId);
                embed = buildDailyActivityEmbed(enrichedData, liveMvpRecipients, true, nextRefreshTimestamp); 
            } else if (t.type === 'coins') {
                const rawData = await getTopCoinUsers(guildId);
                const enrichedData = await enrichUserData(client, guildId, rawData, 'user_id');
                embed = buildCoinsEmbed(enrichedData, nextRefreshTimestamp);
            } else if (t.type === 'streak') {
                const rawData = await getTopStreakUsers(guildId);
                const enrichedData = await enrichUserData(client, guildId, rawData, 'user_id');
                embed = buildStreakEmbed(enrichedData, nextRefreshTimestamp);
            } else if (t.type === 'level') {
                const rawData = await getTopLevelUsers(guildId);
                const enrichedData = await enrichUserData(client, guildId, rawData, 'user_id');
                embed = buildLevelEmbed(enrichedData, nextRefreshTimestamp);
            }

            if (messagesIntact && msgMap.get(t.type)) {
                await msgMap.get(t.type).edit({ embeds: [embed] }).catch(async () => {
                    const newMsg = await channel.send({ embeds: [embed] });
                    config[t.configMsg] = newMsg.id;
                    configUpdated = true;
                });
            } else {
                const newMsg = await channel.send({ embeds: [embed] });
                config[t.configMsg] = newMsg.id;
                configUpdated = true;
            }
        } catch (err) {
            sysError(`Failed to update ${t.type} leaderboard`, err, { guild: guildId });
        }
    }

    if (configUpdated) {
        await setLeaderboardConfig(guildId, config);
    }
}

/**
 * Refresh a single leaderboard type
 * Kept for backwards compatibility but proxying to the new unified flow.
 */
export async function refreshLeaderboard(client, guildId, type) {
    return updateLeaderboards(client, guildId);
}


/**
 * Send a single leaderboard type immediately (for admin channel selection)
 */
export async function sendSingleLeaderboard(client, guildId, type, channelId) {
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return null;

    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel) return null;

    let embed;
    if (type === 'activity' || type === 'daily_coins') {
        const { getTopActiveUsers } = await import('../activity/tracker.js');
        const rawData = await getTopActiveUsers(guildId, 50, guild);
        const enrichedData = await enrichUserData(client, guildId, rawData, 'userId');
        const { getGuildConfig } = await import('../storage/config.js');
        const guildConfig = await getGuildConfig(guildId);
        const winnersCount = Math.min(Math.max(1, guildConfig?.winnersCount || 1), 5);
        const liveMvpRecipients = rawData.slice(0, winnersCount).map(u => u.userId);
        embed = buildDailyActivityEmbed(enrichedData, liveMvpRecipients, true);
    } else if (type === 'coins') {
        const rawData = await getTopCoinUsers(guildId);
        const enrichedData = await enrichUserData(client, guildId, rawData, 'user_id');
        embed = buildCoinsEmbed(enrichedData);
    } else if (type === 'streak') {
        const rawData = await getTopStreakUsers(guildId);
        const enrichedData = await enrichUserData(client, guildId, rawData, 'user_id');
        embed = buildStreakEmbed(enrichedData);
    } else if (type === 'level') {
        const rawData = await getTopLevelUsers(guildId);
        const enrichedData = await enrichUserData(client, guildId, rawData, 'user_id');
        embed = buildLevelEmbed(enrichedData);
    } else {
        return null;
    }

    const newMessage = await channel.send({ embeds: [embed] });
    return newMessage.id;
}

/**
 * Handle initial setup logic (needs to do same enrichment)
 */
async function handleSetup(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const dailyChannel = interaction.options.getChannel('daily_activity_channel');
    const coinsChannel = interaction.options.getChannel('total_coins_channel');
    const streakChannel = interaction.options.getChannel('highest_streak_channel');
    const levelChannel = interaction.options.getChannel('highest_level_channel');
    const guildId = interaction.guildId;

    try {
        const config = {
            daily_channel_id: dailyChannel.id,
            daily_message_id: null,
            coins_channel_id: coinsChannel.id,
            coins_message_id: null,
            streak_channel_id: streakChannel.id,
            streak_message_id: null,
            level_channel_id: levelChannel ? levelChannel.id : null,
            level_message_id: null
        };

        // Post initial embeds with live data
        // Daily - Live Top Active Users
        const { getTopActiveUsers } = await import('../activity/tracker.js');
        const rawActivity = await getTopActiveUsers(guildId, 50, interaction.guild);
        const enrichedActivity = await enrichUserData(interaction.client, guildId, rawActivity, 'userId');
        const { getGuildConfig } = await import('../storage/config.js');
        const guildConfig = await getGuildConfig(guildId);
        const winnersCount = Math.min(Math.max(1, guildConfig?.winnersCount || 1), 5);
        const liveMvpRecipients = rawActivity.slice(0, winnersCount).map(u => u.userId);
        const dailyEmbed = buildDailyActivityEmbed(enrichedActivity, liveMvpRecipients, true);
        const dailyMsg = await dailyChannel.send({ embeds: [dailyEmbed] });
        config.daily_message_id = dailyMsg.id;

        // Coins
        const coinsData = await getTopCoinUsers(guildId);
        const enrichedCoins = await enrichUserData(interaction.client, guildId, coinsData, 'user_id');
        const coinsEmbed = buildCoinsEmbed(enrichedCoins);
        const coinsMsg = await coinsChannel.send({ embeds: [coinsEmbed] });
        config.coins_message_id = coinsMsg.id;

        // Streak
        const streakData = await getTopStreakUsers(guildId);
        const enrichedStreak = await enrichUserData(interaction.client, guildId, streakData, 'user_id');
        const streakEmbed = buildStreakEmbed(enrichedStreak);
        const streakMsg = await streakChannel.send({ embeds: [streakEmbed] });
        config.streak_message_id = streakMsg.id;

        // Level (if configured)
        if (levelChannel) {
            const levelData = await getTopLevelUsers(guildId);
            const enrichedLevel = await enrichUserData(interaction.client, guildId, levelData, 'user_id');
            const levelEmbed = buildLevelEmbed(enrichedLevel);
            const levelMsg = await levelChannel.send({ embeds: [levelEmbed] });
            config.level_message_id = levelMsg.id;
        }

        await setLeaderboardConfig(guildId, config);

        const logName = getUserLogName(interaction);
        sendLog(interaction.guild, 'audit', 'cyan', '📊 Leaderboard Config Changed', 
            `**Admin:** \`${logName}\`\n` +
            `**Action:** Initial setup of all leaderboard channels.`
        );

        const descLines = [
            `**Daily Activity:** ${dailyChannel}`,
            `**Total Coins:** ${coinsChannel}`,
            `**Highest Streak:** ${streakChannel}`
        ];
        if (levelChannel) descLines.push(`**Highest Level:** ${levelChannel}`);
        descLines.push('', '📅 Leaderboards refresh daily at **00:00 Cairo time** and hourly.');

        const successEmbed = new EmbedBuilder()
            .setTitle('Leaderboards Configured')
            .setColor(0x00FF00)
            .setDescription(descLines.join('\n'));

        await interaction.editReply({ files: [], embeds: [successEmbed] });

    } catch (error) {
        sysError('Leaderboard setup failed', error, { guildId });
        await interaction.editReply({
            content: `❌ Failed to setup leaderboards: ${error.message}`
        });
    }
}

// Keep handleStatus as is...
async function handleStatus(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        const config = await getLeaderboardConfig(interaction.guildId);

        if (!config || !config.daily_channel_id) {
            await interaction.editReply({ files: [], content: '⚠️ Leaderboards not configured. Use `/leaderboard setup` to set them up.' });
            return;
        }

        const embed = new EmbedBuilder()
            .setTitle('Leaderboard Configuration')
            .setColor(0x0099FF)
            .addFields(
                { name: 'Daily Activity', value: config.daily_channel_id ? `<#${config.daily_channel_id}>` : '*Not Set*', inline: true },
                { name: 'Total Coins', value: config.coins_channel_id ? `<#${config.coins_channel_id}>` : '*Not Set*', inline: true },
                { name: 'Highest Streak', value: config.streak_channel_id ? `<#${config.streak_channel_id}>` : '*Not Set*', inline: true },
                { name: 'Highest Level', value: config.level_channel_id ? `<#${config.level_channel_id}>` : '*Not Set*', inline: true }
            )
            .setFooter({ text: 'Refreshes daily at 00:00 Cairo time' });

        await interaction.editReply({ files: [], embeds: [embed] });

    } catch (error) {
        sysError('Leaderboard status failed', error, { guildId: interaction.guildId });
        await interaction.editReply({
            content: `❌ Failed to get leaderboard status: ${error.message}`
        });
    }
}

// Sub-command handler export
export async function execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === 'setup') {
        await handleSetup(interaction);
    } else if (subcommand === 'status') {
        await handleStatus(interaction);
    }
}
