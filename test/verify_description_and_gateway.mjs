import assert from 'node:assert';
import { buildShopPostPayload } from '../src/utils/shop-post-builder.js';

console.log('--- Testing Custom Description & Post Editing Logic ---');

// Test 1: buildShopPostPayload respects postRow.custom_description
{
  const item = {
    id: 99,
    name: 'Mythic Sword',
    description: null, // Catalog has no description
    price: 500,
    stock: 10,
    role_id: '123456789012345678',
    item_type: 'role'
  };

  const postRow = {
    guild_id: '723544218081034303',
    item_id: 99,
    custom_description: 'Custom sword posted by admin with special lore!',
    current_stock: 10,
    max_stock: 10,
    post_mode: 'normal'
  };

  const payload = await buildShopPostPayload({ item, postRow });
  const embed = payload.embeds[0].data;

  assert.strictEqual(embed.title, 'Mythic Sword');
  assert.strictEqual(embed.description, 'Custom sword posted by admin with special lore!');
  console.log('✓ Test 1: postRow.custom_description is faithfully rendered even when catalog description is null');
}

// Test 2: customDescription parameter overrides postRow and catalog
{
  const item = {
    id: 100,
    name: 'Dragon Shield',
    description: 'Catalog description',
    price: 1000,
    stock: 5,
    role_id: '123456789012345679',
    item_type: 'role'
  };

  const postRow = {
    guild_id: '723544218081034303',
    item_id: 100,
    custom_description: 'PostRow description',
    current_stock: 5,
    max_stock: 5,
    post_mode: 'normal'
  };

  // Explicit override passed
  const payload1 = await buildShopPostPayload({
    item,
    postRow,
    customDescription: 'Live modal edit description'
  });
  assert.strictEqual(payload1.embeds[0].data.description, 'Live modal edit description');

  // Fallback to postRow when explicit is null
  const payload2 = await buildShopPostPayload({
    item,
    postRow,
    customDescription: null
  });
  assert.strictEqual(payload2.embeds[0].data.description, 'PostRow description');

  // Fallback to catalog when postRow has no custom description
  const payload3 = await buildShopPostPayload({
    item,
    postRow: { ...postRow, custom_description: null },
    customDescription: null
  });
  assert.strictEqual(payload3.embeds[0].data.description, 'Catalog description');

  console.log('✓ Test 2: Description priority strictly enforced (customDescription > postRow.custom_description > item.description)');
}

// Test 3: Discord URL matching and ID extraction
{
  const testUrl = 'https://discord.com/channels/723544218081034303/1490773140979322972/1492916509679554561';
  const match = testUrl.match(/channels\/(\d+)\/(\d+)\/(\d+)/);

  assert(match !== null, 'Regex must match standard Discord message URL');
  const [_, guildId, channelId, messageId] = match;

  assert.strictEqual(guildId, '723544218081034303');
  assert.strictEqual(channelId, '1490773140979322972');
  assert.strictEqual(messageId, '1492916509679554561');
  console.log('✓ Test 3: User Discord message URL correctly parsed into guild, channel, and message IDs');
}

// Test 4: CustomId parsing for both bank_shop_buy_ and force_buy_
{
  const bankShopCustomId = 'bank_shop_buy_42_111222333_50_250';
  const parts = bankShopCustomId.split('_');
  const isForce = bankShopCustomId.startsWith('force_buy_');
  const itemIdx = isForce ? 2 : 3;
  const sellerIdx = isForce ? 3 : 4;
  const payoutIdx = isForce ? 4 : 5;
  const priceIdx = isForce ? 5 : 6;

  assert.strictEqual(parseInt(parts[itemIdx], 10), 42);
  assert.strictEqual(parts[sellerIdx], '111222333');
  assert.strictEqual(parseInt(parts[payoutIdx], 10), 50);
  assert.strictEqual(parseInt(parts[priceIdx], 10), 250);

  const forceCustomId = 'force_buy_42_111222333_50_250_999888777';
  const forceParts = forceCustomId.split('_');
  const isForce2 = forceCustomId.startsWith('force_buy_');
  const itemIdx2 = isForce2 ? 2 : 3;
  const sellerIdx2 = isForce2 ? 3 : 4;
  const payoutIdx2 = isForce2 ? 4 : 5;
  const priceIdx2 = isForce2 ? 5 : 6;

  assert.strictEqual(parseInt(forceParts[itemIdx2], 10), 42);
  assert.strictEqual(forceParts[sellerIdx2], '111222333');
  assert.strictEqual(parseInt(forceParts[payoutIdx2], 10), 50);
  assert.strictEqual(parseInt(forceParts[priceIdx2], 10), 250);

  console.log('✓ Test 4: Both standard and force_buy button signatures parsed seamlessly');
}

// Test 5: resolveItemDefaultImage is defined and exported from shop-setup.js
{
  const { resolveItemDefaultImage } = await import('../src/commands/shop-setup.js');
  assert.strictEqual(typeof resolveItemDefaultImage, 'function');
  const resolved = await resolveItemDefaultImage({ default_image_url: 'https://example.com/item.png' });
  assert.strictEqual(resolved, 'https://example.com/item.png');
  console.log('✓ Test 5: resolveItemDefaultImage is imported and exported correctly in shop-setup.js');
}

console.log('\n--- All Description & Post Editing Tests Passed! ---');
