import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  getNextCairoMidnight,
  getNextQuestRefresh,
  getTimeUntilNextCairoHour,
  getCairoDateString,
  getCairoDateOffset,
  getYesterdayCairo,
  getTodayCairo
} from '../src/utils/time.js';
import { acquireDailyResetLock, setMockPool } from '../src/storage/postgres.js';
import { getUnclaimedDailyNotificationUsers } from '../src/storage/notifications.js';

describe('Cairo Seasonal Time & Notification Hardening Test Suite', () => {
  describe('Cairo Midnight Transitions (Standard Time vs Summer Time)', () => {
    it('calculates correct Cairo midnight during Summer Time / DST (UTC+3 -> 21:00 UTC)', () => {
      const summerTime = new Date('2026-07-15T14:00:00Z');
      const midnight = getNextCairoMidnight(summerTime);
      assert.equal(midnight.toISOString(), '2026-07-15T21:00:00.000Z');
      assert.equal(getCairoDateString(midnight), '2026-07-16');
    });

    it('calculates correct Cairo midnight during Autumn clock fallback (October 29, 2026 25-hour day)', () => {
      const oct29Noon = new Date('2026-10-29T12:00:00Z');
      const midnight = getNextCairoMidnight(oct29Noon);
      // At midnight, clocks turn back from UTC+3 to UTC+2, so midnight is 22:00 UTC
      assert.equal(midnight.toISOString(), '2026-10-29T22:00:00.000Z');
      assert.equal(getCairoDateString(midnight), '2026-10-30');
    });

    it('calculates correct Cairo midnight when called at 21:05 UTC on October 29 (was 23:05 local)', () => {
      const oct29Late = new Date('2026-10-29T21:05:00Z');
      const midnight = getNextCairoMidnight(oct29Late);
      assert.equal(midnight.toISOString(), '2026-10-29T22:00:00.000Z');
      assert.equal(getCairoDateString(midnight), '2026-10-30');
    });

    it('calculates correct Cairo midnight during Winter / Standard Time (UTC+2 -> 22:00 UTC)', () => {
      const winterTime = new Date('2026-12-01T10:00:00Z');
      const midnight = getNextCairoMidnight(winterTime);
      assert.equal(midnight.toISOString(), '2026-12-01T22:00:00.000Z');
      assert.equal(getCairoDateString(midnight), '2026-12-02');
    });
  });

  describe('Quest Refresh Scheduling Across Timezone Shifts', () => {
    it('calculates 2x refresh correctly during Winter Time (UTC+2)', () => {
      // 08:00 UTC = 10:00 Cairo; next 2x refresh is 12:00 Cairo = 10:00 UTC
      const winterMorning = new Date('2026-11-01T08:00:00Z');
      const nextRefresh = getNextQuestRefresh(2, winterMorning);
      assert.equal(nextRefresh.toISOString(), '2026-11-01T10:00:00.000Z');
    });

    it('calculates 2x refresh correctly during Summer Time (UTC+3)', () => {
      // 07:00 UTC = 10:00 Cairo; next 2x refresh is 12:00 Cairo = 09:00 UTC
      const summerMorning = new Date('2026-07-15T07:00:00Z');
      const nextRefresh = getNextQuestRefresh(2, summerMorning);
      assert.equal(nextRefresh.toISOString(), '2026-07-15T09:00:00.000Z');
    });

    it('calculates 1x refresh correctly across midnight transition', () => {
      const oct29Late = new Date('2026-10-29T21:05:00Z');
      const nextRefresh = getNextQuestRefresh(1, oct29Late);
      assert.equal(nextRefresh.toISOString(), '2026-10-29T22:00:00.000Z');
    });
  });

  describe('Hourly Ticker Alignment', () => {
    it('getTimeUntilNextCairoHour returns valid millisecond duration to next top of hour', () => {
      const ms = getTimeUntilNextCairoHour();
      assert.ok(ms > 0, 'Duration must be positive');
      assert.ok(ms <= 3600000, 'Duration must be at most 1 hour');
    });
  });

  describe('Atomic Daily Lock Idempotency', () => {
    it('acquires lock when database returns returning row', async () => {
      setMockPool({
        query: async (sql, params) => {
          if (sql.includes('global_cron_locks')) {
            return { rows: [{ job_name: params[0] }] };
          }
          return { rows: [] };
        }
      });

      const acquired = await acquireDailyResetLock('cairo_midnight_streak_reset', '2026-10-31');
      assert.equal(acquired, true, 'Lock should be acquired successfully');
    });

    it('rejects duplicate execution on the same date when conflict update matches', async () => {
      setMockPool({
        query: async (sql, params) => {
          if (sql.includes('global_cron_locks')) {
            // Conflict where last_run_date == EXCLUDED.last_run_date -> 0 rows updated
            return { rows: [] };
          }
          return { rows: [] };
        }
      });

      const acquired = await acquireDailyResetLock('cairo_midnight_streak_reset', '2026-10-31');
      assert.equal(acquired, false, 'Duplicate execution on same day must be rejected');
    });
  });

  describe('Unclaimed Daily Users Filtering', () => {
    it('filters for users who have not claimed for today Cairo date', async () => {
      let executedSql = '';
      let executedParams = [];

      setMockPool({
        query: async (sql, params) => {
          executedSql = sql;
          executedParams = params;
          return { rows: [{ user_id: 'user_123' }, { user_id: 'user_456' }] };
        }
      });

      const targetDate = '2026-10-31';
      const users = await getUnclaimedDailyNotificationUsers(targetDate);
      assert.deepEqual(users, ['user_123', 'user_456']);
      assert.ok(executedSql.includes('notif_daily_claim = TRUE'), 'Must filter by opt-in flag');
      assert.ok(executedSql.includes('last_daily AT TIME ZONE \'Africa/Cairo\''), 'Must filter by Cairo date');
      assert.equal(executedParams[0], targetDate);
    });

    it('returns empty array if todayCairoDate is missing', async () => {
      const users = await getUnclaimedDailyNotificationUsers('');
      assert.deepEqual(users, []);
    });
  });
});
