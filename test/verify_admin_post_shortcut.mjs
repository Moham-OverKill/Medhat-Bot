import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags, ChannelType } from 'discord.js';
import {
  ADMIN_SHORTCUT_REGISTRY,
  getAdminShortcutMeta,
  normalizeAdminShortcutOrder,
  buildAdminHubButtons,
  handleAdminHubComponent,
  showAdminInterfaceSlotAssign
} from '../src/commands/interface.js';
import {
  handleShopPostGate,
  handleShopPostStart,
  handleShopPostNewLayout,
  handleShopPostChannelSelect,
  setPendingPostSession,
  getPendingPostSession,
  deletePendingPostSession
} from '../src/commands/shop-setup.js';
import { setMockPool } from '../src/storage/postgres.js';
import { configCache } from '../src/storage/config.js';

describe('Admin Interface Post Shortcut & Channel Selection Suite', () => {
  const validGuildId = '123456789012345678';
  const validUserId = '649702547459670017';
  const validChannelId = '987654321098765432';

  beforeEach(() => {
    configCache.clear();
  });

  it('1. ADMIN_SHORTCUT_REGISTRY includes post shortcut metadata', () => {
    const entry = ADMIN_SHORTCUT_REGISTRY.post;
    assert.ok(entry, 'post shortcut must be registered in ADMIN_SHORTCUT_REGISTRY');
    assert.equal(entry.id, 'post');
    assert.equal(entry.name, 'Post');
    assert.equal(entry.label, 'POST');
    assert.equal(entry.emoji, '📢');
    assert.equal(entry.buttonCustomId, 'admin_hub_post');
    assert.ok(entry.description && entry.description.length > 0, 'Must have description');
  });

  it('2. getAdminShortcutMeta resolves post shortcut', () => {
    const meta = getAdminShortcutMeta('post');
    assert.ok(meta, 'Must resolve by post');
    assert.equal(meta.id, 'post');
    assert.equal(meta.buttonCustomId, 'admin_hub_post');
  });

  it('3. showAdminInterfaceSlotAssign presents post option in module select dropdown', async () => {
    let replyPayload = null;
    const mockInteraction = {
      guildId: validGuildId,
      guild: {
        id: validGuildId,
        emojis: { cache: new Map() }
      },
      deferred: true,
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
              admin_shortcut_order: ['post', 'empty', 'empty', 'empty'],
              admin_slot_colors: ['#000000'],
              admin_slot_button_colors: ['secondary']
            }]
          };
        }
        return { rows: [] };
      }
    });

    await showAdminInterfaceSlotAssign(mockInteraction, 0);

    assert.ok(replyPayload, 'Must editReply with assign menu');
    const menuRow = replyPayload.components[0];
    const selectMenu = menuRow.components[0];
    const options = selectMenu.options;
    const postOpt = options.find(o => o.data.value === 'post');

    assert.ok(postOpt, 'Module select dropdown must contain post option');
    assert.equal(postOpt.data.label, 'Post');
    assert.equal(postOpt.data.default, true, 'Slot 0 must have post marked as default');
  });

  it('4. buildAdminHubButtons renders post shortcut button with admin_hub_post customId', () => {
    const shortcutOrder = [
      'colors', 'levels', 'roles', 'post',
      'coins', 'shop', 'economy', 'empty',
      'users', 'anticheat', 'automod', 'empty'
    ];

    const buttonRows = buildAdminHubButtons(validGuildId, null, shortcutOrder, null);
    assert.ok(buttonRows.length > 0, 'Must generate button rows');
    const firstRowButtons = buttonRows[0].components;
    assert.equal(firstRowButtons.length, 4);

    const postBtn = firstRowButtons[3];
    assert.equal(postBtn.data.custom_id, 'admin_hub_post', 'Fourth button in row 1 must be admin_hub_post');
  });

  it('5. handleAdminHubComponent routes admin_hub_post to handleShopPostGate with disabled Back button', async () => {
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
      customId: 'admin_hub_post',
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
      query: async () => ({ rows: [] })
    });

    await handleAdminHubComponent(mockInteraction);

    assert.equal(deferredWithFlags, MessageFlags.Ephemeral, 'Must defer reply with Ephemeral flag');
    assert.ok(editReplyPayload, 'Must render post gate in ephemeral reply');
    assert.equal(editReplyPayload.embeds[0].data.title, 'Post');

    // Verify back button is disabled when accessed from admin hub
    const buttonRow = editReplyPayload.components[0];
    const backBtn = buttonRow.components[0];
    assert.equal(backBtn.data.custom_id, 'settings_back');
    assert.equal(backBtn.data.disabled, true, 'Back button must be disabled for admin hub ephemeral interaction');
  });

  it('6. handleShopPostGate accessed from /settings has enabled Back button', async () => {
    let editReplyPayload = null;
    const mockInteraction = {
      guildId: validGuildId,
      user: { id: validUserId, tag: 'Admin#0001' },
      guild: {
        id: validGuildId,
        ownerId: validUserId,
        members: { cache: new Map() },
        channels: { cache: new Map() },
        roles: { cache: new Map() }
      },
      customId: 'settings_menu_market',
      message: {
        components: [
          { components: [{ customId: 'settings_back', disabled: false }] }
        ]
      },
      deferred: false,
      replied: false,
      isMessageComponent: () => true,
      deferUpdate: async () => { mockInteraction.deferred = true; },
      editReply: async (payload) => {
        editReplyPayload = payload;
        return payload;
      }
    };

    setMockPool({
      query: async () => ({ rows: [] })
    });

    await handleShopPostGate(mockInteraction);

    assert.ok(editReplyPayload, 'Must render post gate');
    const buttonRow = editReplyPayload.components[0];
    const backBtn = buttonRow.components[0];
    assert.equal(backBtn.data.custom_id, 'settings_back');
    assert.equal(backBtn.data.disabled, false, 'Back button must be enabled when accessed from /settings');
  });

  it('7. handleShopPostStart includes ChannelSelectMenu and respects editing disable state', async () => {
    let editReplyPayload = null;
    const sessionId = 'test-session-1';

    // Mock an active item in DB
    setMockPool({
      query: async (sql) => {
        if (sql.includes('shop_items')) {
          return {
            rows: [
              { id: 101, name: 'Normal Chest', price: 0, is_active: true, item_type: 'normal' }
            ]
          };
        }
        if (sql.includes('shop_categories')) {
          return { rows: [] };
        }
        if (sql.includes('guild_configs')) {
          return { rows: [{ config: {} }] };
        }
        return { rows: [] };
      }
    });

    // Subtest 7A: Creation mode
    await setPendingPostSession(sessionId, {
      itemId: 101,
      channelId: null,
      fromAdminHub: true,
      isEditing: false
    });

    const mockInteractionCreate = {
      _postSessionId: sessionId,
      guildId: validGuildId,
      channelId: validChannelId,
      user: { id: validUserId },
      guild: {
        id: validGuildId,
        channels: { cache: new Map() },
        roles: { cache: new Map() }
      },
      deferred: true,
      replied: true,
      editReply: async (payload) => {
        editReplyPayload = payload;
        return payload;
      }
    };

    await handleShopPostStart(mockInteractionCreate);

    assert.ok(editReplyPayload, 'Must render shop post staging');
    assert.equal(editReplyPayload.components.length, 5, 'Must have exactly 5 ActionRows in creation mode');

    // Row 1 must be ChannelSelectMenuBuilder
    const channelRow = editReplyPayload.components[1];
    const channelSelect = channelRow.components[0];
    assert.ok(channelSelect.data.custom_id.startsWith('shop_post_channel_select'), 'Must be channel select');
    assert.equal(Boolean(channelSelect.data.disabled), false, 'Channel select must be enabled in creation mode');
    assert.ok(channelSelect.data.channel_types.includes(ChannelType.GuildText), 'Must support GuildText');

    // Action row (last row): Publish button must be disabled because channelId is null
    const actionRow = editReplyPayload.components[4];
    const publishBtn = actionRow.components.find(c => c.data.label === 'Publish');
    assert.ok(publishBtn, 'Publish button must exist');
    assert.equal(publishBtn.data.disabled, true, 'Publish button must be disabled when channelId is null');

    // Subtest 7B: Editing mode - channel select menu is completely hidden
    await setPendingPostSession(sessionId, {
      itemId: 101,
      channelId: validChannelId,
      fromAdminHub: false,
      isEditing: true
    });

    await handleShopPostStart(mockInteractionCreate);
    assert.equal(editReplyPayload.components.length, 3, 'Must have 3 ActionRows in editing mode (no item select, no channel select)');

    const hasChannelSelect = editReplyPayload.components.some(row =>
      row.components.some(c => c.data?.custom_id?.startsWith('shop_post_channel_select'))
    );
    assert.equal(hasChannelSelect, false, 'Channel select menu must be completely hidden when editing an existing post');

    const editActionRow = editReplyPayload.components[2];
    const updateBtn = editActionRow.components.find(c => c.data.label === 'Update');
    assert.ok(updateBtn, 'Update button must exist in editing mode');
    assert.equal(updateBtn.data.disabled, false, 'Update button must be enabled in editing mode');
  });

  it('8. Embed status description matches new 3-line format without bullets', async () => {
    let editReplyPayload = null;
    const sessionId = 'test-session-2';

    setMockPool({
      query: async (sql) => {
        if (sql.includes('shop_items')) {
          return {
            rows: [
              { id: 102, name: 'Normal Chest', price: 0, is_active: true, item_type: 'normal' }
            ]
          };
        }
        return { rows: [] };
      }
    });

    await setPendingPostSession(sessionId, {
      itemId: 102,
      channelId: validChannelId,
      fromAdminHub: false,
      isEditing: false,
      stock: null,
      overridePrice: 0,
      restockIntervalSeconds: null,
      claimLimit: null
    });

    const mockInteraction = {
      _postSessionId: sessionId,
      guildId: validGuildId,
      channelId: validChannelId,
      user: { id: validUserId },
      guild: {
        id: validGuildId,
        channels: { cache: new Map() },
        roles: { cache: new Map() }
      },
      deferred: true,
      replied: true,
      editReply: async (payload) => {
        editReplyPayload = payload;
        return payload;
      }
    };

    await handleShopPostStart(mockInteraction);

    const embed = editReplyPayload.embeds[0];
    const desc = embed.data.description;
    assert.ok(desc, 'Must have description');

    // Expected format:
    // Post **Normal Chest** In <#987654321098765432>
    // for `Free` with `Unlimited` Stocks
    // `No Restock` Timer - `No limit` per user
    const lines = desc.split('\n');
    assert.equal(lines[0], `Post **Normal Chest** In <#${validChannelId}>`);
    assert.equal(lines[1], 'for `Free` with `Unlimited` Stocks');
    assert.equal(lines[2], '`No Restock` Timer - `No limit` per user');

    // Verify no line starts with bullet '•'
    for (const line of lines) {
      assert.ok(!line.startsWith('•'), `Line must not start with bullet: "${line}"`);
    }
  });

  it('9. handleShopPostNewLayout defaults channel to null when from admin hub, interaction.channelId when from settings', async () => {
    setMockPool({ query: async () => ({ rows: [] }) });

    // Hub scenario: Back button disabled
    const hubSessionId = 'test-hub-session';
    const hubInteraction = {
      guildId: validGuildId,
      channelId: validChannelId,
      user: { id: validUserId },
      guild: { id: validGuildId },
      customId: `shop_post_new_layout:${hubSessionId}`,
      message: {
        components: [
          { components: [{ customId: 'settings_back', disabled: true }] }
        ]
      },
      deferred: true,
      replied: true,
      editReply: async () => {}
    };

    await handleShopPostNewLayout(hubInteraction);
    const hubState = await getPendingPostSession(hubSessionId);
    assert.equal(hubState.fromAdminHub, true);
    assert.equal(hubState.channelId, null, 'Must be null when coming from admin hub');

    // Settings scenario: Back button enabled
    const settingsSessionId = 'test-settings-session';
    const settingsInteraction = {
      guildId: validGuildId,
      channelId: validChannelId,
      user: { id: validUserId },
      guild: { id: validGuildId },
      customId: `shop_post_new_layout:${settingsSessionId}`,
      message: {
        components: [
          { components: [{ customId: 'settings_back', disabled: false }] }
        ]
      },
      deferred: true,
      replied: true,
      editReply: async () => {}
    };

    await handleShopPostNewLayout(settingsInteraction);
    const settingsState = await getPendingPostSession(settingsSessionId);
    assert.equal(settingsState.fromAdminHub, false);
    assert.equal(settingsState.channelId, validChannelId, 'Must default to interaction.channelId when coming from settings');
  });
});
