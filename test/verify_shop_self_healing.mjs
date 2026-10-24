import assert from 'node:assert';
import { buildShopPostPayload } from '../src/utils/shop-post-builder.js';
import { handleInteractionError } from '../src/utils/errors.js';

console.log('--- Testing Shop Post Builder & Self-Healing Logic ---');

// Test 1: Standard Item Post Payload
{
  const item = {
    id: 101,
    name: 'VIP Role',
    description: 'Special VIP status in the community',
    price: 500,
    item_type: 'role',
    role_id: '999888777',
    duration_seconds: 86400 * 7 // 7 days
  };

  const postRow = {
    message_id: 'msg_001',
    guild_id: 'guild_123',
    channel_id: 'chan_456',
    item_id: 101,
    custom_image_url: 'https://example.com/vip.png',
    current_stock: 5,
    max_stock: 10,
    override_price: 450,
    restock_interval_seconds: null
  };

  const payload = await buildShopPostPayload({
    item,
    postRow,
    guildId: 'guild_123'
  });

  assert.strictEqual(payload.embeds.length, 1, 'Should have 1 embed');
  const embed = payload.embeds[0];
  assert.strictEqual(embed.data.title, 'VIP Role');
  assert.strictEqual(embed.data.description, 'Special VIP status in the community');
  assert.strictEqual(embed.data.image?.url, 'https://example.com/vip.png');
  assert.strictEqual(embed.data.color, 0x3498DB);

  // Check fields
  const fieldNames = embed.data.fields.map(f => f.name);
  assert.ok(fieldNames.includes('🏷️ Item'), 'Should have Item field');
  assert.ok(fieldNames.includes('⏳ Duration'), 'Should have Duration field');
  const durationField = embed.data.fields.find(f => f.name === '⏳ Duration');
  assert.strictEqual(durationField.value, '7 Days');

  const stockField = embed.data.fields.find(f => f.name.includes('Stock'));
  assert.ok(stockField, 'Should have stock field');
  assert.strictEqual(stockField.name, '🟢 5 In Stock');

  // Check component row and button
  assert.strictEqual(payload.components.length, 1, 'Should have 1 action row');
  const button = payload.components[0].components[0];
  assert.strictEqual(button.data.custom_id, 'bank_shop_buy_101_0_0_450');
  assert.strictEqual(button.data.label, 'BUY (450)');
  assert.strictEqual(button.data.disabled, false);

  console.log('✓ Test 1: Standard Item Post Payload constructed correctly');
}

// Test 2: Free Item (Claim) Post Payload
{
  const item = {
    id: 102,
    name: 'Starter Badge',
    description: 'Free welcome badge',
    price: 0,
    item_type: 'badge'
  };

  const postRow = {
    message_id: 'msg_002',
    guild_id: 'guild_123',
    item_id: 102,
    current_stock: 100,
    override_price: 0
  };

  const payload = await buildShopPostPayload({
    item,
    postRow,
    guildId: 'guild_123'
  });

  const button = payload.components[0].components[0];
  assert.strictEqual(button.data.label, 'CLAIM');
  assert.strictEqual(button.data.disabled, false);

  console.log('✓ Test 2: Free Item button label set to CLAIM');
}

// Test 3: Sold Out Item Post Payload
{
  const item = {
    id: 103,
    name: 'Limited Trophy',
    description: 'Rare limited trophy',
    price: 1000,
    item_type: 'item'
  };

  const postRow = {
    message_id: 'msg_003',
    guild_id: 'guild_123',
    item_id: 103,
    current_stock: 0,
    max_stock: 5
  };

  const payload = await buildShopPostPayload({
    item,
    postRow,
    guildId: 'guild_123'
  });

  const embed = payload.embeds[0];
  assert.strictEqual(embed.data.color, 0x808080, 'Sold out color should be gray');

  const stockField = embed.data.fields.find(f => f.name.includes('Stock') || f.name.includes('Out Of Stock'));
  assert.strictEqual(stockField.name, '🔴 Out Of Stock');
  assert.strictEqual(stockField.value, 'Sold Out');

  const button = payload.components[0].components[0];
  assert.strictEqual(button.data.label, 'SOLD OUT');
  assert.strictEqual(button.data.disabled, true, 'Button should be disabled when sold out');

  console.log('✓ Test 3: Sold Out Item sets disabled SOLD OUT button and gray color');
}

// Test 4: Corruption Recovery Simulation
{
  const item = {
    id: 104,
    name: 'Dragon Sword',
    description: 'Legendary blade of dragons',
    price: 2500,
    item_type: 'item'
  };

  const postRow = {
    message_id: 'msg_corrupted',
    guild_id: 'guild_123',
    item_id: 104,
    current_stock: 3,
    max_stock: 3,
    custom_image_url: 'https://example.com/sword.png'
  };

  // Simulated corrupted message that was overwritten with the red error embed
  const corruptedEmbed = {
    title: 'Action Execution Failed',
    description: 'Error details: Interaction token expired',
    fields: [
      { name: '📍 Action', value: 'Shop purchase' },
      { name: '🔍 Error Details', value: '40060 Already acknowledged' }
    ]
  };

  // Recovery should NOT use the corrupted description or title
  const isCorruptedTitle = corruptedEmbed.title.includes('Action Execution Failed');
  assert.ok(isCorruptedTitle, 'Should detect corrupted title');

  const payload = await buildShopPostPayload({
    item,
    postRow,
    guildId: 'guild_123',
    customDescription: isCorruptedTitle ? null : corruptedEmbed.description
  });

  assert.strictEqual(payload.embeds[0].data.title, 'Dragon Sword', 'Title must be restored to item name');
  assert.strictEqual(payload.embeds[0].data.description, 'Legendary blade of dragons', 'Description must be restored from item');
  assert.strictEqual(payload.components.length, 1, 'Components must be restored');
  assert.strictEqual(payload.components[0].components[0].data.label, 'BUY (2,500)', 'Buy button must be restored');

  console.log('✓ Test 4: Corrupted post message is completely restored from database records');
}

// Test 5: Error Handler Public Message Overwrite Guard
{
  let editReplyCalled = false;
  let followUpCalled = false;

  const mockPublicButtonInteraction = {
    message: { id: 'public_msg_123' },
    isMessageComponent: () => true,
    deferred: true,
    replied: false,
    ephemeral: false, // NOT ephemeral! Attached to public message!
    followUp: async () => {
      followUpCalled = true;
      throw new Error('FollowUp failed simulated');
    },
    editReply: async () => {
      editReplyCalled = true;
    }
  };

  await handleInteractionError(mockPublicButtonInteraction, new Error('Simulated failure'), 'Test Context');

  assert.ok(followUpCalled, 'Should attempt followUp first');
  assert.strictEqual(editReplyCalled, false, 'CRITICAL: editReply MUST NEVER be called on a public message component!');

  console.log('✓ Test 5: handleInteractionError guarded against public message component overwrites');
}

console.log('\n--- All Shop Self-Healing Unit Tests Passed! ---');
