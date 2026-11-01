import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN = 'mock_token_for_tests';
process.env.DATABASE_URL = 'postgres://mock:5432/mock';
import { recordReactionAndIncrement, removeReactionAndDecrement } from '../src/quests/quests.js';
import { checkReactionQuest, checkReactionRemoveQuest, activeQuestsCache, completedQuestsCache } from '../src/activity/index.js';
import { setMockPool } from '../src/storage/postgres.js';

describe('Reaction Quest Stability & Anti-Exploit Verification Suite', () => {
  const guildId = '723544218081034303';
  const userId = '1383486097601859686';
  const forumChannelId = '1232850780134834196';
  const threadId = '1564701074001231902';
  const starterMessageId = threadId; // Forum starter post has ID equal to thread ID
  const commentMessageId = '1564701099999999999';

  const mockQuest = {
    id: 180,
    guild_id: guildId,
    channel_id: forumChannelId,
    channel_type: 'forum',
    action_type: 'react_images',
    required_count: 3,
    reward_coins: 100
  };

  let mockEvents = [];
  let mockProgress = null;
  let mockBalances = [];

  beforeEach(() => {
    mockEvents = [];
    mockProgress = null;
    mockBalances = [];

    activeQuestsCache.set(guildId, [mockQuest]);
    completedQuestsCache.delete(guildId);

    const mockClient = {
      query: async (sql, params) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return { rows: [] };
        }

        // Lock & Check progress
        if (sql.includes('SELECT progress, completed, is_claimed FROM quest_progress')) {
          if (mockProgress) {
            return { rows: [{ ...mockProgress }] };
          }
          return { rows: [] };
        }

        // Anti-duplication exact (message_id + emoji)
        if (sql.includes('SELECT 1 FROM quest_reaction_events') && sql.includes('emoji = $6')) {
          const match = mockEvents.find(e =>
            e.guild_id === params[0] &&
            e.user_id === params[1] &&
            e.quest_id === params[2] &&
            e.message_id === params[4] &&
            e.emoji === params[5]
          );
          return { rows: match ? [{ 1: 1 }] : [] };
        }

        // Check if message was already counted (message_id only)
        if (sql.includes('SELECT 1 FROM quest_reaction_events') && sql.includes('message_id = $5 LIMIT 1')) {
          const match = mockEvents.find(e =>
            e.guild_id === params[0] &&
            e.user_id === params[1] &&
            e.quest_id === params[2] &&
            e.message_id === params[4]
          );
          return { rows: match ? [{ 1: 1 }] : [] };
        }

        // Insert reaction event
        if (sql.includes('INSERT INTO quest_reaction_events')) {
          mockEvents.push({
            guild_id: params[0],
            user_id: params[1],
            quest_id: params[2],
            quest_date: params[3],
            message_id: params[4],
            emoji: params[5]
          });
          return { rowCount: 1, rows: [] };
        }

        // Delete reaction event
        if (sql.includes('DELETE FROM quest_reaction_events') && sql.includes('RETURNING id')) {
          const initialLen = mockEvents.length;
          mockEvents = mockEvents.filter(e => !(
            e.guild_id === params[0] &&
            e.user_id === params[1] &&
            e.quest_id === params[2] &&
            e.message_id === params[4] &&
            e.emoji === params[5]
          ));
          const deleted = initialLen > mockEvents.length;
          return { rows: deleted ? [{ id: 1 }] : [] };
        }

        // Upsert quest_progress
        if (sql.includes('INSERT INTO quest_progress')) {
          mockProgress = {
            progress: params[4],
            completed: params[5],
            is_claimed: params[5]
          };
          return { rows: [{ ...mockProgress }] };
        }

        // Update quest_progress (decrement)
        if (sql.includes('UPDATE quest_progress')) {
          if (mockProgress) {
            mockProgress.progress = params[0];
          }
          return { rows: [] };
        }

        // Balances & Transactions & User Activity
        if (sql.includes('user_balances') || sql.includes('transactions') || sql.includes('user_activity')) {
          return { rows: [] };
        }

        return { rows: [] };
      },
      release: () => {}
    };

    setMockPool({
      connect: async () => mockClient,
      query: async (sql, params) => mockClient.query(sql, params)
    });
  });

  it('1. First reaction on a message increments quest progress', async () => {
    const res = await recordReactionAndIncrement(guildId, userId, mockQuest, 'msg_001', 'heart');
    assert.equal(res.progress, 1);
    assert.equal(res.completed, false);
    assert.equal(mockProgress?.progress, 1);
    assert.equal(mockEvents.length, 1);
  });

  it('2. Multi-emoji stacking on the same message is recorded but does NOT double-increment', async () => {
    // Reaction 1 on msg_001
    const res1 = await recordReactionAndIncrement(guildId, userId, mockQuest, 'msg_001', 'heart');
    assert.equal(res1.progress, 1);

    // Reaction 2 on SAME msg_001 with DIFFERENT emoji
    const res2 = await recordReactionAndIncrement(guildId, userId, mockQuest, 'msg_001', 'laugh');
    assert.equal(res2.progress, 1, 'Progress must remain 1 when reacting to the same message');
    assert.equal(res2.messageAlreadyCounted, true);
    assert.equal(mockEvents.length, 2, 'Both emojis must be recorded in ledger');

    // Reaction on a SECOND message msg_002 increments to 2
    const res3 = await recordReactionAndIncrement(guildId, userId, mockQuest, 'msg_002', 'heart');
    assert.equal(res3.progress, 2);
    assert.equal(mockProgress?.progress, 2);
  });

  it('3. Removing an emoji when another emoji remains on the message preserves progress', async () => {
    // Add two emojis to msg_001, one to msg_002 -> progress = 2
    await recordReactionAndIncrement(guildId, userId, mockQuest, 'msg_001', 'heart');
    await recordReactionAndIncrement(guildId, userId, mockQuest, 'msg_001', 'laugh');
    await recordReactionAndIncrement(guildId, userId, mockQuest, 'msg_002', 'heart');
    assert.equal(mockProgress?.progress, 2);

    // Remove laugh from msg_001: heart still remains on msg_001 -> progress must NOT drop
    const rem1 = await removeReactionAndDecrement(guildId, userId, mockQuest, 'msg_001', 'laugh');
    assert.equal(rem1.decremented, false);
    assert.equal(rem1.hasRemainingReactions, true);
    assert.equal(mockProgress?.progress, 2, 'Progress must stay 2 because msg_001 still has heart');

    // Remove heart from msg_001: no more reactions on msg_001 -> progress drops to 1
    const rem2 = await removeReactionAndDecrement(guildId, userId, mockQuest, 'msg_001', 'heart');
    assert.equal(rem2.decremented, true);
    assert.equal(rem2.progress, 1);
    assert.equal(mockProgress?.progress, 1);
  });

  it('4. Completed quests are locked and cannot be decremented upon reaction removal', async () => {
    // Reach 3/3 completions
    await recordReactionAndIncrement(guildId, userId, mockQuest, 'msg_001', 'heart');
    await recordReactionAndIncrement(guildId, userId, mockQuest, 'msg_002', 'heart');
    const comp = await recordReactionAndIncrement(guildId, userId, mockQuest, 'msg_003', 'heart');
    assert.equal(comp.completed, true);
    assert.equal(mockProgress?.completed, true);

    // Try removing a reaction after completion
    const rem = await removeReactionAndDecrement(guildId, userId, mockQuest, 'msg_001', 'heart');
    assert.equal(rem.decremented, false);
    assert.equal(rem.locked, true);
    assert.equal(mockProgress?.progress, 3);
  });

  it('5. Forum quest strictly counts starter post and ignores replies/comments regardless of cache state', async () => {
    let checkedAdd = false;

    // A. Starter message in forum thread (message.id === channelId)
    const starterReaction = {
      message: {
        id: starterMessageId,
        channelId: threadId,
        guildId,
        author: { id: 'other_user' }
      },
      emoji: { name: 'heart', id: null }
    };
    const mockChannel = {
      id: threadId,
      parentId: forumChannelId,
      isThread: () => true,
      starterMessageId
    };

    await checkReactionQuest(starterReaction, { id: userId, bot: false }, mockChannel);
    assert.equal(mockProgress?.progress, 1, 'Starter message must increment quest progress');

    // B. Comment message in forum thread (message.id !== channelId)
    const commentReaction = {
      message: {
        id: commentMessageId,
        channelId: threadId,
        guildId,
        author: { id: 'other_user' }
      },
      emoji: { name: 'heart', id: null }
    };

    await checkReactionQuest(commentReaction, { id: userId, bot: false }, mockChannel);
    assert.equal(mockProgress?.progress, 1, 'Comment/reply inside thread must NOT increment quest progress');

    // C. Thread owner comment (author === ownerId) must NOT count as original post
    const ownerCommentReaction = {
      message: {
        id: '1564701099999999888',
        channelId: threadId,
        guildId,
        author: { id: 'thread_owner_user' },
        reference: null
      },
      emoji: { name: 'star', id: null }
    };
    const threadWithOwner = {
      ...mockChannel,
      ownerId: 'thread_owner_user'
    };

    await checkReactionQuest(ownerCommentReaction, { id: userId, bot: false }, threadWithOwner);
    assert.equal(mockProgress?.progress, 1, 'Thread owner follow-up comment must NOT count as original post');
  });

  it('6. checkReactionRemoveQuest mirrors starter post checks symmetrically', async () => {
    // Add starter post
    const starterReaction = {
      message: { id: starterMessageId, channelId: threadId, guildId },
      emoji: { name: 'heart', id: null }
    };
    const mockChannel = { id: threadId, parentId: forumChannelId, isThread: () => true, starterMessageId };

    await checkReactionQuest(starterReaction, { id: userId, bot: false }, mockChannel);
    assert.equal(mockProgress?.progress, 1);

    // Try removing a comment (should not match or decrement)
    const commentReaction = {
      message: { id: commentMessageId, channelId: threadId, guildId },
      emoji: { name: 'heart', id: null }
    };
    await checkReactionRemoveQuest(commentReaction, { id: userId, bot: false }, mockChannel);
    assert.equal(mockProgress?.progress, 1, 'Removing reaction on a comment must not decrement quest');

    // Remove starter post (must match and decrement)
    await checkReactionRemoveQuest(starterReaction, { id: userId, bot: false }, mockChannel);
    assert.equal(mockProgress?.progress, 0, 'Removing reaction on starter post must decrement quest');
  });

  after(() => {
    process.exit(0);
  });
});
