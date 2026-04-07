import { query } from './postgres.js';
import { sanitizeError } from '../shared.js';
import { logSystemError } from '../utils/logger.js';

/**
 * Log a significant financial or system event
 */
export async function logAudit(guildId, userId, actionType, targetType, targetId, details = {}) {
  try {
    await query(
      `INSERT INTO audit_logs (
        guild_id, user_id, action_type, target_type, target_id, details, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [guildId, userId, actionType, targetType, targetId, JSON.stringify(details)]
    );
  } catch (error) {
    logSystemError(`Failed to log audit: ${sanitizeError(error)}`);
  }
}

/**
 * Process an automated refund
 */
export async function createRefund(userId, guildId, amount, reason, originalTransactionId, itemId, username = null) {
  const pool = (await import('./postgres.js')).getPool();
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // 1. Refund Balance
    await client.query(
      `UPDATE user_balances 
       SET balance = balance + $1, updated_at = NOW() 
       WHERE user_id = $2 AND guild_id = $3`,
      [amount, userId, guildId]
    );
    
    // 2. Log Refund Transaction
    await client.query(
      `INSERT INTO transactions (
        user_id, guild_id, amount, balance_after, type, description, reference_id
      ) VALUES ($1, $2, $3, 
        (SELECT balance FROM user_balances WHERE user_id = $1 AND guild_id = $2),
        'refund', $4, $5
      )`,
      [userId, guildId, amount, `Refund: ${reason}`, originalTransactionId]
    );
    
    // 3. Log Audit
    await client.query(
      `INSERT INTO audit_logs (
        guild_id, user_id, action_type, target_type, target_id, details, created_at
      ) VALUES ($1, $2, 'refund', 'transaction', $3, $4, NOW())`,
      [guildId, userId, originalTransactionId, JSON.stringify({ amount, reason, itemId })]
    );
    
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Get booster loss policy (placeholder for now)
 */
export async function getBoosterLossPolicy(guildId) {
  // In the future, this could fetch from guild_configs
  return {
    action: 'remove_role', // 'remove_role', 'keep_role', 'grace_period'
    gracePeriodHours: 24
  };
}
