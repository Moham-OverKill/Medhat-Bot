import { query } from './postgres.js';
import { sanitizeError } from '../shared.js';
import { logAudit } from '../utils/logger.js';

/**
 * Audit and refund system for shop purchases
 */

/**
 * Log an audit event to database and console
 * @param {string} action - Action performed
 * @param {Object} data - Audit data
 */
export function logAuditEvent(action, data = {}) {
  logAudit(action, data);
  
  // Optionally persist to database
  // For now, just console logging is sufficient
}

/**
 * Create a refund for a user
 * @param {string} userId - User ID
 * @param {string} guildId - Guild ID
 * @param {number} amount - Refund amount
 * @param {string} reason - Refund reason
 * @param {string} referenceId - Reference to original transaction
 * @returns {Promise<Object>} Refund result
 */
export async function createRefund(userId, guildId, amount, reason, referenceId = null) {
  try {
    // Import updateBalance to avoid circular dependency
    const { updateBalance } = await import('../economy/service.js');
    
    const result = await updateBalance(
      userId,
      guildId,
      amount,
      'refund',
      reason,
      referenceId
    );
    
    logAuditEvent('REFUND_CREATED', {
      userId,
      guildId,
      amount,
      reason,
      referenceId,
      success: result.success
    });
    
    return result;
  } catch (error) {
    console.error('Failed to create refund:', sanitizeError(error));
    throw error;
  }
}

/**
 * Get booster loss policy for a guild
 * @param {string} guildId - Guild ID
 * @returns {Promise<string>} Policy: 'refund', 'keep', or 'remove'
 */
export async function getBoosterLossPolicy(guildId) {
  try {
    // Check guild config for custom policy
    const { getGuildConfig } = await import('./config.js');
    const config = await getGuildConfig(guildId);
    
    // Default policy is to refund booster-only items when boost is lost
    return config.boosterLossPolicy || 'refund';
  } catch (error) {
    console.error('Failed to get booster loss policy:', sanitizeError(error));
    return 'refund'; // Safe default
  }
}

/**
 * Handle booster loss - refund or remove booster-only items
 * @param {string} userId - User ID
 * @param {string} guildId - Guild ID
 * @returns {Promise<Object>} Result { itemsRefunded: number, coinsRefunded: number }
 */
export async function handleBoosterLoss(userId, guildId) {
  try {
    const policy = await getBoosterLossPolicy(guildId);
    
    if (policy === 'keep') {
      // User keeps items even after losing boost
      return { itemsRefunded: 0, coinsRefunded: 0 };
    }
    
    // Get user's booster-only items
    const inventoryResult = await query(
      `SELECT ui.id, ui.item_id, ui.quantity, si.name, si.price
       FROM user_inventory ui
       JOIN shop_items si ON ui.item_id = si.id
       WHERE ui.user_id = $1 AND ui.guild_id = $2 AND si.requires_booster = true`,
      [userId, guildId]
    );
    
    if (inventoryResult.rows.length === 0) {
      return { itemsRefunded: 0, coinsRefunded: 0 };
    }
    
    let totalRefund = 0;
    let itemsRefunded = 0;
    
    if (policy === 'refund') {
      // Refund the items
      for (const item of inventoryResult.rows) {
        const refundAmount = item.price * item.quantity;
        totalRefund += refundAmount;
        itemsRefunded += item.quantity;
        
        // Remove from inventory
        await query(
          'DELETE FROM user_inventory WHERE id = $1',
          [item.id]
        );
      }
      
      if (totalRefund > 0) {
        await createRefund(
          userId,
          guildId,
          totalRefund,
          `Automatic refund: Lost server booster status (${itemsRefunded} item${itemsRefunded !== 1 ? 's' : ''})`,
          'booster_loss'
        );
      }
    } else if (policy === 'remove') {
      // Just remove items without refund
      for (const item of inventoryResult.rows) {
        itemsRefunded += item.quantity;
        await query(
          'DELETE FROM user_inventory WHERE id = $1',
          [item.id]
        );
      }
    }
    
    logAuditEvent('BOOSTER_LOSS_HANDLED', {
      userId,
      guildId,
      policy,
      itemsRefunded,
      coinsRefunded: totalRefund
    });
    
    return { itemsRefunded, coinsRefunded: totalRefund };
    
  } catch (error) {
    console.error('Failed to handle booster loss:', sanitizeError(error));
    throw error;
  }
}
