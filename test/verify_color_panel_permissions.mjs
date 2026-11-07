import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits, MessageFlags } from 'discord.js';
import {
  validateColorRolesPrerequisites,
  buildColorRolesWarningEmbed,
  handleColorsComponent
} from '../src/commands/colors.js';
import { setMockPool } from '../src/storage/postgres.js';

describe('Color Panel Creation Preflight Validation Test Suite', () => {
  const guildId = '999888777666555444';
  const botRoleId = '555000111222333444';

  let mockDbRoles = [];

  beforeEach(() => {
    mockDbRoles = [];
    setMockPool({
      query: async (sql, params = []) => {
        const cleanSql = sql.replace(/\s+/g, ' ').trim();
        if (cleanSql.includes('FROM colors') || cleanSql.includes('FROM booster_colors')) {
          const isBooster = cleanSql.includes('FROM booster_colors');
          const filtered = mockDbRoles.filter(r => r.is_booster === isBooster);
          return {
            rows: filtered.map(r => ({
              roleId: r.role_id,
              createdAt: new Date()
            })),
            rowCount: filtered.length
          };
        }
        if (cleanSql.includes('INSERT INTO color_panels')) {
          return { rows: [{ id: 1 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
    });
  });

  function createMockGuild({
    hasManageRoles = true,
    botRolePosition = 50,
    roles = []
  }) {
    const botHighestRole = {
      id: botRoleId,
      name: 'Medhat',
      position: botRolePosition
    };

    const rolesMap = new Map();
    rolesMap.set(botRoleId, botHighestRole);

    for (const r of roles) {
      rolesMap.set(r.id, {
        id: r.id,
        name: r.name || `Role_${r.id}`,
        position: r.position,
        hexColor: r.hexColor || '#3498DB'
      });
    }

    const botMember = {
      roles: {
        highest: botHighestRole
      },
      permissions: {
        has: (flag) => {
          if (flag === PermissionFlagsBits.ManageRoles) return hasManageRoles;
          return true;
        }
      }
    };

    return {
      id: guildId,
      members: {
        me: botMember,
        fetchMe: async () => botMember
      },
      roles: {
        cache: rolesMap,
        fetch: async (id) => (id ? rolesMap.get(id) || null : rolesMap)
      }
    };
  }

  it('1. Rejects validation when bot lacks Manage Roles permission', async () => {
    mockDbRoles = [
      { id: 1, role_id: 'r_101', is_booster: false },
      { id: 2, role_id: 'r_102', is_booster: false }
    ];

    const guild = createMockGuild({
      hasManageRoles: false,
      botRolePosition: 50,
      roles: [
        { id: 'r_101', position: 10 },
        { id: 'r_102', position: 20 }
      ]
    });

    const check = await validateColorRolesPrerequisites(guild, false);
    assert.equal(check.valid, false);
    assert.equal(check.hasManageRoles, false);
    assert.equal(check.higherRolesCount, 0);

    const embed = buildColorRolesWarningEmbed(check, false);
    const desc = embed.data.description;
    assert.ok(desc.includes('Medhat lacks the **Manage Roles** permission'));
    assert.ok(desc.includes('Server Settings → Roles'));
    assert.ok(!desc.includes('Role Hierarchy Conflict'));
  });

  it('2. Rejects validation when color roles are higher than bot role and states count only', async () => {
    mockDbRoles = [
      { id: 1, role_id: 'r_low', is_booster: false },
      { id: 2, role_id: 'r_high_1', is_booster: false },
      { id: 3, role_id: 'r_high_2', is_booster: false },
      { id: 4, role_id: 'r_equal', is_booster: false }
    ];

    const guild = createMockGuild({
      hasManageRoles: true,
      botRolePosition: 50,
      roles: [
        { id: 'r_low', position: 20, name: 'Red' },
        { id: 'r_high_1', position: 60, name: 'Blue' },
        { id: 'r_high_2', position: 75, name: 'Green' },
        { id: 'r_equal', position: 50, name: 'Yellow' } // Equal is also unmanageable
      ]
    });

    const check = await validateColorRolesPrerequisites(guild, false);
    assert.equal(check.valid, false);
    assert.equal(check.hasManageRoles, true);
    assert.equal(check.higherRolesCount, 3, 'Must detect 3 conflicting roles (2 higher, 1 equal)');

    const embed = buildColorRolesWarningEmbed(check, false);
    const desc = embed.data.description;
    assert.ok(desc.includes('Role Hierarchy Conflict'));
    assert.ok(desc.includes('**3** color role(s) are positioned above or equal'));
    assert.ok(desc.includes(`<@&${botRoleId}>`));
    // Verify individual role names/mentions are NOT listed
    assert.ok(!desc.includes('r_high_1'));
    assert.ok(!desc.includes('r_high_2'));
    assert.ok(!desc.includes('r_equal'));
    assert.ok(!desc.includes('Blue'));
    assert.ok(!desc.includes('Green'));
    assert.ok(!desc.includes('Yellow'));
  });

  it('3. Compound failure: Reports both Manage Roles and Hierarchy count cleanly', async () => {
    mockDbRoles = [
      { id: 1, role_id: 'r_above', is_booster: false }
    ];

    const guild = createMockGuild({
      hasManageRoles: false,
      botRolePosition: 10,
      roles: [
        { id: 'r_above', position: 20, name: 'Purple' }
      ]
    });

    const check = await validateColorRolesPrerequisites(guild, false);
    assert.equal(check.valid, false);
    assert.equal(check.hasManageRoles, false);
    assert.equal(check.higherRolesCount, 1);

    const embed = buildColorRolesWarningEmbed(check, false);
    const desc = embed.data.description;
    assert.ok(desc.includes('Missing Permission:'));
    assert.ok(desc.includes('Role Hierarchy Conflict:'));
    assert.ok(desc.includes('**1** color role(s)'));
    assert.ok(desc.includes('Server Settings → Roles'));
  });

  it('4. Rejects validation when color roles list is empty', async () => {
    mockDbRoles = []; // Empty

    const guild = createMockGuild({
      hasManageRoles: true,
      botRolePosition: 50,
      roles: []
    });

    const check = await validateColorRolesPrerequisites(guild, false);
    assert.equal(check.valid, false);
    assert.equal(check.emptyList, true);
  });

  it('5. Passes validation cleanly when bot has Manage Roles and roles are below bot', async () => {
    mockDbRoles = [
      { id: 1, role_id: 'r_1', is_booster: false },
      { id: 2, role_id: 'r_2', is_booster: false }
    ];

    const guild = createMockGuild({
      hasManageRoles: true,
      botRolePosition: 50,
      roles: [
        { id: 'r_1', position: 10 },
        { id: 'r_2', position: 20 }
      ]
    });

    const check = await validateColorRolesPrerequisites(guild, false);
    assert.equal(check.valid, true);
    assert.equal(check.hasManageRoles, true);
    assert.equal(check.higherRolesCount, 0);
  });

  it('6. Full Component Integration: Delivers private followUp warning and preserves dashboard', async () => {
    mockDbRoles = [
      { id: 1, role_id: 'r_top', is_booster: false }
    ];

    const guild = createMockGuild({
      hasManageRoles: true,
      botRolePosition: 20,
      roles: [
        { id: 'r_top', position: 35 } // Above bot
      ]
    });

    let followUpCalls = [];
    let editReplyCalls = [];

    const mockInteraction = {
      guildId,
      guild,
      user: { id: 'admin_123', tag: 'Admin#0001' },
      member: { id: 'admin_123', displayName: 'Admin' },
      client: { user: { id: 'bot_id' } },
      channelId: 'chan_999',
      channel: {
        id: 'chan_999',
        isTextBased: () => true,
        permissionsFor: () => ({
          has: () => true
        }),
        send: async () => ({ id: 'msg_panel_1' })
      },
      customId: 'colors_create_normal',
      isButton: () => true,
      isAnySelectMenu: () => false,
      deferred: true,
      replied: false,
      deferUpdate: async () => {},
      followUp: async (payload) => {
        followUpCalls.push(payload);
        return payload;
      },
      editReply: async (payload) => {
        editReplyCalls.push(payload);
        return payload;
      }
    };

    // Step 1: Admin clicks Create Panel with hierarchy issue
    await handleColorsComponent(mockInteraction);

    assert.equal(followUpCalls.length, 1, 'Must dispatch warning via followUp');
    assert.equal(editReplyCalls.length, 0, 'Must NOT touch or overwrite dashboard via editReply');
    assert.equal(followUpCalls[0].flags, MessageFlags.Ephemeral, 'Warning must be strictly ephemeral');

    const warningEmbed = followUpCalls[0].embeds[0];
    assert.ok(warningEmbed.data.title.includes('Cannot Create Color Panel'));
    assert.ok(warningEmbed.data.description.includes('**1** color role(s)'));

    // Step 2: Admin fixes issue in Discord (moves bot role to 50)
    guild.members.me.roles.highest.position = 50;
    followUpCalls = [];
    editReplyCalls = [];

    // Step 3: Admin clicks Create Panel again
    await handleColorsComponent(mockInteraction);

    assert.equal(followUpCalls.length, 0, 'No warning embed should appear when issue is solved');
    assert.equal(editReplyCalls.length, 1, 'Should complete deployment and render success embed');
    assert.ok(editReplyCalls[0].embeds[0].data.title.includes('Color Panels Deployed'));
  });
});
