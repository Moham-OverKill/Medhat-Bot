import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setMockPool } from '../src/storage/postgres.js';
import {
  DEFAULT_SHORTCUT_ORDER,
  DEFAULT_SLOT_COLORS,
  DEFAULT_SLOT_BUTTON_COLORS,
  DEFAULT_ADMIN_SHORTCUT_ORDER,
  DEFAULT_ADMIN_SLOT_COLORS,
  DEFAULT_ADMIN_SLOT_BUTTON_COLORS,
  buildHubButtons,
  buildAdminHubButtons,
  generateInterfaceBanner,
  generateAdminInterfaceBanner,
  handleInterfaceComponent,
  handleHubShortcut,
  handleAdminHubComponent,
  getInterfaceConfig,
  saveInterfaceConfig,
  showInterfaceSettings,
  showAdminInterfaceSettings,
  showInterfaceSetup,
  showAdminInterfaceSetup
} from '../src/commands/interface.js';
import { ButtonStyle } from 'discord.js';

describe('Interface Reset & Canonical Default Overlay Test Suite', () => {
  const validGuildId = '723544218081034303';
  const validUserId = '123456789012345678';

  it('1. DEFAULT_SHORTCUT_ORDER matches canonical 3x3 layout with empty 4th column', () => {
    assert.equal(DEFAULT_SHORTCUT_ORDER.length, 12);
    assert.deepEqual(DEFAULT_SHORTCUT_ORDER, [
      'level', 'profile', 'inventory', 'empty',
      'daily', 'quests', 'vote', 'empty',
      'items', 'notifications', 'invite', 'empty'
    ]);
  });

  it('2. DEFAULT_SLOT_COLORS matches Grey, Green, Light Blue across rows', () => {
    assert.equal(DEFAULT_SLOT_COLORS.length, 12);
    assert.deepEqual(DEFAULT_SLOT_COLORS, [
      '#636e72', '#636e72', '#636e72', '#000000',
      '#43b581', '#43b581', '#43b581', '#000000',
      '#29b6f6', '#29b6f6', '#29b6f6', '#000000'
    ]);
  });

  it('3. DEFAULT_SLOT_BUTTON_COLORS matches Secondary, Success, Primary styles', () => {
    assert.equal(DEFAULT_SLOT_BUTTON_COLORS.length, 12);
    assert.deepEqual(DEFAULT_SLOT_BUTTON_COLORS, [
      'secondary', 'secondary', 'secondary', 'secondary',
      'success', 'success', 'success', 'secondary',
      'primary', 'primary', 'primary', 'secondary'
    ]);
  });

  it('4. DEFAULT_ADMIN_SHORTCUT_ORDER matches 12 populated modules across 3 rows', () => {
    assert.equal(DEFAULT_ADMIN_SHORTCUT_ORDER.length, 12);
    assert.deepEqual(DEFAULT_ADMIN_SHORTCUT_ORDER, [
      'colors', 'levels', 'roles', 'leaderboard',
      'coins', 'shop', 'chests', 'post',
      'users', 'anticheat', 'automod', 'embed'
    ]);
  });

  it('5. DEFAULT_ADMIN_SLOT_COLORS and BUTTON_COLORS are all black and gray', () => {
    assert.equal(DEFAULT_ADMIN_SLOT_COLORS.length, 12);
    assert.ok(DEFAULT_ADMIN_SLOT_COLORS.every(c => c === '#000000'));
    assert.equal(DEFAULT_ADMIN_SLOT_BUTTON_COLORS.length, 12);
    assert.ok(DEFAULT_ADMIN_SLOT_BUTTON_COLORS.every(c => c === 'secondary'));
  });

  it('6. buildHubButtons builds 3 rows with 3 buttons each for Community Shortcuts', () => {
    const rows = buildHubButtons(null, DEFAULT_SHORTCUT_ORDER, DEFAULT_SLOT_BUTTON_COLORS);
    assert.equal(rows.length, 3, 'Must have 3 ActionRows');

    // Row 1: Level, Profile, Inventory (Secondary)
    assert.equal(rows[0].components.length, 3);
    assert.equal(rows[0].components[0].data.style, ButtonStyle.Secondary);
    assert.equal(rows[0].components[1].data.style, ButtonStyle.Secondary);
    assert.equal(rows[0].components[2].data.style, ButtonStyle.Secondary);

    // Row 2: Daily, Quests, Vote (Success)
    assert.equal(rows[1].components.length, 3);
    assert.equal(rows[1].components[0].data.style, ButtonStyle.Success);
    assert.equal(rows[1].components[1].data.style, ButtonStyle.Success);
    assert.equal(rows[1].components[2].data.style, ButtonStyle.Success);

    // Row 3: Items, Notifications, Invite (Primary)
    assert.equal(rows[2].components.length, 3);
    assert.equal(rows[2].components[0].data.style, ButtonStyle.Primary);
    assert.equal(rows[2].components[1].data.style, ButtonStyle.Primary);
    assert.equal(rows[2].components[2].data.style, ButtonStyle.Primary);
  });

  it('7. buildAdminHubButtons builds 3 rows with 4 buttons each for Admin Dashboard', () => {
    const rows = buildAdminHubButtons(validGuildId, null, DEFAULT_ADMIN_SHORTCUT_ORDER, DEFAULT_ADMIN_SLOT_BUTTON_COLORS);
    assert.equal(rows.length, 3, 'Must have 3 ActionRows');
    assert.equal(rows[0].components.length, 4, 'Row 1 must have 4 buttons');
    assert.equal(rows[1].components.length, 4, 'Row 2 must have 4 buttons');
    assert.equal(rows[2].components.length, 4, 'Row 3 must have 4 buttons');
    for (const row of rows) {
      for (const btn of row.components) {
        assert.equal(btn.data.style, ButtonStyle.Secondary);
      }
    }
  });

  it('8. generateInterfaceBanner and generateAdminInterfaceBanner render without throwing', async () => {
    const commBanner = await generateInterfaceBanner(DEFAULT_SHORTCUT_ORDER, { slotColors: DEFAULT_SLOT_COLORS });
    assert.ok(Buffer.isBuffer(commBanner) && commBanner.length > 0);

    const adminBanner = await generateAdminInterfaceBanner(DEFAULT_ADMIN_SHORTCUT_ORDER, {
      slotColors: DEFAULT_ADMIN_SLOT_COLORS,
      guildId: validGuildId
    });
    assert.ok(Buffer.isBuffer(adminBanner) && adminBanner.length > 0);
  });

  it('9. interface_reset_defaults resets custom configuration to canonical defaults', async () => {
    let savedConfig = null;
    setMockPool({
      query: async (sql, params) => {
        if (typeof sql === 'string' && sql.includes('SELECT') && sql.includes('server_interface_config')) {
          return {
            rows: [{
              guild_id: validGuildId,
              is_enabled: true,
              shortcut_order: ['empty', 'empty', 'empty', 'empty', 'empty', 'empty', 'empty', 'empty', 'empty', 'empty', 'empty', 'empty'],
              slot_colors: ['#eb459e', '#eb459e', '#eb459e', '#eb459e', '#eb459e', '#eb459e', '#eb459e', '#eb459e', '#eb459e', '#eb459e', '#eb459e', '#eb459e'],
              slot_button_colors: ['danger', 'danger', 'danger', 'danger', 'danger', 'danger', 'danger', 'danger', 'danger', 'danger', 'danger', 'danger']
            }]
          };
        }
        if (typeof sql === 'string' && sql.includes('INSERT INTO server_interface_config')) {
          savedConfig = {
            shortcut_order: params[2],
            slot_colors: params[3],
            slot_button_colors: params[4]
          };
          return {
            rows: [{
              guild_id: validGuildId,
              is_enabled: true,
              shortcut_order: params[2],
              slot_colors: params[3],
              slot_button_colors: params[4],
              admin_is_enabled: true,
              admin_shortcut_order: params[10],
              admin_slot_colors: params[11],
              admin_slot_button_colors: params[12]
            }]
          };
        }
        return { rows: [] };
      }
    });

    let editPayload = null;
    const mockInteraction = {
      guildId: validGuildId,
      customId: 'interface_reset_defaults',
      user: { id: validUserId },
      member: { id: validUserId, permissions: { has: () => true } },
      memberPermissions: { has: () => true },
      guild: { id: validGuildId, members: { fetch: async () => null, cache: new Map() } },
      deferUpdate: async () => {},
      editReply: async (p) => { editPayload = p; return p; }
    };

    await handleInterfaceComponent(mockInteraction);
    assert.ok(savedConfig, 'Must have saved interface config');
    assert.deepEqual(JSON.parse(savedConfig.shortcut_order), DEFAULT_SHORTCUT_ORDER);
    assert.deepEqual(JSON.parse(savedConfig.slot_colors), DEFAULT_SLOT_COLORS);
    assert.deepEqual(JSON.parse(savedConfig.slot_button_colors), DEFAULT_SLOT_BUTTON_COLORS);
    assert.ok(editPayload && editPayload.files && editPayload.files.length > 0);
    assert.ok(editPayload.files[0].name.startsWith('preview_'), 'Must use timestamped preview filename');
  });

  it('10. admin_interface_reset_defaults resets custom configuration to canonical defaults', async () => {
    let savedConfig = null;
    setMockPool({
      query: async (sql, params) => {
        if (typeof sql === 'string' && sql.includes('SELECT') && sql.includes('server_interface_config')) {
          return {
            rows: [{
              guild_id: validGuildId,
              admin_is_enabled: true,
              admin_shortcut_order: ['empty', 'empty', 'empty', 'empty', 'empty', 'empty', 'empty', 'empty', 'empty', 'empty', 'empty', 'empty'],
              admin_slot_colors: ['#eb459e', '#eb459e', '#eb459e', '#eb459e', '#eb459e', '#eb459e', '#eb459e', '#eb459e', '#eb459e', '#eb459e', '#eb459e', '#eb459e'],
              admin_slot_button_colors: ['danger', 'danger', 'danger', 'danger', 'danger', 'danger', 'danger', 'danger', 'danger', 'danger', 'danger', 'danger']
            }]
          };
        }
        if (typeof sql === 'string' && sql.includes('INSERT INTO server_interface_config')) {
          savedConfig = {
            admin_shortcut_order: params[10],
            admin_slot_colors: params[11],
            admin_slot_button_colors: params[12]
          };
          return {
            rows: [{
              guild_id: validGuildId,
              is_enabled: true,
              shortcut_order: params[2],
              slot_colors: params[3],
              slot_button_colors: params[4],
              admin_is_enabled: true,
              admin_shortcut_order: params[10],
              admin_slot_colors: params[11],
              admin_slot_button_colors: params[12]
            }]
          };
        }
        return { rows: [] };
      }
    });

    let editPayload = null;
    const mockInteraction = {
      guildId: validGuildId,
      customId: 'admin_interface_reset_defaults',
      user: { id: validUserId },
      member: { id: validUserId, permissions: { has: () => true } },
      memberPermissions: { has: () => true },
      guild: { id: validGuildId, members: { fetch: async () => null, cache: new Map() } },
      deferUpdate: async () => {},
      editReply: async (p) => { editPayload = p; return p; }
    };

    await handleInterfaceComponent(mockInteraction);
    assert.ok(savedConfig, 'Must have saved admin interface config');
    assert.deepEqual(JSON.parse(savedConfig.admin_shortcut_order), DEFAULT_ADMIN_SHORTCUT_ORDER);
    assert.deepEqual(JSON.parse(savedConfig.admin_slot_colors), DEFAULT_ADMIN_SLOT_COLORS);
    assert.deepEqual(JSON.parse(savedConfig.admin_slot_button_colors), DEFAULT_ADMIN_SLOT_BUTTON_COLORS);
    assert.ok(editPayload && editPayload.files && editPayload.files.length > 0);
    assert.ok(editPayload.files[0].name.startsWith('admin_preview_'), 'Must use timestamped admin preview filename');
  });

  it('11. handleHubShortcut routes all 9 community buttons safely without crashing', async () => {
    setMockPool({
      query: async () => ({ rows: [] })
    });

    const buttons = [
      'hub_btn_level',
      'hub_btn_profile',
      'hub_btn_inventory',
      'hub_btn_daily',
      'hub_btn_quests',
      'hub_btn_vote',
      'hub_btn_items',
      'hub_btn_notifications',
      'hub_btn_invite'
    ];

    for (const btnId of buttons) {
      let replied = false;
      const mockInteraction = {
        guildId: validGuildId,
        customId: btnId,
        user: { id: validUserId, username: 'testuser', displayAvatarURL: () => 'https://example.com/avatar.png' },
        member: { id: validUserId, displayName: 'testuser', displayAvatarURL: () => 'https://example.com/avatar.png', roles: { cache: new Map() } },
        guild: {
          id: validGuildId,
          members: { fetch: async () => null, cache: new Map() },
          roles: { fetch: async () => new Map(), cache: new Map() }
        },
        client: { user: { id: '815148891598356502' } },
        deferred: false,
        replied: false,
        isChatInputCommand: () => false,
        isButton: () => true,
        deferReply: async () => { mockInteraction.deferred = true; },
        editReply: async () => { replied = true; },
        reply: async () => { replied = true; }
      };

      try {
        await handleHubShortcut(mockInteraction);
      } catch (err) {
        assert.fail(`Button ${btnId} threw an unexpected error: ${err.message}`);
      }
    }
  });

  it('12. handleAdminHubComponent routes all 12 admin buttons safely with ephemeral deferral', async () => {
    setMockPool({
      query: async () => ({ rows: [] })
    });

    const adminButtons = [
      'admin_hub_colors',
      'admin_hub_pass',
      'admin_hub_roles',
      'admin_hub_leaderboards',
      'admin_hub_coins',
      'admin_hub_shop',
      'admin_hub_chests',
      'admin_hub_post',
      'admin_hub_users',
      'admin_hub_anticheat',
      'admin_hub_automod',
      'admin_hub_embed'
    ];

    for (const btnId of adminButtons) {
      let deferredEphemeral = false;
      const mockInteraction = {
        guildId: validGuildId,
        channelId: '123456789012345678',
        customId: btnId,
        user: { id: validUserId, username: 'adminuser' },
        member: { id: validUserId, displayName: 'adminuser', roles: { cache: new Map() }, permissions: { has: () => true } },
        guild: {
          id: validGuildId,
          members: { fetch: async () => null, cache: new Map() },
          roles: { fetch: async () => new Map(), cache: new Map() },
          channels: { fetch: async () => null, cache: new Map() }
        },
        client: { user: { id: '815148891598356502' } },
        deferred: false,
        replied: false,
        deferReply: async (opts) => {
          mockInteraction.deferred = true;
          if (opts?.flags) deferredEphemeral = true;
        },
        editReply: async () => {},
        reply: async () => {}
      };

      try {
        await handleAdminHubComponent(mockInteraction);
        assert.equal(deferredEphemeral, true, `Button ${btnId} must defer ephemerally`);
      } catch (err) {
        assert.fail(`Admin button ${btnId} threw an unexpected error: ${err.message}`);
      }
    }
  });

  it('13. showInterfaceSettings preserves 4-button row [Back] [Disable/Enable] [Setup] [Send/Update] and self-heals deleted messages', async () => {
    let payload = null;
    let savedConfig = null;

    const mockInteraction = {
      guildId: validGuildId,
      deferred: true,
      replied: false,
      guild: {
        id: validGuildId,
        channels: {
          cache: new Map(),
          fetch: async () => ({
            isTextBased: () => true,
            messages: {
              // Simulate message was deleted from Discord
              fetch: async () => null
            }
          })
        }
      },
      editReply: async (p) => { payload = p; return p; }
    };

    setMockPool({
      query: async (sql, params) => {
        if (sql.includes('INSERT INTO server_interface_config') || sql.includes('UPDATE server_interface_config')) {
          savedConfig = params;
          return { rows: [{ guild_id: validGuildId }] };
        }
        return {
          rows: [{
            guild_id: validGuildId,
            is_enabled: true,
            target_channel_id: '999888777666555444',
            message_id: '111222333444555666'
          }]
        };
      }
    });

    await showInterfaceSettings(mockInteraction);

    assert.ok(payload);
    assert.equal(payload.components.length, 2, 'Must have channel select + button row');
    const buttonRow = payload.components[1].components;
    assert.equal(buttonRow.length, 4, 'Must have strictly 4 buttons');
    assert.equal(buttonRow[0].data.label, 'Back');
    assert.equal(buttonRow[1].data.label, 'Disable');
    assert.equal(buttonRow[2].data.label, 'Setup');
    assert.equal(buttonRow[3].data.label, 'Send', 'Button must revert to Send when message is deleted');
    assert.equal(buttonRow[3].data.custom_id, 'interface_publish_btn');
  });

  it('14. showInterfaceSetup has strictly 2 bottom buttons [Back] [Reset] and renders 12 slot buttons (3 rows of 4)', async () => {
    let payload = null;

    const mockInteraction = {
      guildId: validGuildId,
      deferred: true,
      replied: false,
      guild: { id: validGuildId },
      editReply: async (p) => { payload = p; return p; }
    };

    setMockPool({
      query: async () => ({
        rows: [{
          guild_id: validGuildId,
          shortcut_order: [...DEFAULT_SHORTCUT_ORDER],
          slot_colors: [...DEFAULT_SLOT_COLORS],
          slot_button_colors: [...DEFAULT_SLOT_BUTTON_COLORS]
        }]
      })
    });

    await showInterfaceSetup(mockInteraction);

    assert.ok(payload);
    assert.equal(payload.components.length, 4, '3 slot rows + 1 navigation row');
    // Each slot row must have 4 buttons (3 configured features + 1 empty slot '+' allowing expansion)
    assert.equal(payload.components[0].components.length, 4, 'Row 1 must have 4 buttons');
    assert.equal(payload.components[1].components.length, 4, 'Row 2 must have 4 buttons');
    assert.equal(payload.components[2].components.length, 4, 'Row 3 must have 4 buttons');

    // Bottom row has strictly Back and Reset
    const navRow = payload.components[3].components;
    assert.equal(navRow.length, 2, 'Bottom nav row must have strictly 2 buttons');
    assert.equal(navRow[0].data.label, 'Back');
    assert.equal(navRow[1].data.label, 'Reset');
  });

  it('15. showAdminInterfaceSetup has strictly 2 bottom buttons [Back] [Reset]', async () => {
    let payload = null;

    const mockInteraction = {
      guildId: validGuildId,
      deferred: true,
      replied: false,
      guild: { id: validGuildId },
      editReply: async (p) => { payload = p; return p; }
    };

    setMockPool({
      query: async () => ({
        rows: [{
          guild_id: validGuildId,
          admin_shortcut_order: [...DEFAULT_ADMIN_SHORTCUT_ORDER],
          admin_slot_colors: [...DEFAULT_ADMIN_SLOT_COLORS],
          admin_slot_button_colors: [...DEFAULT_ADMIN_SLOT_BUTTON_COLORS]
        }]
      })
    });

    await showAdminInterfaceSetup(mockInteraction);

    assert.ok(payload);
    assert.equal(payload.components.length, 4, '3 slot rows + 1 navigation row');
    // Bottom row has strictly Back and Reset
    const navRow = payload.components[3].components;
    assert.equal(navRow.length, 2, 'Bottom nav row must have strictly 2 buttons');
    assert.equal(navRow[0].data.label, 'Back');
    assert.equal(navRow[1].data.label, 'Reset');
  });
});
