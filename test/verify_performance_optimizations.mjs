import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { generateColorPanelImage } from '../src/graphics/colorPaletteCard.js';
import { getShopCategories, getShopItems, invalidateShopCache } from '../src/economy/shop.js';
import { getUserRankWithCache } from '../src/commands/profile.js';
import { wrapInteractionSafety } from '../src/shared.js';
import { handleInteractionError } from '../src/utils/errors.js';
import { setMockPool } from '../src/storage/postgres.js';

describe('Performance & Latency Optimization Verification Suite', () => {

  describe('Canvas Asynchronous Offloading', () => {
    it('should asynchronously encode color panel PNG without blocking the event loop', async () => {
      const colors = [
        { id: 1, role_id: '1001', hex_code: '#FF0000', label_num: 1 },
        { id: 2, role_id: '1002', hex_code: '#00FF00', label_num: 2 }
      ];

      const buffer = await generateColorPanelImage(colors);
      assert.ok(Buffer.isBuffer(buffer), 'Result must be a Node.js Buffer');
      assert.ok(buffer.length > 0, 'Buffer must not be empty');

      // Verify PNG magic header: 0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A
      const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
      assert.deepEqual(buffer.subarray(0, 8), pngHeader, 'Buffer must start with PNG magic bytes');
    });
  });

  describe('In-Memory Shop Caching Layer', () => {
    const mockGuildId = '999888777666';
    let queryCallCount = 0;

    beforeEach(() => {
      invalidateShopCache();
      queryCallCount = 0;

      setMockPool({
        query: async (sql, params) => {
          queryCallCount++;
          if (sql.includes('FROM shop_categories')) {
            return {
              rows: [
                { id: 10, guild_id: mockGuildId, name: 'VIP Roles', display_order: 1 },
                { id: 20, guild_id: mockGuildId, name: 'Badges', display_order: 2 }
              ],
              rowCount: 2
            };
          }
          if (sql.includes('FROM shop_items')) {
            return {
              rows: [
                { id: 101, guild_id: mockGuildId, name: 'Champion', price: 500, is_active: true }
              ],
              rowCount: 1
            };
          }
          return { rows: [], rowCount: 0 };
        }
      });
    });

    it('should hit cache on subsequent getShopCategories calls and bypass database', async () => {
      const firstCall = await getShopCategories(mockGuildId);
      assert.equal(queryCallCount, 1, 'First call must query the database');
      assert.equal(firstCall.length, 2);

      const secondCall = await getShopCategories(mockGuildId);
      assert.equal(queryCallCount, 1, 'Second call must hit in-memory cache without DB query');
      assert.deepEqual(secondCall, firstCall);

      // Verify write-through invalidation
      invalidateShopCache(mockGuildId);
      const thirdCall = await getShopCategories(mockGuildId);
      assert.equal(queryCallCount, 2, 'Call after invalidation must re-query the database');
      assert.deepEqual(thirdCall, firstCall);
    });

    it('should cache getShopItems with distinct parameter signatures and invalidate properly', async () => {
      const itemsFirst = await getShopItems(mockGuildId, null, 'price', false, false);
      assert.equal(queryCallCount, 1, 'Initial items query must hit DB');
      assert.equal(itemsFirst.length, 1);

      const itemsSecond = await getShopItems(mockGuildId, null, 'price', false, false);
      assert.equal(queryCallCount, 1, 'Repeated call with same args must be served from memory');
      assert.deepEqual(itemsSecond, itemsFirst);

      // Different parameter signature triggers new cache key
      const itemsInactive = await getShopItems(mockGuildId, null, 'price', true, false);
      assert.equal(queryCallCount, 2, 'Call with includeInactive=true must query DB');

      // Guild-level invalidation
      invalidateShopCache(mockGuildId);
      await getShopItems(mockGuildId, null, 'price', false, false);
      assert.equal(queryCallCount, 3, 'Call after invalidation must query DB again');
    });
  });

  describe('Profile Rank Window Query Caching', () => {
    it('should cache user rank result and avoid repeated heavy window query scans', async () => {
      let profileQueryCount = 0;
      const mockPool = {
        query: async (sql, params) => {
          profileQueryCount++;
          if (sql.includes('WITH ranked AS')) {
            return { rows: [{ rank: '3' }] };
          }
          if (sql.includes('COUNT(*)')) {
            return { rows: [{ count: '25' }] };
          }
          return { rows: [] };
        }
      };

      const res1 = await getUserRankWithCache('guild_perf_1', 'user_perf_1', mockPool);
      assert.equal(profileQueryCount, 2, 'Initial lookup runs ranked and total queries');
      assert.equal(res1.rank, 3);
      assert.equal(res1.totalRankedCount, 25);

      const res2 = await getUserRankWithCache('guild_perf_1', 'user_perf_1', mockPool);
      assert.equal(profileQueryCount, 2, 'Second lookup within TTL must hit cache without DB queries');
      assert.equal(res2.rank, 3);
      assert.equal(res2.totalRankedCount, 25);
    });

    it('should immediately bypass rank cache and re-query database when user XP changes or levels up', async () => {
      let profileQueryCount = 0;
      let currentMockRank = '4';
      const mockPool = {
        query: async (sql) => {
          profileQueryCount++;
          if (sql.includes('WITH ranked AS')) {
            return { rows: [{ rank: currentMockRank }] };
          }
          if (sql.includes('COUNT(*)')) {
            return { rows: [{ count: '30' }] };
          }
          return { rows: [] };
        }
      };

      // 1. Initial lookup at 100 XP
      const res1 = await getUserRankWithCache('guild_perf_2', 'user_perf_2', mockPool, 100);
      assert.equal(profileQueryCount, 2);
      assert.equal(res1.rank, 4);

      // 2. Second lookup with identical XP (100 XP) -> must hit cache
      const res2 = await getUserRankWithCache('guild_perf_2', 'user_perf_2', mockPool, 100);
      assert.equal(profileQueryCount, 2, 'Identical XP must hit cache without re-querying');
      assert.equal(res2.rank, 4);

      // 3. User levels up / gains XP (now 250 XP, rank advances to 2)
      currentMockRank = '2';
      const res3 = await getUserRankWithCache('guild_perf_2', 'user_perf_2', mockPool, 250);
      assert.equal(profileQueryCount, 4, 'XP change must bypass cache and re-query database immediately');
      assert.equal(res3.rank, 2);
    });
  });

  describe('Private Message Protection Invariants', () => {
    it('should guarantee private delivery for errors without altering public messages', async () => {
      let editReplyCalled = false;
      let followUpCalled = false;
      let followUpFlags = null;

      const publicComponentInteraction = {
        guildId: 'guild_test',
        deferred: true,
        replied: false,
        ephemeral: false, // Component on a public message
        isMessageComponent: () => true,
        message: { id: 'public_msg_123' },
        editReply: async () => {
          editReplyCalled = true;
          throw new Error('Must not overwrite public card!');
        },
        followUp: async (opts) => {
          followUpCalled = true;
          followUpFlags = opts?.flags;
          return opts;
        }
      };

      await handleInteractionError(publicComponentInteraction, new Error('Test Error'), 'Shop Purchase');
      assert.equal(editReplyCalled, false, 'Public message component must NEVER call editReply on error');
      assert.equal(followUpCalled, true, 'Error must be delivered via followUp');
      assert.equal(followUpFlags, MessageFlags.Ephemeral, 'Follow-up must strictly carry Ephemeral flag');
    });

    it('should route private replies to editReply when interaction is already deferred ephemerally', async () => {
      let editReplyOptions = null;
      let originalReplyCalled = false;

      const mockInteraction = {
        deferred: true,
        replied: false,
        ephemeral: true,
        editReply: async (opts) => {
          editReplyOptions = opts;
          return opts;
        },
        reply: async () => {
          originalReplyCalled = true;
        }
      };

      wrapInteractionSafety(mockInteraction);
      await mockInteraction.reply({ content: 'Your private purchase confirmation', flags: MessageFlags.Ephemeral });

      assert.equal(originalReplyCalled, false, 'Original reply must not be called on deferred interaction');
      assert.notEqual(editReplyOptions, null, 'editReply must be invoked for ephemeral deferrals');
      assert.equal(editReplyOptions.content, 'Your private purchase confirmation');
    });
  });

  describe('UI Layout & Label Renaming Verification', () => {
    it('should configure Chest Editor panel with Appearance button and Back/Delete on their own bottom row', async () => {
      const { showLootBoxEditorPanel } = await import('../src/commands/shop-setup.js');
      let editedPayload = null;
      const validGuildId = '123456789012345678';

      const mockInteraction = {
        guildId: validGuildId,
        guild: {
          id: validGuildId,
          roles: { cache: new Map() }
        },
        deferred: true,
        replied: false,
        editReply: async (payload) => {
          editedPayload = payload;
          return payload;
        }
      };

      setMockPool({
        query: async (sql) => {
          if (sql.includes('FROM loot_boxes')) {
            return {
              rows: [{
                id: 1,
                guild_id: validGuildId,
                name: 'Magical Chest',
                chance_common: 0,
                chance_uncommon: 10,
                chance_rare: 25,
                chance_epic: 55,
                chance_legendary: 10,
                min_prizes: 2,
                max_prizes: 3,
                chance_coins: 100,
                min_coins: 500,
                max_coins: 1000,
                items_enabled: true,
                coins_enabled: true,
                image_url: 'https://example.com/chest.png'
              }]
            };
          }
          if (sql.includes('FROM guild_configs')) {
            return { rows: [{ config: {} }] };
          }
          return { rows: [] };
        }
      });

      await showLootBoxEditorPanel(mockInteraction, 1, { showImageMenu: false });
      assert.ok(editedPayload, 'Payload must be returned');

      const components = editedPayload.components;
      // Expect 4 rows when showImageMenu is false:
      // Row 0: Configure select menu
      // Row 1: Rarity/Prizes/Coins toggle buttons
      // Row 2: Appearance & Edit Images
      // Row 3: Back & Delete (on their own row at the bottom)
      assert.equal(components.length, 4, 'Must have exactly 4 component rows without image menu');

      const middleRow = components[2].components;
      assert.equal(middleRow.length, 2);
      assert.equal(middleRow[0].data.label, 'Appearance', 'Customize must be renamed to Appearance');
      assert.equal(middleRow[0].data.emoji.name, '🖼️', 'Appearance button must use unified emoji');
      assert.equal(middleRow[1].data.label, 'Edit Images');

      const bottomRow = components[3].components;
      assert.equal(bottomRow.length, 2);
      assert.equal(bottomRow[0].data.label, 'Back', 'Back button must be on bottom row');
      assert.equal(bottomRow[1].data.label, 'Delete', 'Delete button must be on bottom row');

      // Test with showImageMenu: true (should have 5 rows with Back & Delete on Row 4)
      await showLootBoxEditorPanel(mockInteraction, 1, { showImageMenu: true });
      assert.equal(editedPayload.components.length, 5, 'Must have exactly 5 component rows with image menu');
      const bottomRowMenu = editedPayload.components[4].components;
      assert.equal(bottomRowMenu[0].data.label, 'Back');
      assert.equal(bottomRowMenu[1].data.label, 'Delete');
    });

    it('should rename Customize to Appearance in the Other select menu', async () => {
      const { showMainMenu } = await import('../src/commands/settings.js');
      let editedPayload = null;
      const validGuildId = '123456789012345678';

      const mockInteraction = {
        guildId: validGuildId,
        guild: {
          id: validGuildId,
          roles: { cache: new Map() }
        },
        deferred: true,
        replied: false,
        isButton: () => false,
        isAnySelectMenu: () => false,
        editReply: async (payload) => {
          editedPayload = payload;
          return payload;
        }
      };

      setMockPool({
        query: async () => ({ rows: [{ config: {} }] })
      });

      await showMainMenu(mockInteraction);
      assert.ok(editedPayload, 'Payload must be returned');

      // Row 3 (4th row) is the Other menu
      const otherRow = editedPayload.components[3].components[0];
      const otherOptions = otherRow.options;
      const appearanceOption = otherOptions.find(o => o.data.value === 'other_customize');
      assert.ok(appearanceOption, 'other_customize option must exist');
      assert.equal(appearanceOption.data.label, 'Appearance', 'Option label must be Appearance');
      assert.equal(appearanceOption.data.emoji.name, '🖼️', 'Appearance option must use unified emoji');
    });
  });
});
