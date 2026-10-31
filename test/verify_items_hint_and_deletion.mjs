import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { getSettingsHint } from '../src/commands/settings/hints.js';
import {
  handleDeleteItemSelect,
  handleDeleteItemConfirmOnly,
  handleDeleteItemConfirmBoth,
  handleDeleteItemCancel,
  validateRoleDeletable,
  safelyDeleteConnectedRole
} from '../src/commands/shop-setup.js';
import { setMockPool } from '../src/storage/postgres.js';
import { configCache } from '../src/storage/config.js';

test('getSettingsHint for items generates correct title and plain English content with dynamic chest name', () => {
  const customHint = getSettingsHint('items', 'Treasure Crates', '📦');
  assert.equal(customHint.title, 'HINT: Items');
  assert.ok(customHint.description.includes('**[📦 Treasure Crates]**'), 'Should dynamically contain custom chest name and emoji');
  assert.ok(customHint.description.includes('⚠️ **Create First:**'), 'Should contain setup order advisory');
  assert.ok(customHint.description.includes('🏷️ **Item Roles:**'), 'Should contain item roles explanation');
  assert.ok(customHint.description.includes('⚙️ **Configuration:**'), 'Should contain configuration explanation');
  assert.ok(customHint.description.includes('📁 **Categories:**'), 'Should contain categories explanation');
  assert.ok(customHint.description.includes('Single (Swap)'), 'Should explain swap mode');
  assert.ok(customHint.description.includes('Multi (Stack)'), 'Should explain stack mode');
  assert.ok(customHint.description.includes('📦 **Packs:**'), 'Should contain packs explanation');
  assert.ok(customHint.description.includes("✅ **What's Next?:**"), 'Should contain next steps explanation');
  assert.ok(customHint.description.includes('**[📢 Post]**'), 'Should reference Post button');
  assert.ok(customHint.description.includes('**[⭐ Levels]**'), 'Should reference Levels button');
  assert.ok(customHint.description.includes('🗑️ **Editing & Deleting:**'), 'Should contain deletion explanation');

  const defaultHint = getSettingsHint('items');
  assert.ok(defaultHint.description.includes('**[🎁 Chests]**'), 'Should default to Chests');
});

test('getSettingsHint for other pages', () => {
  const coinsHint = getSettingsHint('coins');
  assert.equal(coinsHint.title, 'HINT: Coins');
  assert.ok(coinsHint.description.includes('📅 **Daily:**'));
  assert.ok(coinsHint.description.includes('🏷️ **Tag:** Gives daily coins'));
  assert.ok(coinsHint.description.includes('🗳️ **Vote:** Gives daily coins'));

  const chestsHint = getSettingsHint('chests', 'Mystery Boxes', '🎁');
  assert.equal(chestsHint.title, 'HINT: Mystery Boxes');
  assert.ok(chestsHint.description.includes('⚠️ **Create Items First:**'));
  assert.ok(chestsHint.description.includes('**[🏷️ Items]**'));
  assert.ok(chestsHint.description.includes('**[📢 Post]**'));
  assert.ok(chestsHint.description.includes('**[⭐ Levels]**'));

  const postHint = getSettingsHint('post', 'Chests', '🎁');
  assert.equal(postHint.title, 'HINT: Post');
  assert.ok(postHint.description.includes('➕ **New Post:**'));
  assert.ok(postHint.description.includes('📝 **Edit Post:**'));
  assert.ok(postHint.description.includes('**[🏷️ Items]**'));

  const ecoHint = getSettingsHint('economy', 'Chests', '🎁');
  assert.equal(ecoHint.title, 'HINT: Economy');
  assert.ok(ecoHint.description.includes('💰 **Total Wealth:**'));
  assert.ok(ecoHint.description.includes('🖨️ **Printed (New Coins):**'));
  assert.ok(ecoHint.description.includes('🔥 **Burned (Spent Coins):**'));
});

test('validateRoleDeletable enforces strict security and integrity invariants', async () => {
  const guildId = '111111111111111111';
  const otherGuildId = '222222222222222222';
  const roleId = '333333333333333333';
  const itemId = 42;

  // Mock bot member in guild with ManageRoles and position 50
  const mockBotMember = {
    permissions: {
      has: (perm) => perm === PermissionFlagsBits.ManageRoles
    },
    roles: {
      highest: { position: 50 }
    }
  };

  // Base healthy mock guild
  const createMockGuild = (overrides = {}) => ({
    id: guildId,
    roles: {
      cache: new Map(),
      fetch: async (id) => null,
      premiumSubscriberRole: null
    },
    members: {
      me: mockBotMember,
      fetchMe: async () => mockBotMember
    },
    ...overrides
  });

  // Default empty DB mock
  setMockPool({
    query: async (sql, params) => {
      return { rows: [], rowCount: 0 };
    }
  });
  configCache.set(guildId, {});

  // 1. Rejects missing guild or role
  const res1 = await validateRoleDeletable(null, roleId, itemId);
  assert.equal(res1.canDelete, false);
  assert.equal(res1.reason, 'Guild context missing.');

  const res2 = await validateRoleDeletable(createMockGuild(), null, itemId);
  assert.equal(res2.canDelete, false);
  assert.equal(res2.reason, 'No role attached to this item.');

  // 2. Rejects invalid snowflake
  const res3 = await validateRoleDeletable(createMockGuild(), 'not_a_snowflake', itemId);
  assert.equal(res3.canDelete, false);
  assert.equal(res3.reason, 'Invalid Discord role snowflake.');

  // 3. Rejects cross-guild role
  const mockCrossGuildRole = {
    id: roleId,
    name: 'Cross Server Role',
    guild: { id: otherGuildId },
    permissions: { has: () => false },
    position: 10
  };
  const guildWithCrossRole = createMockGuild({
    roles: {
      cache: new Map([[roleId, mockCrossGuildRole]]),
      fetch: async () => mockCrossGuildRole
    }
  });
  const resCross = await validateRoleDeletable(guildWithCrossRole, roleId, itemId);
  assert.equal(resCross.canDelete, false);
  assert.ok(resCross.reason.includes('different server'));

  // 4. Rejects @everyone
  const mockEveryoneRole = {
    id: guildId,
    name: '@everyone',
    guild: { id: guildId },
    permissions: { has: () => false },
    position: 0
  };
  const guildWithEveryone = createMockGuild({
    roles: {
      cache: new Map([[guildId, mockEveryoneRole]]),
      fetch: async () => mockEveryoneRole
    }
  });
  const resEveryone = await validateRoleDeletable(guildWithEveryone, guildId, itemId);
  assert.equal(resEveryone.canDelete, false);
  assert.equal(resEveryone.reason, 'Cannot delete @everyone role.');

  // 5. Rejects managed / integration role
  const mockManagedRole = {
    id: roleId,
    name: 'Bot Integration Role',
    guild: { id: guildId },
    managed: true,
    permissions: { has: () => false },
    position: 10
  };
  const guildWithManaged = createMockGuild({
    roles: {
      cache: new Map([[roleId, mockManagedRole]]),
      fetch: async () => mockManagedRole
    }
  });
  const resManaged = await validateRoleDeletable(guildWithManaged, roleId, itemId);
  assert.equal(resManaged.canDelete, false);
  assert.equal(resManaged.reason, 'Cannot delete managed or bot integration role.');

  // 6. Rejects role with Administrator / moderation permissions
  const mockAdminRole = {
    id: roleId,
    name: 'Server Admin',
    guild: { id: guildId },
    managed: false,
    permissions: {
      has: (perm) => perm === PermissionFlagsBits.Administrator
    },
    position: 20
  };
  const guildWithAdmin = createMockGuild({
    roles: {
      cache: new Map([[roleId, mockAdminRole]]),
      fetch: async () => mockAdminRole
    }
  });
  const resAdmin = await validateRoleDeletable(guildWithAdmin, roleId, itemId);
  assert.equal(resAdmin.canDelete, false);
  assert.equal(resAdmin.reason, 'Role holds administrative or moderation permissions.');

  // 7. Rejects configured bot administrator role (server_admin_roles)
  const mockNormalRole = {
    id: roleId,
    name: 'Normal Item Role',
    guild: { id: guildId },
    managed: false,
    permissions: { has: () => false },
    position: 20
  };
  const standardGuild = createMockGuild({
    roles: {
      cache: new Map([[roleId, mockNormalRole]]),
      fetch: async () => mockNormalRole
    }
  });

  setMockPool({
    query: async (sql, params) => {
      if (sql.includes('FROM server_admin_roles')) {
        return { rows: [{ 1: 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
  });
  const resServerAdmin = await validateRoleDeletable(standardGuild, roleId, itemId);
  assert.equal(resServerAdmin.canDelete, false);
  assert.equal(resServerAdmin.reason, 'Role is configured as a Bot Administrator role.');

  // 8. Rejects booster roles
  setMockPool({
    query: async (sql, params) => {
      if (sql.includes('FROM booster_roles')) {
        return { rows: [{ 1: 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
  });
  const resBooster = await validateRoleDeletable(standardGuild, roleId, itemId);
  assert.equal(resBooster.canDelete, false);
  assert.equal(resBooster.reason, 'Role is configured as a Server Booster role.');

  // 9. Rejects system reward roles (MVP, Richest, Streak)
  setMockPool({
    query: async () => ({ rows: [], rowCount: 0 })
  });
  configCache.set(guildId, { mvpRoleId: roleId });
  const resMvp = await validateRoleDeletable(standardGuild, roleId, itemId);
  assert.equal(resMvp.canDelete, false);
  assert.equal(resMvp.reason, 'Role is configured as the MVP reward role.');

  configCache.set(guildId, { richest_role_id: roleId });
  const resRichest = await validateRoleDeletable(standardGuild, roleId, itemId);
  assert.equal(resRichest.canDelete, false);
  assert.equal(resRichest.reason, 'Role is configured as the Top Richest reward role.');

  configCache.set(guildId, { streak_role_id: roleId });
  const resStreak = await validateRoleDeletable(standardGuild, roleId, itemId);
  assert.equal(resStreak.canDelete, false);
  assert.equal(resStreak.reason, 'Role is configured as the Daily Streak reward role.');
  configCache.set(guildId, {});

  // 10. Rejects leveling / battlepass reward role
  setMockPool({
    query: async (sql) => {
      if (sql.includes('FROM battlepass_config')) {
        return { rows: [{ level: 5 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
  });
  const resBp = await validateRoleDeletable(standardGuild, roleId, itemId);
  assert.equal(resBp.canDelete, false);
  assert.equal(resBp.reason, 'Role is configured as a Level 5 reward role.');

  // 11. Rejects role shared with another shop item
  setMockPool({
    query: async (sql) => {
      if (sql.includes('FROM shop_items')) {
        return { rows: [{ id: 99, name: 'VIP Bundle' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
  });
  const resShared = await validateRoleDeletable(standardGuild, roleId, itemId);
  assert.equal(resShared.canDelete, false);
  assert.equal(resShared.reason, 'Role is also linked to another item ("VIP Bundle").');

  // 12. Rejects role if bot is lower in hierarchy
  setMockPool({
    query: async () => ({ rows: [], rowCount: 0 })
  });
  const higherRole = {
    ...mockNormalRole,
    position: 60 // higher than bot position (50)
  };
  const guildWithHigherRole = createMockGuild({
    roles: {
      cache: new Map([[roleId, higherRole]]),
      fetch: async () => higherRole
    }
  });
  const resHierarchy = await validateRoleDeletable(guildWithHigherRole, roleId, itemId);
  assert.equal(resHierarchy.canDelete, false);
  assert.equal(resHierarchy.reason, 'Bot role is lower than or equal to this role in server hierarchy.');

  // 13. Accepts clean role when all 12 checks pass
  const resValid = await validateRoleDeletable(standardGuild, roleId, itemId);
  assert.equal(resValid.canDelete, true);
  assert.equal(resValid.role.id, roleId);
});

test('safelyDeleteConnectedRole guards role deletion and only deletes when valid', async () => {
  const guildId = '111111111111111111';
  const roleId = '333333333333333333';
  const itemId = 42;

  let deleteCalled = false;
  let deleteReason = '';
  const mockRole = {
    id: roleId,
    name: 'Sword Role',
    guild: { id: guildId },
    managed: false,
    permissions: { has: () => false },
    position: 10,
    delete: async (reason) => {
      deleteCalled = true;
      deleteReason = reason;
      return true;
    }
  };

  const mockGuild = {
    id: guildId,
    roles: {
      cache: new Map([[roleId, mockRole]]),
      fetch: async () => mockRole
    },
    members: {
      me: {
        permissions: { has: (perm) => perm === PermissionFlagsBits.ManageRoles },
        roles: { highest: { position: 50 } }
      }
    }
  };

  // Blocked by conflict
  setMockPool({
    query: async (sql) => {
      if (sql.includes('FROM server_admin_roles')) return { rows: [{ 1: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }
  });
  const blockedRes = await safelyDeleteConnectedRole(mockGuild, roleId, itemId, 'Sword', 'User#1234', '999');
  assert.equal(blockedRes.success, false);
  assert.equal(deleteCalled, false, 'role.delete() must NEVER be called when validation fails');

  // Allowed when clean
  setMockPool({
    query: async () => ({ rows: [], rowCount: 0 })
  });
  configCache.set(guildId, {});
  const successRes = await safelyDeleteConnectedRole(mockGuild, roleId, itemId, 'Sword', 'User#1234', '999');
  assert.equal(successRes.success, true);
  assert.equal(deleteCalled, true, 'role.delete() must be called when all checks pass');
  assert.ok(deleteReason.includes('Sword'), 'Delete reason must include item name');
  assert.ok(deleteReason.includes('User#1234'), 'Delete reason must include user tag');
});

test('handleDeleteItemSelect formats concise confirmation embed with role mentioned inline', async () => {
  const guildId = '111111111111111111';
  const roleId = '333333333333333333';
  const itemId = 42;

  let replyPayload = null;
  const mockInteraction = {
    guildId,
    deferred: true,
    replied: false,
    values: [String(itemId)],
    guild: {
      id: guildId,
      roles: {
        cache: new Map([[roleId, {
          id: roleId,
          name: 'Warrior',
          guild: { id: guildId },
          managed: false,
          permissions: { has: () => false },
          position: 10
        }]]),
        fetch: async () => null
      },
      members: {
        me: {
          permissions: { has: (perm) => perm === PermissionFlagsBits.ManageRoles },
          roles: { highest: { position: 50 } }
        }
      }
    },
    editReply: async (payload) => {
      replyPayload = payload;
      return payload;
    }
  };

  setMockPool({
    query: async (sql, params) => {
      if (sql.includes('FROM shop_items')) {
        return {
          rows: [{
            id: itemId,
            guild_id: guildId,
            name: 'Warrior Blade',
            role_id: roleId
          }],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 0 };
    }
  });

  await handleDeleteItemSelect(mockInteraction);

  assert.ok(replyPayload, 'editReply must be called');
  const embed = replyPayload.embeds[0].data;
  assert.equal(embed.title, 'Delete Item: Warrior Blade');
  assert.ok(!embed.description.includes('Are you sure you want to delete'), 'Must omit redundant "Are you sure" preamble');
  assert.ok(!embed.description.includes('Connected Role:'), 'Must omit redundant "Connected Role:" footer');
  assert.ok(!embed.description.includes('Deleting this item will:'), 'Must omit "Deleting this item will:" header');
  assert.ok(embed.description.includes(`• Removes <@&${roleId}> from all members holding it`), 'Must inline role mention cleanly in list');
  assert.ok(embed.description.includes("• Removes this item from everyone's inventory"));
  assert.ok(embed.description.includes('• Removes all active shop posts for this item'));
});
