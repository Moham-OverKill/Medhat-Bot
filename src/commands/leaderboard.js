import {
    SlashCommandBuilder,
    MessageFlags,
    EmbedBuilder,
    PermissionFlagsBits,
    ChannelType,
    AttachmentBuilder
} from 'discord.js';
import { getPool } from '../storage/postgres.js';
import { sanitizeError, getUserDisplayName, getUserLogName, COIN_EMOJI, COIN_NAME, getCurrencyName } from '../shared.js';
import { logger, sendLog, sysWarn, sysError, sysLog, checkLeaderboardPermissions } from '../utils/logger.js';
import { renderLeaderboardCard, LEADERBOARD_THEMES } from '../graphics/leaderboardCard.js';
import { normalizeDisplayName } from '../graphics/shared.js';

export { checkLeaderboardPermissions };

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

// In-memory cache for leaderboard configurations to prevent redundant DB reads during activity tracking
export const leaderboardConfigCache = new Map();

// In-memory cache for departed guild members to eliminate 404 (Unknown Member) and 429 rate limit errors
// Key: `${guildId}:${userId}` -> timestamp (ms)
export const departedGuildMembersCache = new Map();
export const DEPARTED_MEMBER_TTL = 6 * 60 * 60 * 1000; // 6 hours

// In-memory cache for external Discord user profiles (username and avatar)
// Key: `userId` -> { username: string, avatarUrl: string | null, fetchedAt: number }
export const externalUserProfileCache = new Map();
export const EXTERNAL_USER_PROFILE_TTL = 12 * 60 * 60 * 1000; // 12 hours

/**
 * Mark a member as departed from a guild
 */
export function markMemberDeparted(guildId, userId) {
    if (!guildId || !userId) return;
    departedGuildMembersCache.set(`${guildId}:${userId}`, Date.now());
    if (departedGuildMembersCache.size > 10000) {
        const cutoff = Date.now() - DEPARTED_MEMBER_TTL;
        for (const [key, ts] of departedGuildMembersCache.entries()) {
            if (ts < cutoff) departedGuildMembersCache.delete(key);
        }
    }
}

/**
 * Clear a member from departed cache (e.g. upon re-joining)
 */
export function clearMemberDeparted(guildId, userId) {
    if (!guildId || !userId) return;
    departedGuildMembersCache.delete(`${guildId}:${userId}`);
}

/**
 * Preload all leaderboard configurations into memory on startup
 */
export async function loadAllLeaderboardConfigs() {
    try {
        const pool = getPool();
        const result = await pool.query('SELECT * FROM leaderboard_config');
        for (const row of result.rows) {
            if (row.guild_id) {
                leaderboardConfigCache.set(row.guild_id, row);
            }
        }
        sysLog('Leaderboard Configs Preloaded', { count: leaderboardConfigCache.size });
    } catch (err) {
        sysError('Failed to preload leaderboard configs', err);
    }
}

/**
 * Synchronous in-memory check to see if the daily activity leaderboard is active
 * @param {string} guildId
 * @returns {boolean}
 */
export function isDailyLeaderboardActive(guildId) {
    if (!guildId) return false;
    const cfg = leaderboardConfigCache.get(guildId);
    return Boolean(cfg?.daily_channel_id);
}

/**
 * Get leaderboard config from memory cache or database
 */
export async function getLeaderboardConfig(guildId) {
    if (!guildId) return null;
    if (leaderboardConfigCache.has(guildId)) {
        return leaderboardConfigCache.get(guildId);
    }
    const pool = getPool();
    const result = await pool.query(
        'SELECT * FROM leaderboard_config WHERE guild_id = $1',
        [guildId]
    );
    const row = result.rows[0] || null;
    if (row) {
        leaderboardConfigCache.set(guildId, row);
    }
    return row;
}

/**
 * Save leaderboard config to database and update in-memory cache
 */
export async function setLeaderboardConfig(guildId, config) {
    const pool = getPool();
    const existing = await getLeaderboardConfig(guildId) || {};
    const merged = {
        daily_channel_id: config.daily_channel_id !== undefined ? config.daily_channel_id : (existing.daily_channel_id ?? null),
        daily_title_message_id: config.daily_title_message_id !== undefined ? config.daily_title_message_id : (existing.daily_title_message_id ?? null),
        daily_message_id: config.daily_message_id !== undefined ? config.daily_message_id : (existing.daily_message_id ?? null),
        coins_channel_id: config.coins_channel_id !== undefined ? config.coins_channel_id : (existing.coins_channel_id ?? null),
        coins_title_message_id: config.coins_title_message_id !== undefined ? config.coins_title_message_id : (existing.coins_title_message_id ?? null),
        coins_message_id: config.coins_message_id !== undefined ? config.coins_message_id : (existing.coins_message_id ?? null),
        streak_channel_id: config.streak_channel_id !== undefined ? config.streak_channel_id : (existing.streak_channel_id ?? null),
        streak_title_message_id: config.streak_title_message_id !== undefined ? config.streak_title_message_id : (existing.streak_title_message_id ?? null),
        streak_message_id: config.streak_message_id !== undefined ? config.streak_message_id : (existing.streak_message_id ?? null),
        level_channel_id: config.level_channel_id !== undefined ? config.level_channel_id : (existing.level_channel_id ?? null),
        level_title_message_id: config.level_title_message_id !== undefined ? config.level_title_message_id : (existing.level_title_message_id ?? null),
        level_message_id: config.level_message_id !== undefined ? config.level_message_id : (existing.level_message_id ?? null)
    };
    await pool.query(`
    INSERT INTO leaderboard_config (
      guild_id, 
      daily_channel_id, daily_title_message_id, daily_message_id,
      coins_channel_id, coins_title_message_id, coins_message_id,
      streak_channel_id, streak_title_message_id, streak_message_id,
      level_channel_id, level_title_message_id, level_message_id,
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CURRENT_TIMESTAMP)
    ON CONFLICT (guild_id) DO UPDATE SET
      daily_channel_id = EXCLUDED.daily_channel_id,
      daily_title_message_id = EXCLUDED.daily_title_message_id,
      daily_message_id = EXCLUDED.daily_message_id,
      coins_channel_id = EXCLUDED.coins_channel_id,
      coins_title_message_id = EXCLUDED.coins_title_message_id,
      coins_message_id = EXCLUDED.coins_message_id,
      streak_channel_id = EXCLUDED.streak_channel_id,
      streak_title_message_id = EXCLUDED.streak_title_message_id,
      streak_message_id = EXCLUDED.streak_message_id,
      level_channel_id = EXCLUDED.level_channel_id,
      level_title_message_id = EXCLUDED.level_title_message_id,
      level_message_id = EXCLUDED.level_message_id,
      updated_at = CURRENT_TIMESTAMP
  `, [
        guildId,
        merged.daily_channel_id, merged.daily_title_message_id, merged.daily_message_id,
        merged.coins_channel_id, merged.coins_title_message_id, merged.coins_message_id,
        merged.streak_channel_id, merged.streak_title_message_id, merged.streak_message_id,
        merged.level_channel_id, merged.level_title_message_id, merged.level_message_id
    ]);

    leaderboardConfigCache.set(guildId, { guild_id: guildId, ...merged });
}

/**
 * Delete leaderboard configuration from database and cache (used when guild is departed or configuration is removed)
 */
export async function deleteLeaderboardConfig(guildId) {
    if (!guildId) return;
    leaderboardConfigCache.delete(guildId);
    try {
        const pool = getPool();
        await pool.query('DELETE FROM leaderboard_config WHERE guild_id = $1', [guildId]);
        sysLog('Leaderboard Config Pruned', { guildId, detail: 'Stale configuration purged from database' });
    } catch (err) {
        sysWarn('Failed to delete leaderboard config from database', { guildId, error: err.message });
    }
}

/**
 * Helper to fetch usernames for leaderboard data
 * Resolves user IDs to display names (or username) for clean text rendering
 */
async function enrichUserData(client, guildId, data, userIdKey = 'user_id') {
    if (!data || data.length === 0) return [];

    // Safety check: slice to 50 just in case query returned more
    const slicedData = data.slice(0, 50);
    const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return slicedData.map(d => ({ ...d, displayName: d.username || 'Unknown' }));

    const now = Date.now();

    // Warm up member cache targeted for displayed leaderboard entries
    // Skip members already in guild member cache or confirmed departed within TTL
    const targetUids = slicedData
        .map(item => item[userIdKey] || item.userId)
        .filter(uid => {
            if (!uid || guild.members.cache.has(uid)) return false;
            const departedAt = departedGuildMembersCache.get(`${guildId}:${uid}`);
            if (departedAt && (now - departedAt) < DEPARTED_MEMBER_TTL) return false;
            return true;
        });

    if (targetUids.length > 0) {
        await guild.members.fetch({ user: targetUids }).catch(() => null);
        // Any requested user that was not returned by bulk fetch is confirmed departed
        for (const uid of targetUids) {
            if (!guild.members.cache.has(uid)) {
                markMemberDeparted(guildId, uid);
            }
        }
    }

    const enriched = await Promise.all(slicedData.map(async (item) => {
        const uid = item[userIdKey] || item.userId;
        let name = item.username || 'Unknown';
        let avatarUrl = null;
        let roleColor = null;

        // Fast path: member is present in the guild cache
        const member = guild.members.cache.get(uid);
        if (member) {
            // Prioritize user's Discord username over nickname as requested, with fallback
            name = member.user?.username || member.displayName || item.username || 'Unknown User';
            avatarUrl = member.displayAvatarURL({ extension: 'png', size: 256 });
            if (member.displayHexColor && member.displayHexColor !== '#000000') {
                roleColor = member.displayHexColor;
            }
        } else {
            // Member is absent from guild cache -> confirmed departed from this guild
            markMemberDeparted(guildId, uid);

            // Check client.users cache first (0 network calls)
            const cachedUser = client.users.cache.get(uid);
            if (cachedUser) {
                name = cachedUser.username || cachedUser.displayName || item.username || 'Unknown User';
                avatarUrl = cachedUser.displayAvatarURL({ extension: 'png', size: 256 });
            } else {
                // Check in-memory external profile cache (0 network calls)
                const profile = externalUserProfileCache.get(uid);
                if (profile && (now - profile.fetchedAt) < EXTERNAL_USER_PROFILE_TTL) {
                    name = profile.username || item.username || 'Unknown User';
                    avatarUrl = profile.avatarUrl;
                } else {
                    // Fetch global user profile once and cache to prevent repeated REST calls
                    try {
                        const user = await client.users.fetch(uid).catch(() => null);
                        if (user) {
                            name = user.username || user.displayName || item.username || 'Unknown User';
                            avatarUrl = user.displayAvatarURL({ extension: 'png', size: 256 });
                            externalUserProfileCache.set(uid, {
                                username: name,
                                avatarUrl,
                                fetchedAt: now
                            });
                        } else {
                            name = item.username || 'Unknown User';
                            avatarUrl = null;
                            externalUserProfileCache.set(uid, {
                                username: name,
                                avatarUrl: null,
                                fetchedAt: now
                            });
                        }
                    } catch {
                        name = item.username || 'Unknown User';
                        avatarUrl = null;
                        externalUserProfileCache.set(uid, {
                            username: name,
                            avatarUrl: null,
                            fetchedAt: now
                        });
                    }
                }
            }
        }

        // Sanitize and normalize name: collapse multiple spaces, trim, and normalize special font glyphs
        const sanitizedName = normalizeDisplayName(name);
        return {
            ...item,
            displayName: sanitizedName,
            userId: uid,
            avatarUrl,
            roleColor,
            accentColor: roleColor
        };
    }));

    return enriched;
}

/**
 * Extract custom coin URL from guild config or fallback emoji
 */
export function getCustomCoinUrl(config, guildId) {
    const coinEmojiStr = config?.coin_emoji || COIN_EMOJI.forGuild(guildId) || '';
    const customEmojiMatch = String(coinEmojiStr).match(/<a?:\w+:(\d{17,20})>/);
    if (customEmojiMatch && customEmojiMatch[1]) {
        return `https://cdn.discordapp.com/emojis/${customEmojiMatch[1]}.png?size=128&quality=lossless`;
    }
    return null;
}

/**
 * Build the decoupled leaderboard category title message payload (> # <icon> <TITLE>)
 */
export function buildLeaderboardTitlePayload(category, guildId = null) {
    const theme = LEADERBOARD_THEMES[category] || LEADERBOARD_THEMES.daily_coins;
    const coinEmojiStr = guildId ? COIN_EMOJI.forGuild(guildId) : '';
    const categoryIcon = (category === 'coins' && coinEmojiStr) ? coinEmojiStr : theme.iconEmoji;

    return {
        content: `> # ${categoryIcon} ${theme.title}`,
        embeds: [],
        files: []
    };
}

/**
 * Build a rich, mobile-first visual leaderboard card image attachment payload
 */
export async function buildLeaderboardMessagePayload({
    category,
    data,
    mvpRecipients = [],
    nextRefreshTimestamp = null,
    guildId = null,
    currencyName = null,
    customCoinUrl = null
}) {
    const theme = LEADERBOARD_THEMES[category] || LEADERBOARD_THEMES.daily_coins;
    const activeCoinName = currencyName || (guildId ? COIN_NAME.forGuild(guildId) : 'Coins');

    const imageBuffer = await renderLeaderboardCard({
        category,
        data,
        mvpRecipients,
        currencyName: activeCoinName,
        customCoinUrl
    });

    const filename = `${category}_leaderboard.png`;
    const attachment = new AttachmentBuilder(imageBuffer, { name: filename });

    return {
        content: '',
        embeds: [],
        files: [attachment]
    };
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
export function buildCoinsEmbed(coinsData, nextRefreshTimestamp = null, guildId = null) {
    const coinName = guildId ? COIN_NAME.forGuild(guildId) : COIN_NAME.toString();
    const embed = new EmbedBuilder()
        .setTitle('Richest Members')
        .setColor(0x2ECC71); // Emerald Green

    let description;
    if (!coinsData || coinsData.length === 0) {
        description = `*💸 The vault is empty...*\n*Be the first to earn ${coinName.toLowerCase()} and claim the top spot!*`;
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
    const baseXp = Math.max(1, parseInt(config.battlepass_base_xp ?? config.battlepass_xp_per_level, 10) || 100);
    const incrementXp = Math.max(1, parseInt(config.battlepass_xp_increment, 10) > 0 ? parseInt(config.battlepass_xp_increment, 10) : 50);
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
 * Compare two snowflake IDs safely with BigInt, falling back to string comparison
 */
function compareSnowflakes(idA, idB) {
    if (!idA && !idB) return 0;
    if (!idA) return -1;
    if (!idB) return 1;
    try {
        const biA = BigInt(idA);
        const biB = BigInt(idB);
        if (biA < biB) return -1;
        if (biA > biB) return 1;
        return 0;
    } catch {
        if (String(idA) < String(idB)) return -1;
        if (String(idA) > String(idB)) return 1;
        return 0;
    }
}

/**
 * Safely delete an array of Discord messages
 * Uses bulkDelete when ManageMessages is held and messages are < 14 days old;
 * otherwise gracefully falls back to deleting messages one-by-one.
 */
export async function deleteMessagesSafe(channel, messages) {
    if (!messages || messages.length === 0) return 0;
    let deletedCount = 0;
    const me = channel.guild?.members?.me || channel.client?.user;
    const perms = channel.permissionsFor ? channel.permissionsFor(me) : null;
    const hasManageMessages = perms?.has ? perms.has(PermissionFlagsBits.ManageMessages) : false;

    const fourteenDaysAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const youngMessages = [];
    const oldMessages = [];

    for (const m of messages) {
        if (!m || typeof m.delete !== 'function') continue;
        const ts = m.createdTimestamp || 0;
        if (ts > fourteenDaysAgo) {
            youngMessages.push(m);
        } else {
            oldMessages.push(m);
        }
    }

    if (hasManageMessages && youngMessages.length >= 2 && typeof channel.bulkDelete === 'function') {
        try {
            const bulkDeleted = await channel.bulkDelete(youngMessages, true);
            deletedCount += (bulkDeleted?.size || bulkDeleted?.length || youngMessages.length);
        } catch {
            for (const m of youngMessages) {
                try {
                    await m.delete();
                    deletedCount++;
                } catch {}
            }
        }
    } else {
        for (const m of youngMessages) {
            try {
                await m.delete();
                deletedCount++;
            } catch {}
        }
    }

    for (const m of oldMessages) {
        try {
            await m.delete();
            deletedCount++;
        } catch {}
    }

    return deletedCount;
}

/**
 * Clean a leaderboard channel:
 * 1. Scans messages authored by the bot.
 * 2. Removes orphaned titles (titles not followed by a card), orphan cards, and duplicate titles.
 * 3. Binds surviving valid (Title -> Card) pairs to config if DB IDs were lost.
 * 4. Checks whether the channel's sequence is intact across all configured types.
 */
export async function cleanLeaderboardChannel(channel, client, configuredTypes = null, config = null, guildId = null) {
    if (!channel || !channel.permissionsFor) {
        return { cleanedCount: 0, intact: false, configUpdated: false, survivingPairs: new Map() };
    }
    const me = channel.guild?.members?.me || channel.client?.user;
    const perms = channel.permissionsFor(me);

    // Require ViewChannel and ReadMessageHistory to inspect channel messages
    if (!perms || !perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
        return { cleanedCount: 0, intact: false, configUpdated: false, survivingPairs: new Map() };
    }

    const channelKeys = [
        { type: 'daily_coins', configChannel: 'daily_channel_id', configTitleMsg: 'daily_title_message_id', configMsg: 'daily_message_id', name: 'MVP Champions' },
        { type: 'coins', configChannel: 'coins_channel_id', configTitleMsg: 'coins_title_message_id', configMsg: 'coins_message_id', name: 'Richest Members' },
        { type: 'streak', configChannel: 'streak_channel_id', configTitleMsg: 'streak_title_message_id', configMsg: 'streak_message_id', name: 'Longest Streaks' },
        { type: 'level', configChannel: 'level_channel_id', configTitleMsg: 'level_title_message_id', configMsg: 'level_message_id', name: 'Highest Levels' }
    ];

    const types = configuredTypes || channelKeys.filter(t => !config || config[t.configChannel] === channel.id);
    if (types.length === 0) {
        return { cleanedCount: 0, intact: false, configUpdated: false, survivingPairs: new Map() };
    }

    const fetched = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (!fetched) {
        return { cleanedCount: 0, intact: false, configUpdated: false, survivingPairs: new Map() };
    }

    const botId = client?.user?.id || me?.id;
    let msgList = [];
    if (typeof fetched.values === 'function') {
        msgList = Array.from(fetched.values());
    } else if (Array.isArray(fetched)) {
        msgList = fetched;
    } else if (fetched instanceof Map) {
        msgList = Array.from(fetched.values());
    } else if (typeof fetched[Symbol.iterator] === 'function') {
        msgList = Array.from(fetched);
    } else if (fetched.id) {
        msgList = [fetched];
    }

    const botMsgs = msgList
        .filter(m => m && m.author && m.author.id === botId)
        .sort((a, b) => compareSnowflakes(a.id, b.id)); // Oldest first

    if (botMsgs.length === 0) {
        return { cleanedCount: 0, intact: false, configUpdated: false, survivingPairs: new Map() };
    }

    const recognizedTitles = new Map();
    const recognizedCards = new Map();
    const otherLeaderboardMessages = [];

    for (const t of types) {
        recognizedTitles.set(t.type, []);
        recognizedCards.set(t.type, []);
    }

    for (const msg of botMsgs) {
        let categorized = false;
        const content = msg.content || '';

        // Check for title messages across all known categories to preserve other valid leaderboards
        for (const t of channelKeys) {
            const theme = LEADERBOARD_THEMES[t.type];
            const isConfiguredTitle = config && config[t.configTitleMsg] === msg.id;
            const matchesThemeTitle = (theme && content.includes(theme.title)) ||
                (t.type === 'daily_coins' && (content.includes('MVP CHAMPIONS') || content.includes('MVP'))) ||
                (t.type === 'coins' && (content.includes('RICHEST MEMBERS') || content.includes('RICHEST'))) ||
                (t.type === 'streak' && (content.includes('LONGEST STREAKS') || content.includes('STREAKS'))) ||
                (t.type === 'level' && (content.includes('HIGHEST LEVELS') || content.includes('LEVELS')));

            if (isConfiguredTitle || matchesThemeTitle) {
                if (recognizedTitles.has(t.type)) {
                    recognizedTitles.get(t.type).push(msg);
                }
                categorized = true;
                break;
            }
        }

        if (categorized) continue;

        // Check for card messages across all known categories
        for (const t of channelKeys) {
            const isConfiguredCard = config && config[t.configMsg] === msg.id;
            let hasCategoryAttachment = false;

            if (msg.attachments && (msg.attachments.size > 0 || msg.attachments.length > 0)) {
                const attachList = Array.isArray(msg.attachments)
                    ? msg.attachments
                    : Array.from(msg.attachments.values ? msg.attachments.values() : msg.attachments);

                hasCategoryAttachment = attachList.some(a => {
                    const name = a?.name || a?.filename || '';
                    if (t.type === 'daily_coins') {
                        return name.includes('daily_coins') || name.includes('daily') || name.includes('activity');
                    }
                    if (t.type === 'coins') {
                        return (name.includes('coins_leaderboard') || name.includes('coins')) && !name.includes('daily_coins');
                    }
                    if (t.type === 'streak') {
                        return name.includes('streak');
                    }
                    if (t.type === 'level') {
                        return name.includes('level');
                    }
                    return false;
                });
            }

            const hasCategoryEmbed = msg.embeds && msg.embeds.some(e => e.title && e.title.includes(LEADERBOARD_THEMES[t.type]?.title));

            if (isConfiguredCard || hasCategoryAttachment || hasCategoryEmbed) {
                if (recognizedCards.has(t.type)) {
                    recognizedCards.get(t.type).push(msg);
                }
                categorized = true;
                break;
            }
        }

        if (!categorized) {
            // Stray or unlinked header message
            if (content.startsWith('> # ') && (content.includes('CHAMPIONS') || content.includes('RICHEST') || content.includes('STREAKS') || content.includes('LEVELS'))) {
                otherLeaderboardMessages.push(msg);
            }
        }
    }

    const messagesToDelete = new Set(otherLeaderboardMessages);
    let configUpdated = false;
    let intact = true;
    const survivingPairs = new Map();

    for (const t of types) {
        const titles = recognizedTitles.get(t.type) || [];
        const cards = recognizedCards.get(t.type) || [];

        if (titles.length === 0 && cards.length === 0) {
            intact = false;
            if (config && (config[t.configTitleMsg] || config[t.configMsg])) {
                config[t.configTitleMsg] = null;
                config[t.configMsg] = null;
                configUpdated = true;
            }
            continue;
        }

        // Titles without card or cards without title are orphans
        if (titles.length === 0 || cards.length === 0) {
            titles.forEach(m => messagesToDelete.add(m));
            cards.forEach(m => messagesToDelete.add(m));
            intact = false;
            if (config && (config[t.configTitleMsg] || config[t.configMsg])) {
                config[t.configTitleMsg] = null;
                config[t.configMsg] = null;
                configUpdated = true;
            }
            continue;
        }

        // Search for newest valid pair: Title precedes Card
        let validPair = null;
        for (let i = titles.length - 1; i >= 0; i--) {
            const titleMsg = titles[i];
            for (let j = cards.length - 1; j >= 0; j--) {
                const cardMsg = cards[j];
                if (compareSnowflakes(titleMsg.id, cardMsg.id) < 0) {
                    validPair = { title: titleMsg, card: cardMsg };
                    break;
                }
            }
            if (validPair) break;
        }

        if (!validPair) {
            titles.forEach(m => messagesToDelete.add(m));
            cards.forEach(m => messagesToDelete.add(m));
            intact = false;
            if (config && (config[t.configTitleMsg] || config[t.configMsg])) {
                config[t.configTitleMsg] = null;
                config[t.configMsg] = null;
                configUpdated = true;
            }
            continue;
        }

        // Mark older/duplicate titles & cards for deletion
        for (const tm of titles) {
            if (tm.id !== validPair.title.id) messagesToDelete.add(tm);
        }
        for (const cm of cards) {
            if (cm.id !== validPair.card.id) messagesToDelete.add(cm);
        }

        survivingPairs.set(t.type, validPair);

        if (config) {
            if (config[t.configTitleMsg] !== validPair.title.id) {
                config[t.configTitleMsg] = validPair.title.id;
                configUpdated = true;
            }
            if (config[t.configMsg] !== validPair.card.id) {
                config[t.configMsg] = validPair.card.id;
                configUpdated = true;
            }
        }
    }

    // Strict Sequence Check across categories in shared channel
    if (intact && types.length > 0) {
        const sequence = [];
        for (const t of types) {
            const pair = survivingPairs.get(t.type);
            if (!pair) {
                intact = false;
                break;
            }
            sequence.push(pair.title.id);
            sequence.push(pair.card.id);
        }

        if (intact && sequence.length > 1) {
            for (let i = 0; i < sequence.length - 1; i++) {
                if (compareSnowflakes(sequence[i], sequence[i + 1]) >= 0) {
                    intact = false;
                    break;
                }
            }
        }
    }

    const toDeleteArray = Array.from(messagesToDelete);
    let cleanedCount = 0;
    if (toDeleteArray.length > 0) {
        cleanedCount = await deleteMessagesSafe(channel, toDeleteArray);
    }

    return { cleanedCount, intact, configUpdated, survivingPairs };
}

/**
 * Sweep duplicate or orphaned leaderboard messages for a single guild
 */
export async function cleanupGuildLeaderboards(client, guildId) {
    const config = await getLeaderboardConfig(guildId);
    if (!config) return { cleanedCount: 0 };

    let guild = client.guilds.cache.get(guildId);
    if (!guild) {
        try {
            guild = await client.guilds.fetch(guildId);
        } catch (err) {
            if (err?.code === 10004 || err?.status === 404) {
                sysWarn('Pruning stale leaderboard config for departed guild during cleanup', { guild: guildId, error: err.message });
                await deleteLeaderboardConfig(guildId);
                return { cleanedCount: 0 };
            }
            return { cleanedCount: 0 };
        }
    }
    if (!guild) return { cleanedCount: 0 };

    const channelKeys = [
        { type: 'daily_coins', configChannel: 'daily_channel_id', configTitleMsg: 'daily_title_message_id', configMsg: 'daily_message_id', name: 'MVP Champions' },
        { type: 'coins', configChannel: 'coins_channel_id', configTitleMsg: 'coins_title_message_id', configMsg: 'coins_message_id', name: 'Richest Members' },
        { type: 'streak', configChannel: 'streak_channel_id', configTitleMsg: 'streak_title_message_id', configMsg: 'streak_message_id', name: 'Longest Streaks' },
        { type: 'level', configChannel: 'level_channel_id', configTitleMsg: 'level_title_message_id', configMsg: 'level_message_id', name: 'Highest Levels' }
    ];

    const configuredTypes = channelKeys.filter(k => config[k.configChannel]);
    if (configuredTypes.length === 0) return { cleanedCount: 0 };

    const channelsMap = new Map();
    for (const t of configuredTypes) {
        const cid = config[t.configChannel];
        if (!channelsMap.has(cid)) channelsMap.set(cid, []);
        channelsMap.get(cid).push(t);
    }

    let totalCleaned = 0;
    let configUpdated = false;

    for (const [cid, types] of channelsMap.entries()) {
        let channel = guild.channels.cache.get(cid);
        if (!channel) {
            try {
                channel = await guild.channels.fetch(cid);
            } catch (err) {
                if (err?.code === 10003 || err?.status === 404) {
                    sysWarn('Pruning stale leaderboard channel config during cleanup', { guild: guildId, channel: cid });
                    for (const t of types) {
                        config[t.configChannel] = null;
                        config[t.configTitleMsg] = null;
                        config[t.configMsg] = null;
                    }
                    configUpdated = true;
                    continue;
                }
                continue;
            }
        }
        if (!channel) continue;

        const res = await cleanLeaderboardChannel(channel, client, types, config, guildId);
        totalCleaned += res.cleanedCount;
        if (res.configUpdated) configUpdated = true;
    }

    if (configUpdated) {
        await setLeaderboardConfig(guildId, config);
    }

    if (totalCleaned > 0) {
        sysLog('Leaderboard Cleanup Completed', {
            guildId,
            detail: `Cleaned up ${totalCleaned} duplicate or orphaned leaderboard message(s).`
        });
    }

    return { cleanedCount: totalCleaned };
}

/**
 * Sweep duplicate or orphaned leaderboard messages across all configured guilds on startup
 */
export async function cleanupAllLeaderboardChannels(client) {
    if (!client) return { totalCleaned: 0 };
    const { loadGuildConfigs } = await import('../storage/config.js');
    const configs = await loadGuildConfigs().catch(() => ({}));
    const guildIds = Object.keys(configs || {});

    let grandTotal = 0;
    for (const guildId of guildIds) {
        try {
            const res = await cleanupGuildLeaderboards(client, guildId);
            grandTotal += (res?.cleanedCount || 0);
        } catch (err) {
            sysError('Guild Leaderboard Cleanup Failed', err, { guild: guildId });
        }
    }
    return { totalCleaned: grandTotal };
}

/**
 * Send a single leaderboard type immediately (for admin channel selection or preview)
 */
export async function sendLeaderboardPreview(client, channelId, guildId, type) {
    const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return null;

    const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
    if (!channel) return null;

    const permCheck = checkLeaderboardPermissions(channel);
    if (!permCheck.valid) {
        sysWarn('Cannot send leaderboard preview: missing permissions', {
            guildId,
            channelId,
            type,
            detail: permCheck.error,
            missing: permCheck.missing
        });
        return null;
    }

    const { getGuildConfig } = await import('../storage/config.js');
    const guildConfig = await getGuildConfig(guildId) || {};
    const customCoinUrl = getCustomCoinUrl(guildConfig, guildId);

    let payload;
    if (type === 'daily_coins') {
        const { getTopActiveUsers } = await import('../activity/tracker.js');
        const rawData = await getTopActiveUsers(guildId, 50, guild);
        const enrichedData = await enrichUserData(client, guildId, rawData, 'userId');
        const winnersCount = Math.min(Math.max(1, guildConfig?.winnersCount || 1), 5);
        const liveMvpRecipients = rawData.slice(0, winnersCount).map(u => u.userId);
        payload = await buildLeaderboardMessagePayload({
            category: 'daily_coins',
            data: enrichedData,
            mvpRecipients: liveMvpRecipients,
            guildId
        });
    } else if (type === 'coins') {
        const rawData = await getTopCoinUsers(guildId);
        const enrichedData = await enrichUserData(client, guildId, rawData, 'user_id');
        payload = await buildLeaderboardMessagePayload({
            category: 'coins',
            data: enrichedData,
            guildId,
            customCoinUrl
        });
    } else if (type === 'streak') {
        const rawData = await getTopStreakUsers(guildId);
        const enrichedData = await enrichUserData(client, guildId, rawData, 'user_id');
        payload = await buildLeaderboardMessagePayload({
            category: 'streak',
            data: enrichedData,
            guildId
        });
    } else if (type === 'level') {
        const rawData = await getTopLevelUsers(guildId);
        const enrichedData = await enrichUserData(client, guildId, rawData, 'user_id');
        payload = await buildLeaderboardMessagePayload({
            category: 'level',
            data: enrichedData,
            guildId
        });
    } else {
        return null;
    }

    const catKey = (type === 'activity') ? 'daily_coins' : type;
    const titlePayload = buildLeaderboardTitlePayload(catKey, guildId);

    let titleMsg = null;
    try {
        titleMsg = await channel.send(titlePayload);
        const msg = await channel.send(payload);
        return msg.id;
    } catch (err) {
        if (titleMsg) await titleMsg.delete().catch(() => {});
        throw err;
    }
}

// Mutex lock to prevent concurrent duplicate updates for the same guild
const leaderboardUpdateLocks = new Set();

/**
 * Update all leaderboard embeds.
 * Tries to edit existing messages in place. If messages are missing, duplicate, or out of order,
 * it cleans duplicate headers, sweeps invalid fragments, and re-dispatches in strict sequential order.
 * 
 * @param {Client} client - Discord client
 * @param {string} guildId - Guild ID
 * @param {Array} activityData - Explicit activity data for YESTERDAY's MVP. If null, fetches LIVE today data.
 * @param {Array} mvpRecipients - List of MVP user IDs
 */
export async function updateLeaderboards(client, guildId, activityData = null, mvpRecipients = []) {
    if (leaderboardUpdateLocks.has(guildId)) {
        sysLog('Leaderboard Update Skipped', { guildId, detail: 'Update already in progress for this guild.' });
        return;
    }
    leaderboardUpdateLocks.add(guildId);
    const syncStart = performance.now();

    try {
        const config = await getLeaderboardConfig(guildId);
        if (!config) return;

        let guild = client.guilds.cache.get(guildId);
        if (!guild) {
            try {
                guild = await client.guilds.fetch(guildId);
            } catch (err) {
                if (err?.code === 10004 || err?.status === 404) {
                    sysWarn('Pruning stale leaderboard config for departed guild during sync', { guild: guildId, error: err.message });
                    await deleteLeaderboardConfig(guildId);
                    return;
                }
                return;
            }
        }
        if (!guild) return;

        const channelKeys = [
            { type: 'daily_coins', configChannel: 'daily_channel_id', configTitleMsg: 'daily_title_message_id', configMsg: 'daily_message_id', name: 'MVP Champions' },
            { type: 'coins', configChannel: 'coins_channel_id', configTitleMsg: 'coins_title_message_id', configMsg: 'coins_message_id', name: 'Richest Members' },
            { type: 'streak', configChannel: 'streak_channel_id', configTitleMsg: 'streak_title_message_id', configMsg: 'streak_message_id', name: 'Longest Streaks' },
            { type: 'level', configChannel: 'level_channel_id', configTitleMsg: 'level_title_message_id', configMsg: 'level_message_id', name: 'Highest Levels' }
        ];

        const configuredTypes = channelKeys.filter(k => config[k.configChannel]);
        if (configuredTypes.length === 0) return;

        // Group categories sharing the same channel to guarantee sequential message order
        const channelGroups = new Map();
        for (const t of configuredTypes) {
            const cid = config[t.configChannel];
            if (!channelGroups.has(cid)) channelGroups.set(cid, []);
            channelGroups.get(cid).push(t);
        }

        const { getNextCairoHourTimestamp } = await import('../utils/time.js');
        const nextRefreshTimestamp = getNextCairoHourTimestamp();
        const { getGuildConfig } = await import('../storage/config.js');
        const guildConfig = await getGuildConfig(guildId) || {};
        const customCoinUrl = getCustomCoinUrl(guildConfig, guildId);

        let configChangedOverall = false;

        for (const [cid, typesForChannel] of channelGroups.entries()) {
            let channel = guild.channels.cache.get(cid);
            if (!channel) {
                try {
                    channel = await guild.channels.fetch(cid);
                } catch (err) {
                    if (err?.code === 10003 || err?.status === 404) {
                        sysWarn('Pruning stale leaderboard channel config for deleted channel', { guild: guildId, channel: cid });
                        for (const t of typesForChannel) {
                            config[t.configChannel] = null;
                            config[t.configTitleMsg] = null;
                            config[t.configMsg] = null;
                        }
                        configChangedOverall = true;
                        continue;
                    }
                    continue;
                }
            }
            if (!channel) continue;

            // STEP 1: Verify all required permissions upfront before sending or editing anything
            const permCheck = checkLeaderboardPermissions(channel);
            if (!permCheck.valid) {
                sysWarn('Leaderboard channel missing permissions', {
                    guild: guildId,
                    channel: cid,
                    detail: permCheck.error,
                    missing: permCheck.missing
                });
                // Strictly abort processing for this channel — do not send titles or cards!
                continue;
            }

            // STEP 2: Check if existing configured messages are present in Discord
            let messagesIntact = true;
            const titleMsgMap = new Map();
            const cardMsgMap = new Map();

            for (const t of typesForChannel) {
                const titleId = config[t.configTitleMsg];
                const cardId = config[t.configMsg];

                if (!titleId || !cardId) {
                    messagesIntact = false;
                    break;
                }

                const titleMsg = channel.messages.cache?.get?.(titleId) || await channel.messages.fetch(titleId).catch(() => null);
                const cardMsg = channel.messages.cache?.get?.(cardId) || await channel.messages.fetch(cardId).catch(() => null);

                if (!titleMsg || !cardMsg) {
                    messagesIntact = false;
                    break;
                }

                titleMsgMap.set(t.type, titleMsg);
                cardMsgMap.set(t.type, cardMsg);
            }

            // STEP 3: Verify strict monotonic sequence for intact messages:
            // Title 1 < Card 1 < Title 2 < Card 2 < Title 3 < Card 3 ...
            if (messagesIntact) {
                const sequence = [];
                for (const t of typesForChannel) {
                    sequence.push(titleMsgMap.get(t.type).id);
                    sequence.push(cardMsgMap.get(t.type).id);
                }

                if (sequence.length > 1) {
                    for (let i = 0; i < sequence.length - 1; i++) {
                        if (compareSnowflakes(sequence[i], sequence[i + 1]) >= 0) {
                            messagesIntact = false;
                            break;
                        }
                    }
                }
            }

            // STEP 4: Only if NOT intact, attempt channel scan to recover missing IDs or clean orphans
            if (!messagesIntact) {
                const cleanResult = await cleanLeaderboardChannel(channel, client, typesForChannel, config, guildId);
                if (cleanResult.configUpdated) {
                    configChangedOverall = true;
                }

                if (cleanResult.intact && cleanResult.survivingPairs) {
                    messagesIntact = true;
                    for (const t of typesForChannel) {
                        const pair = cleanResult.survivingPairs.get(t.type);
                        if (pair) {
                            titleMsgMap.set(t.type, pair.title);
                            cardMsgMap.set(t.type, pair.card);
                        } else {
                            messagesIntact = false;
                            break;
                        }
                    }
                }

                // If still not intact after scanning, sweep broken messages for this channel
                if (!messagesIntact) {
                    for (const t of typesForChannel) {
                        if (config[t.configTitleMsg]) {
                            const oldT = await channel.messages.fetch(config[t.configTitleMsg]).catch(() => null);
                            if (oldT) await oldT.delete().catch(() => {});
                            config[t.configTitleMsg] = null;
                        }
                        if (config[t.configMsg]) {
                            const oldC = await channel.messages.fetch(config[t.configMsg]).catch(() => null);
                            if (oldC) await oldC.delete().catch(() => {});
                            config[t.configMsg] = null;
                        }
                    }
                    configChangedOverall = true;
                    await setLeaderboardConfig(guildId, config);
                }
            }

            // STEP 5: Build payloads and dispatch or edit messages in strict category sequence
            for (const t of typesForChannel) {
                try {
                    let cardPayload;
                    if (t.type === 'daily_coins') {
                        const { getTopActiveUsers } = await import('../activity/tracker.js');
                        const rawData = activityData || await getTopActiveUsers(guildId, 50, guild);
                        const enrichedData = await enrichUserData(client, guildId, rawData, 'userId');
                        const winnersCount = Math.min(Math.max(1, guildConfig?.winnersCount || 1), 5);
                        const liveMvpRecipients = (mvpRecipients && mvpRecipients.length > 0) ? mvpRecipients : rawData.slice(0, winnersCount).map(u => u.userId);
                        cardPayload = await buildLeaderboardMessagePayload({
                            category: 'daily_coins',
                            data: enrichedData,
                            mvpRecipients: liveMvpRecipients,
                            nextRefreshTimestamp,
                            guildId
                        });
                    } else if (t.type === 'coins') {
                        const rawData = await getTopCoinUsers(guildId);
                        const enrichedData = await enrichUserData(client, guildId, rawData, 'user_id');
                        cardPayload = await buildLeaderboardMessagePayload({
                            category: 'coins',
                            data: enrichedData,
                            nextRefreshTimestamp,
                            guildId,
                            customCoinUrl
                        });
                    } else if (t.type === 'streak') {
                        const rawData = await getTopStreakUsers(guildId);
                        const enrichedData = await enrichUserData(client, guildId, rawData, 'user_id');
                        cardPayload = await buildLeaderboardMessagePayload({
                            category: 'streak',
                            data: enrichedData,
                            nextRefreshTimestamp,
                            guildId
                        });
                    } else if (t.type === 'level') {
                        const rawData = await getTopLevelUsers(guildId);
                        const enrichedData = await enrichUserData(client, guildId, rawData, 'user_id');
                        cardPayload = await buildLeaderboardMessagePayload({
                            category: 'level',
                            data: enrichedData,
                            nextRefreshTimestamp,
                            guildId
                        });
                    }

                    const titlePayload = buildLeaderboardTitlePayload(t.type, guildId);

                    if (messagesIntact && cardMsgMap.get(t.type) && titleMsgMap.get(t.type)) {
                        // Title message is NEVER edited! It stays untouched without '(edited)' indicator.
                        // Only edit the card message in-place
                        const existingCardMsg = cardMsgMap.get(t.type);
                        try {
                            await existingCardMsg.edit(cardPayload);
                        } catch {
                            // In-place edit failed; clean up old title message and re-dispatch atomically
                            const existingTitleMsg = titleMsgMap.get(t.type);
                            if (existingTitleMsg) await existingTitleMsg.delete().catch(() => {});
                            let newTitleMsg = null;
                            try {
                                newTitleMsg = await channel.send(titlePayload);
                                const newCardMsg = await channel.send(cardPayload);
                                config[t.configTitleMsg] = newTitleMsg.id;
                                config[t.configMsg] = newCardMsg.id;
                                configChangedOverall = true;
                                await setLeaderboardConfig(guildId, config);
                            } catch (dispatchErr) {
                                if (newTitleMsg) await newTitleMsg.delete().catch(() => {});
                                throw dispatchErr;
                            }
                        }
                    } else {
                        // Atomic dispatch: send Title first, then Card.
                        // If Card sending fails, delete Title immediately to prevent leaving an orphaned header.
                        let newTitleMsg = null;
                        try {
                            newTitleMsg = await channel.send(titlePayload);
                            const newCardMsg = await channel.send(cardPayload);
                            config[t.configTitleMsg] = newTitleMsg.id;
                            config[t.configMsg] = newCardMsg.id;
                            configChangedOverall = true;
                            await setLeaderboardConfig(guildId, config);
                        } catch (dispatchErr) {
                            if (newTitleMsg) await newTitleMsg.delete().catch(() => {});
                            throw dispatchErr;
                        }
                    }

                    // Pacing delay to remain well under Discord's 5 edits / 5s channel rate limit bucket
                    const isTestEnv = Boolean(
                        process.env.NODE_ENV === 'test' ||
                        process.argv.some(arg => typeof arg === 'string' && (arg.includes('test') || arg.includes('verify_'))) ||
                        process.execArgv?.some(arg => typeof arg === 'string' && arg.includes('test'))
                    );
                    const editPacingMs = isTestEnv ? 0 : 1000;
                    if (editPacingMs > 0) {
                        await new Promise(r => setTimeout(r, editPacingMs));
                    }
                } catch (err) {
                    sysError(`Failed to update ${t.type} leaderboard`, err, { guild: guildId, channel: cid });
                }
            }
        }

        if (configChangedOverall) {
            await setLeaderboardConfig(guildId, config);
        }

        const durationMs = Math.round(performance.now() - syncStart);
        logger.info('SERVER', `Leaderboard synchronization for guild ${guildId} completed in ${durationMs}ms`, { guildId, durationMs });
    } finally {
        leaderboardUpdateLocks.delete(guildId);
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
    const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return null;

    const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
    if (!channel) return null;

    // Verify all required permissions upfront before sending anything
    const permCheck = checkLeaderboardPermissions(channel);
    if (!permCheck.valid) {
        sysWarn('Cannot send single leaderboard: missing channel permissions', {
            guildId,
            channelId,
            type,
            detail: permCheck.error,
            missing: permCheck.missing
        });
        return { error: permCheck.error, missing: permCheck.missing };
    }

    const { getGuildConfig } = await import('../storage/config.js');
    const guildConfig = await getGuildConfig(guildId) || {};
    const customCoinUrl = getCustomCoinUrl(guildConfig, guildId);

    let payload;
    if (type === 'activity' || type === 'daily_coins') {
        const { getTopActiveUsers } = await import('../activity/tracker.js');
        const rawData = await getTopActiveUsers(guildId, 50, guild);
        const enrichedData = await enrichUserData(client, guildId, rawData, 'userId');
        const winnersCount = Math.min(Math.max(1, guildConfig?.winnersCount || 1), 5);
        const liveMvpRecipients = rawData.slice(0, winnersCount).map(u => u.userId);
        payload = await buildLeaderboardMessagePayload({
            category: 'daily_coins',
            data: enrichedData,
            mvpRecipients: liveMvpRecipients,
            guildId
        });
    } else if (type === 'coins') {
        const rawData = await getTopCoinUsers(guildId);
        const enrichedData = await enrichUserData(client, guildId, rawData, 'user_id');
        payload = await buildLeaderboardMessagePayload({
            category: 'coins',
            data: enrichedData,
            guildId,
            customCoinUrl
        });
    } else if (type === 'streak') {
        const rawData = await getTopStreakUsers(guildId);
        const enrichedData = await enrichUserData(client, guildId, rawData, 'user_id');
        payload = await buildLeaderboardMessagePayload({
            category: 'streak',
            data: enrichedData,
            guildId
        });
    } else if (type === 'level') {
        const rawData = await getTopLevelUsers(guildId);
        const enrichedData = await enrichUserData(client, guildId, rawData, 'user_id');
        payload = await buildLeaderboardMessagePayload({
            category: 'level',
            data: enrichedData,
            guildId
        });
    } else {
        return null;
    }

    const catKey = (type === 'activity') ? 'daily_coins' : type;
    const titlePayload = buildLeaderboardTitlePayload(catKey, guildId);

    // Clean up any stale or orphan messages in target channel without wiping other active types
    await cleanLeaderboardChannel(channel, client, null, null, guildId).catch(() => {});

    // Atomic send with rollback
    let titleMessage = null;
    try {
        titleMessage = await channel.send(titlePayload);
        const cardMessage = await channel.send(payload);

        return {
            titleMsgId: titleMessage.id,
            cardMsgId: cardMessage.id,
            id: cardMessage.id
        };
    } catch (err) {
        if (titleMessage) await titleMessage.delete().catch(() => {});
        throw err;
    }
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
        const targetChannels = [
            { chan: dailyChannel, name: 'Daily Activity' },
            { chan: coinsChannel, name: 'Total Coins' },
            { chan: streakChannel, name: 'Highest Streak' }
        ];
        if (levelChannel) {
            targetChannels.push({ chan: levelChannel, name: 'Highest Level' });
        }

        // Verify required permissions on all target channels before dispatching anything
        for (const item of targetChannels) {
            const permCheck = checkLeaderboardPermissions(item.chan);
            if (!permCheck.valid) {
                return interaction.editReply({
                    content: `Cannot configure leaderboards: Missing permissions in <#${item.chan.id}> for ${item.name} (${permCheck.error})`
                });
            }
        }

        const config = {
            daily_channel_id: dailyChannel.id,
            daily_title_message_id: null,
            daily_message_id: null,
            coins_channel_id: coinsChannel.id,
            coins_title_message_id: null,
            coins_message_id: null,
            streak_channel_id: streakChannel.id,
            streak_title_message_id: null,
            streak_message_id: null,
            level_channel_id: levelChannel ? levelChannel.id : null,
            level_title_message_id: null,
            level_message_id: null
        };

        // Post initial visual leaderboard cards with live data
        const { getGuildConfig } = await import('../storage/config.js');
        const guildConfig = await getGuildConfig(guildId) || {};
        const customCoinUrl = getCustomCoinUrl(guildConfig, guildId);

        // Daily - Live Top Active Users
        const { getTopActiveUsers } = await import('../activity/tracker.js');
        const rawActivity = await getTopActiveUsers(guildId, 50, interaction.guild);
        const enrichedActivity = await enrichUserData(interaction.client, guildId, rawActivity, 'userId');
        const winnersCount = Math.min(Math.max(1, guildConfig?.winnersCount || 1), 5);
        const liveMvpRecipients = rawActivity.slice(0, winnersCount).map(u => u.userId);
        const dailyTitlePayload = buildLeaderboardTitlePayload('daily_coins', guildId);

        let dailyTitleMsg = null;
        try {
            dailyTitleMsg = await dailyChannel.send(dailyTitlePayload);
            const dailyPayload = await buildLeaderboardMessagePayload({
                category: 'daily_coins',
                data: enrichedActivity,
                mvpRecipients: liveMvpRecipients,
                guildId
            });
            const dailyMsg = await dailyChannel.send(dailyPayload);
            config.daily_title_message_id = dailyTitleMsg.id;
            config.daily_message_id = dailyMsg.id;
        } catch (err) {
            if (dailyTitleMsg) await dailyTitleMsg.delete().catch(() => {});
            throw err;
        }

        // Coins
        const coinsData = await getTopCoinUsers(guildId);
        const enrichedCoins = await enrichUserData(interaction.client, guildId, coinsData, 'user_id');
        const coinsTitlePayload = buildLeaderboardTitlePayload('coins', guildId);

        let coinsTitleMsg = null;
        try {
            coinsTitleMsg = await coinsChannel.send(coinsTitlePayload);
            const coinsPayload = await buildLeaderboardMessagePayload({
                category: 'coins',
                data: enrichedCoins,
                guildId,
                customCoinUrl
            });
            const coinsMsg = await coinsChannel.send(coinsPayload);
            config.coins_title_message_id = coinsTitleMsg.id;
            config.coins_message_id = coinsMsg.id;
        } catch (err) {
            if (coinsTitleMsg) await coinsTitleMsg.delete().catch(() => {});
            throw err;
        }

        // Streak
        const streakData = await getTopStreakUsers(guildId);
        const enrichedStreak = await enrichUserData(interaction.client, guildId, streakData, 'user_id');
        const streakTitlePayload = buildLeaderboardTitlePayload('streak', guildId);

        let streakTitleMsg = null;
        try {
            streakTitleMsg = await streakChannel.send(streakTitlePayload);
            const streakPayload = await buildLeaderboardMessagePayload({
                category: 'streak',
                data: enrichedStreak,
                guildId
            });
            const streakMsg = await streakChannel.send(streakPayload);
            config.streak_title_message_id = streakTitleMsg.id;
            config.streak_message_id = streakMsg.id;
        } catch (err) {
            if (streakTitleMsg) await streakTitleMsg.delete().catch(() => {});
            throw err;
        }

        // Level (if configured)
        if (levelChannel) {
            const levelData = await getTopLevelUsers(guildId);
            const enrichedLevel = await enrichUserData(interaction.client, guildId, levelData, 'user_id');
            const levelTitlePayload = buildLeaderboardTitlePayload('level', guildId);

            let levelTitleMsg = null;
            try {
                levelTitleMsg = await levelChannel.send(levelTitlePayload);
                const levelPayload = await buildLeaderboardMessagePayload({
                    category: 'level',
                    data: enrichedLevel,
                    guildId
                });
                const levelMsg = await levelChannel.send(levelPayload);
                config.level_title_message_id = levelTitleMsg.id;
                config.level_message_id = levelMsg.id;
            } catch (err) {
                if (levelTitleMsg) await levelTitleMsg.delete().catch(() => {});
                throw err;
            }
        }

        await setLeaderboardConfig(guildId, config);

        const logName = getUserLogName(interaction);
        sendLog(interaction.guild, 'audit', 'cyan', '📊 Leaderboard Config Changed', 
            `**Admin:** \`${logName}\`\n` +
            `**Action:** Initial setup of all leaderboard channels.`
        );

        const coinName = await getCurrencyName(guildId);
        const descLines = [
            `**Daily Activity:** ${dailyChannel}`,
            `**Total ${coinName}:** ${coinsChannel}`,
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

        const coinName = await getCurrencyName(interaction.guildId);
        const embed = new EmbedBuilder()
            .setTitle('Leaderboards')
            .setColor(0x0099FF)
            .addFields(
                { name: 'Daily Activity', value: config.daily_channel_id ? `<#${config.daily_channel_id}>` : '*Not Set*', inline: true },
                { name: `Total ${coinName}`, value: config.coins_channel_id ? `<#${config.coins_channel_id}>` : '*Not Set*', inline: true },
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
