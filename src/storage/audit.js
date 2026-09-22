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
  const safeAmount = Math.max(0, parseInt(amount, 10) || 0);
  
  try {
    await client.query('BEGIN');
    
    // 1. Refund Balance (Atomic Upsert)
    const refundRes = await client.query(
      `INSERT INTO user_balances (user_id, guild_id, balance, total_earned)
       VALUES ($1, $2, $3, $3)
       ON CONFLICT (user_id, guild_id) DO UPDATE
       SET balance = user_balances.balance + $3, total_earned = user_balances.total_earned + $3, updated_at = NOW()
       RETURNING balance`,
      [userId, guildId, safeAmount]
    );

    const balanceAfter = parseInt(refundRes.rows[0]?.balance || safeAmount, 10);
    
    // 2. Log Refund Transaction
    await client.query(
      `INSERT INTO transactions (
        user_id, guild_id, amount, balance_after, type, description, reference_id
      ) VALUES ($1, $2, $3, $4, 'refund', $5, $6)`,
      [userId, guildId, safeAmount, balanceAfter, `Refund: ${reason}`, originalTransactionId]
    );
    
    // 3. Log Audit
    await client.query(
      `INSERT INTO audit_logs (
        guild_id, user_id, action_type, target_type, target_id, details, created_at
      ) VALUES ($1, $2, 'refund', 'transaction', $3, $4, NOW())`,
      [guildId, userId, originalTransactionId, JSON.stringify({ amount: safeAmount, reason, itemId })]
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
// D-05 FIX: Removed dead function getBoosterLossPolicy (placeholder, never called)
