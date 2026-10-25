import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ButtonStyle, MessageFlags } from 'discord.js';
import { setMockPool } from '../src/storage/postgres.js';
import { configCache } from '../src/storage/config.js';

// Import handlers to test
import { handleBankDaily, handleBankCommand, handleBankHistory } from '../src/commands/bank.js';
import { executeDailyClaim } from '../src/commands/daily.js';
import { handleHubShortcut, handleAdminHubComponent } from '../src/commands/interface.js';
import { handleNotificationsComponent, buildNotificationsPayload } from '../src/commands/notifications.js';
import { NOTIFICATION_KEYS } from '../src/storage/notifications.js';
import { handleSettingsComponent } from '../src/commands/settings.js';
import { handleBalanceModal, handleStreakModal, handleLevelModal, handleAdminGiveModal, handleAdminRemoveModal, handleAdminSetQuantity } from '../src/commands/admin-users.js';
import { handleTradeModal, handleTradeSetupInteraction, ACTIVE_SETUPS } from '../src/commands/trade.js';
import { handleVoteCommand } from '../src/commands/vote.js';
import { handleInviteCommand } from '../src/commands/invite.js';
import { handleRewardsComponent, handleRewardsModal } from '../src/commands/rewards.js';
import { showSetupPanel } from '../src/commands/mvp.js';

describe('Global Component Feedback & Error Handling Audit Suite', () => {
  const guildId = '999888777666555444';
  const userId = '111222333444555666';
  const targetId = '222333444555666777';

  function createMockInteraction(customId, {
    values = [],
    fields = {},
    deferred = false,
    replied = false,
    isAdmin = true
  } = {}) {
    const inter = {
      id: '999111222333444555',
      customId,
      guildId,
      user: { id: userId, tag: 'Tester#0001', username: 'Tester' },
      member: {
        id: userId,
        displayName: 'Tester',
        user: { id: userId, tag: 'Tester#0001' },
        permissions: { has: () => isAdmin },
        roles: { cache: new Map() }
      },
      guild: {
        id: guildId,
        name: 'Test Server',
        roles: { cache: new Map() },
        channels: { cache: new Map() },
        members: {
          fetch: async (id) => ({
            id: id || targetId,
            displayName: 'TargetUser',
            user: { id: id || targetId, tag: 'Target#0001' },
            roles: { cache: new Map() }
          }),
          cache: new Map()
        }
      },
      values,
      fields: {
        getTextInputValue: (fieldId) => fields[fieldId] !== undefined ? fields[fieldId] : ''
      },
      deferred,
      replied,
      replyPayload: null,
      editReplyPayload: null,
      updatePayload: null,
      followUpPayload: null,

      deferReply: async function(opts = {}) {
        this.deferred = true;
        this.replyFlags = opts.flags;
      },
      deferUpdate: async function() {
        this.deferred = true;
      },
      reply: async function(payload) {
        this.replied = true;
        this.replyPayload = payload;
      },
      editReply: async function(payload) {
        this.editReplyPayload = payload;
      },
      update: async function(payload) {
        this.updatePayload = payload;
      },
      followUp: async function(payload) {
        this.followUpPayload = payload;
      },
      showModal: async function(modal) {
        this.shownModal = modal;
      }
    };
    return inter;
  }

  beforeEach(() => {
    configCache.set(guildId, {
      daily_enabled: true,
      quests_enabled: true,
      battlepass_enabled: true,
      currency_name: 'Coins',
      coin_emoji: '🪙'
    });

    const mockUserData = {
      user_id: userId,
      guild_id: guildId,
      balance: 500,
      daily_streak: 3,
      last_daily: null,
      last_lost_streak: 0
    };

    setMockPool({
      query: async (sql, params) => {
        if (sql.includes('guild_configs')) {
          return { rows: [{ config: configCache.get(guildId) }], rowCount: 1 };
        }
        if (sql.includes('user_balances')) {
          return { rows: [mockUserData], rowCount: 1 };
        }
        if (sql.includes('user_inventory')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('user_notification_settings')) {
          return {
            rows: [{
              guild_id: guildId,
              user_id: userId,
              notif_level_up: true,
              notif_daily_claim: false,
              notif_trades: true,
              notif_mvp_win: true,
              notif_quests_refresh: false,
              notif_weekly_summary: true
            }],
            rowCount: 1
          };
        }
        if (sql.includes('transactions')) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      },
      connect: async () => ({
        query: async (sql, params) => {
          if (sql.includes('user_balances')) {
            return { rows: [mockUserData], rowCount: 1 };
          }
          if (sql.includes('transactions')) {
            return { rows: [], rowCount: 0 };
          }
          return { rows: [mockUserData], rowCount: 1 };
        },
        release: () => {}
      })
    });
  });

  // --- 1. Admin Users Modals (Input Validation & Error Feedback) ---
  describe('Admin User Management Modals', () => {
    it('handleBalanceModal should reject invalid non-numeric balance inputs with ephemeral error', async () => {
      const inter = createMockInteraction(`admin_user_balmod_${targetId}`, {
        fields: { new_balance: 'invalid_coins' }
      });

      await handleBalanceModal(inter);
      assert.ok(inter.replied || inter.followUpPayload || inter.editReplyPayload, 'Must provide user feedback');
      const payload = inter.replyPayload || inter.followUpPayload || inter.editReplyPayload;
      assert.match(payload.content || '', /valid/i, 'Must inform user of invalid number');
    });

    it('handleBalanceModal should reject negative balance inputs gracefully', async () => {
      const inter = createMockInteraction(`admin_user_balmod_${targetId}`, {
        fields: { new_balance: '-500' }
      });

      await handleBalanceModal(inter);
      const payload = inter.replyPayload || inter.followUpPayload || inter.editReplyPayload;
      assert.match(payload.content || '', /negative|greater|valid/i);
    });

    it('handleStreakModal should reject invalid non-numeric streak inputs', async () => {
      const inter = createMockInteraction(`admin_user_stkmod_${targetId}`, {
        fields: { new_streak: 'abc' }
      });

      await handleStreakModal(inter);
      const payload = inter.replyPayload || inter.followUpPayload || inter.editReplyPayload;
      assert.match(payload.content || '', /valid/i);
    });

    it('handleStreakModal should reject negative streak inputs', async () => {
      const inter = createMockInteraction(`admin_user_stkmod_${targetId}`, {
        fields: { new_streak: '-5' }
      });

      await handleStreakModal(inter);
      const payload = inter.replyPayload || inter.followUpPayload || inter.editReplyPayload;
      assert.match(payload.content || '', /negative|greater|valid/i);
    });

    it('handleLevelModal should reject invalid non-numeric level inputs', async () => {
      const inter = createMockInteraction(`admin_user_lvlmod_${targetId}`, {
        fields: { new_level: 'xyz' }
      });

      await handleLevelModal(inter);
      const payload = inter.replyPayload || inter.followUpPayload || inter.editReplyPayload;
      assert.match(payload.content || '', /valid/i);
    });

    it('handleAdminGiveModal should reject zero or negative quantities', async () => {
      const inter = createMockInteraction(`admin_user_givemod_${targetId}_item_99`, {
        fields: { give_quantity: '0' }
      });

      await handleAdminGiveModal(inter);
      const payload = inter.replyPayload || inter.followUpPayload || inter.editReplyPayload;
      assert.match(payload.content || '', /greater than 0|valid/i);
    });

    it('handleAdminRemoveModal should reject non-numeric quantities', async () => {
      const inter = createMockInteraction(`admin_user_remmod_${targetId}_item_99`, {
        fields: { remove_quantity: 'bad_val' }
      });

      await handleAdminRemoveModal(inter);
      const payload = inter.replyPayload || inter.followUpPayload || inter.editReplyPayload;
      assert.match(payload.content || '', /valid/i);
    });
  });

  // --- 2. Trade Modals & Inputs ---
  describe('Trade System Modals & Error Feedback', () => {
    it('handleTradeModal should return session expired error if trade setup missing', async () => {
      const inter = createMockInteraction('trade_modal_give_coins', {
        fields: { amount: '100' }
      });

      await handleTradeModal(inter);
      const payload = inter.replyPayload || inter.followUpPayload || inter.editReplyPayload;
      assert.match(payload.content || '', /Session expired/i);
    });

    it('handleTradeModal should reject invalid item quantity input with active setup', async () => {
      const setupId = `${guildId}_${userId}`;
      ACTIVE_SETUPS.set(setupId, {
        guildId,
        senderId: userId,
        targetId,
        senderCoins: 0,
        targetCoins: 0,
        senderItems: [],
        targetItems: []
      });

      const inter = createMockInteraction('trade_modal_item_qty_give_999', {
        fields: { trade_qty: 'invalid_qty' }
      });

      await handleTradeModal(inter);
      const payload = inter.replyPayload || inter.followUpPayload || inter.editReplyPayload;
      assert.match(payload.content || '', /valid quantity of 1 or more/i);

      ACTIVE_SETUPS.delete(setupId);
    });
  });

  // --- 3. Notification Toggles ---
  describe('Notifications Component Toggles', () => {
    it('handleNotificationsComponent should toggle boolean setting and update UI', async () => {
      const inter = createMockInteraction(`notif_toggle_${NOTIFICATION_KEYS.LEVEL_UP}`);
      await handleNotificationsComponent(inter);
      assert.ok(inter.updatePayload !== null, 'Must update notifications message');
      assert.equal(inter.updatePayload.components.length, 2, 'Must have 2 rows of buttons');
    });
  });

  // --- 4. Vote and Invite Commands ---
  describe('Vote & Invite Feedback', () => {
    it('handleVoteCommand should reply with vote link and coins embed', async () => {
      const inter = createMockInteraction('vote_cmd');
      inter.client = { user: { id: '999111' } };

      await handleVoteCommand(inter);
      const payload = inter.replyPayload || inter.editReplyPayload;
      assert.ok(payload !== null);
      assert.equal(payload.embeds.length, 1);
      assert.equal(payload.components.length, 1);
    });

    it('handleInviteCommand should reply with top.gg and invite links', async () => {
      const inter = createMockInteraction('invite_cmd');
      inter.client = { user: { id: '999111' } };

      await handleInviteCommand(inter);
      const payload = inter.replyPayload || inter.editReplyPayload;
      assert.ok(payload !== null);
      assert.equal(payload.embeds.length, 1);
      assert.equal(payload.components.length, 1);
    });
  });

  // --- 5. Interface Shortcuts & Admin Hub Routing ---
  describe('Interface Hub Component Routing', () => {
    it('handleHubShortcut should open bank UI when hub_btn_bank is clicked', async () => {
      const inter = createMockInteraction('hub_btn_bank');
      await handleHubShortcut(inter);
      const payload = inter.editReplyPayload || inter.replyPayload;
      assert.ok(payload !== null);
      assert.equal(payload.embeds[0].data.title, 'Bank');
    });

    it('handleHubShortcut should route hub_btn_daily to executeDailyClaim', async () => {
      const inter = createMockInteraction('hub_btn_daily');
      await handleHubShortcut(inter);
      const payload = inter.editReplyPayload || inter.replyPayload;
      assert.ok(payload !== null);
      assert.equal(payload.embeds.length, 1);
    });
  });

  // --- 6. Rewards Daily Configuration Modal Input Bounds ---
  describe('Rewards Configuration Modal Bounds', () => {
    it('handleRewardsModal should reject negative inputs with ephemeral error', async () => {
      let savedConfig = null;
      setMockPool({
        query: async (sql, params) => {
          if (sql.includes('INSERT INTO guild_configs')) {
            savedConfig = JSON.parse(params[1]);
            return { rows: [{ config: savedConfig }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }
      });

      const inter = createMockInteraction('rewards_config_modal', {
        fields: {
          base_reward: '-10',
          booster_multiplier: '2',
          streak_bonus: '5',
          streak_cap: '20'
        },
        deferred: true
      });

      await handleRewardsModal(inter);
      assert.equal(savedConfig, null, 'Must NOT save config when negative values are provided');
      assert.ok(inter.followUpPayload !== null, 'Must inform user with error');
      assert.match(inter.followUpPayload.content, /Invalid Base Daily reward/);
    });
  });

  // --- 7. MVP Configuration UI Layout and Modals ---
  describe('MVP Configuration UI Layout and Modals', () => {
    it('showSetupPanel should isolate [Back] [Disable/Enable] on the bottom row', async () => {
      let sentPayload = null;
      const inter = createMockInteraction('mvp_setup', {
        deferred: true
      });
      inter.editReply = async (payload) => {
        sentPayload = payload;
      };

      const config = {
        enabled: true,
        mvpRoleId: '123456789012345678',
        winnersCount: 3,
        mvpRewardAmount: 200
      };

      await showSetupPanel(inter, config);
      assert.ok(sentPayload !== null, 'Must send payload');
      assert.equal(sentPayload.components.length, 4, 'Must have 4 rows (Role, Winners, Actions, Bottom)');

      // Row 3: Actions row with Progress and Reward
      const actionRow = sentPayload.components[2].components;
      assert.equal(actionRow.length, 2, 'Action row must have exactly 2 buttons');
      assert.equal(actionRow[0].data.custom_id, 'mvp_stats_leaderboard');
      assert.equal(actionRow[1].data.custom_id, 'mvp_reward_config_btn');

      // Row 4: Bottom row with Back and Disable/Enable
      const bottomRow = sentPayload.components[3].components;
      assert.equal(bottomRow.length, 2, 'Bottom row must have exactly 2 buttons');
      assert.equal(bottomRow[0].data.custom_id, 'settings_users_roles');
      assert.equal(bottomRow[0].data.label, 'Back');
      assert.equal(bottomRow[1].data.custom_id, 'mvp_toggle');
      assert.equal(bottomRow[1].data.label, 'Disable');
      assert.equal(bottomRow[1].data.style, ButtonStyle.Danger);
    });

    it('handleRewardsModal should process rewards_mvp_modal and save mvpRewardAmount', async () => {
      let savedConfig = null;
      setMockPool({
        query: async (sql, params) => {
          if (sql.includes('INSERT INTO guild_configs')) {
            savedConfig = JSON.parse(params[1]);
            return { rows: [{ config: savedConfig }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }
      });

      let updatedWithConfig = null;
      const inter = createMockInteraction('rewards_mvp_modal', {
        fields: { amount: '350' },
        deferred: true
      });
      inter.update = async (payload) => { updatedWithConfig = payload; };
      inter.editReply = async (payload) => { updatedWithConfig = payload; };

      await handleRewardsModal(inter);
      assert.ok(savedConfig !== null, 'Must save config to database');
      assert.equal(savedConfig.mvpRewardAmount, 350, 'Must update mvpRewardAmount to 350');
    });
  });
});
