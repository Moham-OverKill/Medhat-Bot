import { getPool } from '../storage/postgres.js';
import { sanitizeError } from '../shared.js';
import { getCairoDateString, getTodayCairo } from '../utils/time.js';
import { getGuildConfig, setGuildConfig } from '../storage/config.js';
import { getLeaderboardConfig, updateLeaderboards } from '../commands/leaderboard.js';
import { EmbedBuilder } from 'discord.js';
import { sendLog } from '../utils/logger.js';

const MAX_MISSIONS_PER_GUILD = 5;

// ============================================
// MISSION POOL CRUD
// ============================================

/**
 * Get all missions for a guild
 */
export async function getMissions(guildId) {
  const pool = getPool();
  try {
    const result = await pool.query(
      'SELECT * FROM missions WHERE guild_id = $1 ORDER BY id ASC',
      [guildId]
    );
    return result.rows;
  } catch (error) {
    console.error('[Missions] Failed to get missions:', sanitizeError(error));
    return [];
  }
}

/**
 * Get a single mission by ID
 */
export async function getMission(missionId) {
  const pool = getPool();
  try {
    const result = await pool.query(
      'SELECT * FROM missions WHERE id = $1',
      [missionId]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error('[Missions] Failed to get mission:', sanitizeError(error));
    return null;
  }
}

/**
 * Add a new mission (enforces max 7 limit)
 */
export async function addMission(guildId, { channelId, channelType, actionType, requiredCount, rewardCoins }) {
  const pool = getPool();
  try {
    // Check limit
    const countResult = await pool.query(
      'SELECT COUNT(*) as count FROM missions WHERE guild_id = $1',
      [guildId]
    );
    if (parseInt(countResult.rows[0].count) >= MAX_MISSIONS_PER_GUILD) {
      return { error: `Maximum of ${MAX_MISSIONS_PER_GUILD} missions reached.` };
    }

    const result = await pool.query(
      `INSERT INTO missions (guild_id, channel_id, channel_type, action_type, required_count, reward_coins)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [guildId, channelId, channelType, actionType, requiredCount, rewardCoins]
    );
    return { mission: result.rows[0] };
  } catch (error) {
    console.error('[Missions] Failed to add mission:', sanitizeError(error));
    return { error: 'Database error.' };
  }
}

/**
 * Update a mission's required count and reward
 */
export async function updateMission(missionId, { requiredCount, rewardCoins }) {
  const pool = getPool();
  try {
    await pool.query(
      `UPDATE missions SET required_count = $1, reward_coins = $2 WHERE id = $3`,
      [requiredCount, rewardCoins, missionId]
    );
    return true;
  } catch (error) {
    console.error('[Missions] Failed to update mission:', sanitizeError(error));
    return false;
  }
}

/**
 * Delete a mission
 */
export async function deleteMission(missionId) {
  const pool = getPool();
  try {
    await pool.query('DELETE FROM missions WHERE id = $1', [missionId]);
    return true;
  } catch (error) {
    console.error('[Missions] Failed to delete mission:', sanitizeError(error));
    return false;
  }
}

// ============================================
// DAILY PROGRESS TRACKING
// ============================================


/**
 * Get or create a user's progress for today's mission
 */
export async function getProgress(guildId, userId, missionId = 0) {
  const pool = getPool();
  const date = getTodayCairo();
  try {
    let targetMissionId = missionId;
    
    // Auto-resolve active mission if not specified
    if (!targetMissionId) {
      const { getGuildConfig } = await import('../storage/config.js');
      const config = await getGuildConfig(guildId);
      targetMissionId = config?.active_mission_id;
    }

    if (!targetMissionId) return null;

    const result = await pool.query(
      `SELECT * FROM mission_progress
       WHERE guild_id = $1 AND user_id = $2 AND mission_id = $3 AND mission_date = $4`,
      [guildId, userId, targetMissionId, date]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error('[Missions] Failed to get progress:', sanitizeError(error));
    return null;
  }
}

/**
 * Increment a user's mission progress. Returns { progress, completed, justCompleted }
 * Uses atomic upsert to prevent race conditions.
 */
export async function incrementProgress(guildId, userId, missionId, requiredCount, amount = 1) {
  const pool = getPool();
  const date = getTodayCairo();
  try {
    // Atomic upsert: insert or increment, and set completed in one go
    // ONLY updates if active_tracking is TRUE
    const result = await pool.query(
      `INSERT INTO mission_progress (guild_id, user_id, mission_id, mission_date, progress, completed, active_tracking, completed_at)
       VALUES ($1, $2, $3, $4, $5::integer, ($5::integer >= $6::integer), FALSE, CASE WHEN $5::integer >= $6::integer THEN NOW() ELSE NULL END)
       ON CONFLICT (guild_id, user_id, mission_id, mission_date)
       DO UPDATE SET 
         progress = CASE WHEN mission_progress.active_tracking THEN mission_progress.progress + $5::integer ELSE mission_progress.progress END,
         completed_at = CASE 
           WHEN NOT mission_progress.completed AND mission_progress.active_tracking AND (mission_progress.progress + $5::integer) >= $6::integer THEN NOW() 
           ELSE mission_progress.completed_at 
         END,
         completed = CASE 
           WHEN mission_progress.completed THEN TRUE 
           WHEN mission_progress.active_tracking AND (mission_progress.progress + $5::integer) >= $6::integer THEN TRUE 
           ELSE FALSE 
         END
       RETURNING *`,
      [guildId, userId, missionId, date, amount, requiredCount]
    );

    const row = result.rows[0];
    const newProgress = row.progress;
    const oldProgress = newProgress - (row.active_tracking ? amount : 0);
    const justCompleted = oldProgress < requiredCount && newProgress >= requiredCount;

    return { 
      progress: newProgress, 
      completed: row.completed, 
      justCompleted: justCompleted,
      active_tracking: row.active_tracking,
      is_claimed: row.is_claimed
    };
  } catch (error) {
    console.error('[Missions] Failed to increment progress:', sanitizeError(error));
    return { progress: 0, completed: false, justCompleted: false, active_tracking: false, is_claimed: false };
  }
}

/**
 * Start mission tracking for a user
 */
export async function startUserMission(guildId, userId, missionId) {
  const pool = getPool();
  const date = getTodayCairo();
  try {
    await pool.query(
      `INSERT INTO mission_progress (guild_id, user_id, mission_id, mission_date, active_tracking)
       VALUES ($1, $2, $3, $4, TRUE)
       ON CONFLICT (guild_id, user_id, mission_id, mission_date)
       DO UPDATE SET active_tracking = TRUE`,
      [guildId, userId, missionId, date]
    );
    return true;
  } catch (error) {
    console.error('[Missions] Failed to start mission:', sanitizeError(error));
    return false;
  }
}

/**
 * Claim reward for a completed mission
 */
export async function claimUserMissionReward(guildId, userId, missionId, rewardCoins) {
  const pool = getPool();
  const date = getTodayCairo();
  try {
    // Atomic check and update
    const result = await pool.query(
      `UPDATE mission_progress 
       SET is_claimed = TRUE
       WHERE guild_id = $1 AND user_id = $2 AND mission_id = $3 AND mission_date = $4
         AND completed = TRUE AND is_claimed = FALSE
       RETURNING *`,
      [guildId, userId, missionId, date]
    );

    if (result.rows.length === 0) return { error: 'Mission not completed or already claimed.' };

    return { success: true };
  } catch (error) {
    console.error('[Missions] Failed to claim reward:', sanitizeError(error));
    return { error: 'Database error.' };
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
 * Select a random mission from the guild's pool
 */
export async function selectRandomMission(guildId, excludeId = null) {
  const pool = getPool();
  try {
    let query = 'SELECT * FROM missions WHERE guild_id = $1';
    let params = [guildId];

    if (excludeId) {
      query += ' AND id != $2';
      params.push(excludeId);
    }

    query += ' ORDER BY RANDOM() LIMIT 1';
    
    let result = await pool.query(query, params);
    
    // If no other missions found but we excluded one, try again without exclusion
    if (result.rowCount === 0 && excludeId) {
      result = await pool.query('SELECT * FROM missions WHERE guild_id = $1 ORDER BY RANDOM() LIMIT 1', [guildId]);
    }
    
    return result.rows[0] || null;
  } catch (error) {
    console.error('[Missions] Failed to select random mission:', sanitizeError(error));
    return null;
  }
}

/**
 * Cleanup old progress rows (older than 7 days)
 */
export async function cleanupOldProgress() {
  const pool = getPool();
  try {
    await pool.query(
      `DELETE FROM mission_progress WHERE mission_date < CURRENT_DATE - INTERVAL '7 days'`
    );
  } catch (error) {
    console.error('[Missions] Progress cleanup error:', sanitizeError(error));
  }
}

/**
 * Format the mission task string (e.g., "Send 10 messages")
 */
export function formatMissionTask(mission) {
  if (!mission) return '';
  const count = mission.required_count;
  const type = mission.action_type;

  if (type === 'send_messages') return { text: `Send **${count}** messages`, unit: 'Messages' };
  if (type === 'voice_minutes') return { text: `Join for **${count}** minutes`, unit: 'Minutes' };
  if (type === 'react_images') return { text: `React on **${count}** posts`, unit: 'Reactions' };
  if (type === 'upload_images') return { text: `Upload **${count}** files`, unit: 'Uploads' };
  
  return { text: `${formatActionType(type)} × **${count}**`, unit: 'Actions' };
}

/**
 * Generate a compact bold action sentence for the /mission UI.
 */
export function formatCompactMission(mission) {
  const count = mission.required_count;
  const type = mission.action_type;
  const channel = `<#${mission.channel_id}>`;

  if (type === 'send_messages') return `**Send ${count} messages in** ${channel}`;
  if (type === 'voice_minutes') return `**Join** ${channel} **for ${count} minutes**`;
  if (type === 'react_images') return `**React to ${count} posts in** ${channel}`;
  if (type === 'upload_images') return `**Upload ${count} files in** ${channel}`;
  
  return `**Complete ${formatActionType(type)} x${count} in** ${channel}`;
}

/**
 * Format action type for display
 */
export function formatActionType(actionType) {
  const map = {
    'send_messages': 'Send Messages',
    'upload_images': 'Upload Images',
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
        { value: 'upload_images', label: '🖼️ Upload Images' },
        { value: 'react_images', label: '👍 React to Posts' }
      ];
    case 'text':
    default:
      return [{ value: 'send_messages', label: '💬 Send Messages' }];
  }
}

/**
 * Reset all mission progress for a specific guild (Daily Cutoff)
 */
export async function resetGuildMissionProgress(guildId) {
  const pool = getPool();
  try {
    await pool.query('DELETE FROM mission_progress WHERE guild_id = $1', [guildId]);
    return true;
  } catch (error) {
    console.error(`[Missions] Progress wipe error for ${guildId}:`, sanitizeError(error));
    return false;
  }
}

/**
 * Rotate the active daily mission for a specific guild.
 */
export async function rotateGuildMission(client, guildId) {
  try {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;

    const config = await getGuildConfig(guildId) || {};
    if (!config.missions_enabled) return;

    const today = getTodayCairo();

    // 1. Wipe progress
    await resetGuildMissionProgress(guildId);

    // 2. Select new mission (Favoring variety)
    const oldMissionId = config.active_mission_id;
    const allMissions = await getMissions(guildId);
    let validMissions = [];
    
    for (const m of allMissions) {
      const channel = await guild.channels.fetch(m.channel_id).catch(() => null);
      if (channel) validMissions.push(m);
    }

    if (validMissions.length === 0) {
      config.active_mission_id = null;
      config.active_mission_date = today;
      await setGuildConfig(guildId, config);
      return;
    }

    // Try to exclude the old mission if we have at least 2 valid missions total
    let candidates = validMissions;
    if (validMissions.length > 1 && oldMissionId) {
      const others = validMissions.filter(m => m.id !== oldMissionId);
      if (others.length > 0) candidates = others;
    }

    const mission = candidates[Math.floor(Math.random() * candidates.length)];
    config.active_mission_id = mission.id;
    config.active_mission_date = today;

    // 3. Announce new mission
    if (!config.missions_channel_id) {
      await setGuildConfig(guildId, config);
      return;
    }

    const announcementChannel = await guild.channels.fetch(config.missions_channel_id).catch(() => null);
    if (!announcementChannel) {
      await setGuildConfig(guildId, config);
      return;
    }

    // Delete old mission message if exists
    if (config.active_mission_message_id) {
      try {
        const oldMsg = await announcementChannel.messages.fetch(config.active_mission_message_id).catch(() => null);
        if (oldMsg) await oldMsg.delete().catch(() => {});
      } catch (err) {
        // Ignore deletion errors
      }
    }

    const { getNextCairoMidnight } = await import('../utils/time.js');
    const resetTimestamp = Math.floor(getNextCairoMidnight().getTime() / 1000);
    const missionInfo = formatMissionTask(mission);
    const actionString = missionInfo.text.replace(/\*\*/g, '');

    const embed = new EmbedBuilder()
      .setTitle('🎯 Daily Mission')
      .setColor('#F1C40F') // Gold
      .setDescription(
        `📍 Channel ➔ <#${mission.channel_id}>\n` +
        `⚙️ Task ➔ \`${actionString}\`\n` +
        `💰 Reward ➔ \`${mission.reward_coins} OK Coins\`\n\n` +
        `⏱️ Resets in: <t:${resetTimestamp}:R>`
      );

    const sentMessage = await announcementChannel.send({ embeds: [embed] }).catch(() => null);
    if (sentMessage) {
      config.active_mission_message_id = sentMessage.id;
    } else {
      config.active_mission_message_id = null;
    }

    await setGuildConfig(guildId, config);
    console.log(`[Missions] 🎯 New daily mission for ${guild.name}: ${actionString}`);
    sendLog(guild, 'economy', 'gold', '🎯 Mission Rotated', `**New Daily Mission:** ${actionString}\n**Reward:** ${mission.reward_coins} OK Coins`);
    
    // Update the reaction tracker cache immediately
    try {
      const { syncMissionChannelCache } = await import('../activity/index.js');
      syncMissionChannelCache(guildId, mission.channel_id, true);
    } catch {
      // Ignore if sync fails
    }

    await cleanupOldProgress();
  } catch (error) {
    console.error(`[Missions] Rotation error for guild ${guildId}:`, sanitizeError(error));
  }
}
