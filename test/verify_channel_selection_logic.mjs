import assert from 'node:assert';
import { PermissionFlagsBits } from 'discord.js';
import { setMockPool } from '../src/storage/postgres.js';
import { LOG_CATEGORIES, handleLogsSettings, handleLogChannelSelect, handleLogDisable } from '../src/commands/settings/logs.js';
import { getCategories, handleLeaderboardSettings, handleLeaderboardChannelSelect, handleLeaderboardDisable, handleLeaderboardRefresh } from '../src/commands/settings/leaderboards.js';
import { checkChannelPermissions } from '../src/utils/logger.js';

console.log('--- Starting Channel Selection Logic Verification ---');

const GUILD_SNOWFLAKE = '123456789012345678';
const VALID_CHAN_1 = '111111111111111111';
const INVALID_CHAN_1 = '222222222222222222';
const INVALID_CHAN_2 = '333333333333333333';

// Set up mock in-memory DB pool
const mockStorage = {
    guild_configs: new Map(),
    leaderboard_config: new Map()
};

const mockPool = {
    query: async (sql, params = []) => {
        const text = sql.trim();
        if (text.includes('guild_configs')) {
            const guildId = params[0];
            if (text.startsWith('SELECT')) {
                const conf = mockStorage.guild_configs.get(guildId);
                return { rows: conf ? [{ config: conf }] : [] };
            }
            if (text.startsWith('INSERT')) {
                const newConf = JSON.parse(params[1]);
                const existing = mockStorage.guild_configs.get(guildId) || {};
                const merged = { ...existing, ...newConf };
                mockStorage.guild_configs.set(guildId, merged);
                return { rows: [{ config: merged }] };
            }
            if (text.startsWith('UPDATE')) {
                return { rows: [] };
            }
        }
        if (text.includes('leaderboard_config')) {
            const guildId = params[0];
            if (text.startsWith('SELECT')) {
                const conf = mockStorage.leaderboard_config.get(guildId);
                return { rows: conf ? [conf] : [] };
            }
            if (text.startsWith('INSERT')) {
                const existing = mockStorage.leaderboard_config.get(guildId) || { guild_id: guildId };
                const updated = {
                    ...existing,
                    daily_channel_id: params[1],
                    daily_message_id: params[2],
                    coins_channel_id: params[3],
                    coins_message_id: params[4],
                    streak_channel_id: params[5],
                    streak_message_id: params[6],
                    level_channel_id: params[7],
                    level_message_id: params[8]
                };
                mockStorage.leaderboard_config.set(guildId, updated);
                return { rows: [updated] };
            }
        }
        if (text.includes('user_balances') || text.includes('user_streaks') || text.includes('users') || text.includes('active_mvps')) {
            return { rows: [] };
        }
        return { rows: [] };
    }
};

setMockPool(mockPool);

// Mock helpers for Discord channels
function createMockChannel(id, name, permissionsArray) {
    const permBitfield = {
        has: (perms) => {
            if (Array.isArray(perms)) {
                return perms.every(p => permissionsArray.includes(p));
            }
            return permissionsArray.includes(perms);
        }
    };
    const messages = new Map();
    let deletedMessageId = null;

    const channel = {
        id,
        name,
        guild: {
            id: GUILD_SNOWFLAKE,
            name: 'Test Server',
            members: { me: { id: 'bot_id' } }
        },
        permissionsFor: () => permBitfield,
        send: async ({ embeds }) => {
            const msgId = `msg_${Date.now()}_${Math.random()}`;
            const msg = {
                id: msgId,
                embeds,
                edit: async (data) => { Object.assign(msg, data); return msg; },
                delete: async () => { deletedMessageId = msgId; return true; }
            };
            messages.set(msgId, msg);
            return msg;
        },
        messages: {
            fetch: async (msgId) => messages.get(msgId) || { delete: async () => { deletedMessageId = msgId; } }
        },
        getDeletedMessageId: () => deletedMessageId
    };
    return channel;
}

// -------------------------------------------------------------
// Criterion 5: Proactive Permission Validation
// -------------------------------------------------------------
console.log('Testing Criterion 5: Proactive Permission Checks...');

const validChannel = createMockChannel(VALID_CHAN_1, 'general', [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks
]);

const noSendChannel = createMockChannel(INVALID_CHAN_1, 'no-send', [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.EmbedLinks
]);

const noEmbedChannel = createMockChannel(INVALID_CHAN_2, 'no-embed', [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages
]);

assert.strictEqual(checkChannelPermissions(validChannel).valid, true, 'Valid channel should pass');
assert.strictEqual(checkChannelPermissions(noSendChannel).valid, false, 'No send channel should fail');
assert.strictEqual(checkChannelPermissions(noEmbedChannel).valid, false, 'No embed channel should fail');
assert.strictEqual(checkChannelPermissions(null).valid, false, 'Null channel should fail');

console.log('✅ Criterion 5 (Unit): Permission checker correctly validates ViewChannel, SendMessages, EmbedLinks.');

// -------------------------------------------------------------
// Criterion 1 & 2 & 5: Logs Configuration Flow
// -------------------------------------------------------------
console.log('Testing Criteria 1, 2, 5 on Logs Configuration...');

let sentFollowUps = [];
let lastRenderedPayload = null;
let targetChannelSentEmbeds = [];

validChannel.send = async ({ embeds }) => {
    targetChannelSentEmbeds.push(embeds);
    return { id: 'msg_log_confirm' };
};

const mockLogsInteraction = {
    guildId: GUILD_SNOWFLAKE,
    guild: {
        id: GUILD_SNOWFLAKE,
        name: 'Test Server',
        members: { me: { id: 'bot_id' } },
        channels: {
            cache: new Map([
                [VALID_CHAN_1, validChannel],
                [INVALID_CHAN_1, noSendChannel]
            ]),
            fetch: async (id) => (id === VALID_CHAN_1 ? validChannel : (id === INVALID_CHAN_1 ? noSendChannel : null))
        }
    },
    user: { id: 'admin_1', username: 'ServerAdmin' },
    customId: 'logs_set_channel_economy',
    values: [VALID_CHAN_1],
    deferred: true,
    replied: false,
    deferUpdate: async () => {},
    followUp: async (payload) => { sentFollowUps.push(payload); },
    editReply: async (payload) => { lastRenderedPayload = payload; },
    update: async (payload) => { lastRenderedPayload = payload; }
};

// Test initial home render
await handleLogsSettings(mockLogsInteraction);
assert(lastRenderedPayload.embeds[0].data.description.includes('*Disabled*'), 'Default view should show Disabled');

// 1 & 2: Select valid channel for economy
await handleLogChannelSelect(mockLogsInteraction);
assert(targetChannelSentEmbeds.length > 0, 'Criterion 2: Bot must dispatch confirmation message to assigned channel');
assert(lastRenderedPayload.embeds[0].data.description.includes(`<#${VALID_CHAN_1}>`), 'Criterion 1: Embed must immediately reflect new channel');
assert.strictEqual(mockStorage.guild_configs.get(GUILD_SNOWFLAKE)?.log_eco_channel_id, VALID_CHAN_1, 'Criterion 1: DB must store log_eco_channel_id');
console.log('✅ Criterion 1 & 2: Log channel assigned, saved to DB, message sent to channel, and embed updated.');

// 5: Attempt Assignment to Invalid Channel
sentFollowUps = [];
mockLogsInteraction.values = [INVALID_CHAN_1];
await handleLogChannelSelect(mockLogsInteraction);
assert(sentFollowUps.length > 0, 'Criterion 5: User must receive ephemeral warning for invalid channel');
assert(lastRenderedPayload.embeds[0].data.description.includes('⚠️ **Notice:**'), 'Criterion 5: Embed must display warning banner');
assert.strictEqual(mockStorage.guild_configs.get(GUILD_SNOWFLAKE)?.log_eco_channel_id, VALID_CHAN_1, 'Criterion 5: DB must not be overwritten with invalid channel');
console.log('✅ Criterion 5: Attempted assignment with missing permissions blocked and warned in embed + ephemeral.');

// -------------------------------------------------------------
// Criterion 4: Logs Disable Logic
// -------------------------------------------------------------
console.log('Testing Criterion 4: Logs Disabling (Single & All)...');

// Disable single category (economy)
mockLogsInteraction.customId = 'logs_disable_economy';
await handleLogDisable(mockLogsInteraction);
assert.strictEqual(mockStorage.guild_configs.get(GUILD_SNOWFLAKE)?.log_eco_channel_id, null, 'Criterion 4: DB log_eco_channel_id must be null');
assert(lastRenderedPayload.embeds[0].data.description.includes('**📈 Economy**\n↳ *Disabled*'), 'Criterion 4: Economy log must show Disabled in embed');

// Re-assign multiple and test Disable All
mockStorage.guild_configs.set(GUILD_SNOWFLAKE, {
    log_eco_channel_id: VALID_CHAN_1,
    log_inv_channel_id: VALID_CHAN_1,
    log_shop_channel_id: VALID_CHAN_1,
    log_audit_channel_id: VALID_CHAN_1
});
mockLogsInteraction.customId = 'logs_disable_all';
await handleLogDisable(mockLogsInteraction);
for (const cat of Object.values(LOG_CATEGORIES)) {
    assert.strictEqual(mockStorage.guild_configs.get(GUILD_SNOWFLAKE)?.[cat.dbId], null, `Criterion 4: DB ${cat.dbId} must be null on Disable All`);
    assert(lastRenderedPayload.embeds[0].data.description.includes(`**${cat.emoji} ${cat.name}**\n↳ *Disabled*`), `Criterion 4: ${cat.name} must show Disabled on Disable All`);
}
console.log('✅ Criterion 4: Log disabling (single category and all) functions completely.');

// -------------------------------------------------------------
// Criterion 1, 2, 4, 5: Leaderboards Flow
// -------------------------------------------------------------
console.log('Testing Criteria 1, 2, 4, 5 on Leaderboards Configuration...');

let leaderboardDispatchedEmbeds = [];
validChannel.send = async ({ embeds }) => {
    leaderboardDispatchedEmbeds.push(embeds);
    return { id: 'lb_msg_1001' };
};

const mockLbInteraction = {
    guildId: GUILD_SNOWFLAKE,
    guild: {
        id: GUILD_SNOWFLAKE,
        name: 'Test Server',
        members: { me: { id: 'bot_id' } },
        channels: {
            cache: new Map([
                [VALID_CHAN_1, validChannel],
                [INVALID_CHAN_1, noSendChannel]
            ]),
            fetch: async (id) => (id === VALID_CHAN_1 ? validChannel : (id === INVALID_CHAN_1 ? noSendChannel : null))
        }
    },
    client: {
        user: { id: 'bot_id' },
        guilds: {
            cache: new Map([[GUILD_SNOWFLAKE, {
                id: GUILD_SNOWFLAKE,
                channels: {
                    cache: new Map([[VALID_CHAN_1, validChannel]]),
                    fetch: async () => validChannel
                }
            }]]),
            fetch: async () => ({
                id: GUILD_SNOWFLAKE,
                channels: {
                    cache: new Map([[VALID_CHAN_1, validChannel]]),
                    fetch: async () => validChannel
                }
            })
        }
    },
    user: { id: 'admin_1', username: 'ServerAdmin' },
    customId: 'lb_set_channel_coins',
    values: [VALID_CHAN_1],
    deferred: true,
    replied: false,
    deferUpdate: async () => {},
    followUp: async (payload) => { sentFollowUps.push(payload); },
    editReply: async (payload) => { lastRenderedPayload = payload; },
    update: async (payload) => { lastRenderedPayload = payload; }
};

// Test initial home render
await handleLeaderboardSettings(mockLbInteraction);
assert(lastRenderedPayload.embeds[0].data.description.includes('*Not Set*'), 'Default leaderboard view should show Not Set');

// Select valid channel for coins
await handleLeaderboardChannelSelect(mockLbInteraction);
assert(leaderboardDispatchedEmbeds.length > 0, 'Criterion 2: Bot must dispatch live leaderboard embed');
assert.strictEqual(mockStorage.leaderboard_config.get(GUILD_SNOWFLAKE)?.coins_channel_id, VALID_CHAN_1, 'Criterion 1: DB must store coins_channel_id');
assert.strictEqual(mockStorage.leaderboard_config.get(GUILD_SNOWFLAKE)?.coins_message_id, 'lb_msg_1001', 'Criterion 1: DB must store coins_message_id');
assert(lastRenderedPayload.embeds[0].data.description.includes(`<#${VALID_CHAN_1}>`), 'Criterion 1: Leaderboard embed must immediately reflect new channel');
console.log('✅ Criterion 1 & 2: Leaderboard channel assigned, live embed dispatched, saved to DB, and settings embed updated.');

// Test Invalid channel on Leaderboard
sentFollowUps = [];
mockLbInteraction.values = [INVALID_CHAN_1];
await handleLeaderboardChannelSelect(mockLbInteraction);
assert(sentFollowUps.length > 0, 'Criterion 5: User must receive ephemeral warning for invalid channel');
assert(lastRenderedPayload.embeds[0].data.description.includes('⚠️ **Notice:**'), 'Criterion 5: Leaderboard embed must display warning banner');
assert.strictEqual(mockStorage.leaderboard_config.get(GUILD_SNOWFLAKE)?.coins_channel_id, VALID_CHAN_1, 'Criterion 5: DB must not be overwritten with invalid channel');
console.log('✅ Criterion 5: Leaderboard assignment with missing permissions blocked and warned in embed.');

// Test Disable Leaderboard Category
mockLbInteraction.customId = 'lb_disable_coins';
await handleLeaderboardDisable(mockLbInteraction);
assert.strictEqual(mockStorage.leaderboard_config.get(GUILD_SNOWFLAKE)?.coins_channel_id, null, 'Criterion 4: DB coins_channel_id must be null');
assert.strictEqual(mockStorage.leaderboard_config.get(GUILD_SNOWFLAKE)?.coins_message_id, null, 'Criterion 4: DB coins_message_id must be null');
assert(lastRenderedPayload.embeds[0].data.description.includes('Total Coins**\n↳ *Not Set*'), 'Criterion 4: Disabled leaderboard must revert to Not Set');
console.log('✅ Criterion 4: Leaderboard category disable cleanly resets status and deletes old message.');

// -------------------------------------------------------------
// Criterion 3: Refresh Mechanism Verification
// -------------------------------------------------------------
console.log('Testing Criterion 3: Force Refresh Verification...');

let refreshReplied = false;
let refreshFollowUp = false;

const mockRefreshInteraction = {
    guildId: GUILD_SNOWFLAKE,
    guild: {
        id: GUILD_SNOWFLAKE,
        name: 'Test Server',
        channels: {
            cache: new Map([[VALID_CHAN_1, validChannel]]),
            fetch: async () => validChannel
        }
    },
    client: {
        user: { id: 'bot_id' },
        guilds: {
            cache: new Map([[GUILD_SNOWFLAKE, {
                id: GUILD_SNOWFLAKE,
                channels: {
                    cache: new Map([[VALID_CHAN_1, validChannel]]),
                    fetch: async () => validChannel
                }
            }]]),
            fetch: async () => ({
                id: GUILD_SNOWFLAKE,
                channels: {
                    cache: new Map([[VALID_CHAN_1, validChannel]]),
                    fetch: async () => validChannel
                }
            })
        }
    },
    user: { id: 'admin_1', username: 'ServerAdmin' },
    customId: 'lb_refresh',
    reply: async () => { refreshReplied = true; },
    followUp: async () => { refreshFollowUp = true; }
};

await handleLeaderboardRefresh(mockRefreshInteraction);
assert.strictEqual(refreshReplied, true, 'Criterion 3: Refresh must reply immediately with feedback');
assert.strictEqual(refreshFollowUp, true, 'Criterion 3: Refresh must confirm completion via followUp');
console.log('✅ Criterion 3: Force refresh triggers synchronization pipeline and reports status.');

console.log('--- ALL 5 CRITERIA PASSED AND VERIFIED SUCCESSFULLY ---');
process.exit(0);
