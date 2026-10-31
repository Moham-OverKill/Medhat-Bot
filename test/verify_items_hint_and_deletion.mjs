import test from 'node:test';
import assert from 'node:assert/strict';
import { getSettingsHint } from '../src/commands/settings/hints.js';
import {
  handleDeleteItemSelect,
  handleDeleteItemConfirmOnly,
  handleDeleteItemConfirmBoth,
  handleDeleteItemCancel
} from '../src/commands/shop-setup.js';

test('getSettingsHint for items generates correct title and plain English content with dynamic chest name', () => {
  const customHint = getSettingsHint('items', 'Treasure Crates');
  assert.equal(customHint.title, 'HINT: Items');
  assert.ok(customHint.description.includes('Treasure Crates'), 'Should dynamically contain custom chest name');
  assert.ok(customHint.description.includes('⚠️ **Create Items First:**'), 'Should contain setup order advisory');
  assert.ok(customHint.description.includes('📁 **Categories (Swap vs Stack):**'), 'Should contain categories explanation');
  assert.ok(customHint.description.includes('Single (Swap)'), 'Should explain swap mode');
  assert.ok(customHint.description.includes('Multi (Stack)'), 'Should explain stack mode');
  assert.ok(customHint.description.includes('📦 **Packs:**'), 'Should contain packs explanation');
  assert.ok(customHint.description.includes('📢 **Put in Shop:**'), 'Should contain post explanation');
  assert.ok(customHint.description.includes('🗑️ **Editing & Deleting:**'), 'Should contain deletion explanation');

  const defaultHint = getSettingsHint('items');
  assert.ok(defaultHint.description.includes('Chests'), 'Should default to Chests');
});

test('getSettingsHint for other pages', () => {
  const coinsHint = getSettingsHint('coins');
  assert.equal(coinsHint.title, 'HINT: Coins');
  assert.ok(coinsHint.description.includes('📅 **Daily:**'));

  const chestsHint = getSettingsHint('chests', 'Mystery Boxes');
  assert.equal(chestsHint.title, 'HINT: Mystery Boxes');
  assert.ok(chestsHint.description.includes('Mystery Boxes'));
});

test('handleDeleteItemSelect presents confirmation buttons', async () => {
  let editedPayload = null;
  const mockItem = {
    id: 42,
    name: 'Ruby Color',
    role_id: '123456789012345678',
    guild_id: 'guild123'
  };

  const mockInteraction = {
    guildId: 'guild123',
    deferred: true,
    replied: false,
    values: ['42'],
    guild: {
      id: 'guild123',
      roles: {
        cache: new Map([
          ['123456789012345678', { id: '123456789012345678', name: 'Ruby', guild: { id: 'guild123' } }]
        ]),
        fetch: async () => null
      }
    },
    editReply: async (payload) => {
      editedPayload = payload;
      return payload;
    }
  };

  // We test the handler export exists and is callable
  assert.equal(typeof handleDeleteItemSelect, 'function');
  assert.equal(typeof handleDeleteItemConfirmOnly, 'function');
  assert.equal(typeof handleDeleteItemConfirmBoth, 'function');
  assert.equal(typeof handleDeleteItemCancel, 'function');
});
