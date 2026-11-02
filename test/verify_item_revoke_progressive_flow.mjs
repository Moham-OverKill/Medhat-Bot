import test from 'node:test';
import assert from 'node:assert/strict';
import { ButtonStyle, PermissionFlagsBits } from 'discord.js';

import { handleRevokeItemStart, handleRevokeItemConfirm } from '../src/commands/shop-setup.js';
import { setMockPool } from '../src/storage/postgres.js';

test('Progressive Item Revoke Flow Test Suite', async (t) => {
  t.afterEach(() => {
    setMockPool(null);
  });

  await t.test('1. handleRevokeItemStart displays State 1 Confirm Revoke with Back and Confirm buttons', async () => {
    let editReplyArgs = null;

    setMockPool({
      query: async (sql, params) => {
        if (sql.includes('FROM shop_items')) {
          return {
            rows: [{
              id: 42,
              name: 'Diamond Ticket',
              role_id: '999888777',
              guild_id: '123456789'
            }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 0 };
      }
    });

    const mockInteraction = {
      customId: 'shop_item_revoke_42',
      guildId: '123456789',
      deferred: false,
      replied: false,
      deferUpdate: async () => { mockInteraction.deferred = true; },
      editReply: async (payload) => { editReplyArgs = payload; return payload; },
      followUp: async () => {}
    };

    await handleRevokeItemStart(mockInteraction);

    assert.ok(editReplyArgs, 'editReply should be called');
    assert.equal(editReplyArgs.embeds.length, 1);
    const embed = editReplyArgs.embeds[0];
    assert.equal(embed.data.title, 'Confirm Revoke');
    assert.match(embed.data.description, /Diamond Ticket/);
    assert.match(embed.data.description, /Remove it from every user's inventory/);
    assert.match(embed.data.description, /Strip the item's role from all members/);

    const components = editReplyArgs.components;
    assert.equal(components.length, 1);
    const buttons = components[0].components;
    assert.equal(buttons.length, 2);
    assert.equal(buttons[0].data.label, 'Back');
    assert.equal(buttons[0].data.custom_id, 'shop_item_tab_users_42');
    assert.equal(buttons[1].data.label, 'Confirm Revoke');
    assert.equal(buttons[1].data.custom_id, 'shop_item_revoke_confirm_42');
    assert.equal(buttons[1].data.style, ButtonStyle.Danger);
  });

  await t.test('2. Pre-flight check halts if bot lacks ManageRoles permission', async () => {
    let editReplyArgs = null;
    let dbDeleteExecuted = false;

    setMockPool({
      query: async (sql, params) => {
        if (sql.includes('FROM shop_items')) {
          return {
            rows: [{
              id: 42,
              name: 'Diamond Ticket',
              role_id: '999888777',
              guild_id: '123456789'
            }],
            rowCount: 1
          };
        }
        if (sql.includes('DELETE FROM user_inventory')) {
          dbDeleteExecuted = true;
        }
        return { rows: [], rowCount: 0 };
      }
    });

    const mockRole = {
      id: '999888777',
      position: 5,
      editable: true,
      members: new Map()
    };

    const mockInteraction = {
      customId: 'shop_item_revoke_confirm_42',
      guildId: '123456789',
      deferred: false,
      replied: false,
      deferUpdate: async () => { mockInteraction.deferred = true; },
      editReply: async (payload) => { editReplyArgs = payload; return payload; },
      guild: {
        roles: {
          cache: new Map([['999888777', mockRole]])
        },
        members: {
          me: {
            permissions: { has: (perm) => perm !== PermissionFlagsBits.ManageRoles },
            roles: { highest: { position: 10 } }
          }
        }
      }
    };

    await handleRevokeItemConfirm(mockInteraction);

    assert.ok(editReplyArgs, 'editReply should be called');
    assert.equal(editReplyArgs.embeds[0].data.title, 'Cannot Revoke Item');
    assert.match(editReplyArgs.embeds[0].data.description, /lacks the \*\*Manage Roles\*\* permission/);
    assert.equal(dbDeleteExecuted, false, 'Database deletion must not execute when permissions fail');
    assert.equal(editReplyArgs.components[0].components[0].data.label, 'Back');
  });

  await t.test('3. Pre-flight check halts if role is higher than or equal to bot highest role', async () => {
    let editReplyArgs = null;
    let dbDeleteExecuted = false;

    setMockPool({
      query: async (sql, params) => {
        if (sql.includes('FROM shop_items')) {
          return {
            rows: [{
              id: 42,
              name: 'Diamond Ticket',
              role_id: '999888777',
              guild_id: '123456789'
            }],
            rowCount: 1
          };
        }
        if (sql.includes('DELETE FROM user_inventory')) {
          dbDeleteExecuted = true;
        }
        return { rows: [], rowCount: 0 };
      }
    });

    const mockRole = {
      id: '999888777',
      position: 15, // higher than bot (10)
      editable: false,
      members: new Map()
    };

    const mockInteraction = {
      customId: 'shop_item_revoke_confirm_42',
      guildId: '123456789',
      deferred: false,
      replied: false,
      deferUpdate: async () => { mockInteraction.deferred = true; },
      editReply: async (payload) => { editReplyArgs = payload; return payload; },
      guild: {
        roles: {
          cache: new Map([['999888777', mockRole]])
        },
        members: {
          me: {
            permissions: { has: () => true },
            roles: { highest: { position: 10 } }
          }
        }
      }
    };

    await handleRevokeItemConfirm(mockInteraction);

    assert.ok(editReplyArgs, 'editReply should be called');
    assert.equal(editReplyArgs.embeds[0].data.title, 'Cannot Revoke Item');
    assert.match(editReplyArgs.embeds[0].data.description, /higher than or equal to the bot's highest role/);
    assert.equal(dbDeleteExecuted, false, 'Database deletion must not execute when hierarchy fails');
  });

  await t.test('4. Full execution progresses through State 2 (Loading, no buttons) to State 3 (Done, Back button)', async () => {
    const editReplyCalls = [];
    let dbDeleted = false;
    const removedRoles = [];

    // User 1, User 2 (from DB) and User 3 (manual role holder in Discord!)
    const member1 = {
      id: 'user_1',
      roles: {
        cache: new Map([['111222333', true]]),
        remove: async (rid) => { removedRoles.push({ userId: 'user_1', rid }); }
      }
    };
    const member2 = {
      id: 'user_2',
      roles: {
        cache: new Map([['111222333', true]]),
        remove: async (rid) => { removedRoles.push({ userId: 'user_2', rid }); }
      }
    };
    const member3 = {
      id: 'user_3', // Manual role holder! Not in DB user_inventory
      roles: {
        cache: new Map([['111222333', true]]),
        remove: async (rid) => { removedRoles.push({ userId: 'user_3', rid }); }
      }
    };

    const mockRole = {
      id: '111222333',
      position: 5,
      editable: true,
      members: new Map([
        ['user_1', member1],
        ['user_2', member2],
        ['user_3', member3]
      ])
    };

    setMockPool({
      query: async (sql, params) => {
        if (sql.includes('FROM shop_items')) {
          return {
            rows: [{
              id: 42,
              name: 'Black Card',
              role_id: '111222333',
              guild_id: '123456789'
            }],
            rowCount: 1
          };
        }
        if (sql.includes('SELECT DISTINCT user_id FROM user_inventory')) {
          return { rows: [{ user_id: 'user_1' }, { user_id: 'user_2' }] };
        }
        if (sql.includes('DELETE FROM user_inventory')) {
          dbDeleted = true;
          return { rowCount: 2 };
        }
        if (sql.includes('SELECT COUNT(*)::int as count')) {
          return { rows: [{ count: 0 }] };
        }
        return { rows: [] };
      }
    });

    const mockInteraction = {
      customId: 'shop_item_revoke_confirm_42',
      guildId: '123456789',
      deferred: false,
      replied: false,
      user: { id: 'admin_123' },
      deferUpdate: async () => { mockInteraction.deferred = true; },
      editReply: async (payload) => {
        editReplyCalls.push({
          embedTitle: payload.embeds[0]?.data?.title,
          embedDesc: payload.embeds[0]?.data?.description,
          embedColor: payload.embeds[0]?.data?.color,
          componentsCount: payload.components?.length || 0,
          buttons: payload.components?.[0]?.components?.map(c => c.data.label) || []
        });
        return payload;
      },
      guild: {
        roles: {
          cache: new Map([['111222333', mockRole]])
        },
        members: {
          me: {
            permissions: { has: () => true },
            roles: { highest: { position: 10 } }
          },
          cache: new Map([
            ['user_1', member1],
            ['user_2', member2],
            ['user_3', member3]
          ]),
          fetch: async () => new Map([
            ['user_1', member1],
            ['user_2', member2],
            ['user_3', member3]
          ])
        }
      }
    };

    await handleRevokeItemConfirm(mockInteraction);

    // Verify call sequence:
    // Call 1: State 2 (Loading)
    // Call 2: State 3 (Done)
    assert.equal(editReplyCalls.length, 2, 'Should have exactly 2 editReply updates (Loading -> Done)');

    const loadingCall = editReplyCalls[0];
    assert.equal(loadingCall.embedTitle, 'Revoking in Progress...');
    assert.match(loadingCall.embedDesc, /Removing <@&111222333> from \*\*3\*\* members \(including manual assignments\)\.\.\./);
    assert.match(loadingCall.embedDesc, /Removing `Black Card` from \*\*2\*\* user inventories\.\.\./);
    assert.equal(loadingCall.componentsCount, 0, 'State 2 must hide all buttons (components: [])');

    // Verify all 3 members had roles stripped sequentially including the manual user_3
    assert.equal(removedRoles.length, 3, 'All 3 members must have roles removed');
    assert.deepEqual(removedRoles.map(r => r.userId), ['user_1', 'user_2', 'user_3']);

    // Verify DB deletion was executed
    assert.equal(dbDeleted, true, 'Database inventory deletion must be executed');

    // Call 2: State 3 (Success)
    const successCall = editReplyCalls[1];
    assert.match(successCall.embedDesc, /✅ \*\*Black Card\*\* has been revoked from all users/);
    assert.equal(successCall.componentsCount, 1, 'State 3 must provide ActionRow with Back button');
    assert.deepEqual(successCall.buttons, ['Back']);
  });
});
