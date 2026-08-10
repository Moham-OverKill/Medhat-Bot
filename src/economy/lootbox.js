import { getPool, query } from '../storage/postgres.js';
import { getGuildConfig } from '../storage/config.js';
import { sysLog, sysError } from '../utils/logger.js';
import { RARITY_COLORS, RARITY_EMOJIS, RARITY_DISPLAY } from '../shared.js';

// Default base weights by rarity tier
export const RARITY_BASE_WEIGHTS = {
  common: 60,
  uncommon: 25,
  rare: 10,
  epic: 4,
  legendary: 1
};

/**
 * Get the custom category name for loot boxes (default: 'Loot Boxes')
 */
export async function getLootBoxCategoryName(guildId) {
  if (!guildId) return 'Loot Boxes';
  try {
    const config = await getGuildConfig(guildId);
    const customName = config?.loot_box_category_name?.trim();
    return customName && customName.length > 0 ? customName.slice(0, 32) : 'Loot Boxes';
  } catch {
    return 'Loot Boxes';
  }
}

/**
 * Fetch all loot boxes for a guild with item count summary
 */
export async function getLootBoxes(guildId) {
  if (!guildId) return [];
  try {
    const res = await query(
      `SELECT lb.*, 
              COUNT(lbi.id) AS item_count,
              COALESCE(SUM(lbi.weight), 0) AS total_weight,
              si.id AS shop_item_id,
              si.price AS shop_price,
              si.stock AS shop_stock,
              si.is_active AS shop_active
       FROM loot_boxes lb
       LEFT JOIN loot_box_items lbi ON lb.id = lbi.loot_box_id
       LEFT JOIN shop_items si ON lb.id = si.loot_box_id
       WHERE lb.guild_id = $1
       GROUP BY lb.id, si.id, si.price, si.stock, si.is_active
       ORDER BY lb.id ASC`,
      [guildId]
    );
    return res.rows;
  } catch (error) {
    sysError('LootBox Fetch Failed', error, { guild: guildId });
    return [];
  }
}

/**
 * Fetch a single loot box with its full reward pool
 */
export async function getLootBox(boxId, guildId) {
  if (!boxId) return null;
  try {
    const boxRes = await query(
      `SELECT lb.*, si.id AS shop_item_id, si.price AS shop_price, si.stock AS shop_stock, si.is_active AS shop_active
       FROM loot_boxes lb
       LEFT JOIN shop_items si ON lb.id = si.loot_box_id
       WHERE lb.id = $1 ${guildId ? 'AND lb.guild_id = $2' : ''}`,
      guildId ? [boxId, guildId] : [boxId]
    );
    if (boxRes.rows.length === 0) return null;

    const box = boxRes.rows[0];

    // Fetch loot pool items joined with shop_items to fetch live name, rarity, and tradability
    const itemsRes = await query(
      `SELECT lbi.*, 
              si.name AS item_name,
              si.role_id,
              si.rarity AS item_rarity,
              si.is_tradable,
              si.default_image_url AS item_image
       FROM loot_box_items lbi
       LEFT JOIN shop_items si ON lbi.shop_item_id = si.id
       WHERE lbi.loot_box_id = $1
       ORDER BY lbi.id ASC`,
      [boxId]
    );

    box.rewards = itemsRes.rows;
    box.totalWeight = itemsRes.rows.reduce((sum, r) => sum + (parseInt(r.weight) || 0), 0);
    return box;
  } catch (error) {
    sysError('LootBox Detail Fetch Failed', error, { guild: guildId, item: boxId });
    return null;
  }
}

/**
 * Create a new loot box and paired shop_items record
 */
export async function createLootBox(guildId, { name, description, imageUrl }) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const cleanName = (name || 'Mystery Chest').trim().slice(0, 100);
    const cleanDesc = description ? description.trim() : null;
    const cleanImage = imageUrl ? imageUrl.trim() : null;

    // 1. Insert into loot_boxes
    const boxRes = await client.query(
      `INSERT INTO loot_boxes (guild_id, name, description, image_url)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [guildId, cleanName, cleanDesc, cleanImage]
    );
    const newBox = boxRes.rows[0];

    // 2. Insert paired shop_items record (item_type = 'loot_box', role_id = 'LOOT_BOX', is_tradable = true)
    const shopItemRes = await client.query(
      `INSERT INTO shop_items (
         guild_id, name, description, default_image_url, 
         item_type, role_id, is_pack, is_tradable, rarity, price, loot_box_id, is_active
       )
       VALUES ($1, $2, $3, $4, 'loot_box', 'LOOT_BOX', false, true, 'common', NULL, $5, true)
       RETURNING *`,
      [guildId, cleanName, cleanDesc, cleanImage, newBox.id]
    );

    await client.query('COMMIT');
    sysLog('LootBox Created', { guild: guildId, item: newBox.id, detail: `Name: ${cleanName} | ShopItemID: ${shopItemRes.rows[0].id}` });
    return { ...newBox, shop_item_id: shopItemRes.rows[0].id };
  } catch (error) {
    await client.query('ROLLBACK');
    sysError('LootBox Creation Failed', error, { guild: guildId });
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Update an existing loot box and sync its paired shop_items record
 */
export async function updateLootBox(boxId, guildId, { name, description, imageUrl }) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const cleanName = name ? name.trim().slice(0, 100) : null;
    const cleanDesc = description !== undefined ? (description ? description.trim() : null) : undefined;
    const cleanImage = imageUrl !== undefined ? (imageUrl ? imageUrl.trim() : null) : undefined;

    // Build dynamic update for loot_boxes
    const updates = [];
    const values = [boxId, guildId];
    let idx = 3;

    if (cleanName) { updates.push(`name = $${idx++}`); values.push(cleanName); }
    if (cleanDesc !== undefined) { updates.push(`description = $${idx++}`); values.push(cleanDesc); }
    if (cleanImage !== undefined) { updates.push(`image_url = $${idx++}`); values.push(cleanImage); }

    if (updates.length > 0) {
      await client.query(
        `UPDATE loot_boxes SET ${updates.join(', ')} WHERE id = $1 AND guild_id = $2`,
        values
      );

      // Sync paired shop_items
      const shopUpdates = [];
      const shopValues = [boxId, guildId];
      let sIdx = 3;
      if (cleanName) { shopUpdates.push(`name = $${sIdx++}`); shopValues.push(cleanName); }
      if (cleanDesc !== undefined) { shopUpdates.push(`description = $${sIdx++}`); shopValues.push(cleanDesc); }
      if (cleanImage !== undefined) { shopUpdates.push(`default_image_url = $${sIdx++}`); shopValues.push(cleanImage); }

      if (shopUpdates.length > 0) {
        await client.query(
          `UPDATE shop_items SET ${shopUpdates.join(', ')} WHERE loot_box_id = $1 AND guild_id = $2`,
          shopValues
        );
      }
    }

    await client.query('COMMIT');
    sysLog('LootBox Updated', { guild: guildId, item: boxId, detail: `Updated fields: ${updates.join(', ')}` });
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    sysError('LootBox Update Failed', error, { guild: guildId, item: boxId });
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Delete a loot box, cascading to pool rewards, paired shop_items, and all user inventory copies
 */
export async function deleteLootBox(boxId, guildId) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Fetch paired shop_item_id before deletion
    const itemRes = await client.query(
      `SELECT id FROM shop_items WHERE loot_box_id = $1 AND guild_id = $2`,
      [boxId, guildId]
    );
    const shopItemId = itemRes.rows[0]?.id;

    // 2. Delete from user_inventory for this shop_item_id if exists
    if (shopItemId) {
      await client.query(
        `DELETE FROM user_inventory WHERE shop_item_id = $1 AND guild_id = $2`,
        [shopItemId, guildId]
      );
    }

    // 3. Delete from loot_boxes (cascades to loot_box_items and shop_items)
    const delRes = await client.query(
      `DELETE FROM loot_boxes WHERE id = $1 AND guild_id = $2 RETURNING *`,
      [boxId, guildId]
    );

    await client.query('COMMIT');
    sysLog('LootBox Deleted', { guild: guildId, item: boxId, detail: `Deleted loot box and cascaded inventory entries` });
    return delRes.rowCount > 0;
  } catch (error) {
    await client.query('ROLLBACK');
    sysError('LootBox Deletion Failed', error, { guild: guildId, item: boxId });
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Add a reward entry (Coins or Item) to a loot box pool
 */
export async function addLootBoxReward(boxId, guildId, { rewardType, shopItemId, coinAmount, weight }) {
  try {
    const isCoins = rewardType === 'coins';
    const cleanCoin = isCoins ? Math.max(1, parseInt(coinAmount) || 100) : 0;
    const cleanItemId = isCoins ? null : parseInt(shopItemId);
    const cleanWeight = Math.max(1, parseInt(weight) || 10);

    // Validate tradability if item
    if (!isCoins && cleanItemId) {
      const itemRes = await query(
        `SELECT is_tradable FROM shop_items WHERE id = $1 AND guild_id = $2`,
        [cleanItemId, guildId]
      );
      if (itemRes.rows.length === 0 || itemRes.rows[0].is_tradable === false) {
        throw new Error('This item is locked and cannot be added to a loot box.');
      }
    }

    const res = await query(
      `INSERT INTO loot_box_items (loot_box_id, reward_type, shop_item_id, coin_amount, weight)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [boxId, isCoins ? 'coins' : 'item', cleanItemId, cleanCoin, cleanWeight]
    );

    sysLog('LootBox Reward Added', { guild: guildId, item: boxId, detail: `Type: ${rewardType} | Target: ${isCoins ? `${cleanCoin} Coins` : `Item #${cleanItemId}`} | Weight: ${cleanWeight}` });
    return res.rows[0];
  } catch (error) {
    sysError('LootBox Reward Add Failed', error, { guild: guildId, item: boxId });
    throw error;
  }
}

/**
 * Remove a reward entry from a loot box pool
 */
export async function removeLootBoxReward(rewardId, boxId, guildId) {
  try {
    const res = await query(
      `DELETE FROM loot_box_items WHERE id = $1 AND loot_box_id = $2 RETURNING *`,
      [rewardId, boxId]
    );
    sysLog('LootBox Reward Removed', { guild: guildId, item: boxId, detail: `RewardID: ${rewardId}` });
    return res.rowCount > 0;
  } catch (error) {
    sysError('LootBox Reward Remove Failed', error, { guild: guildId, item: boxId });
    throw error;
  }
}

/**
 * Update weight on a reward entry
 */
export async function updateLootBoxRewardWeight(rewardId, boxId, weight) {
  try {
    const cleanWeight = Math.max(1, parseInt(weight) || 1);
    const res = await query(
      `UPDATE loot_box_items SET weight = $1 WHERE id = $2 AND loot_box_id = $3 RETURNING *`,
      [cleanWeight, rewardId, boxId]
    );
    return res.rows[0];
  } catch (error) {
    sysError('LootBox Weight Update Failed', error, { item: boxId });
    throw error;
  }
}

/**
 * Atomic Unboxing Engine
 * 1. Locks user inventory row (FOR UPDATE)
 * 2. Verifies ownership (quantity >= 1)
 * 3. Filters valid active loot pool items (excluding locked items)
 * 4. Deducts 1 box copy
 * 5. Rolls weighted RNG and awards prize (Coins or Item)
 */
export async function openLootBox(userId, guildId, inventoryRowId, member = null) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Lock user inventory row
    const invRes = await client.query(
      `SELECT ui.id, ui.user_id, ui.guild_id, ui.shop_item_id, ui.quantity,
              si.loot_box_id, si.name AS item_name, si.default_image_url
       FROM user_inventory ui
       JOIN shop_items si ON ui.shop_item_id = si.id
       WHERE ui.id = $1 AND ui.user_id = $2 AND ui.guild_id = $3 FOR UPDATE`,
      [inventoryRowId, userId, guildId]
    );

    if (invRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: 'Loot box not found in your inventory.' };
    }

    const invRow = invRes.rows[0];
    const currentQty = parseInt(invRow.quantity) || 1;
    if (currentQty < 1) {
      await client.query('ROLLBACK');
      return { success: false, error: 'You do not own any copies of this loot box.' };
    }

    const lootBoxId = invRow.loot_box_id;
    if (!lootBoxId) {
      await client.query('ROLLBACK');
      return { success: false, error: 'This item is not a valid loot box.' };
    }

    // 2. Fetch master loot box details and reward pool (excluding locked items)
    const boxRes = await client.query(
      `SELECT id, name, description, image_url FROM loot_boxes WHERE id = $1`,
      [lootBoxId]
    );
    if (boxRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: 'Master loot box configuration no longer exists.' };
    }
    const box = boxRes.rows[0];

    const rewardsRes = await client.query(
      `SELECT lbi.*, 
              si.name AS item_name, 
              si.role_id, 
              si.rarity, 
              si.duration_hours,
              si.duration_seconds,
              si.default_image_url AS item_image,
              si.is_tradable
       FROM loot_box_items lbi
       LEFT JOIN shop_items si ON lbi.shop_item_id = si.id
       WHERE lbi.loot_box_id = $1 
         AND (lbi.reward_type = 'coins' OR (si.id IS NOT NULL AND si.is_tradable = true))`,
      [lootBoxId]
    );

    const validRewards = rewardsRes.rows;
    const totalWeight = validRewards.reduce((sum, r) => sum + (parseInt(r.weight) || 0), 0);

    if (validRewards.length === 0 || totalWeight <= 0) {
      await client.query('ROLLBACK');
      return { success: false, error: '⚠️ This loot box currently has no active rewards configured. Please contact an admin.' };
    }

    // 3. Deduct 1 box copy from inventory
    if (currentQty > 1) {
      await client.query(
        `UPDATE user_inventory SET quantity = quantity - 1 WHERE id = $1`,
        [inventoryRowId]
      );
    } else {
      await client.query(
        `DELETE FROM user_inventory WHERE id = $1`,
        [inventoryRowId]
      );
    }

    // 4. Weighted RNG Selection
    const randomRoll = Math.floor(Math.random() * totalWeight) + 1;
    let accumulatedWeight = 0;
    let selectedReward = validRewards[0];

    for (const reward of validRewards) {
      accumulatedWeight += parseInt(reward.weight) || 0;
      if (randomRoll <= accumulatedWeight) {
        selectedReward = reward;
        break;
      }
    }

    // 5. Award Prize
    let rewardResult = {};
    if (selectedReward.reward_type === 'coins') {
      const coinAmt = parseInt(selectedReward.coin_amount) || 0;

      // Update balance
      await client.query(
        `INSERT INTO user_balances (user_id, guild_id, balance, total_earned)
         VALUES ($1, $2, $3, $3)
         ON CONFLICT (user_id, guild_id) DO UPDATE
         SET balance = user_balances.balance + $3, total_earned = user_balances.total_earned + $3, updated_at = NOW()`,
        [userId, guildId, coinAmt]
      );

      // Log transaction
      await client.query(
        `INSERT INTO transactions (user_id, guild_id, amount, balance_after, type, description, reference_id)
         SELECT $1, $2, $3, balance, 'loot_box_reward', $4, $5 FROM user_balances WHERE user_id = $1 AND guild_id = $2`,
        [userId, guildId, coinAmt, `Opened ${box.name}`, lootBoxId.toString()]
      );

      rewardResult = {
        type: 'coins',
        amount: coinAmt,
        boxName: box.name,
        boxImage: box.image_url
      };

      sysLog('INVENTORY Event', { 
        user: userId, 
        guild: guildId, 
        item: lootBoxId, 
        detail: `Opened ${box.name} -> Received ${coinAmt.toLocaleString()} Coins` 
      });
    } else {
      // Item Reward
      const wonItemId = selectedReward.shop_item_id;
      const wonItemName = selectedReward.item_name;
      const wonItemRarity = selectedReward.rarity || 'common';
      const wonRoleId = selectedReward.role_id;

      // Stack into inventory (cap at 999)
      const existingInv = await client.query(
        `SELECT id, quantity, expires_at FROM user_inventory 
         WHERE user_id = $1 AND guild_id = $2 AND shop_item_id = $3`,
        [userId, guildId, wonItemId]
      );

      if (existingInv.rows.length > 0) {
        const row = existingInv.rows[0];
        const newQty = Math.min(999, (parseInt(row.quantity) || 1) + 1);
        await client.query(
          `UPDATE user_inventory SET quantity = $1, is_active = true WHERE id = $2`,
          [newQty, row.id]
        );
      } else {
        await client.query(
          `INSERT INTO user_inventory (user_id, guild_id, shop_item_id, role_id, quantity, is_active, source)
           VALUES ($1, $2, $3, $4, 1, true, 'LOOT_BOX')`,
          [userId, guildId, wonItemId, wonRoleId || 'NONE']
        );
      }

      // Assign Discord role if applicable
      if (member && wonRoleId && wonRoleId !== 'NONE' && wonRoleId !== 'LOOT_BOX' && wonRoleId !== 'PACK') {
        try {
          if (!member.roles.cache.has(wonRoleId)) {
            await member.roles.add(wonRoleId).catch(() => {});
          }
        } catch {}
      }

      rewardResult = {
        type: 'item',
        itemId: wonItemId,
        itemName: wonItemName,
        rarity: wonItemRarity,
        roleId: wonRoleId,
        boxName: box.name,
        boxImage: box.image_url,
        itemImage: selectedReward.item_image
      };

      sysLog('INVENTORY Event', { 
        user: userId, 
        guild: guildId, 
        item: lootBoxId, 
        detail: `Opened ${box.name} -> Received [${wonItemRarity.toUpperCase()}] ${wonItemName}` 
      });
    }

    await client.query('COMMIT');
    return {
      success: true,
      remainingQty: Math.max(0, currentQty - 1),
      reward: rewardResult
    };

  } catch (error) {
    await client.query('ROLLBACK');
    sysError('LootBox Open Failed', error, { user: userId, guild: guildId, item: inventoryRowId });
    return { success: false, error: 'Failed to open loot box. Please try again.' };
  } finally {
    client.release();
  }
}
