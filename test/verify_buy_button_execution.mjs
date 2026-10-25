import assert from 'node:assert';
import { handleShopBuyButton } from '../src/commands/bank.js';

console.log('--- Testing Buy Button Execution & Variable Scope ---');

// Test 1: Verify handleShopBuyButton function executes without ReferenceError TDZ
{
  let replied = false;
  let replyPayload = null;

  const mockInteraction = {
    customId: 'bank_shop_buy_19_0_0_0',
    guildId: '723544218081034303',
    channelId: '1490773654060007596',
    user: { id: '1234353170243915816', username: 'TestUser' },
    member: { id: '1234353170243915816', roles: { cache: new Map() } },
    guild: { name: 'Test Guild' },
    message: { id: '1558403726027268098', embeds: [] },
    reply: (payload) => {
      replied = true;
      replyPayload = payload;
      return Promise.resolve();
    },
    deferReply: () => Promise.resolve(),
    deferUpdate: () => Promise.resolve(),
    editReply: () => Promise.resolve()
  };

  try {
    await handleShopBuyButton(mockInteraction);
  } catch (err) {
    // If it threw ReferenceError about getShopItem, fail immediately
    assert.fail(`handleShopBuyButton threw ReferenceError: ${err.message}`);
  }

  console.log('✓ Test 1: handleShopBuyButton executed without Temporal Dead Zone ReferenceError');
}

console.log('\n--- All Buy Button Execution Tests Passed! ---');
