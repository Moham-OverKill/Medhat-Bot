import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import {
  ADMIN_SHORTCUT_REGISTRY,
  getAdminShortcutMeta,
  normalizeAdminShortcutOrder,
  generateAdminInterfaceBanner,
  buildAdminHubButtons,
  handleAdminHubComponent,
  showAdminInterfaceSlotAssign
} from '../src/commands/interface.js';
import { setMockPool } from '../src/storage/postgres.js';
import { configCache } from '../src/storage/config.js';

describe('Admin Interface Chests/Lootboxes Shortcut Suite', () => {
  const validGuildId = '123456789012345678';
  const validUserId = '649702547459670017';

  beforeEach(() => {
    configCache.clear();
  });

  it('1. ADMIN_SHORTCUT_REGISTRY includes chests shortcut metadata', () => {
    const entry = ADMIN_SHORTCUT_REGISTRY.chests;
    assert.ok(entry, 'chests shortcut must be registered in ADMIN_SHORTCUT_REGISTRY');
    assert.equal(entry.id, 'chests');
    assert.equal(entry.name, 'Chests');
    assert.equal(entry.label, 'CHESTS');
    assert.equal(entry.emoji, '🎁');
    assert.equal(entry.buttonCustomId, 'admin_hub_chests');
    assert.ok(entry.description && entry.description.length > 0, 'Must have description');
  });

  it('2. getAdminShortcutMeta resolves chests and lootboxes alias', () => {
    const byChest = getAdminShortcutMeta('chests');
    assert.ok(byChest, 'Must resolve by chests');
    assert.equal(byChest.id, 'chests');

    const byLootbox = getAdminShortcutMeta('lootboxes');
    assert.ok(byLootbox, 'Must resolve by lootboxes alias');
    assert.equal(byLootbox.id, 'chests');
  });

  it('3. normalizeAdminShortcutOrder accepts chests and normalizes lootboxes to chests', () => {
    const customOrder = ['colors', 'levels', 'roles', 'chests', 'coins', 'shop', 'economy', 'lootboxes'];
    const normalized = normalizeAdminShortcutOrder(customOrder);
    assert.equal(normalized[3], 'chests', 'Slot 3 must remain chests');
    assert.equal(normalized[7], 'chests', 'Slot 7 must normalize from lootboxes to chests');
  });

  it('4. showAdminInterfaceSlotAssign presents chests option in module select dropdown', async () => {
    let replyPayload = null;
    const mockInteraction = {
      guildId: validGuildId,
      guild: {
        id: validGuildId,
        emojis: { cache: new Map() }
      },
      deferred: true,
      replied: false,
      editReply: async (payload) => {
        replyPayload = payload;
        return payload;
      }
    };

    setMockPool({
      query: async (sql) => {
        if (sql.includes('server_interface_config')) {
          return {
            rows: [{
              admin_shortcut_order: ['chests', 'empty', 'empty', 'empty'],
              admin_slot_colors: ['#000000'],
              admin_slot_button_colors: ['secondary']
            }]
          };
        }
        if (sql.includes('guild_configs')) {
          return {
            rows: [{
              config: {
                coin_name: 'Gems',
                coin_emoji: '💎',
                loot_box_category_name: 'Crates',
                loot_box_category_emoji: '📦'
              }
            }]
          };
        }
        return { rows: [] };
      }
    });

    await showAdminInterfaceSlotAssign(mockInteraction, 0);
    assert.ok(replyPayload, 'Must editReply with slot assignment menu');

    const selectMenu = replyPayload.components[0].components[0];
    const options = selectMenu.options;
    const chestOpt = options.find(o => o.data.value === 'chests');

    assert.ok(chestOpt, 'Module select dropdown must contain chests option');
    assert.equal(chestOpt.data.label, 'Crates', 'Must reflect custom category name in label');
    assert.equal(chestOpt.data.default, true, 'Slot 0 must have chests marked as default');
  });

  it('5. handleAdminHubComponent routes admin_hub_chests to handleLootBoxesPage with disabled Back button', async () => {
    let deferredWithFlags = null;
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
        channels: { cache: new Map() },
        roles: { cache: new Map() }
      },
      member: { permissions: { has: () => true } },
      customId: 'admin_hub_chests',
      deferred: false,
      replied: false,
      deferReply: async (options) => {
        mockInteraction.deferred = true;
        deferredWithFlags = options?.flags;
      },
      editReply: async (payload) => {
        editReplyPayload = payload;
        return payload;
      },
      _adminVerified: true
    };

    setMockPool({
      query: async (sql) => {
        if (sql.includes('loot_boxes')) {
          return {
            rows: [
              { id: 1, name: 'Mythic Chest', min_prizes: 1, max_prizes: 2, min_coins: 50, max_coins: 200 }
            ]
          };
        }
        if (sql.includes('guild_configs')) {
          return {
            rows: [{
              config: {
                loot_box_category_name: 'Chests'
              }
            }]
          };
        }
        return { rows: [] };
      }
    });

    await handleAdminHubComponent(mockInteraction);

    assert.equal(deferredWithFlags, MessageFlags.Ephemeral, 'Must defer reply with Ephemeral flag');
    assert.ok(editReplyPayload, 'Must render loot boxes page in ephemeral reply');
    assert.equal(editReplyPayload.embeds[0].data.title, 'Chests');

    // Verify back button is disabled when accessed from admin hub
    const buttonRow = editReplyPayload.components[1];
    const backBtn = buttonRow.components[0];
    assert.equal(backBtn.data.custom_id, 'settings_back');
    assert.equal(backBtn.data.disabled, true, 'Back button must be disabled for admin hub ephemeral interaction');
  });

  it('6. generateAdminInterfaceBanner and buildAdminHubButtons render chests slot and customId', async () => {
    const shortcutOrder = [
      'colors', 'levels', 'roles', 'chests',
      'coins', 'shop', 'economy', 'empty',
      'users', 'anticheat', 'automod', 'empty'
    ];

    setMockPool({
      query: async (sql) => {
        if (sql.includes('guild_configs')) {
          return {
            rows: [{
              config: {
                coin_name: 'Coins',
                coin_emoji: '🪙',
                loot_box_category_name: 'Chests',
                loot_box_category_emoji: '🎁'
              }
            }]
          };
        }
        return { rows: [] };
      }
    });

    // 1. Banner buffer generation
    const banner = await generateAdminInterfaceBanner(shortcutOrder, {
      guildId: validGuildId,
      lootBoxName: 'Chests',
      lootBoxEmoji: '🎁'
    });
    assert.ok(banner instanceof Uint8Array || Buffer.isBuffer(banner), 'Must produce valid image buffer');
    assert.ok(banner.length > 1000, 'Image buffer must contain data');

    // 2. Button rows construction
    const buttonRows = buildAdminHubButtons(validGuildId, null, shortcutOrder, null, { lootBoxEmoji: '🎁' });
    assert.equal(buttonRows.length, 3, 'Must have 3 rows');

    const row1Buttons = buttonRows[0].components;
    assert.equal(row1Buttons.length, 4, 'Row 1 must have 4 buttons');
    assert.equal(row1Buttons[3].data.custom_id, 'admin_hub_chests', 'Fourth button must be admin_hub_chests');
  });
});
