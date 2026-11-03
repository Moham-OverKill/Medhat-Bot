import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChannelType,
  OverwriteType,
  PermissionFlagsBits,
  PermissionsBitField,
  ButtonStyle,
  MessageFlags
} from 'discord.js';

import {
  getServerPauseState,
  updateServerPauseWhitelist,
  recordServerPauseSnapshot,
  getServerChannelPermissionBackups,
  clearServerPauseSnapshot
} from '../src/storage/pause.js';

import {
  validateLockdownPrerequisites,
  captureGuildSettings,
  executeServerLockdown,
  executeServerUnpause,
  inspectServerUnpauseState,
  ELIGIBLE_CHANNEL_TYPES
} from '../src/commands/settings/pause-engine.js';

import {
  showServerLockdownPanel,
  showPauseConfirmScreen,
  showUnpauseConfirmScreen,
  handlePauseWhitelistSelect
} from '../src/commands/settings/pause.js';

import { ADMIN_SHORTCUT_REGISTRY } from '../src/commands/interface.js';
import { getSettingsHint } from '../src/commands/settings/hints.js';
import { setMockPool, closeDatabase } from '../src/storage/postgres.js';

describe('Server Pause / Lockdown Engine Test Suite', () => {
  const guildA = '111111111111111111';
  const guildB = '222222222222222222';
  const adminUser = { id: '999999999999999999', tag: 'Admin#0001' };

  let mockDb = {
    pause_states: new Map(),
    permission_backups: []
  };

  beforeEach(() => {
    mockDb = {
      pause_states: new Map(),
      permission_backups: []
    };

    setMockPool({
      query: async (sql, params = []) => {
        const cleanSql = sql.replace(/\s+/g, ' ').trim();

        // 1. SELECT FROM server_pause_states
        if (cleanSql.includes('SELECT') && cleanSql.includes('FROM server_pause_states')) {
          const gId = params[0];
          const entry = mockDb.pause_states.get(gId);
          if (entry) return { rows: [entry] };
          return { rows: [] };
        }

        // 2. UPSERT server_pause_states
        if (cleanSql.includes('INSERT INTO server_pause_states')) {
          const gId = params[0];
          let existing = mockDb.pause_states.get(gId) || {
            guild_id: gId,
            is_paused: false,
            paused_at: null,
            whitelist_channel_ids: [],
            server_settings_backup: {}
          };

          if (cleanSql.includes('whitelist_channel_ids')) {
            existing.whitelist_channel_ids = params[1] || [];
          }
          if (cleanSql.includes('server_settings_backup')) {
            existing.is_paused = true;
            existing.paused_at = new Date();
            existing.server_settings_backup = JSON.parse(params[1] || '{}');
          }
          mockDb.pause_states.set(gId, existing);
          return { rows: [existing] };
        }

        // 3. UPDATE server_pause_states (unpause)
        if (cleanSql.includes('UPDATE server_pause_states')) {
          const gId = params[0];
          const existing = mockDb.pause_states.get(gId) || { guild_id: gId };
          existing.is_paused = false;
          existing.server_settings_backup = {};
          mockDb.pause_states.set(gId, existing);
          return { rows: [existing] };
        }

        // 4. DELETE FROM server_channel_permission_backups
        if (cleanSql.includes('DELETE FROM server_channel_permission_backups')) {
          const gId = params[0];
          mockDb.permission_backups = mockDb.permission_backups.filter(b => b.guild_id !== gId);
          return { rows: [] };
        }

        // 5. BULK INSERT INTO server_channel_permission_backups
        if (cleanSql.includes('INSERT INTO server_channel_permission_backups')) {
          const [guildIds, channelIds, targetIds, targetTypes, allowBits, denyBits, wasSynthesized] = params;
          for (let i = 0; i < (guildIds?.length || 0); i++) {
            mockDb.permission_backups.push({
              guild_id: guildIds[i],
              channel_id: channelIds[i],
              target_id: targetIds[i],
              target_type: targetTypes[i],
              original_allow_bits: allowBits[i],
              original_deny_bits: denyBits[i],
              was_synthesized: wasSynthesized[i]
            });
          }
          return { rows: [] };
        }

        // 6. SELECT FROM server_channel_permission_backups
        if (cleanSql.includes('SELECT') && cleanSql.includes('FROM server_channel_permission_backups')) {
          const gId = params[0];
          const rows = mockDb.permission_backups.filter(b => b.guild_id === gId);
          return { rows };
        }

        return { rows: [] };
      },
      connect: async () => {
        return {
          query: async (sql, params) => mockDbQuery(sql, params),
          release: () => {}
        };
      }
    });

    const mockDbQuery = async (sql, params = []) => {
      const cleanSql = sql.replace(/\s+/g, ' ').trim();
      if (cleanSql === 'BEGIN' || cleanSql === 'COMMIT' || cleanSql === 'ROLLBACK') {
        return { rows: [] };
      }
      if (cleanSql.includes('INSERT INTO server_pause_states')) {
        const gId = params[0];
        let existing = mockDb.pause_states.get(gId) || {
          guild_id: gId,
          is_paused: false,
          paused_at: null,
          whitelist_channel_ids: [],
          server_settings_backup: {}
        };
        existing.is_paused = true;
        existing.paused_at = new Date();
        existing.server_settings_backup = JSON.parse(params[1] || '{}');
        mockDb.pause_states.set(gId, existing);
        return { rows: [existing] };
      }
      if (cleanSql.includes('UPDATE server_pause_states')) {
        const gId = params[0];
        const existing = mockDb.pause_states.get(gId) || { guild_id: gId };
        existing.is_paused = false;
        existing.server_settings_backup = {};
        mockDb.pause_states.set(gId, existing);
        return { rows: [existing] };
      }
      if (cleanSql.includes('DELETE FROM server_channel_permission_backups')) {
        const gId = params[0];
        mockDb.permission_backups = mockDb.permission_backups.filter(b => b.guild_id !== gId);
        return { rows: [] };
      }
      if (cleanSql.includes('INSERT INTO server_channel_permission_backups')) {
        const [guildIds, channelIds, targetIds, targetTypes, allowBits, denyBits, wasSynthesized] = params;
        for (let i = 0; i < (guildIds?.length || 0); i++) {
          mockDb.permission_backups.push({
            guild_id: guildIds[i],
            channel_id: channelIds[i],
            target_id: targetIds[i],
            target_type: targetTypes[i],
            original_allow_bits: allowBits[i],
            original_deny_bits: denyBits[i],
            was_synthesized: wasSynthesized[i]
          });
        }
        return { rows: [] };
      }
      return { rows: [] };
    };
  });

  it('1. ADMIN_SHORTCUT_REGISTRY registers pause shortcut with correct metadata', () => {
    const entry = ADMIN_SHORTCUT_REGISTRY.pause;
    assert.ok(entry, 'pause shortcut must be registered');
    assert.equal(entry.id, 'pause');
    assert.equal(entry.name, 'Lockdown');
    assert.equal(entry.label, 'LOCKDOWN');
    assert.equal(entry.emoji, '🛑');
    assert.equal(entry.buttonCustomId, 'admin_hub_pause');
  });

  it('2. getSettingsHint resolves straightforward pause hint', () => {
    const hint = getSettingsHint('pause');
    assert.ok(hint, 'Must resolve pause hint');
    assert.equal(hint.title, 'HINT: Lockdown');
    assert.ok(hint.description.includes('What it does:'));
    assert.ok(hint.description.includes('Whitelisted Channels:'));
    assert.ok(hint.description.includes('1-Click Restore:'));
    assert.ok(hint.description.includes('Safe & Reversible:'));
    assert.ok(hint.description.includes('Only channel view permissions are temporarily changed'));
  });

  it('3. Strict Multi-Tenant Database Isolation: Server A and Server B do not interfere', async () => {
    await updateServerPauseWhitelist(guildA, ['101', '102']);
    await updateServerPauseWhitelist(guildB, ['201']);

    const stateA = await getServerPauseState(guildA);
    const stateB = await getServerPauseState(guildB);

    assert.deepEqual(stateA.whitelist_channel_ids, ['101', '102']);
    assert.deepEqual(stateB.whitelist_channel_ids, ['201']);

    await recordServerPauseSnapshot(guildA, { name: 'Guild A' }, [
      {
        channel_id: '101',
        target_id: guildA,
        target_type: 'role',
        original_allow_bits: '1024',
        original_deny_bits: '0',
        was_synthesized: false
      }
    ]);

    const backupsA = await getServerChannelPermissionBackups(guildA);
    const backupsB = await getServerChannelPermissionBackups(guildB);

    assert.equal(backupsA.length, 1);
    assert.equal(backupsB.length, 0, 'Server B backups must be empty');

    await clearServerPauseSnapshot(guildA);
    const clearedA = await getServerChannelPermissionBackups(guildA);
    assert.equal(clearedA.length, 0);
  });

  it('4. validateLockdownPrerequisites rejects when bot lacks Administrator', () => {
    const mockGuildWithoutAdmin = {
      members: {
        me: {
          permissions: {
            has: (perm) => perm !== PermissionFlagsBits.Administrator
          }
        }
      }
    };
    const res = validateLockdownPrerequisites(mockGuildWithoutAdmin);
    assert.equal(res.valid, false);
    assert.ok(res.error.includes('Administrator'));
  });

  it('5. captureGuildSettings serializes all vital settings', () => {
    const mockGuild = {
      name: 'Test Realm',
      verificationLevel: 2,
      defaultMessageNotifications: 1,
      explicitContentFilter: 2,
      afkChannelId: '999',
      afkTimeout: 300,
      systemChannelId: '888',
      systemChannelFlags: { bitfield: 12n },
      rulesChannelId: '777',
      publicUpdatesChannelId: '666',
      preferredLocale: 'en-US',
      description: 'A cozy server'
    };

    const snapshot = captureGuildSettings(mockGuild);
    assert.equal(snapshot.name, 'Test Realm');
    assert.equal(snapshot.verificationLevel, 2);
    assert.equal(snapshot.afkChannelId, '999');
    assert.equal(snapshot.afkTimeout, 300);
    assert.equal(snapshot.systemChannelFlags, '12');
  });

  it('6. executeServerLockdown excludes whitelisted channels and sets non-whitelisted to deny', async () => {
    const setCallsPerChannel = {};
    const VIEW_CHANNEL = 1024n;

    const makeTestChannel = (id, overwrites) => {
      setCallsPerChannel[id] = [];
      return {
        id,
        type: ChannelType.GuildText,
        permissionOverwrites: {
          cache: new Map(overwrites),
          set: async (arr) => { setCallsPerChannel[id].push(arr); }
        }
      };
    };

    // c1: @everyone (ViewChannel allowed), role_member (ViewChannel allowed), role_muted (ViewChannel denied)
    const mockChannel1 = makeTestChannel('c1', [
      [guildA, {
        id: guildA, type: OverwriteType.Role,
        allow: { bitfield: VIEW_CHANNEL }, deny: { bitfield: 0n },
        has: (bit) => (BigInt(bit) & VIEW_CHANNEL) === VIEW_CHANNEL
      }],
      ['role_member', {
        id: 'role_member', type: OverwriteType.Role,
        allow: { bitfield: VIEW_CHANNEL }, deny: { bitfield: 0n },
        has: (bit) => (BigInt(bit) & VIEW_CHANNEL) === VIEW_CHANNEL
      }],
      ['role_muted', {
        id: 'role_muted', type: OverwriteType.Role,
        allow: { bitfield: 0n }, deny: { bitfield: VIEW_CHANNEL },
        has: () => false
      }]
    ]);

    // c_white: whitelisted — must not be touched
    const mockChannelWhitelist = makeTestChannel('c_white', []);
    mockChannelWhitelist.type = ChannelType.GuildAnnouncement;

    const mockGuild = {
      id: guildA, name: 'Lockdown Guild',
      members: { me: { permissions: { has: () => true } } },
      channels: { cache: new Map([['c1', mockChannel1], ['c_white', mockChannelWhitelist]]) },
      systemChannelFlags: null, verificationLevel: 0
    };

    const result = await executeServerLockdown(mockGuild, adminUser, ['c_white']);

    assert.equal(result.success, true);
    assert.equal(result.lockedCount, 1);
    assert.equal(result.whitelistedCount, 1);

    // Whitelisted channel must be completely untouched
    assert.equal((setCallsPerChannel['c_white'] || []).length, 0, 'Whitelisted channel must never have set() called');

    // c1 must have had set() called exactly once
    assert.equal(setCallsPerChannel['c1'].length, 1, 'c1: set() must be called exactly once');
    const c1Overwrites = setCallsPerChannel['c1'][0];

    // @everyone: ViewChannel must be in deny
    const everyoneEntry = c1Overwrites.find(o => String(o.id) === String(guildA));
    assert.ok(everyoneEntry, '@everyone entry must be present');
    assert.equal(BigInt(everyoneEntry.deny) & VIEW_CHANNEL, VIEW_CHANNEL, '@everyone ViewChannel must be denied');
    assert.equal(BigInt(everyoneEntry.allow) & VIEW_CHANNEL, 0n, '@everyone ViewChannel must NOT be in allow');

    // role_member: was ALLOW — must be flipped to DENY
    const memberEntry = c1Overwrites.find(o => String(o.id) === 'role_member');
    assert.ok(memberEntry, 'role_member entry must be present');
    assert.equal(BigInt(memberEntry.deny) & VIEW_CHANNEL, VIEW_CHANNEL, 'role_member ViewChannel must be denied');
    assert.equal(BigInt(memberEntry.allow) & VIEW_CHANNEL, 0n, 'role_member ViewChannel must NOT remain in allow');

    // role_muted: was already DENY — must still be DENY (unchanged)
    const mutedEntry = c1Overwrites.find(o => String(o.id) === 'role_muted');
    assert.ok(mutedEntry, 'role_muted entry must be present');
    assert.equal(BigInt(mutedEntry.deny) & VIEW_CHANNEL, VIEW_CHANNEL, 'role_muted ViewChannel must remain denied');
  });

  it('7. executeServerUnpause restores bitfields, deletes synthesized overwrites, and handles deleted channels safely', async () => {
    const deletedOverwrites = [];
    const restoredOverwrites = [];

    // Pre-populate DB with backed-up overwrites
    await recordServerPauseSnapshot(guildA, { name: 'Original Guild Name' }, [
      {
        channel_id: 'c1',
        target_id: guildA,
        target_type: 'role',
        original_allow_bits: '1024',
        original_deny_bits: '0',
        was_synthesized: false
      },
      {
        channel_id: 'c1',
        target_id: 'synth_role',
        target_type: 'role',
        original_allow_bits: '0',
        original_deny_bits: '0',
        was_synthesized: true
      },
      {
        channel_id: 'c_deleted', // Channel that was deleted while paused
        target_id: guildA,
        target_type: 'role',
        original_allow_bits: '1024',
        original_deny_bits: '0',
        was_synthesized: false
      }
    ]);

    const mockChannel1 = {
      id: 'c1',
      name: 'general',
      permissionOverwrites: {
        cache: new Map([
          [guildA, {
            id: guildA,
            allow: new PermissionsBitField(0n),
            deny: new PermissionsBitField(1024n)
          }],
          ['synth_role', {
            id: 'synth_role',
            allow: new PermissionsBitField(0n),
            deny: new PermissionsBitField(1024n)
          }]
        ]),
        set: async (overwrites) => {
          restoredOverwrites.push({ channelId: 'c1', overwrites });
        },
        delete: async (targetId) => {
          deletedOverwrites.push({ channelId: 'c1', targetId });
        },
        edit: async (targetId, options) => {
          restoredOverwrites.push({ channelId: 'c1', targetId, options });
        }
      }
    };

    let editedGuildSettings = null;
    const mockGuild = {
      id: guildA,
      name: 'Temp Lockdown Name',
      channels: {
        cache: new Map([
          ['c1', mockChannel1]
        ]),
        fetch: async (id) => {
          if (id === 'c1') return mockChannel1;
          return null; // c_deleted returns null
        }
      },
      edit: async (payload) => {
        editedGuildSettings = payload;
      }
    };

    const unpauseResult = await executeServerUnpause(mockGuild, adminUser);

    assert.equal(unpauseResult.success, true);
    assert.equal(unpauseResult.restoredChannelsCount, 1);
    assert.equal(unpauseResult.skippedChannelsCount, 1, 'Must record 1 deleted channel as safely skipped');

    // Verify pre-existing @everyone overwrite was restored via batch set with allow: '1024', deny: '0'
    // and synthesized overwrite was cleanly omitted
    assert.equal(restoredOverwrites.length, 1);
    const setOverwrites = restoredOverwrites[0].overwrites;
    assert.equal(setOverwrites.length, 1, 'Only pre-existing overwrite must be passed, synthesized must be omitted');
    assert.equal(setOverwrites[0].id, guildA);
    assert.equal(setOverwrites[0].allow, '1024');
    assert.equal(setOverwrites[0].deny, '0');

    // Verify guild settings were restored
    assert.ok(editedGuildSettings);
    assert.equal(editedGuildSettings.name, 'Original Guild Name');

    // Verify database backups were purged
    const remainingBackups = await getServerChannelPermissionBackups(guildA);
    assert.equal(remainingBackups.length, 0);

    const postState = await getServerPauseState(guildA);
    assert.equal(postState.is_paused, false);
  });

  it('8. UI Panels: showPauseConfirmScreen, showUnpauseConfirmScreen, and showServerLockdownPanel render correctly', async () => {
    let confirmPayload = null;
    let unpausePayload = null;
    let panelPayload = null;

    const mockInteraction = {
      guildId: guildA,
      guild: {
        id: guildA,
        channels: { cache: new Map() },
        members: {
          me: {
            permissions: {
              has: (flag) => flag === PermissionFlagsBits.Administrator
            }
          }
        }
      },
      deferred: true,
      editReply: async (payload) => {
        panelPayload = payload;
        return payload;
      }
    };

    // Test unpaused panel state
    await showServerLockdownPanel(mockInteraction);
    assert.ok(panelPayload);
    assert.equal(panelPayload.embeds[0].data.title, 'Lockdown');
    assert.ok(panelPayload.embeds[0].data.description.includes('**Status:** 🟢 **Unpaused**'));
    assert.ok(panelPayload.embeds[0].data.description.includes('**Whitelisted Channels:**'));
    assert.ok(!panelPayload.embeds[0].data.description.includes('Normal (Active)'));
    assert.ok(!panelPayload.embeds[0].data.description.includes('Temporarily hide your server'));
    assert.ok(!panelPayload.embeds[0].data.description.includes('Select channels below'));

    mockInteraction.editReply = async (payload) => {
      confirmPayload = payload;
      return payload;
    };

    await showPauseConfirmScreen(mockInteraction);

    assert.ok(confirmPayload);
    assert.equal(confirmPayload.embeds[0].data.title, '⚠️ Confirm Server Lockdown');
    const buttons = confirmPayload.components[0].components;
    assert.equal(buttons[0].data.custom_id, 'pause_cancel_prompt');
    assert.equal(buttons[0].data.style, ButtonStyle.Secondary);
    assert.equal(buttons[1].data.custom_id, 'pause_execute_lockdown');
    assert.equal(buttons[1].data.style, ButtonStyle.Danger);

    // Setup active paused state in database with a backed-up channel
    mockDb.pause_states.set(guildA, {
      guild_id: guildA,
      is_paused: true,
      paused_at: new Date(),
      whitelist_channel_ids: []
    });
    mockDb.permission_backups.push({
      guild_id: guildA,
      channel_id: 'chan_inspect_1',
      target_id: 'role_test',
      target_type: 'role',
      original_allow_bits: '1024',
      original_deny_bits: '0',
      was_synthesized: false
    });

    mockInteraction.editReply = async (payload) => {
      unpausePayload = payload;
      return payload;
    };

    // Case 1: chan_inspect_1 is missing from guild channels cache (deleted during pause)
    // Preflight inspection detects missing channel and renders inspection warnings
    await showUnpauseConfirmScreen(mockInteraction);

    assert.ok(unpausePayload);
    assert.equal(unpausePayload.embeds[0].data.title, '⚠️ Unpause Inspection Warnings');
    assert.ok(unpausePayload.embeds[0].data.description.includes('Missing / Deleted Channels (1)'));
    const warningButtons = unpausePayload.components[0].components;
    assert.equal(warningButtons[0].data.custom_id, 'pause_cancel_unpause_prompt');
    assert.equal(warningButtons[0].data.label, 'Cancel');
    assert.equal(warningButtons[1].data.custom_id, 'pause_unpause_recheck');
    assert.equal(warningButtons[1].data.label, 'Recheck');
    assert.equal(warningButtons[2].data.custom_id, 'pause_execute_unpause_skip');
    assert.equal(warningButtons[2].data.label, 'Skip');

    // Case 2: Channel is restored/present in guild, no missing permissions -> clean confirm
    const mockChannel = {
      id: 'chan_inspect_1',
      name: 'general',
      type: ChannelType.GuildText,
      permissionOverwrites: {
        cache: new Map([
          ['role_test', {
            id: 'role_test',
            allow: { bitfield: 1024n },
            deny: { bitfield: 0n }
          }]
        ])
      }
    };
    mockInteraction.guild.channels.cache.set('chan_inspect_1', mockChannel);

    await showUnpauseConfirmScreen(mockInteraction);

    assert.ok(unpausePayload);
    assert.equal(unpausePayload.embeds[0].data.title, 'Confirm Server Unpause');
    const cleanButtons = unpausePayload.components[0].components;
    assert.equal(cleanButtons[0].data.custom_id, 'pause_cancel_unpause_prompt');
    assert.equal(cleanButtons[0].data.style, ButtonStyle.Secondary);
    assert.equal(cleanButtons[1].data.custom_id, 'pause_execute_unpause');
    assert.equal(cleanButtons[1].data.style, ButtonStyle.Success);
  });

  it('9. showMainMenu includes Lock Down as the very last option in Moderate select menu', async () => {
    const { showMainMenu } = await import('../src/commands/settings.js');
    let mainMenuPayload = null;

    const mockInteraction = {
      guildId: guildA,
      guild: {
        id: guildA,
        emojis: { cache: new Map() }
      },
      user: { id: adminUser.id },
      member: {
        permissions: {
          has: () => true
        }
      },
      deferred: true,
      editReply: async (payload) => {
        mainMenuPayload = payload;
        return payload;
      }
    };

    await showMainMenu(mockInteraction);

    assert.ok(mainMenuPayload);
    // Row 3 is Moderate menu (Row 0: Shop, Row 1: Fun, Row 2: Moderate)
    const row3 = mainMenuPayload.components[2];
    const selectMenu = row3.components[0];
    const options = selectMenu.options;

    const lastOption = options[options.length - 1];
    assert.equal(lastOption.data.value, 'mod_pause');
    assert.equal(lastOption.data.label, 'Lock Down');
    assert.equal(lastOption.data.emoji.name, '🛑');
  });

  it('10. inspectServerUnpauseState accurately detects missing channels, new channels, and missing bot permissions', async () => {
    const testGuildId = '333333333333333333';
    mockDb.pause_states.set(testGuildId, {
      guild_id: testGuildId,
      is_paused: true,
      paused_at: new Date(),
      whitelist_channel_ids: ['whitelisted_chan']
    });

    mockDb.permission_backups.push(
      {
        guild_id: testGuildId,
        channel_id: 'chan_missing',
        target_id: 'role_everyone',
        target_type: 'role',
        original_allow_bits: '0',
        original_deny_bits: '1024',
        was_synthesized: false
      },
      {
        guild_id: testGuildId,
        channel_id: 'chan_backed_up',
        target_id: 'role_backed_up',
        target_type: 'role',
        original_allow_bits: '1024',
        original_deny_bits: '0',
        was_synthesized: false
      }
    );

    // Mock guild where bot is missing Administrator, chan_missing is gone, chan_backed_up exists but role is deleted, and chan_new exists
    const mockGuildWithIssues = {
      id: testGuildId,
      members: {
        me: {
          permissions: {
            has: () => false // Missing Administrator
          }
        }
      },
      roles: { cache: new Map() }, // role_backed_up is missing
      channels: {
        cache: new Map([
          ['chan_backed_up', {
            id: 'chan_backed_up',
            name: 'general',
            type: ChannelType.GuildText,
            permissionOverwrites: { cache: new Map() }
          }],
          ['chan_new', {
            id: 'chan_new',
            name: 'new-announcements',
            type: ChannelType.GuildText
          }]
        ])
      }
    };

    const inspection = await inspectServerUnpauseState(mockGuildWithIssues);

    assert.equal(inspection.valid, true);
    assert.equal(inspection.hasIssues, true);
    assert.deepEqual(inspection.missingPermissions, ['Administrator']);
    assert.equal(inspection.missingChannels.length, 1);
    assert.equal(inspection.missingChannels[0].id, 'chan_missing');
    assert.equal(inspection.newChannels.length, 1);
    assert.equal(inspection.newChannels[0].id, 'chan_new');
    assert.equal(inspection.missingRoles.length, 1);

    // Now resolve all issues: grant Administrator, add missing channel, add role
    const mockRole = { id: 'role_backed_up', name: 'Member' };
    const mockCleanGuild = {
      id: testGuildId,
      members: {
        me: {
          permissions: {
            has: (flag) => flag === PermissionFlagsBits.Administrator
          }
        }
      },
      roles: {
        cache: new Map([
          ['role_backed_up', mockRole],
          ['role_everyone', { id: 'role_everyone', name: '@everyone' }]
        ])
      },
      channels: {
        cache: new Map([
          ['chan_missing', {
            id: 'chan_missing',
            name: 'rules',
            type: ChannelType.GuildText,
            permissionOverwrites: {
              cache: new Map([
                ['role_everyone', {
                  id: 'role_everyone',
                  allow: { bitfield: 0n },
                  deny: { bitfield: 1024n }
                }]
              ])
            }
          }],
          ['chan_backed_up', {
            id: 'chan_backed_up',
            name: 'general',
            type: ChannelType.GuildText,
            permissionOverwrites: {
              cache: new Map([
                ['role_backed_up', {
                  id: 'role_backed_up',
                  allow: { bitfield: 1024n },
                  deny: { bitfield: 0n }
                }]
              ])
            }
          }]
        ])
      }
    };

    const cleanInspection = await inspectServerUnpauseState(mockCleanGuild);

    assert.equal(cleanInspection.valid, true);
    assert.equal(cleanInspection.hasIssues, false);
    assert.equal(cleanInspection.missingPermissions.length, 0);
    assert.equal(cleanInspection.missingChannels.length, 0);
    assert.equal(cleanInspection.newChannels.length, 0);
    assert.equal(cleanInspection.missingRoles.length, 0);
  });

  it('11. Granular REST Fallback: Restores exact bitfields via rest.put and rest.delete when batch set throws', async () => {
    const adminUser = { id: '999999999999999999', tag: 'Admin#0001' };
    const testGuildId = '888888888888888888';

    await recordServerPauseSnapshot(testGuildId, {}, [
      {
        channel_id: 'c_fail',
        target_id: testGuildId,
        target_type: 'role',
        original_allow_bits: '0',
        original_deny_bits: '2048', // E.g., SendMessages denied, ViewChannel neutral
        was_synthesized: false
      },
      {
        channel_id: 'c_fail',
        target_id: 'synth_target',
        target_type: 'role',
        original_allow_bits: '0',
        original_deny_bits: '0',
        was_synthesized: true
      }
    ]);

    const restPuts = [];
    const restDeletes = [];

    const mockChannelFail = {
      id: 'c_fail',
      name: 'announcements',
      permissionOverwrites: {
        cache: new Map([
          [testGuildId, {
            id: testGuildId,
            allow: new PermissionsBitField(0n),
            deny: new PermissionsBitField(3072n) // ViewChannel + SendMessages denied
          }]
        ]),
        set: async () => {
          throw new Error('Simulated batch set network error');
        }
      },
      client: {
        rest: {
          put: async (route, data) => {
            restPuts.push({ route, data });
          },
          delete: async (route, options) => {
            restDeletes.push({ route, options });
          }
        }
      }
    };

    const mockGuildFail = {
      id: testGuildId,
      name: 'Fallback Guild',
      channels: {
        cache: new Map([['c_fail', mockChannelFail]])
      }
    };

    const result = await executeServerUnpause(mockGuildFail, adminUser);

    assert.equal(result.success, true);
    assert.equal(result.restoredChannelsCount, 1);

    // Verify REST delete was called for synthesized overwrite
    assert.equal(restDeletes.length, 1);
    assert.ok(restDeletes[0].route.includes('synth_target'));

    // Verify REST put was called with exact pre-pause allow/deny bits (SendMessages: 2048 denied, ViewChannel restored)
    assert.equal(restPuts.length, 1);
    assert.equal(restPuts[0].data.body.id, testGuildId);
    assert.equal(restPuts[0].data.body.allow, '0');
    assert.equal(restPuts[0].data.body.deny, '2048');
  });

  // ─────────────────────────────────────────────────────────────
  // Test 12 — Double-lockdown guard (Fix 1)
  // ─────────────────────────────────────────────────────────────
  it('should reject lockdown when server is already paused (double-lockdown guard)', async () => {
    const guildId = 'guild_double_lock';

    // Seed the mock DB: is_paused = TRUE to simulate an already-active lockdown
    mockDb.pause_states.set(guildId, {
      guild_id: guildId,
      is_paused: true,
      paused_at: new Date(),
      whitelist_channel_ids: [],
      server_settings_backup: {}
    });

    const mockGuild = {
      id: guildId,
      name: 'Double Lock Guild',
      channels: { cache: new Map() },
      members: { me: { permissions: { has: () => true } } },
      roles: { cache: new Map() },
      systemChannelFlags: null,
      verificationLevel: 0
    };

    const result = await executeServerLockdown(mockGuild, adminUser, []);

    assert.equal(result.success, false);
    assert.ok(
      result.error.toLowerCase().includes('already') || result.error.toLowerCase().includes('active'),
      `Expected error to mention 'already' or 'active', got: "${result.error}"`
    );

    // The snapshot must NOT have been overwritten — is_paused stays TRUE with original backup
    const state = mockDb.pause_states.get(guildId);
    assert.equal(state.is_paused, true, 'Snapshot must not have been mutated by the rejected lockdown attempt');
  });

  // ─────────────────────────────────────────────────────────────
  // Test 13 — missingRoles deduplication (Fix 3)
  // ─────────────────────────────────────────────────────────────
  it('should deduplicate deleted role IDs in missingRoles across multiple channels', async () => {
    const guildId = 'guild_role_dedup';
    const deletedRoleId = 'role_deleted_001';

    // Seed: is_paused = TRUE
    mockDb.pause_states.set(guildId, {
      guild_id: guildId,
      is_paused: true,
      paused_at: new Date(),
      whitelist_channel_ids: [],
      server_settings_backup: {}
    });

    // The same deleted role appears in backups for 3 different channels
    for (const channelId of ['ch_a', 'ch_b', 'ch_c']) {
      mockDb.permission_backups.push({
        guild_id: guildId,
        channel_id: channelId,
        target_id: deletedRoleId,
        target_type: 'role',
        original_allow_bits: '0',
        original_deny_bits: '0',
        was_synthesized: false
      });
    }

    const makeChannel = (id) => ({
      id,
      type: 0,
      permissionOverwrites: { cache: new Map() }
    });

    const channelMap = new Map([
      ['ch_a', makeChannel('ch_a')],
      ['ch_b', makeChannel('ch_b')],
      ['ch_c', makeChannel('ch_c')]
    ]);

    const mockGuild = {
      id: guildId,
      name: 'Role Dedup Guild',
      channels: {
        cache: channelMap,
        // batch fetch (Optimization 3) — returns the same populated map
        fetch: async () => channelMap
      },
      members: { me: { permissions: { has: () => true } } },
      roles: { cache: new Map() }  // deletedRoleId intentionally NOT present
    };

    const inspection = await inspectServerUnpauseState(mockGuild);

    assert.ok(inspection.valid);
    assert.equal(
      inspection.missingRoles.length,
      1,
      `Expected exactly 1 unique deleted role entry, got ${inspection.missingRoles.length}`
    );
    assert.equal(inspection.missingRoles[0].id, deletedRoleId);
  });

  // ─────────────────────────────────────────────────────────────
  // Test 14 — set([]) clears lockdown overwrite for a synthesized-only channel
  // ─────────────────────────────────────────────────────────────
  it('should call permissionOverwrites.set([]) for a channel that had no pre-pause overwrites', async () => {
    const guildId = 'guild_set_empty';

    // Seed: is_paused = TRUE with only a synthesized @everyone entry
    mockDb.pause_states.set(guildId, {
      guild_id: guildId,
      is_paused: true,
      paused_at: new Date(),
      whitelist_channel_ids: [],
      server_settings_backup: {}
    });
    mockDb.permission_backups.push({
      guild_id: guildId,
      channel_id: 'ch_synth',
      target_id: guildId,
      target_type: 'role',
      original_allow_bits: '0',
      original_deny_bits: '0',
      was_synthesized: true
    });

    const setCallArgs = [];
    const mockChannel = {
      id: 'ch_synth',
      type: 0,
      permissionOverwrites: {
        // Live cache: @everyone ViewChannel DENY left by lockdown
        cache: new Map([[guildId, { id: guildId, allow: { bitfield: 0n }, deny: { bitfield: 1024n } }]]),
        set: async (arr) => { setCallArgs.push(arr); }
      },
      client: { rest: { put: async () => {}, delete: async () => {} } }
    };

    const mockGuild = {
      id: guildId,
      name: 'Set Empty Guild',
      channels: {
        cache: new Map([['ch_synth', mockChannel]]),
        fetch: async (id) => (id ? mockGuild.channels.cache.get(id) ?? null : mockGuild.channels.cache)
      },
      members: { me: { permissions: { has: () => true } } },
      roles: { cache: new Map([[guildId, { id: guildId }]]) }
    };

    const result = await executeServerUnpause(mockGuild, adminUser);

    assert.equal(result.success, true);
    assert.equal(result.restoredChannelsCount, 1);
    assert.equal(setCallArgs.length, 1, 'permissionOverwrites.set() must be called exactly once');
    assert.equal(
      setCallArgs[0].length,
      0,
      'set() must be called with an empty array to remove the lockdown-added @everyone overwrite'
    );
  });

  // ─────────────────────────────────────────────────────────────
  // Test 15 — Lockdown set() approach: one call per channel, correct bitmask carry-forward (Optimization 1)
  // ─────────────────────────────────────────────────────────────
  it('should call permissionOverwrites.set() once per channel with correct bitmasks during lockdown', async () => {
    const guildId = 'guild_lockdown_set';
    const VIEW_CHANNEL = 1024n;
    const SEND_MESSAGES = 2048n;
    const roleId = 'role_view_allowed';

    const setCallsPerChannel = {};

    const makeChannel = (id, overwrites) => {
      setCallsPerChannel[id] = [];
      return {
        id,
        type: 0,
        permissionOverwrites: {
          cache: new Map(overwrites),
          set: async (arr) => { setCallsPerChannel[id].push(arr); }
        }
      };
    };

    // ch_set_1: @everyone has SendMessages allowed; ViewChannel not set.
    // After lockdown: @everyone must have ViewChannel DENY added, SendMessages allow preserved.
    const ch1 = makeChannel('ch_set_1', [
      [guildId, {
        id: guildId,
        type: 0,
        allow: { bitfield: SEND_MESSAGES },
        deny: { bitfield: 0n },
        has: () => false
      }]
    ]);

    // ch_set_2: @everyone neutral + role with ViewChannel|SendMessages allowed.
    // After lockdown: role ViewChannel must flip to DENY; SendMessages allow must be preserved.
    const ch2 = makeChannel('ch_set_2', [
      [guildId, {
        id: guildId,
        type: 0,
        allow: { bitfield: 0n },
        deny: { bitfield: 0n },
        has: () => false
      }],
      [roleId, {
        id: roleId,
        type: 0,
        allow: { bitfield: VIEW_CHANNEL | SEND_MESSAGES },
        deny: { bitfield: 0n },
        has: (bit) => (BigInt(bit) & VIEW_CHANNEL) === VIEW_CHANNEL
      }]
    ]);

    const mockGuild = {
      id: guildId,
      name: 'Lockdown Set Guild',
      channels: { cache: new Map([['ch_set_1', ch1], ['ch_set_2', ch2]]) },
      members: { me: { permissions: { has: () => true } } },
      roles: { cache: new Map([[guildId, { id: guildId }], [roleId, { id: roleId }]]) },
      systemChannelFlags: null,
      verificationLevel: 0
    };

    const result = await executeServerLockdown(mockGuild, adminUser, []);

    assert.equal(result.success, true);
    assert.equal(result.lockedCount, 2, 'Both channels must report as locked');

    // Each channel must have had set() called exactly once (single REST call per channel)
    assert.equal(setCallsPerChannel['ch_set_1'].length, 1, 'ch_set_1: set() must be called exactly once');
    assert.equal(setCallsPerChannel['ch_set_2'].length, 1, 'ch_set_2: set() must be called exactly once');

    // ch_set_1: @everyone entry — ViewChannel forced to DENY, SendMessages allow preserved
    const ch1Sets = setCallsPerChannel['ch_set_1'][0];
    const ch1Everyone = ch1Sets.find(o => String(o.id) === String(guildId));
    assert.ok(ch1Everyone, '@everyone entry must be present in ch_set_1 lockdown set() call');
    assert.equal(BigInt(ch1Everyone.deny) & VIEW_CHANNEL, VIEW_CHANNEL, 'ch_set_1 @everyone: ViewChannel must be in deny');
    assert.equal(BigInt(ch1Everyone.allow) & SEND_MESSAGES, SEND_MESSAGES, 'ch_set_1 @everyone: SendMessages allow must be preserved');

    // ch_set_2: role entry — ViewChannel flipped from ALLOW to DENY, SendMessages allow preserved
    const ch2Sets = setCallsPerChannel['ch_set_2'][0];
    const ch2Role = ch2Sets.find(o => String(o.id) === String(roleId));
    assert.ok(ch2Role, 'Role entry must be present in ch_set_2 lockdown set() call');
    assert.equal(BigInt(ch2Role.deny) & VIEW_CHANNEL, VIEW_CHANNEL, 'ch_set_2 role: ViewChannel must be in deny after lockdown');
    assert.equal(BigInt(ch2Role.allow) & VIEW_CHANNEL, 0n, 'ch_set_2 role: ViewChannel must NOT remain in allow');
    assert.equal(BigInt(ch2Role.allow) & SEND_MESSAGES, SEND_MESSAGES, 'ch_set_2 role: SendMessages allow bit must be preserved');
  });

  after(async () => {
    await closeDatabase().catch(() => {});
  });
});
