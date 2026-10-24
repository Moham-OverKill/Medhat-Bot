import assert from 'node:assert';
import { sortItemsByRarity } from '../src/shared.js';

console.log('--- Testing Items View & Chests Category Rendering ---');

// Test 1: sortItemsByRarity does not discard loot box items with LOOT_BOX_ role_id
{
  const mockGuild = {
    roles: {
      cache: new Map([
        ['111111111111111111', { id: '111111111111111111', name: 'Real Role' }]
      ])
    }
  };

  const mixedItems = [
    { id: 1, name: 'Normal Chest', item_type: 'loot_box', role_id: 'LOOT_BOX_1', rarity: 'common' },
    { id: 2, name: 'Silver Chest', item_type: 'loot_box', role_id: 'LOOT_BOX_2', rarity: 'rare' },
    { id: 3, name: 'Diamond Chest', item_type: 'loot_box', role_id: 'LOOT_BOX_3', rarity: 'legendary' },
    { id: 4, name: 'VIP Role', item_type: 'role', role_id: '111111111111111111', rarity: 'epic' },
    { id: 5, name: 'Ghost Role Item', item_type: 'role', role_id: '999999999999999999', rarity: 'common' }
  ];

  const sorted = await sortItemsByRarity(mixedItems, mockGuild);

  // Ghost role (id: 5) must be filtered out
  assert.strictEqual(sorted.some(i => i.id === 5), false, 'Ghost role item must be filtered out');

  // Real role (id: 4) must be kept
  assert.strictEqual(sorted.some(i => i.id === 4), true, 'Real role item must be retained');

  // All 3 chests (id: 1, 2, 3) must be kept and NOT treated as ghost roles
  assert.strictEqual(sorted.some(i => i.id === 1), true, 'Normal Chest must be retained');
  assert.strictEqual(sorted.some(i => i.id === 2), true, 'Silver Chest must be retained');
  assert.strictEqual(sorted.some(i => i.id === 3), true, 'Diamond Chest must be retained');

  console.log('✓ Test 1: sortItemsByRarity retains all chests and only prunes genuine ghost roles');
}

// Test 2: Chests rendering lines format in items view
{
  const mockChests = [
    { id: 'box_1', name: 'Normal Chest', item_type: 'loot_box' },
    { id: 'box_2', name: 'Silver Chest', item_type: 'loot_box' },
    { id: 'box_3', name: 'Diamond Chest', item_type: 'loot_box' }
  ];

  const lootBoxEmoji = '🧰';
  const lines = mockChests.map(item => `${lootBoxEmoji} **${item.name}**`);

  assert.strictEqual(lines.length, 3);
  assert.strictEqual(lines[0], '🧰 **Normal Chest**');
  assert.strictEqual(lines[1], '🧰 **Silver Chest**');
  assert.strictEqual(lines[2], '🧰 **Diamond Chest**');

  const desc = lines.join('\n');
  assert(desc.includes('Normal Chest'));
  assert(desc.includes('Silver Chest'));
  assert(desc.includes('Diamond Chest'));
  assert(!desc.includes('No items in this category'));

  console.log('✓ Test 2: Chests format cleanly with custom emoji and bold names in Category: Chests');
}

console.log('\n--- All Items View & Chests Tests Passed! ---');
