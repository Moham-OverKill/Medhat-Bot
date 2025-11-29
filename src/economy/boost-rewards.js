import { query, getPool } from '../storage/postgres.js';
import { sanitizeError } from '../shared.js';
import { logServerEvent } from '../utils/logger.js';

const BOOST_REWARD_AMOUNT = 500;
const BOOST_COOLDOWN_HOURS = 23; // Prevent rapid on/off farming

/**
 * Handle boost added event
 * Awards coins if this is a new boost or a renewal after cooldown
 */
export async function handleBoostAdded(userId, guild, username) {
  const guildId = typeof guild === 'string' ? guild : guild?.id;
  const pool = getPool();
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const now = new Date();
    
    // Check if user has an existing boost record
    const boostResult = await client.query(
      'SELECT * FROM server_boosts WHERE user_id = $1 AND guild_id = $2',
      [userId, guildId]
    );
    
    let shouldReward = false;
    let reason = '';
    
    if (boostResult.rows.length === 0) {
      // New boost - create record and reward
      await client.query(
        `INSERT INTO server_boosts (user_id, guild_id, boost_started_at, last_reward_at, is_active)
         VALUES ($1, $2, $3, $3, true)`,
        [userId, guildId, now]
      );
      shouldReward = true;
      reason = 'new boost';
    } else {
      const boostData = boostResult.rows[0];
      
      if (!boostData.is_active) {
        // Boost was removed and re-added
        const lastReward = boostData.last_reward_at ? new Date(boostData.last_reward_at) : null;
        const hoursSinceLastReward = lastReward 
          ? (now - lastReward) / (1000 * 60 * 60)
          : Infinity;
        
        if (hoursSinceLastReward >= BOOST_COOLDOWN_HOURS) {
          // Reactivate and reward if cooldown passed
          await client.query(
            `UPDATE server_boosts 
             SET is_active = true, 
                 boost_started_at = $1,
                 boost_count = boost_count + 1,
                 last_reward_at = $1,
                 updated_at = $1
             WHERE user_id = $2 AND guild_id = $3`,
            [now, userId, guildId]
          );
          shouldReward = true;
          reason = 're-boost after cooldown';
        } else {
          // Reactivate but don't reward (cooldown not passed)
          await client.query(
            `UPDATE server_boosts 
             SET is_active = true,
                 boost_started_at = $1,
                 updated_at = $1
             WHERE user_id = $2 AND guild_id = $3`,
            [now, userId, guildId]
          );
          reason = 're-boost within cooldown (no reward)';
        }
      } else {
        // Boost is already active (renewal)
        const lastReward = boostData.last_reward_at ? new Date(boostData.last_reward_at) : null;
        const hoursSinceLastReward = lastReward 
          ? (now - lastReward) / (1000 * 60 * 60)
          : Infinity;
        
        // Natural renewal - reward if enough time passed
        if (hoursSinceLastReward >= BOOST_COOLDOWN_HOURS) {
          await client.query(
            `UPDATE server_boosts 
             SET last_reward_at = $1,
                 boost_count = boost_count + 1,
                 updated_at = $1
             WHERE user_id = $2 AND guild_id = $3`,
            [now, userId, guildId]
          );
          shouldReward = true;
          reason = 'boost renewal';
        } else {
          reason = 'boost renewal within cooldown (no reward)';
        }
      }
    }
    
    let newBalance = 0;
    
    if (shouldReward) {
      // Get or create user balance
      const balanceResult = await client.query(
        `INSERT INTO user_balances (user_id, guild_id, balance)
         VALUES ($1, $2, 0)
         ON CONFLICT (user_id, guild_id) 
         DO UPDATE SET user_id = EXCLUDED.user_id
         RETURNING balance`,
        [userId, guildId]
      );
      
      const currentBalance = balanceResult.rows[0].balance;
      newBalance = currentBalance + BOOST_REWARD_AMOUNT;
      
      // Update balance
      await client.query(
        `UPDATE user_balances 
         SET balance = $1,
             total_earned = total_earned + $2,
             updated_at = NOW()
         WHERE user_id = $3 AND guild_id = $4`,
        [newBalance, BOOST_REWARD_AMOUNT, userId, guildId]
      );
      
      // Log transaction
      await client.query(
        `INSERT INTO transactions (user_id, guild_id, amount, balance_after, type, description)
         VALUES ($1, $2, $3, $4, 'boost_bonus', $5)`,
        [userId, guildId, BOOST_REWARD_AMOUNT, newBalance, `Server boost reward (${reason})`]
      );
    }
    
    await client.query('COMMIT');
    
    // Log: [ServerName] Username — Boost reward +500 coins
    if (shouldReward) {
      logServerEvent(guild, username, `Boost reward +${BOOST_REWARD_AMOUNT} coins`);
    }
    
    return {
      success: true,
      rewarded: shouldReward,
      amount: shouldReward ? BOOST_REWARD_AMOUNT : 0,
      balance: newBalance,
      reason
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Handle boost removed event
 */
export async function handleBoostRemoved(userId, guild, username) {
  const guildId = typeof guild === 'string' ? guild : guild?.id;
  try {
    await query(
      `UPDATE server_boosts 
       SET is_active = false,
           updated_at = NOW()
       WHERE user_id = $1 AND guild_id = $2`,
      [userId, guildId]
    );
    
    logServerEvent(guild, username, 'Boost removed');
    
    return { success: true };
  } catch (error) {
    throw error;
  }
}
