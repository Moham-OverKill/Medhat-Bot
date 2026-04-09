import {
    SlashCommandBuilder,
    MessageFlags,
    EmbedBuilder,
    PermissionFlagsBits,
    ChannelType
} from 'discord.js';
import { getPool } from '../storage/postgres.js';
import { sanitizeError, getUserDisplayName, getUserLogName } from '../shared.js';
import { sendLog } from '../utils/logger.js';

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
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
    ON CONFLICT (guild_id) DO UPDATE SET
      daily_channel_id = EXCLUDED.daily_channel_id,
      daily_message_id = EXCLUDED.daily_message_id,
      coins_channel_id = EXCLUDED.coins_channel_id,
      coins_message_id = EXCLUDED.coins_message_id,
      streak_channel_id = EXCLUDED.streak_channel_id,
      streak_message_id = EXCLUDED.streak_message_id,
      updated_at = CURRENT_TIMESTAMP
  `, [
        guildId,
        config.daily_channel_id, config.daily_message_id,
        config.coins_channel_id, config.coins_message_id,
        config.streak_channel_id, config.streak_message_id
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
    if (!guild) return slicedData.map(d => ({ ...d, displayName: 'Unknown' }));

    const enriched = await Promise.all(slicedData.map(async (item) => {
        const uid = item[userIdKey] || item.userId;
        let name = 'Unknown';
        try {
            // Try fetching member to get nickname/display name
            const member = await guild.members.fetch(uid);
            name = member.displayName;
        } catch {
            // Fallback to fetch user to get username
            try {
                const user = await client.users.fetch(uid);
                name = user.username;
            } catch {
                name = 'Unknown User';
            }
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
    if (name.length <= maxLen) return name;
    return name.substring(0, maxLen - 3) + '...';
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

        // Final line assembly
        const baseLine = `${rankStr} | ${valueStr} | `;
        const maxNameLen = MOBILE_MAX_LINE_LENGTH - baseLine.length;
        const finalName = truncateName(userStr, maxNameLen);

        lines.push(`${baseLine}${finalName}`);

        // Separator after Top 3
        if (index === 2 && data.length > 3) {
            const separatorLen = Math.min(MOBILE_MAX_LINE_LENGTH, baseLine.length + 8);
            lines.push('-'.repeat(separatorLen));
        }
    });

    return `\`\`\`\n${lines.join('\n')}\n\`\`\``;
}


/**
 * Build the Daily Activity leaderboard embed (shows YESTERDAY's final results)
 */
export function buildDailyActivityEmbed(activityData, mvpRecipients = []) {
    const embed = new EmbedBuilder()
        .setTitle('🏆 MVP Champions')
        .setColor(0xFFD700); // Gold

    if (!activityData || activityData.length === 0) {
        embed.setDescription('*🌅 No MVP history yet...*\n*The first champions will appear after the next daily award cycle!*');
    } else {
        const table = buildLeaderboardTable(activityData, 'score', ' Points', mvpRecipients, true);
        embed.setDescription(table);
    }
    return embed;
}

/**
 * Build the Total Coins leaderboard embed
 */
export function buildCoinsEmbed(coinsData) {
    const embed = new EmbedBuilder()
        .setTitle('💰 Richest Members')
        .setColor(0x2ECC71); // Emerald Green

    if (!coinsData || coinsData.length === 0) {
        embed.setDescription('*💸 The vault is empty...*\n*Be the first to earn coins and claim the top spot!*');
    } else {
        const table = buildLeaderboardTable(coinsData, 'balance', '', [], true);
        embed.setDescription(table);
    }
    return embed;
}

/**
 * Build the Highest Streak leaderboard embed
 */
export function buildStreakEmbed(streakData) {
    const embed = new EmbedBuilder()
        .setTitle('🔥 Longest Streaks')
        .setColor(0xFF4500); // Fire Orange

    if (!streakData || streakData.length === 0) {
        embed.setDescription('*🕯️ No flames burning yet...*\n*Use `/daily` every day to ignite your streak!*');
    } else {
        const table = buildLeaderboardTable(streakData, 'daily_streak', ' Days', [], false);
        embed.setDescription(table);
    }
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

    // Fetch users with any streak history (including last_daily for validation)
    const result = await pool.query(`
        SELECT user_id, daily_streak, last_daily
        FROM user_balances
        WHERE guild_id = $1
        ORDER BY daily_streak DESC, user_id ASC
        LIMIT $2
    `, [guildId, limit]);

    // Validate each streak - if stale, set to 0 for display
    const validatedRows = result.rows.map(row => {
        const isValid = isStreakValid(row.last_daily);
        return {
            user_id: row.user_id,
            daily_streak: isValid ? row.daily_streak : 0
        };
    });

    // Re-sort: valid streaks first (DESC), then 0s at bottom
    validatedRows.sort((a, b) => b.daily_streak - a.daily_streak);

    // Filter to only include users with any activity (have a last_daily record)
    return validatedRows.filter(row => result.rows.some(r => r.user_id === row.user_id && r.last_daily));
}

/**
 * Update all leaderboard embeds
 */
export async function updateLeaderboards(client, guildId, activityData = null, mvpRecipients = []) {
    const config = await getLeaderboardConfig(guildId);
    if (!config) return;

    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return;

    // --- PASS 1: Sweep (Delete all tracked messages across all channels) ---
    const types = [
        { key: 'daily', channelId: config.daily_channel_id, messageId: config.daily_message_id },
        { key: 'coins', channelId: config.coins_channel_id, messageId: config.coins_message_id },
        { key: 'streak', channelId: config.streak_channel_id, messageId: config.streak_message_id }
    ];

    for (const type of types) {
        if (type.channelId && type.messageId) {
            try {
                const channel = await guild.channels.fetch(type.channelId).catch(() => null);
                if (channel) {
                    const msg = await channel.messages.fetch(type.messageId).catch(() => null);
                    if (msg) await msg.delete().catch(() => { });
                }
            } catch (err) {
                console.error(`Cleanup failed for ${type.key}:`, sanitizeError(err));
            }
        }
    }

    // --- PASS 2: Re-send in absolute order (Daily -> Richest -> Streak) ---
    // If they share a channel, this order is guaranteed relative to each other.

    // 1. Daily MVP
    if (config.daily_channel_id) {
        try {
            const channel = await guild.channels.fetch(config.daily_channel_id).catch(() => null);
            if (channel) {
                let rawData = activityData;
                if (!rawData || rawData.length === 0) {
                    const { getLastMvpCycleResults } = await import('../storage/mvpHistory.js');
                    const cycleData = await getLastMvpCycleResults(guildId, 50);
                    rawData = cycleData.results;
                }
                const enrichedData = await enrichUserData(client, guildId, rawData, 'userId');
                const embed = buildDailyActivityEmbed(enrichedData, mvpRecipients);
                const newMessage = await channel.send({ embeds: [embed] });
                config.daily_message_id = newMessage.id;
            }
        } catch (error) {
            console.error('Failed to update daily leaderboard:', sanitizeError(error));
        }
    }

    // 2. Richest Members
    if (config.coins_channel_id) {
        try {
            const channel = await guild.channels.fetch(config.coins_channel_id).catch(() => null);
            if (channel) {
                const rawData = await getTopCoinUsers(guildId);
                const enrichedData = await enrichUserData(client, guildId, rawData, 'user_id');
                const embed = buildCoinsEmbed(enrichedData);
                const newMessage = await channel.send({ embeds: [embed] });
                config.coins_message_id = newMessage.id;
            }
        } catch (error) {
            console.error('Failed to update coins leaderboard:', sanitizeError(error));
        }
    }

    // 3. Longest Streaks
    if (config.streak_channel_id) {
        try {
            const channel = await guild.channels.fetch(config.streak_channel_id).catch(() => null);
            if (channel) {
                const rawData = await getTopStreakUsers(guildId);
                const enrichedData = await enrichUserData(client, guildId, rawData, 'user_id');
                const embed = buildStreakEmbed(enrichedData);
                const newMessage = await channel.send({ embeds: [embed] });
                config.streak_message_id = newMessage.id;
            }
        } catch (error) {
            console.error('Failed to update streak leaderboard:', sanitizeError(error));
        }
    }

    await setLeaderboardConfig(guildId, config);
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
    if (type === 'activity') {
        // Fetch YESTERDAY's MVP results from DB
        const { getLastMvpCycleResults } = await import('../storage/mvpHistory.js');
        const cycleData = await getLastMvpCycleResults(guildId, 50);
        const enrichedData = await enrichUserData(client, guildId, cycleData.results, 'userId');
        embed = buildDailyActivityEmbed(enrichedData, []);
    } else if (type === 'coins') {
        const rawData = await getTopCoinUsers(guildId);
        const enrichedData = await enrichUserData(client, guildId, rawData, 'user_id');
        embed = buildCoinsEmbed(enrichedData);
    } else if (type === 'streak') {
        const rawData = await getTopStreakUsers(guildId);
        const enrichedData = await enrichUserData(client, guildId, rawData, 'user_id');
        embed = buildStreakEmbed(enrichedData);
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
    const guildId = interaction.guildId;

    try {
        const config = {
            daily_channel_id: dailyChannel.id,
            daily_message_id: null,
            coins_channel_id: coinsChannel.id,
            coins_message_id: null,
            streak_channel_id: streakChannel.id,
            streak_message_id: null
        };

        // Post initial embeds with historical data
        // Daily - Fetch yesterday's MVP results
        const { getLastMvpCycleResults } = await import('../storage/mvpHistory.js');
        const cycleData = await getLastMvpCycleResults(guildId, 50);
        const enrichedActivity = await enrichUserData(interaction.client, guildId, cycleData.results, 'userId');
        const dailyEmbed = buildDailyActivityEmbed(enrichedActivity, []);
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

        await setLeaderboardConfig(guildId, config);

        const logName = getUserLogName(interaction);
        sendLog(interaction.guild, 'audit', 'cyan', '📊 Leaderboard Config Changed', 
            `**Admin:** \`${logName}\`\n` +
            `**Action:** Initial setup of all leaderboard channels.`
        );

        const successEmbed = new EmbedBuilder()
            .setTitle('✅ Leaderboards Configured')
            .setColor(0x00FF00)
            .setDescription([
                `**Daily Activity:** ${dailyChannel}`,
                `**Total Coins:** ${coinsChannel}`,
                `**Highest Streak:** ${streakChannel}`,
                '',
                '📅 Leaderboards refresh daily at **00:00 Cairo time**.'
            ].join('\n'));

        await interaction.editReply({ embeds: [successEmbed] });

    } catch (error) {
        console.error('Leaderboard setup failed:', sanitizeError(error));
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
            await interaction.editReply({
                content: '⚠️ Leaderboards not configured. Use `/leaderboard setup` to set them up.'
            });
            return;
        }

        const embed = new EmbedBuilder()
            .setTitle('📊 Leaderboard Configuration')
            .setColor(0x0099FF)
            .addFields(
                { name: 'Daily Activity', value: `<#${config.daily_channel_id}>`, inline: true },
                { name: 'Total Coins', value: `<#${config.coins_channel_id}>`, inline: true },
                { name: 'Highest Streak', value: `<#${config.streak_channel_id}>`, inline: true }
            )
            .setFooter({ text: 'Refreshes daily at 00:00 Cairo time' });

        await interaction.editReply({ embeds: [embed] });

    } catch (error) {
        console.error('Leaderboard status failed:', sanitizeError(error));
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
