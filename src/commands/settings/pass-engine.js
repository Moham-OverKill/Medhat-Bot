/**
 * Battlepass XP Engine — Phase 2
 * Awards XP to users on activity, detects level-ups, and dispatches rewards.
 * All progress is stored in user_activity.battlepass_xp — never reset by MVP cycles.
 * Rewards are locked in user_pass_claims (permanent anti-exploit ledger).
 */
import { EmbedBuilder } from 'discord.js';
import { getPool } from '../../storage/postgres.js';
import { sysLog, sysError, sendLog } from '../../utils/logger.js';

/**
 * Total cumulative XP needed to reach Level L.
 * Level 0: 0 XP
 * Level 1: Base XP
 * Level L: L * Base + (L * (L - 1) / 2) * Increment
 */
export function getTotalXpForLevel(level, base = 100, increment = 0) {
  if (level <= 0) return 0;
  const L = Math.floor(level);
  const B = Math.max(1, parseInt(base || 100, 10));
  const I = Math.max(0, parseInt(increment || 0, 10));
  return L * B + Math.floor((L * (L - 1) * I) / 2);
}

/**
 * Given a user's total accumulated XP, calculate:
 * - currentLevel
 * - xpIntoCurrentLevel (XP earned inside current level)
 * - xpForNextLevel (XP needed to complete current level and reach next level)
 */
export function calculateLevelFromXp(totalXp, base = 100, increment = 0) {
  const B = Math.max(1, parseInt(base || 100, 10));
  const I = Math.max(0, parseInt(increment || 0, 10));
  const xp = Math.max(0, parseInt(totalXp || 0, 10));

  if (xp === 0) {
    return {
      level: 0,
      xpIntoCurrentLevel: 0,
      xpForNextLevel: B
    };
  }

  if (I === 0) {
    const level = Math.floor(xp / B);
    const xpIntoCurrentLevel = xp % B;
    return {
      level,
      xpIntoCurrentLevel,
      xpForNextLevel: B
    };
  }

  // Fast estimate via quadratic formula: (I/2)*L^2 + (B - I/2)*L - xp = 0
  const a = I;
  const b = 2 * B - I;
  const c = -2 * xp;
  const discriminant = Math.max(0, b * b - 4 * a * c);
  let level = Math.floor((-b + Math.sqrt(discriminant)) / (2 * a));
  if (level < 0) level = 0;

  // Exact bounds adjustment
  while (getTotalXpForLevel(level + 1, B, I) <= xp) {
    level++;
  }
  while (level > 0 && getTotalXpForLevel(level, B, I) > xp) {
    level--;
  }

  const xpAtCurrentLevel = getTotalXpForLevel(level, B, I);
  const xpForNext = B + level * I;
  const xpIntoCurrentLevel = xp - xpAtCurrentLevel;

  return {
    level,
    xpIntoCurrentLevel,
    xpForNextLevel: xpForNext
  };
}

/**
 * Award battlepass XP to a user and dispatch any newly unlocked level rewards.
 * Called after each message point or voice point is awarded.
 *
 * @param {string} guildId
 * @param {string} userId
 * @param {string} username
 * @param {number} xpToAdd — how many XP points to add (1 per message point or voice minute)
 * @param {object} client — Discord client, used to DM or post level-up notification
 */
export async function awardBattlepassXp(guildId, userId, username, xpToAdd, client = null) {
  if (!guildId || !userId || xpToAdd <= 0) return;

  try {
    const { getGuildConfig } = await import('../../storage/config.js');
    const config = await getGuildConfig(guildId);
    if (!config || config.battlepass_enabled !== true) return;

    if (!client) {
      const { getDiscordClient } = await import('../../activity/index.js');
      client = getDiscordClient();
    }

    const pool = getPool();

    // 1. Atomically increment battlepass_xp and return new total
    const xpResult = await pool.query(
      `INSERT INTO user_activity (guild_id, user_id, username, battlepass_xp)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (guild_id, user_id)
       DO UPDATE SET
         battlepass_xp = user_activity.battlepass_xp + $4,
         username = $3
       RETURNING battlepass_xp`,
      [guildId, userId, username, xpToAdd]
    );

    const totalXp = parseInt(xpResult.rows[0]?.battlepass_xp || 0, 10);
    if (totalXp <= 0) return;

    // 2. Calculate current level based on Base XP and Increment
    const baseXp = parseInt(config.battlepass_base_xp || config.battlepass_xp_per_level || 100, 10);
    const incrementXp = parseInt(config.battlepass_xp_increment || 0, 10);
    const { level: currentLevel } = calculateLevelFromXp(totalXp, baseXp, incrementXp);
    if (currentLevel <= 0) return;

    // 3. Load all configured levels that user could have reached
    const levelsResult = await pool.query(
      `SELECT bc.level, bc.reward_coins, bc.reward_item_id, bc.reward_chest_id,
              si.name as item_name, si.role_id as item_role_id,
              lb.name as chest_name
       FROM battlepass_config bc
       LEFT JOIN shop_items si ON bc.reward_item_id = si.id
       LEFT JOIN loot_boxes lb ON bc.reward_chest_id = lb.id
       WHERE bc.guild_id = $1 AND bc.level <= $2
       ORDER BY bc.level ASC`,
      [guildId, currentLevel]
    );

    if (levelsResult.rows.length === 0) return;

    // 4. Check which levels are already claimed
    const claimsResult = await pool.query(
      `SELECT level_claimed FROM user_pass_claims WHERE guild_id = $1 AND user_id = $2`,
      [guildId, userId]
    );
    const alreadyClaimed = new Set(claimsResult.rows.map(r => r.level_claimed));

    // 5. Dispatch rewards for each newly reached unclaimed level
    const claimedLevels = [];
    for (const levelRow of levelsResult.rows) {
      if (alreadyClaimed.has(levelRow.level)) continue;

      const claimData = await dispatchLevelReward(pool, guildId, userId, username, levelRow, client, config);
      if (claimData) {
        claimedLevels.push(claimData);
      }
    }

    // 6. Send single consolidated notification for all newly claimed levels
    if (claimedLevels.length > 0 && client) {
      await sendLevelUpNotification(client, guildId, userId, username, claimedLevels, config);
    }
  } catch (err) {
    sysError('Level XP Engine Failed', err, { guild: guildId, user: userId });
  }
}

async function dispatchLevelReward(pool, guildId, userId, username, levelRow, client, config) {
  const client2 = await pool.connect();
  try {
    await client2.query('BEGIN');

    // A. Lock the claim row first (anti-double-claim)
    const lockCheck = await client2.query(
      `SELECT 1 FROM user_pass_claims WHERE guild_id = $1 AND user_id = $2 AND level_claimed = $3`,
      [guildId, userId, levelRow.level]
    );
    if (lockCheck.rows.length > 0) {
      // Already claimed by a concurrent process
      await client2.query('ROLLBACK');
      return null;
    }

    // B. Insert claim record (prevents double-claiming permanently)
    await client2.query(
      `INSERT INTO user_pass_claims (user_id, guild_id, level_claimed) VALUES ($1, $2, $3)`,
      [userId, guildId, levelRow.level]
    );

    // C. Award coins
    const coins = parseInt(levelRow.reward_coins || 0, 10);
    if (coins > 0) {
      const balRes = await client2.query(
        `INSERT INTO user_balances (user_id, guild_id, balance, total_earned)
         VALUES ($1, $2, $3, $3)
         ON CONFLICT (user_id, guild_id)
         DO UPDATE SET
           balance = user_balances.balance + $3,
           total_earned = user_balances.total_earned + $3,
           updated_at = NOW()
         RETURNING balance`,
        [userId, guildId, coins]
      );
      const newBal = parseInt(balRes.rows[0]?.balance || coins, 10);

      await client2.query(
        `INSERT INTO transactions (user_id, guild_id, amount, balance_after, type, description)
         VALUES ($1, $2, $3, $4, 'battlepass', $5)`,
        [userId, guildId, coins, newBal, `Level ${levelRow.level} reward`]
      );

      await client2.query(
        `INSERT INTO transaction_history (user_id, guild_id, amount, type, description)
         VALUES ($1, $2, $3, 'battlepass_reward', $4)`,
        [userId, guildId, coins, `Level ${levelRow.level} reward`]
      );
    }

    // D. Award item
    if (levelRow.reward_item_id) {
      const existingItem = await client2.query(
        `SELECT id FROM user_inventory
         WHERE user_id = $1 AND guild_id = $2 AND shop_item_id = $3 AND expires_at IS NULL
         ORDER BY is_active DESC LIMIT 1`,
        [userId, guildId, levelRow.reward_item_id]
      );
      if (existingItem.rows.length > 0) {
        await client2.query(
          `UPDATE user_inventory SET quantity = COALESCE(quantity, 1) + 1 WHERE id = $1`,
          [existingItem.rows[0].id]
        );
      } else {
        await client2.query(
          `INSERT INTO user_inventory (user_id, guild_id, shop_item_id, role_id, is_active, source, purchase_source, quantity)
           VALUES ($1, $2, $3, $4, false, 'LEVEL', 'level', 1)`,
          [userId, guildId, levelRow.reward_item_id, levelRow.item_role_id || null]
        );
      }
    }

    // E. Award chest (loot box — link to paired shop_item_id)
    if (levelRow.reward_chest_id) {
      const shopItemRes = await client2.query(
        `SELECT id, role_id FROM shop_items WHERE loot_box_id = $1 AND guild_id = $2 LIMIT 1`,
        [levelRow.reward_chest_id, guildId]
      );
      const chestShopItemId = shopItemRes.rows[0]?.id;
      const chestRoleId = shopItemRes.rows[0]?.role_id || `LOOT_BOX_${levelRow.reward_chest_id}`;

      if (chestShopItemId) {
        const existingChest = await client2.query(
          `SELECT id FROM user_inventory
           WHERE user_id = $1 AND guild_id = $2 AND shop_item_id = $3 AND expires_at IS NULL
           ORDER BY is_active DESC LIMIT 1`,
          [userId, guildId, chestShopItemId]
        );
        if (existingChest.rows.length > 0) {
          await client2.query(
            `UPDATE user_inventory SET quantity = COALESCE(quantity, 1) + 1 WHERE id = $1`,
            [existingChest.rows[0].id]
          );
        } else {
          await client2.query(
            `INSERT INTO user_inventory (user_id, guild_id, shop_item_id, role_id, is_active, source, purchase_source, quantity)
             VALUES ($1, $2, $3, $4, false, 'LEVEL', 'level', 1)`,
            [userId, guildId, chestShopItemId, chestRoleId]
          );
        }
      }
    }

    await client2.query('COMMIT');

    sysLog('Level Reward Dispatched', {
      user: userId,
      guild: guildId,
      detail: `Level ${levelRow.level} | Coins: ${coins} | Item: ${levelRow.item_name || 'None'} | Chest: ${levelRow.chest_name || 'None'}`
    });

    // F. Send Discord channel audit logs
    if (client) {
      const guild = client.guilds?.cache?.get(guildId);
      if (guild) {
        if (coins > 0) {
          const { COIN_EMOJI } = await import('../../shared.js');
          const coinEmoji = COIN_EMOJI.forGuild(guildId);
          sendLog(guild, 'economy', 'green', '⭐ Level Reward', `<@${userId}> reached **Level ${levelRow.level}** and received **${coins.toLocaleString()}** ${coinEmoji}!`);
        }
        if (levelRow.item_name) {
          sendLog(guild, 'inventory', 'green', '🏷️ Level Item Reward', `<@${userId}> reached **Level ${levelRow.level}** and received **${levelRow.item_name}**!`);
        }
        if (levelRow.chest_name) {
          const { getLootBoxCategoryEmoji } = await import('../../economy/lootbox.js');
          const lootBoxEmoji = await getLootBoxCategoryEmoji(guildId);
          sendLog(guild, 'inventory', 'green', `${lootBoxEmoji} Level Chest Reward`, `<@${userId}> reached **Level ${levelRow.level}** and received **${levelRow.chest_name}**!`);
        }
      }
    }

    return {
      level: levelRow.level,
      coins,
      itemName: levelRow.item_name || null,
      chestName: levelRow.chest_name || null
    };
  } catch (err) {
    await client2.query('ROLLBACK').catch(() => {});
    sysError('Level Reward Dispatch Failed', err, { user: userId, guild: guildId, level: levelRow.level });
    return null;
  } finally {
    client2.release();
  }
}

async function sendLevelUpNotification(client, guildId, userId, username, claimedLevels, config) {
  try {
    if (!claimedLevels || claimedLevels.length === 0) return;

    const { getLootBoxCategoryEmoji } = await import('../../economy/lootbox.js');
    const { COIN_EMOJI } = await import('../../shared.js');

    const coinEmoji = COIN_EMOJI.forGuild(guildId);
    const lootBoxEmoji = await getLootBoxCategoryEmoji(guildId);
    const notifChannelId = config.battlepass_notif_channel;

    const guild = client.guilds?.cache?.get(guildId) || await client.guilds?.fetch(guildId).catch(() => null);
    const guildName = guild?.name || 'Discord Server';
    const guildIcon = guild?.iconURL?.({ dynamic: true }) || null;

    let title;
    let description;

    if (claimedLevels.length === 1) {
      const single = claimedLevels[0];
      const rewards = [];
      if (single.coins > 0) rewards.push(`${coinEmoji} **${single.coins.toLocaleString()} Coins**`);
      if (single.itemName) rewards.push(`🏷️ **${single.itemName}**`);
      if (single.chestName) rewards.push(`${lootBoxEmoji} **${single.chestName}**`);
      const rewardText = rewards.length > 0 ? rewards.join('\n• ') : '_No rewards configured for this level_';

      title = `⭐ Level Up! (Level ${single.level})`;
      description = `Congratulations <@${userId}>! You reached **Level ${single.level}**.\n\n**Rewards Unlocked:**\n• ${rewardText}`;
    } else {
      const highestLevel = Math.max(...claimedLevels.map(c => c.level));
      title = `⭐ Level Up! (Level ${highestLevel})`;

      const lines = claimedLevels.map(c => {
        const rewards = [];
        if (c.coins > 0) rewards.push(`${coinEmoji} **${c.coins.toLocaleString()} Coins**`);
        if (c.itemName) rewards.push(`🏷️ **${c.itemName}**`);
        if (c.chestName) rewards.push(`${lootBoxEmoji} **${c.chestName}**`);
        const rewardText = rewards.length > 0 ? rewards.join(' + ') : '_None_';
        return `• **Level ${c.level}:** ${rewardText}`;
      });

      description = `Congratulations <@${userId}>! You reached **Level ${highestLevel}**.\n\n**Rewards Unlocked:**\n${lines.join('\n')}`;
    }

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle(title)
      .setDescription(description)
      .setFooter({ text: guildName, iconURL: guildIcon || undefined })
      .setTimestamp();

    if (notifChannelId) {
      const channel = guild?.channels?.cache?.get(notifChannelId) || await client.channels?.fetch(notifChannelId).catch(() => null);
      if (channel?.isTextBased?.()) {
        await channel.send({ embeds: [embed] }).catch(() => {});
        return;
      }
    }

    // Fallback: DM the user
    const user = await client.users.fetch(userId).catch(() => null);
    if (user) {
      await user.send({ embeds: [embed] }).catch(() => {});
    }
  } catch (err) {
    sysError('Level Notification Failed', err, { user: userId, guild: guildId });
  }
}

/**
 * Get a user's Battlepass progress summary for /pass command
 */
export async function getUserPassProgress(guildId, userId) {
  const pool = getPool();

  const { getGuildConfig } = await import('../../storage/config.js');
  const config = await getGuildConfig(guildId) || {};
  const baseXp = parseInt(config.battlepass_base_xp || config.battlepass_xp_per_level || 100, 10);
  const incrementXp = parseInt(config.battlepass_xp_increment || 0, 10);
  const isEnabled = config.battlepass_enabled === true;

  // Get user XP
  const xpResult = await pool.query(
    `SELECT battlepass_xp, username FROM user_activity WHERE guild_id = $1 AND user_id = $2`,
    [guildId, userId]
  );
  const totalXp = parseInt(xpResult.rows[0]?.battlepass_xp || 0, 10);
  const { level: currentLevel, xpIntoCurrentLevel, xpForNextLevel } = calculateLevelFromXp(totalXp, baseXp, incrementXp);

  // Get claimed rewards
  const claimsResult = await pool.query(
    `SELECT upc.level_claimed, bc.reward_coins, bc.reward_item_id, bc.reward_chest_id,
            si.name as item_name, lb.name as chest_name
     FROM user_pass_claims upc
     LEFT JOIN battlepass_config bc ON bc.guild_id = upc.guild_id AND bc.level = upc.level_claimed
     LEFT JOIN shop_items si ON bc.reward_item_id = si.id
     LEFT JOIN loot_boxes lb ON bc.reward_chest_id = lb.id
     WHERE upc.guild_id = $1 AND upc.user_id = $2
     ORDER BY upc.level_claimed ASC`,
    [guildId, userId]
  );

  // Get next unclaimed reward
  const nextResult = await pool.query(
    `SELECT bc.level, bc.reward_coins, bc.reward_item_id, bc.reward_chest_id,
            si.name as item_name, lb.name as chest_name
     FROM battlepass_config bc
     LEFT JOIN shop_items si ON bc.reward_item_id = si.id
     LEFT JOIN loot_boxes lb ON bc.reward_chest_id = lb.id
     WHERE bc.guild_id = $1
       AND bc.level > $2
     ORDER BY bc.level ASC
     LIMIT 1`,
    [guildId, currentLevel]
  );

  return {
    isEnabled,
    totalXp,
    currentLevel,
    xpIntoCurrentLevel,
    xpForNextLevel,
    baseXp,
    incrementXp,
    claims: claimsResult.rows,
    nextReward: nextResult.rows[0] || null,
    config
  };
}
