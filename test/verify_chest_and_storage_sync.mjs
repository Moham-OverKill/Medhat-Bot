import test from 'node:test';
import assert from 'node:assert/strict';
import { setMockPool } from '../src/storage/postgres.js';
import { createLootBox, getLootBox } from '../src/economy/lootbox.js';
import { syncGuildStorageThreads } from '../src/utils/image-host.js';
import { getShopSetupPayload } from '../src/commands/shop-setup.js';
import { showMainMenu, showCoinsSubMenu } from '../src/commands/settings.js';
import { getRewardsPayload } from '../src/commands/rewards.js';
import { handleEconomySettings } from '../src/commands/settings/economy.js';
import { getPassDashboardPayload } from '../src/commands/settings/pass.js';
import { renderRootEmbedMenu } from '../src/commands/settings/embeds.js';
import { handleLogsSettings } from '../src/commands/settings/logs.js';
import { showUserSelector, showAdminManagement } from '../src/commands/admin-users.js';
import { showRolesMenu } from '../src/commands/settings/role-rewards.js';
import { handleLeaderboardSettings } from '../src/commands/settings/leaderboards.js';
import { configCache } from '../src/storage/config.js';

test('Chest Assets, Storage Thread Sync & UI Standardization Suite', async (t) => {
  const guildId = '123456789012345678';
  const mockStorage = {
    loot_boxes: new Map(),
    shop_items: new Map(),
    image_host_threads: new Map(),
    guild_configs: new Map()
  };

  const mockPool = {
    connect: async () => {
      return {
        query: async (sql, params = []) => {
          const text = sql.trim();
          if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
            return { rows: [] };
          }
          if (text.includes('INSERT INTO loot_boxes')) {
            const id = mockStorage.loot_boxes.size + 1;
            const row = {
              id,
              guild_id: params[0],
              name: params[1],
              description: null,
              image_url: params[2],
              opened_image_url: params[3],
              chance_common: 70,
              chance_uncommon: 20,
              chance_rare: 10,
              chance_epic: 0,
              chance_legendary: 0,
              chance_coins: 25,
              min_coins: 100,
              max_coins: 500,
              min_prizes: 1,
              max_prizes: 1,
              items_enabled: true,
              coins_enabled: true
            };
            mockStorage.loot_boxes.set(id, row);
            return { rows: [row] };
          }
          if (text.includes('INSERT INTO shop_items')) {
            const id = mockStorage.shop_items.size + 1;
            const row = { id, guild_id: params[0], name: params[1] };
            mockStorage.shop_items.set(id, row);
            return { rows: [row] };
          }
          return { rows: [] };
        },
        release: () => {}
      };
    },
    query: async (sql, params = []) => {
      const text = sql.trim();
      if (text.includes('SELECT') && text.includes('FROM loot_boxes')) {
        const id = parseInt(params[0], 10);
        const row = mockStorage.loot_boxes.get(id);
        return { rows: row ? [row] : [] };
      }
      if (text.includes('SELECT') && text.includes('FROM image_host_threads')) {
        const gId = params[0];
        const rows = [];
        for (const [k, v] of mockStorage.image_host_threads.entries()) {
          if (k.startsWith(`${gId}:`)) {
            rows.push(v);
          }
        }
        return { rows };
      }
      if (text.includes('SELECT') && text.includes('FROM shop_categories')) {
        return { rows: [{ count: '2' }] };
      }
      if (text.includes('SELECT') && text.includes('FROM shop_items')) {
        return { rows: [{ pack_count: '1', lootbox_count: '1', item_count: '5' }] };
      }
      if (text.includes('user_balances')) {
        return { rows: [{ total: '50000', count: '10' }] };
      }
      if (text.includes('guild_configs')) {
        const gId = params[0];
        const cfg = mockStorage.guild_configs.get(gId);
        return { rows: cfg ? [{ config: cfg }] : [] };
      }
      return { rows: [] };
    }
  };

  setMockPool(mockPool);

  await t.test('createLootBox should maintain independent image slots without auto-assumption', async () => {
    // Case 1: Closed image only
    const box1 = await createLootBox(guildId, {
      name: 'Silver Chest',
      imageUrl: 'https://example.com/closed.png',
      openedImageUrl: null
    });
    assert.equal(box1.image_url, 'https://example.com/closed.png');
    assert.equal(box1.opened_image_url, null, 'opened_image_url must remain null when only closed image is uploaded');

    // Verify fetching also preserves null without copying
    const fetched1 = await getLootBox(box1.id, guildId);
    assert.equal(fetched1.opened_image_url, null, 'Fetched box opened_image_url must remain null');

    // Case 2: Opened image only
    const box2 = await createLootBox(guildId, {
      name: 'Golden Chest',
      imageUrl: null,
      openedImageUrl: 'https://example.com/opened.png'
    });
    assert.equal(box2.image_url, null, 'image_url must remain null when only opened image is uploaded');
    assert.equal(box2.opened_image_url, 'https://example.com/opened.png');
  });

  await t.test('syncGuildStorageThreads should update thread title and starter message on server rename', async () => {
    const threadId = 'thread_boxes_999';
    mockStorage.image_host_threads.set(`${guildId}:boxes`, {
      category: 'boxes',
      thread_id: threadId
    });

    let updatedThreadName = null;
    let updatedMessageContent = null;

    const mockStarterMessage = {
      author: { id: 'bot_id' },
      content: `📂 **Asset Storage Thread**\n**Server:** Old Server Name (\`${guildId}\`)\n**Category:** \`BOXES\`\n*All uploaded boxes assets for this server will be archived and hosted here.*`,
      edit: async ({ content }) => {
        updatedMessageContent = content;
        return mockStarterMessage;
      }
    };

    const mockThread = {
      id: threadId,
      name: `Old Server Name (${guildId})`,
      archived: false,
      deleted: false,
      setName: async (name) => {
        updatedThreadName = name;
        mockThread.name = name;
      },
      fetchStarterMessage: async () => mockStarterMessage
    };

    const mockClient = {
      user: { id: 'bot_id' },
      channels: {
        cache: new Map([[threadId, mockThread]]),
        fetch: async (id) => (id === threadId ? mockThread : null)
      }
    };

    await syncGuildStorageThreads(mockClient, guildId, 'Renamed Gaming Hub');

    assert.equal(updatedThreadName, `Renamed Gaming Hub (${guildId})`, 'Thread title must match new server name and ID');
    assert.ok(updatedMessageContent.includes(`**Server:** Renamed Gaming Hub (\`${guildId}\`)`), 'Starter message Server line must be updated');
  });

  await t.test('Shop navigation should feature Chests at top level and clean Items bottom buttons', async () => {
    // 1. Check /settings main menu shop select options
    let renderedPayload = null;
    const mockInteraction = {
      guildId,
      guild: { id: guildId, name: 'Test Server' },
      deferred: true,
      replied: false,
      editReply: async (data) => { renderedPayload = data; }
    };

    await showMainMenu(mockInteraction);
    const shopRow = renderedPayload.components[0];
    const shopSelect = shopRow.components[0];
    const optionValues = shopSelect.options.map(o => o.data.value);
    assert.ok(optionValues.includes('market_chests'), 'Shop dropdown must contain market_chests option');

    const chestOption = shopSelect.options.find(o => o.data.value === 'market_chests');
    assert.equal(chestOption.data.label, 'Chests');

    // 2. Check Items management panel button row (should only have Back and Post)
    const itemsPanel = await getShopSetupPayload(mockInteraction.guild, guildId, mockInteraction);
    const bottomRow = itemsPanel.components[3];
    assert.equal(bottomRow.components.length, 2, 'Bottom button row must have exactly 2 buttons: Back and Post');
    assert.equal(bottomRow.components[0].data.label, 'Back');
    assert.equal(bottomRow.components[1].data.label, 'Post');
  });

  await t.test('Global embed titles should strictly adhere to clean standardized headers', async () => {
    // 1. Items (was Shop Configuration)
    const mockInteraction = {
      guildId,
      guild: { id: guildId, name: 'Test Server' },
      deferred: true,
      replied: false,
      editReply: async () => {}
    };
    const shopPayload = await getShopSetupPayload(mockInteraction.guild, guildId, mockInteraction);
    assert.equal(shopPayload.embeds[0].data.title, 'Items');

    // 2. Coins (was Coins Management)
    let coinsPayload = null;
    const coinsInteraction = {
      guildId,
      guild: { id: guildId, name: 'Test Server' },
      deferred: true,
      replied: false,
      editReply: async (data) => { coinsPayload = data; }
    };
    await showCoinsSubMenu(coinsInteraction);
    assert.equal(coinsPayload.embeds[0].data.title, 'Coins');

    // 3. Daily (was Daily Configuration)
    const dailyPayload = await getRewardsPayload(mockInteraction.guild, guildId, mockInteraction);
    assert.equal(dailyPayload.embeds[0].data.title, 'Daily');

    // 4. Economy (was Economy Dashboard)
    let ecoPayload = null;
    const ecoInteraction = {
      guildId,
      guild: { id: guildId, name: 'Test Server' },
      user: { id: 'admin_1' },
      customId: 'eco_day',
      isButton: () => true,
      deferred: true,
      replied: false,
      editReply: async (data) => { ecoPayload = data; }
    };
    await handleEconomySettings(ecoInteraction);
    assert.equal(ecoPayload.embeds[0].data.title, 'Economy');

    // 5. Levels (was Levels Configuration / Pass Dashboard)
    const levelsPayload = await getPassDashboardPayload(guildId, 0, null, 'root', 1, mockInteraction);
    assert.equal(levelsPayload.embeds[0].data.title, 'Levels');

    // 6. Settings (was Control Panel)
    let settingsPayload = null;
    const settingsInteraction = {
      guildId,
      guild: { id: guildId, name: 'Test Server', roles: { cache: new Map() } },
      deferred: true,
      replied: false,
      editReply: async (data) => { settingsPayload = data; }
    };
    await showMainMenu(settingsInteraction);
    assert.equal(settingsPayload.embeds[0].data.title, 'Settings');

    // 7. Embeds (was Embed Manager)
    let embedsPayload = null;
    const embedsInteraction = {
      guildId,
      guild: { id: guildId, name: 'Test Server' },
      deferred: true,
      replied: false,
      editReply: async (data) => { embedsPayload = data; }
    };
    await renderRootEmbedMenu(embedsInteraction);
    assert.equal(embedsPayload.embeds[0].data.title, 'Embeds');

    // 8. Logs (was Logs Configuration)
    let logsPayload = null;
    const logsInteraction = {
      guildId,
      guild: { id: guildId, name: 'Test Server', channels: { cache: new Map() } },
      deferred: true,
      replied: false,
      editReply: async (data) => { logsPayload = data; }
    };
    await handleLogsSettings(logsInteraction);
    assert.equal(logsPayload.embeds[0].data.title, 'Logs');

    // 9. Users (was User Management)
    let usersPayload = null;
    const usersInteraction = {
      guildId,
      deferred: true,
      replied: false,
      editReply: async (data) => { usersPayload = data; }
    };
    await showUserSelector(usersInteraction);
    assert.equal(usersPayload.embeds[0].data.title, 'Users');

    // 10. Roles (was Roles Management)
    let rolesPayload = null;
    const rolesInteraction = {
      guildId,
      deferred: true,
      replied: false,
      editReply: async (data) => { rolesPayload = data; }
    };
    await showRolesMenu(rolesInteraction);
    assert.equal(rolesPayload.embeds[0].data.title, 'Roles');

    // 11. Leaderboards (was Leaderboard Configuration)
    let lbPayload = null;
    const lbInteraction = {
      guildId,
      guild: { id: guildId, name: 'Test Server', channels: { cache: new Map() } },
      deferred: true,
      replied: false,
      editReply: async (data) => { lbPayload = data; }
    };
    await handleLeaderboardSettings(lbInteraction);
    assert.equal(lbPayload.embeds[0].data.title, 'Leaderboards');

    // 12. Admins (was Authorized Users)
    let adminsPayload = null;
    const adminsInteraction = {
      guildId,
      guild: {
        id: guildId,
        ownerId: 'owner_1',
        members: { cache: new Map(), fetch: async () => new Map() },
        roles: { cache: new Map(), fetch: async () => new Map() }
      },
      user: { id: 'owner_1' },
      deferred: true,
      replied: false,
      editReply: async (data) => { adminsPayload = data; }
    };
    await showAdminManagement(adminsInteraction);
    assert.equal(adminsPayload.embeds[0].data.title, 'Admins');
  });

  await t.test('Dynamic loot box category name and emoji customization should apply everywhere across UI', async () => {
    configCache.clear();
    const customGuildId = '999111222333444555';
    const customEmoji = '<:minecraftchest:1539577473728254032>';

    mockStorage.guild_configs.set(customGuildId, {
      loot_box_category_name: 'Boxes',
      loot_box_category_emoji: customEmoji
    });

    // 1. Settings main menu shop dropdown
    let renderedPayload = null;
    const mockInteraction = {
      guildId: customGuildId,
      guild: { id: customGuildId, name: 'Custom Server', emojis: { cache: new Map() } },
      deferred: true,
      replied: false,
      editReply: async (data) => { renderedPayload = data; }
    };

    await showMainMenu(mockInteraction);
    const shopRow = renderedPayload.components[0];
    const shopSelect = shopRow.components[0];
    const chestOption = shopSelect.options.find(o => o.data.value === 'market_chests');

    assert.ok(chestOption, 'Shop dropdown must contain market_chests option');
    assert.equal(chestOption.data.label, 'Boxes', 'Option label must match custom category name Boxes');
    assert.equal(chestOption.data.emoji.id, '1539577473728254032', 'Option emoji must resolve custom emoji snowflake ID');
  });
});
