import { query, getPool } from '../storage/postgres.js';
export { query };
import { sanitizeError, COIN_EMOJI, getUserLogName } from '../shared.js';
import { updateBalance } from './service.js';
import { logAudit, createRefund, getBoosterLossPolicy } from '../storage/audit.js';
import { isMemberBooster } from '../commands/colors.js';
import { logServerEvent, logSystemError, sendLog, sendBulkLog } from '../utils/logger.js';

/**
 * Validate that a role ID is not already linked to another shop item
 * @param {string} guildId - The guild ID
 * @param {string} roleId - The role ID to check
 * @param {number|null} currentItemId - If editing, exclude this item from the check
 * @returns {Promise<{valid: boolean, existingItem: object|null}>}
 */
export async function validateRoleUniqueness(guildId, roleId, currentItemId = null) {
  try {
    let queryStr = `SELECT id, name FROM shop_items WHERE guild_id = $1 AND role_id = $2`;
    const params = [guildId, roleId];

    if (currentItemId) {
      queryStr += ` AND id != $3`;
      params.push(currentItemId);
    }

    const result = await query(queryStr, params);

    if (result.rows.length > 0) {
      return { valid: false, existingItem: result.rows[0] };
    }
    return { valid: true, existingItem: null };
  } catch (error) {
    logSystemError(`Failed to validate role uniqueness: ${sanitizeError(error)}`);
    return { valid: false, existingItem: null };
  }
}

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
export async function getShopItems(guildId, categoryId = null, sortBy = 'price', includeInactive = false) {
  try {
    let sql = `SELECT si.*, sc.name as category_name 
               FROM shop_items si
               LEFT JOIN shop_categories sc ON si.category_id = sc.id
               WHERE si.guild_id = $1`;
    const params = [guildId];

    if (!includeInactive) {
      sql += ' AND si.is_active = true';
    }

    if (categoryId !== null) {
      sql += ' AND si.category_id = $2';
      params.push(categoryId);
    }

    if (sortBy === 'name') {
      sql += ' ORDER BY si.name ASC';
    } else {
      sql += ' ORDER BY si.price ASC';
    }

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
 * Calculate dynamic pack price based on partial ownership
 */
export async function calculatePackPrice(userId, guildId, itemId) {
  const item = await getShopItem(itemId);
  if (!item) return null;

  // Default return for non-packs or empty packs
  const defaultResult = {
    finalPrice: item.price,
    originalPrice: item.price,
    discount: 0,
    ownedCount: 0,
    totalCount: 0,
    isOwnedAll: false,
    item
  };

  if (!item.is_pack || !item.contents || !Array.isArray(item.contents) || item.contents.length === 0) {
    return defaultResult;
  }

  // It is a pack
  const contentIds = item.contents;
  const totalCount = contentIds.length;

  // Get user inventory to check ownership
  try {
    const ownedResult = await query(
      `SELECT shop_item_id FROM user_inventory 
             WHERE user_id = $1 AND guild_id = $2 AND shop_item_id = ANY($3)`,
      [userId, guildId, contentIds]
    );

    // Unique owned items
    const ownedIds = new Set(ownedResult.rows.map(r => r.shop_item_id));
    const ownedCount = ownedIds.size;

    // Calculate per-item value
    const perItemValue = Math.floor(item.price / totalCount);
    const discount = perItemValue * ownedCount;
    let finalPrice = item.price - discount;
    if (finalPrice < 0) finalPrice = 0;

    return {
      finalPrice,
      originalPrice: item.price,
      discount,
      ownedCount,
      totalCount,
      isOwnedAll: ownedCount === totalCount,
      item
    };
  } catch (error) {
    console.error('Error calculating pack price:', error);
    return defaultResult;
  }
}

/**
 * Add a new shop category
 */
export async function addShopCategory(guildId, name, displayOrder = 0, categoryType = 0) {
  try {
    const result = await query(
      `INSERT INTO shop_categories (guild_id, name, display_order, category_type)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [guildId, name, displayOrder, categoryType]
    );
    return result.rows[0];
  } catch (error) {
    logSystemError(`Failed to add shop category: ${sanitizeError(error)}`);
    throw error;
  }
}

/**
 * Update a shop category
 */
export async function updateShopCategory(categoryId, updates) {
  try {
    const allowedFields = ['name', 'display_order', 'category_type'];
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

    if (setClauses.length === 0) return null;

    values.push(categoryId);
    const result = await query(
      `UPDATE shop_categories SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values
    );
    return result.rows[0];
  } catch (error) {
    logSystemError(`Failed to update shop category: ${sanitizeError(error)}`);
    throw error;
  }
}

/**
 * Detach all items from a category (Make them standalone)
 */
export async function detachItemsFromCategory(categoryId) {
  try {
    const result = await query(
      'UPDATE shop_items SET category_id = NULL WHERE category_id = $1',
      [categoryId]
    );
    return { success: true, count: result.rowCount };
  } catch (error) {
    logSystemError(`Failed to detach items from category ${categoryId}: ${sanitizeError(error)}`);
    return { success: false, count: 0 };
  }
}

/**
 * Delete a shop category
 */
export async function deleteShopCategory(categoryId) {
  try {
    await query('DELETE FROM shop_categories WHERE id = $1', [categoryId]);
    return true;
  } catch (error) {
    logSystemError(`Failed to delete shop category: ${sanitizeError(error)}`);
    return false;
  }
}

/**
 * Get usage count of an item in Packs
 */
export async function getItemUsageCount(itemId) {
  try {
    // Since we are using a JSON array/string for contents, we need to fetch all packs and check in JS
    // Postgres JSONB containment (@>) would be better but our schema might be using text or simple JSON
    // Let's be safe and do it in JS for now as we did for other logic
    const result = await query("SELECT contents FROM shop_items WHERE item_type = 'pack' OR is_pack = true", []);

    let packCount = 0;
    const idToCheck = parseInt(itemId);

    for (const row of result.rows) {
      let contents = row.contents;
      if (typeof contents === 'string') {
        try { contents = JSON.parse(contents); } catch (e) { contents = []; }
      }
      if (Array.isArray(contents) && contents.includes(idToCheck)) {
        packCount++;
      }
    }
    return packCount;
  } catch (error) {
    console.error('Error getting item usage count:', error);
    return 0;
  }
}

/**
 * Add a new item to the shop
 */
export async function addShopItem(guildId, categoryId, roleId, name, description, price, durationSeconds = null, stock = null, itemType = 'role', contents = [], requiredItems = []) {
  try {
    // Map itemType to is_pack
    const isPack = itemType === 'pack';
    // contents should be JSON stringified if passed as array, or handled by pg driver if JSONB
    const contentsJson = JSON.stringify(contents || []);

    const result = await query(
      `INSERT INTO shop_items (guild_id, category_id, role_id, name, description, price, duration_seconds, stock, item_type, is_pack, contents, required_items, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true)
       RETURNING *`,
      [guildId, categoryId, roleId, name, description, price, durationSeconds, stock, itemType, isPack, contentsJson, JSON.stringify(requiredItems || [])]
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
    const allowedFields = ['name', 'description', 'price', 'duration_seconds', 'stock', 'is_active', 'role_id', 'category_id', 'item_type', 'is_pack', 'contents', 'required_items'];
    const setClauses = [];
    const values = [];
    let paramIndex = 1;

    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key)) {
        setClauses.push(`${key} = $${paramIndex}`);
        // Handle JSON serialization for arrays/objects
        if ((key === 'contents' || key === 'required_items') && typeof value === 'object') {
          values.push(JSON.stringify(value));
        } else {
          values.push(value);
        }
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
 * Delete a shop item and remove from all user inventories and pack contents
 */
export async function deleteShopItem(itemId) {
  try {
    // 1. Remove from user inventories
    await query('DELETE FROM user_inventory WHERE shop_item_id = $1', [itemId]);

    // 2. Delete the shop item itself
    await query('DELETE FROM shop_items WHERE id = $1', [itemId]);

    console.log(`[System] Shop: Deleted item ${itemId}`);
    return true;
  } catch (error) {
    logSystemError(`Failed to delete shop item: ${sanitizeError(error)}`);
    return false;
  }
}

/**
 * Get tiers for a shop item
 */
export async function getItemTiers(itemId) {
  try {
    const result = await query(
      'SELECT * FROM item_tiers WHERE parent_item_id = $1 ORDER BY tier_level ASC',
      [itemId]
    );
    return result.rows;
  } catch (error) {
    logSystemError(`Failed to get item tiers for item ${itemId}: ${sanitizeError(error)}`);
    return [];
  }
}

/**
 * Add a new tier to a shop item
 */
export async function addItemTier(parentItemId, tierLevel, roleId, upgradePrice) {
  try {
    const result = await query(
      `INSERT INTO item_tiers (parent_item_id, tier_level, role_id, upgrade_price)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [parentItemId, tierLevel, roleId, upgradePrice]
    );
    return result.rows[0];
  } catch (error) {
    logSystemError(`Failed to add item tier: ${sanitizeError(error)}`);
    throw error;
  }
}

/**
 * Delete an item tier
 */
export async function deleteItemTier(tierId) {
  try {
    await query('DELETE FROM item_tiers WHERE id = $1', [tierId]);
    return true;
  } catch (error) {
    logSystemError(`Failed to delete item tier: ${sanitizeError(error)}`);
    return false;
  }
}

/**
 * Helper: Check if a member meets all Required Items prerequisites.
 * Integers = Must own the item in shop_inventory.
 * "booster:X" = Must currently have the Discord booster role X.
 */
export async function checkPrerequisites(member, guildId, requiredItems, client = null) {
  if (!requiredItems || !Array.isArray(requiredItems) || requiredItems.length === 0) {
    return { met: true, missingItemIds: [], missingBooster: false };
  }

  const pool = client || getPool();
  const userId = member.user.id;
  const missingItemIds = [];
  let missingBooster = false;

  for (const req of requiredItems) {
    // 1. Booster Role Check (Live Status)
    if (typeof req === 'string' && req.startsWith('booster:')) {
      const roleId = req.split(':')[1];
      if (!member.roles.cache.has(roleId)) {
        missingBooster = true;
      }
      continue;
    }

    // 2. Standard Item Check (Inventory Ownership)
    if (Number.isInteger(req)) {
      const res = await pool.query(
        'SELECT id FROM user_inventory WHERE user_id = $1 AND guild_id = $2 AND shop_item_id = $3',
        [userId, guildId, req]
      );
      
      if (res.rows.length === 0) {
        missingItemIds.push(req);
      }
      continue;
    }
  }

  const met = missingItemIds.length === 0 && !missingBooster;
  return { met, missingItemIds, missingBooster };
}

/**
 * Helper: Format comprehensive prerequisite error messages
 */
export async function formatPrerequisiteError(prereqs, guildId) {
  const { missingItemIds, missingBooster } = prereqs;
  
  // Scenario A: Booster Only
  if (missingItemIds.length === 0 && missingBooster) {
    return 'This item is for Server Boosters only. 🚀';
  }

  // Scenario B: Items Only OR Scenario C: Hybrid
  let itemMessage = '';
  if (missingItemIds.length > 0) {
    const itemNamesRes = await query(
      'SELECT name FROM shop_items WHERE id = ANY($1)',
      [missingItemIds]
    );
    const names = itemNamesRes.rows.map(r => `**${r.name}**`);
    
    let formattedNames = '';
    if (names.length === 1) {
      formattedNames = names[0];
    } else if (names.length === 2) {
      formattedNames = `${names[0]} and ${names[1]}`;
    } else {
      const last = names.pop();
      formattedNames = `${names.join(', ')}, and ${last}`;
    }
    
    itemMessage = `You must own ${formattedNames} first`;
  }

  if (missingBooster) {
    // Scenario C: Hybrid
    return `${itemMessage}${itemMessage ? ' AND ' : ''}be an active **Server Booster** 🚀.`;
  } else {
    // Scenario B: Items Only
    return `${itemMessage}.`;
  }
}

/**
 * Purchase an item from the shop
 * @param {string} userId - The buyer's user ID
 * @param {string} guildId - The guild ID
 * @param {number} itemId - The shop item ID
 * @param {object} member - The Discord member object
 * @param {object} options - Optional settings
 * @param {boolean} options.skipBalanceDeduction - If true, skip balance check/deduction (used when * @param {Object} options - Additional options including seller information and payout
 */
export async function purchaseItem(userId, guildId, itemId, member, options = {}) {
  const { sellerId = '0', payoutAmount = 0, skipBalanceDeduction = false } = options;
  const pool = getPool();
  const client = await pool.connect();
  let transactionId = null;

  try {
    await client.query('BEGIN');

    // ========== STEP 1: Validate Shop Item ==========
    // FOR UPDATE locks this row until transaction commits - prevents race condition on stock
    const itemResult = await client.query(
      `SELECT si.* 
       FROM shop_items si
       WHERE si.id = $1 AND si.guild_id = $2
       FOR UPDATE`,
      [itemId, guildId]
    );

    if (itemResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: 'Item not found' };
    }

    const item = itemResult.rows[0];

    // ========== NEW: Prerequisite Check ==========
    const audit = await checkPrerequisites(member, guildId, item.required_items, client);
    if (!audit.met) {
      await client.query('ROLLBACK');
      const errorMsg = await formatPrerequisiteError(audit, guildId);
      return { success: false, error: errorMsg };
    }

    // Check if item is active
    if (!item.is_active) {
      await client.query('ROLLBACK');
      return { success: false, error: 'This item is no longer available' };
    }

    // Check stock
    if (item.stock !== null && item.stock <= 0) {
      await client.query('ROLLBACK');
      return { success: false, error: 'Item out of stock' };
    }

    // Capture initial balances for logging (BEFORE update)
    const buyerBalRes = await client.query('SELECT balance FROM user_balances WHERE user_id = $1 AND guild_id = $2', [userId, guildId]);
    const buyerBefore = parseInt(buyerBalRes.rows[0]?.balance || 0);

    let sellerBefore = 0;
    let sellerMember = null;
    if (sellerId !== '0') {
        const sellerBalRes = await client.query('SELECT balance FROM user_balances WHERE user_id = $1 AND guild_id = $2', [sellerId, guildId]);
        sellerBefore = parseInt(sellerBalRes.rows[0]?.balance || 0);
        sellerMember = await member.guild.members.fetch(sellerId).catch(() => null);
    }

    // Define effectivePrice (default to item price)
    let effectivePrice = item.price;

    // Define checkRoleSafety helper
    const botMember = member.guild.members.me;
    const checkRoleSafety = (rId) => {
      if (!rId) return true;
      const role = member.guild.roles.cache.get(rId);
      if (!role) return true; // Role might be deleted, we'll just ignore it later or fail? 
      // If role exists but we can't manage it:
      if (role.comparePositionTo(botMember.roles.highest) >= 0) {
        return false;
      }
      return true;
    };

    // Check for Temporary Item Logic
    const isTemp = (item.duration_seconds && item.duration_seconds > 0) || (item.duration_hours && item.duration_hours > 0);

    // ========== TEMP ITEM CHECK (Highest Priority) ==========
    // Check if item is currently active in DB (expires_at > NOW)
    // We do this BEFORE role check so we give the correct "Wait for expire" message
    if (isTemp) {
      const activeTemp = await client.query(
        `SELECT id FROM user_inventory 
                 WHERE user_id = $1 AND guild_id = $2 AND shop_item_id = $3 
                 AND expires_at > NOW()`,
        [userId, guildId, itemId]
      );

      if (activeTemp.rows.length > 0) {
        await client.query('ROLLBACK');
        return { success: false, error: 'Wait for the item to expire before buying it again.' };
      }
    }

    // ========== REAL-TIME ROLE CHECK ==========
    // Check if user ALREADY HAS the role (even if admin-granted, not in DB)
    // This prevents buying items they already own via Discord role
    if (item.role_id) {
      const firstRoleId = item.role_id.split(/[,\s]+/)[0];
      if (member.roles.cache.has(firstRoleId)) {
        await client.query('ROLLBACK');
        return { success: false, error: 'You already have that item.' };
      }
    }

    // ========== CHECK OWNERSHIP (Permanent Items) ==========
    if (!isTemp && item.item_type !== 'pack') {
      // Permanent item check: already owned?
      const existing = await client.query(
        'SELECT * FROM user_inventory WHERE user_id = $1 AND guild_id = $2 AND shop_item_id = $3',
        [userId, guildId, itemId]
      );

      if (existing.rows.length > 0) {
        await client.query('ROLLBACK');
        return { success: false, error: 'You already have that item.' };
      }
    }

    // Track pack info for later use
    let packInfo = null;

    if (item.item_type === 'pack' && item.contents && Array.isArray(item.contents) && item.contents.length > 0) {
      // PACK LOGIC: Allow partial purchases - only add missing items
      const contentIds = item.contents;

      // Check what the user already owns
      const ownedResult = await client.query(
        `SELECT shop_item_id FROM user_inventory 
             WHERE user_id = $1 AND guild_id = $2 AND shop_item_id = ANY($3)`,
        [userId, guildId, contentIds]
      );

      const ownedIds = new Set(ownedResult.rows.map(r => r.shop_item_id));
      const ownedCount = ownedIds.size;
      const totalCount = contentIds.length;

      // Only block if user owns ALL items in the pack
      if (ownedCount >= totalCount) {
        await client.query('ROLLBACK');
        return { success: false, error: 'You already have that pack.' };
      }

      // Calculate missing items
      const missingIds = contentIds.filter(id => !ownedIds.has(id));

      // Store pack info for later (to add only missing items)
      packInfo = {
        missingIds: missingIds,
        ownedCount: ownedCount,
        totalCount: totalCount,
        newCount: missingIds.length
      };

      // Full price - no discount for partial ownership
      effectivePrice = item.price;

      // Check roles of MISSING contents for safety (only check what we're adding)
      const contentItemsRes = await client.query(
        `SELECT role_id FROM shop_items WHERE id = ANY($1) AND guild_id = $2`,
        [missingIds, guildId]
      );

      for (const cItem of contentItemsRes.rows) {
        if (cItem.role_id && !checkRoleSafety(cItem.role_id)) {
          await client.query('ROLLBACK');
          return { success: false, error: 'Some roles in this pack is higher than my role. Please contact an admin.' };
        }
      }

    }

    // ========== STEP 3: Verify User Balance (Lock Wallet) ==========
    // Skip if balance was already deducted atomically by caller
    let currentBalance = 0;
    if (!skipBalanceDeduction) {
      const balanceResult = await client.query(
        'SELECT balance FROM user_balances WHERE user_id = $1 AND guild_id = $2 FOR UPDATE',
        [userId, guildId]
      );

      if (balanceResult.rows.length === 0) {
        await client.query(
          'INSERT INTO user_balances (user_id, guild_id, balance) VALUES ($1, $2, 0)',
          [userId, guildId]
        );
      }

      currentBalance = parseInt(balanceResult.rows[0]?.balance || 0);

      if (currentBalance < effectivePrice) {
        await client.query('ROLLBACK');
        sendLog(member.guild, 'shop', 'red', '❌ Purchase Failed', `**${getUserLogName(member)}** tried to buy **${item.name}** but has insufficient funds.\n• Required: **${effectivePrice.toLocaleString()}** ${COIN_EMOJI}\n• Balance: **${currentBalance.toLocaleString()}** ${COIN_EMOJI}`);
        return { success: false, error: 'Insufficient balance' };
      }
    }

    // ========== STEP 4: Handle Inventory & Contents (Add FIRST) ==========

    // Define helper to add item to inventory
    const addToInventory = async (targetItem, purchaseSource = 'shop') => {
      const durationSeconds = targetItem.duration_seconds || (targetItem.duration_hours ? targetItem.duration_hours * 3600 : null);
      const expiresAt = durationSeconds
        ? new Date(Date.now() + durationSeconds * 1000)
        : null;

      // AUTO-EQUIP for Temporary Items ONLY
      // Check if THIS specific target item is temp
      const isTargetTemp = (targetItem.duration_seconds && targetItem.duration_seconds > 0) || (targetItem.duration_hours && targetItem.duration_hours > 0);
      const isActive = isTargetTemp ? true : false; // Ensure boolean, never null 

      const res = await client.query(
        `INSERT INTO user_inventory (
            user_id, guild_id, shop_item_id, role_id, expires_at, 
            purchase_source, is_active, source
          )
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'SHOP')
           RETURNING *`,
        [userId, guildId, targetItem.id, targetItem.role_id, expiresAt, purchaseSource, isActive]
      );
      return { inventoryItem: res.rows[0], isActive };
    };

    // Add Main Item (for packs, this adds the pack itself as a "container" record)
    const { isActive: mainActive } = await addToInventory(item, 'shop');

    // Handle Pack Contents - ONLY add MISSING items with valid roles
    if (packInfo && packInfo.missingIds.length > 0) {
      // Fetch only the missing items
      const contentItemsRes = await client.query(
        `SELECT * FROM shop_items WHERE id = ANY($1) AND guild_id = $2`,
        [packInfo.missingIds, guildId]
      );

      let skippedCount = 0;
      for (const contentItem of contentItemsRes.rows) {
        // Validate role exists before adding (skip ghost items)
        if (contentItem.role_id) {
          const firstRoleId = contentItem.role_id.split(/[,\s]+/)[0];
          const roleExists = member.guild.roles.cache.has(firstRoleId);
          if (!roleExists) {
            console.log(`[${member.guild.name}] ${member.user.username} — Pack: Skipping ghost item "${contentItem.name}"`);
            skippedCount++;
            continue;
          }
        }
        await addToInventory(contentItem, 'pack');
      }
      if (skippedCount > 0) {
        packInfo.skippedCount = skippedCount;
      }
    } else if (!packInfo && item.contents && Array.isArray(item.contents) && item.contents.length > 0) {
      // Non-pack item with contents (shouldn't happen, but fallback)
      const contentIds = item.contents;
      const contentItemsRes = await client.query(
        `SELECT * FROM shop_items WHERE id = ANY($1) AND guild_id = $2`,
        [contentIds, guildId]
      );

      for (const contentItem of contentItemsRes.rows) {
        // Validate role exists before adding
        if (contentItem.role_id) {
          const firstRoleId = contentItem.role_id.split(/[,\s]+/)[0];
          if (!member.guild.roles.cache.has(firstRoleId)) {
            console.log(`[${member.guild.name}] ${member.user.username} — Pack: Skipping ghost item "${contentItem.name}"`);
            continue;
          }
        }
        const check = await client.query(
          'SELECT id FROM user_inventory WHERE user_id = $1 AND shop_item_id = $2',
          [userId, contentItem.id]
        );
        if (check.rows.length === 0) {
          await addToInventory(contentItem, 'pack');
        }
      }
    }

    // ========== STEP 5: Deduct Coins (Charge SECOND) ==========
    // Skip if balance was already deducted atomically by caller
    let newBalance = currentBalance - effectivePrice;

    if (!skipBalanceDeduction) {
      // Enforce non-negative balance check again (though logic above ensures it)
      if (newBalance < 0) {
        await client.query('ROLLBACK');
        return { success: false, error: 'Transaction rejected: Negative balance protection.' };
      }

      await client.query(
        `UPDATE user_balances 
         SET balance = $1, total_spent = total_spent + $2, updated_at = NOW()
         WHERE user_id = $3 AND guild_id = $4`,
        [newBalance, effectivePrice, userId, guildId]
      );

      await client.query(
        `INSERT INTO transactions (user_id, guild_id, amount, balance_after, type, description, reference_id)
         VALUES ($1, $2, $3, $4, 'purchase', $5, $6)`,
        [userId, guildId, -effectivePrice, newBalance, `Purchased: ${item.name}`, itemId.toString()]
      );
    } else {
      // Balance was already deducted, just get current balance for return value
      const balResult = await client.query(
        'SELECT balance FROM user_balances WHERE user_id = $1 AND guild_id = $2',
        [userId, guildId]
      );
      newBalance = parseInt(balResult.rows[0]?.balance || 0);
    }

    // Update stock
    if (item.stock !== null) {
      await client.query(
        'UPDATE shop_items SET stock = stock - 1, updated_at = NOW() WHERE id = $1',
        [itemId]
      );
    }

    // ========== STEP 5.5: Seller Payout (ATOMIC) ==========
    const isSelfPurchase = sellerId !== '0' && sellerId === userId;
    const hasSeller = sellerId !== '0' && !isSelfPurchase;
    
    if (hasSeller && payoutAmount > 0) {
      // 1. Give coins to seller
      await client.query(
        `INSERT INTO user_balances (guild_id, user_id, balance, total_earned)
         VALUES ($1, $2, $3, $3)
         ON CONFLICT (guild_id, user_id) 
         DO UPDATE SET 
            balance = user_balances.balance + $3, 
            total_earned = user_balances.total_earned + $3, 
            updated_at = NOW()`,
        [guildId, sellerId, payoutAmount]
      );

      // 2. Log to seller's transaction history
      await client.query(
        `INSERT INTO transactions (guild_id, user_id, amount, balance_after, type, description, reference_id, created_at)
         VALUES ($1, $2, $3, $4, 'sale', $5, $6, NOW())`,
        [guildId, sellerId, payoutAmount, sellerBefore + payoutAmount, `<@${userId}> bought **${item.name}**`, `sale_${itemId}_${userId}`]
      );
      
      console.log(`[Shop] Atomic Payout: Seller ${sellerId} received ${payoutAmount} coins for item ${itemId}`);
    }

    await client.query('COMMIT');

    // ========== STEP 6: Grant Roles (ONLY for Temporary Items) ==========
    // - Temp items: Auto-equipped (is_active=true), role granted immediately
    // - Permanent items: NOT auto-equipped (is_active=false), NO role granted
    //   User must go to inventory and click "Equip" manually to get the role

    if (mainActive && item.role_id) {
      // Only grant role for TEMPORARY items (auto-equipped)
      const roles = item.role_id.split(/[,\s]+/);
      for (const rid of roles) {
        try {
          await member.roles.add(rid);
          const roleObj = member.guild.roles.cache.get(rid);
          const roleName = roleObj ? roleObj.name : rid;
          console.log(`[${member.guild.name}] Granted role "${roleName}" to ${member.user.username} for TEMP item "${item.name}"`);
        } catch (e) {
          const roleObj = member.guild.roles.cache.get(rid);
          const roleName = roleObj ? roleObj.name : rid;
          console.error(`[${member.guild.name}] Failed to grant role "${roleName}" to ${member.user.username}:`, e.message);
        }
      }
    }
    // Permanent items: No role granted here - user must equip from inventory

    // ========== DISCORD LOGS (Dual Receipt) ==========
    const buyerLogName = getUserLogName(member);
    const buyerAfter = buyerBefore - effectivePrice;
    
    // 1. Buyer Log
    sendLog(member.guild, 'shop', 'green', '🛒 Item Purchased', 
      `**User:** \`${buyerLogName}\`\n` +
      `**Item:** \`${item.name}\`\n` +
      `**Price:** \`${effectivePrice.toLocaleString()}\` ${COIN_EMOJI}\n` +
      `**Balance:** \`${buyerBefore.toLocaleString()}\` ➡️ \`${buyerAfter.toLocaleString()}\``
    );

    // 2. Seller Log (Dual Receipt)
    if (hasSeller && payoutAmount > 0) {
      const sellerMember = await member.guild.members.fetch(sellerId).catch(() => null);
      const sellerLogName = sellerMember ? getUserLogName(sellerMember) : `Unknown (${sellerId})`;
      const sellerAfter = sellerBefore + payoutAmount;

      sendLog(member.guild, 'shop', 'green', '💰 Item Sold (Payout)', 
        `**User:** \`${sellerLogName}\`\n` +
        `**Item:** \`${item.name}\` (Sold)\n` +
        `**Payout:** \`${payoutAmount.toLocaleString()}\` ${COIN_EMOJI}\n` +
        `**Balance:** \`${sellerBefore.toLocaleString()}\` ➡️ \`${sellerAfter.toLocaleString()}\``
      );
    }

    return {
      success: true,
      newBalance,
      item,
      pricePaid: effectivePrice,
      packInfo: packInfo // Include pack info for feedback (null if not a pack)
    };

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Purchase error:', error);
    return { success: false, error: 'Purchase failed due to an error.' };
  } finally {
    client.release();
  }
}

/**
 * Audit and unequip items that no longer meet requirements
 */
export async function runDependencySweep(userId, guildId, member, client = null) {
  const pool = client || getPool();
  try {
    // Fetch all currently EQUIPPED items
    const equippedRes = await pool.query(
      `SELECT ui.id, ui.shop_item_id, si.name, si.required_items 
       FROM user_inventory ui
       JOIN shop_items si ON ui.shop_item_id = si.id
       WHERE ui.user_id = $1 AND ui.guild_id = $2 AND ui.is_active = true`,
      [userId, guildId]
    );

    const lostItems = [];
    for (const invItem of equippedRes.rows) {
      let reqItems = invItem.required_items;
      if (typeof reqItems === 'string') {
        try { reqItems = JSON.parse(reqItems); } catch (e) { reqItems = []; }
      }

      const audit = await checkPrerequisites(member, guildId, reqItems, pool);
      if (!audit.met) {
        // Requirement lost -> Unequip
        await pool.query('UPDATE user_inventory SET is_active = false WHERE id = $1', [invItem.id]);
        lostItems.push(invItem.name);
      }
    }

    // Trigger role sync to remove Discord roles for the unequipped items
    if (lostItems.length > 0) {
      await syncInventoryWithDiscord(userId, guildId, member);
    }

    return lostItems;
  } catch (err) {
    console.error('Dependency Sweep failed:', err);
    return [];
  }
}

/**
 * Drop an item from inventory (Multiplayer System)
 */
export async function dropItem(userId, guildId, invId, member) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Fetch Item details
    const invRes = await client.query(
      `SELECT ui.*, si.name, si.role_id 
       FROM user_inventory ui
       JOIN shop_items si ON ui.shop_item_id = si.id
       WHERE ui.id = $1 AND ui.user_id = $2 AND ui.guild_id = $3`,
      [invId, userId, guildId]
    );

    if (invRes.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new Error('Item not found in inventory');
    }

    const item = invRes.rows[0];

    // 2. Instant Database Wipe
    await client.query('DELETE FROM user_inventory WHERE id = $1', [invId]);

    // 3. Create Drop Record (Expires after 24 hours)
    const dropRes = await client.query(
      `INSERT INTO dropped_items (guild_id, dropper_id, shop_item_id, status)
       VALUES ($1, $2, $3, 'available')
       RETURNING id`,
      [guildId, userId, item.shop_item_id]
    );

    // 4. Role removal (Instant Discord Wipe)
    if (item.role_id) {
      const rIds = item.role_id.split(/[,\s]+/);
      for (const rId of rIds) {
        const role = member.guild.roles.cache.get(rId);
        if (role && role.comparePositionTo(member.guild.members.me.roles.highest) < 0) {
          await member.roles.remove(role).catch(() => {});
        }
      }
    }

    // 5. Dependency Sweep (Unequip items that lost requirements)
    await runDependencySweep(userId, guildId, member, client);

    await client.query('COMMIT');

    return { 
      success: true, 
      item: item, 
      dropId: dropRes.rows[0].id 
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Claim a dropped item
 */
export async function claimItem(claimerId, guildId, dropId, member) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Atomic Lock on Drop
    const dropRes = await client.query(
      `SELECT d.*, si.name, si.role_id 
       FROM dropped_items d
       JOIN shop_items si ON d.shop_item_id = si.id
       WHERE d.id = $1 AND d.status = 'available'
       FOR UPDATE`,
      [dropId]
    );

    if (dropRes.rows.length === 0) {
      await client.query('ROLLBACK');
      // Check if it exists but is expired
      const existsRes = await client.query('SELECT created_at FROM dropped_items WHERE id = $1', [dropId]);
      if (existsRes.rows.length > 0) {
          const created = new Date(existsRes.rows[0].created_at);
          if (Date.now() - created.getTime() > 24 * 60 * 60 * 1000) {
              throw new Error('This item drop has expired.');
          }
      }
      throw new Error('This item has already been claimed.');
    }

    const drop = dropRes.rows[0];

    // 2. Rules Verification
    if (drop.dropper_id === claimerId) {
      await client.query('ROLLBACK');
      throw new Error('You cannot claim your own drop.');
    }

    // Check Database Ownership
    const ownCheck = await client.query(
      'SELECT id FROM user_inventory WHERE user_id = $1 AND shop_item_id = $2 AND guild_id = $3',
      [claimerId, drop.shop_item_id, guildId]
    );
    if (ownCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      throw new Error('You already own that item.');
    }

    // 3. Join Date Gate
    const guildConfigRes = await client.query('SELECT config FROM guild_configs WHERE guild_id = $1', [guildId]);
    const config = guildConfigRes.rows[0]?.config || {};
    const requiredDays = parseInt(config.drop_join_gate || '7', 10);
    
    if (member.joinedAt) {
      const daysInServer = (Date.now() - member.joinedAt.getTime()) / (1000 * 60 * 60 * 24);
      if (daysInServer < requiredDays) {
        await client.query('ROLLBACK');
        throw new Error(`You must be in the server for at least ${requiredDays} days to claim dropped items.`);
      }
    }

    // 4. Acquisition (Skip Pre-reqs, add Unequipped)
    await client.query(
      `INSERT INTO user_inventory (user_id, guild_id, shop_item_id, role_id, is_active, source)
       VALUES ($1, $2, $3, $4, false, 'SHOP')`,
      [claimerId, guildId, drop.shop_item_id, drop.role_id]
    );

    // 5. Finalize Drop record
    await client.query(
      "UPDATE dropped_items SET status = 'claimed', claimer_id = $1 WHERE id = $2",
      [claimerId, dropId]
    );

    await client.query('COMMIT');
    return { success: true, item: drop };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Get user's active inventory items (filters out deleted/ghost items)
 */
export async function getUserInventory(userId, guildId) {
  try {
    // Use INNER JOIN to only return items that still exist in shop_items
    // This prevents "ghost" items from deleted shop entries
    const result = await query(
      `SELECT i.*, s.name, s.description, s.item_type, s.is_pack, s.role_id, s.category_id, s.price
       FROM user_inventory i
       INNER JOIN shop_items s ON i.shop_item_id = s.id
       WHERE i.user_id = $1 AND i.guild_id = $2
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
 * Bi-directional sync: inventory is_active state with actual Discord role ownership
 * - If user HAS role but DB says unequipped -> mark as equipped
 * - If user LACKS role but DB says equipped -> mark as unequipped
 */
export async function syncInventoryRoleState(userId, guildId, member, inventory) {
  if (!member || !inventory || inventory.length === 0) return inventory;

  const toEquip = [];
  const toUnequip = [];

  for (const item of inventory) {
    // Skip items without roles or temporary items (they're auto-managed)
    if (!item.role_id || item.expires_at) continue;

    const firstRoleId = item.role_id.split(/[,\s]+/)[0];
    const hasRole = member.roles.cache.has(firstRoleId);

    if (hasRole && !item.is_active) {
      // User HAS the role but DB says unequipped -> mark as equipped
      toEquip.push(item.id);
      item.is_active = true;
    } else if (!hasRole && item.is_active) {
      // User LACKS the role but DB says equipped -> mark as unequipped
      toUnequip.push(item.id);
      item.is_active = false;
    }
  }

  // Batch update DB
  try {
    if (toEquip.length > 0) {
      await query(`UPDATE user_inventory SET is_active = true WHERE id = ANY($1)`, [toEquip]);
    }
    if (toUnequip.length > 0) {
      await query(`UPDATE user_inventory SET is_active = false WHERE id = ANY($1)`, [toUnequip]);
    }
  } catch (error) {
    logSystemError(`Failed to sync inventory role state: ${sanitizeError(error)}`);
  }

  return inventory;
}

/**
 * SYNC: The "Source of Truth" Inventory Manager
 * - DB user_inventory is the master registry.
 * - Discord Roles are the "Active View".
 * RULE: We NO LONGER delete items if a role is missing from Discord. 
 * Instead, we use the DB to re-apply roles if is_active is true.
 */
export async function syncInventoryWithDiscord(userId, guildId, member) {
  if (!member) return [];
  try {
    const inventory = await query(
      `SELECT ui.*, si.name, si.role_id, si.price, si.item_type, si.is_pack, si.category_id, si.required_items
       FROM user_inventory ui
       LEFT JOIN shop_items si ON ui.shop_item_id = si.id
       WHERE ui.user_id = $1 AND ui.guild_id = $2`,
      [userId, guildId]
    );

    const botMember = member.guild.members.me;
    const currentInv = inventory.rows;

    // Discovery: Roles the user has that ARE linked to shop items BUT not in DB
    const shopItemsWithRoles = await getShopItems(guildId, null, 'name', true);
    const existingShopIds = new Set(currentInv.map(i => i.shop_item_id));

    for (const item of shopItemsWithRoles) {
      if (!item.role_id) continue;
      const firstRoleId = item.role_id.split(/[,\s]+/)[0];

      // If user has the role but NO DB ENTRY, discover it
      if (member.roles.cache.has(firstRoleId) && !existingShopIds.has(item.id)) {
        console.log(`[Sync] Discovering item ${item.name} for ${member.user.username}`);
        await query(
          `INSERT INTO user_inventory (user_id, guild_id, shop_item_id, role_id, is_active, source)
           VALUES ($1, $2, $3, $4, true, 'SYNC')`,
          [userId, guildId, item.id, item.role_id]
        );
      }
    }

    // Refresh inventory after discovery (if any)
    const refreshed = await query(
      `SELECT ui.*, si.name, si.role_id, si.price, si.item_type, si.is_pack, si.category_id, si.required_items
       FROM user_inventory ui
       LEFT JOIN shop_items si ON ui.shop_item_id = si.id
       WHERE ui.user_id = $1 AND ui.guild_id = $2`,
      [userId, guildId]
    );

    // Rule Verification: Ensure roles match the 'is_active' state in DB
    for (const invItem of refreshed.rows) {
      if (!invItem.role_id || invItem.item_type === 'pack' || invItem.is_pack) continue;
      const firstRoleId = invItem.role_id.split(/[,\s]+/)[0];
      const role = member.guild.roles.cache.get(firstRoleId);
      if (!role) continue;

      const hasRole = member.roles.cache.has(firstRoleId);
      const shouldHaveRole = invItem.is_active === true;

      // Only perform role movement if bot is high enough
      if (role.comparePositionTo(botMember.roles.highest) < 0) {
        if (shouldHaveRole && !hasRole) {
          await member.roles.add(role).catch(() => {});
        } else if (!shouldHaveRole && hasRole) {
          await member.roles.remove(role).catch(() => {});
        }
      }
    }

    return refreshed.rows;
  } catch (error) {
    console.error('Inventory Sync Error:', error);
    return [];
  }
}

/**
 * Clean up orphaned inventory entries (items that no longer exist in shop)
 */
export async function cleanupOrphanedInventory(guildId = null) {
  try {
    let sql = `DELETE FROM user_inventory 
               WHERE shop_item_id NOT IN (SELECT id FROM shop_items)`;
    const params = [];

    if (guildId) {
      sql += ' AND guild_id = $1';
      params.push(guildId);
    }

    const result = await query(sql, params);
    if (result.rowCount > 0) {
      console.log(`[System] Cleaned up ${result.rowCount} orphaned inventory entries`);
    }
    return result.rowCount;
  } catch (error) {
    logSystemError(`Failed to cleanup orphaned inventory: ${sanitizeError(error)}`);
    return 0;
  }
}

/**
 * Clean up "Ghost Items" - shop items whose Discord roles have been deleted from the server.
 * This function only READS the role cache to check existence, it NEVER deletes actual Discord roles.
 * 
 * @param {Guild} guild - The Discord guild object
 * @returns {Promise<{itemsRemoved: number, inventoryRemoved: number}>} Cleanup stats
 */
export async function cleanupGhostItems(guild) {
  if (!guild) return { itemsRemoved: 0, inventoryRemoved: 0 };

  try {
    // Get all shop items with roles for this guild
    const shopItemsResult = await query(
      `SELECT id, name, role_id FROM shop_items 
       WHERE guild_id = $1 AND role_id IS NOT NULL`,
      [guild.id]
    );

    const ghostItemIds = [];
    const ghostItemNames = [];

    for (const item of shopItemsResult.rows) {
      // Extract first role ID (items can have comma-separated roles)
      const firstRoleId = item.role_id.split(/[,\s]+/)[0];

      // Check if this role exists in the guild (READ ONLY - never delete roles)
      const roleExists = guild.roles.cache.has(firstRoleId);

      if (!roleExists) {
        ghostItemIds.push(item.id);
        ghostItemNames.push(item.name);
      }
    }

    if (ghostItemIds.length === 0) {
      return { itemsRemoved: 0, inventoryRemoved: 0, packsUpdated: 0 };
    }

    // 1. Remove ghost items from pack contents arrays
    const packsResult = await query(
      `SELECT id, contents FROM shop_items WHERE guild_id = $1 AND item_type = 'pack' AND contents IS NOT NULL`,
      [guild.id]
    );
    let packsUpdated = 0;
    for (const pack of packsResult.rows) {
      let contents = pack.contents;
      if (typeof contents === 'string') {
        try { contents = JSON.parse(contents); } catch (e) { contents = []; }
      }
      if (!Array.isArray(contents)) continue;
      const filtered = contents.filter(id => !ghostItemIds.includes(id));
      if (filtered.length !== contents.length) {
        await query(`UPDATE shop_items SET contents = $1 WHERE id = $2`, [JSON.stringify(filtered), pack.id]);
        packsUpdated++;
      }
    }

    // 2. Delete from user_inventory
    const inventoryResult = await query(
      `DELETE FROM user_inventory WHERE shop_item_id = ANY($1)`,
      [ghostItemIds]
    );

    // 3. Delete from shop_items
    const shopResult = await query(
      `DELETE FROM shop_items WHERE id = ANY($1)`,
      [ghostItemIds]
    );

    // Log each removed item
    for (const name of ghostItemNames) {
      console.log(`[System] Ghost Cleanup: Removed item "${name}" (Role deleted)`);
    }

    console.log(`[System] Ghost Cleanup (${guild.name}): Removed ${shopResult.rowCount} items, ${inventoryResult.rowCount} inventory entries, updated ${packsUpdated} packs`);

    return {
      itemsRemoved: shopResult.rowCount,
      inventoryRemoved: inventoryResult.rowCount,
      packsUpdated
    };

  } catch (error) {
    logSystemError(`Failed to cleanup ghost items for guild ${guild.id}: ${sanitizeError(error)}`);
    return { itemsRemoved: 0, inventoryRemoved: 0 };
  }
}

/**
 * Clean up ghost items for a specific deleted role
 * Called from roleDelete event handler
 * 
 * @param {string} guildId - The guild ID
 * @param {string} roleId - The deleted role ID
 * @returns {Promise<{itemsRemoved: number, inventoryRemoved: number}>}
 */
export async function cleanupDeletedRole(guildId, roleId) {
  try {
    // Find shop items that use this role
    const shopItemsResult = await query(
      `SELECT id, name FROM shop_items 
       WHERE guild_id = $1 AND role_id LIKE $2`,
      [guildId, `%${roleId}%`]
    );

    if (shopItemsResult.rows.length === 0) {
      return { itemsRemoved: 0, inventoryRemoved: 0, packsUpdated: 0 };
    }

    const itemIds = shopItemsResult.rows.map(r => r.id);
    const itemNames = shopItemsResult.rows.map(r => r.name);

    // 1. Remove deleted items from pack contents arrays
    const packsResult = await query(
      `SELECT id, contents FROM shop_items WHERE guild_id = $1 AND item_type = 'pack' AND contents IS NOT NULL`,
      [guildId]
    );
    let packsUpdated = 0;
    for (const pack of packsResult.rows) {
      let contents = pack.contents;
      if (typeof contents === 'string') {
        try { contents = JSON.parse(contents); } catch (e) { contents = []; }
      }
      if (!Array.isArray(contents)) continue;
      const filtered = contents.filter(id => !itemIds.includes(id));
      if (filtered.length !== contents.length) {
        await query(`UPDATE shop_items SET contents = $1 WHERE id = $2`, [JSON.stringify(filtered), pack.id]);
        packsUpdated++;
      }
    }

    // 2. Delete from user_inventory
    const inventoryResult = await query(
      `DELETE FROM user_inventory WHERE shop_item_id = ANY($1)`,
      [itemIds]
    );

    // 3. Delete from shop_items
    const shopResult = await query(
      `DELETE FROM shop_items WHERE id = ANY($1)`,
      [itemIds]
    );

    for (const name of itemNames) {
      console.log(`[System] Role deleted - Removed shop item "${name}"`);
    }

    // Discord Log (Bulk)
    if (shopResult.rowCount > 0) {
      sendBulkLog(
        { id: guildId, name: 'Server', iconURL: () => null }, // Minimal guild object for logger
        'audit', 
        'red', 
        'Role Deleted Cleanup', 
        `**Role ID:** \`${roleId}\`\n` +
        `**Action:** Purged **${shopResult.rowCount}** shop items and **${inventoryResult.rowCount}** user inventory entries.\n` +
        `**Items Removed:** ${itemNames.map(n => `\`${n}\``).join(', ')}`
      );
    }

    return {
      itemsRemoved: shopResult.rowCount,
      inventoryRemoved: inventoryResult.rowCount,
      packsUpdated
    };

  } catch (error) {
    logSystemError(`Failed to cleanup deleted role ${roleId}: ${sanitizeError(error)}`);
    return { itemsRemoved: 0, inventoryRemoved: 0 };
  }
}

/**
 * Activate or Deactivate an item
 * - Activate: Add Discord role, set is_active=true
 * - Deactivate: Remove Discord role, set is_active=false (item stays in inventory)
 * - Checks expiry before allowing activation
 */
export async function toggleEquipItem(userId, guildId, inventoryId, member) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Get item details including source
    const result = await client.query(
      `SELECT i.*, s.role_id as source_roles, s.category_id, s.name, s.item_type
       FROM user_inventory i
       JOIN shop_items s ON i.shop_item_id = s.id
       WHERE i.id = $1 AND i.user_id = $2`,
      [inventoryId, userId]
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: 'Item not found in inventory' };
    }

    const item = result.rows[0];
    const newStatus = !item.is_active; // Toggle
    
    // ========== NEW: Prerequisite Check for Equip ==========
    if (newStatus) {
      const prereqs = await checkPrerequisites(member, guildId, item.required_items, client);
      if (!prereqs.met) {
        await client.query('ROLLBACK');
        const errorMsg = await formatPrerequisiteError(prereqs, guildId);
        return { success: false, error: errorMsg };
      }
    }

    const roles = item.source_roles ? item.source_roles.split(/[,\s]+/) : [];

    // Check if trying to ACTIVATE an expired item
    if (newStatus && item.expires_at) {
      const now = new Date();
      const expiresAt = new Date(item.expires_at);
      if (expiresAt < now) {
        // Item has expired - delete it and return error
        await client.query('DELETE FROM user_inventory WHERE id = $1', [inventoryId]);
        await client.query('COMMIT');
        return { success: false, error: 'This item has expired and has been removed.' };
      }
    }

    // Check if SYNC item (admin-granted) - these can't be toggled by user
    if (item.source === 'SYNC') {
      await client.query('ROLLBACK');
      return { success: false, error: 'Admin-granted items cannot be manually activated/deactivated.' };
    }

    // === CLEAN SLATE LOGIC ===
    // Any interaction (Equip OR Unequip) on a categorized item triggers a full category wipe first
    if (item.category_id) {
      // Get ALL active items in this category (including the clicked one)
      const allCategoryItems = await client.query(
        `SELECT i.id, s.role_id
             FROM user_inventory i
             JOIN shop_items s ON i.shop_item_id = s.id
             WHERE i.user_id = $1 AND i.guild_id = $2 
             AND s.category_id = $3 AND i.is_active = true
             AND i.expires_at IS NULL`,
        [userId, guildId, item.category_id]
      );

      // Wipe ALL - remove all roles and mark as unequipped
      for (const catItem of allCategoryItems.rows) {
        await client.query('UPDATE user_inventory SET is_active = false WHERE id = $1', [catItem.id]);

        if (catItem.role_id) {
          const catRoles = catItem.role_id.split(/[,\s]+/);
          for (const rid of catRoles) {
            try { await member.roles.remove(rid); } catch (e) { }
          }
        }
      }
    }

    // === APPLY ACTION ===
    if (newStatus) {
      // User clicked ACTIVATE -> After wipe, add this item's role
      for (const rid of roles) {
        try { await member.roles.add(rid); } catch (e) { }
      }
      await client.query('UPDATE user_inventory SET is_active = true WHERE id = $1', [inventoryId]);
    } else {
      // User clicked DEACTIVATE -> After wipe, user is left with nothing (already wiped above)
      // For standalone items (no category), just remove the role
      if (!item.category_id) {
        for (const rid of roles) {
          try { await member.roles.remove(rid); } catch (e) { }
        }
      }
      await client.query('UPDATE user_inventory SET is_active = false WHERE id = $1', [inventoryId]);
    }

    await client.query('COMMIT');

    // LOGGING
    const action = newStatus ? 'Equipped' : 'Unequipped';
    const logName = `${member.displayName} (${member.user.username})`;
    sendLog(member.guild, 'inventory', 'blue', `🎒 Item ${action}`, `**${logName}** ${action.toLowerCase()} **${item.name}**.`);

    return { success: true, is_active: newStatus, name: item.name, action: newStatus ? 'activated' : 'deactivated' };

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Activate/Deactivate toggle error:', error);
    return { success: false, error: 'Failed to toggle item.' };
  } finally {
    client.release();
  }
}

/**

    // Refund coins
    await client.query(
      `UPDATE user_balances SET balance = balance + $1, total_earned = total_earned + $1 WHERE user_id = $2 AND guild_id = $3`,
      [refundAmount, userId, guildId]
    );

    // Log transaction
    await client.query(
      `INSERT INTO transactions (user_id, guild_id, amount, balance_after, type, description)
       VALUES ($1, $2, $3, (SELECT balance FROM user_balances WHERE user_id = $1 AND guild_id = $2), 'sell', $4)`,
      [userId, guildId, refundAmount, `Sold item: ${item.name}`]
    );

    await client.query('COMMIT');
    return { success: true, refundAmount, name: item.name };

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Sell item error:', error);
    return { success: false, error: 'Failed to sell item.' };
  } finally {
    client.release();
  }
}

/**
 * Check and remove expired items
 */
export async function cleanupExpiredItems(client) {
  try {
    // Get all expired items
    const expiredResult = await query(
      `SELECT i.*, m.role_id as item_role_id
       FROM user_inventory i
       LEFT JOIN shop_items m ON i.shop_item_id = m.id
       WHERE i.expires_at IS NOT NULL 
       AND i.expires_at < NOW()`,
      []
    );

    if (expiredResult.rows.length === 0) return [];

    let cleaned = 0;

    for (const item of expiredResult.rows) {
      // 1. Remove role from Discord FIRST (so we don't lose track of it if DB fails, though unlikely)
      try {
        const guild = await client.guilds.fetch(item.guild_id).catch(() => null);
        if (guild) {
          const member = await guild.members.fetch(item.user_id).catch(() => null);
          if (member) {
            const roleIdToRemove = item.role_id || item.item_role_id;
            if (roleIdToRemove) {
              await member.roles.remove(roleIdToRemove);
            }
          }
        }
      } catch (e) {
        // Log but continue to delete from DB so we don't loop forever on a missing user/role
        logSystemError(`Failed to remove expired role for user ${item.user_id}: ${e.message}`);
      }

      // 2. Delete from DB
      await query(
        'DELETE FROM user_inventory WHERE id = $1',
        [item.id]
      );

      // Log with guild name and username if available
      const guildName = guild?.name || item.guild_id;
      const username = member?.user?.username || item.user_id;
      logSystemEvent(`[${guildName}] ${username} — Expired item removed`);
      cleaned++;
    }

    if (cleaned > 0) {
      logSystemEvent(`Cleaned up ${cleaned} expired inventory items`);
    }

    return expiredResult.rows;
  } catch (error) {
    logSystemError(`Failed to clean up expired items: ${sanitizeError(error)}`);
    return [];
  }
}
