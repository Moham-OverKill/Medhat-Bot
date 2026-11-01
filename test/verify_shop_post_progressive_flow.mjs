import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import {
  handleShopPostStart,
  handleShopPostReset,
  handleShopPostSellerSelect,
  handleShopPostModalSubmit,
  handleShopPostPayoutBtn,
  setPendingPostSession,
  getPendingPostSession
} from '../src/commands/shop-setup.js';
import { setMockPool } from '../src/storage/postgres.js';
import { configCache } from '../src/storage/config.js';

describe('Shop Post Progressive Disclosure & Menu Dynamic Phrasing Suite', () => {
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
      deferred: true,
      replied: true,
      deferUpdate: async () => {},
      editReply: async (p) => {
        payload = p;
        return p;
      },
      getPayload: () => payload
    };
  }

  it('1. State A: Initial unconfigured state shows 2 warnings and only Item, Channel, Back buttons', async () => {
    await setPendingPostSession(sessionId, {
      itemId: null,
      channelId: null,
      isEditing: false
    });

    const interaction = createMockInteraction();
    await handleShopPostStart(interaction);
    const payload = interaction.getPayload();

    assert.ok(payload);
    // Embed description must have both warnings
    const desc = payload.embeds[0].data.description;
    assert.equal(desc, '⚠️ Set Item\n⚠️ Set Channel');
    assert.equal(payload.embeds[0].data.thumbnail, undefined, 'No thumbnail when item is unselected');

    // Exactly 3 action rows: Item select, Channel select, Back button row
    assert.equal(payload.components.length, 3, 'Must have strictly 3 component rows');

    const itemSelect = payload.components[0].components[0];
    assert.equal(itemSelect.data.custom_id, `shop_post_item_select:${sessionId}`);
    assert.equal(itemSelect.data.placeholder, '📦 Set Item', 'Item menu placeholder must say Set Item');

    const channelSelect = payload.components[1].components[0];
    assert.equal(channelSelect.data.custom_id, `shop_post_channel_select:${sessionId}`);
    assert.equal(channelSelect.data.placeholder, '📢 Set Channel', 'Channel menu placeholder must say Set Channel');

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

  it('4. State D: Both configured removes all warnings, reveals full summary, shows plain item name, and reveals all buttons', async () => {
    await setPendingPostSession(sessionId, {
      itemId: 501,
      channelId: channelId,
      overridePrice: 1500,
      stock: null,
      isEditing: false
    });

    const interaction = createMockInteraction();
    await handleShopPostStart(interaction);
    const payload = interaction.getPayload();

    const desc = payload.embeds[0].data.description;
    assert.ok(!desc.includes('⚠️'), 'All warnings must be gone');
    assert.ok(desc.includes(`Post **Dragon Blade** In <#${channelId}>`), 'Must show item target');
    assert.ok(desc.includes('for `1,500` Coins 🪙 with `Unlimited` Stocks'), 'Must show price and stock');

    // Exactly 5 action rows
    assert.equal(payload.components.length, 5, 'Must reveal all 5 component rows');

    // Item select menu displays clean item name without emoji or prefix
    const itemSelect = payload.components[0].components[0];
    assert.equal(itemSelect.options[0].data.label, 'Dragon Blade');
    assert.equal(itemSelect.options[0].data.emoji, undefined);

    // Channel select menu placeholder remains Set Channel (with Discord channel tag selected)
    const channelSelect = payload.components[1].components[0];
    assert.equal(channelSelect.data.placeholder, '📢 Set Channel');

    // Seller select menu
    const sellerSelect = payload.components[2].components[0];
    assert.equal(sellerSelect.data.custom_id, `shop_post_seller_select:${sessionId}`);

    // Config row ([Appearance], [Config], [Auto Equip])
    const configRow = payload.components[3].components;
    assert.equal(configRow[0].data.label, 'Appearance');
    assert.equal(configRow[1].data.label, 'Config');
    assert.equal(configRow[2].data.label, 'Auto Equip');

    // Action row ([Back], [Reset], [Publish])
    const actionRow = payload.components[4].components;
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

  it('6. Editing mode immediately presents full editor controls without item/channel selects', async () => {
    await setPendingPostSession(sessionId, {
      itemId: 501,
      channelId: channelId,
      overridePrice: 1500,
      isEditing: true
    });

    const interaction = createMockInteraction();
    await handleShopPostStart(interaction);
    const payload = interaction.getPayload();

    // In edit mode: 3 rows (Seller Select, Config Row, Action Row [Back, Update])
    assert.equal(payload.components.length, 3);
    const editActionRow = payload.components[2].components;
    const updateBtn = editActionRow.find(c => c.data.label === 'Update');
    assert.ok(updateBtn, 'Update button must exist in editing mode');
    assert.equal(updateBtn.data.disabled, false);
  });

  it('7. Seller selection renders "@user will get `None` per sale" when payout is not set', async () => {
    const sellerUserId = '999888777666555444';
    await setPendingPostSession(sessionId, {
      itemId: 501,
      channelId: channelId,
      sellerId: sellerUserId,
      payout: null,
      overridePrice: 1500,
      isEditing: false
    });

    const interaction = createMockInteraction();
    await handleShopPostStart(interaction);
    const payload = interaction.getPayload();

    const desc = payload.embeds[0].data.description;
    assert.ok(desc.includes(`<@${sellerUserId}> will get \`None\` per sale`), 'Must display None when payout is unset');
  });

  it('8. Seller selection renders "@user will get `X` per sale" when payout is set', async () => {
    const sellerUserId = '999888777666555444';
    await setPendingPostSession(sessionId, {
      itemId: 501,
      channelId: channelId,
      sellerId: sellerUserId,
      payout: 250,
      overridePrice: 1500,
      isEditing: false
    });

    const interaction = createMockInteraction();
    await handleShopPostStart(interaction);
    const payload = interaction.getPayload();

    const desc = payload.embeds[0].data.description;
    assert.ok(desc.includes(`<@${sellerUserId}> will get \`250\` per sale`), 'Must display payout value in backticks');
  });

  it('9. Payout modal displays placeholder "None" and rejects payout exceeding item price or Free items', async () => {
    let modalShown = null;
    const interaction = {
      _postSessionId: sessionId,
      showModal: async (m) => { modalShown = m; }
    };

    await setPendingPostSession(sessionId, {
      itemId: 501,
      overridePrice: 100,
      sellerId: '999888777666555444',
      payout: null
    });

    await handleShopPostPayoutBtn(interaction);
    assert.ok(modalShown);
    const textInput = modalShown.components[0].components[0];
    assert.equal(textInput.data.placeholder, 'None', 'Modal placeholder must strictly say None');

    // Validation: Exceeding item price
    let followUpMsg = null;
    const exceedInteraction = {
      _postSessionId: sessionId,
      customId: `shop_post_payout_modal:${sessionId}`,
      fields: { getTextInputValue: () => '150' },
      deferUpdate: async () => {},
      followUp: async (f) => { followUpMsg = f; }
    };
    await handleShopPostModalSubmit(exceedInteraction);
    assert.ok(followUpMsg?.content.includes('cannot exceed the item price'));

    // Validation: Setting payout for Free item
    await setPendingPostSession(sessionId, {
      itemId: 501,
      overridePrice: 0,
      sellerId: '999888777666555444',
      payout: null
    });
    followUpMsg = null;
    const freeInteraction = {
      _postSessionId: sessionId,
      customId: `shop_post_payout_modal:${sessionId}`,
      fields: { getTextInputValue: () => '50' },
      deferUpdate: async () => {},
      followUp: async (f) => { followUpMsg = f; }
    };
    await handleShopPostModalSubmit(freeInteraction);
    assert.ok(followUpMsg?.content.includes('Cannot set a seller payout for a Free item'));
  });

  it('10. Clearing seller safely resets sellerId and payout without crashing, and allows guild owner as seller', async () => {
    const ownerId = '111222333444555666';
    const mockInteraction = {
      ...createMockInteraction(),
      guild: { ownerId, channels: { cache: new Map() }, roles: { cache: new Map() } },
      values: [ownerId]
    };

    await setPendingPostSession(sessionId, {
      itemId: 501,
      channelId: channelId,
      overridePrice: 1000,
      sellerId: null,
      payout: null
    });

    // Selecting guild owner is supported and sets seller
    await handleShopPostSellerSelect(mockInteraction);
    let state = await getPendingPostSession(sessionId);
    assert.equal(state.sellerId, ownerId, 'Guild owner must be supported as seller');

    // Clearing seller via Discord native clear (empty values array)
    const clearInteraction = {
      ...mockInteraction,
      values: []
    };
    await handleShopPostSellerSelect(clearInteraction);
    state = await getPendingPostSession(sessionId);
    assert.equal(state.sellerId, null, 'Clearing seller must set sellerId to null');
    assert.equal(state.payout, null, 'Clearing seller must set payout to null');
  });

  it('11. Changing item price clamps or resets existing seller payout', async () => {
    await setPendingPostSession(sessionId, {
      itemId: 501,
      overridePrice: 500,
      sellerId: '999888777666555444',
      payout: 400
    });

    // Lower price to 200 -> payout clamped to 200
    const lowerPriceInteraction = {
      ...createMockInteraction(),
      customId: `shop_post_price_modal:${sessionId}`,
      fields: { getTextInputValue: () => '200' }
    };
    await handleShopPostModalSubmit(lowerPriceInteraction);
    let state = await getPendingPostSession(sessionId);
    assert.equal(state.overridePrice, 200);
    assert.equal(state.payout, 200, 'Payout must be clamped to new lower price');

    // Change price to Free -> payout automatically reset to null
    const freePriceInteraction = {
      ...createMockInteraction(),
      customId: `shop_post_price_modal:${sessionId}`,
      fields: { getTextInputValue: () => '0' }
    };
    await handleShopPostModalSubmit(freePriceInteraction);
    state = await getPendingPostSession(sessionId);
    assert.equal(state.overridePrice, 0);
    assert.equal(state.payout, null, 'Payout must be reset to null when item is made Free');
  });

  after(() => {
    process.exit(0);
  });
});
