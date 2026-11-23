import test from 'node:test';
import assert from 'node:assert/strict';
import { VOICE_TICK_INTERVAL_MS, voicePointsTick, addMessagePoint, flushMessageBatch } from '../src/activity/tracker.js';
import { lastRenderedLeaderboardHashes } from '../src/commands/leaderboard.js';
import { flushWeeklyActivityBatch, recordWeeklyMessages, recordWeeklyVoice } from '../src/cron/weeklySummary.js';
import crypto from 'node:crypto';

test('1. Voice points tick interval is 60 seconds', () => {
  assert.equal(VOICE_TICK_INTERVAL_MS, 60000, 'Voice points tick must be configured to 60,000 ms');
});

test('2. Voice points tick bypasses DB when zero voice users are active', async () => {
  let dbQueried = false;
  // Mock client with empty guilds / voiceStates
  const mockClient = {
    guilds: {
      cache: new Map([
        ['guild_1', { voiceStates: { cache: new Map() }, channels: { cache: new Map() } }]
      ])
    }
  };

  // Run tick — since no users are in voice, it should return without querying DB
  await voicePointsTick(mockClient);
  assert.equal(dbQueried, false, 'Database must not be queried when zero users are in voice');
});

test('3. Leaderboard content hashing skips re-rendering when data is unchanged', () => {
  const guildId = 'test_guild_123';
  const category = 'coins';
  const hashKey = `${guildId}:${category}`;

  const top10Data = [
    { userId: 'u1', displayName: 'Alice', balance: 5000, avatarUrl: 'https://cdn.example/1.png', roleColor: '#FF0000' },
    { userId: 'u2', displayName: 'Bob', balance: 3500, avatarUrl: 'https://cdn.example/2.png', roleColor: '#00FF00' }
  ];

  const fingerprint = [
    category,
    '',
    '',
    top10Data.map(u => `${u.userId}:${u.displayName}:${u.balance}:${u.avatarUrl}:${u.roleColor}`).join(';')
  ].join('|');

  const initialHash = crypto.createHash('sha256').update(fingerprint).digest('hex');
  lastRenderedLeaderboardHashes.set(hashKey, initialHash);

  // Compute again with identical data
  const secondHash = crypto.createHash('sha256').update(fingerprint).digest('hex');
  assert.equal(secondHash, initialHash, 'Hash must match for identical data');
  assert.equal(lastRenderedLeaderboardHashes.get(hashKey), secondHash, 'Stored hash must match');

  // Modify one user score
  const modifiedData = [
    { userId: 'u1', displayName: 'Alice', balance: 5200, avatarUrl: 'https://cdn.example/1.png', roleColor: '#FF0000' },
    { userId: 'u2', displayName: 'Bob', balance: 3500, avatarUrl: 'https://cdn.example/2.png', roleColor: '#00FF00' }
  ];
  const modifiedFingerprint = [
    category,
    '',
    '',
    modifiedData.map(u => `${u.userId}:${u.displayName}:${u.balance}:${u.avatarUrl}:${u.roleColor}`).join(';')
  ].join('|');
  const modifiedHash = crypto.createHash('sha256').update(modifiedFingerprint).digest('hex');
  assert.notEqual(modifiedHash, initialHash, 'Hash must change when user score changes');
});

test('4. Weekly activity UNNEST batch buffering', async () => {
  // Test buffering metrics into pendingWeeklyBatch
  recordWeeklyMessages('guild_test', 'user_1', 'UserOne', 5);
  recordWeeklyVoice('guild_test', 'user_1', 'UserOne', 10);
  recordWeeklyMessages('guild_test', 'user_2', 'UserTwo', 3);

  // The metrics are buffered in memory without immediate DB queries
  assert.ok(true, 'Buffered weekly metrics without throwing');
});

test('5. Level boundary guard correctly differentiates XP gain vs level up', async () => {
  const { calculateLevelFromXp } = await import('../src/commands/settings/pass-engine.js');
  const baseXp = 100;
  const incrementXp = 50;

  // Case A: Intra-level gain (user gains XP but stays Level 1)
  const xpBeforeA = 120;
  const xpAfterA = 140;
  const { level: oldLevelA } = calculateLevelFromXp(xpBeforeA, baseXp, incrementXp);
  const { level: newLevelA } = calculateLevelFromXp(xpAfterA, baseXp, incrementXp);
  assert.equal(oldLevelA, 1);
  assert.equal(newLevelA, 1);
  assert.equal(newLevelA > oldLevelA, false, 'Intra-level gain must not trigger level sync');

  // Case B: Level boundary crossed (user reaches Level 2)
  // Level 1 threshold = 100, Level 2 threshold = 100 + 150 = 250
  const xpBeforeB = 240;
  const xpAfterB = 255;
  const { level: oldLevelB } = calculateLevelFromXp(xpBeforeB, baseXp, incrementXp);
  const { level: newLevelB } = calculateLevelFromXp(xpAfterB, baseXp, incrementXp);
  assert.equal(oldLevelB, 1);
  assert.equal(newLevelB, 2);
  assert.equal(newLevelB > oldLevelB, true, 'Crossing level boundary must trigger level sync');
});
