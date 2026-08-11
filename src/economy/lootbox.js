import { getPool, query } from '../storage/postgres.js';
import { getGuildConfig } from '../storage/config.js';
import { sysLog, sysError } from '../utils/logger.js';
import { RARITY_COLORS, RARITY_EMOJIS, RARITY_DISPLAY } from '../shared.js';

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
 * Get the custom category emoji for loot boxes (default: '🎁')
 */
export async function getLootBoxCategoryEmoji(guildId) {
  if (!guildId) return '🎁';
  try {
    const config = await getGuildConfig(guildId);
    const customEmoji = config?.loot_box_category_emoji?.trim();
    return customEmoji && customEmoji.length > 0 ? customEmoji.slice(0, 32) : '🎁';
  } catch {
    return '🎁';
  }
}

/**
 * Fetch all loot boxes for a guild
 */
export async function getLootBoxes(guildId) {
  if (!guildId) return [];
  try {
    const res = await query(
      `SELECT lb.*, 
              si.id AS shop_item_id,
              si.price AS shop_price,
              si.stock AS shop_stock,
              si.is_active AS shop_active
       FROM loot_boxes lb
       LEFT JOIN shop_items si ON lb.id = si.loot_box_id
       WHERE lb.guild_id = $1
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
 * Fetch a single loot box with its full configuration and calculated drop percentages
 */
export async function getLootBox(boxId, guildId) {
  if (!boxId) return null;
  try {
    const boxRes = await query(
      `SELECT lb.*, 
              si.id AS shop_item_id, 
              si.price AS shop_price, 
              si.stock AS shop_stock, 
              si.is_active AS shop_active
       FROM loot_boxes lb
       LEFT JOIN shop_items si ON lb.id = si.loot_box_id
       WHERE lb.id = $1 ${guildId ? 'AND lb.guild_id = $2' : ''}`,
      guildId ? [boxId, guildId] : [boxId]
    );
    if (boxRes.rows.length === 0) return null;

    const box = boxRes.rows[0];

    // Parse numeric fields
    box.chance_common = parseFloat(box.chance_common) || 0;
    box.chance_uncommon = parseFloat(box.chance_uncommon) || 0;
    box.chance_rare = parseFloat(box.chance_rare) || 0;
    box.chance_epic = parseFloat(box.chance_epic) || 0;
    box.chance_legendary = parseFloat(box.chance_legendary) || 0;
    box.chance_coins = parseFloat(box.chance_coins) || 0;
    box.min_coins = parseInt(box.min_coins, 10) || 100;
    box.max_coins = parseInt(box.max_coins, 10) || 500;
    box.min_prizes = parseInt(box.min_prizes, 10) || 1;
    box.max_prizes = parseInt(box.max_prizes, 10) || 1;
    box.items_enabled = box.items_enabled !== false;
    box.coins_enabled = box.coins_enabled !== false;
    box.image_url = box.image_url ? box.image_url.trim() : null;

    // Calculate item pool weight
    box.totalItemWeight = box.chance_common + box.chance_uncommon + box.chance_rare + 
                          box.chance_epic + box.chance_legendary;

    // Calculate percentage display
    box.percentages = {
      common: box.totalItemWeight > 0 ? ((box.chance_common / box.totalItemWeight) * 100).toFixed(1) : '0.0',
      uncommon: box.totalItemWeight > 0 ? ((box.chance_uncommon / box.totalItemWeight) * 100).toFixed(1) : '0.0',
      rare: box.totalItemWeight > 0 ? ((box.chance_rare / box.totalItemWeight) * 100).toFixed(1) : '0.0',
      epic: box.totalItemWeight > 0 ? ((box.chance_epic / box.totalItemWeight) * 100).toFixed(1) : '0.0',
      legendary: box.totalItemWeight > 0 ? ((box.chance_legendary / box.totalItemWeight) * 100).toFixed(1) : '0.0',
      coins: box.chance_coins.toFixed(1)
    };

    return box;
  } catch (error) {
    sysError('LootBox Detail Fetch Failed', error, { guild: guildId, item: boxId });
    return null;
  }
}

/**
 * Create a new loot box with defaults and paired shop_items record
 */
export async function createLootBox(guildId, { name, imageUrl = null }) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const cleanName = (name || 'Mystery Chest').trim().slice(0, 100);
    const cleanImage = imageUrl ? imageUrl.trim() : null;

    // 1. Insert into loot_boxes with defaults
    const boxRes = await client.query(
      `INSERT INTO loot_boxes (
         guild_id, name, description, image_url,
         chance_common, chance_uncommon, chance_rare, chance_epic, chance_legendary,
         chance_coins, min_coins, max_coins, min_prizes, max_prizes
       )
       VALUES ($1, $2, NULL, $3, 70, 20, 10, 0, 0, 25, 100, 500, 1, 1)
       RETURNING *`,
      [guildId, cleanName, cleanImage]
    );
    const newBox = boxRes.rows[0];

    // 2. Insert paired shop_items record (item_type = 'loot_box', role_id = 'LOOT_BOX_[id]', is_tradable = true)
    const shopItemRes = await client.query(
      `INSERT INTO shop_items (
         guild_id, name, description, default_image_url, 
         item_type, role_id, is_pack, is_tradable, rarity, price, loot_box_id, is_active
       )
       VALUES ($1, $2, NULL, $3, 'loot_box', $4, false, true, 'common', NULL, $5, true)
       RETURNING *`,
      [guildId, cleanName, cleanImage, `LOOT_BOX_${newBox.id}`, newBox.id]
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
 * Update general loot box details (Name & Image) and sync paired shop_items
 */
export async function updateLootBox(boxId, guildId, { name, imageUrl }) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const cleanName = name ? name.trim().slice(0, 100) : null;
    const cleanImage = imageUrl !== undefined ? (imageUrl ? imageUrl.trim() : null) : undefined;

    const updates = [];
    const values = [boxId, guildId];
    let idx = 3;

    if (cleanName) { updates.push(`name = $${idx++}`); values.push(cleanName); }
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
      if (cleanImage !== undefined) { shopUpdates.push(`default_image_url = $${sIdx++}`); shopValues.push(cleanImage); }

      if (shopUpdates.length > 0) {
        await client.query(
          `UPDATE shop_items SET ${shopUpdates.join(', ')} WHERE loot_box_id = $1 AND guild_id = $2`,
          shopValues
        );
      }
    }

    await client.query('COMMIT');
    sysLog('LootBox Updated', { guild: guildId, item: boxId, detail: `Updated details` });
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
 * Update Rarity Drop Rates (%) for a loot box
 */
export async function updateLootBoxRarityRates(boxId, guildId, { chanceCommon, chanceUncommon, chanceRare, chanceEpic, chanceLegendary }) {
  try {
    const cCommon = Math.max(0, parseFloat(chanceCommon) || 0);
    const cUncommon = Math.max(0, parseFloat(chanceUncommon) || 0);
    const cRare = Math.max(0, parseFloat(chanceRare) || 0);
    const cEpic = Math.max(0, parseFloat(chanceEpic) || 0);
    const cLegendary = Math.max(0, parseFloat(chanceLegendary) || 0);

    const res = await query(
      `UPDATE loot_boxes 
       SET chance_common = $1, chance_uncommon = $2, chance_rare = $3, chance_epic = $4, chance_legendary = $5
       WHERE id = $6 AND guild_id = $7
       RETURNING *`,
      [cCommon, cUncommon, cRare, cEpic, cLegendary, boxId, guildId]
    );
    sysLog('LootBox Rarity Rates Updated', { guild: guildId, item: boxId, detail: `C:${cCommon} U:${cUncommon} R:${cRare} E:${cEpic} L:${cLegendary}` });
    return res.rows[0];
  } catch (error) {
    sysError('LootBox Rarity Rates Update Failed', error, { guild: guildId, item: boxId });
    throw error;
  }
}

/**
 * Update Coins Config (Chance, Min, Max) for a loot box
 */
export async function updateLootBoxCoinsConfig(boxId, guildId, { chanceCoins, minCoins, maxCoins }) {
  try {
    const cCoins = Math.max(0, parseFloat(chanceCoins) || 0);
    let minC = Math.max(0, parseInt(minCoins, 10) || 0);
    let maxC = Math.max(0, parseInt(maxCoins, 10) || 0);
    if (maxC < minC) {
      const temp = minC;
      minC = maxC;
      maxC = temp;
    }

    const res = await query(
      `UPDATE loot_boxes 
       SET chance_coins = $1, min_coins = $2, max_coins = $3
       WHERE id = $4 AND guild_id = $5
       RETURNING *`,
      [cCoins, minC, maxC, boxId, guildId]
    );
    sysLog('LootBox Coins Config Updated', { guild: guildId, item: boxId, detail: `Chance:${cCoins}% | Range:${minC}-${maxC}` });
    return res.rows[0];
  } catch (error) {
    sysError('LootBox Coins Config Update Failed', error, { guild: guildId, item: boxId });
    throw error;
  }
}

/**
 * Update Prize Count Configuration (Min/Max prizes per unbox)
 */
export async function updateLootBoxPrizeCount(boxId, guildId, { minPrizes, maxPrizes }) {
  try {
    let minP = Math.max(1, parseInt(minPrizes, 10) || 1);
    let maxP = Math.max(1, parseInt(maxPrizes, 10) || 1);
    if (maxP < minP) {
      const temp = minP;
      minP = maxP;
      maxP = temp;
    }

    const res = await query(
      `UPDATE loot_boxes 
       SET min_prizes = $1, max_prizes = $2
       WHERE id = $3 AND guild_id = $4
       RETURNING *`,
      [minP, maxP, boxId, guildId]
    );
    sysLog('LootBox Prize Count Updated', { guild: guildId, item: boxId, detail: `Prizes Range:${minP}-${maxP}` });
    return res.rows[0];
  } catch (error) {
    sysError('LootBox Prize Count Update Failed', error, { guild: guildId, item: boxId });
    throw error;
  }
}

/**
 * Toggle a feature on a loot box (items or coins)
 * Enforces the "Empty Box" failsafe: at least one feature must remain enabled.
 * If featureType === 'items' | 'rarity' | 'prizes', toggles items_enabled.
 * If featureType === 'coins', toggles coins_enabled.
 */
export async function toggleLootBoxFeature(boxId, guildId, featureType) {
  const box = await getLootBox(boxId, guildId);
  if (!box) throw new Error('Loot box not found.');

  const currentItems = box.items_enabled !== false;
  const currentCoins = box.coins_enabled !== false;

  let newItems = currentItems;
  let newCoins = currentCoins;

  if (featureType === 'items' || featureType === 'rarity' || featureType === 'prizes') {
    newItems = !currentItems;
    if (!newItems && !newCoins) {
      return { success: false, error: 'You must have at least one reward type (Items or Coins) enabled for this loot box.' };
    }
  } else if (featureType === 'coins') {
    newCoins = !currentCoins;
    if (!newItems && !newCoins) {
      return { success: false, error: 'You must have at least one reward type (Items or Coins) enabled for this loot box.' };
    }
  }

  const res = await query(
    `UPDATE loot_boxes
     SET items_enabled = $1, coins_enabled = $2
     WHERE id = $3 AND guild_id = $4
     RETURNING *`,
    [newItems, newCoins, boxId, guildId]
  );

  sysLog('LootBox Feature Toggled', {
    guild: guildId,
    item: boxId,
    detail: `Items:${newItems} Coins:${newCoins} (triggered by ${featureType})`
  });

  return { success: true, box: res.rows[0] };
}

/**
 * Delete a loot box, cascading to paired shop_items and all user inventory copies
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
      // Clean up any uncollected dropped items in chat
      await client.query(
        `DELETE FROM dropped_items WHERE shop_item_id = $1 AND guild_id = $2`,
        [shopItemId, guildId]
      ).catch(() => {});
    }

    // 3. Delete from loot_boxes
    const delRes = await client.query(
      `DELETE FROM loot_boxes WHERE id = $1 AND guild_id = $2 RETURNING *`,
      [boxId, guildId]
    );

    // 4. Ensure paired shop_item is purged
    await client.query(
      `DELETE FROM shop_items WHERE loot_box_id = $1 AND guild_id = $2`,
      [boxId, guildId]
    );

    await client.query('COMMIT');
    sysLog('LootBox Deleted', { guild: guildId, item: boxId, detail: `Deleted loot box and purged inventory copies` });
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
 * Atomic Unboxing Engine
 * 1. Locks user inventory row (FOR UPDATE) and verifies ownership (quantity >= 1)
 * 2. Deducts 1 box copy
 * 3. Rolls prize count: random integer between min_prizes and max_prizes
 * 4. For each prize:
 *    - Evaluates weighted RNG across Common, Uncommon, Rare, Epic, Legendary, and Coins
 *    - If Coins: rolls amount in [min_coins, max_coins] and credits balance
 *    - If Item Rarity: picks a random unlocked, active item in the guild of that rarity
 *      (If no items exist for that rarity, gracefully awards coins in the range)
 * 5. Returns all itemized prizes for a unified reveal message
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

    // 2. Fetch master loot box configuration
    const boxRes = await client.query(
      `SELECT * FROM loot_boxes WHERE id = $1`,
      [lootBoxId]
    );
    if (boxRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: 'Master loot box configuration no longer exists.' };
    }
    const box = boxRes.rows[0];

    const itemsEnabled = box.items_enabled !== false;
    const coinsEnabled = box.coins_enabled !== false;

    const chanceCommon = itemsEnabled ? (parseFloat(box.chance_common) || 0) : 0;
    const chanceUncommon = itemsEnabled ? (parseFloat(box.chance_uncommon) || 0) : 0;
    const chanceRare = itemsEnabled ? (parseFloat(box.chance_rare) || 0) : 0;
    const chanceEpic = itemsEnabled ? (parseFloat(box.chance_epic) || 0) : 0;
    const chanceLegendary = itemsEnabled ? (parseFloat(box.chance_legendary) || 0) : 0;
    const chanceCoins = coinsEnabled ? (parseFloat(box.chance_coins) || 0) : 0;

    const itemTiers = [];
    if (itemsEnabled) {
      if (chanceCommon > 0) itemTiers.push({ tier: 'common', weight: chanceCommon });
      if (chanceUncommon > 0) itemTiers.push({ tier: 'uncommon', weight: chanceUncommon });
      if (chanceRare > 0) itemTiers.push({ tier: 'rare', weight: chanceRare });
      if (chanceEpic > 0) itemTiers.push({ tier: 'epic', weight: chanceEpic });
      if (chanceLegendary > 0) itemTiers.push({ tier: 'legendary', weight: chanceLegendary });
    }

    const totalItemWeight = itemTiers.reduce((sum, t) => sum + t.weight, 0);

    // Safeguard: must have either active item pool or coins enabled
    if (itemsEnabled && totalItemWeight <= 0 && (!coinsEnabled || chanceCoins <= 0)) {
      await client.query('ROLLBACK');
      return { success: false, error: '⚠️ This loot box has all drop chances set to 0%. Please contact an admin.' };
    }

    const minCoins = parseInt(box.min_coins, 10) || 100;
    const maxCoins = Math.max(minCoins, parseInt(box.max_coins, 10) || 500);
    const minPrizes = itemsEnabled ? Math.max(1, parseInt(box.min_prizes, 10) || 1) : 0;
    const maxPrizes = itemsEnabled ? Math.max(minPrizes, parseInt(box.max_prizes, 10) || 1) : 0;

    // 3. Deduct 1 box copy from user inventory
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

    // 4. Fetch all available server items (active, tradable, non-pack, non-lootbox)
    const guildItemsRes = await client.query(
      `SELECT id, name, rarity, role_id, default_image_url
       FROM shop_items
       WHERE guild_id = $1 
         AND is_active = true 
         AND is_tradable = true 
         AND is_pack = false 
         AND (item_type != 'pack' AND item_type != 'loot_box' OR item_type IS NULL)`,
      [guildId]
    );
    const guildItems = guildItemsRes.rows;

    // Build items by rarity tier lookup
    const itemsByRarity = {
      common: guildItems.filter(i => (i.rarity || 'common').toLowerCase() === 'common'),
      uncommon: guildItems.filter(i => (i.rarity || '').toLowerCase() === 'uncommon'),
      rare: guildItems.filter(i => (i.rarity || '').toLowerCase() === 'rare'),
      epic: guildItems.filter(i => (i.rarity || '').toLowerCase() === 'epic'),
      legendary: guildItems.filter(i => (i.rarity || '').toLowerCase() === 'legendary')
    };

    const awardedPrizes = [];
    let totalCoinsAwarded = 0;

    // 5. Roll Items (Prize Count dictates exact number of items awarded)
    if (itemsEnabled && totalItemWeight > 0 && maxPrizes > 0) {
      const prizeCount = Math.floor(Math.random() * (maxPrizes - minPrizes + 1)) + minPrizes;

      for (let p = 0; p < prizeCount; p++) {
        const roll = Math.random() * totalItemWeight;
        let acc = 0;
        let selectedTier = itemTiers[0]?.tier || 'common';

        for (const entry of itemTiers) {
          acc += entry.weight;
          if (roll <= acc) {
            selectedTier = entry.tier;
            break;
          }
        }

        // Pick random item of selected rarity tier
        let candidates = itemsByRarity[selectedTier] || [];
        if (candidates.length === 0) {
          candidates = guildItems;
        }

        if (candidates.length > 0) {
          const wonItem = candidates[Math.floor(Math.random() * candidates.length)];

          // Stack into user_inventory (cap at 999)
          const existingInv = await client.query(
            `SELECT id, quantity FROM user_inventory 
             WHERE user_id = $1 AND guild_id = $2 AND shop_item_id = $3`,
            [userId, guildId, wonItem.id]
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
              [userId, guildId, wonItem.id, wonItem.role_id || 'NONE']
            );
          }

          // Assign Discord role if applicable
          if (member && wonItem.role_id && wonItem.role_id !== 'NONE' && wonItem.role_id !== 'LOOT_BOX' && wonItem.role_id !== 'PACK') {
            try {
              if (!member.roles.cache.has(wonItem.role_id)) {
                await member.roles.add(wonItem.role_id).catch(() => {});
              }
            } catch {}
          }

          awardedPrizes.push({
            type: 'item',
            itemId: wonItem.id,
            itemName: wonItem.name,
            rarity: selectedTier,
            roleId: wonItem.role_id,
            itemImage: wonItem.default_image_url
          });
        }
      }
    }

    // 6. Roll Coins (Independent percentage chance and range)
    if (coinsEnabled && chanceCoins > 0) {
      const coinRoll = Math.random() * 100;
      if (coinRoll <= chanceCoins) {
        const coinAmt = Math.floor(Math.random() * (maxCoins - minCoins + 1)) + minCoins;
        totalCoinsAwarded += coinAmt;
        awardedPrizes.push({
          type: 'coins',
          amount: coinAmt
        });
      }
    }

    // Credit total coins if any were awarded
    if (totalCoinsAwarded > 0) {
      await client.query(
        `INSERT INTO user_balances (user_id, guild_id, balance, total_earned)
         VALUES ($1, $2, $3, $3)
         ON CONFLICT (user_id, guild_id) DO UPDATE
         SET balance = user_balances.balance + $3, total_earned = user_balances.total_earned + $3, updated_at = NOW()`,
        [userId, guildId, totalCoinsAwarded]
      );

      await client.query(
        `INSERT INTO transactions (user_id, guild_id, amount, balance_after, type, description, reference_id)
         SELECT $1, $2, $3, balance, 'loot_box_reward', $4, $5 FROM user_balances WHERE user_id = $1 AND guild_id = $2`,
        [userId, guildId, totalCoinsAwarded, `Opened ${box.name}`, lootBoxId.toString()]
      );
    }

    await client.query('COMMIT');

    sysLog('INVENTORY Event', { 
      user: userId, 
      guild: guildId, 
      item: lootBoxId, 
      detail: `Opened ${box.name} -> Won ${awardedPrizes.length} prizes (Coins: ${totalCoinsAwarded})` 
    });

    return {
      success: true,
      remainingQty: Math.max(0, currentQty - 1),
      box: {
        id: box.id,
        name: box.name,
        image_url: box.image_url
      },
      prizes: awardedPrizes,
      totalCoins: totalCoinsAwarded
    };

  } catch (error) {
    await client.query('ROLLBACK');
    sysError('LootBox Open Failed', error, { user: userId, guild: guildId, item: inventoryRowId });
    return { success: false, error: 'Failed to open loot box. Please try again.' };
  } finally {
    client.release();
  }
}
