import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ButtonStyle, MessageFlags } from 'discord.js';
import { CONFIG_DEFAULTS, applyConfigDefaults, configCache } from '../src/storage/config.js';
import { getRewardsPayload, handleRewardsComponent, handleRewardsModal } from '../src/commands/rewards.js';
import { buildGuildCommands } from '../src/commands/register.js';
import { executeDailyClaim } from '../src/commands/daily.js';
import { handleBankCommand, handleBankDaily } from '../src/commands/bank.js';
import { claimDaily } from '../src/economy/service.js';
import { setMockPool } from '../src/storage/postgres.js';

describe('Daily Configuration UI Rework & Gating Test Suite', () => {
  const guildId = '999888777666555444';
  const userId = '111222333444555666';

  beforeEach(() => {
    configCache.delete(guildId);
    setMockPool({
      query: async (sql, params) => {
        if (sql.includes('guild_configs')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('user_balances')) {
          return {
            rows: [{
              user_id: userId,
              guild_id: guildId,
              balance: 100,
              daily_streak: 2,
              last_daily: null,
              last_lost_streak: 0
            }],
            rowCount: 1
          };
        }
        if (sql.includes('battlepass_config')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('quests')) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      },
      connect: async () => ({
        query: async () => ({ rows: [], rowCount: 0 }),
        release: () => {}
      })
    });
  });

  describe('Configuration Schema & Default Rules', () => {
    it('should default daily_enabled to false for new guilds', () => {
      assert.equal(CONFIG_DEFAULTS.daily_enabled, false, 'CONFIG_DEFAULTS.daily_enabled must be false');
    });

    it('applyConfigDefaults should populate daily_enabled: false if unset', () => {
      const merged = applyConfigDefaults({});
      assert.equal(merged.daily_enabled, false, 'Unset daily_enabled must default to false');
    });

    it('applyConfigDefaults should preserve explicit daily_enabled: true', () => {
      const merged = applyConfigDefaults({ daily_enabled: true });
      assert.equal(merged.daily_enabled, true, 'Explicit true must be preserved');
    });

    it('applyConfigDefaults should preserve explicit daily_enabled: false', () => {
      const merged = applyConfigDefaults({ daily_enabled: false });
      assert.equal(merged.daily_enabled, false, 'Explicit false must be preserved');
    });
  });

  describe('Rewards UI & Component Structure', () => {
    it('should build single action row with exactly 3 buttons: Back, Config, Enable/Disable and non-inline fields', async () => {
      configCache.set(guildId, {
        daily_enabled: true,
        daily_base_reward: 30,
        booster_multiplier: 2.0,
        daily_streak_bonus: 10,
        daily_streak_cap: 15
      });

      const payload = await getRewardsPayload(guildId);
      assert.equal(payload.components.length, 1, 'Must have exactly 1 ActionRow');

      const buttons = payload.components[0].components;
      assert.equal(buttons.length, 3, 'ActionRow must contain exactly 3 buttons');

      // Button 1: Back
      assert.equal(buttons[0].data.custom_id, 'settings_coins');
      assert.equal(buttons[0].data.label, 'Back');
      assert.equal(buttons[0].data.style, ButtonStyle.Secondary);

      // Button 2: Config
      assert.equal(buttons[1].data.custom_id, 'rewards_config_btn');
      assert.equal(buttons[1].data.label, 'Config');
      assert.equal(buttons[1].data.style, ButtonStyle.Secondary);

      // Button 3: Disable (when enabled)
      assert.equal(buttons[2].data.custom_id, 'rewards_daily_toggle');
      assert.equal(buttons[2].data.label, 'Disable');
      assert.equal(buttons[2].data.style, ButtonStyle.Danger);

      // Embed properties when enabled
      const embed = payload.embeds[0];
      assert.equal(embed.data.color, 0x2ECC71, 'Embed color must be green when enabled');
      assert.equal(embed.data.description, 'Status: 🟢 Enabled', 'Embed description must strictly be status only');

      // Check fields are each on their own line (inline: false) and in order
      assert.equal(embed.data.fields.length, 4, 'Must have 4 fields in embed');
      assert.equal(embed.data.fields[0].name, '💰 Base Daily');
      assert.equal(embed.data.fields[0].inline, false);

      assert.equal(embed.data.fields[1].name, '🚀 Boosters');
      assert.equal(embed.data.fields[1].inline, false);

      assert.equal(embed.data.fields[2].name, '🔥 Streak Bonus');
      assert.equal(embed.data.fields[2].inline, false);

      assert.equal(embed.data.fields[3].name, '♾️ Streak Cap');
      assert.equal(embed.data.fields[3].inline, false);
    });

    it('should format toggle button as Enable (Success green) and embed as red when disabled', async () => {
      configCache.set(guildId, {
        daily_enabled: false,
        daily_base_reward: 25,
        booster_multiplier: 1.5,
        daily_streak_bonus: 5,
        daily_streak_cap: 20
      });

      const payload = await getRewardsPayload(guildId);
      const buttons = payload.components[0].components;

      assert.equal(buttons[2].data.custom_id, 'rewards_daily_toggle');
      assert.equal(buttons[2].data.label, 'Enable');
      assert.equal(buttons[2].data.style, ButtonStyle.Success);

      const embed = payload.embeds[0];
      assert.equal(embed.data.color, 0xE74C3C, 'Embed color must be red when disabled');
      assert.equal(embed.data.description, 'Status: 🔴 Disabled', 'Embed description must strictly be status only');
    });
  });

  describe('Dynamic Slash Command Registration Gating', () => {
    it('should omit /daily command when daily_enabled is false', async () => {
      configCache.set(guildId, {
        daily_enabled: false,
        quests_enabled: false,
        battlepass_enabled: false
      });

      const commands = await buildGuildCommands(guildId);
      const hasDaily = commands.some(c => c.name === 'daily');
      assert.equal(hasDaily, false, '/daily command must NOT be registered when daily is disabled');
    });

    it('should include /daily command when daily_enabled is true', async () => {
      configCache.set(guildId, {
        daily_enabled: true,
        quests_enabled: false,
        battlepass_enabled: false
      });

      const commands = await buildGuildCommands(guildId);
      const hasDaily = commands.some(c => c.name === 'daily');
      assert.equal(hasDaily, true, '/daily command MUST be registered when daily is enabled');
    });
  });

  describe('Disabled Gating & Standard Error Embeds', () => {
    it('claimDaily should return daily_disabled error when daily_enabled is false', async () => {
      configCache.set(guildId, {
        daily_enabled: false
      });

      const result = await claimDaily(userId, guildId, 'TestUser');
      assert.equal(result.success, false);
      assert.equal(result.error, 'daily_disabled');
    });

    it('executeDailyClaim should reply with standardized error embed when disabled', async () => {
      configCache.set(guildId, {
        daily_enabled: false
      });

      let replyPayload = null;
      const fakeInteraction = {
        guildId,
        user: { id: userId },
        deferred: false,
        replied: false,
        reply: async (payload) => {
          replyPayload = payload;
        }
      };

      await executeDailyClaim(fakeInteraction);
      assert.notEqual(replyPayload, null, 'Must reply to interaction');
      assert.equal(replyPayload.flags, MessageFlags.Ephemeral);
      assert.equal(replyPayload.embeds.length, 1);

      const embed = replyPayload.embeds[0];
      assert.equal(embed.data.title, 'Daily Rewards');
      assert.equal(embed.data.description, 'Daily rewards are not configured for this server yet.');
      assert.equal(embed.data.color, 0xFF0000);
    });
    it('handleBankCommand should open bank UI normally even when daily_enabled is false', async () => {
      configCache.set(guildId, {
        daily_enabled: false
      });

      let editReplyPayload = null;
      const fakeInteraction = {
        guildId,
        user: { id: userId },
        member: { id: userId, displayName: 'TestUser' },
        deferred: true,
        replied: false,
        editReply: async (payload) => {
          editReplyPayload = payload;
        }
      };

      await handleBankCommand(fakeInteraction);
      assert.notEqual(editReplyPayload, null, 'Must editReply with bank UI');
      assert.equal(editReplyPayload.embeds.length, 1);

      const embed = editReplyPayload.embeds[0];
      assert.equal(embed.data.title, 'Bank');
      assert.match(embed.data.description, /Welcome to your personal bank account/);

      const balanceField = embed.data.fields.find(f => f.name.includes('Balance'));
      assert.notEqual(balanceField, undefined);
      assert.match(balanceField.value, /100/);

      const streakField = embed.data.fields.find(f => f.name.includes('Daily Streak'));
      assert.equal(streakField.value, '`Disabled`');

      const nextField = embed.data.fields.find(f => f.name.includes('Next Daily'));
      assert.equal(nextField.value, '`Disabled`');

      const buttons = editReplyPayload.components[0].components;
      assert.equal(buttons.length, 2);
      assert.equal(buttons[0].data.custom_id, 'bank_history');
      assert.equal(buttons[1].data.custom_id, 'bank_daily');
      assert.equal(buttons[1].data.disabled, false, 'Daily button must NOT be disabled so user can click it');
    });

    it('handleBankDaily should reply with Daily Rewards error embed when daily_enabled is false', async () => {
      configCache.set(guildId, {
        daily_enabled: false
      });

      let followUpPayload = null;
      const fakeInteraction = {
        guildId,
        user: { id: userId },
        member: { id: userId, displayName: 'TestUser' },
        deferred: true,
        replied: false,
        deferUpdate: async () => {},
        followUp: async (payload) => {
          followUpPayload = payload;
        }
      };

      await handleBankDaily(fakeInteraction);
      assert.notEqual(followUpPayload, null, 'Must followUp with error');
      assert.equal(followUpPayload.flags, MessageFlags.Ephemeral);
      assert.equal(followUpPayload.embeds.length, 1);

      const embed = followUpPayload.embeds[0];
      assert.equal(embed.data.title, 'Daily Rewards');
      assert.equal(embed.data.description, 'Daily rewards are not configured for this server yet.');
      assert.equal(embed.data.color, 0xFF0000);
    });
  });

  describe('Unified Configuration Modal & Toggle Components', () => {
    it('handleRewardsComponent should show unified modal on rewards_config_btn with non-required fields', async () => {
      configCache.set(guildId, {
        daily_enabled: true,
        daily_base_reward: 50,
        booster_multiplier: 2.5,
        daily_streak_bonus: 8,
        daily_streak_cap: 25
      });

      let shownModal = null;
      const fakeInteraction = {
        customId: 'rewards_config_btn',
        guildId,
        user: { id: userId },
        showModal: async (modal) => {
          shownModal = modal;
        }
      };

      await handleRewardsComponent(fakeInteraction);
      assert.notEqual(shownModal, null, 'Modal must be shown');
      assert.equal(shownModal.data.custom_id, 'rewards_config_modal');
      assert.equal(shownModal.data.title, 'Daily Configuration');
      assert.equal(shownModal.components.length, 4, 'Must have 4 action rows for 4 inputs');

      // Verify all 4 inputs are NOT required and match embed labels
      const expectedLabels = ['Base Daily', 'Boost Multiplier', 'Streak Bonus', 'Streak Cap'];
      for (let i = 0; i < shownModal.components.length; i++) {
        const input = shownModal.components[i].components[0];
        assert.equal(input.data.required, false, `${input.data.custom_id} must not be required`);
        assert.equal(input.data.label, expectedLabels[i], `Input ${i} label must match`);
      }
    });

    it('handleRewardsModal should update all 4 fields simultaneously', async () => {
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

      configCache.set(guildId, { daily_enabled: true });

      const fakeInteraction = {
        customId: 'rewards_config_modal',
        guildId,
        guild: { id: guildId, channels: { cache: new Map() } },
        user: { id: userId, tag: 'Admin#0001' },
        member: { user: { tag: 'Admin#0001' }, displayName: 'Admin' },
        fields: {
          getTextInputValue: (field) => {
            if (field === 'base_reward') return '40';
            if (field === 'booster_multiplier') return '3.0';
            if (field === 'streak_bonus') return '12';
            if (field === 'streak_cap') return '30';
            return '';
          }
        },
        deferred: true,
        replied: false,
        followUp: async () => {},
        editReply: async () => {}
      };

      await handleRewardsModal(fakeInteraction);
      assert.notEqual(savedConfig, null, 'Config must be saved to DB');
      assert.equal(savedConfig.daily_base_reward, 40);
      assert.equal(savedConfig.booster_multiplier, 3.0);
      assert.equal(savedConfig.daily_streak_bonus, 12);
      assert.equal(savedConfig.daily_streak_cap, 30);
    });

    it('handleRewardsModal should fall back to default values when inputs are left empty', async () => {
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

      configCache.set(guildId, { daily_enabled: true });

      const fakeInteraction = {
        customId: 'rewards_config_modal',
        guildId,
        guild: { id: guildId, channels: { cache: new Map() } },
        user: { id: userId, tag: 'Admin#0001' },
        member: { user: { tag: 'Admin#0001' }, displayName: 'Admin' },
        fields: {
          getTextInputValue: (field) => {
            return ''; // All fields left empty
          }
        },
        deferred: true,
        replied: false,
        followUp: async () => {},
        editReply: async () => {}
      };

      await handleRewardsModal(fakeInteraction);
      assert.notEqual(savedConfig, null, 'Config must be saved to DB');
      assert.equal(savedConfig.daily_base_reward, 25, 'Empty base_reward must default to 25');
      assert.equal(savedConfig.booster_multiplier, 2, 'Empty booster_multiplier must default to 2');
      assert.equal(savedConfig.daily_streak_bonus, 5, 'Empty streak_bonus must default to 5');
      assert.equal(savedConfig.daily_streak_cap, 20, 'Empty streak_cap must default to 20');
    });
  });
});
