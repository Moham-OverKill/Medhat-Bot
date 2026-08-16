import { getPool, query } from './postgres.js';
import { isValidSnowflake, sanitizeError as formatError } from '../shared.js';
import { sysLog, sysError } from '../utils/logger.js';

// Config schema validation
const CONFIG_SCHEMA = {
  mvpRoleId: { type: 'string', validate: isValidSnowflake, required: false },
  announceChannelId: { type: 'string', validate: isValidSnowflake, required: false },
  intervalNumber: { type: 'number', min: 1, max: 168, required: false },
  winnersCount: { type: 'number', min: 1, max: 5, required: false },
  intervalUnit: { type: 'string', enum: ['hours', 'weeks'], required: false },
  enabled: { type: 'boolean', required: false },
  nextCheckTime: { type: 'number', min: 0, required: false },
  schedule_interval_ms: { type: 'number', min: 60000, max: 4 * 7 * 24 * 60 * 60 * 1000, required: false },
  last_award_at: { type: 'string', required: false },
  next_award_at: { type: 'string', required: false },
  activated_at: { type: 'string', required: false },
  mvpRewardAmount: { type: 'number', min: 0, required: false },
  booster_multiplier: { type: 'number', min: 0, required: false },
  daily_streak_bonus: { type: 'number', min: 0, required: false },
  daily_base_reward: { type: 'number', min: 0, required: false },
  daily_streak_cap: { type: 'number', min: 1, required: false },
  // Quests module (Passive system)
  quests_enabled: { type: 'boolean', required: false },
  quests_channel_id: { type: 'string', validate: isValidSnowflake, required: false },
  quests_refreshes_per_day: { type: 'number', min: 1, max: 4, required: false },
  quests_per_refresh: { type: 'number', min: 1, max: 10, required: false },
  active_quest_ids: { type: 'object', required: false }, // Store as array
  active_quest_snapshot: { type: 'object', required: false }, // Frozen quest objects for the current cycle
  current_quest_cycle: { type: 'number', min: 0, required: false }, // Monotonic cycle counter
  last_quest_ids: { type: 'object', required: false }, // Previous cycle's IDs
  // Legacy Missions module (for migration)
  missions_enabled: { type: 'boolean', required: false },
  missions_channel_id: { type: 'string', validate: isValidSnowflake, required: false },
  active_mission_id: { type: 'number', min: 0, required: false },
  active_mission_date: { type: 'string', required: false },
  // Log channels
  log_eco_channel_id: { type: 'string', validate: isValidSnowflake, required: false },
  log_inv_channel_id: { type: 'string', validate: isValidSnowflake, required: false },
  log_shop_channel_id: { type: 'string', validate: isValidSnowflake, required: false },
  log_audit_channel_id: { type: 'string', validate: isValidSnowflake, required: false },
  last_mvp_reset: { type: 'string', required: false },
  // Channel content filters (Organize module)
  channel_filters: { type: 'object', required: false },
  // Anti-Cheat (Trade Gates)
  anti_cheat_account_age_gate: { type: 'boolean', required: false },
  anti_cheat_join_date_gate: { type: 'boolean', required: false },
  // Vote & Tag Rewards
  vote_reward_amount: { type: 'number', min: 0, required: false },
  tag_reward_amount: { type: 'number', min: 0, required: false },
  coin_emoji: { type: 'string', required: false },
  bot_nickname: { type: 'string', required: false },
  bot_avatar: { type: 'string', required: false },
  // Richest Role Reward
  richest_role_id: { type: 'string', validate: isValidSnowflake, required: false },
  richest_role_enabled: { type: 'boolean', required: false },
  richest_role_winners: { type: 'number', min: 1, max: 5, required: false },
  // Streaks Role Reward
  streak_role_id: { type: 'string', validate: isValidSnowflake, required: false },
  streak_role_enabled: { type: 'boolean', required: false },
  streak_role_winners: { type: 'number', min: 1, max: 5, required: false },
  // Loot Boxes Module
  loot_box_category_name: { type: 'string', required: false },
  loot_box_category_emoji: { type: 'string', required: false },
  // Battlepass / Level System Module
  battlepass_enabled: { type: 'boolean', required: false },
  battlepass_base_xp: { type: 'number', min: 1, max: 999999, required: false },
  battlepass_xp_increment: { type: 'number', min: 0, max: 999999, required: false },
  battlepass_xp_per_level: { type: 'number', min: 1, max: 999999, required: false }, // legacy alias
  battlepass_msg_xp: { type: 'number', min: 0, max: 9999, required: false },
  battlepass_voice_xp: { type: 'number', min: 0, max: 9999, required: false },
  battlepass_quest_xp: { type: 'number', min: 0, max: 9999, required: false },
  battlepass_notif_channel: { type: 'string', validate: isValidSnowflake, required: false },
  // Community Interface / Server Hub Module
  interface_channel_id: { type: 'string', validate: isValidSnowflake, required: false },
  interface_message_id: { type: 'string', validate: isValidSnowflake, required: false }
};

export const configCache = new Map();

import { registerEmojiResolver } from '../shared.js';
registerEmojiResolver((guildId) => {
  const config = configCache.get(guildId);
  return config?.coin_emoji || null;
});

/**
 * Validates and sanitizes configuration object against schema
 */
function validateConfig(config) {
  if (!config || typeof config !== 'object') return null;
  
  const sanitized = {};
  
  for (const [key, schema] of Object.entries(CONFIG_SCHEMA)) {
    if (config[key] === undefined) continue;
    
    // Handle null values for optional fields
    if (config[key] === null) {
      if (schema.required) return null;
      sanitized[key] = null;
      continue;
    }

    // Type checking
    if (schema.type === 'number') {
      const num = Number(config[key]);
      if (isNaN(num)) return null;
      if (schema.min !== undefined && num < schema.min) return null;
      if (schema.max !== undefined && num > schema.max) return null;
      sanitized[key] = num;
    } 
    else if (schema.type === 'string') {
      if (typeof config[key] !== 'string') return null;
      if (schema.validate && !schema.validate(config[key])) return null;
      if (schema.enum && !schema.enum.includes(config[key])) return null;
      sanitized[key] = config[key];
    }
    else if (schema.type === 'boolean') {
      sanitized[key] = Boolean(config[key]);
    }
    else if (schema.type === 'object') {
      if (typeof config[key] !== 'object') return null;
      sanitized[key] = config[key];
    }
  }
  
  return sanitized;
}

export async function initializeGuildConfigs() {
  // Database tables are created by initializeDatabase() in postgres.js
  // This function is kept for backward compatibility
  try {
    const pool = getPool();
    // Test database connection
    await pool.query('SELECT 1');
    
    if (!process.env.NODE_ENV || process.env.NODE_ENV !== 'production') {
      sysLog('Infrastructure Audit', { detail: 'Guild configs storage ready (PostgreSQL)' });
    }
    return true;
  } catch (error) {
    sysError('Infrastructure Audit Failed', error, { detail: 'Guild configs init' });
    throw error;
  }
}

export async function loadGuildConfigs() {
  try {
    const result = await query('SELECT guild_id, config FROM guild_configs');
    
    const validConfigs = {};
    for (const row of result.rows) {
      const guildId = row.guild_id;
      const config = row.config;
      
      if (isValidSnowflake(guildId) && config && typeof config === 'object') {
        const validated = validateConfig(config);
        if (validated) {
          validConfigs[guildId] = validated;
          configCache.set(guildId, validated);
        }
      }
    }
    
    return validConfigs;
  } catch (error) {
    sysError('Infrastructure Audit Failed', error, { detail: 'Loading guild configs' });
    return {};
  }
}

export async function saveGuildConfigs(configs) {
  try {
    // Security: Validate all configs before saving
    const validConfigs = {};
    for (const [guildId, config] of Object.entries(configs)) {
      if (isValidSnowflake(guildId)) {
        const validated = validateConfig(config);
        if (validated) {
          validConfigs[guildId] = validated;
        }
      }
    }
    
    // Use a transaction to ensure all-or-nothing save
    const pool = getPool();
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      for (const [guildId, config] of Object.entries(validConfigs)) {
        const existing = (await getGuildConfig(guildId)) || {};
        const merged = { ...existing, ...config };
        configCache.set(guildId, merged);
        await client.query(
          `INSERT INTO guild_configs (guild_id, config, updated_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (guild_id)
           DO UPDATE SET config = COALESCE(guild_configs.config, '{}'::jsonb) || $2::jsonb, updated_at = NOW()`,
          [guildId, JSON.stringify(merged)]
        );
      }
      
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    sysError('Infrastructure Audit Failed', error, { detail: 'Saving guild configs' });
    throw new Error('Failed to save configuration. Please try again.');
  }
}

export async function getGuildConfig(guildId) {
  // Security: Validate guild ID
  if (!isValidSnowflake(guildId)) {
    sysLog('Interaction Warning', { detail: `Invalid guild ID attempted: ${guildId}` });
    return null;
  }
  
  if (configCache.has(guildId)) {
    return configCache.get(guildId);
  }
  
  try {
    const result = await query(
      'SELECT config FROM guild_configs WHERE guild_id = $1',
      [guildId]
    );
    
    if (result.rows.length === 0) {
      return null;
    }
    
    const config = result.rows[0].config;
    const validated = validateConfig(config);
    if (validated) {
      configCache.set(guildId, validated);
    }
    return validated;
  } catch (error) {
    sysError('Infrastructure Audit Failed', error, { guild: guildId, detail: 'Getting guild config' });
    return null;
  }
}

export async function setGuildConfig(guildId, config) {
  // Security: Validate guild ID
  if (!isValidSnowflake(guildId)) {
    throw new Error('Invalid guild ID');
  }
  
  // Security: Validate config
  const sanitized = validateConfig(config);
  if (!sanitized) {
    throw new Error('Invalid configuration');
  }
  
  try {
    const existing = (await getGuildConfig(guildId)) || {};
    const merged = { ...existing, ...sanitized };
    configCache.set(guildId, merged);
    await query(
      `INSERT INTO guild_configs (guild_id, config, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (guild_id)
       DO UPDATE SET config = COALESCE(guild_configs.config, '{}'::jsonb) || $2::jsonb, updated_at = NOW()`,
      [guildId, JSON.stringify(merged)]
    );
  } catch (error) {
    sysError('Infrastructure Audit Failed', error, { guild: guildId, detail: 'Setting guild config', error: formatError(error) });
    throw new Error('Failed to save configuration');
  }
}

export async function deleteGuildConfig(guildId) {
  // Security: Validate guild ID
  if (!isValidSnowflake(guildId)) {
    throw new Error('Invalid guild ID');
  }
  
  try {
    configCache.delete(guildId);
    await query('DELETE FROM guild_configs WHERE guild_id = $1', [guildId]);
  } catch (error) {
    sysError('Infrastructure Audit Failed', error, { guild: guildId, detail: 'Deleting guild config' });
    throw new Error('Failed to delete configuration');
  }
}
