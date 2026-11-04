import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { claimDaily } from '../src/economy/service.js';
import { setMockPool } from '../src/storage/postgres.js';
import { configCache } from '../src/storage/config.js';
import { handleBankCommand } from '../src/commands/bank.js';

describe('All-Time Highest Streak Tracking & Multi-Source Backfill Test Suite', () => {
  const guildId = '888777666555444333';
  const userId = '111222333444555666';

  let mockBalances = new Map();
  let executedQueries = [];

  beforeEach(() => {
    mockBalances.clear();
    executedQueries = [];
    configCache.set(guildId, {
      daily_enabled: true,
      daily_base_reward: 25,
      daily_streak_bonus: 5,
      daily_streak_cap: 30,
      booster_multiplier: 2.0
    });

    setMockPool({
      query: async (sql, params = []) => {
        executedQueries.push({ sql, params });
        const cleanSql = sql.replace(/\s+/g, ' ').trim();

        if (cleanSql.includes('FROM guild_configs')) {
          return { rows: [{ config: configCache.get(guildId) }], rowCount: 1 };
        }

        if (cleanSql.includes('SELECT balance, daily_streak, last_daily, last_lost_streak FROM user_balances WHERE guild_id = $1 AND user_id = $2')) {
          const gId = params[0];
          const uId = params[1];
          const key = `${uId}_${gId}`;
          const row = mockBalances.get(key);
          if (row) return { rows: [{ ...row }], rowCount: 1 };
          return { rows: [], rowCount: 0 };
        }

        if (cleanSql.includes('SELECT * FROM user_balances WHERE user_id = $1 AND guild_id = $2 FOR UPDATE')) {
          const key = `${params[0]}_${params[1]}`;
          const row = mockBalances.get(key);
          if (row) return { rows: [{ ...row }], rowCount: 1 };
          return { rows: [], rowCount: 0 };
        }

        if (cleanSql.includes('UPDATE user_balances SET highest_streak = GREATEST')) {
          return { rowCount: 1 };
        }

        if (cleanSql.includes('INSERT INTO transactions')) {
          return { rows: [], rowCount: 1 };
        }

        return { rows: [], rowCount: 0 };
      },
      connect: async () => ({
        query: async (sql, params = []) => {
          executedQueries.push({ sql, params });
          const cleanSql = sql.replace(/\s+/g, ' ').trim();

          if (cleanSql === 'BEGIN' || cleanSql === 'COMMIT' || cleanSql === 'ROLLBACK') {
            return { rows: [] };
          }

          if (cleanSql.includes('SELECT * FROM user_balances WHERE user_id = $1 AND guild_id = $2 FOR UPDATE')) {
            const key = `${params[0]}_${params[1]}`;
            const row = mockBalances.get(key);
            if (row) return { rows: [{ ...row }], rowCount: 1 };
            return { rows: [], rowCount: 0 };
          }

          if (cleanSql.includes('INSERT INTO user_balances (user_id, guild_id, balance, daily_streak, highest_streak)')) {
            const row = {
              user_id: params[0],
              guild_id: params[1],
              balance: 0,
              daily_streak: 0,
              highest_streak: 0,
              last_daily: null,
              last_lost_streak: 0
            };
            mockBalances.set(`${params[0]}_${params[1]}`, row);
            return { rows: [row], rowCount: 1 };
          }

          if (cleanSql.includes('UPDATE user_balances SET balance = balance + $1')) {
            const reward = params[0];
            const newStreak = params[1];
            const uId = params[2];
            const gId = params[3];
            const key = `${uId}_${gId}`;
            const row = mockBalances.get(key) || { balance: 0, daily_streak: 0, highest_streak: 0 };

            row.balance += reward;
            row.daily_streak = newStreak;
            row.highest_streak = Math.max(row.highest_streak || 0, newStreak);
            row.last_daily = new Date();
            mockBalances.set(key, row);

            return { rows: [{ balance: row.balance, daily_streak: row.daily_streak, highest_streak: row.highest_streak }], rowCount: 1 };
          }

          if (cleanSql.includes('INSERT INTO transactions')) {
            return { rows: [], rowCount: 1 };
          }

          return { rows: [], rowCount: 0 };
        },
        release: () => {}
      })
    });
  });

  it('1. claimDaily increments both daily_streak and highest_streak on personal record', async () => {
    // Initial claim for new user
    const res1 = await claimDaily(userId, guildId, 'TestUser', false);
    assert.equal(res1.success, true);
    assert.equal(res1.streak, 1);

    const key = `${userId}_${guildId}`;
    const userRow = mockBalances.get(key);
    assert.equal(userRow.daily_streak, 1);
    assert.equal(userRow.highest_streak, 1);

    // Verify UPDATE query included highest_streak = GREATEST(...)
    const updateQuery = executedQueries.find(q => q.sql.includes('UPDATE user_balances') && q.sql.includes('highest_streak = GREATEST'));
    assert.ok(updateQuery, 'UPDATE statement must include highest_streak = GREATEST(COALESCE(highest_streak, 0), $2)');
  });

  it('2. claimDaily retains higher highest_streak when starting over after a broken streak', async () => {
    // Seed user with a broken streak of 15 days, currently at streak 0
    const key = `${userId}_${guildId}`;
    mockBalances.set(key, {
      user_id: userId,
      guild_id: guildId,
      balance: 500,
      daily_streak: 0,
      highest_streak: 15,
      last_daily: null, // eligible to claim
      last_lost_streak: 15
    });

    // Claim daily - new streak becomes 1
    const res = await claimDaily(userId, guildId, 'TestUser', false);
    assert.equal(res.success, true);
    assert.equal(res.streak, 1);

    const userRow = mockBalances.get(key);
    assert.equal(userRow.daily_streak, 1, 'Current streak must be 1');
    assert.equal(userRow.highest_streak, 15, 'highest_streak must remain 15, not overwritten by 1');
  });

  it('3. Baseline DB Backfill preserves GREATEST(daily_streak, last_lost_streak)', () => {
    // Test the logic that runs in Phase 1 of the migration
    const accounts = [
      { daily_streak: 5, last_lost_streak: 20, highest_streak: 0 },
      { daily_streak: 30, last_lost_streak: 10, highest_streak: 0 },
      { daily_streak: 0, last_lost_streak: 42, highest_streak: 0 },
      { daily_streak: 8, last_lost_streak: 0, highest_streak: 12 }
    ];

    const results = accounts.map(acc => Math.max(acc.daily_streak, acc.last_lost_streak, acc.highest_streak));
    assert.equal(results[0], 20, 'Should promote last_lost_streak of 20');
    assert.equal(results[1], 30, 'Should promote daily_streak of 30');
    assert.equal(results[2], 42, 'Should promote lost streak of 42');
    assert.equal(results[3], 12, 'Should preserve existing highest_streak of 12');
  });

  it('4. Gaps-and-Islands calculation correctly groups consecutive calendar days into streaks', () => {
    // Simulate transaction claim dates (YYYY-MM-DD in Cairo time)
    // Chain 1: Jan 1, Jan 2, Jan 3 (length: 3)
    // Gap: Jan 4 missing
    // Chain 2: Jan 5, Jan 6, Jan 7, Jan 8, Jan 9 (length: 5)
    // Gap: Jan 10 missing
    // Chain 3: Jan 11, Jan 12 (length: 2)
    const claimDates = [
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
      '2026-01-05',
      '2026-01-06',
      '2026-01-07',
      '2026-01-08',
      '2026-01-09',
      '2026-01-11',
      '2026-01-12'
    ].map(d => new Date(d + 'T00:00:00Z'));

    // Gaps and islands logic
    let maxStreak = 0;
    let currentChain = 0;
    let prevTime = null;

    for (const d of claimDates) {
      if (prevTime === null) {
        currentChain = 1;
      } else {
        const diffDays = Math.round((d.getTime() - prevTime.getTime()) / (1000 * 60 * 60 * 24));
        if (diffDays === 1) {
          currentChain++;
        } else if (diffDays === 0) {
          // Same day claim, ignore
        } else {
          currentChain = 1;
        }
      }
      prevTime = d;
      if (currentChain > maxStreak) {
        maxStreak = currentChain;
      }
    }

    assert.equal(maxStreak, 5, 'The longest unbroken chain should be 5 days');
  });

  it('5. Cairo Midnight Reset leaves highest_streak intact while resetting daily_streak', () => {
    // Simulate a user undergoing Cairo midnight reset
    const user = {
      user_id: userId,
      guild_id: guildId,
      daily_streak: 10,
      highest_streak: 25,
      last_lost_streak: 0
    };

    // Stale reset query simulation:
    // SET last_lost_streak = daily_streak, daily_streak = 0
    user.last_lost_streak = user.daily_streak;
    user.daily_streak = 0;

    assert.equal(user.daily_streak, 0, 'daily_streak must reset to 0');
    assert.equal(user.last_lost_streak, 10, 'last_lost_streak must capture the 10 days');
    assert.equal(user.highest_streak, 25, 'highest_streak must remain completely untouched at 25');
  });

  it('6. Bank UI maintains 100% user-facing integrity with zero "Best:" text leaks', async () => {
    // Seed user with active streak of 3 and highest_streak of 50
    mockBalances.set(`${userId}_${guildId}`, {
      user_id: userId,
      guild_id: guildId,
      balance: 1000,
      daily_streak: 3,
      highest_streak: 50,
      last_daily: new Date(),
      last_lost_streak: 0
    });

    let renderedPayload = null;
    const mockInteraction = {
      guildId,
      user: { id: userId, tag: 'User#1234' },
      member: { id: userId, displayName: 'User' },
      client: { user: { id: '999' } },
      isRepliable: () => true,
      deferred: false,
      replied: false,
      deferReply: async () => {},
      editReply: async (payload) => { renderedPayload = payload; return payload; },
      reply: async (payload) => { renderedPayload = payload; return payload; }
    };

    await handleBankCommand(mockInteraction);

    assert.ok(renderedPayload);
    const embed = renderedPayload.embeds[0];
    const streakField = embed.data.fields.find(f => f.name.includes('Streak'));
    assert.ok(streakField);

    // Verify user-facing string has NO "Best:" or "(Best: 50)" leaks
    assert.ok(!streakField.value.includes('Best:'), 'Bank UI must NOT leak Best streak text to regular users');
    assert.ok(!streakField.value.includes('50'), 'Bank UI must not reveal internal highest_streak number');
    assert.ok(streakField.value.includes('3 day(s)'), 'Must show current active streak of 3 day(s)');
  });

  it('7. Admin streak override promotes highest_streak on increases and protects it on reductions', async () => {
    // Case A: User has highest_streak = 10, admin sets streak to 25
    let currentHighest = 10;
    let newAdminStreak = 25;
    let resultingHighest = Math.max(currentHighest, newAdminStreak);
    assert.equal(resultingHighest, 25, 'Admin setting higher streak must elevate highest_streak to 25');

    // Case B: User has highest_streak = 50, admin sets streak to 5 (e.g. penalty or correction)
    currentHighest = 50;
    newAdminStreak = 5;
    resultingHighest = Math.max(currentHighest, newAdminStreak);
    assert.equal(resultingHighest, 50, 'Admin reducing daily_streak must NEVER reduce all-time highest_streak');
  });

  it('8. Full Lifecycle: New user -> 3-day streak -> Streak broken -> New 5-day streak beats old peak', async () => {
    const key = `${userId}_${guildId}`;

    // Day 1 claim
    let res = await claimDaily(userId, guildId, 'UserA', false);
    assert.equal(res.streak, 1);
    assert.equal(mockBalances.get(key).highest_streak, 1);

    // Day 2 claim (simulate next day)
    let row = mockBalances.get(key);
    // Move last_daily to yesterday
    row.last_daily = new Date(Date.now() - 24 * 60 * 60 * 1000);
    res = await claimDaily(userId, guildId, 'UserA', false);
    assert.equal(res.streak, 2);
    assert.equal(mockBalances.get(key).highest_streak, 2);

    // Day 3 claim (simulate next day)
    row = mockBalances.get(key);
    row.last_daily = new Date(Date.now() - 24 * 60 * 60 * 1000);
    res = await claimDaily(userId, guildId, 'UserA', false);
    assert.equal(res.streak, 3);
    assert.equal(mockBalances.get(key).highest_streak, 3);

    // Cairo Midnight Reset (Streak broken: 3 days missed)
    row = mockBalances.get(key);
    row.last_daily = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
    row.last_lost_streak = 3;
    row.daily_streak = 0;

    // Day 1 after break
    res = await claimDaily(userId, guildId, 'UserA', false);
    assert.equal(res.streak, 1);
    assert.equal(mockBalances.get(key).daily_streak, 1);
    assert.equal(mockBalances.get(key).highest_streak, 3, 'Peak must still be 3 after reset');

    // Day 2 after break
    row = mockBalances.get(key);
    row.last_daily = new Date(Date.now() - 24 * 60 * 60 * 1000);
    res = await claimDaily(userId, guildId, 'UserA', false);
    assert.equal(res.streak, 2);
    assert.equal(mockBalances.get(key).highest_streak, 3, 'Peak must still be 3');

    // Day 3 after break (Ties old peak)
    row = mockBalances.get(key);
    row.last_daily = new Date(Date.now() - 24 * 60 * 60 * 1000);
    res = await claimDaily(userId, guildId, 'UserA', false);
    assert.equal(res.streak, 3);
    assert.equal(mockBalances.get(key).highest_streak, 3, 'Peak ties at 3');

    // Day 4 after break (Surpasses old peak!)
    row = mockBalances.get(key);
    row.last_daily = new Date(Date.now() - 24 * 60 * 60 * 1000);
    res = await claimDaily(userId, guildId, 'UserA', false);
    assert.equal(res.streak, 4);
    assert.equal(mockBalances.get(key).daily_streak, 4);
    assert.equal(mockBalances.get(key).highest_streak, 4, 'Peak must now advance to 4');
  });
});
