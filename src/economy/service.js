import { query, getPool } from '../storage/postgres.js';
import { sanitizeError } from '../shared.js';
import { formatDetailedTimeRemaining, getNextDailyTime } from '../utils/time.js';
import { logEvent, logError } from '../utils/logger.js';

/**
 * Get or create a user's balance
 */
export async function getUserBalance(userId, guildId) {
  try {
    const result = await query(
      'SELECT * FROM user_balances WHERE user_id = $1 AND guild_id = $2',
      [userId, guildId]
    );
    
    if (result.rows.length === 0) {
      // Create new balance entry
      const createResult = await query(
        `INSERT INTO user_balances (user_id, guild_id, balance)
         VALUES ($1, $2, 0)
         RETURNING *`,
        [userId, guildId]
      );
      return createResult.rows[0];
    }
    
    return result.rows[0];
  } catch (error) {
    logError('System', 'System', `Get user balance failed: ${sanitizeError(error)}`);
    throw error;
  }
}

/**
 * Update user balance and log transaction
 */
export async function updateBalance(userId, guildId, amount, type, description = null, referenceId = null) {
  const pool = getPool();
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Get current balance
    const balanceResult = await client.query(
      'SELECT balance FROM user_balances WHERE user_id = $1 AND guild_id = $2',
      [userId, guildId]
    );
    
    let currentBalance = 0;
    if (balanceResult.rows.length === 0) {
      // Create new balance entry
      await client.query(
        `INSERT INTO user_balances (user_id, guild_id, balance)
         VALUES ($1, $2, 0)`,
        [userId, guildId]
      );
    } else {
      currentBalance = balanceResult.rows[0].balance;
    }
    
    const newBalance = currentBalance + amount;
    
    // Prevent negative balances
    if (newBalance < 0) {
      await client.query('ROLLBACK');
      return { success: false, error: 'Insufficient balance', balance: currentBalance };
    }
    
    // Update balance
    await client.query(
      `UPDATE user_balances 
       SET balance = $1, 
           updated_at = NOW(),
           total_earned = total_earned + CASE WHEN $2 > 0 THEN $2 ELSE 0 END,
           total_spent = total_spent + CASE WHEN $2 < 0 THEN ABS($2) ELSE 0 END
       WHERE user_id = $3 AND guild_id = $4`,
      [newBalance, amount, userId, guildId]
    );
    
    // Log transaction
    await client.query(
      `INSERT INTO transactions (user_id, guild_id, amount, balance_after, type, description, reference_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, guildId, amount, newBalance, type, description, referenceId]
    );
    
    await client.query('COMMIT');
    
    return { success: true, balance: newBalance, amount };
  } catch (error) {
    await client.query('ROLLBACK');
    logError('System', 'System', `Update balance failed: ${sanitizeError(error)}`);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Claim daily coins
 */
export async function claimDaily(userId, guildId, username) {
  const pool = getPool();
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Get user balance info with row lock to prevent race conditions
    const userResult = await client.query(
      'SELECT * FROM user_balances WHERE user_id = $1 AND guild_id = $2 FOR UPDATE',
      [userId, guildId]
    );
    
    let userData;
    let isNewUser = false;
    
    if (userResult.rows.length === 0) {
      // Create new user
      const createResult = await client.query(
        `INSERT INTO user_balances (user_id, guild_id, balance, daily_streak)
         VALUES ($1, $2, 0, 0)
         RETURNING *`,
        [userId, guildId]
      );
      userData = createResult.rows[0];
      isNewUser = true;
    } else {
      userData = userResult.rows[0];
    }
    
    // Check if daily was already claimed today (24 hour cooldown)
    if (userData.last_claim_time) {
      const nextClaim = getNextDailyTime(userData.last_claim_time);
      const now = new Date();
      
      if (now < nextClaim) {
        await client.query('ROLLBACK');
        
        // Use consistent time formatting
        const detailedTime = formatDetailedTimeRemaining(nextClaim - now.getTime());
        
        return {
          success: false,
          error: 'daily_claimed',
          nextClaim,
          detailedTime
        };
      }
      
      // Check if streak continues (claimed within 48 hours)
      const lastDaily = new Date(userData.last_claim_time);
      const hoursSinceLastDaily = (now - lastDaily) / (1000 * 60 * 60);
      
      if (hoursSinceLastDaily <= 48) {
        userData.daily_streak += 1;
      } else {
        userData.daily_streak = 1;
      }
    } else {
      userData.daily_streak = 1;
    }
    
    // Calculate reward with streak bonus
    const baseReward = 25;
    // Bonus only applies from day 2 onwards: (streak - 1) * 5
    const streakBonus = userData.daily_streak > 1 ? (userData.daily_streak - 1) * 5 : 0;
    const totalReward = baseReward + streakBonus;
    
    // Update balance and streak
    const newBalance = userData.balance + totalReward;
    await client.query(
      `UPDATE user_balances 
       SET balance = $1,
           last_claim_time = NOW(),
           daily_streak = $2,
           total_earned = total_earned + $3,
           updated_at = NOW()
       WHERE user_id = $4 AND guild_id = $5`,
      [newBalance, userData.daily_streak, totalReward, userId, guildId]
    );
    
    // Log transaction
    await client.query(
      `INSERT INTO transactions (user_id, guild_id, amount, balance_after, type, description)
       VALUES ($1, $2, $3, $4, 'daily', $5)`,
      [
        userId,
        guildId,
        totalReward,
        newBalance,
        `Daily reward (Streak: ${userData.daily_streak})`
      ]
    );
    
    await client.query('COMMIT');

    // Log: [ServerName] Username — Daily claim +25 coins (streak 1, balance 36)
    logEvent(guildId, username || userId, `Daily claim +${totalReward} coins (streak ${userData.daily_streak}, balance ${newBalance})`);

    return {
      success: true,
      amount: totalReward,
      balance: newBalance,
      streak: userData.daily_streak,
      breakdown: {
        base: baseReward,
        streak: streakBonus
      },
      isNewUser
    };
  } catch (error) {
    await client.query('ROLLBACK');
    logError(guildId, username || userId, `Daily claim failed: ${sanitizeError(error)}`);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Get top richest users in a guild
 */
export async function getLeaderboard(guildId, limit = 10) {
  try {
    const result = await query(
      `SELECT user_id, balance, daily_streak, total_earned, total_spent
       FROM user_balances
       WHERE guild_id = $1
       ORDER BY balance DESC
       LIMIT $2`,
      [guildId, limit]
    );
    
    return result.rows;
  } catch (error) {
    logError(guildId, 'System', `Get leaderboard failed: ${sanitizeError(error)}`);
    return [];
  }
}

/**
 * Get user's transaction history
 */
export async function getTransactionHistory(userId, guildId, limit = 10) {
  try {
    const result = await query(
      `SELECT * FROM transactions
       WHERE user_id = $1 AND guild_id = $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [userId, guildId, limit]
    );
    
    return result.rows;
  } catch (error) {
    logError(guildId, userId, `Get transaction history failed: ${sanitizeError(error)}`);
    return [];
  }
}

/**
 * Transfer coins between users
 */
export async function transferCoins(fromUserId, toUserId, guild, amount, fromUsername = null, toUsername = null) {
  const guildId = typeof guild === 'string' ? guild : guild?.id;
  const pool = getPool();
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Validate amount
    if (amount <= 0) {
      await client.query('ROLLBACK');
      return { success: false, error: 'Invalid amount' };
    }
    
    // Get sender balance
    const senderResult = await client.query(
      'SELECT balance FROM user_balances WHERE user_id = $1 AND guild_id = $2',
      [fromUserId, guildId]
    );
    
    if (senderResult.rows.length === 0 || senderResult.rows[0].balance < amount) {
      await client.query('ROLLBACK');
      return { success: false, error: 'Insufficient balance' };
    }
    
    const senderNewBalance = senderResult.rows[0].balance - amount;
    
    // Deduct from sender
    await client.query(
      `UPDATE user_balances 
       SET balance = $1, updated_at = NOW(), total_spent = total_spent + $2
       WHERE user_id = $3 AND guild_id = $4`,
      [senderNewBalance, amount, fromUserId, guildId]
    );
    
    // Add to receiver (create if doesn't exist)
    await client.query(
      `INSERT INTO user_balances (user_id, guild_id, balance, total_earned)
       VALUES ($1, $2, $3, $3)
       ON CONFLICT (user_id, guild_id) 
       DO UPDATE SET 
         balance = user_balances.balance + $3,
         total_earned = user_balances.total_earned + $3,
         updated_at = NOW()`,
      [toUserId, guildId, amount]
    );
    
    // Get receiver's new balance
    const receiverResult = await client.query(
      'SELECT balance FROM user_balances WHERE user_id = $1 AND guild_id = $2',
      [toUserId, guildId]
    );
    const receiverNewBalance = receiverResult.rows[0].balance;
    
    // Log transactions
    await client.query(
      `INSERT INTO transactions (user_id, guild_id, amount, balance_after, type, description, reference_id)
       VALUES ($1, $2, $3, $4, 'transfer_out', $5, $6)`,
      [fromUserId, guildId, -amount, senderNewBalance, `Transfer to ${toUserId}`, toUserId]
    );
    
    await client.query(
      `INSERT INTO transactions (user_id, guild_id, amount, balance_after, type, description, reference_id)
       VALUES ($1, $2, $3, $4, 'transfer_in', $5, $6)`,
      [toUserId, guildId, amount, receiverNewBalance, `Transfer from ${fromUserId}`, fromUserId]
    );
    
    await client.query('COMMIT');

    // Log: [ServerName] Username — Sent 5 coins to Shadow
    logEvent(guild, fromUsername || fromUserId, `Sent ${amount} coins to ${toUsername || toUserId}`);

    return {
      success: true,
      amount,
      senderBalance: senderNewBalance,
      receiverBalance: receiverNewBalance
    };
  } catch (error) {
    await client.query('ROLLBACK');
    logError(guild, fromUsername || fromUserId, `Transfer failed: ${sanitizeError(error)}`);
    throw error;
  } finally {
    client.release();
  }
}
