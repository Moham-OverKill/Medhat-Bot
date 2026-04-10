import { getPool } from '../storage/postgres.js';
import { sanitizeError } from '../shared.js';
import { getCairoDateString, getTodayCairo } from '../utils/time.js';
import { getGuildConfig, setGuildConfig } from '../storage/config.js';
import { sendLog } from '../utils/logger.js';
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
    console.error('[Quests] Failed to get quests:', sanitizeError(error));
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
    console.error('[Quests] Failed to get quest:', sanitizeError(error));
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
    console.error('[Quests] Failed to add quest:', sanitizeError(error));
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
    console.error('[Quests] Failed to update quest:', sanitizeError(error));
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
    console.error('[Quests] Failed to delete quest:', sanitizeError(error));
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
    console.error('[Quests] Failed to get progress:', sanitizeError(error));
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
    console.error('[Quests] Failed to get all progress:', sanitizeError(error));
    return [];
  }
}

/**
 * Reset all quest progress for a guild (used during rotation)
 */
export async function resetGuildQuestProgress(guildId) {
  const pool = getPool();
  const date = getTodayCairo();
  try {
    await pool.query(
      'DELETE FROM quest_progress WHERE guild_id = $1 AND quest_date = $2',
      [guildId, date]
    );
    return true;
  } catch (error) {
    console.error('[Quests] Failed to reset guild progress:', sanitizeError(error));
    return false;
  }
}

/**
 * Increment progress and securely auto-payout if completed.
 * active_tracking is always TRUE.
 */
export async function incrementProgressAndPayout(guildId, userId, quest, amount = 1) {
  const pool = getPool();
  const date = getTodayCairo();
  try {
    // Atomic Upsert: Will only mark completed=true ONCE
    const result = await pool.query(
      `INSERT INTO quest_progress (guild_id, user_id, quest_id, quest_date, progress, completed, active_tracking, is_claimed, completed_at)
       VALUES ($1::varchar, $2::varchar, $3::integer, $4::date, $5::integer, ($5::integer >= $6::integer), TRUE, ($5::integer >= $6::integer), CASE WHEN $5::integer >= $6::integer THEN NOW() ELSE NULL END)
       ON CONFLICT (guild_id, user_id, quest_id, quest_date)
       DO UPDATE SET 
         progress = quest_progress.progress + EXCLUDED.progress,
         completed_at = CASE 
           WHEN NOT quest_progress.completed AND (quest_progress.progress + EXCLUDED.progress) >= $6::integer THEN NOW() 
           ELSE quest_progress.completed_at 
         END,
         is_claimed = CASE
           WHEN NOT quest_progress.completed AND (quest_progress.progress + EXCLUDED.progress) >= $6::integer THEN TRUE
           ELSE quest_progress.is_claimed
         END,
         completed = CASE 
           WHEN quest_progress.completed THEN TRUE 
           WHEN (quest_progress.progress + EXCLUDED.progress) >= $6::integer THEN TRUE 
           ELSE FALSE 
         END
       RETURNING *`,
      [guildId, userId, quest.id, date, amount, quest.required_count]
    );

    const row = result.rows[0];
    const newProgress = parseInt(row.progress);
    const oldProgress = newProgress - amount;
    const justCompleted = oldProgress < quest.required_count && newProgress >= quest.required_count;

    if (amount > 0) {
        console.log(`[SQL Debug] Guild [${guildId}] User [${userId}] Quest [${quest.id}] Progress: ${oldProgress} -> ${newProgress} (Goal: ${quest.required_count})`);
    }

    // Execute Auto-Payout silently in background
    if (justCompleted) {
      await autoPayout(guildId, userId, quest);
    }

    return { 
      progress: newProgress, 
      completed: row.completed, 
      justCompleted: justCompleted
    };
  } catch (error) {
    console.error('[Quests] Failed to increment progress:', sanitizeError(error));
    return { progress: 0, completed: false, justCompleted: false };
  }
}

/**
 * Silent bank deposit and logging when a quest is completed
 */
async function autoPayout(guildId, userId, quest) {
  try {
    await updateBalance(userId, guildId, quest.reward_coins, 'quest_reward', `Completed quest`);
    
    // Log silently to eco logs
    const { client } = await import('../index.js');
    if (client) {
        const guild = client.guilds.cache.get(guildId);
        if (guild) {
             const user = await client.users.fetch(userId).catch(()=>null);
             const tag = user ? user.tag : userId;
             sendLog(guild, 'economy', 'green', '✅ Quest Auto-Payout', 
                `**User:** \`${tag}\`\n**Quest:** ${formatCompactQuest(quest)}\n**Reward:** \`${quest.reward_coins}\` Coins`);
        }
    }
  } catch (err) {
    console.error('[Quests] Auto-Payout failed:', err);
  }
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
    console.error('[Quests] Progress cleanup error:', sanitizeError(error));
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
    const container = count === 1 ? 'post' : 'posts';
    return { text: `React on **${count}** ${container}`, unit };
  }
  if (type === 'upload_images') {
    const unit = count === 1 ? 'Upload' : 'Uploads';
    const container = count === 1 ? 'file' : 'files';
    return { text: `Upload **${count}** ${container}`, unit };
  }
  
  return { text: `${formatActionType(type)} × **${count}**`, unit: count === 1 ? 'Action' : 'Actions' };
}

/**
 * Generate a compact bold action sentence for UI.
 */
export function formatCompactQuest(quest) {
  const count = quest.required_count;
  const type = quest.action_type;
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
    const unit = count === 1 ? 'post' : 'posts';
    return `**React to ${count} ${unit} in** ${channel}`;
  }
  if (type === 'upload_images') {
    const unit = count === 1 ? 'file' : 'files';
    return `**Upload ${count} ${unit} in** ${channel}`;
  }
  
  return `**Complete ${formatActionType(type)} x${count} in** ${channel}`;
}

/**
 * Format action type for display
 */
export function formatActionType(actionType) {
  const map = {
    'send_messages': 'Send Messages',
    'upload_images': 'Upload Files',
    'react_images': 'React to Posts',
    'voice_minutes': 'Voice Minutes',
  };
  return map[actionType] || actionType;
}

/**
 * Get the action types available for a channel type
 */
export function getActionsForChannelType(channelType) {
  switch (channelType) {
    case 'voice':
      return [{ value: 'voice_minutes', label: '🎙️ Stay in Call (Minutes)' }];
    case 'media':
      return [
        { value: 'send_messages', label: '💬 Send Messages' },
        { value: 'upload_images', label: '🖼️ Upload Files' },
        { value: 'react_images', label: '👍 React to Posts' }
      ];
    case 'text':
    default:
      return [{ value: 'send_messages', label: '💬 Send Messages' }];
  }
}
