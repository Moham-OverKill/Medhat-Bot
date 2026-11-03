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
    assert.equal(hint.title, 'HINT: Server Lockdown');
    assert.ok(hint.description.includes('What it does:'));
    assert.ok(hint.description.includes('Whitelisted Channels:'));
    assert.ok(hint.description.includes('1-Click Restore:'));
    assert.ok(hint.description.includes('Safe & Reversible:'));
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
    const editedOverwrites = [];

    const mockChannel1 = {
      id: 'c1',
      name: 'general',
      type: ChannelType.GuildText,
      permissionOverwrites: {
        cache: new Map([
          [guildA, {
            id: guildA,
            type: OverwriteType.Role,
            allow: new PermissionsBitField(1024n), // ViewChannel allowed
            deny: new PermissionsBitField(0n)
          }],
          ['role_member', {
            id: 'role_member',
            type: OverwriteType.Role,
            allow: new PermissionsBitField(1024n), // ViewChannel allowed
            deny: new PermissionsBitField(0n)
          }],
          ['role_muted', {
            id: 'role_muted',
            type: OverwriteType.Role,
            allow: new PermissionsBitField(0n),
            deny: new PermissionsBitField(1024n) // Already denied
          }]
        ]),
        edit: async (targetId, options) => {
          editedOverwrites.push({ channelId: 'c1', targetId, options });
        }
      }
    };

    const mockChannelWhitelist = {
      id: 'c_white',
      name: 'announcements',
      type: ChannelType.GuildAnnouncement,
      permissionOverwrites: {
        cache: new Map(),
        edit: async (targetId, options) => {
          editedOverwrites.push({ channelId: 'c_white', targetId, options });
        }
      }
    };

    const mockGuild = {
      id: guildA,
      name: 'Lockdown Guild',
      members: {
        me: {
          permissions: { has: () => true }
        }
      },
      channels: {
        cache: new Map([
          ['c1', mockChannel1],
          ['c_white', mockChannelWhitelist]
        ])
      }
    };

    const result = await executeServerLockdown(mockGuild, adminUser, ['c_white']);

    assert.equal(result.success, true);
    assert.equal(result.lockedCount, 1);
    assert.equal(result.whitelistedCount, 1);

    // Verify whitelisted channel was NOT touched
    const touchedWhitelist = editedOverwrites.filter(o => o.channelId === 'c_white');
    assert.equal(touchedWhitelist.length, 0, 'Whitelisted channels must be completely untouched');

    // Verify c1 overwrites: @everyone set to ViewChannel: false, role_member set to ViewChannel: false, role_muted ignored!
    const c1Edits = editedOverwrites.filter(o => o.channelId === 'c1');
    assert.equal(c1Edits.length, 2, 'Must only edit @everyone and allowed role_member');

    assert.ok(c1Edits.some(e => e.targetId === guildA && e.options.ViewChannel === false));
    assert.ok(c1Edits.some(e => e.targetId === 'role_member' && e.options.ViewChannel === false));
    assert.ok(!c1Edits.some(e => e.targetId === 'role_muted'), 'role_muted must be ignored');
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

    // Verify synthesized overwrite was deleted
    assert.equal(deletedOverwrites.length, 1);
    assert.equal(deletedOverwrites[0].targetId, 'synth_role');

    // Verify pre-existing @everyone overwrite was restored to allow: 1024, deny: 0
    assert.equal(restoredOverwrites.length, 1);
    assert.equal(restoredOverwrites[0].targetId, guildA);
    assert.equal(restoredOverwrites[0].options.allow, 1024n);
    assert.equal(restoredOverwrites[0].options.deny, 0n);

    // Verify guild settings were restored
    assert.ok(editedGuildSettings);
    assert.equal(editedGuildSettings.name, 'Original Guild Name');

    // Verify database backups were purged
    const remainingBackups = await getServerChannelPermissionBackups(guildA);
    assert.equal(remainingBackups.length, 0);

    const postState = await getServerPauseState(guildA);
    assert.equal(postState.is_paused, false);
  });

  it('8. UI Panels: showPauseConfirmScreen and showUnpauseConfirmScreen render confirmation controls', async () => {
    let confirmPayload = null;
    let unpausePayload = null;

    const mockInteraction = {
      guildId: guildA,
      deferred: true,
      editReply: async (payload) => {
        confirmPayload = payload;
        return payload;
      }
    };

    await showPauseConfirmScreen(mockInteraction);

    assert.ok(confirmPayload);
    assert.equal(confirmPayload.embeds[0].data.title, '⚠️ Confirm Server Lockdown');
    const buttons = confirmPayload.components[0].components;
    assert.equal(buttons[0].data.custom_id, 'pause_cancel_prompt');
    assert.equal(buttons[0].data.style, ButtonStyle.Secondary);
    assert.equal(buttons[1].data.custom_id, 'pause_execute_lockdown');
    assert.equal(buttons[1].data.style, ButtonStyle.Danger);

    mockInteraction.editReply = async (payload) => {
      unpausePayload = payload;
      return payload;
    };

    await showUnpauseConfirmScreen(mockInteraction);

    assert.ok(unpausePayload);
    assert.equal(unpausePayload.embeds[0].data.title, '🟢 Confirm Server Unpause');
    const unpauseButtons = unpausePayload.components[0].components;
    assert.equal(unpauseButtons[0].data.custom_id, 'pause_cancel_unpause_prompt');
    assert.equal(unpauseButtons[0].data.style, ButtonStyle.Secondary);
    assert.equal(unpauseButtons[1].data.custom_id, 'pause_execute_unpause');
    assert.equal(unpauseButtons[1].data.style, ButtonStyle.Success);
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

  after(async () => {
    await closeDatabase().catch(() => {});
  });
});
