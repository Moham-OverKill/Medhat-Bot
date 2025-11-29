import { query, getPool } from '../storage/postgres.js';
import { sanitizeError } from '../shared.js';
import { logServerEvent } from '../utils/logger.js';

const DEFAULT_MVP_REWARD = 100;

/**
 * Award coins to MVP winner
 */
export async function awardMvpCoins(userId, guild, username, customAmount = null) {
  const guildId = typeof guild === 'string' ? guild : guild?.id;
  const pool = getPool();
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const rewardAmount = customAmount !== null ? customAmount : DEFAULT_MVP_REWARD;
    
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
    const newBalance = currentBalance + rewardAmount;
    
    // Update balance
    await client.query(
      `UPDATE user_balances 
       SET balance = $1,
           total_earned = total_earned + $2,
           updated_at = NOW()
       WHERE user_id = $3 AND guild_id = $4`,
      [newBalance, rewardAmount, userId, guildId]
    );
    
    // Log transaction
    await client.query(
      `INSERT INTO transactions (user_id, guild_id, amount, balance_after, type, description)
       VALUES ($1, $2, $3, $4, 'mvp_bonus', $5)`,
      [userId, guildId, rewardAmount, newBalance, 'MVP of the Day reward']
    );
    
    await client.query('COMMIT');
    
    // No log here - logged in award.js to consolidate into single line
    
    return {
      success: true,
      amount: rewardAmount,
      balance: newBalance
    };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error awarding MVP coins:', sanitizeError(error));
    throw error;
  } finally {
    client.release();
  }
}
