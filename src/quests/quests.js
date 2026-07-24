import { getPool } from '../storage/postgres.js';
import { sanitizeError } from '../shared.js';
import { getCairoDateString, getTodayCairo } from '../utils/time.js';
import { getGuildConfig, setGuildConfig } from '../storage/config.js';
import { sendLog, sysLog, sysError } from '../utils/logger.js';
import { updateBalance } from '../economy/service.js';

const MAX_QUESTS_PER_GUILD = 10;

// ============================================
// QUEST POOL CRUD
// ============================================

/**
 * Get all configured quests for a guild
 */
export async function getQuests(guildId) {
  const pool = getPool();
  try {
    const result = await pool.query(
      'SELECT * FROM quests WHERE guild_id = $1 ORDER BY id ASC',
      [guildId]
    );
    return result.rows;
  } catch (error) {
    sysError('Quest Fetch Failed', error, { guild: guildId });
    return [];
  }
}

/**
 * Get a single quest by ID
 */
export async function getQuest(questId) {
  const pool = getPool();
  try {
    const result = await pool.query(
      'SELECT * FROM quests WHERE id = $1',
      [questId]
    );
    return result.rows[0] || null;
  } catch (error) {
    sysError('Quest Fetch Failed', error, { detail: `QuestID: ${questId}` });
    return null;
  }
}

/**
 * Add a new quest (enforces max 10 limit)
 */
export async function addQuest(guildId, { channelId, channelType, actionType, requiredCount, rewardCoins }) {
  const pool = getPool();
  try {
    const countResult = await pool.query(
      'SELECT COUNT(*) as count FROM quests WHERE guild_id = $1',
      [guildId]
    );
    if (parseInt(countResult.rows[0].count) >= MAX_QUESTS_PER_GUILD) {
      return { error: `Maximum of ${MAX_QUESTS_PER_GUILD} quests reached.` };
    }

    const result = await pool.query(
      `INSERT INTO quests (guild_id, channel_id, channel_type, action_type, required_count, reward_coins)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [guildId, channelId, channelType, actionType, requiredCount, rewardCoins]
    );
    return { quest: result.rows[0] };
  } catch (error) {
    sysError('Quest Addition Failed', error, { guild: guildId });
    return { error: 'Database error.' };
  }
}

/**
 * Update a quest's required count and reward
 */
export async function updateQuest(questId, { requiredCount, rewardCoins }) {
  const pool = getPool();
  try {
    await pool.query(
      `UPDATE quests SET required_count = $1, reward_coins = $2 WHERE id = $3`,
      [requiredCount, rewardCoins, questId]
    );
    return true;
  } catch (error) {
    sysError('Quest Update Failed', error, { detail: `QuestID: ${questId}` });
    return false;
  }
}

/**
 * Delete a quest
 */
export async function deleteQuest(questId) {
  const pool = getPool();
  try {
    await pool.query('DELETE FROM quests WHERE id = $1', [questId]);
    return true;
  } catch (error) {
    sysError('Quest Deletion Failed', error, { detail: `QuestID: ${questId}` });
    return false;
  }
}

// ============================================
// DAILY PROGRESS TRACKING (PASSIVE)
// ============================================

/**
 * Get progress for a specific user and quest for today
 */
export async function getProgress(guildId, userId, questId) {
  const pool = getPool();
  const date = getTodayCairo();
  try {
    const result = await pool.query(
      `SELECT * FROM quest_progress
       WHERE guild_id = $1 AND user_id = $2 AND quest_id = $3 AND quest_date = $4`,
      [guildId, userId, questId, date]
    );
    return result.rows[0] || null;
  } catch (error) {
    sysError('Quest Progress Fetch Failed', error, { user: userId, guild: guildId, detail: `QuestID: ${questId}` });
    return null;
  }
}

/**
 * Get all progress records for a user for today's active quests
 */
export async function getAllActiveProgress(guildId, userId, activeQuestIds) {
  if (!activeQuestIds || activeQuestIds.length === 0) return [];
  
  const pool = getPool();
  const date = getTodayCairo();
  try {
    // Need to generate placeholders dynamically
    const placeholders = activeQuestIds.map((_, i) => `$${i + 3}`).join(',');
    const result = await pool.query(
      `SELECT * FROM quest_progress
       WHERE guild_id = $1 AND user_id = $2 AND quest_date = $3
       AND quest_id IN (${placeholders})`,
      [guildId, userId, date, ...activeQuestIds]
    );
    return result.rows;
  } catch (error) {
    sysError('Quest Progress Fetch Failed', error, { user: userId, guild: guildId });
    return [];
  }
}

/**
 * Reset old quest progress for a guild (used during rotation).
 * Preserves today's completions to prevent repeating quests across mid-day refreshes.
 */
export async function resetGuildQuestProgress(guildId) {
  const pool = getPool();
  const date = getTodayCairo();
  try {
    await pool.query(
      'DELETE FROM quest_progress WHERE guild_id = $1 AND quest_date < $2',
      [guildId, date]
    );
    return true;
  } catch (error) {
    sysError('Quest Progress Reset Failed', error, { guild: guildId });
    return false;
  }
}

/**
 * Increment progress and securely auto-payout if completed.
 * Now performs ATOMIC payouts within a transaction to prevent 'burned' quests.
 */
export async function incrementProgressAndPayout(guildId, userId, quest, amount = 1) {
  const pool = getPool();
  const client = await pool.connect();
  const date = getTodayCairo();
  
  const requiredCount = parseInt(quest.required_count) || 1;
  const reward = parseInt(quest.reward_coins) || 0;

  if (requiredCount <= 0 || amount <= 0) {
    client.release();
    return { progress: 0, completed: false, justCompleted: false };
  }

  try {
    await client.query('BEGIN');

    // 1. Lock and Check current progress (FOR UPDATE prevents race conditions)
    const res = await client.query(
      `SELECT progress, completed, is_claimed FROM quest_progress 
       WHERE guild_id = $1 AND user_id = $2 AND quest_id = $3 AND quest_date = $4 FOR UPDATE`,
      [guildId, userId, quest.id, date]
    );

    let currentProgress = 0;
    let alreadyCompleted = false;
    let alreadyClaimed = false;

    if (res.rows.length > 0) {
      currentProgress = parseInt(res.rows[0].progress);
      alreadyCompleted = res.rows[0].completed;
      alreadyClaimed = res.rows[0].is_claimed;
    }

    if (alreadyCompleted || alreadyClaimed) {
      await client.query('ROLLBACK');
      client.release();
      return { progress: currentProgress, completed: true, justCompleted: false };
    }

    const newProgress = currentProgress + amount;
    const justCompleted = newProgress >= requiredCount;

    // 2. Perform UPSERT with updated stats
    const upsertRes = await client.query(
      `INSERT INTO quest_progress (guild_id, user_id, quest_id, quest_date, progress, completed, active_tracking, is_claimed, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE, $6, CASE WHEN $6 THEN NOW() ELSE NULL END)
       ON CONFLICT (guild_id, user_id, quest_id, quest_date)
       DO UPDATE SET 
         progress = $5,
         completed = $6,
         is_claimed = $6,
         completed_at = CASE WHEN NOT quest_progress.completed AND $6 THEN NOW() ELSE quest_progress.completed_at END
       RETURNING *`,
      [guildId, userId, quest.id, date, newProgress, justCompleted]
    );

    // 3. ATOMIC PAYOUT: If just completed, give the reward NOW inside the transaction
    if (justCompleted && reward > 0) {
      // NOTE: We don't call updateBalance() here because it manages its own transaction.
      // We perform the balance update manually within THIS transaction for true atomicity.
      
      // Update Balance
      await client.query(
        `INSERT INTO user_balances (user_id, guild_id, balance, total_earned)
         VALUES ($1, $2, $3, $3)
         ON CONFLICT (user_id, guild_id) DO UPDATE
         SET balance = user_balances.balance + $3, total_earned = user_balances.total_earned + $3, updated_at = NOW()`,
        [userId, guildId, reward]
      );

      // Log Transaction
      await client.query(
        `INSERT INTO transactions (user_id, guild_id, amount, balance_after, type, description, reference_id)
         SELECT $1, $2, $3, balance, 'quest_reward', $4, $5 FROM user_balances WHERE user_id = $1 AND guild_id = $2`,
        [userId, guildId, reward, 'Completed quest', quest.id]
      );
      
      sysLog('Quest Atomic Payout', { user: userId, guild: guildId, detail: `QuestID: ${quest.id} | Amount: ${reward}` });
    }

    await client.query('COMMIT');
    client.release();

    if (amount > 0) {
      sysLog('Quest Progress Captured', { 
          user: userId, 
          guild: guildId, 
          detail: `Quest: ${quest.id} | Progress: ${currentProgress} -> ${newProgress} (Goal: ${requiredCount})${justCompleted ? ' | COMPLETE' : ''}` 
      });
    }

    // Trigger log notification (non-critical, can be async)
    if (justCompleted) {
        triggerQuestLog(guildId, userId, quest).catch(() => {});
    }

    return { 
      progress: newProgress, 
      completed: justCompleted, 
      justCompleted: justCompleted
    };
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch {}
      client.release();
    }
    sysError('Quest Atomic Increment Failed', error, { 
      user: userId, 
      guild: guildId, 
      detail: `QuestID: ${quest.id} | Amount: ${amount}` 
    });
    return { progress: 0, completed: false, justCompleted: false };
  }
}

/**
 * Separate log trigger to keep main logic fast.
 */
async function triggerQuestLog(guildId, userId, quest) {
    try {
        const { client } = await import('../index.js');
        if (client) {
            const guild = client.guilds.cache.get(guildId);
            if (guild) {
                 const user = await client.users.fetch(userId).catch(()=>null);
                 const tag = user ? user.tag : userId;
                 sendLog(guild, 'economy', 'green', '🎯 Quest Completed', 
                    `**User:** \`${tag}\`\n**Quest:** ${formatCompactQuest(quest)}\n**Reward:** \`${quest.reward_coins}\` ${COIN_EMOJI}`);
            }
        }
    } catch {}
}

/**
 * Generate a visual progress bar
 */
export function generateProgressBar(current, total, length = 10) {
  if (total <= 0) return '▱'.repeat(length) + ' 0%';
  const percentage = Math.min(100, Math.floor((current / total) * 100));
  const filledCount = Math.min(length, Math.floor((current / total) * length));
  const emptyCount = length - filledCount;
  
  return '▰'.repeat(filledCount) + '▱'.repeat(emptyCount) + ` ${percentage}%`;
}

/**
 * Cleanup old progress rows (older than 7 days)
 */
export async function cleanupOldProgress() {
  const pool = getPool();
  try {
    await pool.query(
      `DELETE FROM quest_progress WHERE quest_date < CURRENT_DATE - INTERVAL '7 days'`
    );
  } catch (error) {
    sysError('Quest Maintenance Failed', error, { detail: 'Progress cleanup' });
  }
}

// ============================================
// FORMATTERS
// ============================================

/**
 * Format the quest task string (e.g., "Send 10 messages")
 */
export function formatQuestTask(quest) {
  if (!quest) return '';
  const count = quest.required_count;
  const type = quest.action_type;
  const channelType = quest.channel_type || 'text';

  if (type === 'send_messages') {
    const unit = count === 1 ? 'Message' : 'Messages';
    return { text: `Send **${count}** ${unit.toLowerCase()}`, unit };
  }
  if (type === 'voice_minutes') {
    const unit = count === 1 ? 'Minute' : 'Minutes';
    return { text: `Join for **${count}** ${unit.toLowerCase()}`, unit };
  }
  if (type === 'react_images') {
    const unit = count === 1 ? 'Reaction' : 'Reactions';
    const container = (channelType === 'media' || channelType === 'forum') ? (count === 1 ? 'post' : 'posts') : (count === 1 ? 'message' : 'messages');
    return { text: `React on **${count}** ${container}`, unit };
  }
  if (type === 'upload_images') {
    const unit = count === 1 ? 'Upload' : 'Uploads';
    const container = count === 1 ? 'file' : 'files';
    return { text: `Upload **${count}** ${container}`, unit };
  }
  
  return { text: `${formatActionType(type, channelType)} × **${count}**`, unit: count === 1 ? 'Action' : 'Actions' };
}

/**
 * Generate a compact bold action sentence for UI.
 */
export function formatCompactQuest(quest) {
  const count = quest.required_count;
  const type = quest.action_type;
  const channelType = quest.channel_type || 'text';
  const channel = `<#${quest.channel_id}>`;

  if (type === 'send_messages') {
    const unit = count === 1 ? 'message' : 'messages';
    return `**Send ${count} ${unit} in** ${channel}`;
  }
  if (type === 'voice_minutes') {
    const unit = count === 1 ? 'minute' : 'minutes';
    return `**Join** ${channel} **for ${count} ${unit}**`;
  }
  if (type === 'react_images') {
    const container = (channelType === 'media' || channelType === 'forum') ? (count === 1 ? 'post' : 'posts') : (count === 1 ? 'message' : 'messages');
    return `**React to ${count} ${container} in** ${channel}`;
  }
  if (type === 'upload_images') {
    const unit = count === 1 ? 'file' : 'files';
    return `**Upload ${count} ${unit} in** ${channel}`;
  }
  
  return `**Complete ${formatActionType(type, channelType)} x${count} in** ${channel}`;
}

/**
 * Format action type for display
 */
export function formatActionType(actionType, channelType = 'text') {
  if (actionType === 'react_images') {
    return (channelType === 'media' || channelType === 'forum') ? 'React to Posts' : 'React to Messages';
  }
  const map = {
    'send_messages': 'Send Messages',
    'upload_images': 'Upload Files',
    'voice_minutes': 'Voice Minutes',
  };
  return map[actionType] || actionType;
}

/**
 * Get the action types available for a channel type.
 *
 * Rules:
 * - Voice channels (voice): "Stay in Call (Minutes)" AND standard text engagement (voice text chat).
 * - Media/Forum channels (media): Send Messages, Upload Files, React to Posts.
 * - Text/Announcement channels (text): Send Messages, Upload Files, React to Messages.
 */
export function getActionsForChannelType(channelType) {
  if (channelType === 'voice') {
    return [
      { value: 'voice_minutes', label: '🎙️ Stay in Call (Minutes)' },
      { value: 'send_messages', label: '💬 Send Messages' },
      { value: 'upload_images', label: '🖼️ Upload Files' },
      { value: 'react_images', label: '👍 React to Messages' }
    ];
  }

  if (channelType === 'media' || channelType === 'forum') {
    return [
      { value: 'send_messages', label: '💬 Send Messages' },
      { value: 'upload_images', label: '🖼️ Upload Files' },
      { value: 'react_images', label: '👍 React to Posts' }
    ];
  }

  // text | announcement — standard text engagement set
  return [
    { value: 'send_messages', label: '💬 Send Messages' },
    { value: 'upload_images', label: '🖼️ Upload Files' },
    { value: 'react_images', label: '👍 React to Messages' }
  ];
}
