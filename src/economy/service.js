import { query, getPool } from '../storage/postgres.js';
import { sanitizeError, COIN_EMOJI } from '../shared.js';
import { formatDetailedTimeRemaining, getNextCairoMidnight, hasClaimedToday, isStreakValid } from '../utils/time.js';
import { sendLog, logServerEvent, logServerError } from '../utils/logger.js';
import { getGuildConfig } from '../storage/config.js';

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
    console.error(`Get balance failed:`, sanitizeError(error));
    throw error;
  }
}

/**
 * Update user balance and log transaction
 */
export async function updateBalance(userId, guildId, amount, type, description = null, referenceId = null) {
  const pool = getPool();
  const client = await pool.connect();

  // Ensure amount is a proper integer to avoid PostgreSQL type issues
  const numericAmount = parseInt(amount, 10);

  try {
    await client.query('BEGIN');

    // Atomic upsert to handle balance update safely without race conditions or type issues
    const result = await client.query(
      `INSERT INTO user_balances (user_id, guild_id, balance, total_earned, total_spent)
       VALUES ($1, $2, $3::bigint, 
               CASE WHEN $3::bigint > 0 THEN $3::bigint ELSE 0 END, 
               CASE WHEN $3::bigint < 0 THEN ABS($3::bigint) ELSE 0 END
       )
       ON CONFLICT (user_id, guild_id) DO UPDATE
       SET balance = user_balances.balance + $3::bigint,
           updated_at = NOW(),
           total_earned = user_balances.total_earned + CASE WHEN $3::bigint > 0 THEN $3::bigint ELSE 0 END,
           total_spent = user_balances.total_spent + CASE WHEN $3::bigint < 0 THEN ABS($3::bigint) ELSE 0 END
       RETURNING balance`,
      [userId, guildId, numericAmount]
    );

    const newBalance = parseInt(result.rows[0].balance);

    // Prevent negative balances
    if (newBalance < 0) {
      await client.query('ROLLBACK');
      // Calculate what the balance was before the failed deduction for the error message
      const originalBalance = newBalance - numericAmount;
      return { success: false, error: 'Insufficient balance', balance: originalBalance };
    }

    // Log transaction
    await client.query(
      `INSERT INTO transactions (user_id, guild_id, amount, balance_after, type, description, reference_id)
       VALUES ($1, $2, $3::bigint, $4, $5, $6, $7)`,
      [userId, guildId, numericAmount, newBalance, type, description, referenceId]
    );

    await client.query('COMMIT');

    return { success: true, balance: newBalance, amount };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`Update balance failed:`, sanitizeError(error));
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Claim daily coins (STATIC CAIRO MIDNIGHT RESET)
 * - Can only claim once per calendar day (Cairo time)
 * - Streak continues if claimed yesterday
 * - Streak resets to 0 if last claim is older than yesterday
 */
export async function claimDaily(userId, guildId, username, isBooster = false) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Get user balance info
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

    // ========== STATIC CAIRO MIDNIGHT RESET LOGIC ==========

    // Check if already claimed TODAY (Cairo time)
    if (hasClaimedToday(userData.last_daily)) {
      await client.query('ROLLBACK');

      const nextClaim = getNextCairoMidnight();
      const detailedTime = formatDetailedTimeRemaining(nextClaim);

      return {
        success: false,
        error: 'daily_claimed',
        nextClaim,
        detailedTime
      };
    }

    // Check if streak is still valid (claimed yesterday or today)
    // If last claim is older than yesterday -> reset streak to 0
    let currentStreak = parseInt(userData.daily_streak, 10) || 0;

    if (!isStreakValid(userData.last_daily)) {
      // Streak is broken - reset to 0
      currentStreak = 0;
    }
    // else: Streak continues from current value

    // --- 2. Calculate Reward (BEFORE Increment) ---
    const config = await getGuildConfig(guildId) || {};
    const baseReward = 25;

    // Use configured values.
    const streakBonusPerDay = config.daily_streak_bonus !== undefined ? parseInt(config.daily_streak_bonus, 10) : 5;
    const boosterMultiplier = config.booster_multiplier !== undefined ? parseFloat(config.booster_multiplier) : 2;

    // Streak Bonus = Current Streak * Bonus Per Day
    // Example: Day 1 (Streak 0) -> 0 * 5 = 0
    // Example: Day 2 (Streak 1) -> 1 * 5 = 5
    const streakBonus = currentStreak * streakBonusPerDay;

    const subtotal = baseReward + streakBonus;

    // Apply Booster Multiplier to Subtotal
    const effectiveMultiplier = (isBooster && boosterMultiplier > 1) ? boosterMultiplier : 1;
    const totalReward = Math.floor(subtotal * effectiveMultiplier);

    // Calculate Boost Bonus (for display only)
    const boostBonus = totalReward - subtotal;

    // --- 3. Increment Streak (AFTER Calculation) ---
    const newStreak = currentStreak + 1;

    // Atomic Update balance and streak
    const updateResult = await client.query(
      `UPDATE user_balances 
       SET balance = balance + $1,
           last_daily = NOW(),
           daily_streak = $2,
           total_earned = total_earned + $1,
           updated_at = NOW()
       WHERE user_id = $3 AND guild_id = $4
       RETURNING balance`,
      [totalReward, newStreak, userId, guildId]
    );

    const newBalance = parseInt(updateResult.rows[0].balance, 10);

    // Log transaction
    await client.query(
      `INSERT INTO transactions (user_id, guild_id, amount, balance_after, type, description)
       VALUES ($1, $2, $3, $4, 'daily', $5)`,
      [
        userId,
        guildId,
        totalReward,
        newBalance,
        `Daily reward (Streak: ${newStreak})${boostBonus > 0 ? ` [Boost +${boostBonus}]` : ''}`
      ]
    );

    await client.query('COMMIT');

    // No log for daily claim to reduce noise

    return {
      success: true,
      amount: totalReward,
      balance: newBalance,
      streak: newStreak,
      breakdown: {
        base: baseReward,
        streakBonus: streakBonus,
        subtotal: subtotal,
        multiplier: effectiveMultiplier,
        isBooster: isBooster,
        boostBonus: boostBonus
      },
      isNewUser
    };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`Daily claim failed:`, sanitizeError(error));
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
    console.error(`Leaderboard failed:`, sanitizeError(error));
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
    console.error(`Transaction history failed:`, sanitizeError(error));
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

    // Validate amount (Integer check)
    if (!Number.isInteger(amount) || amount <= 0) {
      await client.query('ROLLBACK');
      return { success: false, error: 'Invalid amount' };
    }

    // Atomic Deduct from sender (Prevent negative balance)
    const senderUpdate = await client.query(
      `UPDATE user_balances 
       SET balance = balance - $1, 
           updated_at = NOW(), 
           total_spent = total_spent + $1
       WHERE user_id = $2 AND guild_id = $3 AND balance >= $1
       RETURNING balance`,
      [amount, fromUserId, guildId]
    );

    if (senderUpdate.rowCount === 0) {
      // Check if user exists or just has insufficient funds
      const checkUser = await client.query('SELECT balance FROM user_balances WHERE user_id = $1 AND guild_id = $2', [fromUserId, guildId]);
      await client.query('ROLLBACK');

      if (checkUser.rowCount === 0) {
        return { success: false, error: 'Insufficient balance' };
      } else {
        return { success: false, error: 'Insufficient balance' };
      }
    }

    const senderNewBalance = parseInt(senderUpdate.rows[0].balance, 10);

    // Atomic Add to receiver (Upsert)
    const receiverUpdate = await client.query(
      `INSERT INTO user_balances (user_id, guild_id, balance, total_earned)
       VALUES ($1, $2, $3, $3)
       ON CONFLICT (user_id, guild_id) 
       DO UPDATE SET 
         balance = user_balances.balance + $3,
         total_earned = user_balances.total_earned + $3,
         updated_at = NOW()
       RETURNING balance`,
      [toUserId, guildId, amount]
    );

    const receiverNewBalance = parseInt(receiverUpdate.rows[0].balance, 10);

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

    const logName = fromUsername || fromUserId;
    sendLog(guild, 'economy', 'blue', '💸 Bank Transfer', `**${logName}** sent **${amount.toLocaleString()}** ${COIN_EMOJI} to **<@${toUserId}>**`);

    return {
      success: true,
      amount,
      senderBalance: senderNewBalance,
      receiverBalance: receiverNewBalance
    };
  } catch (error) {
    await client.query('ROLLBACK');
    logServerError(guild, fromUsername || fromUserId, `Transfer failed: ${sanitizeError(error)}`);
    throw error;
  } finally {
    client.release();
  }
}
