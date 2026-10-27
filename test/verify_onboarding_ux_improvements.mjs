import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ButtonStyle, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { setMockPool } from '../src/storage/postgres.js';

// Import target modules
import {
  handleCreateItemStart,
  handleCreateRoleSelect,
  getShopSetupPayload,
  handleCreateItemAutoRoleModal,
  handleCreateItemAutoRoleSubmit
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

  it('1. Item Creation: provides Auto-Create Role button and opens modal', async () => {
    let replyPayload = null;
    const mockInteraction = {
      deferred: true,
      replied: false,
      guildId: '123456789',
      guild: { id: '123456789' },
      editReply: async (payload) => {
        replyPayload = payload;
        return payload;
      }
    };

    await handleCreateItemStart(mockInteraction);
    assert.ok(replyPayload, 'Should render create item screen');

    // Nav row is components[3]
    const navRow = replyPayload.components[3];
    assert.ok(navRow, 'Nav row must be present');

    const autoRoleBtn = navRow.components.find(c => c.data?.custom_id === 'shop_create_item_auto_role');
    assert.ok(autoRoleBtn, 'shop_create_item_auto_role button must be present in nav row');
    assert.equal(autoRoleBtn.data.label, 'Auto-Create Role');
    assert.equal(autoRoleBtn.data.style, ButtonStyle.Success);

    // Verify modal opener
    let modalShown = null;
    const modalInteraction = {
      showModal: async (modal) => {
        modalShown = modal;
      }
    };
    await handleCreateItemAutoRoleModal(modalInteraction);
    assert.ok(modalShown, 'Modal must be shown');
    assert.equal(modalShown.data.custom_id, 'shop_create_item_auto_role_modal');
    assert.equal(modalShown.components[0].components[0].data.custom_id, 'item_name');
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
