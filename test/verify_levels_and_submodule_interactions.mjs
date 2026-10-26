import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { handlePassComponent, handlePassModal } from '../src/commands/settings/pass.js';
import { handleSettingsComponent } from '../src/commands/settings.js';
import { setMockPool } from '../src/storage/postgres.js';
import { configCache } from '../src/storage/config.js';

describe('Levels Dashboard & Submodule Interaction Resilience Suite', () => {
  const guildId = '123456789012345678';
  const userId = '987654321098765432';

  beforeEach(() => {
    configCache.set(guildId, {
      battlepass_enabled: false,
      battlepass_base_xp: 100,
      battlepass_xp_increment: 50,
      battlepass_msg_xp: 1,
      battlepass_voice_xp: 1,
      battlepass_quest_xp: 150
    });

    setMockPool({
      query: async (sql, params) => {
        if (sql.includes('FROM battlepass_config WHERE guild_id = $1 AND level = $2')) {
          return { rows: [{ reward_coins: '500', reward_role_id: null }], rowCount: 1 };
        }
        if (sql.includes('FROM battlepass_config')) {
          return { rows: [{ level: 1, reward_coins: 500, reward_role_id: null }], rowCount: 1 };
        }
        if (sql.includes('FROM battlepass_rewards')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('FROM role_xp_boosters')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('FROM shop_items')) {
          return { rows: [{ id: 10, name: 'Sword', category_id: null }], rowCount: 1 };
        }
        if (sql.includes('FROM shop_categories')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('FROM loot_boxes')) {
          return { rows: [{ id: 20, name: 'Gold Chest' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
    });
  });

  describe('Levels Dashboard Modals (Must NEVER be deferred beforehand)', () => {
    it('1. pass_set_xp_threshold_pg_ must call showModal without prior deferral', async () => {
      let deferred = false;
      let modalShown = null;

      const interaction = {
        customId: 'pass_set_xp_threshold_pg_0',
        guildId,
        user: { id: userId },
        guild: { id: guildId, roles: { cache: new Map() } },
        _adminVerified: true,
        deferred: false,
        replied: false,
        deferUpdate: async () => { deferred = true; },
        showModal: async (m) => {
          assert.equal(deferred, false, 'Modal MUST NOT be deferred before showModal');
          modalShown = m;
        }
      };

      await handlePassComponent(interaction);
      assert.ok(modalShown, 'showModal must have been called');
      assert.ok(modalShown.data.custom_id.startsWith('pass_xp_threshold_modal_pg_0_'));
    });

    it('2. pass_main_select selecting pass_create_level_page_ must call showModal without prior deferral', async () => {
      let deferred = false;
      let modalShown = null;

      const interaction = {
        customId: 'pass_main_select',
        values: ['pass_create_level_page_0'],
        guildId,
        user: { id: userId },
        guild: { id: guildId, roles: { cache: new Map() } },
        _adminVerified: true,
        deferred: false,
        replied: false,
        deferUpdate: async () => { deferred = true; },
        showModal: async (m) => {
          assert.equal(deferred, false, 'Modal MUST NOT be deferred before showModal');
          modalShown = m;
        }
      };

      await handlePassComponent(interaction);
      assert.ok(modalShown, 'showModal must have been called');
      assert.ok(modalShown.data.custom_id.startsWith('pass_create_lvl_modal_pg_0_'));
    });

    it('3. pass_coins_select_lvl_ selecting custom must call showModal without prior deferral', async () => {
      let deferred = false;
      let modalShown = null;

      const interaction = {
        customId: 'pass_coins_select_lvl_1_pg_0',
        values: ['custom'],
        guildId,
        user: { id: userId },
        guild: { id: guildId, roles: { cache: new Map() } },
        _adminVerified: true,
        deferred: false,
        replied: false,
        deferUpdate: async () => { deferred = true; },
        showModal: async (m) => {
          assert.equal(deferred, false, 'Modal MUST NOT be deferred before showModal');
          modalShown = m;
        }
      };

      await handlePassComponent(interaction);
      assert.ok(modalShown, 'showModal must have been called');
      assert.ok(modalShown.data.custom_id.startsWith('pass_set_coins_modal_1_pg_0_'));
    });

    it('4. pass_rewards_select_lvl_ selecting an item must call showModal without prior deferral', async () => {
      let deferred = false;
      let modalShown = null;

      const interaction = {
        customId: 'pass_rewards_select_lvl_1_pg_0_fld_root_rpg_1',
        values: ['add_item_10'],
        guildId,
        user: { id: userId },
        guild: { id: guildId, roles: { cache: new Map() } },
        _adminVerified: true,
        deferred: false,
        replied: false,
        deferUpdate: async () => { deferred = true; },
        showModal: async (m) => {
          assert.equal(deferred, false, 'Modal MUST NOT be deferred before showModal');
          modalShown = m;
        }
      };

      await handlePassComponent(interaction);
      assert.ok(modalShown, 'showModal must have been called');
      assert.ok(modalShown.data.custom_id.startsWith('pass_reward_qty_1_item_10_pg_0_fld_root_rpg_1_'));
      const input = modalShown.components[0].components[0].data;
      assert.equal(input.placeholder, 'None', 'Placeholder must be strictly "None"');
      assert.equal(input.required, false, 'Input must not be required');
      assert.equal(input.value, undefined, 'Input must be empty when no existing reward is configured');
    });

    it('5. pass_rewards_select_lvl_ selecting a chest must call showModal without prior deferral', async () => {
      let deferred = false;
      let modalShown = null;

      const interaction = {
        customId: 'pass_rewards_select_lvl_1_pg_0_fld_root_rpg_1',
        values: ['add_chest_20'],
        guildId,
        user: { id: userId },
        guild: { id: guildId, roles: { cache: new Map() } },
        _adminVerified: true,
        deferred: false,
        replied: false,
        deferUpdate: async () => { deferred = true; },
        showModal: async (m) => {
          assert.equal(deferred, false, 'Modal MUST NOT be deferred before showModal');
          modalShown = m;
        }
      };

      await handlePassComponent(interaction);
      assert.ok(modalShown, 'showModal must have been called');
      assert.ok(modalShown.data.custom_id.startsWith('pass_reward_qty_1_chest_20_pg_0_fld_root_rpg_1_'));
      const input = modalShown.components[0].components[0].data;
      assert.equal(input.placeholder, 'None', 'Placeholder must be strictly "None"');
      assert.equal(input.required, false, 'Input must not be required');
      assert.equal(input.value, undefined, 'Input must be empty when no existing reward is configured');
    });

    it('6. pass_boost_add_role_pg_ selecting a role must call showModal without prior deferral', async () => {
      let deferred = false;
      let modalShown = null;
      const roleId = '555666777';

      const rolesCache = new Map();
      rolesCache.set(roleId, { id: roleId, name: 'VIP Booster' });

      const interaction = {
        customId: 'pass_boost_add_role_pg_0',
        values: [roleId],
        guildId,
        user: { id: userId },
        guild: { id: guildId, roles: { cache: rolesCache } },
        _adminVerified: true,
        deferred: false,
        replied: false,
        deferUpdate: async () => { deferred = true; },
        showModal: async (m) => {
          assert.equal(deferred, false, 'Modal MUST NOT be deferred before showModal');
          modalShown = m;
        }
      };

      await handlePassComponent(interaction);
      assert.ok(modalShown, 'showModal must have been called');
      assert.ok(modalShown.data.custom_id.startsWith('pass_boost_pct_modal_' + roleId + '_pg_0_'));
    });

    it('7. pass_import_role_select_ selecting a role must call showModal without prior deferral', async () => {
      let deferred = false;
      let modalShown = null;
      const roleId = '444333222';

      const rolesCache = new Map();
      rolesCache.set(roleId, { id: roleId, name: 'Old Level 5' });

      // First initialize import session via pass_import_proceed_pg_0
      let editReplyPayload = null;
      const initInteraction = {
        customId: 'pass_import_proceed_pg_0',
        guildId,
        user: { id: userId },
        guild: { id: guildId, roles: { cache: rolesCache } },
        _adminVerified: true,
        deferred: false,
        replied: false,
        deferUpdate: async () => {},
        editReply: async (p) => { editReplyPayload = p; }
      };
      await handlePassComponent(initInteraction);
      assert.ok(editReplyPayload, 'Import session should be initialized');

      // Now select role to map
      const selectInteraction = {
        customId: 'pass_import_role_select_0',
        values: [roleId],
        guildId,
        user: { id: userId },
        guild: { id: guildId, roles: { cache: rolesCache } },
        _adminVerified: true,
        deferred: false,
        replied: false,
        deferUpdate: async () => { deferred = true; },
        showModal: async (m) => {
          assert.equal(deferred, false, 'Modal MUST NOT be deferred before showModal');
          modalShown = m;
        }
      };

      await handlePassComponent(selectInteraction);
      assert.ok(modalShown, 'showModal must have been called');
      assert.ok(modalShown.data.custom_id.startsWith('pass_import_level_modal_0_'));
    });
  });

  describe('Levels Dashboard Non-Modal Buttons (Must defer properly and update view)', () => {
    it('1. pass_toggle_start_pg_0 shows confirmation dialog', async () => {
      let deferred = false;
      let edited = null;

      const interaction = {
        customId: 'pass_toggle_start_pg_0',
        guildId,
        user: { id: userId },
        guild: { id: guildId, roles: { cache: new Map() } },
        _adminVerified: true,
        deferred: false,
        replied: false,
        deferUpdate: async () => { deferred = true; },
        editReply: async (p) => { edited = p; }
      };

      await handlePassComponent(interaction);
      assert.equal(deferred, true, 'Start button must defer');
      assert.ok(edited, 'Confirmation view must be rendered');
      assert.equal(edited.embeds[0].data.title, 'Start Level Progression?');
    });

    it('2. pass_boosts_pg_0 renders Boosts panel', async () => {
      let deferred = false;
      let edited = null;

      const interaction = {
        customId: 'pass_boosts_pg_0',
        guildId,
        user: { id: userId },
        guild: { id: guildId, roles: { cache: new Map() } },
        _adminVerified: true,
        deferred: false,
        replied: false,
        deferUpdate: async () => { deferred = true; },
        editReply: async (p) => { edited = p; }
      };

      await handlePassComponent(interaction);
      assert.equal(deferred, true, 'Boosts button must defer');
      assert.ok(edited, 'Boosts view must be rendered');
      assert.equal(edited.embeds[0].data.title, 'Boosts');
    });

    it('3. pass_home_page_0 renders root Levels dashboard', async () => {
      let deferred = false;
      let edited = null;

      const interaction = {
        customId: 'pass_home_page_0',
        guildId,
        user: { id: userId },
        guild: { id: guildId, roles: { cache: new Map() } },
        _adminVerified: true,
        deferred: false,
        replied: false,
        deferUpdate: async () => { deferred = true; },
        editReply: async (p) => { edited = p; }
      };

      await handlePassComponent(interaction);
      assert.equal(deferred, true, 'Home button must defer');
      assert.ok(edited, 'Root dashboard must be rendered');
      assert.equal(edited.embeds[0].data.title, 'Levels');
    });
  });

  describe('Settings Dispatcher Submodule Isolation', () => {
    it('should NOT run blanket deferUpdate when dispatching pass_ components through handleSettingsComponent', async () => {
      let settingsDeferred = false;
      let modalCalled = false;

      const interaction = {
        customId: 'pass_set_xp_threshold_pg_0',
        guildId,
        user: { id: userId },
        guild: { id: guildId, roles: { cache: new Map() } },
        _adminVerified: true,
        deferred: false,
        replied: false,
        isModalSubmit: () => false,
        deferUpdate: async () => {
          settingsDeferred = true;
        },
        showModal: async () => {
          assert.equal(settingsDeferred, false, 'handleSettingsComponent MUST NOT defer before delegating to pass.js');
          modalCalled = true;
        }
      };

      await handleSettingsComponent(interaction);
      assert.ok(modalCalled, 'Modal must have been successfully triggered through settings dispatcher');
    });

    it('should NOT run blanket deferUpdate when dispatching admin_user_ balance button through handleSettingsComponent', async () => {
      let settingsDeferred = false;
      let modalCalled = false;

      const interaction = {
        customId: 'admin_user_balance_' + userId,
        guildId,
        user: { id: userId },
        guild: {
          id: guildId,
          roles: { cache: new Map() },
          members: {
            fetch: async () => ({ user: { username: 'TargetUser' } })
          }
        },
        _adminVerified: true,
        deferred: false,
        replied: false,
        isModalSubmit: () => false,
        deferUpdate: async () => {
          settingsDeferred = true;
        },
        showModal: async () => {
          assert.equal(settingsDeferred, false, 'handleSettingsComponent MUST NOT defer before delegating to admin-users.js');
          modalCalled = true;
        }
      };

      await handleSettingsComponent(interaction);
      assert.ok(modalCalled, 'Balance modal must have opened without blanket deferral');
    });

    it('should NOT run blanket deferUpdate when dispatching organize_set_reactions through handleSettingsComponent', async () => {
      let settingsDeferred = false;
      let modalCalled = false;

      const interaction = {
        customId: 'organize_set_reactions',
        guildId,
        user: { id: userId },
        guild: { id: guildId, roles: { cache: new Map() } },
        _adminVerified: true,
        deferred: false,
        replied: false,
        isModalSubmit: () => false,
        deferUpdate: async () => {
          settingsDeferred = true;
        },
        showModal: async () => {
          assert.equal(settingsDeferred, false, 'handleSettingsComponent MUST NOT defer before delegating to organize.js');
          modalCalled = true;
        }
      };

      await handleSettingsComponent(interaction);
      assert.ok(modalCalled, 'Auto-react modal must have opened without blanket deferral');
    });
  });

  describe('Pass Reward Quantity Modal Submissions & Auto-fill Invariants', () => {
    it('should pre-fill existing quantity when item is already configured and keep placeholder as None', async () => {
      setMockPool({
        query: async (sql, params) => {
          if (sql.includes('FROM battlepass_rewards WHERE guild_id = $1 AND level = $2 AND reward_type = $3 AND shop_item_id = $4')) {
            return { rows: [{ quantity: 5 }], rowCount: 1 };
          }
          if (sql.includes('FROM shop_items')) {
            return { rows: [{ id: 10, name: 'Excalibur' }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }
      });

      let modalShown = null;
      const interaction = {
        customId: 'pass_rewards_select_lvl_1_pg_0_fld_root_rpg_1',
        values: ['add_item_10'],
        guildId,
        user: { id: userId },
        guild: { id: guildId, roles: { cache: new Map() } },
        _adminVerified: true,
        deferred: false,
        replied: false,
        deferUpdate: async () => {},
        showModal: async (m) => { modalShown = m; }
      };

      await handlePassComponent(interaction);
      assert.ok(modalShown, 'Modal must be shown');
      const input = modalShown.components[0].components[0].data;
      assert.equal(input.placeholder, 'None', 'Placeholder must be None');
      assert.equal(input.value, '5', 'Existing quantity 5 must be auto-filled');
      assert.equal(input.required, false, 'Field must not be required');
    });

    it('should delete reward when submitted quantity is empty string', async () => {
      let deleted = false;
      let replyEdited = false;

      setMockPool({
        query: async (sql, params) => {
          if (sql.includes('DELETE FROM battlepass_rewards')) {
            deleted = true;
            return { rowCount: 1 };
          }
          if (sql.includes('FROM shop_items')) {
            return { rows: [{ name: 'Sword' }] };
          }
          if (sql.includes('FROM battlepass_config')) {
            return { rows: [{ level: 1, reward_coins: 0, reward_role_id: null }] };
          }
          if (sql.includes('FROM battlepass_rewards')) {
            return { rows: [] };
          }
          return { rows: [], rowCount: 0 };
        }
      });

      const interaction = {
        customId: `pass_reward_qty_1_item_10_pg_0_fld_root_rpg_1_${Date.now()}`,
        guildId,
        user: { id: userId },
        guild: { id: guildId, roles: { cache: new Map() } },
        fields: {
          getTextInputValue: () => '' // empty
        },
        deferred: false,
        replied: false,
        deferUpdate: async () => {},
        editReply: async () => { replyEdited = true; }
      };

      await handlePassModal(interaction);
      assert.equal(deleted, true, 'Submitting empty string must delete the reward');
      assert.equal(replyEdited, true, 'Dashboard must be updated after removal');
    });

    it('should delete reward when submitted quantity is 0', async () => {
      let deleted = false;
      let replyEdited = false;

      setMockPool({
        query: async (sql, params) => {
          if (sql.includes('DELETE FROM battlepass_rewards')) {
            deleted = true;
            return { rowCount: 1 };
          }
          if (sql.includes('FROM loot_boxes')) {
            return { rows: [{ name: 'Chest' }] };
          }
          if (sql.includes('FROM battlepass_config')) {
            return { rows: [{ level: 1, reward_coins: 0, reward_role_id: null }] };
          }
          if (sql.includes('FROM battlepass_rewards')) {
            return { rows: [] };
          }
          return { rows: [], rowCount: 0 };
        }
      });

      const interaction = {
        customId: `pass_reward_qty_1_chest_20_pg_0_fld_chests_rpg_1_${Date.now()}`,
        guildId,
        user: { id: userId },
        guild: { id: guildId, roles: { cache: new Map() } },
        fields: {
          getTextInputValue: () => '0'
        },
        deferred: false,
        replied: false,
        deferUpdate: async () => {},
        editReply: async () => { replyEdited = true; }
      };

      await handlePassModal(interaction);
      assert.equal(deleted, true, 'Submitting 0 must delete the reward');
      assert.equal(replyEdited, true, 'Dashboard must be updated after removal');
    });

    it('should save positive quantity when valid number is submitted', async () => {
      let upserted = false;
      let savedQty = null;

      setMockPool({
        query: async (sql, params) => {
          if (sql.includes('INSERT INTO battlepass_rewards')) {
            upserted = true;
            savedQty = params[3]; // quantity parameter
            return { rowCount: 1 };
          }
          if (sql.includes('FROM shop_items')) {
            return { rows: [{ name: 'Sword' }] };
          }
          if (sql.includes('FROM battlepass_config')) {
            return { rows: [{ level: 1, reward_coins: 0, reward_role_id: null }] };
          }
          if (sql.includes('FROM battlepass_rewards')) {
            return { rows: [] };
          }
          return { rows: [], rowCount: 0 };
        }
      });

      const interaction = {
        customId: `pass_reward_qty_1_item_10_pg_0_fld_root_rpg_1_${Date.now()}`,
        guildId,
        user: { id: userId },
        guild: { id: guildId, roles: { cache: new Map() } },
        fields: {
          getTextInputValue: () => '7'
        },
        deferred: false,
        replied: false,
        deferUpdate: async () => {},
        editReply: async () => {}
      };

      await handlePassModal(interaction);
      assert.equal(upserted, true, 'Submitting positive number must upsert reward');
      assert.equal(savedQty, 7, 'Quantity must be saved as 7');
    });
  });
});
