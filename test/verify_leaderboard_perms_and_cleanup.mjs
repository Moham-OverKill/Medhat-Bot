import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { setMockPool } from '../src/storage/postgres.js';
import {
    checkLeaderboardPermissions,
    cleanLeaderboardChannel,
    cleanupGuildLeaderboards,
    cleanupAllLeaderboardChannels,
    updateLeaderboards,
    sendSingleLeaderboard,
    deleteMessagesSafe
} from '../src/commands/leaderboard.js';

// Setup Mock In-Memory Database
const mockDb = {
    leaderboard_config: new Map(),
    guild_configs: new Map(),
    users: new Map()
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
        }
        if (text.includes('guild_configs')) {
            return { rows: [{ config: { currency_name: 'Coins' } }] };
        }
        if (text.includes('user_activity') || text.includes('user_balances') || text.includes('active_mvps')) {
            return { rows: [] };
        }
        return { rows: [] };
    }
};

setMockPool(mockPool);

function createMockDiscordChannel({ id, name, permissions = [], botId = 'bot_user_123' }) {
    const permBitfield = {
        has: (perms) => {
            if (Array.isArray(perms)) {
                return perms.every(p => permissions.includes(p));
            }
            return permissions.includes(perms);
        }
    };

    const messageStore = new Map();
    let currentSnowflake = 100000000000000000n;

    const channel = {
        id,
        name,
        guild: {
            id: 'guild_test_1',
            name: 'Test Guild',
            members: {
                me: { id: botId, permissions: permBitfield }
            }
        },
        permissionsFor: () => permBitfield,
        send: async (payload) => {
            currentSnowflake += 10n;
            const msgId = String(currentSnowflake);
            const msg = {
                id: msgId,
                content: payload.content || '',
                embeds: payload.embeds || [],
                files: payload.files || [],
                attachments: (payload.files || []).map(f => ({ name: f.name || 'file.png' })),
                author: { id: botId },
                createdTimestamp: Date.now(),
                edit: async (newPayload) => {
                    Object.assign(msg, newPayload);
                    return msg;
                },
                delete: async () => {
                    messageStore.delete(msgId);
                    return true;
                }
            };
            messageStore.set(msgId, msg);
            return msg;
        },
        bulkDelete: async (msgs) => {
            const list = Array.isArray(msgs) ? msgs : Array.from(msgs.values());
            for (const m of list) {
                messageStore.delete(m.id);
            }
            return { size: list.length };
        },
        messages: {
            fetch: async (arg) => {
                if (typeof arg === 'string') {
                    return messageStore.get(arg) || null;
                }
                return messageStore;
            }
        },
        _messages: messageStore,
        _nextSnowflake: () => {
            currentSnowflake += 10n;
            return String(currentSnowflake);
        }
    };

    return channel;
}

test('Leaderboard Permissions Pre-Validation Suite', async (t) => {
    await t.test('checkLeaderboardPermissions should fail if AttachFiles is missing', () => {
        const channel = createMockDiscordChannel({
            id: 'chan_no_attach',
            permissions: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.EmbedLinks,
                PermissionFlagsBits.ReadMessageHistory
            ]
        });

        const res = checkLeaderboardPermissions(channel);
        assert.equal(res.valid, false);
        assert.ok(res.missing.includes('Attach Files'));
        assert.ok(res.error.includes('Attach Files'));
    });

    await t.test('checkLeaderboardPermissions should fail if ReadMessageHistory is missing', () => {
        const channel = createMockDiscordChannel({
            id: 'chan_no_history',
            permissions: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.EmbedLinks,
                PermissionFlagsBits.AttachFiles
            ]
        });

        const res = checkLeaderboardPermissions(channel);
        assert.equal(res.valid, false);
        assert.ok(res.missing.includes('Read Message History'));
    });

    await t.test('checkLeaderboardPermissions should succeed if all 5 permissions are granted', () => {
        const channel = createMockDiscordChannel({
            id: 'chan_valid',
            permissions: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.EmbedLinks,
                PermissionFlagsBits.AttachFiles,
                PermissionFlagsBits.ReadMessageHistory
            ]
        });

        const res = checkLeaderboardPermissions(channel);
        assert.equal(res.valid, true);
    });

    await t.test('updateLeaderboards should abort without sending title or card if channel lacks AttachFiles', async () => {
        const channelNoAttach = createMockDiscordChannel({
            id: 'chan_no_attach_exec',
            permissions: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.EmbedLinks,
                PermissionFlagsBits.ReadMessageHistory
            ]
        });

        const guildId = 'guild_missing_perm';
        mockDb.leaderboard_config.set(guildId, {
            guild_id: guildId,
            daily_channel_id: 'chan_no_attach_exec',
            daily_title_message_id: null,
            daily_message_id: null
        });

        const client = {
            user: { id: 'bot_user_123' },
            guilds: {
                cache: new Map([
                    [guildId, {
                        id: guildId,
                        channels: {
                            cache: new Map([['chan_no_attach_exec', channelNoAttach]]),
                            fetch: async (id) => channelNoAttach
                        },
                        members: {
                            cache: new Map(),
                            fetch: async () => null
                        }
                    }]
                ]),
                fetch: async () => null
            }
        };

        await updateLeaderboards(client, guildId);

        // Verify zero messages sent to channel
        assert.equal(channelNoAttach._messages.size, 0, 'No messages should be sent when AttachFiles permission is missing');
    });
});

test('Leaderboard Channel Scanning and Duplicate Cleanup Suite', async (t) => {
    const BOT_ID = 'bot_user_123';

    await t.test('cleanLeaderboardChannel should delete orphaned duplicate title headers', async () => {
        const channel = createMockDiscordChannel({
            id: 'chan_cleanup_test',
            permissions: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.EmbedLinks,
                PermissionFlagsBits.AttachFiles,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.ManageMessages
            ],
            botId: BOT_ID
        });

        // Simulate repeated restarts leaving 5 orphan MVP CHAMPIONS titles
        for (let i = 0; i < 5; i++) {
            const sid = channel._nextSnowflake();
            channel._messages.set(sid, {
                id: sid,
                content: '> # ⭐ MVP CHAMPIONS',
                embeds: [],
                files: [],
                attachments: [],
                author: { id: BOT_ID },
                createdTimestamp: Date.now(),
                delete: async () => { channel._messages.delete(sid); return true; }
            });
        }

        assert.equal(channel._messages.size, 5, 'Initially 5 orphan titles in channel');

        const client = { user: { id: BOT_ID } };
        const types = [{ type: 'daily_coins', configChannel: 'daily_channel_id', configTitleMsg: 'daily_title_message_id', configMsg: 'daily_message_id', name: 'MVP Champions' }];

        const res = await cleanLeaderboardChannel(channel, client, types, null, 'guild_test_1');

        assert.equal(res.cleanedCount, 5, 'Should clean up all 5 orphan titles');
        assert.equal(channel._messages.size, 0, 'Channel should have 0 messages left');
        assert.equal(res.intact, false, 'Channel without cards cannot be intact');
    });

    await t.test('cleanLeaderboardChannel should preserve valid Title + Card pair and delete older duplicates', async () => {
        const channel = createMockDiscordChannel({
            id: 'chan_pair_test',
            permissions: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.EmbedLinks,
                PermissionFlagsBits.AttachFiles,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.ManageMessages
            ],
            botId: BOT_ID
        });

        // 2 older duplicate orphan titles
        for (let i = 0; i < 2; i++) {
            const sid = channel._nextSnowflake();
            channel._messages.set(sid, {
                id: sid,
                content: '> # ⭐ MVP CHAMPIONS',
                embeds: [],
                files: [],
                attachments: [],
                author: { id: BOT_ID },
                createdTimestamp: Date.now(),
                delete: async () => { channel._messages.delete(sid); return true; }
            });
        }

        // 1 valid title followed by 1 valid card
        const validTitleId = channel._nextSnowflake();
        channel._messages.set(validTitleId, {
            id: validTitleId,
            content: '> # ⭐ MVP CHAMPIONS',
            embeds: [],
            files: [],
            attachments: [],
            author: { id: BOT_ID },
            createdTimestamp: Date.now(),
            delete: async () => { channel._messages.delete(validTitleId); return true; }
        });

        const validCardId = channel._nextSnowflake();
        channel._messages.set(validCardId, {
            id: validCardId,
            content: '',
            embeds: [],
            files: [],
            attachments: [{ name: 'daily_coins_leaderboard.png' }],
            author: { id: BOT_ID },
            createdTimestamp: Date.now(),
            edit: async () => {},
            delete: async () => { channel._messages.delete(validCardId); return true; }
        });

        assert.equal(channel._messages.size, 4, 'Initially 4 messages (2 orphan titles + 1 valid pair)');

        const client = { user: { id: BOT_ID } };
        const types = [{ type: 'daily_coins', configChannel: 'daily_channel_id', configTitleMsg: 'daily_title_message_id', configMsg: 'daily_message_id', name: 'MVP Champions' }];
        const config = { daily_channel_id: channel.id, daily_title_message_id: null, daily_message_id: null };

        const res = await cleanLeaderboardChannel(channel, client, types, config, 'guild_test_1');

        assert.equal(res.cleanedCount, 2, 'Should delete only the 2 orphan duplicate titles');
        assert.equal(channel._messages.size, 2, 'Channel should retain exactly the valid pair');
        assert.equal(res.intact, true, 'Channel should be evaluated as intact');
        assert.equal(config.daily_title_message_id, validTitleId, 'Config should adopt valid Title ID');
        assert.equal(config.daily_message_id, validCardId, 'Config should adopt valid Card ID');
    });

    await t.test('Atomic Rollback: sendSingleLeaderboard should delete title if card sending fails', async () => {
        const channel = createMockDiscordChannel({
            id: 'chan_rollback',
            permissions: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.EmbedLinks,
                PermissionFlagsBits.AttachFiles,
                PermissionFlagsBits.ReadMessageHistory
            ],
            botId: BOT_ID
        });

        let sendCount = 0;
        channel.send = async (payload) => {
            sendCount++;
            if (sendCount === 1) {
                // Title message succeeds
                const sid = channel._nextSnowflake();
                const msg = {
                    id: sid,
                    content: payload.content,
                    author: { id: BOT_ID },
                    delete: async () => { channel._messages.delete(sid); return true; }
                };
                channel._messages.set(sid, msg);
                return msg;
            } else {
                // Card payload throws simulated permission / canvas error
                throw new Error('DiscordAPIError[50013]: Missing Permissions');
            }
        };

        const client = {
            user: { id: BOT_ID },
            guilds: {
                cache: new Map([
                    ['guild_rollback', {
                        id: 'guild_rollback',
                        channels: {
                            cache: new Map([[channel.id, channel]]),
                            fetch: async () => channel
                        },
                        members: { cache: new Map(), fetch: async () => null }
                    }]
                ]),
                fetch: async () => null
            }
        };

        await assert.rejects(
            async () => {
                await sendSingleLeaderboard(client, 'guild_rollback', 'daily_coins', channel.id);
            },
            /DiscordAPIError\[50013\]/
        );

        // Verify title message was deleted during rollback
        assert.equal(channel._messages.size, 0, 'Orphaned title must be deleted when card dispatch fails');
    });
});

test('Leaderboard Message Sequence and Startup Cleanup Integration', async (t) => {
    const BOT_ID = 'bot_user_123';

    await t.test('cleanupGuildLeaderboards should automatically clean duplicate headers across guild channels', async () => {
        const channel = createMockDiscordChannel({
            id: 'chan_cron_cleanup',
            permissions: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.EmbedLinks,
                PermissionFlagsBits.AttachFiles,
                PermissionFlagsBits.ReadMessageHistory
            ],
            botId: BOT_ID
        });

        // 3 duplicate headers
        for (let i = 0; i < 3; i++) {
            const sid = channel._nextSnowflake();
            channel._messages.set(sid, {
                id: sid,
                content: '> # ⭐ MVP CHAMPIONS',
                author: { id: BOT_ID },
                createdTimestamp: Date.now(),
                delete: async () => { channel._messages.delete(sid); return true; }
            });
        }

        const guildId = 'guild_cron_test';
        mockDb.leaderboard_config.set(guildId, {
            guild_id: guildId,
            daily_channel_id: channel.id,
            daily_title_message_id: null,
            daily_message_id: null
        });

        const client = {
            user: { id: BOT_ID },
            guilds: {
                cache: new Map([
                    [guildId, {
                        id: guildId,
                        channels: {
                            cache: new Map([[channel.id, channel]]),
                            fetch: async () => channel
                        }
                    }]
                ]),
                fetch: async () => null
            }
        };

        const res = await cleanupGuildLeaderboards(client, guildId);
        assert.equal(res.cleanedCount, 3, 'Should clean 3 orphaned headers on guild cleanup');
        assert.equal(channel._messages.size, 0, 'Channel should be completely cleaned');
    });
});
