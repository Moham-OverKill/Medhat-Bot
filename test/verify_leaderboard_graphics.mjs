import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderLeaderboardCard,
  drawFittedText,
  LEADERBOARD_THEMES
} from '../src/graphics/leaderboardCard.js';
import { normalizeDisplayName } from '../src/graphics/shared.js';
import { createCanvas } from '@napi-rs/canvas';

test('Leaderboard Card Graphics Suite', async (t) => {
  await t.test('drawFittedText should auto-scale font size for long display names', () => {
    const canvas = createCanvas(800, 200);
    const ctx = canvas.getContext('2d');

    // Short name uses maxFontSize
    const shortRes = drawFittedText(ctx, 'Alex', 10, 50, 150, 24, 12, true);
    assert.equal(shortRes.size, 24);

    // Very long name scales down to fit within maxWidth
    const longRes = drawFittedText(ctx, 'Super Incredibly Long Display Name That Would Overflow', 10, 100, 150, 24, 12, true);
    assert.ok(longRes.size < 24, 'Font size should be scaled down');
    assert.ok(ctx.measureText(longRes.text).width <= 150, 'Fitted text width must not exceed maxWidth');
  });

  await t.test('renderLeaderboardCard should render MVP Champions card with Top 3 podium and rows', async () => {
    const sampleData = [
      { userId: '1', displayName: 'Medhat Overkill', score: 28450, roleColor: '#FFD700' },
      { userId: '2', displayName: 'Alex Shadow', score: 14820, roleColor: '#00E5FF' },
      { userId: '3', displayName: 'Knight Rider', score: 11200, roleColor: '#FF0055' },
      { userId: '4', displayName: 'Valkyrie Prime', score: 9450 },
      { userId: '5', displayName: 'Cyber Hunter', score: 8120 },
      { userId: '6', displayName: 'Nova Blade', score: 6890 },
      { userId: '7', displayName: 'Echo Ghost', score: 5340 },
      { userId: '8', displayName: 'Solaris Fire', score: 4100 },
      { userId: '9', displayName: 'Drift King', score: 3250 },
      { userId: '10', displayName: 'Vortex Void', score: 2900 }
    ];

    const buffer = await renderLeaderboardCard({
      category: 'daily_coins',
      data: sampleData,
      mvpRecipients: ['1']
    });

    assert.ok(Buffer.isBuffer(buffer), 'Output must be a Buffer');
    assert.ok(buffer.length > 20000, 'Buffer should be a substantial high-res PNG');
    assert.equal(buffer[0], 0x89);
    assert.equal(buffer[1], 0x50);
    assert.equal(buffer[2], 0x4E);
    assert.equal(buffer[3], 0x47);
  });

  await t.test('renderLeaderboardCard should render Richest Members with coin format', async () => {
    const coinsData = [
      { userId: '1', displayName: 'GoldHoarder', balance: 4500000, roleColor: '#F59E0B' },
      { userId: '2', displayName: 'DragonBanker', balance: 2100000 },
      { userId: '3', displayName: 'CryptoBaron', balance: 1800000 }
    ];

    const buffer = await renderLeaderboardCard({
      category: 'coins',
      data: coinsData,
      currencyName: 'Coins'
    });

    assert.ok(Buffer.isBuffer(buffer));
    assert.equal(buffer[0], 0x89);
    assert.equal(buffer[1], 0x50);
  });

  await t.test('renderLeaderboardCard should render Longest Streaks with flame icon and Days unit', async () => {
    const streakData = [
      { userId: '1', displayName: 'FlameKeeper', daily_streak: 215, roleColor: '#FF5722' },
      { userId: '2', displayName: 'NeverMiss', daily_streak: 164 },
      { userId: '3', displayName: 'TorchBearer', daily_streak: 128 },
      { userId: '4', displayName: 'Solar Flare', daily_streak: 94 }
    ];

    const buffer = await renderLeaderboardCard({
      category: 'streak',
      data: streakData
    });

    assert.ok(Buffer.isBuffer(buffer));
    assert.equal(buffer[0], 0x89);
  });

  await t.test('renderLeaderboardCard should render Highest Levels with Lv and XP formatting', async () => {
    const levelData = [
      { userId: '1', displayName: 'OverLord XP', level: 64, battlepass_xp: 182000, roleColor: '#8B5CF6' },
      { userId: '2', displayName: 'Arcane Mage', level: 51, battlepass_xp: 124000 },
      { userId: '3', displayName: 'Grand Master', level: 45, battlepass_xp: 98000 }
    ];

    const buffer = await renderLeaderboardCard({
      category: 'level',
      data: levelData
    });

    assert.ok(Buffer.isBuffer(buffer));
    assert.equal(buffer[0], 0x89);
  });

  await t.test('normalizeDisplayName should cleanly de-curse aesthetic lookalike characters and preserve valid unicode', () => {
    assert.equal(normalizeDisplayName('! Տ卩丨ᗪ乇尺 | 𝗥𝘅𝗦⁴⁷'), '! SPIDER | RxS47');
    assert.equal(normalizeDisplayName('! 𝔓𝔥𝔬𝔯𝔡𝔢𝔵 | 𝔇𝔈𝔙⁴⁷'), '! Phordex | DEV47');
    assert.equal(normalizeDisplayName('Pʜᴏʀᴅᴇx ⚡'), 'PHORDEx ⚡');
    assert.equal(normalizeDisplayName('𝒩ezuko 🍮 🐾 🎀'), 'Nezuko 🍮 🐾 🎀');
    assert.equal(normalizeDisplayName('الضحكة لايت 🌟'), 'الضحكة لايت 🌟');
    assert.equal(normalizeDisplayName('한글 테스트 👑'), '한글 테스트 👑');
    assert.equal(normalizeDisplayName('日本語 カタカナ 漢字'), '日本語 カタカナ 漢字');
  });

  await t.test('renderLeaderboardCard should handle empty state cleanly', async () => {
    const buffer = await renderLeaderboardCard({
      category: 'daily_coins',
      data: []
    });

    assert.ok(Buffer.isBuffer(buffer));
    assert.ok(buffer.length > 5000);
    assert.equal(buffer[0], 0x89);
  });
});
