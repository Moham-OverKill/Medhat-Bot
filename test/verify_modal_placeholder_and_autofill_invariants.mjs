import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setMockPool } from '../src/storage/postgres.js';
import { configCache } from '../src/storage/config.js';
import { invalidateShopCache } from '../src/economy/shop.js';

// Submodules under test
import { handleMvpComponent } from '../src/commands/mvp.js';
import { handleRewardsModal } from '../src/commands/rewards.js';
import { handlePassComponent, handlePassModal } from '../src/commands/settings/pass.js';
import { handleOrganizeComponent } from '../src/commands/settings/organize.js';
import { handleSettingsComponent } from '../src/commands/settings.js';
import {
  handleLootBoxRenameCatStart,
  handleLootBoxRenameCatSubmit,
  handleEditCategoryRenameStart,
  handleEditCategoryModalSubmit
} from '../src/commands/shop-setup.js';

describe('Modal Placeholder and Auto-Fill Invariants Suite', () => {
  const guildId = '123456789012345678';
  const userId = '987654321098765432';

  const createMockInteraction = (customId, overrides = {}) => ({
    customId,
    guildId,
    user: { id: userId },
    member: { permissions: { has: () => true } },
    guild: {
      id: guildId,
      roles: { cache: new Map() },
      channels: { cache: new Map() },
      emojis: { cache: new Map(), fetch: async () => new Map() }
    },
    _adminVerified: true,
    deferred: false,
    replied: false,
    isModalSubmit: () => false,
    isButton: () => false,
    isAnySelectMenu: () => false,
    deferUpdate: async () => {},
    editReply: async () => {},
    reply: async () => {},
    update: async () => {},
    followUp: async () => {},
    ...overrides
  });

  let guildConfigDb = {};

  beforeEach(() => {
    configCache.clear();
    invalidateShopCache(guildId);
    invalidateShopCache();
    guildConfigDb = {};
    setMockPool({
      query: async (sql, params) => {
        if (sql.includes('UPDATE guild_configs') || sql.includes('INSERT INTO guild_configs')) {
          const parsed = JSON.parse(params[1]);
          guildConfigDb = { ...guildConfigDb, ...parsed };
          return { rows: [{ config: guildConfigDb }], rowCount: 1 };
        }
        if (sql.includes('FROM guild_configs')) {
          return { rows: [{ config: guildConfigDb }], rowCount: 1 };
        }
        if (sql.includes('FROM shop_categories')) {
          return { rows: [{ id: '123', name: 'Roles', category_type: 0 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
    });
  });

  describe('1. MVP Hourly Reward Modal', () => {
    it('should render empty when reward is at default (5) and show "5" placeholder', async () => {
      configCache.set(guildId, { mvpRewardAmount: 5 });
      let modalShown = null;
      const interaction = createMockInteraction('mvp_reward_config_btn', {
        showModal: async (m) => { modalShown = m; }
      });

      await handleMvpComponent(interaction);
      assert.ok(modalShown, 'Modal must be shown');
      const input = modalShown.components[0].components[0].data;
      assert.equal(input.placeholder, '5');
      assert.equal(input.value, undefined, 'Must not pre-fill when equal to default 5');
    });

    it('should auto-fill when reward differs from default', async () => {
      configCache.set(guildId, { mvpRewardAmount: 25 });
      let modalShown = null;
      const interaction = createMockInteraction('mvp_reward_config_btn', {
        showModal: async (m) => { modalShown = m; }
      });

      await handleMvpComponent(interaction);
      const input = modalShown.components[0].components[0].data;
      assert.equal(input.value, '25', 'Must auto-fill non-default 25');
    });

    it('should default to 5 on empty submission', async () => {
      configCache.set(guildId, { mvpRewardAmount: 25 });
      const interaction = createMockInteraction(`rewards_mvp_modal_${Date.now()}`, {
        isModalSubmit: () => true,
        fields: { getTextInputValue: () => '' }
      });

      await handleRewardsModal(interaction);
      const cfg = configCache.get(guildId);
      assert.equal(cfg.mvpRewardAmount, 5, 'Empty submission must revert mvpRewardAmount to 5');
    });
  });

  describe('2. Role XP Boost % Modal', () => {
    it('should render empty when boost is at default (35) and show "35" placeholder', async () => {
      setMockPool({
        query: async (sql) => {
          if (sql.includes('SELECT boost_percentage FROM role_xp_boosters')) {
            return { rows: [{ boost_percentage: 35 }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }
      });

      let modalShown = null;
      const roleId = '111222333444555666';
      const interaction = createMockInteraction('pass_boost_add_role_pg_0', {
        values: [roleId],
        guild: {
          id: guildId,
          roles: { cache: new Map([[roleId, { id: roleId, name: 'VIP' }]]) }
        },
        showModal: async (m) => { modalShown = m; }
      });

      await handlePassComponent(interaction);
      assert.ok(modalShown, 'Modal must be shown');
      const input = modalShown.components[0].components[0].data;
      assert.equal(input.placeholder, '35');
      assert.equal(input.value, undefined, 'Must not pre-fill when equal to default 35');
    });

    it('should auto-fill when boost differs from 35', async () => {
      setMockPool({
        query: async (sql) => {
          if (sql.includes('SELECT boost_percentage FROM role_xp_boosters')) {
            return { rows: [{ boost_percentage: 50 }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }
      });

      let modalShown = null;
      const roleId = '111222333444555666';
      const interaction = createMockInteraction('pass_boost_add_role_pg_0', {
        values: [roleId],
        guild: {
          id: guildId,
          roles: { cache: new Map([[roleId, { id: roleId, name: 'VIP' }]]) }
        },
        showModal: async (m) => { modalShown = m; }
      });

      await handlePassComponent(interaction);
      const input = modalShown.components[0].components[0].data;
      assert.equal(input.value, '50', 'Must auto-fill non-default 50');
    });

    it('should default to 35 on empty submission', async () => {
      let savedBoost = null;
      setMockPool({
        query: async (sql, params) => {
          if (sql.includes('INSERT INTO role_xp_boosters')) {
            savedBoost = params[2];
            return { rowCount: 1 };
          }
          if (sql.includes('FROM role_xp_boosters')) {
            return { rows: [] };
          }
          return { rows: [], rowCount: 0 };
        }
      });

      const interaction = createMockInteraction(`pass_boost_pct_modal_111222333444555666_pg_0_${Date.now()}`, {
        isModalSubmit: () => true,
        fields: { getTextInputValue: () => '' }
      });

      await handlePassModal(interaction);
      assert.equal(savedBoost, 35, 'Empty submission must default boost to 35');
    });
  });

  describe('3. Auto React Emojis Configuration Modal', () => {
    it('should render empty when emojis match default reactions', async () => {
      configCache.set(guildId, {
        channel_filters: { auto_react_emojis: ['👍', '❤️', '😂', '😭'] }
      });

      let modalShown = null;
      const interaction = createMockInteraction('organize_set_reactions', {
        showModal: async (m) => { modalShown = m; }
      });

      await handleOrganizeComponent(interaction);
      assert.ok(modalShown, 'Modal must be shown');
      const input = modalShown.components[0].components[0].data;
      assert.equal(input.value, undefined, 'Must not pre-fill when reactions are default');
    });

    it('should auto-fill when custom emojis are configured', async () => {
      configCache.set(guildId, {
        channel_filters: { auto_react_emojis: ['🔥', '✨'] }
      });

      let modalShown = null;
      const interaction = createMockInteraction('organize_set_reactions', {
        showModal: async (m) => { modalShown = m; }
      });

      await handleOrganizeComponent(interaction);
      const input = modalShown.components[0].components[0].data;
      assert.equal(input.value, '🔥 ✨', 'Must auto-fill custom reactions');
    });

    it('should revert to DEFAULT_REACTIONS on empty submission', async () => {
      configCache.set(guildId, {
        channel_filters: { auto_react_emojis: ['🔥', '✨'] }
      });

      const interaction = createMockInteraction(`organize_auto_react_modal_${Date.now()}`, {
        isModalSubmit: () => true,
        fields: { getTextInputValue: () => '' }
      });

      await handleOrganizeComponent(interaction);
      const cfg = configCache.get(guildId);
      assert.deepEqual(cfg.channel_filters.auto_react_emojis, ['👍', '❤️', '😂', '😭']);
    });
  });

  describe('4. Custom Chest Category Appearance Modal', () => {
    it('should render empty when category name and emoji are default (Chests / 🎁)', async () => {
      configCache.set(guildId, {});

      let modalShown = null;
      const interaction = createMockInteraction('shop_lb_rename_cat', {
        showModal: async (m) => { modalShown = m; }
      });

      await handleLootBoxRenameCatStart(interaction);
      assert.ok(modalShown, 'Modal must be shown');
      const catInput = modalShown.components[0].components[0].data;
      const emojiInput = modalShown.components[1].components[0].data;
      assert.equal(catInput.value, undefined, 'Category name must be empty when default');
      assert.equal(emojiInput.value, undefined, 'Category emoji must be empty when default');
    });

    it('should auto-fill when category name or emoji are customized', async () => {
      configCache.set(guildId, {
        loot_box_category_name: 'Gifts',
        loot_box_category_emoji: '💎'
      });

      let modalShown = null;
      const interaction = createMockInteraction('shop_lb_rename_cat', {
        showModal: async (m) => { modalShown = m; }
      });

      await handleLootBoxRenameCatStart(interaction);
      const catInput = modalShown.components[0].components[0].data;
      const emojiInput = modalShown.components[1].components[0].data;
      assert.equal(catInput.value, 'Gifts');
      assert.equal(emojiInput.value, '💎');
    });

    it('should default to "Chests" and "🎁" on empty submission', async () => {
      const interaction = createMockInteraction(`shop_lb_rename_cat_modal_${Date.now()}`, {
        isModalSubmit: () => true,
        fields: { getTextInputValue: () => '' }
      });

      await handleLootBoxRenameCatSubmit(interaction);
      const cfg = configCache.get(guildId);
      assert.equal(cfg.loot_box_category_name, 'Chests');
      assert.equal(cfg.loot_box_category_emoji, '🎁');
    });
  });

  describe('5. Vote Reward and Tag Reward Modals', () => {
    it('Vote Reward: should render empty when at default 100 with "100" placeholder', async () => {
      configCache.set(guildId, { vote_reward_amount: 100 });
      let modalShown = null;
      const interaction = createMockInteraction('settings_vote_reward', {
        showModal: async (m) => { modalShown = m; }
      });

      await handleSettingsComponent(interaction);
      assert.ok(modalShown, 'Modal must be shown');
      const input = modalShown.components[0].components[0].data;
      assert.equal(input.placeholder, '100');
      assert.equal(input.value, undefined, 'Must not pre-fill when equal to 100');
    });

    it('Vote Reward: should auto-fill when non-default and revert to 100 on empty submit', async () => {
      configCache.set(guildId, { vote_reward_amount: 250 });
      let modalShown = null;
      const openInteraction = createMockInteraction('settings_vote_reward', {
        showModal: async (m) => { modalShown = m; }
      });
      await handleSettingsComponent(openInteraction);
      assert.equal(modalShown.components[0].components[0].data.value, '250');

      // Submit empty
      const submitInteraction = createMockInteraction(`settings_vote_modal_${Date.now()}`, {
        isModalSubmit: () => true,
        fields: { getTextInputValue: () => '' }
      });
      await handleSettingsComponent(submitInteraction);
      const cfg = configCache.get(guildId);
      assert.equal(cfg.vote_reward_amount, 100, 'Empty submit must revert to 100');
    });

    it('Tag Reward: should render empty when at default 0 with "None" placeholder', async () => {
      configCache.set(guildId, { tag_reward_amount: 0 });
      let modalShown = null;
      const interaction = createMockInteraction('settings_tag_reward', {
        showModal: async (m) => { modalShown = m; }
      });

      await handleSettingsComponent(interaction);
      assert.ok(modalShown, 'Modal must be shown');
      const input = modalShown.components[0].components[0].data;
      assert.equal(input.placeholder, 'None');
      assert.equal(input.value, undefined, 'Must not pre-fill when 0');
    });

    it('Tag Reward: should auto-fill when positive and default to 0 on empty submit', async () => {
      configCache.set(guildId, { tag_reward_amount: 50 });
      let modalShown = null;
      const openInteraction = createMockInteraction('settings_tag_reward', {
        showModal: async (m) => { modalShown = m; }
      });
      await handleSettingsComponent(openInteraction);
      assert.equal(modalShown.components[0].components[0].data.value, '50');

      // Submit empty
      const submitInteraction = createMockInteraction(`settings_tag_modal_${Date.now()}`, {
        isModalSubmit: () => true,
        fields: { getTextInputValue: () => '' }
      });
      await handleSettingsComponent(submitInteraction);
      const cfg = configCache.get(guildId);
      assert.equal(cfg.tag_reward_amount, 0, 'Empty submit must default to 0');
    });
  });

  describe('6. Shop Category Type Modal', () => {
    it('should render empty when category_type is 0 (Multi)', async () => {
      let modalShown = null;
      const interaction = createMockInteraction('shop_cat_settings_123', {
        showModal: async (m) => { modalShown = m; }
      });

      await handleEditCategoryRenameStart(interaction);
      assert.ok(modalShown, 'Modal must be shown');
      const typeInput = modalShown.components[1].components[0].data;
      assert.equal(typeInput.placeholder, '0 = Multi, 1 = Single');
      assert.equal(typeInput.value, undefined, 'Must not pre-fill when category_type is 0');
      assert.equal(typeInput.required, false, 'Must not be required');
    });

    it('should auto-fill "1" when category_type is 1 (Single)', async () => {
      setMockPool({
        query: async (sql) => {
          if (sql.includes('FROM shop_categories')) {
            return { rows: [{ id: '123', name: 'Exclusive Roles', category_type: 1 }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }
      });

      let modalShown = null;
      const interaction = createMockInteraction('shop_cat_settings_123', {
        showModal: async (m) => { modalShown = m; }
      });

      await handleEditCategoryRenameStart(interaction);
      const typeInput = modalShown.components[1].components[0].data;
      assert.equal(typeInput.value, '1', 'Must auto-fill "1" for single swap categories');
    });

    it('should default category_type to 0 on empty submit', async () => {
      let updatedType = null;
      setMockPool({
        query: async (sql, params) => {
          if (sql.includes('UPDATE shop_categories')) {
            updatedType = params[1]; // category_type
            return { rows: [{ id: '123', name: 'Roles', category_type: 0, guild_id: guildId }], rowCount: 1 };
          }
          if (sql.includes('FROM shop_categories')) {
            return { rows: [{ id: '123', name: 'Roles', category_type: 1 }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }
      });

      const interaction = createMockInteraction(`shop_cat_modal_edit_123_${Date.now()}`, {
        isModalSubmit: () => true,
        fields: {
          getTextInputValue: (field) => field === 'cat_name' ? 'Updated Roles' : '' // empty type
        }
      });

      await handleEditCategoryModalSubmit(interaction);
      assert.equal(updatedType, 0, 'Empty submit must default category_type to 0');
    });
  });
});
