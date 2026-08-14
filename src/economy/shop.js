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
export async function getShopItems(guildId, categoryId = null, sortBy = 'price', includeInactive = false, excludeLocked = false) {
  try {
    let sql = `SELECT si.*, sc.name as category_name 
               FROM shop_items si
               LEFT JOIN shop_categories sc ON si.category_id = sc.id
               WHERE si.guild_id = $1`;
    const params = [guildId];

    if (!includeInactive) {
      sql += ' AND si.is_active = true';
    }

    if (excludeLocked) {
      sql += ' AND (si.is_tradable IS TRUE OR si.is_tradable IS NULL)';
    }

    if (categoryId !== null) {
      if (categoryId === 'null' || categoryId === 'none' || categoryId === 'uncategorized') {
        sql += ' AND si.category_id IS NULL';
      } else {
        params.push(categoryId);
        sql += ` AND si.category_id = $${params.length}`;
      }
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
 * Get items eligible for loot boxes / chests / random drops.
 * STRICT RULE: Locked items (is_tradable = false) are NEVER included in loot boxes.
 *
 * @param {string} guildId - Discord Guild ID
 * @returns {Promise<Array>} Array of active, unlocked shop items eligible for loot boxes
 */
export async function getLootBoxPool(guildId) {
  return getShopItems(guildId, null, 'price', false, true);
}

/**
 * Get a specific shop item
 */
export async function getShopItem(itemId, guildId = null) {
  try {
    const numId = parseInt(itemId, 10);
    if (isNaN(numId)) return null;

    let result;
    if (guildId) {
      result = await query(
        'SELECT * FROM shop_items WHERE id = $1 AND guild_id = $2',
        [numId, String(guildId)]
      );
    } else {
      result = await query(
        'SELECT * FROM shop_items WHERE id = $1',
        [numId]
      );
    }

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
export async function addShopItem(guildId, categoryId, roleId, name, description, price, durationSeconds = null, stock = null, itemType = 'role', contents = [], requiredItems = [], defaultImageUrl = null, rarity = 'common', isTradable = true) {
  try {
    // Map itemType to is_pack
    const isPack = itemType === 'pack';
    // contents should be JSON stringified if passed as array, or handled by pg driver if JSONB
    const contentsJson = JSON.stringify(contents || []);

    const result = await query(
      `INSERT INTO shop_items (guild_id, category_id, role_id, name, description, price, duration_seconds, stock, item_type, is_pack, contents, required_items, is_active, default_image_url, rarity, is_tradable)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true, $13, $14, $15)
       RETURNING *`,
      [guildId, categoryId, roleId, name, description, price ?? null, durationSeconds, stock, itemType, isPack, contentsJson, JSON.stringify(requiredItems || []), defaultImageUrl || null, rarity, isTradable]
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
export async function updateShopItem(itemId, updates, guildId = null) {
  try {
    const numId = parseInt(itemId, 10);
    if (isNaN(numId)) throw new Error(`Invalid item ID: ${itemId}`);

    const allowedFields = ['name', 'description', 'price', 'duration_seconds', 'stock', 'is_active', 'role_id', 'category_id', 'item_type', 'is_pack', 'contents', 'required_items', 'default_image_url', 'rarity', 'is_tradable'];
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
    values.push(numId);

    let whereClause = `WHERE id = $${paramIndex}`;
    if (guildId) {
      paramIndex++;
      whereClause += ` AND guild_id = $${paramIndex}`;
      values.push(String(guildId));
    }

    const result = await query(
      `UPDATE shop_items SET ${setClauses.join(', ')} ${whereClause} RETURNING *`,
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
export async function deleteShopItem(itemId, guildId = null) {
  try {
    const numId = parseInt(itemId, 10);
    if (isNaN(numId)) return false;

    if (guildId) {
      await query('DELETE FROM user_inventory WHERE shop_item_id = $1 AND guild_id = $2', [numId, String(guildId)]);
      await query('DELETE FROM shop_items WHERE id = $1 AND guild_id = $2', [numId, String(guildId)]);
    } else {
      await query('DELETE FROM user_inventory WHERE shop_item_id = $1', [numId]);
      await query('DELETE FROM shop_items WHERE id = $1', [numId]);
    }

    sysLog('Shop Item Deleted', { detail: `ItemID: ${numId}` });
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
 * Cleans up inventory for a user who has left the server.
 * Called from the guildMemberRemove event handler.
 * Marks all their active inventory records as inactive (does NOT delete them —
 * historical records are preserved for admin auditing).
 *
 * @param {string} userId  - The departed user's ID
 * @param {string} guildId - The guild they left
 */
export async function cleanupDepartedMember(userId, guildId) {
  try {
    await query(
      `UPDATE user_inventory SET is_active = false
       WHERE user_id = $1 AND guild_id = $2 AND is_active = true`,
      [userId, guildId]
    );
    sysLog('Member Leave Cleanup', { user: userId, guild: guildId, detail: 'Inventory deactivated on member leave' });
  } catch (error) {
    sysError('Member Leave Cleanup Failed', error, { user: userId, guild: guildId });
  }
}

/**
 * Startup reconciliation: fetches all current guild members and deactivates
 * inventory records for users who left while the bot was offline.
 * Runs once per guild on bot ready — safe to call in background.
 *
 * @param {Guild} guild - The Discord.js Guild object
 */
export async function reconcileGuildInventory(guild) {
  try {
    // Fetch all current guild members
    const members = await guild.members.fetch();
    const memberIds = new Set(members.keys());

    // Find all user_ids that have active inventory records in this guild
    const result = await query(
      `SELECT DISTINCT user_id FROM user_inventory
       WHERE guild_id = $1 AND is_active = true`,
      [guild.id]
    );

    const departed = result.rows
      .map(r => r.user_id)
      .filter(uid => !memberIds.has(uid));

    if (departed.length === 0) return;

    // Deactivate inventory for all departed users in one query
    await query(
      `UPDATE user_inventory SET is_active = false
       WHERE guild_id = $1 AND user_id = ANY($2::text[]) AND is_active = true`,
      [guild.id, departed]
    );

    sysLog('Startup Inventory Reconciliation', {
      guild: guild.id,
      detail: `Deactivated inventory for ${departed.length} users who left while offline`
    });
  } catch (error) {
    sysError('Startup Inventory Reconciliation Failed', error, { guild: guild.id });
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
  const { sellerId = '0', payoutAmount = 0, skipBalanceDeduction = false, overridePrice = null, quantity = 1 } = options;
  // qty is the validated integer quantity the user wants to buy (always >= 1)
  const qty = Math.max(1, Math.floor(Number(quantity) || 1));
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

    // Check stock (must have enough for the full requested quantity)
    if (item.stock !== null && item.stock < qty) {
      await client.query('ROLLBACK');
      sysLog('Purchase Attempt Failed', { user: userId, guild: guildId, detail: `Item: ${item.name} | Reason: Out of stock (need ${qty}, have ${item.stock})` });
      return { success: false, error: item.stock <= 0 ? 'Item out of stock' : `Only ${item.stock} left in stock.` };
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
    const isLocked = item.is_tradable === false;

    // ========== LOCKED ITEM RULES ==========
    // Locked items operate the old way: max 1 copy per user, no bulk purchase.
    if (isLocked) {
      // Lock user's inventory rows to prevent concurrent spam purchases (no aggregate with FOR UPDATE!)
      const lockedCheck = await client.query(
        `SELECT id, COALESCE(quantity, 1) as quantity
         FROM user_inventory
         WHERE user_id = $1 AND guild_id = $2 AND shop_item_id = $3
         FOR UPDATE`,
        [userId, guildId, itemId]
      );
      const lockedTotal = lockedCheck.rows.reduce((sum, r) => sum + (parseInt(r.quantity) || 1), 0);
      if (lockedTotal >= 1) {
        await client.query('ROLLBACK');
        sysLog('Purchase Attempt Failed', { user: userId, guild: guildId, detail: `Item: ${item.name} | Reason: Locked item already owned (qty: ${lockedTotal})` });
        return { success: false, error: 'You already have that item.' };
      }
    }

    // ========== TEMP ITEM CHECK ==========
    // Temporary items can be stacked (multiple inactive copies in inventory).
    // We no longer block buying if an inactive temp exists — the user can buy more and stack durations.
    if (isTemp) {
      const activeTemp = await client.query(
        `SELECT id, expires_at FROM user_inventory 
         WHERE user_id = $1 AND guild_id = $2 AND shop_item_id = $3 AND is_active = true AND expires_at > NOW()`,
        [userId, guildId, itemId]
      );
      // If already active, only block if also Locked (Locked+Temp = strict 1 copy)
      if (activeTemp.rows.length > 0 && isLocked) {
        await client.query('ROLLBACK');
        sysLog('Purchase Attempt Failed', { user: userId, guild: guildId, detail: `Item: ${item.name} | Reason: Locked temporary item already active` });
        return { success: false, error: 'Wait for the item to expire before buying it again.' };
      }
    }

    // ========== UNLOCKED ITEMS: 999 CAP CHECK ==========
    // Prevents integer overflow or runaway stacking.
    if (!isLocked && item.item_type !== 'pack') {
      const capCheck = await client.query(
        `SELECT id, COALESCE(quantity, 1) as quantity
         FROM user_inventory
         WHERE user_id = $1 AND guild_id = $2 AND shop_item_id = $3
         FOR UPDATE`,
        [userId, guildId, itemId]
      );
      const currentTotal = capCheck.rows.reduce((sum, r) => sum + (parseInt(r.quantity) || 1), 0);
      if (currentTotal + qty > 999) {
        await client.query('ROLLBACK');
        const remaining = 999 - currentTotal;
        sysLog('Purchase Attempt Failed', { user: userId, guild: guildId, detail: `Item: ${item.name} | Reason: 999 cap exceeded (have ${currentTotal}, want ${qty})` });
        return { success: false, error: remaining > 0 ? `You can only hold up to 999 copies. You can buy ${remaining} more.` : 'You have reached the maximum of 999 copies of this item.' };
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
    // Total cost is effectivePrice * qty for unlocked bulk purchases.
    // Locked items always use qty=1 (enforced above).
    const totalCost = isLocked ? effectivePrice : effectivePrice * qty;

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

      if (currentBalance < totalCost) {
        await client.query('ROLLBACK');
        sysLog('Purchase Attempt Failed', { user: userId, guild: guildId, detail: `Item: ${item.name} | Reason: Insufficient funds (Bal: ${currentBalance}, Req: ${totalCost})` });
        sendLog(member.guild, 'shop', 'red', '❌ Purchase Failed', `**${getUserLogName(member)}** tried to buy **${qty > 1 ? `${qty}x ` : ''}${item.name}** but has insufficient funds.\n• Required: **${totalCost.toLocaleString()}** ${COIN_EMOJI}\n• Balance: **${currentBalance.toLocaleString()}** ${COIN_EMOJI}`);
        return { success: false, error: 'Insufficient balance' };
      }
    }

    // ========== STEP 4: Handle Inventory & Contents (Add FIRST) ==========

    // Define helper to add item to inventory using UPSERT quantity stacking.
    // For packs and locked items, always inserts a new row (no stacking).
    // For unlocked items, increments quantity on an existing inactive row, or inserts new.
    const addToInventory = async (targetItem, purchaseSource = 'shop', addQty = 1) => {
      const isActive = false;
      const expiresAt = null;
      const targetIsLocked = targetItem.is_tradable === false;

      // Packs and locked items: always insert a new row (no quantity stacking)
      if (targetIsLocked || targetItem.item_type === 'pack') {
        const res = await client.query(
          `INSERT INTO user_inventory (
              user_id, guild_id, shop_item_id, role_id, expires_at,
              purchase_source, is_active, source, quantity
            )
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'SHOP', 1)
             RETURNING *`,
          [userId, guildId, targetItem.id, targetItem.role_id, expiresAt, purchaseSource, isActive]
        );
        return { inventoryItem: res.rows[0], isActive };
      }

      // Unlocked items: UPSERT — increment quantity on the existing inactive row (no active/expires_at row)
      // INSERT ... ON CONFLICT is not suitable here since there's no unique constraint on (user_id, shop_item_id).
      // Instead, SELECT the existing inactive row first, then UPDATE or INSERT.
      const existing = await client.query(
        `SELECT id FROM user_inventory
         WHERE user_id = $1 AND guild_id = $2 AND shop_item_id = $3
           AND expires_at IS NULL
         ORDER BY is_active DESC LIMIT 1`,
        [userId, guildId, targetItem.id]
      );

      if (existing.rows.length > 0) {
        // Increment existing inactive stack
        const res = await client.query(
          `UPDATE user_inventory
           SET quantity = COALESCE(quantity, 1) + $1, purchase_source = $2, purchased_at = NOW()
           WHERE id = $3
           RETURNING *`,
          [addQty, purchaseSource, existing.rows[0].id]
        );
        return { inventoryItem: res.rows[0], isActive: false };
      }

      // No existing inactive row — insert new
      const res = await client.query(
        `INSERT INTO user_inventory (
            user_id, guild_id, shop_item_id, role_id, expires_at,
            purchase_source, is_active, source, quantity
          )
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'SHOP', $8)
           RETURNING *`,
        [userId, guildId, targetItem.id, targetItem.role_id, expiresAt, purchaseSource, isActive, addQty]
      );
      return { inventoryItem: res.rows[0], isActive };
    };

    // Add Main Item — pass the full requested qty (locked always uses 1 enforced above)
    const { isActive: mainActive } = await addToInventory(item, 'shop', isLocked ? 1 : qty);

    // Handle Pack Contents — grant ALL bundled items (quantity stacking applies per item)
    // Locked items inside a pack still obey the 1-copy rule.
    if (packInfo && packInfo.missingIds.length > 0) {
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
        // If content item is Locked, check if user already owns 1 copy before adding
        if (contentItem.is_tradable === false) {
          const lockCheck = await client.query(
            `SELECT COALESCE(SUM(COALESCE(quantity, 1)), 0) as total FROM user_inventory
             WHERE user_id = $1 AND guild_id = $2 AND shop_item_id = $3`,
            [userId, guildId, contentItem.id]
          );
          if (parseInt(lockCheck.rows[0]?.total || 0) >= 1) {
            sysLog('Pack Locked Skip', { user: userId, guild: guildId, detail: `Skipping locked item "${contentItem.name}" — already owned` });
            skippedCount++;
            continue;
          }
        }
        await addToInventory(contentItem, 'pack', 1);
      }
      if (skippedCount > 0) {
        packInfo.skippedCount = skippedCount;
      }
    } else if (!packInfo && item.contents && Array.isArray(item.contents) && item.contents.length > 0) {
      // Non-pack item with contents (fallback)
      const contentIds = item.contents;
      const contentItemsRes = await client.query(
        `SELECT * FROM shop_items WHERE id = ANY($1) AND guild_id = $2`,
        [contentIds, guildId]
      );

      for (const contentItem of contentItemsRes.rows) {
        if (contentItem.role_id) {
          const firstRoleId = contentItem.role_id.split(/[,\s]+/)[0];
          if (!member.guild.roles.cache.has(firstRoleId)) {
            sysLog('Pack Sync Notice', { user: userId, guild: guildId, detail: `Skipping ghost item "${contentItem.name}" in content chain` });
            continue;
          }
        }
        await addToInventory(contentItem, 'pack', 1);
      }
    }

    // ========== STEP 5: Deduct Coins (Charge SECOND) ==========
    let newBalance = currentBalance - totalCost;

    if (!skipBalanceDeduction) {
      // Atomic non-negative guard
      if (newBalance < 0) {
        await client.query('ROLLBACK');
        sysLog('Purchase Rejection', { user: userId, guild: guildId, detail: `Item: ${item.name} | Reason: Atomic balance fault check` });
        return { success: false, error: 'Transaction rejected: Negative balance protection.' };
      }

      await client.query(
        `UPDATE user_balances 
         SET balance = $1, total_spent = total_spent + $2, updated_at = NOW()
         WHERE user_id = $3 AND guild_id = $4`,
        [newBalance, totalCost, userId, guildId]
      );

      const itemLabel = qty > 1 ? `${qty}x ${item.name}` : item.name;
      await client.query(
        `INSERT INTO transactions (user_id, guild_id, amount, balance_after, type, description, reference_id)
         VALUES ($1, $2, $3, $4, 'purchase', $5, $6)`,
        [userId, guildId, -totalCost, newBalance, `Purchased: ${itemLabel}`, itemId.toString()]
      );
    } else {
      const balResult = await client.query(
        'SELECT balance FROM user_balances WHERE user_id = $1 AND guild_id = $2',
        [userId, guildId]
      );
      newBalance = parseInt(balResult.rows[0]?.balance || 0);
    }

    // Update stock — decrement by qty
    if (item.stock !== null) {
      const effectiveQty = isLocked ? 1 : qty;
      await client.query(
        'UPDATE shop_items SET stock = stock - $1, updated_at = NOW() WHERE id = $2',
        [effectiveQty, itemId]
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
    const buyerAfter = buyerBefore - totalCost;
    const itemLabel = (isLocked ? 1 : qty) > 1 ? `${qty}x ${item.name}` : item.name;
    const lockedTag = isLocked ? ' (Locked)' : '';

    sysLog('Purchase Success', { 
      user: userId, 
      guild: guildId, 
      detail: `Item: ${itemLabel}${lockedTag} | Paid: ${totalCost} | New Bal: ${newBalance}` 
    });

    // 1. Buyer Log [Discord]
    sendLog(member.guild, 'shop', 'green', '🛒 Item Purchased', 
      `**User:** \`${buyerLogName}\`\n` +
      `**Item:** \`${itemLabel}\`${lockedTag ? ` \`${lockedTag.trim()}\`` : ''}\n` +
      `**Price:** \`${totalCost.toLocaleString()}\` ${COIN_EMOJI}\n` +
      `**Balance:** \`${buyerBefore.toLocaleString()}\` ➡️ \`${buyerAfter.toLocaleString()}\``
    );

    // 2. Seller Log (Dual Receipt)
    if (hasSeller && payoutAmount > 0) {
      const sellerMember = await member.guild.members.fetch(sellerId).catch(() => null);
      const sellerLogName = sellerMember ? getUserLogName(sellerMember) : `Unknown (${sellerId})`;
      const sellerAfter = sellerBefore + payoutAmount;

      sendLog(member.guild, 'shop', 'green', '💰 Item Sold (Payout)', 
        `**User:** \`${sellerLogName}\`\n` +
        `**Item:** \`${itemLabel}\` (Sold)\n` +
        `**Payout:** \`${payoutAmount.toLocaleString()}\` ${COIN_EMOJI}\n` +
        `**Balance:** \`${sellerBefore.toLocaleString()}\` ➡️ \`${sellerAfter.toLocaleString()}\``
      );
    }

    return {
      success: true,
      newBalance,
      item,
      quantity: isLocked ? 1 : qty,
      pricePaid: totalCost,
      packInfo: packInfo
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
export async function dropItem(userId, guildId, invId, member, dropQty = 1) {
  const pool = getPool();
  const client = await pool.connect();

  // Validate drop quantity
  const qty = Math.max(1, Math.floor(Number(dropQty) || 1));

  try {
    await client.query('BEGIN');

    // 1. Fetch and lock the inventory row
    const invRes = await client.query(
      `SELECT ui.*, si.name, si.role_id, si.is_tradable 
       FROM user_inventory ui
       JOIN shop_items si ON ui.shop_item_id = si.id
       WHERE ui.id = $1 AND ui.user_id = $2 AND ui.guild_id = $3
       FOR UPDATE`,
      [invId, userId, guildId]
    );

    if (invRes.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new Error('Item not found in inventory');
    }

    const item = invRes.rows[0];
    const currentQty = parseInt(item.quantity) || 1;

    if (item.is_tradable === false) {
      await client.query('ROLLBACK');
      throw new Error('This item is locked and cannot be dropped');
    }

    const availableToDrop = item.expires_at ? Math.max(0, currentQty - 1) : currentQty;
    if (qty > availableToDrop) {
      await client.query('ROLLBACK');
      throw new Error(`You can only drop up to ${availableToDrop} unactivated cop${availableToDrop === 1 ? 'y' : 'ies'} of this item.`);
    }

    // 2. Calculate remaining quantity after the drop
    const remainingQty = currentQty - qty;

    // 3. Role removal — only strip role if the user's total remaining quantity across ALL rows hits 0
    //    (they may have another active copy we should not strip)
    const totalRemainingRes = await client.query(
      `SELECT COALESCE(SUM(COALESCE(quantity, 1)), 0) - $1 as remaining
       FROM user_inventory
       WHERE user_id = $2 AND guild_id = $3 AND shop_item_id = $4`,
      [qty, userId, guildId, item.shop_item_id]
    );
    const totalRemaining = parseInt(totalRemainingRes.rows[0]?.remaining || 0);
    const shouldRemoveRole = totalRemaining <= 0;

    if (shouldRemoveRole && item.role_id) {
      const rIds = item.role_id.split(/[,\s]+/);
      const botMember = member.guild.members.me;

      for (const rId of rIds) {
        const role = member.guild.roles.cache.get(rId);
        if (role) {
          if (role.comparePositionTo(botMember.roles.highest) >= 0) {
            await client.query('ROLLBACK');
            throw new Error(`❌ Failed to drop item: I cannot remove the role "${role.name}" due to hierarchy permissions.`);
          }
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

    // 4. Decrement or delete the inventory row
    if (remainingQty <= 0) {
      await client.query('DELETE FROM user_inventory WHERE id = $1', [invId]);
    } else {
      await client.query(
        'UPDATE user_inventory SET quantity = $1 WHERE id = $2',
        [remainingQty, invId]
      );
    }

    // 5. Create Drop Record with quantity
    const dropRes = await client.query(
      `INSERT INTO dropped_items (guild_id, dropper_id, shop_item_id, status, quantity)
       VALUES ($1, $2, $3, 'available', $4)
       RETURNING id`,
      [guildId, userId, item.shop_item_id, qty]
    );

    // 6. Dependency Sweep
    await runDependencySweep(userId, guildId, member, client);

    await client.query('COMMIT');

    const itemLabel = qty > 1 ? `${qty}x ${item.name}` : item.name;
    sysLog('Item Dropped', { user: userId, guild: guildId, detail: `Item: ${itemLabel} | DropID: ${dropRes.rows[0].id} | Remaining: ${totalRemaining}` });

    return { 
      success: true, 
      item: item,
      quantity: qty,
      dropId: dropRes.rows[0].id,
      roleRemoved: shouldRemoveRole
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
    const claimedQty = parseInt(drop.quantity) || 1;

    // 2. Rules Verification
    // [Self-Claiming Enabled]: Droppers can now claim their own items.
    // NOTE: We no longer block claiming if the user already owns copies — quantity stacking is allowed.
    // Locked items dropped before being locked are still claimable (legacy grace).

    // 3. Join Date Gate (anti-cheat)
    const guildConfigRes = await client.query('SELECT config FROM guild_configs WHERE guild_id = $1', [guildId]);
    const config = guildConfigRes.rows[0]?.config || {};
    const joinGateEnabled = config.anti_cheat_join_date_gate ?? false;
    
    if (joinGateEnabled && member?.joinedAt) {
      const daysInServer = (Date.now() - member.joinedAt.getTime()) / (1000 * 60 * 60 * 24);
      if (daysInServer < 7) {
        await client.query('ROLLBACK');
        throw new Error('You must be a member of the server for at least 7 days to claim dropped items.');
      }
    }

    // 4. Acquisition — UPSERT into claimer's inventory stack
    const existingClaim = await client.query(
      `SELECT id FROM user_inventory
       WHERE user_id = $1 AND guild_id = $2 AND shop_item_id = $3
         AND expires_at IS NULL
       ORDER BY is_active DESC LIMIT 1`,
      [claimerId, guildId, drop.shop_item_id]
    );

    if (existingClaim.rows.length > 0) {
      await client.query(
        'UPDATE user_inventory SET quantity = COALESCE(quantity, 1) + $1 WHERE id = $2',
        [claimedQty, existingClaim.rows[0].id]
      );
    } else {
      await client.query(
        `INSERT INTO user_inventory (user_id, guild_id, shop_item_id, role_id, is_active, source, quantity)
         VALUES ($1, $2, $3, $4, false, 'SHOP', $5)`,
        [claimerId, guildId, drop.shop_item_id, drop.role_id, claimedQty]
      );
    }

    // 5. Finalize Drop record
    await client.query(
      "UPDATE dropped_items SET status = 'claimed', claimer_id = $1 WHERE id = $2",
      [claimerId, dropId]
    );

    await client.query('COMMIT');

    const itemLabel = claimedQty > 1 ? `${claimedQty}x ${drop.name}` : drop.name;
    sysLog('Item Claimed', { user: claimerId, guild: guildId, detail: `Item: ${itemLabel} | From Drop: ${dropId}` });

    return { 
      success: true, 
      item: drop,
      quantity: claimedQty,
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
      `SELECT i.*, s.name, s.description, s.item_type, s.is_pack, s.role_id, s.category_id, s.price, s.is_tradable, s.rarity
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

    // Self-heal any broken chest inventory rows with missing shop_item_id
    await query(`
      UPDATE user_inventory ui
      SET shop_item_id = si.id,
          role_id = si.role_id,
          source = 'LEVEL',
          purchase_source = 'level'
      FROM shop_items si
      WHERE ui.user_id = $1 AND ui.guild_id = $2
        AND ui.shop_item_id IS NULL
        AND ui.role_id LIKE 'CHEST_%'
        AND si.loot_box_id = NULLIF(SUBSTRING(ui.role_id FROM 7), '')::INTEGER
        AND si.guild_id = ui.guild_id
    `, [userId, guildId]).catch(() => {});

    // ========== EVENT-DRIVEN PURGE (Lazy Evaluation) ==========
    await purgeUserInventory(userId, guildId, member);

    const inventory = await query(
      `SELECT ui.*, si.name, si.role_id, si.price, si.item_type, si.is_pack, si.category_id, si.required_items, si.default_image_url, si.is_tradable, si.rarity, si.loot_box_id
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

    // Sync any missing claimed level rewards (items or chests)
    try {
      const claimedChests = await query(
        `SELECT upc.level_claimed, bc.reward_chest_id, si.id AS shop_item_id, si.role_id
         FROM user_pass_claims upc
         JOIN battlepass_config bc ON bc.guild_id = upc.guild_id AND bc.level = upc.level_claimed
         JOIN shop_items si ON si.loot_box_id = bc.reward_chest_id AND si.guild_id = upc.guild_id
         WHERE upc.user_id = $1 AND upc.guild_id = $2 AND bc.reward_chest_id IS NOT NULL`,
        [userId, guildId]
      );

      for (const chest of claimedChests.rows) {
        const exists = await query(
          `SELECT id, quantity FROM user_inventory WHERE user_id = $1 AND guild_id = $2 AND shop_item_id = $3`,
          [userId, guildId, chest.shop_item_id]
        );
        if (exists.rows.length === 0) {
          await query(
            `INSERT INTO user_inventory (user_id, guild_id, shop_item_id, role_id, is_active, source, purchase_source, quantity)
             VALUES ($1, $2, $3, $4, false, 'LEVEL', 'level', 1)`,
            [userId, guildId, chest.shop_item_id, chest.role_id]
          );
          // If another level chest had absorbed its quantity from an earlier null merge, decrement it
          await query(
            `UPDATE user_inventory
             SET quantity = quantity - 1
             WHERE user_id = $1 AND guild_id = $2 AND source = 'LEVEL' AND quantity > 1 AND shop_item_id != $3`,
            [userId, guildId, chest.shop_item_id]
          );
        }
      }
    } catch {}

    // Auto-consolidate any duplicate permanent item rows for the user
    const permanentItemMap = new Map();
    const rowsToDelete = [];
    const consolidatedRows = [];

    for (const row of inventory.rows) {
      if (row.expires_at !== null || !row.shop_item_id) {
        consolidatedRows.push(row);
        continue;
      }
      const key = `${row.shop_item_id}`;
      if (!permanentItemMap.has(key)) {
        permanentItemMap.set(key, row);
        consolidatedRows.push(row);
      } else {
        const primaryRow = permanentItemMap.get(key);
        primaryRow.quantity = (parseInt(primaryRow.quantity) || 1) + (parseInt(row.quantity) || 1);
        if (!primaryRow.is_active && row.is_active) {
          primaryRow.is_active = true;
        }
        rowsToDelete.push(row.id);
      }
    }

    if (rowsToDelete.length > 0) {
      for (const delId of rowsToDelete) {
        await query(`DELETE FROM user_inventory WHERE id = $1`, [delId]);
      }
      for (const primaryRow of permanentItemMap.values()) {
        await query(`UPDATE user_inventory SET quantity = $1, is_active = $2 WHERE id = $3`, [primaryRow.quantity, primaryRow.is_active, primaryRow.id]);
      }
    }

    return consolidatedRows;
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
          // Item has expired since last interaction - decrement quantity or purge if 1 left
          const currentQty = parseInt(item.quantity) || 1;
          if (currentQty > 1) {
            await client.query('UPDATE user_inventory SET quantity = quantity - 1, expires_at = NULL, is_active = false WHERE id = $1', [inventoryId]);
          } else {
            await client.query('DELETE FROM user_inventory WHERE id = $1', [inventoryId]);
          }
          // Clean roles just in case
          if (item.source_roles) {
             const rIds = item.source_roles.split(/[,\s]+/);
             for (const rId of rIds) {
               try { await member.roles.remove(rId, 'Item Expired'); } catch (e) {}
             }
          }
          await client.query('COMMIT');
          return { 
            success: false, 
            error: currentQty > 1 
              ? `This consumable item expired. 1 copy was consumed (${currentQty - 1} remaining in inventory).` 
              : 'This item has expired and has been removed.' 
          };
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
    // 1. Fetch expired items belonging to this user
    const expiredQuery = await query(
      `SELECT i.id, i.shop_item_id, i.role_id, COALESCE(i.quantity, 1) as quantity
       FROM user_inventory i
       WHERE i.user_id = $1 AND i.guild_id = $2
       AND i.expires_at IS NOT NULL 
       AND i.expires_at < NOW()`,
      [userId, guildId]
    );

    if (expiredQuery.rows.length === 0) return 0;

    const expiredItems = expiredQuery.rows;
    const itemIds = expiredItems.map(i => i.shop_item_id);
    const shopItems = await query(`SELECT id, name FROM shop_items WHERE id = ANY($1)`, [itemIds]);
    const nameMap = Object.fromEntries(shopItems.rows.map(s => [s.id, s.name]));

    for (const item of expiredItems) {
      const itemName = nameMap[item.shop_item_id] || 'Unknown Item';
      const currentQty = parseInt(item.quantity) || 1;

      // 2. Decrement quantity by 1 if quantity > 1, or DELETE if quantity <= 1
      if (currentQty > 1) {
        await query(
          `UPDATE user_inventory 
           SET quantity = quantity - 1, expires_at = NULL, is_active = false 
           WHERE id = $1`,
          [item.id]
        );
      } else {
        await query(`DELETE FROM user_inventory WHERE id = $1`, [item.id]);
      }

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
      sysLog('Item Expired', { user: userId, guild: guildId, detail: `Item: ${itemName} | Quantity Remaining: ${currentQty - 1} | Reason: Lazy Purge` });
      
      try {
        const remainingNotice = currentQty > 1 ? ` (1 copy consumed, ${currentQty - 1} remaining in inventory)` : '';
        sendLog(
          { id: guildId, name: member?.guild?.name || 'Server' }, 
          'inventory', 
          'red', 
          '⏳ Item Expired', 
          `**${member?.user?.username || userId}**'s consumable item **${itemName}** has expired${remainingNotice}.`
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
