import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  handleBalanceAction,
  handleBalanceModal,
  handleStreakAction,
  handleStreakModal,
  handleLevelAction,
  handleLevelModal,
  handleAdminGiveModal
} from '../src/commands/admin-users.js';
import { handleRewardsComponent, handleRewardsModal } from '../src/commands/rewards.js';
import { handleMvpComponent } from '../src/commands/mvp.js';
import { handleOrganizeComponent } from '../src/commands/settings/organize.js';
import { handleEditQuest, handleEditQuestModal } from '../src/commands/quests-dashboard.js';
import { setMockPool } from '../src/storage/postgres.js';
import { configCache } from '../src/storage/config.js';

describe('Modal Auto-fill & Placeholder Refinements Suite', () => {
  const guildId = '999888777666555444';
  const targetUserId = '111222333444555666';

  beforeEach(() => {
    configCache.delete(guildId);
    setMockPool({
      query: async (sql, params) => {
        if (sql.includes('user_balances')) {
          return {
            rows: [{
              user_id: targetUserId,
              guild_id: guildId,
              balance: 1500,
              daily_streak: 7,
              last_daily: null
            }],
            rowCount: 1
          };
        }
        if (sql.includes('user_activity')) {
          return {
            rows: [{
              user_id: targetUserId,
              guild_id: guildId,
              battlepass_xp: 350
            }],
            rowCount: 1
          };
        }
        if (sql.includes('quests')) {
          return {
            rows: [{
              id: 42,
              guild_id: guildId,
              action_type: 'chat',
              channel_type: 'any',
              channel_id: '123',
              required_count: 15,
              reward_coins: 250,
              custom_title: 'Chat 15 times'
            }],
            rowCount: 1
          };
        }
        if (sql.includes('guild_configs')) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      }
    });
  });

  it('1. Admin User Balance modal: empty value, placeholder shows current balance, dynamic nonce', async () => {
    let capturedModal = null;
    const mockInteraction = {
      guildId,
      guild: {
        members: {
          fetch: async () => ({ displayName: 'TestUser', user: { username: 'TestUser' } })
        }
      },
      memberPermissions: { has: () => true },
      user: { id: 'admin_user' },
      showModal: async (m) => { capturedModal = m; }
    };

    await handleBalanceAction(mockInteraction, targetUserId);

    assert.ok(capturedModal, 'Modal should be shown');
    assert.match(capturedModal.data.custom_id, new RegExp(`^admin_user_balmod_${targetUserId}_\\d+$`));
    const input = capturedModal.components[0].components[0].data;
    assert.strictEqual(input.custom_id, 'new_balance');
    assert.strictEqual(input.value, undefined, 'Field must be rendered empty (no active value)');
    assert.strictEqual(input.required, false, 'Field must not be required');
    assert.strictEqual(input.placeholder, '1500', 'Placeholder must show user current balance');
  });

  it('2. Admin User Balance modal submit: empty value does nothing', async () => {
    let balanceChanged = false;
    let dashboardShown = false;
    const mockInteraction = {
      guildId,
      guild: {
        id: guildId,
        members: {
          fetch: async () => ({ displayName: 'TestUser', user: { username: 'TestUser' } })
        }
      },
      customId: `admin_user_balmod_${targetUserId}_${Date.now()}`,
      fields: {
        getTextInputValue: () => '   ' // empty/whitespace
      },
      editReply: async () => { dashboardShown = true; },
      deferUpdate: async () => {},
      isButton: () => false,
      isStringSelectMenu: () => false,
      isAnySelectMenu: () => false,
      user: { id: 'admin_user' }
    };

    setMockPool({
      query: async (sql) => {
        if (sql.includes('transactions') || (sql.includes('user_balances') && sql.includes('balance = $3'))) {
          balanceChanged = true;
        }
        return { rows: [{ balance: 1500, daily_streak: 7, battlepass_xp: 350 }], rowCount: 1 };
      }
    });

    await handleBalanceModal(mockInteraction);
    assert.strictEqual(balanceChanged, false, 'Empty balance input must not update balance');
    assert.strictEqual(dashboardShown, true, 'Should refresh dashboard without making changes');
  });

  it('3. Admin User Streak modal: empty value, placeholder shows current streak, dynamic nonce', async () => {
    let capturedModal = null;
    const mockInteraction = {
      guildId,
      memberPermissions: { has: () => true },
      user: { id: 'admin_user' },
      showModal: async (m) => { capturedModal = m; }
    };

    await handleStreakAction(mockInteraction, targetUserId);

    assert.ok(capturedModal, 'Modal should be shown');
    assert.match(capturedModal.data.custom_id, new RegExp(`^admin_user_stkmod_${targetUserId}_\\d+$`));
    const input = capturedModal.components[0].components[0].data;
    assert.strictEqual(input.custom_id, 'new_streak');
    assert.strictEqual(input.value, undefined, 'Streak field must be rendered empty');
    assert.strictEqual(input.required, false, 'Field must not be required');
    assert.strictEqual(input.placeholder, '7', 'Placeholder must show user current streak');
  });

  it('4. Admin User Streak modal submit: empty value does nothing', async () => {
    let streakChanged = false;
    let dashboardShown = false;
    const mockInteraction = {
      guildId,
      guild: {
        id: guildId,
        members: {
          fetch: async () => ({ displayName: 'TestUser', user: { username: 'TestUser' } })
        }
      },
      customId: `admin_user_stkmod_${targetUserId}_${Date.now()}`,
      fields: {
        getTextInputValue: () => '' // empty
      },
      editReply: async () => { dashboardShown = true; },
      deferUpdate: async () => {},
      isButton: () => false,
      isStringSelectMenu: () => false,
      isAnySelectMenu: () => false,
      user: { id: 'admin_user' }
    };

    setMockPool({
      query: async (sql) => {
        if (sql.includes('user_balances') && sql.includes('daily_streak = $3')) {
          streakChanged = true;
        }
        return { rows: [{ balance: 1500, daily_streak: 7, battlepass_xp: 350 }], rowCount: 1 };
      }
    });

    await handleStreakModal(mockInteraction);
    assert.strictEqual(streakChanged, false, 'Empty streak input must not update streak');
    assert.strictEqual(dashboardShown, true, 'Should refresh dashboard without making changes');
  });

  it('5. Admin User Level modal: empty value, placeholder shows current level, dynamic nonce', async () => {
    let capturedModal = null;
    const mockInteraction = {
      guildId,
      guild: {
        members: {
          fetch: async () => ({ displayName: 'TestUser', user: { username: 'TestUser' } })
        }
      },
      memberPermissions: { has: () => true },
      user: { id: 'admin_user' },
      showModal: async (m) => { capturedModal = m; }
    };

    await handleLevelAction(mockInteraction, targetUserId);

    assert.ok(capturedModal, 'Modal should be shown');
    assert.match(capturedModal.data.custom_id, new RegExp(`^admin_user_lvlmod_${targetUserId}_\\d+$`));
    const input = capturedModal.components[0].components[0].data;
    assert.strictEqual(input.custom_id, 'new_level');
    assert.strictEqual(input.value, undefined, 'Level field must be rendered empty');
    assert.strictEqual(input.required, false, 'Field must not be required');
    assert.ok(input.placeholder, 'Placeholder must be set to computed user level');
  });

  it('6. Admin User Level modal submit: empty value does nothing', async () => {
    let dbUpdated = false;
    let dashboardShown = false;
    const mockInteraction = {
      guildId,
      guild: {
        id: guildId,
        members: {
          fetch: async () => ({ displayName: 'TestUser', user: { username: 'TestUser' } })
        }
      },
      customId: `admin_user_lvlmod_${targetUserId}_${Date.now()}`,
      fields: {
        getTextInputValue: () => '' // empty
      },
      editReply: async () => { dashboardShown = true; },
      deferUpdate: async () => {},
      isButton: () => false,
      isStringSelectMenu: () => false,
      isAnySelectMenu: () => false,
      user: { id: 'admin_user' }
    };

    setMockPool({
      query: async (sql) => {
        if (sql.includes('UPDATE user_activity') || sql.includes('INSERT INTO user_activity')) {
          dbUpdated = true;
        }
        return { rows: [], rowCount: 0 };
      }
    });

    await handleLevelModal(mockInteraction);
    assert.strictEqual(dbUpdated, false, 'Empty level input must not update database');
    assert.strictEqual(dashboardShown, true, 'Should refresh dashboard without making changes');
  });

  it('7. Legacy Reward Modals: default value renders empty with placeholder, non-default pre-fills', async () => {
    let capturedModal = null;
    const mockInteraction = {
      guildId,
      customId: 'rewards_booster_btn',
      memberPermissions: { has: () => true },
      user: { id: 'admin_user' },
      showModal: async (m) => { capturedModal = m; }
    };

    // When config is at default (2x multiplier)
    await handleRewardsComponent(mockInteraction);
    assert.ok(capturedModal);
    assert.match(capturedModal.data.custom_id, /^rewards_booster_modal_\d+$/);
    let input = capturedModal.components[0].components[0].data;
    assert.strictEqual(input.placeholder, '2');
    assert.strictEqual(input.value, undefined, 'Default 2 must render empty to display placeholder');

    // Test streak modal with default (5)
    mockInteraction.customId = 'rewards_streak_btn';
    await handleRewardsComponent(mockInteraction);
    assert.match(capturedModal.data.custom_id, /^rewards_streak_modal_\d+$/);
    input = capturedModal.components[0].components[0].data;
    assert.strictEqual(input.placeholder, '5');
    assert.strictEqual(input.value, undefined, 'Default 5 must render empty to display placeholder');

    // Test daily base modal with default (25)
    mockInteraction.customId = 'rewards_daily_base_btn';
    await handleRewardsComponent(mockInteraction);
    assert.match(capturedModal.data.custom_id, /^rewards_daily_base_modal_\d+$/);
    input = capturedModal.components[0].components[0].data;
    assert.strictEqual(input.placeholder, '25');
    assert.strictEqual(input.value, undefined, 'Default 25 must render empty to display placeholder');

    // Test streak cap modal with default (20)
    mockInteraction.customId = 'rewards_streak_cap_btn';
    await handleRewardsComponent(mockInteraction);
    assert.match(capturedModal.data.custom_id, /^rewards_streak_cap_modal_\d+$/);
    input = capturedModal.components[0].components[0].data;
    assert.strictEqual(input.placeholder, '20');
    assert.strictEqual(input.value, undefined, 'Default 20 must render empty to display placeholder');
  });

  it('8. MVP Hourly Reward modal: auto-fills saved config amount, placeholder is 5, dynamic nonce', async () => {
    let capturedModal = null;
    const mockInteraction = {
      guildId,
      customId: 'mvp_reward_config_btn',
      member: { permissions: { has: () => true } },
      user: { id: 'admin_user' },
      showModal: async (m) => { capturedModal = m; }
    };

    await handleMvpComponent(mockInteraction);
    assert.ok(capturedModal);
    assert.match(capturedModal.data.custom_id, /^rewards_mvp_modal_\d+$/);
    const input = capturedModal.components[0].components[0].data;
    assert.strictEqual(input.placeholder, '5');
    assert.strictEqual(input.value, '100', 'Must auto-fill current saved config amount');
    assert.strictEqual(input.required, false);
  });

  it('9. Edit Quest modal: auto-fills values, sets placeholders, dynamic nonce and robust parsing', async () => {
    let capturedModal = null;
    const mockInteraction = {
      guildId,
      guild: {
        channels: { cache: new Map() }
      },
      showModal: async (m) => { capturedModal = m; }
    };

    await handleEditQuest(mockInteraction, 42);
    assert.ok(capturedModal);
    assert.match(capturedModal.data.custom_id, /^quests_edit_modal_42_\d+$/);

    const titleInput = capturedModal.components[0].components[0].data;
    const countInput = capturedModal.components[1].components[0].data;
    const rewardInput = capturedModal.components[2].components[0].data;

    assert.strictEqual(titleInput.value, 'Chat 15 times');
    assert.strictEqual(countInput.value, '15');
    assert.strictEqual(countInput.placeholder, 'e.g. 10');
    assert.strictEqual(rewardInput.value, '250');
    assert.strictEqual(rewardInput.placeholder, 'e.g. 100');
  });

  it('10. Organize Auto-react modal: dynamic nonce and empty input resets to defaults', async () => {
    let capturedModal = null;
    const mockInteraction = {
      guildId,
      customId: 'organize_set_reactions',
      showModal: async (m) => { capturedModal = m; }
    };

    await handleOrganizeComponent(mockInteraction);
    assert.ok(capturedModal);
    assert.match(capturedModal.data.custom_id, /^organize_auto_react_modal_\d+$/);

    const input = capturedModal.components[0].components[0].data;
    assert.strictEqual(input.required, false);
  });
});
