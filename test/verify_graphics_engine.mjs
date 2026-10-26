import test from 'node:test';
import assert from 'node:assert/strict';
import { generateProfileCard, computeProfileStateHash } from '../src/graphics/profileCard.js';
import { renderTradeCard, normalizeToImageUrl, fetchImageSafe, extractCoinColor } from '../src/graphics/tradeCard.js';
import { generateColorPanelImage } from '../src/graphics/colorPaletteCard.js';
import {
  fontStack,
  boldFontStack,
  formatCompactNumber,
  safeFirstChar,
  normalizeHex,
  getLuminance,
  getContrastTextColor,
  hexToRgba,
  shiftColorBrightness
} from '../src/graphics/shared.js';

test('Graphics Shared Utilities Suite', async (t) => {
  await t.test('formatCompactNumber should format values across scales', () => {
    assert.equal(formatCompactNumber(500), '500');
    assert.equal(formatCompactNumber(1500), '1.5k');
    assert.equal(formatCompactNumber(25000), '25K');
    assert.equal(formatCompactNumber(1200000), '1.2M');
    assert.equal(formatCompactNumber(3500000000), '3.5B');
    assert.equal(formatCompactNumber(10000000000000), '10T');
  });

  await t.test('safeFirstChar should handle emojis and surrogate pairs cleanly', () => {
    assert.equal(safeFirstChar('Medhat'), 'M');
    assert.equal(safeFirstChar('🔥Fire'), '🔥');
    assert.equal(safeFirstChar('👑King'), '👑');
    assert.equal(safeFirstChar('', 'D'), 'D');
    assert.equal(safeFirstChar(null, 'U'), 'U');
  });

  await t.test('Color utilities should correctly compute rgba, hex, and luminance', () => {
    assert.equal(normalizeHex('ff0000'), '#ff0000');
    assert.equal(normalizeHex('#fff'), '#ffffff');
    assert.equal(hexToRgba('#00E5FF', 0.5), 'rgba(0, 229, 255, 0.5)');
    assert.ok(getLuminance('#FFFFFF') > 200);
    assert.ok(getLuminance('#000000') < 50);
    assert.equal(getContrastTextColor('#FFFFFF'), '#000000');
    assert.equal(getContrastTextColor('#000000'), '#FFFFFF');
  });

  await t.test('normalizeToImageUrl should resolve Discord custom emojis and emojis', () => {
    assert.equal(
      normalizeToImageUrl('<:gold_coin:123456789012345678>'),
      'https://cdn.discordapp.com/emojis/123456789012345678.png?size=128&quality=lossless'
    );
    assert.equal(
      normalizeToImageUrl('https://example.com/image.png'),
      'https://example.com/image.png'
    );
    assert.equal(normalizeToImageUrl(null), null);
    assert.equal(normalizeToImageUrl('none'), null);
  });
});

test('Profile Card Graphics Engine', async (t) => {
  await t.test('generateProfileCard should generate a valid 2x Retina PNG buffer', async () => {
    const buffer = await generateProfileCard({
      userId: '123456789',
      guildId: '987654321',
      displayName: '🔥 Champ User',
      username: 'champ_user',
      avatarUrl: null,
      currentLevel: 42,
      rank: 1,
      xpIntoCurrentLevel: 350,
      xpForNextLevel: 1000,
      totalXp: 54350,
      balance: 154200,
      streak: 15,
      questsDone: 88,
      itemCount: 12,
      isOwner: true,
      isBooster: true,
      isMvp: true,
      boostPct: 25,
      accentColor: '#FFD700'
    });

    assert.ok(Buffer.isBuffer(buffer), 'Output must be a Buffer');
    assert.ok(buffer.length > 5000, 'Buffer should be non-empty valid PNG');
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    assert.equal(buffer[0], 0x89);
    assert.equal(buffer[1], 0x50);
    assert.equal(buffer[2], 0x4E);
    assert.equal(buffer[3], 0x47);
  });

  await t.test('computeProfileStateHash should compute deterministic hash', () => {
    const data = {
      guildId: '1',
      userId: '2',
      displayName: 'Test',
      username: 'test',
      currentLevel: 5,
      rank: 2,
      balance: 100
    };
    const hash1 = computeProfileStateHash(data);
    const hash2 = computeProfileStateHash(data);
    assert.equal(hash1, hash2);

    const hash3 = computeProfileStateHash({ ...data, balance: 200 });
    assert.notEqual(hash1, hash3);
  });
});

test('Trade Card Graphics Engine', async (t) => {
  await t.test('renderTradeCard should produce a valid 2x Retina PNG buffer', async () => {
    const buffer = await renderTradeCard({
      status: 'pending',
      direction: 'both',
      sender: {
        userId: '111',
        username: 'alice',
        displayName: 'Alice 🌟',
        avatarUrl: null
      },
      target: {
        userId: '222',
        username: 'bob',
        displayName: 'Bob 🛡️',
        avatarUrl: null
      },
      senderCoins: 5000,
      senderItems: [
        { name: 'Dragon Blade', count: 1, item_type: 'weapon' }
      ],
      targetCoins: 12000,
      targetItems: [
        { name: 'Mystery Chest', count: 2, item_type: 'chest' }
      ]
    });

    assert.ok(Buffer.isBuffer(buffer), 'Trade card must return a Buffer');
    assert.ok(buffer.length > 5000, 'Trade card buffer must be substantial');
    assert.equal(buffer[0], 0x89);
    assert.equal(buffer[1], 0x50);
  });
});

test('Color Palette Graphics Engine', async (t) => {
  await t.test('generateColorPanelImage should produce a valid 2x Retina PNG buffer', async () => {
    const buffer = await generateColorPanelImage([
      { roleId: '1', hexColor: '#FF0055', index: 1 },
      { roleId: '2', hexColor: '#00E5FF', index: 2 },
      { roleId: '3', hexColor: '#F59E0B', index: 3 },
      {
        roleId: '4',
        index: 4,
        colors: {
          primaryColor: 0xFF0055,
          secondaryColor: 0x00E5FF,
          tertiaryColor: 0xFFFF00
        }
      }
    ]);

    assert.ok(Buffer.isBuffer(buffer), 'Color palette must return a Buffer');
    assert.ok(buffer.length > 2000, 'Color palette buffer must be substantial');
    assert.equal(buffer[0], 0x89);
    assert.equal(buffer[1], 0x50);
  });
});
