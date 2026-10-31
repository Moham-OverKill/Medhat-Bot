import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import {
  handleAdminHubComponent,
  handleInterfaceComponent,
  showAdminInterfaceSettings,
  showInterfaceSettings
} from '../src/commands/interface.js';
import { setMockPool } from '../src/storage/postgres.js';

describe('Admin Dashboard Stability & Ephemeral Message Invariants Suite', () => {
  const validGuildId = '123456789012345678';
  const validUserId = '649702547459670017';

  it('1. admin_hub_* must strictly deferReply with MessageFlags.Ephemeral and never deferUpdate', async () => {
    let deferredWithFlags = null;
    let deferUpdateCalled = false;
    let editReplyPayload = null;

    const mockInteraction = {
      guildId: validGuildId,
      user: { id: validUserId, tag: 'Admin#0001' },
      guild: {
        id: validGuildId,
        ownerId: validUserId,
        members: {
          cache: new Map(),
          fetch: async () => ({ permissions: { has: () => true } })
        },
        channels: { cache: new Map(), fetch: async () => null }
      },
      member: { permissions: { has: () => true } },
      customId: 'admin_hub_dashboard',
      deferred: false,
      replied: false,
      deferReply: async (options) => {
        mockInteraction.deferred = true;
        deferredWithFlags = options?.flags;
      },
      deferUpdate: async () => {
        deferUpdateCalled = true;
        mockInteraction.deferred = true;
      },
      editReply: async (payload) => {
        editReplyPayload = payload;
        return payload;
      },
      _adminVerified: true
    };

    setMockPool({
      query: async (sql) => {
        if (sql.includes('server_interface_config')) {
          return {
            rows: [{
              admin_is_enabled: true,
              admin_target_channel_id: '999888777666555444',
              admin_message_id: '111222333444555666'
            }]
          };
        }
        return { rows: [] };
      }
    });

    await handleAdminHubComponent(mockInteraction);

    assert.equal(deferUpdateCalled, false, 'deferUpdate must NEVER be called on admin_hub_* interactions');
    assert.equal(deferredWithFlags, MessageFlags.Ephemeral, 'admin_hub_* must defer with Ephemeral flag');
    assert.ok(editReplyPayload, 'editReply must be called with response payload');
    assert.equal(editReplyPayload.embeds[0].data.title, 'Dashboard', 'Must render Dashboard embed in ephemeral reply');
  });

  it('2. admin_hub_customize modal must open directly without any deferral', async () => {
    let modalShown = null;
    let deferReplyCalled = false;
    let deferUpdateCalled = false;

    const mockInteraction = {
      guildId: validGuildId,
      user: { id: validUserId },
      guild: {
        id: validGuildId,
        ownerId: validUserId,
        members: {
          me: { nickname: 'Bot', avatarURL: () => null },
          cache: new Map(),
          fetch: async () => ({ permissions: { has: () => true } })
        }
      },
      member: { permissions: { has: () => true } },
      customId: 'admin_hub_customize',
      deferred: false,
      replied: false,
      deferReply: async () => { deferReplyCalled = true; },
      deferUpdate: async () => { deferUpdateCalled = true; },
      showModal: async (m) => { modalShown = m; return m; },
      _adminVerified: true
    };

    setMockPool({
      query: async () => ({ rows: [{ config: {} }] })
    });

    await handleAdminHubComponent(mockInteraction);

    assert.equal(deferReplyCalled, false, 'deferReply must not be called for modals');
    assert.equal(deferUpdateCalled, false, 'deferUpdate must not be called for modals');
    assert.ok(modalShown, 'Modal must be shown directly');
    assert.equal(modalShown.data.title, 'Appearance');
  });

  it('3. admin_interface_disable_btn must never self-delete interaction.message and avoid 10008 Unknown Message', async () => {
    let deletedMessageId = null;
    let followUpCalled = false;
    const sameMsgId = '777888999000111222';

    const mockInteraction = {
      guildId: validGuildId,
      user: { id: validUserId },
      guild: {
        id: validGuildId,
        channels: {
          cache: new Map(),
          fetch: async () => ({
            isTextBased: () => true,
            messages: {
              fetch: async (id) => ({
                id,
                delete: async () => { deletedMessageId = id; }
              })
            }
          })
        }
      },
      customId: 'admin_interface_disable_btn',
      message: { id: sameMsgId },
      deferred: true,
      replied: false,
      deferUpdate: async () => {},
      editReply: async () => {
        // Simulate Discord REST throwing Unknown Message if deleted
        const err = new Error('Unknown Message');
        err.code = 10008;
        throw err;
      },
      followUp: async () => {
        followUpCalled = true;
      }
    };

    setMockPool({
      query: async (sql) => {
        if (sql.includes('SELECT') && sql.includes('server_interface_config')) {
          return {
            rows: [{
              guild_id: validGuildId,
              admin_is_enabled: true,
              admin_target_channel_id: '999888777666555444',
              admin_message_id: sameMsgId
            }]
          };
        }
        return { rows: [{ guild_id: validGuildId }] };
      }
    });

    // Handle disable button
    await handleInterfaceComponent(mockInteraction);

    // Assert interaction.message was protected from deletion
    assert.equal(deletedMessageId, null, 'Must NOT delete interaction.message itself');
    // Assert 10008 error was caught and cleanly redirected to followUp
    assert.equal(followUpCalled, true, 'Must fall back cleanly to followUp when editReply throws 10008');
  });

  it('4. Main Dashboard Settings view strictly preserves 4-button layout [Back] [Disable/Enable] [Setup] [Send/Update]', async () => {
    let payload = null;

    const mockInteraction = {
      guildId: validGuildId,
      deferred: true,
      replied: false,
      guild: { channels: { cache: new Map(), fetch: async () => null } },
      editReply: async (p) => { payload = p; return p; }
    };

    setMockPool({
      query: async () => ({
        rows: [{
          admin_is_enabled: true,
          admin_target_channel_id: null,
          admin_message_id: null
        }]
      })
    });

    await showAdminInterfaceSettings(mockInteraction);

    assert.ok(payload);
    assert.equal(payload.components.length, 2, 'Must have exactly 2 component rows (channel select + button row)');
    const buttonRow = payload.components[1].components;
    assert.equal(buttonRow.length, 4, 'Must have strictly 4 buttons: Back, Toggle, Setup, Send/Update');
    assert.equal(buttonRow[0].data.label, 'Back');
    assert.equal(buttonRow[1].data.label, 'Disable');
    assert.equal(buttonRow[2].data.label, 'Setup');
    assert.equal(buttonRow[3].data.label, 'Send');
  });

  it('5. verifyAdminAccess must bypass database and return true immediately if _adminVerified is true', async () => {
    const { verifyAdminAccess } = await import('../src/storage/admins.js');
    let queryRun = false;
    setMockPool({
      query: async () => {
        queryRun = true;
        return { rows: [] };
      }
    });

    const mockInteraction = {
      _adminVerified: true,
      guildId: validGuildId,
      user: { id: validUserId }
    };

    const hasAccess = await verifyAdminAccess(mockInteraction);
    assert.equal(hasAccess, true, 'Must grant access when pre-verified');
    assert.equal(queryRun, false, 'Must NOT query database when _adminVerified is true');
  });

  it('6. Setup panels showInterfaceSetup and showAdminInterfaceSetup must acknowledge interaction instantly via deferUpdate', async () => {
    const { showInterfaceSetup, showAdminInterfaceSetup } = await import('../src/commands/interface.js');

    let shortcutDeferred = false;
    const shortcutMock = {
      guildId: validGuildId,
      deferred: false,
      replied: false,
      deferUpdate: async () => { shortcutDeferred = true; },
      editReply: async () => {}
    };

    setMockPool({
      query: async () => ({ rows: [] })
    });

    await showInterfaceSetup(shortcutMock);
    assert.equal(shortcutDeferred, true, 'showInterfaceSetup must call deferUpdate when unacknowledged');

    let adminDeferred = false;
    const adminMock = {
      guildId: validGuildId,
      deferred: false,
      replied: false,
      deferUpdate: async () => { adminDeferred = true; },
      editReply: async () => {}
    };

    await showAdminInterfaceSetup(adminMock);
    assert.equal(adminDeferred, true, 'showAdminInterfaceSetup must call deferUpdate when unacknowledged');
  });
});
