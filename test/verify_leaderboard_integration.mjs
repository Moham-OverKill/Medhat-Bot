import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLeaderboardMessagePayload,
  getCustomCoinUrl
} from '../src/commands/leaderboard.js';

test('Leaderboard Dispatch Integration Suite', async (t) => {
  await t.test('getCustomCoinUrl should extract CDN URL for custom Discord emojis', () => {
    const configWithCustom = { coin_emoji: '<:medhat_coin:123456789012345678>' };
    const url = getCustomCoinUrl(configWithCustom, 'guild_1');
    assert.equal(url, 'https://cdn.discordapp.com/emojis/123456789012345678.png?size=128&quality=lossless');

    const configWithStandard = { coin_emoji: '🪙' };
    const nullUrl = getCustomCoinUrl(configWithStandard, 'guild_1');
    assert.equal(nullUrl, null);
  });

  await t.test('buildLeaderboardMessagePayload should assemble standalone image attachment and live countdown text', async () => {
    const timestamp = Math.floor(Date.now() / 1000) + 3600;
    const sampleData = [
      { userId: '101', displayName: 'Apex Warrior', score: 25000, roleColor: '#FFD700' },
      { userId: '102', displayName: 'Cyber Knight', score: 18000, roleColor: '#00E5FF' },
      { userId: '103', displayName: 'Shadow Assassin', score: 12000, roleColor: '#FF0055' },
      { userId: '104', displayName: 'Rogue Hunter', score: 8500 }
    ];

    const payload = await buildLeaderboardMessagePayload({
      category: 'daily_coins',
      data: sampleData,
      mvpRecipients: ['101'],
      nextRefreshTimestamp: timestamp,
      guildId: 'guild_123'
    });

    assert.ok(payload.files && payload.files.length === 1, 'Must include 1 image attachment');
    assert.deepEqual(payload.embeds, [], 'Embeds array must be empty to display standalone full-width image');
    assert.ok(payload.content && payload.content.includes(`<t:${timestamp}:R>`), 'Message content must contain live relative timestamp');

    const attachment = payload.files[0];

    // Verify attachment buffer
    assert.equal(attachment.name, 'daily_coins_leaderboard.png');
    assert.ok(Buffer.isBuffer(attachment.attachment), 'Attachment must contain image Buffer');
    assert.equal(attachment.attachment[0], 0x89);
    assert.equal(attachment.attachment[1], 0x50);
  });
});
