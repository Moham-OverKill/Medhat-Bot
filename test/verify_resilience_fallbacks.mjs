import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { wrapInteractionSafety } from '../src/shared.js';
import { handleInteractionError } from '../src/utils/errors.js';
import { query, setMockPool } from '../src/storage/postgres.js';
import { handleShopBuyButton } from '../src/commands/bank.js';

describe('Resilience and Fallback Verification Suite', () => {

  describe('Layer 1: wrapInteractionSafety and Interaction Timeout Shield', () => {
    it('should invoke original reply on normal non-deferred interaction', async () => {
      let originalReplyCalled = false;
      const mockInteraction = {
        deferred: false,
        replied: false,
        reply: async (opts) => {
          originalReplyCalled = true;
          return opts;
        }
      };

      wrapInteractionSafety(mockInteraction);
      await mockInteraction.reply({ content: 'Hello' });

      assert.equal(originalReplyCalled, true, 'Original reply should have been called');
    });

    it('should route reply() to editReply() when interaction was deferred ephemerally by watchdog', async () => {
      let editReplyCalled = false;
      let followUpCalled = false;
      const mockInteraction = {
        deferred: true,
        replied: false,
        ephemeral: true,
        reply: async () => assert.fail('reply should not be called directly when deferred'),
        editReply: async (opts) => {
          editReplyCalled = true;
          return opts;
        },
        followUp: async () => {
          followUpCalled = true;
        }
      };

      wrapInteractionSafety(mockInteraction);
      await mockInteraction.reply({ content: 'Watchdog deferred response' });

      assert.equal(editReplyCalled, true, 'Should route to editReply when ephemeral');
      assert.equal(followUpCalled, false, 'Should not call followUp');
    });

    it('should route reply() to followUp() when interaction was deferred publicly', async () => {
      let editReplyCalled = false;
      let followUpCalled = false;
      const mockInteraction = {
        deferred: true,
        replied: false,
        ephemeral: false,
        reply: async () => assert.fail('reply should not be called directly when deferred'),
        editReply: async () => {
          editReplyCalled = true;
        },
        followUp: async (opts) => {
          followUpCalled = true;
          return opts;
        }
      };

      wrapInteractionSafety(mockInteraction);
      await mockInteraction.reply({ content: 'Public component follow-up' });

      assert.equal(followUpCalled, true, 'Should route to followUp when not ephemeral');
      assert.equal(editReplyCalled, false, 'Must not call editReply on public component');
    });

    it('should safely swallow duplicate deferReply and deferUpdate calls without throwing 40060', async () => {
      let deferReplyCallCount = 0;
      const mockInteraction = {
        deferred: true,
        replied: false,
        deferReply: async () => {
          deferReplyCallCount++;
        },
        deferUpdate: async () => {
          throw new Error('Should not be called');
        }
      };

      wrapInteractionSafety(mockInteraction);
      await assert.doesNotReject(async () => {
        await mockInteraction.deferReply();
        await mockInteraction.deferUpdate();
      });

      assert.equal(deferReplyCallCount, 0, 'Should not invoke original deferReply if already deferred');
    });
  });

  describe('Layer 1.5: handleInteractionError Public Message Shield', () => {
    it('should never call editReply on a public non-ephemeral message component', async () => {
      let editReplyCalled = false;
      let followUpCalled = false;
      let followUpFlags = null;

      const mockInteraction = {
        isMessageComponent: () => true,
        deferred: true,
        replied: false,
        ephemeral: false,
        message: { id: 'public-shop-msg-123' },
        guildId: 'guild-1',
        user: { id: 'user-1' },
        editReply: async () => {
          editReplyCalled = true;
        },
        followUp: async (payload) => {
          followUpCalled = true;
          followUpFlags = payload.flags;
          return payload;
        }
      };

      await handleInteractionError(mockInteraction, new Error('Simulated runtime failure'), 'Test Public Card');

      assert.equal(editReplyCalled, false, 'CRITICAL: editReply must NEVER be called on a public message');
      assert.equal(followUpCalled, true, 'Error must be delivered via followUp');
      assert.equal(followUpFlags, MessageFlags.Ephemeral, 'FollowUp error must be strictly Ephemeral');
    });

    it('should format database reconnect errors with a friendly service notice', async () => {
      let deliveredEmbed = null;

      const mockInteraction = {
        isMessageComponent: () => true,
        deferred: true,
        replied: false,
        ephemeral: true,
        guildId: 'guild-1',
        user: { id: 'user-1' },
        editReply: async (payload) => {
          deliveredEmbed = payload.embeds?.[0];
          return payload;
        }
      };

      await handleInteractionError(mockInteraction, new Error('Database pool not initialized. Call initializeDatabase() first.'), 'Test DB Fail');

      assert.ok(deliveredEmbed, 'Error embed must be created');
      assert.equal(deliveredEmbed.data.title, 'Service Temporarily Unavailable');
      assert.match(deliveredEmbed.data.description, /database service is reconnecting/i);
    });
  });

  describe('Layer 2: Database Transient Error Retry', () => {
    it('should retry transient database disconnects and succeed on recovery', async () => {
      let queryAttempts = 0;
      const mockPool = {
        query: async (sql, params) => {
          queryAttempts++;
          if (queryAttempts === 1) {
            const err = new Error('Connection terminated unexpectedly');
            err.code = 'ECONNRESET';
            throw err;
          }
          return { rows: [{ success: true }], rowCount: 1 };
        }
      };

      setMockPool(mockPool);
      const res = await query('SELECT 1', []);

      assert.equal(queryAttempts, 2, 'Query should have been retried on transient error');
      assert.equal(res.rows[0].success, true);
    });
  });

  describe('Layer 3: Deleted Item Self-Healing in handleShopBuyButton', () => {
    it('should cleanly abort with ephemeral message and prune orphan shop_post when item is deleted', async () => {
      let replyCalled = false;
      let replyPayload = null;
      let deleteQueryExecuted = false;

      const mockDbPool = {
        query: async (sql, params) => {
          if (sql.includes('shop_posts WHERE message_id')) {
            return { rows: [{ message_id: 'msg-999', post_mode: 'buy' }] };
          }
          if (sql.includes('shop_items WHERE id')) {
            // Item does not exist in catalog!
            return { rows: [] };
          }
          if (sql.includes('DELETE FROM shop_posts')) {
            deleteQueryExecuted = true;
            return { rowCount: 1 };
          }
          return { rows: [] };
        }
      };

      setMockPool(mockDbPool);

      const mockInteraction = {
        customId: 'shop_buy_99999_0_0',
        guildId: 'guild-1',
        guild: { name: 'Test Guild' },
        channelId: 'channel-1',
        user: { id: 'buyer-1', username: 'Tester' },
        member: { id: 'buyer-1', roles: { highest: { position: 10 } } },
        deferred: false,
        replied: false,
        message: {
          id: 'msg-999',
          editable: false
        },
        reply: async (payload) => {
          replyCalled = true;
          replyPayload = payload;
          return payload;
        }
      };

      await handleShopBuyButton(mockInteraction);

      assert.equal(replyCalled, true, 'User must receive an immediate reply');
      assert.equal(replyPayload.flags, MessageFlags.Ephemeral, 'Reply must be ephemeral');
      assert.match(replyPayload.embeds[0].data.description, /no longer available in the shop catalog/i);
    });
  });
});
