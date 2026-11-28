import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { setMockPool } from '../src/storage/postgres.js';
import { sendLog, invalidateLogChannelCache, logger, LogLevel } from '../src/utils/logger.js';
import { configCache, setGuildConfig, getGuildConfig } from '../src/storage/config.js';
import { handleLogsSettings, handleLogMenuAction } from '../src/commands/settings/logs.js';

function createMockChannel(id, opts = {}) {
  const {
    perms = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks
    ],
    sendError = null,
    isText = true
  } = opts;

  const sent = [];
  return {
    id,
    sent,
    isTextBased: () => isText,
    permissionsFor: (member) => {
      if (!member) throw new TypeError('Supplied parameter is not a User nor a Role');
      return {
        has: (flags) => {
          if (Array.isArray(flags)) return flags.every(f => perms.includes(f));
          return perms.includes(flags);
        }
      };
    },
    send: async (payload) => {
      if (sendError) throw sendError;
      sent.push(payload);
      return { id: `msg_${sent.length}` };
    }
  };
}

test('Resilient Log Channel Deletion & Strict Category Isolation Suite', async (t) => {
  const dbConfigs = new Map();
  let dbUpdateCalls = [];

  const mockPool = {
    connect: async () => ({
      query: async (sql, params) => mockPool.query(sql, params),
      release: () => {}
    }),
    query: async (sql, params = []) => {
      const text = sql.trim();
      if (text.includes('guild_configs')) {
        if (text.startsWith('SELECT')) {
          const guildId = params[0];
          const conf = dbConfigs.get(guildId);
          return { rows: conf ? [{ config: { ...conf } }] : [] };
        }
        if (text.startsWith('INSERT INTO guild_configs')) {
          const guildId = params[0];
          const patch = JSON.parse(params[1]);
          const merged = { ...(dbConfigs.get(guildId) || {}), ...patch };
          dbConfigs.set(guildId, merged);
          return { rows: [{ config: { ...merged } }] };
        }
        if (text.includes('SET config = config - $1')) {
          const key = params[0];
          const guildId = params[1];
          dbUpdateCalls.push({ guildId, prunedKey: key });
          const existing = dbConfigs.get(guildId);
          if (existing) {
            delete existing[key];
            return { rowCount: 1, rows: [] };
          }
          return { rowCount: 0, rows: [] };
        }
        if (text.startsWith('UPDATE guild_configs')) {
          return { rowCount: 1, rows: [] };
        }
      }
      return { rowCount: 0, rows: [] };
    }
  };

  setMockPool(mockPool);

  await t.test('1. Deleted economy log channel auto-disables ONLY economy logs (never hits systemChannel or audit channel)', async () => {
    dbConfigs.clear();
    configCache.clear();
    invalidateLogChannelCache();
    dbUpdateCalls = [];

    const guildId = '100000000000000001';
    const ecoChanId = '200000000000000001';
    const auditChanId = '200000000000000002';
    const systemChanId = '200000000000000003';

    dbConfigs.set(guildId, {
      log_eco_channel_id: ecoChanId,
      log_audit_channel_id: auditChanId
    });
    configCache.set(guildId, {
      log_eco_channel_id: ecoChanId,
      log_audit_channel_id: auditChanId
    });

    const auditChannel = createMockChannel(auditChanId);
    const systemChannel = createMockChannel(systemChanId);
    let fetchCallsForDeleted = 0;

    const mockGuild = {
      id: guildId,
      name: 'Isolation Guild',
      systemChannel,
      members: { me: { id: 'bot_1' } },
      channels: {
        cache: new Map([
          [auditChanId, auditChannel],
          [systemChanId, systemChannel]
        ]),
        fetch: async (id) => {
          if (id === ecoChanId) {
            fetchCallsForDeleted++;
            const err = new Error('Unknown Channel');
            err.code = 10003;
            throw err;
          }
          if (id === auditChanId) return auditChannel;
          return null;
        }
      }
    };

    // 1st economy log detects deleted channel -> prunes DB & configCache, skips systemChannel & auditChannel
    await sendLog(mockGuild, 'economy', 'green', 'Daily Claim', 'Earned 100 coins');

    assert.equal(fetchCallsForDeleted, 1, 'Should attempt REST fetch once for deleted channel');
    assert.equal(systemChannel.sent.length, 0, 'Must NEVER fallback to guild.systemChannel');
    assert.equal(auditChannel.sent.length, 0, 'Must NEVER redirect deleted economy log into audit channel');
    assert.equal(dbConfigs.get(guildId).log_eco_channel_id, undefined, 'DB must remove log_eco_channel_id');
    assert.equal(dbConfigs.get(guildId).log_audit_channel_id, auditChanId, 'DB must preserve log_audit_channel_id');
    assert.equal(configCache.get(guildId).log_eco_channel_id, undefined, 'configCache must also clear stale log_eco_channel_id');

    // 2nd economy log sees economy disabled -> zero REST fetches, zero sends anywhere
    await sendLog(mockGuild, 'economy', 'green', 'Second Claim', 'Earned 50 coins');
    assert.equal(fetchCallsForDeleted, 1, 'Disabled category must not retry deleted channel');
    assert.equal(systemChannel.sent.length, 0);
    assert.equal(auditChannel.sent.length, 0);

    // Valid audit log still works normally
    await sendLog(mockGuild, 'audit', 'cyan', 'Audit Action', 'Still active');
    assert.equal(auditChannel.sent.length, 1, 'Valid audit channel must continue receiving audit logs');
  });

  await t.test('2. Unknown Channel (10003) on cached channel.send() prunes key without systemChannel leak', async () => {
    dbConfigs.clear();
    configCache.clear();
    invalidateLogChannelCache();

    const guildId = '100000000000000002';
    const shopChanId = '200000000000000010';
    const systemChanId = '200000000000000011';

    dbConfigs.set(guildId, { log_shop_channel_id: shopChanId });
    configCache.set(guildId, { log_shop_channel_id: shopChanId });

    const err10003 = new Error('Unknown Channel');
    err10003.code = 10003;
    const staleShopChannel = createMockChannel(shopChanId, { sendError: err10003 });
    const systemChannel = createMockChannel(systemChanId);

    const mockGuild = {
      id: guildId,
      name: 'Send Reject Guild',
      systemChannel,
      members: { me: { id: 'bot_1' } },
      channels: {
        cache: new Map([[shopChanId, staleShopChannel], [systemChanId, systemChannel]])
      }
    };

    await sendLog(mockGuild, 'shop', 'blue', 'Item Bought', 'Purchased sword');

    assert.equal(systemChannel.sent.length, 0, 'Must NEVER send to systemChannel on 10003');
    assert.equal(dbConfigs.get(guildId).log_shop_channel_id, undefined, 'Must prune deleted shop channel key');
    assert.equal(configCache.get(guildId).log_shop_channel_id, undefined, 'Must sync configCache');
  });

  await t.test('3. Missing permissions & uncached guild.members.me skip safely without throwing or falling back', async () => {
    dbConfigs.clear();
    configCache.clear();
    invalidateLogChannelCache();

    const guildId = '100000000000000003';
    const invChanId = '200000000000000020';
    const systemChanId = '200000000000000021';

    dbConfigs.set(guildId, { log_inv_channel_id: invChanId });

    // Case A: Missing EmbedLinks permission
    const invChannelNoEmbed = createMockChannel(invChanId, {
      perms: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]
    });
    const systemChannel = createMockChannel(systemChanId);

    const mockGuild = {
      id: guildId,
      name: 'Perms Guild',
      systemChannel,
      members: { me: { id: 'bot_1' } },
      channels: { cache: new Map([[invChanId, invChannelNoEmbed], [systemChanId, systemChannel]]) }
    };

    await sendLog(mockGuild, 'inventory', 'blue', 'Item Used', 'Potion');
    assert.equal(invChannelNoEmbed.sent.length, 0);
    assert.equal(systemChannel.sent.length, 0, 'Missing permissions must NOT fallback to systemChannel');
    assert.equal(dbConfigs.get(guildId).log_inv_channel_id, invChanId, 'Temporary permission issue must preserve configured channel ID');

    // Case B: Uncached guild.members.me (null) and fetchMe returns null -> must NOT throw TypeError
    const originalStderr = process.stderr.write;
    const errorsLogged = [];
    process.stderr.write = (chunk) => { errorsLogged.push(chunk.toString()); return true; };
    try {
      const guildNullMe = {
        id: guildId,
        name: 'Uncached Me Guild',
        systemChannel,
        members: { me: null, fetchMe: async () => null },
        channels: { cache: new Map([[invChanId, createMockChannel(invChanId)]]) }
      };
      await sendLog(guildNullMe, 'inventory', 'blue', 'Item Used', 'Should skip cleanly');
      assert.equal(errorsLogged.length, 0, 'Uncached guild.members.me must not produce ERROR logs');
    } finally {
      process.stderr.write = originalStderr;
    }

    // Case C: Synthetic guild object without .channels -> must NOT throw safeSend Critical error
    const stderrCap2 = [];
    process.stderr.write = (chunk) => { stderrCap2.push(chunk.toString()); return true; };
    try {
      await sendLog({ id: guildId, name: 'Synthetic Guild' }, 'inventory', 'red', 'Item Expired', 'Lazy purge');
      assert.equal(stderrCap2.length, 0, 'Synthetic guild without .channels must not emit ERROR');
    } finally {
      process.stderr.write = originalStderr;
    }
  });

  await t.test('4. Transient REST error during channel fetch preserves admin channel config', async () => {
    dbConfigs.clear();
    configCache.clear();
    invalidateLogChannelCache();

    const guildId = '100000000000000004';
    const ecoChanId = '200000000000000030';
    dbConfigs.set(guildId, { log_eco_channel_id: ecoChanId });

    const mockGuild = {
      id: guildId,
      name: 'Transient Guild',
      members: { me: { id: 'bot_1' } },
      channels: {
        cache: new Map(),
        fetch: async () => {
          const err = new Error('503 Service Unavailable');
          err.status = 503;
          throw err;
        }
      }
    };

    await sendLog(mockGuild, 'economy', 'green', 'Daily Claim', 'Transient outage check');
    assert.equal(dbConfigs.get(guildId).log_eco_channel_id, ecoChanId, 'Transient 503 must NOT wipe configured channel');
  });

  await t.test('5. setGuildConfig immediately invalidates logChannelCache (no 60s stale window)', async () => {
    dbConfigs.clear();
    configCache.clear();
    invalidateLogChannelCache();

    const guildId = '100000000000000005';
    const oldChanId = '200000000000000040';
    const newChanId = '200000000000000041';

    const oldChan = createMockChannel(oldChanId);
    const newChan = createMockChannel(newChanId);
    dbConfigs.set(guildId, { log_audit_channel_id: oldChanId });

    const mockGuild = {
      id: guildId,
      name: 'Cache Sync Guild',
      members: { me: { id: 'bot_1' } },
      channels: { cache: new Map([[oldChanId, oldChan], [newChanId, newChan]]) }
    };

    // Warm logChannelCache with old channel
    await sendLog(mockGuild, 'audit', 'blue', 'Initial Log', 'Old channel');
    assert.equal(oldChan.sent.length, 1);

    // Reassign via setGuildConfig -> immediate next sendLog must hit newChan
    await setGuildConfig(guildId, { log_audit_channel_id: newChanId });
    await sendLog(mockGuild, 'audit', 'blue', 'Updated Log', 'New channel');
    assert.equal(oldChan.sent.length, 1, 'Old channel must not receive logs after config update');
    assert.equal(newChan.sent.length, 1, 'New channel must receive logs immediately without 60s wait');

    // Disable via setGuildConfig -> immediate next sendLog must send nowhere
    await setGuildConfig(guildId, { log_audit_channel_id: null });
    await sendLog(mockGuild, 'audit', 'blue', 'Disabled Log', 'Should drop');
    assert.equal(newChan.sent.length, 1, 'Disabled log category must stop immediately');
  });

  await t.test('6. Logs Settings UI auto-heals offline-deleted channels to *Disabled* on open and Send Test Log', async () => {
    dbConfigs.clear();
    configCache.clear();
    invalidateLogChannelCache();

    const guildId = '100000000000000006';
    const deletedEcoChanId = '200000000000000050';
    const validAuditChanId = '200000000000000051';

    dbConfigs.set(guildId, {
      log_eco_channel_id: deletedEcoChanId,
      log_audit_channel_id: validAuditChanId
    });

    const validAuditChan = createMockChannel(validAuditChanId);
    let rendered = null;

    const mockInteraction = {
      guildId,
      guild: {
        id: guildId,
        name: 'UI Heal Guild',
        members: { me: { id: 'bot_1' } },
        channels: {
          cache: new Map([[validAuditChanId, validAuditChan]]),
          fetch: async (id) => {
            if (id === deletedEcoChanId) {
              const err = new Error('Unknown Channel');
              err.code = 10003;
              throw err;
            }
            if (id === validAuditChanId) return validAuditChan;
            return null;
          }
        }
      },
      user: { id: 'admin_1', username: 'Admin' },
      deferred: true,
      replied: false,
      editReply: async (payload) => { rendered = payload; },
      update: async (payload) => { rendered = payload; },
      followUp: async () => {}
    };

    // Open Logs panel -> offline deleted channel should auto-disable and show *Disabled*
    await handleLogsSettings(mockInteraction);
    assert.ok(rendered.embeds[0].data.description.includes('**📈 Economy**\n↳ *Disabled*'), 'Deleted economy channel must show *Disabled*');
    assert.ok(rendered.embeds[0].data.description.includes(`<#${validAuditChanId}>`), 'Valid audit channel must remain active');
    const refreshedConfig = await getGuildConfig(guildId);
    assert.equal(refreshedConfig.log_eco_channel_id, null, 'Offline deleted channel must be saved as null in config');

    // Now test clicking "Send Test Log" on a channel that was just deleted while still in cache/send rejects with 10003
    const err10003 = new Error('Unknown Channel');
    err10003.code = 10003;
    const staleShopId = '200000000000000052';
    const staleShopChan = createMockChannel(staleShopId, { sendError: err10003 });
    await setGuildConfig(guildId, { log_shop_channel_id: staleShopId });
    mockInteraction.guild.channels.cache.set(staleShopId, staleShopChan);
    mockInteraction.customId = 'logs_menu_shop_12345';
    mockInteraction.values = ['test'];

    await handleLogMenuAction(mockInteraction);
    const afterTestCfg = await getGuildConfig(guildId);
    assert.equal(afterTestCfg.log_shop_channel_id, null, 'Send Test Log hitting 10003 must auto-disable category');
    assert.ok(rendered.embeds[0].data.description.includes('was deleted'), 'UI must notify admin that deleted channel disabled logging');
  });
});
