import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import {
  handleShopPostStart,
  handleShopPostReset,
  handleShopPostSellerSelect,
  handleShopPostModalSubmit,
  handleShopPostConfigBtn,
  setPendingPostSession,
  getPendingPostSession
} from '../src/commands/shop-setup.js';
import { setMockPool } from '../src/storage/postgres.js';
import { configCache } from '../src/storage/config.js';

describe('Shop Post Progressive Disclosure & Dynamic Seller Payout Suite', () => {
  const guildId = '723544218081034303';
  const userId = '1383486097601859686';
  const channelId = '1232850780134834196';
  const sessionId = 'test-progressive-session';

  const mockItem = {
    id: 501,
    name: 'Dragon Blade',
    price: 1500,
    is_active: true,
    item_type: 'normal',
    role_id: null
  };

  beforeEach(() => {
    configCache.clear();
    setMockPool({
      query: async (sql) => {
        if (sql.includes('shop_items')) {
          return { rows: [{ ...mockItem }] };
        }
        if (sql.includes('shop_categories')) {
          return { rows: [] };
        }
        if (sql.includes('guild_configs')) {
          return { rows: [{ config: { coin_name: 'Coins', coin_emoji: '🪙' } }] };
        }
        return { rows: [] };
      }
    });
  });

  function createMockInteraction() {
    let payload = null;
    return {
      _postSessionId: sessionId,
      guildId,
      channelId,
      user: { id: userId },
      guild: {
        id: guildId,
        channels: { cache: new Map() },
        roles: { cache: new Map() }
      },
      client: {
        channels: {
          cache: {
            get: () => ({
              type: ChannelType.GuildText,
              name: 'testing'
            })
          }
        }
      },
      deferUpdate: async () => {},
      editReply: async (data) => {
        payload = data;
        return data;
      },
      followUp: async (data) => {
        payload = data;
        return data;
      },
      getPayload: () => payload
    };
  }

  it('1. State A: Neither Item nor Channel set shows 2 progressive warnings and only Back button', async () => {
    await setPendingPostSession(sessionId, {
      itemId: null,
      channelId: null,
      fromGateway: true,
      fromAdminHub: false,
      isEditing: false
    });

    const interaction = createMockInteraction();
    await handleShopPostStart(interaction);
    const payload = interaction.getPayload();

    assert.ok(payload);
    assert.ok(payload.embeds && payload.embeds.length > 0);
    const desc = payload.embeds[0].data.description;
    assert.equal(desc, '⚠️ Set Item\n⚠️ Set Channel', 'Must display both progressive warnings');

    // Title should be generic
    assert.equal(payload.embeds[0].data.title, 'Posting an item');

    // Only 3 component rows: Item Select, Channel Select, Action Row (with Back only)
    assert.equal(payload.components.length, 3, 'Must only show item, channel, and back button');
    const itemSelect = payload.components[0].components[0];
    assert.equal(itemSelect.data.placeholder, '📦 Set Item');

    const channelSelect = payload.components[1].components[0];
    assert.equal(channelSelect.data.placeholder, '📢 Set Channel');

    const actionRow = payload.components[2].components;
    assert.equal(actionRow.length, 1, 'Action row must contain only Back button');
    assert.equal(actionRow[0].data.label, 'Back');
  });

  it('2. State B: Item set but Channel unset removes Set Item warning and keeps Set Channel without summary', async () => {
    await setPendingPostSession(sessionId, {
      itemId: 501,
      channelId: null,
      isEditing: false
    });

    const interaction = createMockInteraction();
    await handleShopPostStart(interaction);
    const payload = interaction.getPayload();

    const desc = payload.embeds[0].data.description;
    assert.equal(desc, '⚠️ Set Channel', 'Only Set Channel warning must remain');
    assert.ok(!desc.includes('Dragon Blade'), 'Must not display item summary details yet');

    // Title and thumbnail updated for selected item
    assert.equal(payload.embeds[0].data.title, 'Posting Dragon Blade');

    // Components still restricted to 3 rows
    assert.equal(payload.components.length, 3, 'Buttons must remain hidden until channel is configured');
    const itemSelect = payload.components[0].components[0];
    assert.equal(itemSelect.options[0].data.label, 'Dragon Blade', 'Quick-pick option must be clean item name');
    assert.equal(itemSelect.options[0].data.emoji, undefined, 'Must not have emoji');

    const channelSelect = payload.components[1].components[0];
    assert.equal(channelSelect.data.placeholder, '📢 Set Channel');

    const actionRow = payload.components[2].components;
    assert.equal(actionRow.length, 1);
    assert.equal(actionRow[0].data.label, 'Back');
  });

  it('3. State C: Channel set but Item unset removes Set Channel warning and keeps Set Item without summary', async () => {
    await setPendingPostSession(sessionId, {
      itemId: null,
      channelId: channelId,
      isEditing: false
    });

    const interaction = createMockInteraction();
    await handleShopPostStart(interaction);
    const payload = interaction.getPayload();

    const desc = payload.embeds[0].data.description;
    assert.equal(desc, '⚠️ Set Item', 'Only Set Item warning must remain');
    assert.ok(!desc.includes('Post'), 'Must not display post summary details yet');

    // Components still restricted to 3 rows
    assert.equal(payload.components.length, 3, 'Buttons must remain hidden until item is configured');
    const itemSelect = payload.components[0].components[0];
    assert.equal(itemSelect.data.placeholder, '📦 Set Item');

    const channelSelect = payload.components[1].components[0];
    assert.equal(channelSelect.data.placeholder, '📢 Set Channel');

    const actionRow = payload.components[2].components;
    assert.equal(actionRow.length, 1);
    assert.equal(actionRow[0].data.label, 'Back');
  });

  it('4. State D: Both configured without payout hides Seller Menu, shows strictly 3 param buttons, and enables Publish', async () => {
    await setPendingPostSession(sessionId, {
      itemId: 501,
      channelId: channelId,
      overridePrice: 1500,
      stock: null,
      payout: null,
      sellerId: null,
      isEditing: false
    });

    const interaction = createMockInteraction();
    await handleShopPostStart(interaction);
    const payload = interaction.getPayload();

    const desc = payload.embeds[0].data.description;
    assert.ok(!desc.includes('⚠️'), 'All warnings must be gone');
    assert.ok(desc.includes(`- Post **Dragon Blade** In <#${channelId}>`), 'Must show item target');
    assert.ok(desc.includes('for `1,500` 🪙 with `Unlimited` Stocks'), 'Must show price and stock');

    // Without payout configured, Seller Menu is HIDDEN -> 4 rows total
    assert.equal(payload.components.length, 4, 'Must show 4 rows (Item, Channel, Param buttons, Action buttons)');

    // Item select menu displays clean item name without emoji or prefix
    const itemSelect = payload.components[0].components[0];
    assert.equal(itemSelect.options[0].data.label, 'Dragon Blade');
    assert.equal(itemSelect.options[0].data.emoji, undefined);

    // Channel select menu placeholder remains Set Channel
    const channelSelect = payload.components[1].components[0];
    assert.equal(channelSelect.data.placeholder, '📢 Set Channel');

    // Config row strictly has 3 buttons ([Appearance], [Config], [Auto Equip]) - NO Payout button
    const configRow = payload.components[2].components;
    assert.equal(configRow.length, 3, 'Param row must have exactly 3 buttons');
    assert.equal(configRow[0].data.label, 'Appearance');
    assert.equal(configRow[1].data.label, 'Config');
    assert.equal(configRow[2].data.label, 'Auto Equip');

    // Action row ([Back], [Reset], [Publish])
    const actionRow = payload.components[3].components;
    assert.equal(actionRow[0].data.label, 'Back');
    assert.equal(actionRow[1].data.label, 'Reset');
    assert.equal(actionRow[2].data.label, 'Publish');
    assert.equal(actionRow[2].data.disabled, false, 'Publish button must be enabled');
  });

  it('5. Reset flow resets selections back to State A (2 warnings, only Back button)', async () => {
    await setPendingPostSession(sessionId, {
      itemId: 501,
      channelId: channelId,
      fromGateway: true,
      fromAdminHub: false,
      isEditing: false
    });

    const interaction = createMockInteraction();
    await handleShopPostReset(interaction);
    const payload = interaction.getPayload();

    // Verify state was reset
    const state = await getPendingPostSession(sessionId);
    assert.equal(state.channelId, null);
    assert.equal(state.itemId, null);

    // Verify re-render has both warnings and only 3 rows with Back button
    const desc = payload.embeds[0].data.description;
    assert.equal(desc, '⚠️ Set Item\n⚠️ Set Channel');
    assert.equal(payload.components.length, 3);
    assert.equal(payload.components[2].components.length, 1);
    assert.equal(payload.components[2].components[0].data.label, 'Back');
  });

  it('6. Editing mode presents controls without item/channel selects and hides seller menu when payout is unset', async () => {
    await setPendingPostSession(sessionId, {
      itemId: 501,
      channelId: channelId,
      overridePrice: 1500,
      payout: null,
      sellerId: null,
      isEditing: true
    });

    const interaction = createMockInteraction();
    await handleShopPostStart(interaction);
    const payload = interaction.getPayload();

    // In edit mode without payout: 2 rows (Config Row, Action Row [Back, Update])
    assert.equal(payload.components.length, 2);
    const configRow = payload.components[0].components;
    assert.equal(configRow.length, 3, 'Param row must have exactly 3 buttons');
    assert.equal(configRow[0].data.label, 'Appearance');
    assert.equal(configRow[1].data.label, 'Config');
    assert.equal(configRow[2].data.label, 'Auto Equip');

    const editActionRow = payload.components[1].components;
    const updateBtn = editActionRow.find(c => c.data.label === 'Update');
    assert.ok(updateBtn, 'Update button must exist in editing mode');
    assert.equal(updateBtn.data.disabled, false);
  });

  it('7. Post Configuration Modal has 5 fields and pre-fills / defaults correctly', async () => {
    let modalShown = null;
    const interaction = {
      _postSessionId: sessionId,
      guildId,
      showModal: async (m) => { modalShown = m; }
    };

    // Case A: No payout set -> Seller Payout input defaults to empty with placeholder 'No Seller'
    await setPendingPostSession(sessionId, {
      itemId: 501,
      overridePrice: 1500,
      payout: null
    });

    await handleShopPostConfigBtn(interaction);
    assert.ok(modalShown, 'Modal must be shown');
    assert.equal(modalShown.components.length, 5, 'Modal must contain exactly 5 ActionRows');
    const payoutFieldA = modalShown.components[4].components[0];
    assert.equal(payoutFieldA.data.custom_id, 'seller_payout');
    assert.equal(payoutFieldA.data.label, 'Seller Payout');
    assert.equal(payoutFieldA.data.placeholder, 'No Seller');
    assert.equal(payoutFieldA.data.value, undefined, 'Must be empty when payout is unset');

    // Case B: Payout is configured to 250 -> pre-filled with '250'
    await setPendingPostSession(sessionId, {
      itemId: 501,
      overridePrice: 1500,
      payout: 250
    });

    await handleShopPostConfigBtn(interaction);
    const payoutFieldB = modalShown.components[4].components[0];
    assert.equal(payoutFieldB.data.value, '250', 'Must pre-fill configured payout amount');
  });

  it('8. Submitting payout > 0 in Config modal dynamically reveals Seller Menu and requires seller selection', async () => {
    await setPendingPostSession(sessionId, {
      itemId: 501,
      channelId: channelId,
      overridePrice: 1500,
      payout: null,
      sellerId: null,
      isEditing: false
    });

    // Submit Config modal with seller_payout = 300
    const configModalInteraction = {
      ...createMockInteraction(),
      customId: `shop_post_config_modal:${sessionId}`,
      fields: {
        getTextInputValue: (field) => {
          if (field === 'price_input') return '1500';
          if (field === 'seller_payout') return '300';
          return '';
        }
      }
    };
    await handleShopPostModalSubmit(configModalInteraction);

    const state = await getPendingPostSession(sessionId);
    assert.equal(state.payout, 300, 'Payout must be updated to 300');
    assert.equal(state.sellerId, null);

    // Re-render post panel
    const interaction = createMockInteraction();
    await handleShopPostStart(interaction);
    const payload = interaction.getPayload();

    // Now 5 rows: Item Select, Channel Select, Seller UserSelectMenu, Config Row, Action Row
    assert.equal(payload.components.length, 5, 'Seller menu must now be revealed');
    const sellerSelect = payload.components[2].components[0];
    assert.equal(sellerSelect.data.custom_id, `shop_post_seller_select:${sessionId}`);
    assert.equal(sellerSelect.data.placeholder, '👤 Select Seller');

    // Embed description prompts to select seller, and Publish button is disabled
    const desc = payload.embeds[0].data.description;
    assert.ok(desc.includes('⚠️ Select a seller to receive `300` per sale'));
    const actionRow = payload.components[4].components;
    const publishBtn = actionRow.find(c => c.data.label === 'Publish');
    assert.equal(publishBtn.data.disabled, true, 'Publish button must be disabled until seller is selected');
  });

  it('9. Selecting a seller satisfies the requirement and renders payout confirmation in embed', async () => {
    const sellerUserId = '999888777666555444';
    const selectInteraction = {
      ...createMockInteraction(),
      values: [sellerUserId]
    };

    await setPendingPostSession(sessionId, {
      itemId: 501,
      channelId: channelId,
      overridePrice: 1500,
      payout: 300,
      sellerId: null,
      isEditing: false
    });

    await handleShopPostSellerSelect(selectInteraction);

    const state = await getPendingPostSession(sessionId);
    assert.equal(state.sellerId, sellerUserId);
    assert.equal(state.payout, 300);

    const interaction = createMockInteraction();
    await handleShopPostStart(interaction);
    const payload = interaction.getPayload();

    const desc = payload.embeds[0].data.description;
    assert.ok(desc.includes(`<@${sellerUserId}> will get \`300\` per sale`));

    const actionRow = payload.components[4].components;
    const publishBtn = actionRow.find(c => c.data.label === 'Publish');
    assert.equal(publishBtn.data.disabled, false, 'Publish button must be enabled once seller is selected');
  });

  it('10. Setting payout to 0 or empty in Config modal removes the seller and hides the Seller Menu', async () => {
    await setPendingPostSession(sessionId, {
      itemId: 501,
      channelId: channelId,
      overridePrice: 1500,
      payout: 300,
      sellerId: '999888777666555444',
      isEditing: false
    });

    // Admin sets seller_payout to 0 / empty
    const removePayoutInteraction = {
      ...createMockInteraction(),
      customId: `shop_post_config_modal:${sessionId}`,
      fields: {
        getTextInputValue: (field) => {
          if (field === 'price_input') return '1500';
          if (field === 'seller_payout') return '0';
          return '';
        }
      }
    };
    await handleShopPostModalSubmit(removePayoutInteraction);

    const state = await getPendingPostSession(sessionId);
    assert.equal(state.payout, null, 'Payout must be reset to null');
    assert.equal(state.sellerId, null, 'Seller must be cleared');

    // Re-render
    const interaction = createMockInteraction();
    await handleShopPostStart(interaction);
    const payload = interaction.getPayload();

    // Seller menu is gone, back to 4 rows
    assert.equal(payload.components.length, 4, 'Seller menu must be hidden');
    const desc = payload.embeds[0].data.description;
    assert.ok(!desc.includes('will get'), 'No seller payout line in embed');
  });

  it('11. Config modal allows any seller payout amount, including on Free items and exceeding item price', async () => {
    // Payout exceeding item price is permitted
    await setPendingPostSession(sessionId, {
      itemId: 501,
      overridePrice: 100,
      payout: null
    });

    const exceedInteraction = {
      ...createMockInteraction(),
      customId: `shop_post_config_modal:${sessionId}`,
      fields: {
        getTextInputValue: (field) => {
          if (field === 'price_input') return '100';
          if (field === 'seller_payout') return '150';
          return '';
        }
      }
    };
    await handleShopPostModalSubmit(exceedInteraction);
    let state = await getPendingPostSession(sessionId);
    assert.equal(state.payout, 150, 'Payout greater than item price must be accepted');

    // Payout for Free item is permitted
    await setPendingPostSession(sessionId, {
      itemId: 501,
      overridePrice: 0,
      payout: null
    });
    const freeInteraction = {
      ...createMockInteraction(),
      customId: `shop_post_config_modal:${sessionId}`,
      fields: {
        getTextInputValue: (field) => {
          if (field === 'price_input') return '0';
          if (field === 'seller_payout') return '50';
          return '';
        }
      }
    };
    await handleShopPostModalSubmit(freeInteraction);
    state = await getPendingPostSession(sessionId);
    assert.equal(state.payout, 50, 'Payout on Free items must be accepted');
  });

  it('12. Clearing seller via native "x" clears sellerId while preserving payout so menu remains visible', async () => {
    await setPendingPostSession(sessionId, {
      itemId: 501,
      channelId: channelId,
      overridePrice: 1000,
      sellerId: '999888777666555444',
      payout: 200
    });

    const clearInteraction = {
      ...createMockInteraction(),
      values: []
    };
    await handleShopPostSellerSelect(clearInteraction);

    const state = await getPendingPostSession(sessionId);
    assert.equal(state.sellerId, null, 'sellerId must be cleared');
    assert.equal(state.payout, 200, 'payout must remain configured so menu stays active');

    const interaction = createMockInteraction();
    await handleShopPostStart(interaction);
    const payload = interaction.getPayload();

    assert.equal(payload.components.length, 5, 'Seller menu remains open');
    const desc = payload.embeds[0].data.description;
    assert.ok(desc.includes('⚠️ Select a seller to receive `200` per sale'));
  });

  after(() => {
    process.exit(0);
  });
});
