import { query, getPool } from '../storage/postgres.js';
export { query };
import { sanitizeError, COIN_EMOJI, getUserLogName } from '../shared.js';
import { updateBalance } from './service.js';
// D-04 FIX: Removed unused imports (logAudit, createRefund, getBoosterLossPolicy)
import { isMemberBooster } from '../commands/colors.js';
import { logServerEvent, logSystemError, sendLog, sendBulkLog, sysLog, sysError } from '../utils/logger.js';

/**
 * Get the display image for a shop item.
 * Returns the item's default_image_url if set, otherwise null.
 * Use this everywhere an item image is needed so fallback logic is centralised.
 * @param {object|null} item - A shop_items row
 * @returns {string|null}
 */
export function getItemImage(item) {
  return item?.default_image_url || null;
}

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
    sysError('Role Uniqueness Check Failed', error, { guild: guildId });
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
      sql += ' ORDER BY si.price ASC NULLS LAST';
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
    sysError('Pack Price Calculation Failed', error, { user: userId, guild: guildId });
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
    sysError('Item Usage Count Failed', error);
    return 0;
  }
}

/**
 * Add a new item to the shop
 */
export async function addShopItem(guildId, categoryId, roleId, name, description, price, durationSeconds = null, stock = null, itemType = 'role', contents = [], requiredItems = [], defaultImageUrl = null) {
  try {
    // Map itemType to is_pack
    const isPack = itemType === 'pack';
    // contents should be JSON stringified if passed as array, or handled by pg driver if JSONB
    const contentsJson = JSON.stringify(contents || []);

    const result = await query(
      `INSERT INTO shop_items (guild_id, category_id, role_id, name, description, price, duration_seconds, stock, item_type, is_pack, contents, required_items, is_active, default_image_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true, $13)
       RETURNING *`,
      [guildId, categoryId, roleId, name, description, price ?? null, durationSeconds, stock, itemType, isPack, contentsJson, JSON.stringify(requiredItems || []), defaultImageUrl || null]
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
    const allowedFields = ['name', 'description', 'price', 'duration_seconds', 'stock', 'is_active', 'role_id', 'category_id', 'item_type', 'is_pack', 'contents', 'required_items', 'default_image_url'];
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
      sysError('Update Shop Item Rejected', 'No valid fields to update', { detail: `Item: ${itemId}` });
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

    sysLog('Shop Item Deleted', { detail: `ItemID: ${itemId}` });
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
    return { met: true, missingItemIds: [], missingBooster: false, missingMvp: false };
  }

  const pool = client || getPool();
  const userId = member.user.id;
  const missingItemIds = [];
  let missingBooster = false;
  let missingMvp = false;

  for (const req of requiredItems) {
    // 1. Booster Role Check (Live Status)
    if (typeof req === 'string' && req.startsWith('booster:')) {
      const roleId = req.split(':')[1];
      if (!member.roles.cache.has(roleId)) {
        missingBooster = true;
      }
      continue;
    }

    // 1.5. MVP Role Exemption Check (In-Memory Cache — Single Source of Truth)
    if (typeof req === 'string' && req.startsWith('mvp:')) {
      const reqRoleId = req.split(':')[1];
      
      try {
        const { getGuildConfig } = await import('../storage/config.js');
        const config = await getGuildConfig(guildId);
        
        // Failsafe Auto-Unlinking: If the MVP requirement on the item doesn't match the current
        // guild setting, the admin changed/deleted the MVP role. Bypass the requirement.
        if (!config || config.mvpRoleId !== reqRoleId) {
          continue; 
        }

        // Use the in-memory KotH cache for an O(1) real-time check
        const { isUserMvp } = await import('../mvp/mvpCache.js');
        if (!isUserMvp(guildId, userId)) {
          missingMvp = true;
        }
      } catch (error) {
        sysError('MVP Prereq Check Failed', error, { user: userId, guild: guildId });
        missingMvp = true; 
      }
      continue;
    }

  // 2. Standard Item Check (Inventory Ownership)
  if (Number.isInteger(req)) {
    // SELF-HEALING: Verify item still exists in shop_items
    const itemExists = await pool.query('SELECT 1 FROM shop_items WHERE id = $1', [req]);
    if (itemExists.rowCount === 0) {
      sysLog('Self-Healing Prereq', { guild: guildId, detail: `Ghost prerequisite detected: Item ${req} no longer exists. Skipping.` });
      continue;
    }

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

  const met = missingItemIds.length === 0 && !missingBooster && !missingMvp;
  return { met, missingItemIds, missingBooster, missingMvp };
}

/**
 * Helper: Format comprehensive prerequisite error messages
 */
export async function formatPrerequisiteError(prereqs, guildId) {
  const { missingItemIds, missingBooster, missingMvp } = prereqs;
  
  if (missingMvp) {
    if (missingBooster && missingItemIds.length === 0) return 'This item requires you to be the Active Server MVP and a Server Booster. 🏆🚀';
    if (missingItemIds.length === 0) return 'This item requires you to be the Active Server MVP. 🏆';
  }

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
    // Ignore any IDs that couldn't be found (Ghost items)
    const names = itemNamesRes.rows
      .filter(r => r && r.name)
      .map(r => `**${r.name}**`);
    
    if (names.length === 0) {
      // All missing items were ghost items
      itemMessage = '';
    } else {
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
  }

    if (missingBooster) {
      // Scenario C: Hybrid
      return `${itemMessage}${itemMessage ? ' AND ' : ''}be an active **Server Booster** 🚀.`;
    } else {
      // Scenario B: Items Only
      return itemMessage ? `${itemMessage}.` : 'Requirement not met.';
    }
}

/**
 * Self-Healing: Removes a specific item ID from the required_items JSONB array
 * of all shop items in a guild. Used when an item is deleted or deactivated.
 */
export async function scrubPrerequisiteFromGuild(guildId, itemId) {
  try {
    const itemIntId = typeof itemId === 'string' ? parseInt(itemId) : itemId;
    
    // SQL: Use jsonb_agg to rebuild the array without the specified ID
    // This works reliably for JSONB arrays of numbers
    const res = await query(
      `UPDATE shop_items 
       SET required_items = (
         SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
         FROM jsonb_array_elements(required_items) elem
         WHERE (elem::text)::int != $1
       )
       WHERE guild_id = $2 
       AND required_items @> $1::text::jsonb`,
      [itemIntId, guildId]
    );

    if (res.rowCount > 0) {
      sysLog('Self-Healing Scrub', { guild: guildId, detail: `Scrubbed item ${itemIntId} from ${res.rowCount} prerequisite lists` });
    }
    return res.rowCount;
  } catch (error) {
    sysError('Self-Healing Scrub Failed', error, { guild: guildId, detail: `ItemID: ${itemId}` });
    return 0;
  }
}

/**
 * Strict Dependency Sweep:
 * Checks ALL active items for a user and uneclips anything that no longer meets prerequisites.
 * Triggered after drops, trades, or losing booster status.
 */
export async function runDependencySweep(userId, guildId, member, client = null) {
  const pool = client || getPool();
  const unequippedNames = [];

  try {
    // 1. Fetch all currently active items
    const activeItems = await pool.query(
      `SELECT ui.id, si.id as shop_item_id, si.name, si.role_id, si.required_items 
       FROM user_inventory ui
       JOIN shop_items si ON ui.shop_item_id = si.id
       WHERE ui.user_id = $1 AND ui.guild_id = $2 AND ui.is_active = true`,
      [userId, guildId]
    );

    if (activeItems.rows.length === 0) return [];

    // 2. Re-verify each active item
    for (const item of activeItems.rows) {
      const prereqs = await checkPrerequisites(member, guildId, item.required_items, pool);
      
      if (!prereqs.met) {
        // Requirement lost -> Unequip
        await pool.query('UPDATE user_inventory SET is_active = false WHERE id = $1', [item.id]);

        if (item.role_id) {
          const roles = item.role_id.split(/[,\s]+/);
          for (const rid of roles) {
            try { await member.roles.remove(rid, 'Requirement no longer met (Dependency Sweep)'); } catch (e) { }
          }
        }
        unequippedNames.push(item.name);
        sysLog('Dependency Unequip', { user: userId, guild: guildId, detail: `Item: ${item.shop_item_id} (${item.name}) due to lost prereqs` });
      }
    }

    // 3. Log Results
    if (unequippedNames.length > 0) {
      sendLog(member.guild, 'inventory', 'orange', '⛓️ Dependency Cascade', 
        `**${member.user.username}** had items unequipped because requirements were no longer met:\n` +
        `• Items: ${unequippedNames.map(n => `**${n}**`).join(', ')}`
      );
    }

    return unequippedNames;
  } catch (error) {
    sysError('Dependency Sweep Failed', error, { user: userId, guild: guildId });
    return [];
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
  const { sellerId = '0', payoutAmount = 0, skipBalanceDeduction = false, overridePrice = null } = options;
  const pool = getPool();
  const client = await pool.connect();
  let transactionId = null;

  try {
    await client.query('BEGIN');

    // ========== EVENT-DRIVEN PURGE (Lazy Evaluation) ==========
    await purgeUserInventory(userId, guildId, member);

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
      sysLog('Purchase Attempt Failed', { user: userId, guild: guildId, detail: `ItemID: ${itemId} | Reason: Item not found` });
      return { success: false, error: 'Item not found' };
    }

    const item = itemResult.rows[0];

    // Define effectivePrice (Check for admin override from button first)
    let effectivePrice = (overridePrice !== null && overridePrice !== undefined) ? Number(overridePrice) : item.price;

    // ========== NULL-PRICE GUARD ==========
    // Use effectivePrice for the safety check. Hard-block if no global or button price exists.
    if (effectivePrice === null || effectivePrice === undefined) {
      await client.query('ROLLBACK');
      sysLog('Purchase Blocked', { user: userId, guild: guildId, detail: `Item: ${item.name} | Reason: Price not set` });
      return { success: false, error: 'This item does not have a price set yet. Contact an admin.' };
    }

    // ========== PREREQUISITE CHECK (Informational Only) ==========
    // We NO LONGER block purchases based on prerequisites.
    // Why? Because all items are added as UNEQUIPPED/DEACTIVATED.
    // Requirements are strictly enforced when the user tries to ACTIVATE/EQUIP the item in their inventory.
    // This allows users to buy packs or "stock up" on items they plan to use later.
    // However, we still log a warning if they don't meet them yet.
    const audit = await checkPrerequisites(member, guildId, item.required_items, client);
    if (!audit.met) {
      const errorMsg = await formatPrerequisiteError(audit, guildId);
      sysLog('Purchase Prereq Warning', { user: userId, guild: guildId, detail: `Item: ${item.name} | Missing: ${errorMsg}` });
    }

    // Check if item is active
    if (!item.is_active) {
      await client.query('ROLLBACK');
      sysLog('Purchase Attempt Failed', { user: userId, guild: guildId, detail: `Item: ${item.name} | Reason: Inactive` });
      return { success: false, error: 'This item is no longer available' };
    }

    // Check stock
    if (item.stock !== null && item.stock <= 0) {
      await client.query('ROLLBACK');
      sysLog('Purchase Attempt Failed', { user: userId, guild: guildId, detail: `Item: ${item.name} | Reason: Out of stock` });
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

    // Define effectivePrice (Check for admin override first)

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
    // Check if item is currently active in DB (expires_at > NOW) or exists inactive/unequipped
    // We do this BEFORE role check so we give the correct status message
    if (isTemp) {
      const activeTemp = await client.query(
        `SELECT id, expires_at FROM user_inventory 
                  WHERE user_id = $1 AND guild_id = $2 AND shop_item_id = $3`,
        [userId, guildId, itemId]
      );

      if (activeTemp.rows.length > 0) {
        const hasActive = activeTemp.rows.some(r => r.expires_at && new Date(r.expires_at) > new Date());
        const hasInactive = activeTemp.rows.some(r => !r.expires_at);

        if (hasActive) {
          await client.query('ROLLBACK');
          sysLog('Purchase Attempt Failed', { user: userId, guild: guildId, detail: `Item: ${item.name} | Reason: Already active temporary item` });
          return { success: false, error: 'Wait for the item to expire before buying it again.' };
        }

        if (hasInactive) {
          await client.query('ROLLBACK');
          sysLog('Purchase Attempt Failed', { user: userId, guild: guildId, detail: `Item: ${item.name} | Reason: Inactive temporary item exists` });
          return { success: false, error: 'You already have this item in your inventory. Please equip it first!' };
        }
      }
    }

    // ========== REAL-TIME ROLE CHECK ==========
    // Check if user ALREADY HAS the role (even if admin-granted, not in DB)
    // This prevents buying items they already own via Discord role
      // Discovery Logic Removed: We no longer write Admin-granted items to the DB.
    // They are now synthesized live in the view layer (bank.js).
    if (item.role_id) {
      const firstRoleId = item.role_id.split(/[,\s]+/)[0];
      if (member.roles.cache.has(firstRoleId)) {
        await client.query('ROLLBACK');
        sysLog('Purchase Attempt Failed', { user: userId, guild: guildId, detail: `Item: ${item.name} | Reason: Role already owned in Discord` });
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
        sysLog('Purchase Attempt Failed', { user: userId, guild: guildId, detail: `Item: ${item.name} | Reason: Already owned in Database` });
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
        sysLog('Purchase Attempt Failed', { user: userId, guild: guildId, detail: `Pack: ${item.name} | Reason: All contents already owned` });
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

      // Full price (or override) - no discount for partial ownership
      effectivePrice = (overridePrice !== null && overridePrice !== undefined) ? Number(overridePrice) : item.price;

      // Check roles of MISSING contents for safety (only check what we're adding)
      const contentItemsRes = await client.query(
        `SELECT role_id FROM shop_items WHERE id = ANY($1) AND guild_id = $2`,
        [missingIds, guildId]
      );

      for (const cItem of contentItemsRes.rows) {
        if (cItem.role_id && !checkRoleSafety(cItem.role_id)) {
          await client.query('ROLLBACK');
          sysLog('Purchase Attempt Failed', { user: userId, guild: guildId, detail: `Pack: ${item.name} | Reason: Hierarchy restriction on content role ${cItem.role_id}` });
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
        sysLog('Purchase Attempt Failed', { user: userId, guild: guildId, detail: `Item: ${item.name} | Reason: Insufficient funds (Bal: ${currentBalance}, Req: ${effectivePrice})` });
        sendLog(member.guild, 'shop', 'red', '❌ Purchase Failed', `**${getUserLogName(member)}** tried to buy **${item.name}** but has insufficient funds.\n• Required: **${effectivePrice.toLocaleString()}** ${COIN_EMOJI}\n• Balance: **${currentBalance.toLocaleString()}** ${COIN_EMOJI}`);
        return { success: false, error: 'Insufficient balance' };
      }
    }

    // ========== STEP 4: Handle Inventory & Contents (Add FIRST) ==========

    // Define helper to add item to inventory (Consumable Mode: Deactivated by default, no timer)
    const addToInventory = async (targetItem, purchaseSource = 'shop') => {
      // RULE: All new acquisitions enter DEACTIVATED with NO expires_at (Stasis)
      const isActive = false;
      const expiresAt = null;

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
            sysLog('Pack Sync Notice', { user: userId, guild: guildId, detail: `Skipping ghost item "${contentItem.name}" in pack ${item.name}` });
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
            sysLog('Pack Sync Notice', { user: userId, guild: guildId, detail: `Skipping ghost item "${contentItem.name}" in content chain` });
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
        sysLog('Purchase Rejection', { user: userId, guild: guildId, detail: `Item: ${item.name} | Reason: Atomic balance fault check` });
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
      
      sysLog('Seller Payout Executed', { user: sellerId, guild: guildId, detail: `Amount: ${payoutAmount} | Item: ${item.name} | From: ${userId}` });
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
          sysLog('Role Granted', { user: userId, guild: guildId, detail: `RoleID: ${rid} | Reason: TEMP Item ${item.name}` });
        } catch (e) {
          sysError('Role Grant Failed', e, { user: userId, guild: guildId, detail: `RoleID: ${rid} | Item: ${item.name}` });
        }
      }
    }
    // Permanent items: No role granted here - user must equip from inventory

    // ========== DISCORD LOGS (Dual Receipt) ==========
    const buyerLogName = getUserLogName(member);
    const buyerAfter = buyerBefore - effectivePrice;
    
    // Final Success Log
    sysLog('Purchase Success', { 
      user: userId, 
      guild: guildId, 
      detail: `Item: ${item.name} | Paid: ${effectivePrice} | New Bal: ${newBalance}` 
    });

    // 1. Buyer Log [Discord]
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
    sysError('Purchase Critical Failure', error, { user: userId, guild: guildId, detail: `ItemID: ${itemId}` });
    return { success: false, error: 'Purchase failed due to an error.' };
  } finally {
    client.release();
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

    // 2. Role removal (STRICT: Try to remove Discord roles FIRST)
    // If we can't remove the role, we MUST NOT delete the item from the DB.
    if (item.role_id) {
      const rIds = item.role_id.split(/[,\s]+/);
      const botMember = member.guild.members.me;
      
      for (const rId of rIds) {
        const role = member.guild.roles.cache.get(rId);
        if (role) {
          // Check Hierarchy
          if (role.comparePositionTo(botMember.roles.highest) >= 0) {
            await client.query('ROLLBACK');
            throw new Error(`❌ Failed to drop item: I cannot remove the role "${role.name}" due to hierarchy permissions.`);
          }

          // Strict removal
          try {
            await member.roles.remove(role);
          } catch (err) {
            await client.query('ROLLBACK');
            sysError('Drop Role Removal Failed', err, { user: userId, guild: guildId, detail: `RoleID: ${role.id}` });
            throw new Error(`❌ Failed to drop item: Internal error removing your role.`);
          }
        }
      }
    }

    // 3. Database Wipe (Only after roles are successfully confirmed gone)
    await client.query('DELETE FROM user_inventory WHERE id = $1', [invId]);

    // 4. Create Drop Record (Expires after 24 hours)
    const dropRes = await client.query(
      `INSERT INTO dropped_items (guild_id, dropper_id, shop_item_id, status)
       VALUES ($1, $2, $3, 'available')
       RETURNING id`,
      [guildId, userId, item.shop_item_id]
    );

    // 5. Dependency Sweep (Unequip items that lost requirements)
    await runDependencySweep(userId, guildId, member, client);

    await client.query('COMMIT');

    sysLog('Item Dropped', { user: userId, guild: guildId, detail: `Item: ${item.name} | DropID: ${dropRes.rows[0].id}` });

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

    // ========== EVENT-DRIVEN PURGE (Lazy Evaluation) ==========
    await purgeUserInventory(claimerId, guildId, member);

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
    // [Self-Claiming Enabled]: Droppers can now claim their own items.

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

    sysLog('Item Claimed', { user: claimerId, guild: guildId, detail: `Item: ${drop.name} | From Drop: ${dropId}` });

    return { 
      success: true, 
      item: drop,
      dropped_at: drop.created_at
    };
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

// D-02 FIX: Removed dead function syncInventoryRoleState (superseded by syncInventoryWithDiscord)

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
    // ONE-TIME CLEANUP: Purge legacy 'SYNC' items once to fix existing ghosts
    // Admin-granted items are now synthesized live at the view layer.
    await query(`DELETE FROM user_inventory WHERE source = 'SYNC' AND guild_id = $1`, [guildId]);

    // ========== EVENT-DRIVEN PURGE (Lazy Evaluation) ==========
    await purgeUserInventory(userId, guildId, member);

    const inventory = await query(
      `SELECT ui.*, si.name, si.role_id, si.price, si.item_type, si.is_pack, si.category_id, si.required_items, si.default_image_url
       FROM user_inventory ui
       LEFT JOIN shop_items si ON ui.shop_item_id = si.id
       WHERE ui.user_id = $1 AND ui.guild_id = $2`,
      [userId, guildId]
    );

    const botMember = member.guild.members.me;

    // Rule Verification: Ensure roles match the 'is_active' state in DB
    // Re-fetch member to get latest role cache from Discord (avoids race conditions)
    const freshMember = await member.guild.members.fetch(userId).catch(() => member);

    for (const invItem of inventory.rows) {
      if (!invItem.role_id || invItem.item_type === 'pack' || invItem.is_pack) continue;
      const firstRoleId = invItem.role_id.split(/[,\s]+/)[0];
      const role = freshMember.guild.roles.cache.get(firstRoleId);
      if (!role) continue;

      const hasRole = freshMember.roles.cache.has(firstRoleId);
      const shouldHaveRole = invItem.is_active === true;

      // Only perform role movement if bot is high enough
      if (role.comparePositionTo(botMember.roles.highest) < 0) {
        if (shouldHaveRole && !hasRole) {
          // Admin likely removed the role manually - respect it and unequip in DB
          await query(`UPDATE user_inventory SET is_active = false WHERE id = $1`, [invItem.id]);
          invItem.is_active = false;
        } else if (!shouldHaveRole && hasRole) {
          // User has role but DB says unequipped (likely admin granted)
          // If they own it, just mark it as Equipped (Auto-Sync)
          await query(`UPDATE user_inventory SET is_active = true WHERE id = $1`, [invItem.id]);
          invItem.is_active = true;
        }
      }
    }

    // Final Domino Sweep (Ensures manual role removals/admin changes respect dependencies)
    await runDependencySweep(userId, guildId, freshMember);

    return inventory.rows;
  } catch (error) {
    sysError('Inventory Sync Error', error, { user: userId, guild: guildId });
    return [];
  }
}

/**
 * Unified Helper: Fetch DB inventory and synthesize live Admin-Granted items (State C)
 * Ensures consistency between Main Menu counts, Category Lists, and Item Management.
 */
export async function getSynthesizedInventory(userId, guildId, member) {
  if (!member) return [];

  // 1. Fetch DB Items (Owned/Purchased)
  const dbInventory = await syncInventoryWithDiscord(userId, guildId, member);
  const dbShopIds = new Set(dbInventory.map(i => i.shop_item_id));

  // 2. Fetch Shop Items to check for live Role-based items (Admin Granted)
  const allShopItems = await getShopItems(guildId, null, 'name', true);
  const adminItems = [];

  for (const shopItem of allShopItems) {
    if (!shopItem.role_id) continue;
    const firstRoleId = shopItem.role_id.split(/[,\s]+/)[0];

    // State C: User has the role in Discord but doesn't own it in the DB
    if (member.roles.cache.has(firstRoleId) && !dbShopIds.has(shopItem.id)) {
      adminItems.push({
        ...shopItem,
        id: `admin_${shopItem.id}`, // Virtual ID for State Anchoring
        shop_item_id: shopItem.id,
        source: 'SYNC',
        is_active: true, // Always active for roles
        price: 0,
        purchased_at: new Date()
      });
    }
  }

  // Final Merged List
  return [...dbInventory, ...adminItems];
}

// D-03 FIX: Removed dead function cleanupOrphanedInventory (never called from any module)

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

    // Log removal in God-Mode console
    if (shopResult.rowCount > 0) {
      sysLog('Ghost Cleanup Executed', { guild: guild.id, detail: `Removed ${shopResult.rowCount} items, ${inventoryResult.rowCount} inventory entries, updated ${packsUpdated} packs. Items: ${ghostItemNames.join(', ')}` });
    }

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

    // 2. Deactivate in user_inventory (Soft delete to preserve logs)
    const inventoryResult = await query(
      `UPDATE user_inventory SET is_active = false WHERE shop_item_id = ANY($1)`,
      [itemIds]
    );

    // 3. Deactivate in shop_items
    const shopResult = await query(
      `UPDATE shop_items SET is_active = false, updated_at = NOW() WHERE id = ANY($1)`,
      [itemIds]
    );

    // 4. Scrub from other items' prerequisites
    for (const itemId of itemIds) {
      await scrubPrerequisiteFromGuild(guildId, itemId);
    }

    sysLog('Role Deletion Purge', { guild: guildId, detail: `RoleID: ${roleId} | Purged: ${shopResult.rowCount} items | Reason: Role deleted` });

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

    // Get item details including source and category type
    const result = await client.query(
      `SELECT i.*, s.role_id as source_roles, s.category_id, s.name, s.item_type, s.required_items, sc.category_type
       FROM user_inventory i
       JOIN shop_items s ON i.shop_item_id = s.id
       LEFT JOIN shop_categories sc ON s.category_id = sc.id
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

    // ========== CONSUMABLE TIMER LOGIC ==========
    // Check if this is a temporary item
    const durationSeconds = item.duration_seconds;
    const isTemp = !!durationSeconds && durationSeconds > 0;

    if (newStatus && isTemp) {
      // Trying to ACTIVATE a temporary item
      if (!item.expires_at) {
        // FIRST ACTIVATION: Start the timer now
        const expiresAt = new Date(Date.now() + durationSeconds * 1000);
        await client.query('UPDATE user_inventory SET expires_at = $1 WHERE id = $2', [expiresAt, inventoryId]);
        sysLog('Timer Started', { user: userId, guild: guildId, detail: `Consumable: ${item.name} | Duration: ${durationSeconds}s` });
      } else {
        // RE-ACTIVATION (Timer already running)
        // Check if actually expired
        const expiresAt = new Date(item.expires_at);
        if (expiresAt < new Date()) {
          // Item has expired since last interaction - purge it
          await client.query('DELETE FROM user_inventory WHERE id = $1', [inventoryId]);
          // Clean roles just in case
          if (item.source_roles) {
             const rIds = item.source_roles.split(/[,\s]+/);
             for (const rId of rIds) {
               try { await member.roles.remove(rId, 'Item Expired'); } catch (e) {}
             }
          }
          await client.query('COMMIT');
          return { success: false, error: 'This item has expired and has been removed.' };
        }
      }
    }

    // Unstoppable Timer Rule: If newStatus is false (UNEQUIP), 
    // we remove the roles but LEAVE expires_at alone. The clock keeps ticking.

    // Check if SYNC item (admin-granted) - these can't be toggled by user
    if (item.source === 'SYNC') {
      await client.query('ROLLBACK');
      return { success: false, error: 'Admin-granted items cannot be manually activated/deactivated.' };
    }

    // === CLEAN SLATE LOGIC (ONLY FOR SWAP/SINGLE CATEGORIES) ===
    // If the category is set to 'Single' (category_type = 1), we unequip everything else first.
    if (item.category_id && item.category_type === 1 && newStatus) {
      // Get ALL active items in this category (excluding the clicked one)
      // ADMIN IMMUNITY: We explicitly exclude 'SYNC' items so Admin-granted roles stay active
      const allCategoryItems = await client.query(
        `SELECT i.id, s.role_id
             FROM user_inventory i
             JOIN shop_items s ON i.shop_item_id = s.id
             WHERE i.user_id = $1 AND i.guild_id = $2 
             AND s.category_id = $3 AND i.is_active = true
             AND i.id != $4
             AND i.source != 'SYNC'`,
        [userId, guildId, item.category_id, inventoryId]
      );

      // Wipe others belonging to the same category
      for (const catItem of allCategoryItems.rows) {
        await client.query('UPDATE user_inventory SET is_active = false WHERE id = $1', [catItem.id]);

        if (catItem.role_id) {
          const catRoles = catItem.role_id.split(/[,\s]+/);
          for (const rid of catRoles) {
            try { await member.roles.remove(rid, 'Automatic unequip due to category swap'); } catch (e) { }
          }
        }
      }
    }


    // === APPLY ACTION ===
    if (newStatus) {
      // User clicked ACTIVATE -> After wipe, add this item's role
      for (const rid of roles) {
        try { await member.roles.add(rid, `Equipped item: ${item.name}`); } catch (e) { }
      }
      await client.query('UPDATE user_inventory SET is_active = true WHERE id = $1', [inventoryId]);
    } else {
      // User clicked DEACTIVATE
      // REMOVE ROLES: Always remove roles for the specific item being deactivated
      for (const rid of roles) {
        try { await member.roles.remove(rid, `Unequipped item: ${item.name}`); } catch (e) { }
      }
      await client.query('UPDATE user_inventory SET is_active = false WHERE id = $1', [inventoryId]);
    }


    await client.query('COMMIT');

    // LOGGING
    const action = newStatus ? 'Equipped' : 'Unequipped';
    
    // God-Mode System Log (Audit)
    sysLog(`Item ${action}`, { user: userId, guild: guildId, detail: `Item: ${item.name} | InventoryID: ${inventoryId}` });
    
    const logName = `${member.displayName} (${member.user.username})`;
    sendLog(member.guild, 'inventory', 'blue', `🎒 Item ${action}`, `**${logName}** ${action.toLowerCase()} **${item.name}**.`);

    return { success: true, is_active: newStatus, name: item.name, action: newStatus ? 'activated' : 'deactivated' };

  } catch (error) {
    await client.query('ROLLBACK');
    sysError('Toggle Equip Failed', error, { user: userId, guild: guildId, detail: `InventoryID: ${inventoryId}` });
    return { success: false, error: 'Failed to toggle item.' };
  } finally {
    client.release();
  }
}


/**
 * EVENT-DRIVEN PURGE (Lazy Evaluation)
 * Executes exactly when needed to ensure zero background overhead.
 * 
 * @param {string} userId - The user ID
 * @param {string} guildId - The guild ID 
 * @param {GuildMember|null} member - Discord member object (if provided, roles are stripped)
 */
export async function purgeUserInventory(userId, guildId, member = null) {
  try {
    // 1. Delete all items belonging to this user that have passed their expiration
    const result = await query(
      `DELETE FROM user_inventory 
       WHERE user_id = $1 AND guild_id = $2
       AND expires_at IS NOT NULL 
       AND expires_at < NOW()
       RETURNING id, shop_item_id, role_id`,
      [userId, guildId]
    );

    if (result.rows.length === 0) return 0;

    // 2. Fetch Item Names for logging accurately
    const expiredItems = result.rows;
    const itemIds = expiredItems.map(i => i.shop_item_id);
    const shopItems = await query(`SELECT id, name FROM shop_items WHERE id = ANY($1)`, [itemIds]);
    const nameMap = Object.fromEntries(shopItems.rows.map(s => [s.id, s.name]));

    for (const item of expiredItems) {
      const itemName = nameMap[item.shop_item_id] || 'Unknown Item';

      // 3. Strip Discord Role (Only if member is provided)
      if (member && item.role_id) {
        const roles = item.role_id.split(/[,\s]+/);
        const botMember = member.guild.members.me;

        for (const rid of roles) {
          try {
            const role = member.guild.roles.cache.get(rid);
            if (role && role.comparePositionTo(botMember.roles.highest) < 0) {
              await member.roles.remove(rid, 'Item Expired (Lazy Purge)');
            }
          } catch (e) {
            sysError('Purge Role Removal Failed', e, { user: userId, guild: guildId, detail: `RoleID: ${rid}` });
          }
        }
      }

      // 4. Log to Audit
      sysLog('Item Expired', { user: userId, guild: guildId, detail: `Item: ${itemName} | Reason: Lazy Purge` });
      
      try {
        // B-06 FIX: Corrected import path (was '../commands/bank.js', which is wrong)
        sendLog(
          { id: guildId, name: member?.guild?.name || 'Server' }, 
          'inventory', 
          'red', 
          '⏳ Item Expired', 
          `**${member?.user?.username || userId}**'s consumable item **${itemName}** has expired and was removed.`
        );
      } catch (e) {
        // Silently fail if sendLog execution fails
      }
    }

    return expiredItems.length;
  } catch (error) {
    logSystemError(`Failed to purge user inventory for ${userId}: ${sanitizeError(error)}`);
    return 0;
  }
}
