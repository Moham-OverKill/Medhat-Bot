import { query, getPool } from '../storage/postgres.js';
import { sanitizeError } from '../shared.js';
import { updateBalance } from './service.js';
import { createRefund, getBoosterLossPolicy } from '../storage/audit.js';
import { isMemberBooster } from '../commands/colors.js';
import { logServerEvent, logSystemError, logAudit } from '../utils/logger.js';

/**
 * Get all shop categories for a guild
 */
export async function getShopCategories(guildId) {
  try {
    const result = await query(
      `SELECT * FROM shop_categories 
       WHERE guild_id = $1
       ORDER BY display_order, name ASC`,
      [guildId]
    );
    
    return result.rows;
  } catch (error) {
    logSystemError(`Failed to get shop categories for guild ${guildId}: ${sanitizeError(error)}`);
    return [];
  }
}

/**
 * Get all active shop items for a guild
 */
export async function getShopItems(guildId, categoryId = null) {
  try {
    let sql = `SELECT si.*, sc.name as category_name 
               FROM shop_items si
               LEFT JOIN shop_categories sc ON si.category_id = sc.id
               WHERE si.guild_id = $1 AND si.is_active = true`;
    const params = [guildId];
    
    if (categoryId !== null) {
      sql += ' AND si.category_id = $2';
      params.push(categoryId);
    }
    
    sql += ' ORDER BY si.price ASC';
    
    const result = await query(sql, params);
    
    return result.rows;
  } catch (error) {
    logSystemError(`Failed to get shop items for guild ${guildId}: ${sanitizeError(error)}`);
    return [];
  }
}

/**
 * Get a specific shop item
 */
export async function getShopItem(itemId) {
  try {
    const result = await query(
      'SELECT * FROM shop_items WHERE id = $1',
      [itemId]
    );
    
    return result.rows[0] || null;
  } catch (error) {
    logSystemError(`Failed to get shop item: ${sanitizeError(error)}`);
    return null;
  }
}

/**
 * Add a new item to the shop
 */
export async function addShopItem(guildId, roleId, name, description, price, itemType, durationHours = null, stock = null) {
  try {
    const result = await query(
      `INSERT INTO shop_items (guild_id, role_id, name, description, price, item_type, duration_hours, stock)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [guildId, roleId, name, description, price, itemType, durationHours, stock]
    );
    
    return result.rows[0];
  } catch (error) {
    logSystemError(`Failed to add shop item for guild ${guildId}: ${sanitizeError(error)}`);
    throw error;
  }
}

/**
 * Update a shop item
 */
export async function updateShopItem(itemId, updates) {
  try {
    const allowedFields = ['name', 'description', 'price', 'duration_hours', 'stock', 'is_active'];
    const setClauses = [];
    const values = [];
    let paramIndex = 1;
    
    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key)) {
        setClauses.push(`${key} = $${paramIndex}`);
        values.push(value);
        paramIndex++;
      }
    }
    
    if (setClauses.length === 0) {
      throw new Error('No valid fields to update');
    }
    
    setClauses.push(`updated_at = NOW()`);
    values.push(itemId);
    
    const result = await query(
      `UPDATE shop_items SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values
    );
    
    return result.rows[0];
  } catch (error) {
    logSystemError(`Failed to update shop item ${itemId}: ${sanitizeError(error)}`);
    throw error;
  }
}

/**
 * Delete/deactivate a shop item
 */
export async function deleteShopItem(itemId) {
  try {
    await query(
      'UPDATE shop_items SET is_active = false, updated_at = NOW() WHERE id = $1',
      [itemId]
    );
    
    return true;
  } catch (error) {
    logSystemError(`Failed to delete shop item ${itemId}: ${sanitizeError(error)}`);
    return false;
  }
}

/**
 * Purchase an item from the shop - COMPREHENSIVE EDGE CASE HANDLING
 * 
 * This function handles all edge cases including:
 * - Role validation before purchase
 * - Duplicate ownership checks
 * - Booster-only requirements
 * - Atomic transactions with automatic refunds on failure
 * - Comprehensive audit logging
 */
export async function purchaseItem(userId, guildId, itemId, member) {
  const pool = getPool();
  const client = await pool.connect();
  let transactionId = null;
  let coinsDeducted = false;
  
  try {
    await client.query('BEGIN');
    
    // ========== STEP 1: Validate Shop Item ==========
    const itemResult = await client.query(
      'SELECT * FROM shop_items WHERE id = $1 AND guild_id = $2',
      [itemId, guildId]
    );
    
    if (itemResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: 'Item not found' };
    }
    
    const item = itemResult.rows[0];
    
    // Check if item is active
    if (!item.is_active) {
      await client.query('ROLLBACK');
      return { success: false, error: 'This item is no longer available for purchase' };
    }
    
    // Check if role is valid (not deleted from server)
    if (!item.role_valid) {
      await client.query('ROLLBACK');
      return { 
        success: false, 
        error: 'This item is temporarily unavailable (role not found on server)' 
      };
    }
    
    // Check stock
    if (item.stock !== null && item.stock <= 0) {
      await client.query('ROLLBACK');
      return { success: false, error: 'Item out of stock' };
    }
    
    // ========== STEP 2: Verify Role Exists on Discord Server ==========
    let role;
    try {
      role = await member.guild.roles.fetch(item.role_id);
      if (!role) {
        // Role doesn't exist - mark item as invalid
        await client.query(
          'UPDATE shop_items SET role_valid = false, role_invalid_since = NOW(), is_active = false WHERE id = $1',
          [itemId]
        );
        await client.query('ROLLBACK');
        
        await logAudit(guildId, 'system', 'role_invalidated', 'shop_item', itemId.toString(), {
          itemName: item.name,
          roleId: item.role_id,
          reason: 'Role not found during purchase attempt'
        });
        
        return { 
          success: false, 
          error: 'This item is no longer available (role deleted from server)' 
        };
      }
    } catch (roleError) {
      await client.query('ROLLBACK');
      return { 
        success: false, 
        error: 'Unable to verify role availability. Please try again later.' 
      };
    }
    
    // ========== STEP 3: Check if User Already Has Role ==========
    const hasRole = member.roles.cache.has(item.role_id);
    
    // Check if user already owns this in inventory (for non-temporary items)
    if (!item.duration_hours) {
      const existingResult = await client.query(
        'SELECT * FROM user_inventory WHERE user_id = $1 AND guild_id = $2 AND role_id = $3 AND is_active = true',
        [userId, guildId, item.role_id]
      );
      
      if (existingResult.rows.length > 0 || hasRole) {
        await client.query('ROLLBACK');
        return { 
          success: false, 
          error: 'You already own this item',
          alreadyOwned: true 
        };
      }
    }
    
    // ========== STEP 4: Check Booster Requirements ==========
    if (item.booster_only) {
      const isBooster = await isMemberBooster(member, guildId);
      if (!isBooster) {
        await client.query('ROLLBACK');
        return { 
          success: false, 
          error: 'This item is only available to server boosters',
          requiresBooster: true
        };
      }
    }
    
    // ========== STEP 5: Verify User Balance ==========
    const balanceResult = await client.query(
      'SELECT balance FROM user_balances WHERE user_id = $1 AND guild_id = $2 FOR UPDATE',
      [userId, guildId]
    );
    
    if (balanceResult.rows.length === 0) {
      // Create balance entry
      await client.query(
        'INSERT INTO user_balances (user_id, guild_id, balance) VALUES ($1, $2, 0)',
        [userId, guildId]
      );
    }
    
    const currentBalance = balanceResult.rows[0]?.balance || 0;
    
    if (currentBalance < item.price) {
      await client.query('ROLLBACK');
      return { 
        success: false, 
        error: 'Insufficient balance',
        required: item.price,
        current: currentBalance,
        shortfall: item.price - currentBalance
      };
    }
    
    // ========== STEP 6: Deduct Coins (TRANSACTION STARTS) ==========
    const newBalance = currentBalance - item.price;
    await client.query(
      `UPDATE user_balances 
       SET balance = $1, total_spent = total_spent + $2, updated_at = NOW()
       WHERE user_id = $3 AND guild_id = $4`,
      [newBalance, item.price, userId, guildId]
    );
    coinsDeducted = true;
    
    // Log transaction
    const transactionResult = await client.query(
      `INSERT INTO transactions (user_id, guild_id, amount, balance_after, type, description, reference_id)
       VALUES ($1, $2, $3, $4, 'purchase', $5, $6)
       RETURNING id`,
      [userId, guildId, -item.price, newBalance, `Purchased: ${item.name}`, itemId.toString()]
    );
    transactionId = transactionResult.rows[0].id;
    
    // ========== STEP 7: Add to Inventory ==========
    const expiresAt = item.duration_hours 
      ? new Date(Date.now() + item.duration_hours * 60 * 60 * 1000)
      : null;
    
    await client.query(
      `INSERT INTO user_inventory (
        user_id, guild_id, shop_item_id, role_id, expires_at, 
        purchase_source, requires_booster
      )
       VALUES ($1, $2, $3, $4, $5, 'shop', $6)`,
      [userId, guildId, itemId, item.role_id, expiresAt, item.booster_only || false]
    );
    
    // ========== STEP 8: Update Stock ==========
    if (item.stock !== null) {
      await client.query(
        'UPDATE shop_items SET stock = stock - 1, updated_at = NOW() WHERE id = $1',
        [itemId]
      );
    }
    
    // ========== STEP 9: Grant Role to User ==========
    let roleGranted = false;
    let roleError = null;
    
    try {
      await member.roles.add(role);
      roleGranted = true;
    } catch (error) {
      roleError = error;
      logSystemError(`Failed to grant role for user ${userId} in guild ${guildId}: ${sanitizeError(error)}`);
      
      // CRITICAL: Role assignment failed - initiate refund
      await client.query('ROLLBACK');
      
      // Issue automatic refund
      const username = member?.user?.username || member?.displayName || null;
      try {
        await createRefund(
          userId,
          guildId,
          item.price,
          `Role assignment failed for item: ${item.name}`,
          transactionId,
          itemId,
          username
        );
        
        await logAudit(guildId, userId, 'purchase_failed_refunded', 'shop_item', itemId.toString(), {
          itemName: item.name,
          price: item.price,
          reason: 'Role assignment failure',
          errorDetails: sanitizeError(roleError)
        });
        
        return { 
          success: false, 
          error: 'Failed to assign role. Your coins have been refunded.',
          refunded: true,
          refundAmount: item.price
        };
      } catch (refundError) {
        logSystemError(`Failed to refund after role assignment failure for user ${userId} in guild ${guildId}: ${sanitizeError(refundError)}`);
        
        await logAudit(guildId, userId, 'purchase_failed_refund_failed', 'shop_item', itemId.toString(), {
          itemName: item.name,
          price: item.price,
          reason: 'Role assignment failure + refund failure',
          requiresAdminAction: true
        });
        
        return { 
          success: false, 
          error: 'Failed to assign role and process refund. Please contact an administrator.',
          requiresAdminAction: true
        };
      }
    }
    
    // ========== STEP 10: Commit Transaction ==========
    await client.query('COMMIT');
    
    // ========== STEP 11: Log Audit Entry ==========
    await logAudit(guildId, userId, 'shop_purchase', 'shop_item', itemId.toString(), {
      itemName: item.name,
      price: item.price,
      newBalance,
      roleId: item.role_id,
      boosterOnly: item.booster_only || false
    });

    // Log: [ServerName] Username — Bought Blue Color (50 coins)
    const username = member?.user?.username || member?.displayName || 'Unknown';
    logServerEvent(member.guild, username, `Bought ${item.name} (${item.price} coins)`);

    return {
      success: true,
      item,
      newBalance,
      previousBalance: currentBalance,
      expiresAt,
      roleGranted
    };
    
  } catch (error) {
    await client.query('ROLLBACK');
    logSystemError(`Purchase error for user ${userId} in guild ${guildId}: ${sanitizeError(error)}`);
    
    // If coins were deducted, attempt refund
    if (coinsDeducted && transactionId) {
      const username = member?.user?.username || member?.displayName || null;
      try {
        await createRefund(
          userId,
          guildId,
          itemResult.rows[0]?.price || 0,
          `Purchase error: ${sanitizeError(error).message}`,
          transactionId,
          itemId,
          username
        );
        
        return { 
          success: false, 
          error: 'Purchase failed. Your coins have been refunded.',
          refunded: true
        };
      } catch (refundError) {
        logSystemError(`Failed to refund after purchase error for user ${userId} in guild ${guildId}: ${sanitizeError(refundError)}`);
        return { 
          success: false, 
          error: 'Purchase failed. Please contact an administrator for a refund.',
          requiresAdminAction: true
        };
      }
    }
    
    return { 
      success: false, 
      error: 'Purchase failed. Please try again later.' 
    };
  } finally {
    client.release();
  }
}

/**
 * Get user's active inventory items
 */
export async function getUserInventory(userId, guildId) {
  try {
    const result = await query(
      `SELECT i.*, s.name, s.description, s.item_type, s.role_id
       FROM user_inventory i
       LEFT JOIN shop_items s ON i.shop_item_id = s.id
       WHERE i.user_id = $1 AND i.guild_id = $2 AND i.is_active = true
       ORDER BY i.purchased_at DESC`,
      [userId, guildId]
    );
    
    return result.rows;
  } catch (error) {
    logSystemError(`Failed to get user inventory for user ${userId} in guild ${guildId}: ${sanitizeError(error)}`);
    return [];
  }
}

/**
 * Check and remove expired items
 */
export async function cleanupExpiredItems(client) {
  try {
    // Get all expired items
    const expiredResult = await query(
      `SELECT i.*, m.guild_id, m.user_id
       FROM user_inventory i
       WHERE i.expires_at IS NOT NULL 
       AND i.expires_at < NOW() 
       AND i.is_active = true`,
      []
    );
    
    // Deactivate expired items
    if (expiredResult.rows.length > 0) {
      await query(
        `UPDATE user_inventory 
         SET is_active = false 
         WHERE expires_at IS NOT NULL 
         AND expires_at < NOW() 
         AND is_active = true`,
        []
      );
      
      logSystem(`Cleaned up ${expiredResult.rows.length} expired inventory items`);
    }
    
    return expiredResult.rows;
  } catch (error) {
    logSystemError(`Failed to clean up expired items: ${sanitizeError(error)}`);
    return [];
  }
}
