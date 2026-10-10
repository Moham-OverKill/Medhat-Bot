import { getPool, query } from './postgres.js';
import { isValidSnowflake, sanitizeError as formatError } from '../shared.js';
import { sysLog, sysWarn, sysError } from '../utils/logger.js';

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
  quest_history_ids: { type: 'object', required: false }, // LRU history of recently played quests
  last_quest_rotated_date: { type: 'string', required: false }, // YYYY-MM-DD
  last_quest_rotated_hour: { type: 'number', min: 0, max: 23, required: false }, // 0-23
  last_quest_rotated_at: { type: 'string', required: false }, // ISO timestamp
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
  // Anti-Cheat (Voice AFK Gates)
  anti_cheat_voice_min_humans: { type: 'boolean', required: false },
  anti_cheat_voice_no_mute: { type: 'boolean', required: false },
  anti_cheat_voice_no_deafen: { type: 'boolean', required: false },
  anti_cheat_voice_no_afk_channel: { type: 'boolean', required: false },
  // Anti-Cheat (Text Spam Gates)
  anti_cheat_text_cooldown: { type: 'boolean', required: false },
  anti_cheat_text_min_length: { type: 'boolean', required: false },
  anti_cheat_text_no_duplicates: { type: 'boolean', required: false },
  anti_cheat_text_no_prefixes: { type: 'boolean', required: false },
  // Vote & Tag Rewards
  vote_reward_amount: { type: 'number', min: 0, required: false },
  tag_reward_amount: { type: 'number', min: 0, required: false },
  coin_name: { type: 'string', required: false },
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
  battlepass_xp_increment: { type: 'number', min: 1, max: 999999, required: false },
  battlepass_xp_per_level: { type: 'number', min: 1, max: 999999, required: false }, // legacy alias
  battlepass_msg_xp: { type: 'number', min: 0, max: 9999, required: false },
  battlepass_voice_xp: { type: 'number', min: 0, max: 9999, required: false },
  battlepass_quest_xp: { type: 'number', min: 0, max: 9999, required: false },
  battlepass_notif_channel: { type: 'string', validate: isValidSnowflake, required: false },
  // Community Interface / Server Hub Module
  interface_channel_id: { type: 'string', validate: isValidSnowflake, required: false },
  interface_message_id: { type: 'string', validate: isValidSnowflake, required: false }
};

export const CONFIG_DEFAULTS = {
  enabled: false,
  intervalNumber: 24,
  intervalUnit: 'hours',
  winnersCount: 1,
  mvpRewardAmount: 100,
  booster_multiplier: 1.5,
  daily_streak_bonus: 5,
  daily_base_reward: 25,
  daily_streak_cap: 20,
  quests_enabled: false,
  quests_refreshes_per_day: 1,
  quests_per_refresh: 3,
  vote_reward_amount: 100,
  tag_reward_amount: 0,
  coin_name: 'Coins',
  anti_cheat_account_age_gate: false,
  anti_cheat_join_date_gate: false,
  anti_cheat_voice_min_humans: true,
  anti_cheat_voice_no_mute: true,
  anti_cheat_voice_no_deafen: true,
  anti_cheat_voice_no_afk_channel: true,
  anti_cheat_text_cooldown: true,
  anti_cheat_text_min_length: true,
  anti_cheat_text_no_duplicates: true,
  anti_cheat_text_no_prefixes: true,
  richest_role_enabled: false,
  richest_role_winners: 1,
  streak_role_enabled: false,
  streak_role_winners: 1,
  battlepass_enabled: false,
  battlepass_base_xp: 100,
  battlepass_xp_increment: 50,
  battlepass_xp_per_level: 100,
  battlepass_msg_xp: 1,
  battlepass_voice_xp: 1,
  battlepass_quest_xp: 150
};

/**
 * Merges defaults into a configuration object, ensuring primitive values never fall back to undefined
 */
export function applyConfigDefaults(config) {
  if (!config || typeof config !== 'object') return { ...CONFIG_DEFAULTS };
  const merged = { ...CONFIG_DEFAULTS, ...config };
  for (const [key, defaultVal] of Object.entries(CONFIG_DEFAULTS)) {
    if (merged[key] === undefined || merged[key] === null || (typeof defaultVal === 'number' && isNaN(merged[key]))) {
      merged[key] = defaultVal;
    }
  }
  // Hard guards: level engine parameters must never be zero or negative
  if (typeof merged.battlepass_xp_increment !== 'number' || merged.battlepass_xp_increment <= 0) {
    sysWarn('Invalid Battlepass XP Increment In Config', {
      detail: `Value was ${merged.battlepass_xp_increment}; reset to default 50`
    });
    merged.battlepass_xp_increment = 50;
  }
  if (typeof merged.battlepass_base_xp !== 'number' || merged.battlepass_base_xp <= 0) {
    merged.battlepass_base_xp = 100;
  }
  if (typeof merged.battlepass_quest_xp !== 'number' || merged.battlepass_quest_xp <= 0) {
    merged.battlepass_quest_xp = 150;
  }
  return merged;
}

export const configCache = new Map();

import { registerEmojiResolver, registerNameResolver, getCurrencyName, getCurrencyEmoji } from '../shared.js';
registerEmojiResolver((guildId) => {
  const config = configCache.get(guildId);
  return config?.coin_emoji || null;
});
registerNameResolver((guildId) => {
  const config = configCache.get(guildId);
  return config?.coin_name || null;
});
export { getCurrencyName, getCurrencyEmoji };

/**
 * Validates and sanitizes configuration object against schema
 * Never discards the whole config if a single field is invalid.
 */
function validateConfig(config) {
  if (!config || typeof config !== 'object') return {};
  
  const sanitized = {};
  
  for (const [key, schema] of Object.entries(CONFIG_SCHEMA)) {
    if (config[key] === undefined) continue;
    
    // Handle null values for optional fields
    if (config[key] === null) {
      sanitized[key] = null;
      continue;
    }

    // Type checking
    if (schema.type === 'number') {
      const num = Number(config[key]);
      if (!isNaN(num)) {
        if (schema.min !== undefined && num < schema.min) {
          sanitized[key] = schema.min;
        } else if (schema.max !== undefined && num > schema.max) {
          sanitized[key] = schema.max;
        } else {
          sanitized[key] = num;
        }
      }
    } 
    else if (schema.type === 'string') {
      if (typeof config[key] === 'string') {
        const trimmed = config[key].trim();
        if (trimmed === '') {
          sanitized[key] = null;
        } else if (schema.validate) {
          sanitized[key] = schema.validate(trimmed) ? trimmed : null;
        } else if (schema.enum) {
          sanitized[key] = schema.enum.includes(trimmed) ? trimmed : null;
        } else {
          sanitized[key] = trimmed;
        }
      } else {
        sanitized[key] = null;
      }
    }
    else if (schema.type === 'boolean') {
      sanitized[key] = Boolean(config[key]);
    }
    else if (schema.type === 'object') {
      if (typeof config[key] === 'object' && config[key] !== null) {
        sanitized[key] = config[key];
      }
    }
  }

  // Preserve any additional top-level keys that may exist in JSON and are not part of CONFIG_SCHEMA
  for (const [key, val] of Object.entries(config)) {
    if (!(key in CONFIG_SCHEMA) && sanitized[key] === undefined && val !== undefined) {
      sanitized[key] = val;
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
    const pool = getPool();
    const result = await pool.query('SELECT guild_id, config FROM guild_configs');
    
    const validConfigs = {};
    for (const row of result.rows) {
      const guildId = row.guild_id;
      const config = row.config;
      
      if (isValidSnowflake(guildId) && config && typeof config === 'object') {
        const validated = applyConfigDefaults(validateConfig(config));
        validConfigs[guildId] = validated;
        configCache.set(guildId, validated);
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
    const pool = getPool();
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      for (const [guildId, config] of Object.entries(configs)) {
        if (isValidSnowflake(guildId) && config && typeof config === 'object') {
          const sanitized = validateConfig(config);
          const res = await client.query(
            `INSERT INTO guild_configs (guild_id, config, updated_at)
             VALUES ($1, $2::jsonb, NOW())
             ON CONFLICT (guild_id)
             DO UPDATE SET config = (
               CASE 
                 WHEN $2::jsonb ? 'channel_filters' AND jsonb_typeof($2::jsonb->'channel_filters') = 'object' THEN 
                   (COALESCE(guild_configs.config, '{}'::jsonb) || $2::jsonb) || 
                   jsonb_build_object('channel_filters', 
                     COALESCE(guild_configs.config->'channel_filters', '{}'::jsonb) || ($2::jsonb->'channel_filters')
                   )
                 ELSE 
                   COALESCE(guild_configs.config, '{}'::jsonb) || $2::jsonb
               END
             ), updated_at = NOW()
             RETURNING config`,
            [guildId, JSON.stringify(sanitized)]
          );
          const fullConfig = applyConfigDefaults(validateConfig(res.rows[0]?.config || {}));
          configCache.set(guildId, fullConfig);
        }
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
    return applyConfigDefaults(configCache.get(guildId));
  }
  
  try {
    const pool = getPool();
    const result = await pool.query(
      'SELECT config FROM guild_configs WHERE guild_id = $1',
      [guildId]
    );
    
    if (result.rows.length === 0) {
      const defaultConfig = applyConfigDefaults({});
      configCache.set(guildId, defaultConfig);
      return defaultConfig;
    }
    
    const config = result.rows[0].config;
    const validated = applyConfigDefaults(validateConfig(config || {}));
    configCache.set(guildId, validated);
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
  
  if (!config || typeof config !== 'object') {
    throw new Error('Invalid configuration');
  }
  
  const sanitized = validateConfig(config);
  
  try {
    const pool = getPool();
    // Atomic PostgreSQL JSONB merge - deep merges channel_filters to prevent accidental resets
    const result = await pool.query(
      `INSERT INTO guild_configs (guild_id, config, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (guild_id)
       DO UPDATE SET config = (
         CASE 
           WHEN $2::jsonb ? 'channel_filters' AND jsonb_typeof($2::jsonb->'channel_filters') = 'object' THEN 
             (COALESCE(guild_configs.config, '{}'::jsonb) || $2::jsonb) || 
             jsonb_build_object('channel_filters', 
               COALESCE(guild_configs.config->'channel_filters', '{}'::jsonb) || ($2::jsonb->'channel_filters')
             )
           ELSE 
             COALESCE(guild_configs.config, '{}'::jsonb) || $2::jsonb
         END
       ), updated_at = NOW()
       RETURNING config`,
      [guildId, JSON.stringify(sanitized)]
    );
    
    const fullConfig = applyConfigDefaults(validateConfig(result.rows[0]?.config || {}));
    configCache.set(guildId, fullConfig);

    // Sync explicit database columns on guild_configs
    await pool.query(
      `UPDATE guild_configs SET
         coin_name = COALESCE(config->>'coin_name', 'Coins'),
         coin_emoji = COALESCE(config->>'coin_emoji', '🪙')
       WHERE guild_id = $1`,
      [guildId]
    ).catch(() => {});

    // Invalidate activity tracker config cache to ensure immediate synchronization across systems
    try {
      const { invalidateConfigCache } = await import('../activity/index.js');
      invalidateConfigCache(guildId);
    } catch (_) {}

    return fullConfig;
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
