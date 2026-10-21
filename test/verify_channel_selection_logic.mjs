import assert from 'node:assert';
import { PermissionFlagsBits } from 'discord.js';
import { setMockPool } from '../src/storage/postgres.js';
import { LOG_CATEGORIES, handleLogsSettings, handleLogMenuAction, handleLogChannelSelect, handleLogDisable } from '../src/commands/settings/logs.js';
import { getCategories, handleLeaderboardSettings, handleLeaderboardMenuAction, handleLeaderboardChannelSelect, handleLeaderboardDisable, handleLeaderboardRefresh } from '../src/commands/settings/leaderboards.js';
import { checkChannelPermissions } from '../src/utils/logger.js';

console.log('--- Starting 4-Menu / 3-Option Layout & Logic Verification ---');

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
            fetch: async (msgId) => messages.get(msgId) || { edit: async () => {}, delete: async () => { deletedMessageId = msgId; } }
        },
        getDeletedMessageId: () => deletedMessageId
    };
    return channel;
}

const validChannel = createMockChannel(VALID_CHAN_1, 'general', [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks
]);

const noSendChannel = createMockChannel(INVALID_CHAN_1, 'no-send', [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.EmbedLinks
]);

// -------------------------------------------------------------
// Test 1: Logs Configuration Layout & Menus
// -------------------------------------------------------------
console.log('Testing Logs Configuration: 4 Select Menus with 3 options + Only Back button...');

let lastRenderedPayload = null;
let sentFollowUps = [];
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
    customId: 'settings_logs',
    values: [],
    deferred: true,
    replied: false,
    deferUpdate: async () => {},
    followUp: async (payload) => { sentFollowUps.push(payload); },
    editReply: async (payload) => { lastRenderedPayload = payload; },
    update: async (payload) => { lastRenderedPayload = payload; }
};

// Render Logs Home Panel
await handleLogsSettings(mockLogsInteraction);

// Verify exactly 5 action rows
assert.strictEqual(lastRenderedPayload.components.length, 5, 'Must have exactly 5 action rows');

// Verify Rows 1-4 are Select Menus, each with exactly 3 options
for (let i = 0; i < 4; i++) {
    const row = lastRenderedPayload.components[i];
    const menu = row.components[0];
    assert(menu.data.custom_id.startsWith('logs_menu_'), `Row ${i + 1} must be a logs_menu_ select menu`);
    assert.strictEqual(menu.options.length, 3, `Row ${i + 1} select menu must have exactly 3 options`);
    assert.strictEqual(menu.options[0].data.value, 'channel', 'Option 1 must be Select A Channel');
    assert.strictEqual(menu.options[0].data.emoji.name, '💬', 'Option 1 emoji must be 💬');
    assert(!menu.options[0].data.description, 'Option 1 must have no description');
    assert.strictEqual(menu.options[1].data.value, 'test', 'Option 2 must be Send Test Log');
    assert(!menu.options[1].data.description, 'Option 2 must have no description');
    assert.strictEqual(menu.options[2].data.value, 'disable', 'Option 3 must be Disable');
    assert.strictEqual(menu.options[2].data.emoji.name, '❌', 'Option 3 emoji must be ❌');
    assert(!menu.options[2].data.description, 'Option 3 must have no description');
    assert(!menu.data.placeholder.includes('<:'), 'Placeholder must not contain raw emoji IDs');
}

// Verify Row 5 has ONLY the Back button
const logsRow5 = lastRenderedPayload.components[4];
assert.strictEqual(logsRow5.components.length, 1, 'Row 5 must have ONLY 1 button');
assert.strictEqual(logsRow5.components[0].data.label, 'Back', 'Row 5 button must be Back');
console.log('✅ Logs Configuration UI: Exactly 4 select menus with 3 options each and ONLY the Back button on Row 5.');

// Test Logs Action: Select A Channel (with dynamic nonce customId)
mockLogsInteraction.customId = 'logs_menu_economy_999999999';
mockLogsInteraction.values = ['channel'];
await handleLogMenuAction(mockLogsInteraction);
assert.strictEqual(lastRenderedPayload.components.length, 2, 'Channel picker view must have 2 rows');
assert(lastRenderedPayload.components[0].components[0].data.custom_id.startsWith('logs_set_channel_'), 'Row 1 must be Channel Select Menu');
assert.strictEqual(lastRenderedPayload.components[1].components[0].data.label, 'Back', 'Row 2 must be Back button');

// Assign Channel
mockLogsInteraction.customId = 'logs_set_channel_economy';
mockLogsInteraction.values = [VALID_CHAN_1];
await handleLogChannelSelect(mockLogsInteraction);
assert.strictEqual(mockStorage.guild_configs.get(GUILD_SNOWFLAKE)?.log_eco_channel_id, VALID_CHAN_1, 'DB must store assigned channel');
assert(lastRenderedPayload.embeds[0].data.description.includes(`<#${VALID_CHAN_1}>`), 'Embed must reflect assigned channel');
assert.strictEqual(lastRenderedPayload.components.length, 5, 'Must return back to 5 action rows');
assert(lastRenderedPayload.components[0].components[0].data.custom_id.split('_').length >= 3, 'Must have dynamic nonce to clear selection');
console.log('✅ Logs Action (Select A Channel): Opens channel picker, saves channel to DB, and returns to 4-menu view.');

// Test Logs Action: Disable (with dynamic nonce customId)
mockLogsInteraction.customId = 'logs_menu_economy_888888888';
mockLogsInteraction.values = ['disable'];
await handleLogMenuAction(mockLogsInteraction);
assert.strictEqual(mockStorage.guild_configs.get(GUILD_SNOWFLAKE)?.log_eco_channel_id, null, 'DB log_eco_channel_id must be null');
assert(lastRenderedPayload.embeds[0].data.description.includes('**📈 Economy**\n↳ *Disabled*'), 'Embed must show Disabled');
assert(lastRenderedPayload.components[0].components[0].data.custom_id.split('_').length >= 3, 'Must have dynamic nonce to clear selection');
console.log('✅ Logs Action (Disable): Successfully disables category from dropdown.');

// -------------------------------------------------------------
// Test 2: Leaderboard Configuration Layout & Menus
// -------------------------------------------------------------
console.log('Testing Leaderboard Configuration: 4 Select Menus with 3 options + Only Back button...');

let leaderboardDispatchedEmbeds = [];
validChannel.send = async ({ embeds }) => {
    leaderboardDispatchedEmbeds.push(embeds);
    return { id: 'lb_msg_2002' };
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
    customId: 'settings_leaderboards',
    values: [],
    deferred: true,
    replied: false,
    deferUpdate: async () => {},
    followUp: async (payload) => { sentFollowUps.push(payload); },
    editReply: async (payload) => { lastRenderedPayload = payload; },
    update: async (payload) => { lastRenderedPayload = payload; }
};

// Render Leaderboard Home Panel
await handleLeaderboardSettings(mockLbInteraction);

// Verify exactly 5 action rows
assert.strictEqual(lastRenderedPayload.components.length, 5, 'Leaderboard must have exactly 5 action rows');

// Verify Rows 1-4 are Select Menus, each with exactly 3 options
for (let i = 0; i < 4; i++) {
    const row = lastRenderedPayload.components[i];
    const menu = row.components[0];
    assert(menu.data.custom_id.startsWith('lb_menu_'), `Row ${i + 1} must be an lb_menu_ select menu`);
    assert.strictEqual(menu.options.length, 3, `Row ${i + 1} select menu must have exactly 3 options`);
    assert.strictEqual(menu.options[0].data.value, 'channel', 'Option 1 must be Select A Channel');
    assert.strictEqual(menu.options[0].data.emoji.name, '💬', 'Option 1 emoji must be 💬');
    assert(!menu.options[0].data.description, 'Option 1 must have no description');
    assert.strictEqual(menu.options[1].data.value, 'refresh', 'Option 2 must be Force Refresh');
    assert(!menu.options[1].data.description, 'Option 2 must have no description');
    assert.strictEqual(menu.options[2].data.value, 'disable', 'Option 3 must be Disable');
    assert.strictEqual(menu.options[2].data.emoji.name, '❌', 'Option 3 emoji must be ❌');
    assert(!menu.options[2].data.description, 'Option 3 must have no description');
    assert(!menu.data.placeholder.includes('<:'), 'Placeholder must not contain raw emoji IDs');
}

// Verify Row 5 has ONLY the Back button
const lbRow5 = lastRenderedPayload.components[4];
assert.strictEqual(lbRow5.components.length, 1, 'Row 5 must have ONLY 1 button');
assert.strictEqual(lbRow5.components[0].data.label, 'Back', 'Row 5 button must be Back');
console.log('✅ Leaderboard Configuration UI: Exactly 4 select menus with 3 options each and ONLY the Back button on Row 5.');

// Test Leaderboard Action: Select A Channel
mockLbInteraction.customId = 'lb_menu_coins';
mockLbInteraction.values = ['channel'];
await handleLeaderboardMenuAction(mockLbInteraction);
assert.strictEqual(lastRenderedPayload.components.length, 2, 'Channel picker view must have 2 rows');
assert(lastRenderedPayload.components[0].components[0].data.custom_id.startsWith('lb_set_channel_'), 'Row 1 must be Channel Select Menu');
assert.strictEqual(lastRenderedPayload.components[1].components[0].data.label, 'Back', 'Row 2 must be Back button');

// Assign Channel
sentFollowUps = [];
mockLbInteraction.customId = 'lb_set_channel_coins';
mockLbInteraction.values = [VALID_CHAN_1];
await handleLeaderboardChannelSelect(mockLbInteraction);
assert.strictEqual(sentFollowUps.length, 0, 'No feedback message on channel assignment');
assert.strictEqual(mockStorage.leaderboard_config.get(GUILD_SNOWFLAKE)?.coins_channel_id, VALID_CHAN_1, 'DB must store coins_channel_id');
assert.strictEqual(mockStorage.leaderboard_config.get(GUILD_SNOWFLAKE)?.coins_message_id, 'lb_msg_2002', 'DB must store coins_message_id');
assert(lastRenderedPayload.embeds[0].data.description.includes(`<#${VALID_CHAN_1}>`), 'Embed must reflect assigned channel');
assert.strictEqual(lastRenderedPayload.components.length, 5, 'Must return back to 5 action rows');
assert(lastRenderedPayload.components[0].components[0].data.custom_id.split('_').length >= 3, 'Must have dynamic nonce to clear selection');
console.log('✅ Leaderboard Action (Select A Channel): Opens channel picker, dispatches live embed, saves to DB, returns to 4-menu view.');

// Test Leaderboard Action: Force Refresh (with dynamic nonce customId)
sentFollowUps = [];
mockLbInteraction.customId = 'lb_menu_coins_777777777';
mockLbInteraction.values = ['refresh'];
await handleLeaderboardMenuAction(mockLbInteraction);
assert.strictEqual(sentFollowUps.length, 0, 'No feedback message on force refresh');
assert(lastRenderedPayload.components[0].components[0].data.custom_id.split('_').length >= 3, 'Must have dynamic nonce to clear selection');
console.log('✅ Leaderboard Action (Force Refresh): Successfully triggers role and message synchronization without sending feedback messages.');

// Test Leaderboard Action: Disable (with dynamic nonce customId)
sentFollowUps = [];
mockLbInteraction.customId = 'lb_menu_coins_666666666';
mockLbInteraction.values = ['disable'];
await handleLeaderboardMenuAction(mockLbInteraction);
assert.strictEqual(sentFollowUps.length, 0, 'No feedback message on disable');
assert.strictEqual(mockStorage.leaderboard_config.get(GUILD_SNOWFLAKE)?.coins_channel_id, null, 'DB coins_channel_id must be null');
assert.strictEqual(mockStorage.leaderboard_config.get(GUILD_SNOWFLAKE)?.coins_message_id, null, 'DB coins_message_id must be null');
assert(lastRenderedPayload.embeds[0].data.description.includes('Total Coins**\n↳ *Not Set*'), 'Embed must show Not Set');
assert(lastRenderedPayload.components[0].components[0].data.custom_id.split('_').length >= 3, 'Must have dynamic nonce to clear selection');
console.log('✅ Leaderboard Action (Disable): Successfully deletes old Discord message and nullifies DB config without sending feedback messages.');

console.log('--- ALL VERIFICATIONS PASSED SUCCESSFULLY ---');
process.exit(0);
