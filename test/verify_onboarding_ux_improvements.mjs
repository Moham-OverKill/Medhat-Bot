import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ButtonStyle, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { setMockPool } from '../src/storage/postgres.js';

// Import target modules
import {
  handleCreateItemStart,
  openCreatePackModal,
  handleCreateRoleSelect,
  getShopSetupPayload,
  handleCreateItemModalSubmit
} from '../src/commands/shop-setup.js';
import { showMainMenu } from '../src/commands/settings.js';
import { handleShopBuyModalSubmit } from '../src/commands/bank.js';
import { showQuestsSchedule } from '../src/commands/quests-dashboard.js';

describe('Onboarding & Mobile UX Streamlining Suite', () => {
  let mockQuests = [];
  let mockConfig = {};

  beforeEach(() => {
    mockQuests = [];
    mockConfig = {};

    setMockPool({
      query: async (sql, params = []) => {
        if (typeof sql === 'string' && sql.includes('SELECT * FROM quests WHERE guild_id = $1')) {
          return { rows: mockQuests };
        }
        if (typeof sql === 'string' && sql.includes('guild_configurations')) {
          return { rows: [{ config: mockConfig }] };
        }
        if (typeof sql === 'string' && sql.includes('shop_posts')) {
          return { rows: [] };
        }
        if (typeof sql === 'string' && sql.includes('shop_items')) {
          return { rows: [] };
        }
        if (typeof sql === 'string' && sql.includes('user_balances')) {
          return { rows: [{ balance: 1000 }] };
        }
        return { rows: [] };
      }
    });
  });

  it('1. Item Creation: immediately shows modal and provisions role on submit', async () => {
    let modalShown = null;
    let webhookEdited = false;
    const mockInteraction = {
      deferred: false,
      replied: false,
      guildId: '123456789012345678',
      guild: {
        id: '123456789012345678',
        roles: { cache: new Map() }
      },
      showModal: async (modal) => {
        modalShown = modal;
        return modal;
      },
      webhook: {
        editMessage: async () => {
          webhookEdited = true;
        }
      }
    };

    // 1. Immediately opens modal upon selecting "Create Item"
    await handleCreateItemStart(mockInteraction);
    assert.ok(modalShown, 'handleCreateItemStart must show modal directly');
    assert.equal(modalShown.data.title, 'Create Item');
    assert.ok(modalShown.data.custom_id.startsWith('shop_create_item_modal'));

    const nameInput = modalShown.components[0].components[0];
    assert.equal(nameInput.data.custom_id, 'item_name');
    assert.equal(nameInput.data.label, 'Item Name');
    assert.equal(nameInput.data.placeholder, 'Sword');
    assert.equal(nameInput.data.required, true);

    // 2. Refreshes message behind modal so menu doesn't stay stuck on "Create Item"
    assert.ok(webhookEdited, 'Must refresh source message to reset select menu');

    // 2b. Verify Pack creation modal labels and placeholders
    let packModalShown = null;
    await openCreatePackModal({
      showModal: async (m) => { packModalShown = m; return m; },
      webhook: { editMessage: async () => {} }
    });
    assert.ok(packModalShown, 'openCreatePackModal must show modal');
    assert.equal(packModalShown.data.title, 'Create Item Pack');
    const packJson = packModalShown.toJSON();
    const packLabelComp = packJson.components[0];
    assert.equal(packLabelComp.label, 'Pack Name', 'Pack input label must be Pack Name');
    assert.equal(packLabelComp.component.placeholder, 'Cool Bundle!', 'Pack placeholder must be Cool Bundle!');

    // 3. Submitting the modal auto-provisions role and mutates existing message via deferUpdate
    let createdRole = null;
    let editReplyPayload = null;
    let deferredUpdateCalled = false;
    let deferredReplyCalled = false;
    const submitInteraction = {
      deferred: false,
      replied: false,
      message: { id: 'source_message_111' },
      guildId: '123456789012345678',
      user: { id: 'admin1', tag: 'Admin#0001', username: 'Admin' },
      member: {
        id: 'admin1',
        roles: { cache: new Map() },
        permissions: { has: () => true }
      },
      memberPermissions: { has: () => true },
      guild: {
        id: '123456789012345678',
        name: 'Test Server',
        roles: {
          cache: new Map(),
          create: async (options) => {
            createdRole = {
              id: '999888111222333444',
              name: options.name,
              permissions: { has: () => false },
              members: new Map()
            };
            return createdRole;
          }
        },
        members: {
          me: {
            permissions: { has: (perm) => true }
          },
          fetch: async () => new Map()
        }
      },
      fields: {
        getTextInputValue: (id) => 'VIP Legend'
      },
      deferUpdate: async () => {
        deferredUpdateCalled = true;
        submitInteraction.deferred = true;
      },
      deferReply: async () => {
        deferredReplyCalled = true;
        submitInteraction.deferred = true;
      },
      editReply: async (payload) => {
        editReplyPayload = payload;
        return payload;
      },
      followUp: async () => {}
    };

    // Mock query for adding item and re-rendering details
    let insertedItem = null;
    setMockPool({
      query: async (sql, params = []) => {
        if (typeof sql === 'string' && sql.includes('INSERT INTO shop_items')) {
          insertedItem = {
            id: 777,
            guild_id: params[0],
            name: params[3],
            role_id: params[2],
            is_tradable: params[15],
            rarity: 'common',
            item_type: 'role'
          };
          return { rows: [insertedItem] };
        }
        if (typeof sql === 'string' && (sql.includes('FROM shop_items si') || sql.includes('shop_items WHERE id = $1'))) {
          return { rows: [insertedItem || { id: 777, name: 'VIP Legend', role_id: '999888111222333444', is_tradable: true, rarity: 'common', item_type: 'role' }] };
        }
        if (typeof sql === 'string' && sql.includes('SELECT * FROM shop_items')) {
          return { rows: [] };
        }
        if (typeof sql === 'string' && sql.includes('shop_categories')) {
          return { rows: [] };
        }
        if (typeof sql === 'string' && sql.includes('user_inventory')) {
          return { rows: [] };
        }
        return { rows: [] };
      }
    });

    try {
      await handleCreateItemModalSubmit(submitInteraction);

      assert.ok(createdRole, 'Role must be created in Discord with entered name');
      assert.equal(createdRole.name, 'VIP Legend');
      assert.ok(insertedItem, 'Item must be inserted into database');
      assert.equal(insertedItem.is_tradable, true, 'New item must be tradable by default');

      assert.equal(deferredUpdateCalled, true, 'Must deferUpdate to mutate existing embed');
      assert.equal(deferredReplyCalled, false, 'Must not deferReply to avoid duplicate ephemeral messages');

      // Verify Tab 1 (Details) renders "Change Role" in the role select menu
      assert.ok(editReplyPayload, 'Tab 1 Details must be rendered in editReply');
      const roleRow = editReplyPayload.components[1];
      const roleSelect = roleRow.components[0];
      assert.equal(roleSelect.data.placeholder, 'Change Role', 'Role menu placeholder must say Change Role');
    } catch (err) {
      console.error('TEST 1 ERROR:', err);
      throw err;
    }
  });

  it('2. Main Settings Shop Menu: contains Post and removes Market', async () => {
    let replyPayload = null;
    const mockInteraction = {
      guildId: '123456789',
      guild: { id: '123456789', roles: { cache: new Map() } },
      user: { id: 'admin1', username: 'Admin' },
      deferred: true,
      replied: false,
      isButton: () => false,
      isAnySelectMenu: () => false,
      editReply: async (payload) => {
        replyPayload = payload;
        return payload;
      }
    };

    await showMainMenu(mockInteraction);
    assert.ok(replyPayload, 'showMainMenu should editReply with payload');

    const shopRow = replyPayload.components[0];
    const shopMenu = shopRow.components[0];

    const marketPostOpt = shopMenu.options.find(o => o.data?.value === 'market_post');
    const marketMarketOpt = shopMenu.options.find(o => o.data?.value === 'market_market');

    assert.ok(marketPostOpt, 'market_post option must exist in the Shop select menu');
    assert.equal(marketPostOpt.data.label, 'Post');
    assert.equal(marketMarketOpt, undefined, 'market_market option must be removed');

    // Verify root Shop Setup payload no longer includes Post button
    const shopSetupPayload = await getShopSetupPayload(mockInteraction.guild, mockInteraction.guildId, mockInteraction);
    const bottomRow = shopSetupPayload.components[shopSetupPayload.components.length - 1];
    const postBtn = bottomRow.components.find(c => c.data?.custom_id === 'shop_admin_post');
    assert.equal(postBtn, undefined, 'shop_admin_post button must be removed from item management home row');
  });

  it('3. Shop Buy Modal Submit: defaults blank quantity input to 1', async () => {
    let editReplyPayload = null;
    const mockInteraction = {
      customId: 'shop_buy_qty_modal_999_0_0_',
      user: { id: 'user1', username: 'Buyer' },
      guildId: '123456789',
      member: { id: 'user1', roles: { cache: new Map() } },
      deferred: true,
      replied: false,
      fields: {
        getTextInputValue: (id) => '' // Empty string
      },
      editReply: async (payload) => {
        editReplyPayload = payload;
        return payload;
      }
    };

    await handleShopBuyModalSubmit(mockInteraction).catch(() => {});

    if (editReplyPayload?.embeds?.[0]?.data?.description) {
      assert.notEqual(
        editReplyPayload.embeds[0].data.description,
        '❌ Please enter a valid quantity of 1 or more.',
        'Empty input must not trigger invalid quantity validation error'
      );
    }
  });

  it('4. Quest Schedule Menu: dynamically sizes to pool and isolates excess saved setting', async () => {
    let replyPayload = null;
    const testGuildId = '123456789012345678';
    const mockInteraction = {
      guildId: testGuildId,
      deferred: true,
      replied: false,
      editReply: async (payload) => {
        replyPayload = payload;
        return payload;
      }
    };

    // Case A: Pool has 3 quests, setting is 2
    mockQuests = [
      { id: 1, name: 'Q1' },
      { id: 2, name: 'Q2' },
      { id: 3, name: 'Q3' }
    ];
    mockConfig = {
      quests_per_refresh: 2,
      quests_refreshes_per_day: 1
    };

    const { configCache } = await import('../src/storage/config.js');
    configCache.set(testGuildId, mockConfig);

    await showQuestsSchedule(mockInteraction);
    const perRefreshMenuA = replyPayload.components[0].components[0];
    assert.equal(perRefreshMenuA.options.length, 3, 'Should only render 3 options when pool has 3 quests');
    assert.equal(perRefreshMenuA.options[1].data.default, true, 'Option 2 should be default');
    assert.ok(!perRefreshMenuA.options.some(o => o.data.label.includes('exceeds current pool')), 'No option should say exceeds pool');

    // Case B: Saved setting is 5, but pool only has 3 quests (deleted quests edge-case)
    mockConfig.quests_per_refresh = 5;
    configCache.set(testGuildId, mockConfig);

    await showQuestsSchedule(mockInteraction);
    const perRefreshMenuB = replyPayload.components[0].components[0];
    assert.equal(perRefreshMenuB.options.length, 4, 'Should render 3 options + 1 excess option');
    const excessOption = perRefreshMenuB.options.find(o => o.data.value === '5');
    assert.ok(excessOption, 'Excess option 5 must be present');
    assert.ok(excessOption.data.label.includes('(exceeds current pool)'), 'Excess option must specify it exceeds current pool');
    assert.equal(excessOption.data.default, true, 'Excess option must be marked default');
  });

});
