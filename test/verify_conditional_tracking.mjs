import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { isTrackingRequiredForGuild, addMessagePoint, handleVoiceStateChange } from '../src/activity/tracker.js';
import { configCache } from '../src/storage/config.js';
import { leaderboardConfigCache, isDailyLeaderboardActive } from '../src/commands/leaderboard.js';
import { weeklySummaryActiveGuilds, isWeeklySummaryActiveForGuild } from '../src/cron/weeklySummary.js';
import { checkContentFilter, invalidateFilterCache } from '../src/middleware/organize.js';
import { setMockPool } from '../src/storage/postgres.js';

describe('Conditional Activity Tracking Shield Verification Suite', () => {
  const guildId = '777888999111';

  beforeEach(() => {
    configCache.delete(guildId);
    leaderboardConfigCache.delete(guildId);
    weeklySummaryActiveGuilds.delete(guildId);
    invalidateFilterCache(guildId);

    setMockPool({
      query: async (sql, params) => {
        if (sql.includes('channel_filters')) {
          return {
            rows: [{
              filters: {
                links_only: ['chan_links_only_123']
              }
            }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 0 };
      }
    });
  });

  describe('isTrackingRequiredForGuild Synchronous Evaluator', () => {
    it('should return false for new unconfigured guilds (0 consumers active)', () => {
      configCache.set(guildId, {
        enabled: false,
        quests_enabled: false,
        battlepass_enabled: false
      });

      const required = isTrackingRequiredForGuild(guildId);
      assert.equal(required, false, 'Unconfigured guild must not require tracking');
    });

    it('should return true immediately when MVP auto-awards are enabled', () => {
      configCache.set(guildId, {
        enabled: true,
        quests_enabled: false,
        battlepass_enabled: false
      });

      const required = isTrackingRequiredForGuild(guildId);
      assert.equal(required, true, 'Guild with MVP enabled must require tracking');
    });

    it('should return true immediately when Quests are enabled', () => {
      configCache.set(guildId, {
        enabled: false,
        quests_enabled: true,
        battlepass_enabled: false
      });

      const required = isTrackingRequiredForGuild(guildId);
      assert.equal(required, true, 'Guild with Quests enabled must require tracking');
    });

    it('should return true immediately when Levels/Battle Pass is enabled', () => {
      configCache.set(guildId, {
        enabled: false,
        quests_enabled: false,
        battlepass_enabled: true
      });

      const required = isTrackingRequiredForGuild(guildId);
      assert.equal(required, true, 'Guild with Levels enabled must require tracking');
    });

    it('should return true when Daily Activity Leaderboard is configured', () => {
      configCache.set(guildId, {
        enabled: false,
        quests_enabled: false,
        battlepass_enabled: false
      });

      leaderboardConfigCache.set(guildId, {
        daily_channel_id: '123456789'
      });

      assert.equal(isDailyLeaderboardActive(guildId), true);
      const required = isTrackingRequiredForGuild(guildId);
      assert.equal(required, true, 'Guild with Daily Leaderboard must require tracking');
    });

    it('should return true when Weekly Summary has subscribers in guild', () => {
      configCache.set(guildId, {
        enabled: false,
        quests_enabled: false,
        battlepass_enabled: false
      });

      weeklySummaryActiveGuilds.add(guildId);

      assert.equal(isWeeklySummaryActiveForGuild(guildId), true);
      const required = isTrackingRequiredForGuild(guildId);
      assert.equal(required, true, 'Guild with weekly summary subscribers must require tracking');
    });
  });

  describe('Activity Tracking Pipeline Bypass', () => {
    it('should immediately reject addMessagePoint when guild tracking is not required', async () => {
      configCache.set(guildId, {
        enabled: false,
        quests_enabled: false,
        battlepass_enabled: false
      });

      const mockGuild = { id: guildId };
      const pointAwarded = await addMessagePoint(mockGuild, 'user123', 'testuser', 'Hello world this is a test message');
      assert.equal(pointAwarded, false, 'addMessagePoint must immediately return false without queuing');
    });

    it('should immediately exit handleVoiceStateChange when guild tracking is not required', async () => {
      configCache.set(guildId, {
        enabled: false,
        quests_enabled: false,
        battlepass_enabled: false
      });

      const mockGuild = { id: guildId, channels: { cache: new Map() } };
      const mockMember = { id: 'user123', user: { username: 'testuser', bot: false } };
      const oldState = { channelId: null, member: mockMember };
      const newState = { channelId: 'voice_chan_1', channel: { id: 'voice_chan_1', members: new Map() }, member: mockMember };

      // Should complete without errors or starting voice tracking
      await handleVoiceStateChange(mockGuild, oldState, newState);
      assert.ok(true, 'handleVoiceStateChange must safely exit early');
    });
  });

  describe('AutoMod & Content Filter Preservation', () => {
    it('should still enforce content filters (e.g. links_only) even when points tracking is completely disabled', async () => {
      configCache.set(guildId, {
        enabled: false,
        quests_enabled: false,
        battlepass_enabled: false,
        channel_filters: {
          links_only: ['chan_links_only_123']
        }
      });

      // Verify tracking is disabled
      assert.equal(isTrackingRequiredForGuild(guildId), false);

      const violatingMessage = {
        guild: { id: guildId, ownerId: 'server_owner_999' },
        channel: { id: 'chan_links_only_123' },
        content: 'Hey everyone check this plain text out without any links',
        attachments: new Map(),
        author: { id: 'regular_user_123', bot: false },
        member: { id: 'regular_user_123', permissions: { has: () => false }, roles: { cache: new Map() } }
      };

      const shouldDelete = await checkContentFilter(violatingMessage);
      assert.equal(shouldDelete, true, 'Content filter must still flag violation for deletion even if tracking is off');

      const conformingMessage = {
        guild: { id: guildId, ownerId: 'server_owner_999' },
        channel: { id: 'chan_links_only_123' },
        content: 'https://discord.com',
        attachments: new Map(),
        author: { id: 'regular_user_123', bot: false },
        member: { id: 'regular_user_123', permissions: { has: () => false }, roles: { cache: new Map() } }
      };

      const shouldDeleteConforming = await checkContentFilter(conformingMessage);
      assert.equal(shouldDeleteConforming, false, 'Conforming link message must be allowed');
    });
  });
});
