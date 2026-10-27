import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { setMockPool } from '../src/storage/postgres.js';
import {
    departedGuildMembersCache,
    externalUserProfileCache,
    markMemberDeparted,
    clearMemberDeparted,
    getLeaderboardConfig,
    setLeaderboardConfig,
    deleteLeaderboardConfig,
    leaderboardConfigCache,
    updateLeaderboards,
    cleanupGuildLeaderboards,
    DEPARTED_MEMBER_TTL,
    EXTERNAL_USER_PROFILE_TTL
} from '../src/commands/leaderboard.js';

// Setup Mock In-Memory Database
const mockDb = {
    leaderboard_config: new Map(),
    guild_configs: new Map()
};

const mockPool = {
    query: async (sql, params = []) => {
        const text = sql.trim();
        if (text.includes('leaderboard_config')) {
            const guildId = params[0];
            if (text.startsWith('SELECT')) {
                const conf = mockDb.leaderboard_config.get(guildId);
                return { rows: conf ? [conf] : [] };
            }
            if (text.startsWith('INSERT') || text.startsWith('UPDATE')) {
                const existing = mockDb.leaderboard_config.get(guildId) || { guild_id: guildId };
                const updated = {
                    ...existing,
                    guild_id: guildId,
                    daily_channel_id: params[1],
                    daily_title_message_id: params[2],
                    daily_message_id: params[3],
                    coins_channel_id: params[4],
                    coins_title_message_id: params[5],
                    coins_message_id: params[6],
                    streak_channel_id: params[7],
                    streak_title_message_id: params[8],
                    streak_message_id: params[9],
                    level_channel_id: params[10],
                    level_title_message_id: params[11],
                    level_message_id: params[12]
                };
                mockDb.leaderboard_config.set(guildId, updated);
                return { rows: [updated] };
            }
            if (text.startsWith('DELETE')) {
                mockDb.leaderboard_config.delete(guildId);
                return { rows: [] };
            }
        }
        if (text.includes('guild_configs')) {
            return { rows: [{ config: { currency_name: 'Coins' } }] };
        }
        return { rows: [] };
    }
};

setMockPool(mockPool);

test('Leaderboard Performance Optimizations Suite', async (t) => {
    await t.test('departed members caching: eliminates individual guild member fetches and suppresses 429 rate limits', async () => {
        const guildId = 'guild_departed_cache_test';
        const presentUserId = 'user_present_1';
        const departedUserId1 = 'user_departed_1';
        const departedUserId2 = 'user_departed_2';

        let individualMemberFetchCalls = 0;
        let batchMemberFetchCalls = 0;
        let userFetchCalls = 0;

        const mockGuild = {
            id: guildId,
            members: {
                cache: new Map([
                    [presentUserId, {
                        id: presentUserId,
                        displayName: 'Active Member',
                        user: { username: 'ActiveMember' },
                        displayHexColor: '#00FF00',
                        displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/1.png'
                    }]
                ]),
                fetch: async (arg) => {
                    if (arg && arg.user) {
                        batchMemberFetchCalls++;
                        // Bulk fetch only finds presentUserId, not departed users
                        return mockGuild.members.cache;
                    }
                    individualMemberFetchCalls++;
                    const err = new Error('Unknown Member');
                    err.code = 10007;
                    err.status = 404;
                    throw err;
                }
            }
        };

        const mockClient = {
            guilds: {
                cache: new Map([[guildId, mockGuild]]),
                fetch: async () => mockGuild
            },
            users: {
                cache: new Map(),
                fetch: async (uid) => {
                    userFetchCalls++;
                    return {
                        id: uid,
                        username: `Departed_${uid}`,
                        displayName: `Departed Name ${uid}`,
                        displayAvatarURL: () => `https://cdn.discordapp.com/avatars/${uid}.png`
                    };
                }
            }
        };

        // Clear caches for test isolation
        departedGuildMembersCache.delete(`${guildId}:${departedUserId1}`);
        departedGuildMembersCache.delete(`${guildId}:${departedUserId2}`);
        externalUserProfileCache.delete(departedUserId1);
        externalUserProfileCache.delete(departedUserId2);

        // Pass candidate data with 1 present member and 2 departed members
        const testData = [
            { userId: presentUserId, username: 'ActiveMember', score: 1000 },
            { userId: departedUserId1, username: 'OldMember1', score: 800 },
            { userId: departedUserId2, username: 'OldMember2', score: 500 }
        ];

        const mockChannel = {
            id: 'channel_perf_test',
            guild: mockGuild,
            permissionsFor: () => ({ has: () => true }),
            messages: {
                cache: new Map(),
                fetch: async (id) => {
                    if (typeof id === 'string') {
                        return { id, delete: async () => {} };
                    }
                    return new Map();
                }
            },
            send: async () => ({ id: 'msg_' + Date.now(), delete: async () => {} })
        };
        mockGuild.channels = {
            cache: new Map([['channel_perf_test', mockChannel]]),
            fetch: async () => mockChannel
        };

        await setLeaderboardConfig(guildId, {
            daily_channel_id: 'channel_perf_test',
            daily_title_message_id: null,
            daily_message_id: null
        });

        // Trigger leaderboard update with the departed members
        await updateLeaderboards(mockClient, guildId, testData);

        // Verification:
        // 1. guild.members.fetch(uid) must NEVER be called individually!
        assert.equal(individualMemberFetchCalls, 0, 'guild.members.fetch must NEVER be called individually for single users');

        // 2. Departed members must be recorded in departedGuildMembersCache
        assert.ok(departedGuildMembersCache.has(`${guildId}:${departedUserId1}`), 'Departed user 1 must be cached in departedGuildMembersCache');
        assert.ok(departedGuildMembersCache.has(`${guildId}:${departedUserId2}`), 'Departed user 2 must be cached in departedGuildMembersCache');

        // 3. User fetch should have resolved external profiles
        assert.ok(externalUserProfileCache.has(departedUserId1), 'External user profile for user 1 must be cached');
        assert.ok(externalUserProfileCache.has(departedUserId2), 'External user profile for user 2 must be cached');

        const initialUserFetches = userFetchCalls;
        assert.ok(initialUserFetches > 0, 'Initial external user fetch performed once');

        // Second run: cached profiles and departed statuses must avoid any extra fetch calls
        await updateLeaderboards(mockClient, guildId, testData);
        assert.equal(individualMemberFetchCalls, 0, 'guild.members.fetch still zero individual calls');
        assert.equal(userFetchCalls, initialUserFetches, 'externalUserProfileCache prevented redundant client.users.fetch calls');
    });

    await t.test('departed guild pruning: catches 10004 Unknown Guild and deletes stale leaderboard_config', async () => {
        const departedGuildId = 'guild_departed_10004';

        mockDb.leaderboard_config.set(departedGuildId, {
            guild_id: departedGuildId,
            daily_channel_id: 'chan_dead'
        });
        leaderboardConfigCache.set(departedGuildId, mockDb.leaderboard_config.get(departedGuildId));

        const mockClient = {
            guilds: {
                cache: new Map(), // Not in cache
                fetch: async (gid) => {
                    const err = new Error('Unknown Guild');
                    err.code = 10004;
                    err.status = 404;
                    throw err;
                }
            }
        };

        // Calling updateLeaderboards must catch 10004, prune DB and cache, and return cleanly
        await updateLeaderboards(mockClient, departedGuildId);

        assert.equal(mockDb.leaderboard_config.has(departedGuildId), false, 'Stale guild config must be purged from database');
        assert.equal(leaderboardConfigCache.has(departedGuildId), false, 'Stale guild config must be purged from memory cache');
    });

    await t.test('deleted channel pruning: catches 10003 Unknown Channel and nullifies channel config in DB', async () => {
        const guildId = 'guild_channel_deleted_10003';
        const deletedChannelId = 'chan_deleted_10003';

        const config = {
            guild_id: guildId,
            daily_channel_id: deletedChannelId,
            daily_title_message_id: 'title_msg_old',
            daily_message_id: 'card_msg_old',
            coins_channel_id: null
        };
        mockDb.leaderboard_config.set(guildId, { ...config });
        leaderboardConfigCache.set(guildId, { ...config });

        const mockGuild = {
            id: guildId,
            channels: {
                cache: new Map(), // Not in cache
                fetch: async (cid) => {
                    const err = new Error('Unknown Channel');
                    err.code = 10003;
                    err.status = 404;
                    throw err;
                }
            }
        };

        const mockClient = {
            guilds: {
                cache: new Map([[guildId, mockGuild]]),
                fetch: async () => mockGuild
            }
        };

        // Execute updateLeaderboards
        await updateLeaderboards(mockClient, guildId);

        const updatedConfig = mockDb.leaderboard_config.get(guildId);
        assert.ok(updatedConfig, 'Guild config should still exist');
        assert.equal(updatedConfig.daily_channel_id, null, 'Deleted channel ID must be nullified');
        assert.equal(updatedConfig.daily_title_message_id, null, 'Deleted title message ID must be nullified');
        assert.equal(updatedConfig.daily_message_id, null, 'Deleted card message ID must be nullified');
    });
});
