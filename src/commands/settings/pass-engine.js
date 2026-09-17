/**
 * Battlepass XP Engine — Phase 3
 * Awards XP to users on activity, detects level-ups, and dispatches rewards.
 * All progress is stored in user_activity.battlepass_xp — never reset by MVP cycles.
 * Rewards are locked in user_pass_claims (permanent anti-exploit ledger).
 *
 * Security guarantees:
 *  - All queries are scoped by guild_id — no cross-guild data leakage.
 *  - Dangerous permission bitfield check before any role.add().
 *  - Role hierarchy check before any role.add().
 *  - Anti-double-claim lock in every dispatchLevelReward call.
 */
import { EmbedBuilder } from 'discord.js';
import { getPool } from '../../storage/postgres.js';
import { sysLog, sysError, sendLog } from '../../utils/logger.js';

// Dangerous permissions that must never be awarded via the level system
const DANGEROUS_PERMS = [
  'Administrator',
  'ManageGuild',
  'ManageRoles',
  'ManageChannels',
  'KickMembers',
  'BanMembers',
  'ManageWebhooks',
  'ManageMessages',
  'MentionEveryone',
  'ModerateMembers',
  'ViewAuditLog'
];

/**
 * Validate a Discord role for safe assignment:
 *  1. Role must not hold any dangerous permission.
 *  2. Bot's highest role must be positioned above the target role.
 *
 * Returns null on success, or an error message string on failure.
 */
export function validateRoleForAssignment(role, guild) {
  if (!role || !guild) return '⚠️ Role or guild not found.';

  // Dangerous permission check
  for (const perm of DANGEROUS_PERMS) {
    if (role.permissions.has(perm)) {
      return `⚠️ <@&${role.id}> has a dangerous permission (**${perm}**) and cannot be used as a level reward.`;
    }
  }

  // Hierarchy check
  const botHighest = guild.members.me?.roles?.highest;
  if (!botHighest || role.position >= botHighest.position) {
    return `⚠️ My bot role must be placed higher than <@&${role.id}> in the server settings to award it!`;
  }

  return null; // safe
}

/**
 * Total cumulative XP needed to reach Level L.
 * Level 0: 0 XP
 * Level 1: Base XP
 * Level L: L * Base + (L * (L - 1) / 2) * Increment
 */
export function getTotalXpForLevel(level, base = 100, increment = 50) {
  if (level <= 0) return 0;
  const L = Math.floor(level);
  const B = Math.max(1, parseInt(base ?? 100, 10));
  const I = Math.max(0, parseInt(increment ?? 50, 10));
  return L * B + Math.floor((L * (L - 1) * I) / 2);
}

/**
 * Given a user's total accumulated XP, calculate:
 * - currentLevel
 * - xpIntoCurrentLevel (XP earned inside current level)
 * - xpForNextLevel (XP needed to complete current level and reach next level)
 */
export function calculateLevelFromXp(totalXp, base = 100, increment = 50) {
  const B = Math.max(1, parseInt(base ?? 100, 10));
  const I = Math.max(0, parseInt(increment ?? 50, 10));
  const xp = Math.max(0, parseFloat(totalXp || 0));

  if (xp === 0) {
    return {
      level: 0,
      xpIntoCurrentLevel: 0,
      xpForNextLevel: B
    };
  }

  if (I === 0) {
    const level = Math.floor(xp / B);
    const xpIntoCurrentLevel = Number((xp % B).toFixed(2));
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
  const xpIntoCurrentLevel = Number((xp - xpAtCurrentLevel).toFixed(2));

  return {
    level,
    xpIntoCurrentLevel,
    xpForNextLevel: xpForNext
  };
}

/**
 * Calculate the effective XP multiplier for a member based on their roles.
 * Stacks additively. Returns a multiplier ≥ 1.0.
 * Example: 50% boost → multiplier 1.5
 */
export async function getMemberXpMultiplier(guildId, userId) {
  try {
    const pool = getPool();
    const { getDiscordClient } = await import('../../activity/index.js');
    const client = getDiscordClient();
    if (!client) return 1.0;

    const guild = client.guilds?.cache?.get(guildId);
    if (!guild) return 1.0;

    const member = guild.members.cache.get(userId)
      || await guild.members.fetch(userId).catch(() => null);
    if (!member) return 1.0;

    const memberRoleIds = [...member.roles.cache.keys()];
    if (memberRoleIds.length === 0) return 1.0;

    const placeholders = memberRoleIds.map((_, i) => `$${i + 2}`).join(', ');
    const res = await pool.query(
      `SELECT boost_percentage FROM role_xp_boosters
       WHERE guild_id = $1 AND role_id IN (${placeholders})`,
      [guildId, ...memberRoleIds]
    );

    const totalBoost = res.rows.reduce((sum, r) => sum + (parseInt(r.boost_percentage, 10) || 0), 0);
    return 1.0 + totalBoost / 100;
  } catch {
    return 1.0;
  }
}

/**
 * Award battlepass XP to a user and dispatch any newly unlocked level rewards.
 * Called after each message point or voice point is awarded.
 *
 * @param {string} guildId
 * @param {string} userId
 * @param {string} username
 * @param {number} xpToAdd — base XP points to add before multiplier
 * @param {object} client — Discord client, used to DM or post level-up notification
 */
export async function awardBattlepassXp(guildId, userId, username, xpToAdd, client = null) {
  if (!guildId || !userId || xpToAdd <= 0) return;

  try {
    const { getGuildConfig } = await import('../../storage/config.js');
    const config = await getGuildConfig(guildId);
    if (!config || config.battlepass_enabled !== true) return;

    const pool = getPool();

    // Apply role XP multiplier (multiplicative boost)
    const multiplier = await getMemberXpMultiplier(guildId, userId);
    const finalXp = Number((xpToAdd * multiplier).toFixed(2));

    // Atomically increment battlepass_xp
    await pool.query(
      `INSERT INTO user_activity (guild_id, user_id, username, battlepass_xp)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (guild_id, user_id)
       DO UPDATE SET
         battlepass_xp = user_activity.battlepass_xp + $4,
         username = $3`,
      [guildId, userId, username, finalXp]
    );

    // Dispatch any newly qualified level rewards
    await syncUserLevelRewards(guildId, userId, username, client);
  } catch (err) {
    sysError('Level XP Engine Failed', err, { guild: guildId, user: userId });
  }
}

/**
 * Check a user's current XP and dispatch rewards for any newly qualified unclaimed levels.
 */
export async function syncUserLevelRewards(guildId, userId, username, client = null) {
  if (!guildId || !userId) return;

  try {
    const { getGuildConfig } = await import('../../storage/config.js');
    const config = await getGuildConfig(guildId);
    if (!config || config.battlepass_enabled !== true) return;

    if (!client) {
      const { getDiscordClient } = await import('../../activity/index.js');
      client = getDiscordClient();
    }

    const pool = getPool();

    const xpResult = await pool.query(
      `SELECT battlepass_xp FROM user_activity WHERE guild_id = $1 AND user_id = $2`,
      [guildId, userId]
    );
    const totalXp = parseFloat(xpResult.rows[0]?.battlepass_xp || 0);
    if (totalXp <= 0) return;

    const baseXp = parseInt(config.battlepass_base_xp ?? config.battlepass_xp_per_level ?? 100, 10);
    const incrementXp = parseInt(config.battlepass_xp_increment ?? 50, 10);
    const { level: currentLevel } = calculateLevelFromXp(totalXp, baseXp, incrementXp);
    if (currentLevel <= 0) return;

    const levelsResult = await pool.query(
      `SELECT bc.level, bc.reward_coins, bc.reward_role_id,
              bc.reward_item_id, bc.reward_chest_id,
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

    const claimsResult = await pool.query(
      `SELECT level_claimed FROM user_pass_claims WHERE guild_id = $1 AND user_id = $2`,
      [guildId, userId]
    );
    const alreadyClaimedLevels = new Set(claimsResult.rows.map(r => r.level_claimed));

    // Also detect if any reached/claimed levels have pending multi-rewards not yet in user_pass_reward_claims
    const pendingMultiRewards = await pool.query(
      `SELECT br.level
       FROM battlepass_rewards br
       LEFT JOIN shop_items si ON br.shop_item_id = si.id AND si.guild_id = br.guild_id AND si.is_active = true
       LEFT JOIN loot_boxes lb ON br.loot_box_id = lb.id AND lb.guild_id = br.guild_id
       LEFT JOIN user_pass_reward_claims uprc 
         ON uprc.guild_id = br.guild_id AND uprc.user_id = $2 AND uprc.reward_id = br.id
        WHERE br.guild_id = $1 AND br.level <= $3 
          AND (uprc.reward_id IS NULL OR COALESCE(uprc.quantity_claimed, 1) < COALESCE(br.quantity, 1))
         AND (
           (br.reward_type = 'item' AND si.id IS NOT NULL AND si.item_type != 'pack' AND si.role_id IS NOT NULL) OR
           (br.reward_type = 'chest' AND lb.id IS NOT NULL)
         )
       GROUP BY br.level`,
      [guildId, userId, currentLevel]
    );
    const levelsWithPendingRewards = new Set(pendingMultiRewards.rows.map(r => r.level));

    const toClaim = levelsResult.rows.filter(r => !alreadyClaimedLevels.has(r.level) || levelsWithPendingRewards.has(r.level));
    if (toClaim.length === 0) return;

    const isBulk = toClaim.length > 5;
    const claimedLevels = [];
    for (const levelRow of toClaim) {
      const claimData = await dispatchLevelReward(pool, guildId, userId, username, levelRow, client, config, isBulk);
      if (claimData) {
        claimedLevels.push(claimData);
      }
    }

    // If bulk, send ONE consolidated audit log instead of spamming 50-200 logs
    if (isBulk && claimedLevels.length > 0 && client) {
      const guild = client.guilds?.cache?.get(guildId);
      if (guild) {
        const { COIN_EMOJI } = await import('../../shared.js');
        const coinEmoji = COIN_EMOJI.forGuild(guildId);
        const totalCoins = claimedLevels.reduce((sum, c) => sum + (c.coins || 0), 0);
        const totalRewardsCount = claimedLevels.reduce((sum, c) => sum + (c.rewards?.length || 0), 0);
        sendLog(
          guild,
          'economy',
          'green',
          '⭐ Bulk Level Sync',
          `<@${userId}> synchronized **${claimedLevels.length} levels** (up to Level ${currentLevel}), receiving **${totalCoins.toLocaleString()}** ${coinEmoji} and **${totalRewardsCount} items/chests**.`
        );
      }
    }

    // Continuous self-healing: ensure member holds ONLY their highest earned level role
    await alignMemberLevelRole(guildId, userId, currentLevel, client);

    if (claimedLevels.length > 0 && client) {
      await sendLevelUpNotification(client, guildId, userId, username, claimedLevels, config);
    }
  } catch (err) {
    sysError('Level Sync Failed', err, { guild: guildId, user: userId });
  }
}

/**
 * Enforce the role reward rules:
 *  - The Persistence Rule: If the user's current level has NO role configured,
 *    they keep whatever the last milestone role was.
 *  - The Replacement Rule: If the user's current level DOES have a role configured,
 *    remove all other configured level roles and add only this one.
 *
 * Only operates on roles that are actually configured as level rewards.
 */
async function alignMemberLevelRole(guildId, userId, currentLevel, client) {
  try {
    if (!client) return;
    const guild = client.guilds?.cache?.get(guildId);
    if (!guild) return;

    const member = guild.members.cache.get(userId)
      || await guild.members.fetch(userId).catch(() => null);
    if (!member) return;

    const pool = getPool();

    // Fetch all configured role rewards for this guild, ordered by level ASC
    const rolesRes = await pool.query(
      `SELECT level, reward_role_id FROM battlepass_config
       WHERE guild_id = $1 AND reward_role_id IS NOT NULL
       ORDER BY level ASC`,
      [guildId]
    );

    if (rolesRes.rows.length === 0) return; // No roles configured

    const allConfiguredRoleIds = rolesRes.rows.map(r => r.reward_role_id);

    // Find the highest configured level with a role that the user has earned
    // (i.e., level <= currentLevel)
    const earnedRoleRows = rolesRes.rows.filter(r => r.level <= currentLevel);

    if (earnedRoleRows.length === 0) {
      // User hasn't reached any role milestone yet — remove all configured level roles
      for (const roleId of allConfiguredRoleIds) {
        if (member.roles.cache.has(roleId)) {
          const role = guild.roles.cache.get(roleId);
          if (role) {
            const err = validateRoleForAssignment(role, guild);
            if (!err) await member.roles.remove(role).catch(() => {});
          }
        }
      }
      return;
    }

    // The active role is the HIGHEST level milestone role the user has earned
    const activeRoleRow = earnedRoleRows[earnedRoleRows.length - 1]; // rows are ordered ASC
    const activeRoleId = activeRoleRow.reward_role_id;

    // Remove all configured level roles that are NOT the active one
    for (const roleId of allConfiguredRoleIds) {
      if (roleId === activeRoleId) continue;
      if (member.roles.cache.has(roleId)) {
        const role = guild.roles.cache.get(roleId);
        if (role) await member.roles.remove(role).catch(() => {});
      }
    }

    // Add the active role if the member doesn't already have it
    if (!member.roles.cache.has(activeRoleId)) {
      const activeRole = guild.roles.cache.get(activeRoleId)
        || await guild.roles.fetch(activeRoleId).catch(() => null);
      if (activeRole) {
        const err = validateRoleForAssignment(activeRole, guild);
        if (!err) {
          await member.roles.add(activeRole).catch(() => {});
        }
      }
    }
  } catch (err) {
    sysError('Level Role Alignment Failed', err, { guild: guildId, user: userId });
  }
}

export async function dispatchLevelReward(pool, guildId, userId, username, levelRow, client, config, skipChannelLogs = false) {
  const client2 = await pool.connect();
  try {
    await client2.query('BEGIN');

    // A. Check if the level base claim (coins) is already locked
    const lockCheck = await client2.query(
      `SELECT 1 FROM user_pass_claims WHERE guild_id = $1 AND user_id = $2 AND level_claimed = $3`,
      [guildId, userId, levelRow.level]
    );
    const levelAlreadyClaimed = lockCheck.rows.length > 0;

    // B. Insert base claim record if not yet claimed
    if (!levelAlreadyClaimed) {
      await client2.query(
        `INSERT INTO user_pass_claims (user_id, guild_id, level_claimed) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [userId, guildId, levelRow.level]
      );
    }

    // C. Award coins ONLY if this level was NOT previously claimed
    let coins = 0;
    if (!levelAlreadyClaimed) {
      coins = parseInt(levelRow.reward_coins || 0, 10);
      if (coins > 0) {
        await client2.query(
          `INSERT INTO user_balances (user_id, guild_id, balance, total_earned)
           VALUES ($1, $2, $3, $3)
           ON CONFLICT (user_id, guild_id)
           DO UPDATE SET
             balance = user_balances.balance + $3,
             total_earned = user_balances.total_earned + $3,
             updated_at = NOW()`,
          [userId, guildId, coins]
        );

        await client2.query(
          `INSERT INTO transactions (user_id, guild_id, amount, balance_after, type, description, reference_id)
           SELECT $1, $2, $3, balance, 'battlepass_reward', $4, $5 FROM user_balances WHERE user_id = $1 AND guild_id = $2`,
          [userId, guildId, coins, `Level ${levelRow.level} Reward`, `bp_lvl_${levelRow.level}`]
        );
      }
    }

    // D. Fetch and award configured items/chests from battlepass_rewards (Phase 3 multi-reward)
    const rewardsResult = await client2.query(
      `SELECT br.id as reward_id, br.reward_type, br.shop_item_id, br.loot_box_id, br.quantity,
              si.name as item_name, si.role_id as item_role_id, si.is_active as item_is_active, si.item_type,
              lb.name as chest_name, lb.id as valid_box_id
       FROM battlepass_rewards br
       LEFT JOIN shop_items si ON br.shop_item_id = si.id AND si.guild_id = br.guild_id
       LEFT JOIN loot_boxes lb ON br.loot_box_id = lb.id AND lb.guild_id = br.guild_id
       WHERE br.guild_id = $1 AND br.level = $2`,
      [guildId, levelRow.level]
    );

    const grantedRewards = [];

    // Fallback if no multi-rewards were found: check legacy single columns on battlepass_config (only if level not previously claimed)
    if (rewardsResult.rows.length === 0 && !levelAlreadyClaimed) {
      if (levelRow.reward_item_id) {
        rewardsResult.rows.push({
          reward_id: null,
          reward_type: 'item',
          shop_item_id: levelRow.reward_item_id,
          item_name: levelRow.item_name,
          item_role_id: levelRow.item_role_id,
          item_is_active: true,
          quantity: 1
        });
      }
      if (levelRow.reward_chest_id) {
        rewardsResult.rows.push({
          reward_id: null,
          reward_type: 'chest',
          loot_box_id: levelRow.reward_chest_id,
          chest_name: levelRow.chest_name,
          valid_box_id: levelRow.reward_chest_id,
          quantity: 1
        });
      }
    }

    for (const reward of rewardsResult.rows) {
      let qty = Math.min(100, Math.max(1, parseInt(reward.quantity || 1, 10)));
      // Check if this specific reward has already been claimed (including partial quantity checks)
      if (reward.reward_id) {
        const rewardClaimCheck = await client2.query(
          `SELECT quantity_claimed FROM user_pass_reward_claims WHERE guild_id = $1 AND user_id = $2 AND reward_id = $3`,
          [guildId, userId, reward.reward_id]
        );
        if (rewardClaimCheck.rows.length > 0) {
          const claimedQty = parseInt(rewardClaimCheck.rows[0]?.quantity_claimed || 1, 10);
          if (claimedQty >= qty) {
            continue; // Already fully claimed, skip
          }
          qty = qty - claimedQty;
        }
      }

      if (reward.reward_type === 'item') {
        // Guard 1: Item must exist in shop, be active, have a valid role, and not be a pack
        if (!reward.shop_item_id || !reward.item_role_id || reward.item_is_active !== true || reward.item_type === 'pack') {
          if (reward.reward_id) {
            await client2.query(
              `INSERT INTO user_pass_reward_claims (guild_id, user_id, level, reward_id, quantity_claimed)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (guild_id, user_id, reward_id)
               DO UPDATE SET quantity_claimed = user_pass_reward_claims.quantity_claimed + EXCLUDED.quantity_claimed`,
              [guildId, userId, levelRow.level, reward.reward_id, qty]
            );
          }
          continue;
        }

        // Guard 2: Discord role dangerous permissions & hierarchy check
        if (client) {
          const guild = client.guilds?.cache?.get(guildId);
          if (guild) {
            const role = guild.roles.cache.get(reward.item_role_id);
            if (role) {
              const secErr = validateRoleForAssignment(role, guild);
              if (secErr) {
                sysError('Battlepass Level Reward Blocked: Dangerous Role', new Error(secErr), { guild: guildId, user: userId, role: reward.item_role_id });
                if (reward.reward_id) {
                  await client2.query(
                    `INSERT INTO user_pass_reward_claims (guild_id, user_id, level, reward_id, quantity_claimed)
                     VALUES ($1, $2, $3, $4, $5)
                     ON CONFLICT (guild_id, user_id, reward_id)
                     DO UPDATE SET quantity_claimed = user_pass_reward_claims.quantity_claimed + EXCLUDED.quantity_claimed`,
                    [guildId, userId, levelRow.level, reward.reward_id, qty]
                  );
                }
                continue;
              }
            }
          }
        }

        // Stack into existing inventory or create a new row
        const existingItem = await client2.query(
          `SELECT id FROM user_inventory
           WHERE user_id = $1 AND guild_id = $2 AND shop_item_id = $3 AND expires_at IS NULL
             AND (UPPER(COALESCE(source, '')) IN ('LEVEL', 'BATTLEPASS') OR LOWER(COALESCE(purchase_source, '')) IN ('level', 'battlepass'))
           ORDER BY is_active DESC LIMIT 1`,
          [userId, guildId, reward.shop_item_id]
        );
        if (existingItem.rows.length > 0) {
          await client2.query(
            `UPDATE user_inventory SET quantity = COALESCE(quantity, 1) + $1 WHERE id = $2`,
            [qty, existingItem.rows[0].id]
          );
        } else {
          await client2.query(
            `INSERT INTO user_inventory (user_id, guild_id, shop_item_id, role_id, is_active, source, purchase_source, quantity)
             VALUES ($1, $2, $3, $4, false, 'LEVEL', 'level', $5)`,
            [userId, guildId, reward.shop_item_id, reward.item_role_id || null, qty]
          );
        }
        grantedRewards.push({
          type: 'item',
          name: reward.item_name || 'Item',
          quantity: qty
        });

        if (reward.reward_id) {
          await client2.query(
            `INSERT INTO user_pass_reward_claims (guild_id, user_id, level, reward_id, quantity_claimed)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (guild_id, user_id, reward_id)
             DO UPDATE SET quantity_claimed = user_pass_reward_claims.quantity_claimed + EXCLUDED.quantity_claimed`,
            [guildId, userId, levelRow.level, reward.reward_id, qty]
          );
        }
      } else if (reward.reward_type === 'chest') {
        // Guard: Loot box must exist in this guild
        if (!reward.loot_box_id || !reward.valid_box_id) {
          if (reward.reward_id) {
            await client2.query(
              `INSERT INTO user_pass_reward_claims (guild_id, user_id, level, reward_id, quantity_claimed)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (guild_id, user_id, reward_id)
               DO UPDATE SET quantity_claimed = user_pass_reward_claims.quantity_claimed + EXCLUDED.quantity_claimed`,
              [guildId, userId, levelRow.level, reward.reward_id, qty]
            );
          }
          continue;
        }

        const shopItemRes = await client2.query(
          `SELECT id, role_id FROM shop_items WHERE loot_box_id = $1 AND guild_id = $2 LIMIT 1`,
          [reward.loot_box_id, guildId]
        );
        let chestShopItemId = shopItemRes.rows[0]?.id;
        let chestRoleId = shopItemRes.rows[0]?.role_id || `LOOT_BOX_${reward.loot_box_id}`;

        if (!chestShopItemId) {
          const boxRow = await client2.query(`SELECT * FROM loot_boxes WHERE id = $1 AND guild_id = $2`, [reward.loot_box_id, guildId]);
          if (boxRow.rows.length > 0) {
            const newShopItem = await client2.query(
              `INSERT INTO shop_items (guild_id, name, item_type, role_id, is_pack, is_tradable, rarity, loot_box_id, is_active)
               VALUES ($1, $2, 'loot_box', $3, false, true, 'common', $4, true)
               RETURNING id, role_id`,
              [guildId, boxRow.rows[0].name, `LOOT_BOX_${reward.loot_box_id}`, reward.loot_box_id]
            );
            chestShopItemId = newShopItem.rows[0]?.id;
            chestRoleId = newShopItem.rows[0]?.role_id || chestRoleId;
          }
        }

        if (chestShopItemId) {
          const existingChest = await client2.query(
            `SELECT id FROM user_inventory
             WHERE user_id = $1 AND guild_id = $2 AND shop_item_id = $3 AND expires_at IS NULL
               AND (UPPER(COALESCE(source, '')) IN ('LEVEL', 'BATTLEPASS') OR LOWER(COALESCE(purchase_source, '')) IN ('level', 'battlepass'))
             ORDER BY is_active DESC LIMIT 1`,
            [userId, guildId, chestShopItemId]
          );
          if (existingChest.rows.length > 0) {
            await client2.query(
              `UPDATE user_inventory SET quantity = COALESCE(quantity, 1) + $1 WHERE id = $2`,
              [qty, existingChest.rows[0].id]
            );
          } else {
            await client2.query(
              `INSERT INTO user_inventory (user_id, guild_id, shop_item_id, role_id, is_active, source, purchase_source, quantity)
               VALUES ($1, $2, $3, $4, false, 'LEVEL', 'level', $5)`,
              [userId, guildId, chestShopItemId, chestRoleId, qty]
            );
          }
          grantedRewards.push({
            type: 'chest',
            name: reward.chest_name || 'Chest',
            quantity: qty
          });

          if (reward.reward_id) {
            await client2.query(
              `INSERT INTO user_pass_reward_claims (guild_id, user_id, level, reward_id, quantity_claimed)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (guild_id, user_id, reward_id)
               DO UPDATE SET quantity_claimed = user_pass_reward_claims.quantity_claimed + EXCLUDED.quantity_claimed`,
              [guildId, userId, levelRow.level, reward.reward_id, qty]
            );
          }
        } else {
          if (reward.reward_id) {
            await client2.query(
              `INSERT INTO user_pass_reward_claims (guild_id, user_id, level, reward_id, quantity_claimed)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (guild_id, user_id, reward_id)
               DO UPDATE SET quantity_claimed = user_pass_reward_claims.quantity_claimed + EXCLUDED.quantity_claimed`,
              [guildId, userId, levelRow.level, reward.reward_id, qty]
            );
          }
        }
      }
    }

    if (coins === 0 && grantedRewards.length === 0) {
      await client2.query('COMMIT');
      return null;
    }

    await client2.query('COMMIT');

    sysLog('Level Reward Dispatched', {
      user: userId,
      guild: guildId,
      detail: `Level ${levelRow.level} | Coins: ${coins} | Rewards: ${grantedRewards.map(r => `${r.quantity}x ${r.name}`).join(', ') || 'None'}`
    });

    // Send Discord channel audit logs (suppressed during bulk claims to avoid spam)
    if (!skipChannelLogs && client) {
      const guild = client.guilds?.cache?.get(guildId);
      if (guild) {
        if (coins > 0) {
          const { COIN_EMOJI } = await import('../../shared.js');
          const coinEmoji = COIN_EMOJI.forGuild(guildId);
          sendLog(guild, 'economy', 'green', '⭐ Level Reward', `<@${userId}> reached **Level ${levelRow.level}** and received **${coins.toLocaleString()}** ${coinEmoji}!`);
        }
        for (const gr of grantedRewards) {
          const countStr = gr.quantity > 1 ? `${gr.quantity}x ` : '';
          if (gr.type === 'item') {
            sendLog(guild, 'inventory', 'green', '🏷️ Level Item Reward', `<@${userId}> reached **Level ${levelRow.level}** and received **${countStr}${gr.name}**!`);
          } else if (gr.type === 'chest') {
            const { getLootBoxCategoryEmoji } = await import('../../economy/lootbox.js');
            const lootBoxEmoji = await getLootBoxCategoryEmoji(guildId);
            sendLog(guild, 'inventory', 'green', `${lootBoxEmoji} Level Chest Reward`, `<@${userId}> reached **Level ${levelRow.level}** and received **${countStr}${gr.name}**!`);
          }
        }
      }
    }

    return {
      level: levelRow.level,
      coins,
      rewards: grantedRewards
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

    let title;
    let description;

    if (claimedLevels.length === 1) {
      const single = claimedLevels[0];
      const rewards = [];
      if (single.coins > 0) rewards.push(`${coinEmoji} **${single.coins.toLocaleString()} Coins**`);
      for (const r of (single.rewards || [])) {
        const qStr = r.quantity > 1 ? `${r.quantity}x ` : '';
        if (r.type === 'item') rewards.push(`🏷️ **${qStr}${r.name}**`);
        else if (r.type === 'chest') rewards.push(`${lootBoxEmoji} **${qStr}${r.name}**`);
      }

      title = `Level Up! (Level ${single.level})`;
      if (rewards.length > 0) {
        description = `Congratulations <@${userId}>! You reached **Level ${single.level}**.\n\n**Rewards Unlocked:**\n• ${rewards.join('\n• ')}`;
      } else {
        description = `Congratulations <@${userId}>! You reached **Level ${single.level}**.`;
      }
    } else if (claimedLevels.length <= 15) {
      const highestLevel = Math.max(...claimedLevels.map(c => c.level));
      title = `Level Up! (Level ${highestLevel})`;

      const rewardLines = [];
      for (const c of claimedLevels) {
        const rewards = [];
        if (c.coins > 0) rewards.push(`${coinEmoji} **${c.coins.toLocaleString()} Coins**`);
        for (const r of (c.rewards || [])) {
          const qStr = r.quantity > 1 ? `${r.quantity}x ` : '';
          if (r.type === 'item') rewards.push(`🏷️ **${qStr}${r.name}**`);
          else if (r.type === 'chest') rewards.push(`${lootBoxEmoji} **${qStr}${r.name}**`);
        }
        if (rewards.length > 0) {
          rewardLines.push(`• **Level ${c.level}:** ${rewards.join(' + ')}`);
        }
      }

      if (rewardLines.length > 0) {
        description = `Congratulations <@${userId}>! You reached **Level ${highestLevel}**.\n\n**Rewards Unlocked (${claimedLevels.length} Levels):**\n${rewardLines.join('\n')}`;
      } else {
        description = `Congratulations <@${userId}>! You reached **Level ${highestLevel}**.`;
      }
    } else {
      // Bulk unlock (e.g. 16 to 200 levels claimed in one go)
      const highestLevel = Math.max(...claimedLevels.map(c => c.level));
      const lowestLevel = Math.min(...claimedLevels.map(c => c.level));
      title = `Bulk Rewards Unlocked! (Levels ${lowestLevel} - ${highestLevel})`;

      const totalCoins = claimedLevels.reduce((sum, c) => sum + (c.coins || 0), 0);
      const itemsMap = new Map();
      const chestsMap = new Map();

      for (const c of claimedLevels) {
        for (const r of (c.rewards || [])) {
          if (r.type === 'item') {
            itemsMap.set(r.name, (itemsMap.get(r.name) || 0) + (r.quantity || 1));
          } else if (r.type === 'chest') {
            chestsMap.set(r.name, (chestsMap.get(r.name) || 0) + (r.quantity || 1));
          }
        }
      }

      const summaryParts = [];
      if (totalCoins > 0) summaryParts.push(`${coinEmoji} **${totalCoins.toLocaleString()} Total Coins**`);
      for (const [name, qty] of itemsMap.entries()) {
        const qStr = qty > 1 ? `${qty}x ` : '';
        summaryParts.push(`🏷️ **${qStr}${name}**`);
      }
      for (const [name, qty] of chestsMap.entries()) {
        const qStr = qty > 1 ? `${qty}x ` : '';
        summaryParts.push(`${lootBoxEmoji} **${qStr}${name}**`);
      }

      const summaryText = summaryParts.length > 0 ? `• ${summaryParts.slice(0, 25).join('\n• ')}` : '_No rewards configured for these levels._';
      const extraCount = summaryParts.length > 25 ? `\n_...and ${summaryParts.length - 25} more rewards_` : '';

      description = `Congratulations <@${userId}>! You unlocked rewards for **${claimedLevels.length} levels**.\n\n**Total Rewards Claimed:**\n${summaryText}${extraCount}`;
    }

    // Safety guard against Discord 4096 char limit
    if (description && description.length > 4000) {
      description = description.slice(0, 3990) + '\n...';
    }

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle(title)
      .setDescription(description)
      .setFooter({
        text: `${guildName} • ${new Date().toLocaleString()}`,
        iconURL: typeof guild?.iconURL === 'function' ? (guild.iconURL({ dynamic: true }) || guild.iconURL()) : null
      });

    if (notifChannelId) {
      const channel = guild?.channels?.cache?.get(notifChannelId) || await client.channels?.fetch(notifChannelId).catch(() => null);
      if (channel?.isTextBased?.()) {
        const sentMsg = await channel.send({ embeds: [embed] }).catch(() => null);
        if (sentMsg) {
          const { verifyAndHealMessageImages } = await import('../../utils/image-healer.js');
          verifyAndHealMessageImages(sentMsg);
        }
      }
    }

    // Direct Message Notification (Opt-in only)
    const { getUserNotificationSettings, disableUserNotificationsOnLeave } = await import('../../storage/notifications.js');
    const userSettings = await getUserNotificationSettings(guildId, userId);

    if (userSettings.notif_level_up) {
      const isStillMember = guild?.members?.cache?.has(userId) || !!(await guild?.members?.fetch(userId).catch(() => null));
      if (!isStillMember) {
        await disableUserNotificationsOnLeave(guildId, userId);
        return;
      }

      const user = await client.users.fetch(userId).catch(() => null);
      if (user) {
        await user.send({ embeds: [embed] }).catch(() => {});
      }
    }
  } catch (err) {
    sysError('Level Notification Failed', err, { user: userId, guild: guildId });
  }
}

/**
 * Get a user's Battlepass progress summary for /level command
 */
export async function getUserPassProgress(guildId, userId) {
  try {
    const { flushMessageBatch } = await import('../../activity/tracker.js');
    await flushMessageBatch().catch(() => {});
  } catch {}

  const pool = getPool();

  const { getGuildConfig } = await import('../../storage/config.js');
  const config = await getGuildConfig(guildId) || {};
  const baseXp = parseInt(config.battlepass_base_xp ?? config.battlepass_xp_per_level ?? 100, 10);
  const incrementXp = parseInt(config.battlepass_xp_increment ?? 50, 10);
  const isEnabled = config.battlepass_enabled === true;

  // Get user XP
  const xpResult = await pool.query(
    `SELECT battlepass_xp, username FROM user_activity WHERE guild_id = $1 AND user_id = $2`,
    [guildId, userId]
  );
  const totalXp = parseFloat(xpResult.rows[0]?.battlepass_xp || 0);
  const username = xpResult.rows[0]?.username || null;

  // Proactively claim any newly configured level rewards if system is enabled
  if (isEnabled && totalXp > 0) {
    const { getDiscordClient } = await import('../../activity/index.js');
    const client = getDiscordClient();
    await syncUserLevelRewards(guildId, userId, username, client).catch(() => {});
  }

  const { level: currentLevel, xpIntoCurrentLevel, xpForNextLevel } = calculateLevelFromXp(totalXp, baseXp, incrementXp);

  // Get claimed levels
  const claimsResult = await pool.query(
    `SELECT upc.level_claimed, bc.reward_coins, bc.reward_role_id
     FROM user_pass_claims upc
     LEFT JOIN battlepass_config bc ON bc.guild_id = upc.guild_id AND bc.level = upc.level_claimed
     WHERE upc.guild_id = $1 AND upc.user_id = $2
     ORDER BY upc.level_claimed ASC`,
    [guildId, userId]
  );

  // Get all active configured rewards across levels
  const rewardsResult = await pool.query(
    `SELECT br.level, br.reward_type, br.quantity,
            si.name as item_name, lb.name as chest_name
     FROM battlepass_rewards br
     LEFT JOIN shop_items si ON br.shop_item_id = si.id AND si.guild_id = br.guild_id AND si.is_active = true
     LEFT JOIN loot_boxes lb ON br.loot_box_id = lb.id AND lb.guild_id = br.guild_id
     WHERE br.guild_id = $1
       AND (
         (br.reward_type = 'item' AND si.id IS NOT NULL AND si.item_type != 'pack' AND si.role_id IS NOT NULL) OR
         (br.reward_type = 'chest' AND lb.id IS NOT NULL)
       )
     ORDER BY br.level ASC, br.id ASC`,
    [guildId]
  );

  const rewardsByLevel = new Map();
  for (const r of rewardsResult.rows) {
    if (!rewardsByLevel.has(r.level)) rewardsByLevel.set(r.level, []);
    rewardsByLevel.get(r.level).push(r);
  }

  const claims = claimsResult.rows.map(c => ({
    level_claimed: c.level_claimed,
    reward_role_id: c.reward_role_id,
    reward_coins: parseInt(c.reward_coins, 10) || 0,
    rewards: rewardsByLevel.get(c.level_claimed) || []
  }));

  // Get next level that actually has tangible rewards (coins, items, or chests)
  const nextLevelsResult = await pool.query(
    `SELECT level, reward_coins
     FROM battlepass_config
     WHERE guild_id = $1 AND level > $2
     ORDER BY level ASC`,
    [guildId, currentLevel]
  );

  let nextReward = null;
  for (const nextRow of nextLevelsResult.rows) {
    const coins = parseInt(nextRow.reward_coins, 10) || 0;
    const itemsAndChests = rewardsByLevel.get(nextRow.level) || [];
    if (coins > 0 || itemsAndChests.length > 0) {
      nextReward = {
        level: nextRow.level,
        reward_coins: coins,
        rewards: itemsAndChests
      };
      break;
    }
  }

  // Get active role XP boosters for this user
  let activeBoosts = [];
  let totalBoostPct = 0;
  try {
    const { getDiscordClient } = await import('../../activity/index.js');
    const client = getDiscordClient();
    const guild = client?.guilds?.cache?.get(guildId);
    if (guild) {
      const member = guild.members.cache.get(userId)
        || await guild.members.fetch(userId).catch(() => null);
      if (member) {
        const memberRoleIds = Array.from(member.roles.cache.keys());
        if (memberRoleIds.length > 0) {
          const placeholders = memberRoleIds.map((_, i) => `$${i + 2}`).join(', ');
          const boostersRes = await pool.query(
            `SELECT role_id, boost_percentage FROM role_xp_boosters
             WHERE guild_id = $1 AND role_id IN (${placeholders})
             ORDER BY boost_percentage DESC`,
            [guildId, ...memberRoleIds]
          );
          activeBoosts = boostersRes.rows.map(b => ({
            roleId: b.role_id,
            boostPct: parseInt(b.boost_percentage, 10) || 0
          }));
          totalBoostPct = activeBoosts.reduce((sum, b) => sum + b.boostPct, 0);
        }
      }
    }
  } catch {}

  return {
    isEnabled,
    totalXp,
    currentLevel,
    xpIntoCurrentLevel,
    xpForNextLevel,
    baseXp,
    incrementXp,
    claims,
    nextReward,
    activeBoosts,
    totalBoostPct,
    config
  };
}

/**
 * Reconcile missing milestone rewards (items/chests) for reached levels.
 * Highly optimized: uses set-based querying and in-memory diffing.
 * Can be run for a specific user (on inventory view) or globally for all users.
 *
 * @param {string} guildId
 * @param {string|null} userId
 */
export async function reconcileMissingLevelRewards(guildId, userId = null) {
  if (!guildId) return;
  const pool = getPool();

  try {
    const { getGuildConfig } = await import('../../storage/config.js');
    const config = await getGuildConfig(guildId) || {};
    if (config.battlepass_enabled !== true) return;

    const baseXp = parseInt(config.battlepass_base_xp ?? config.battlepass_xp_per_level ?? 100, 10);
    const incrementXp = parseInt(config.battlepass_xp_increment ?? 50, 10);

    // 1. Fetch all configured rewards for this guild
    const allRewardsRes = await pool.query(
      `SELECT br.id as reward_id, br.level, br.reward_type, br.shop_item_id, br.loot_box_id, COALESCE(br.quantity, 1) as quantity,
              si.role_id as item_role_id, si.name as item_name, si.is_active as item_is_active, si.item_type,
              lb.name as chest_name, lb.id as valid_box_id
       FROM battlepass_rewards br
       LEFT JOIN shop_items si ON br.shop_item_id = si.id AND si.guild_id = br.guild_id
       LEFT JOIN loot_boxes lb ON br.loot_box_id = lb.id AND lb.guild_id = br.guild_id
       WHERE br.guild_id = $1
       ORDER BY br.level ASC`,
      [guildId]
    );

    // Also check legacy single columns on battlepass_config
    const legacyConfigChests = await pool.query(
      `SELECT bc.level, bc.reward_chest_id,
              si.id as shop_item_id, si.role_id, lb.name as chest_name, lb.id as valid_box_id
       FROM battlepass_config bc
       LEFT JOIN loot_boxes lb ON bc.reward_chest_id = lb.id AND lb.guild_id = bc.guild_id
       LEFT JOIN shop_items si ON si.loot_box_id = bc.reward_chest_id AND si.guild_id = bc.guild_id
       WHERE bc.guild_id = $1
         AND bc.reward_chest_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM battlepass_rewards br
           WHERE br.guild_id = bc.guild_id AND br.level = bc.level AND br.reward_type = 'chest' AND br.loot_box_id = bc.reward_chest_id
         )`,
      [guildId]
    );

    if (allRewardsRes.rows.length === 0 && legacyConfigChests.rows.length === 0) {
      return;
    }

    // 2. Resolve target users and their XP / max claimed level in a single aggregated query
    let targetUsers = [];
    if (userId) {
      const userRes = await pool.query(
        `SELECT 
           $2::VARCHAR as user_id,
           COALESCE(ua.battlepass_xp, 0) as battlepass_xp,
           COALESCE(upc.max_level, 0) as max_claim_level
         FROM (SELECT $2::VARCHAR as user_id) u
         LEFT JOIN user_activity ua ON ua.guild_id = $1 AND ua.user_id = u.user_id
         LEFT JOIN (
           SELECT MAX(level_claimed) as max_level FROM user_pass_claims WHERE guild_id = $1 AND user_id = $2
         ) upc ON true`,
        [guildId, userId]
      );
      targetUsers = userRes.rows;
    } else {
      const usersRes = await pool.query(
        `SELECT 
           u.user_id,
           COALESCE(ua.battlepass_xp, 0) as battlepass_xp,
           COALESCE(upc.max_level, 0) as max_claim_level
         FROM (
           SELECT user_id FROM user_activity WHERE guild_id = $1 AND battlepass_xp > 0
           UNION
           SELECT user_id FROM user_pass_claims WHERE guild_id = $1
         ) u
         LEFT JOIN user_activity ua ON ua.guild_id = $1 AND ua.user_id = u.user_id
         LEFT JOIN (
           SELECT user_id, MAX(level_claimed) as max_level 
           FROM user_pass_claims 
           WHERE guild_id = $1 
           GROUP BY user_id
         ) upc ON upc.user_id = u.user_id`,
        [guildId]
      );
      targetUsers = usersRes.rows;
    }

    if (targetUsers.length === 0) return;

    // 3. Fetch existing claims from user_pass_reward_claims to perform in-memory diffing
    let claimedRewardMap;
    let claimedLegacyLevels;
    if (userId) {
      const claimsRes = await pool.query(
        `SELECT reward_id, COALESCE(quantity_claimed, 1) as quantity_claimed FROM user_pass_reward_claims WHERE guild_id = $1 AND user_id = $2`,
        [guildId, userId]
      );
      claimedRewardMap = new Map(claimsRes.rows.map(r => [r.reward_id, parseInt(r.quantity_claimed || 1, 10)]));

      const legacyClaimsRes = await pool.query(
        `SELECT level_claimed FROM user_pass_claims WHERE guild_id = $1 AND user_id = $2`,
        [guildId, userId]
      );
      claimedLegacyLevels = new Set(legacyClaimsRes.rows.map(r => r.level_claimed));
    } else {
      const claimsRes = await pool.query(
        `SELECT user_id, reward_id, COALESCE(quantity_claimed, 1) as quantity_claimed FROM user_pass_reward_claims WHERE guild_id = $1`,
        [guildId]
      );
      claimedRewardMap = new Map(claimsRes.rows.map(r => [`${r.user_id}_${r.reward_id}`, parseInt(r.quantity_claimed || 1, 10)]));

      const legacyClaimsRes = await pool.query(
        `SELECT user_id, level_claimed FROM user_pass_claims WHERE guild_id = $1`,
        [guildId]
      );
      claimedLegacyLevels = new Set(legacyClaimsRes.rows.map(r => `${r.user_id}_${r.level_claimed}`));
    }

    // 4. For each user, calculate reached level and reconcile missing rewards
    for (const u of targetUsers) {
      const uid = u.user_id;
      const totalXp = parseFloat(u.battlepass_xp || 0);
      const xpLevel = calculateLevelFromXp(totalXp, baseXp, incrementXp).level;
      const maxClaimLevel = parseInt(u.max_claim_level || 0, 10);
      const reachedLevel = Math.max(xpLevel, maxClaimLevel);
      if (reachedLevel <= 0) continue;

      const missingRewards = [];
      for (const br of allRewardsRes.rows) {
        if (br.level > reachedLevel) continue;
        const key = userId ? br.reward_id : `${uid}_${br.reward_id}`;
        const claimedQty = claimedRewardMap.get(key) || 0;
        const targetQty = Math.min(100, Math.max(1, parseInt(br.quantity || 1, 10)));
        if (claimedQty < targetQty) {
          missingRewards.push({
            ...br,
            quantity: targetQty - claimedQty
          });
        }
      }

      const missingLegacyChests = legacyConfigChests.rows.filter(bc => {
        if (bc.level > reachedLevel) return false;
        const key = userId ? bc.level : `${uid}_${bc.level}`;
        return !claimedLegacyLevels.has(key);
      });

      for (const row of missingRewards) {
        const { reward_id, level, reward_type, shop_item_id, loot_box_id, quantity, item_role_id, chest_name, item_name, item_is_active, item_type, valid_box_id } = row;
        const qty = Math.min(100, Math.max(1, parseInt(quantity || 1, 10)));

        if (reward_type === 'chest' && loot_box_id) {
          if (!valid_box_id) {
            await pool.query(
              `INSERT INTO user_pass_reward_claims (guild_id, user_id, level, reward_id, quantity_claimed)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (guild_id, user_id, reward_id)
               DO UPDATE SET quantity_claimed = user_pass_reward_claims.quantity_claimed + EXCLUDED.quantity_claimed`,
              [guildId, uid, level, reward_id, qty]
            );
            if (userId) claimedRewardMap.set(reward_id, (claimedRewardMap.get(reward_id) || 0) + qty);
            else claimedRewardMap.set(`${uid}_${reward_id}`, (claimedRewardMap.get(`${uid}_${reward_id}`) || 0) + qty);
            continue;
          }

          const shopItemRes = await pool.query(
            `SELECT id, role_id FROM shop_items WHERE loot_box_id = $1 AND guild_id = $2 LIMIT 1`,
            [loot_box_id, guildId]
          );
          let chestShopItemId = shopItemRes.rows[0]?.id;
          let chestRoleId = shopItemRes.rows[0]?.role_id || `LOOT_BOX_${loot_box_id}`;

          if (!chestShopItemId) {
            const boxRow = await pool.query(`SELECT * FROM loot_boxes WHERE id = $1 AND guild_id = $2`, [loot_box_id, guildId]);
            if (boxRow.rows.length > 0) {
              const newShopItem = await pool.query(
                `INSERT INTO shop_items (guild_id, name, item_type, role_id, is_pack, is_tradable, rarity, loot_box_id, is_active)
                 VALUES ($1, $2, 'loot_box', $3, false, true, 'common', $4, true)
                 RETURNING id, role_id`,
                [guildId, boxRow.rows[0].name, `LOOT_BOX_${loot_box_id}`, loot_box_id]
              );
              chestShopItemId = newShopItem.rows[0]?.id;
              chestRoleId = newShopItem.rows[0]?.role_id || chestRoleId;
            }
          }

          // Check if user already holds a chest specifically from LEVEL / BATTLEPASS
          const levelInvCheck = await pool.query(
            `SELECT id, quantity FROM user_inventory 
             WHERE user_id = $1 AND guild_id = $2 
               AND (UPPER(COALESCE(source, '')) IN ('LEVEL', 'BATTLEPASS') OR LOWER(COALESCE(purchase_source, '')) IN ('level', 'battlepass'))
               AND (shop_item_id = $3 OR (role_id LIKE 'CHEST_%' AND NULLIF(SUBSTRING(role_id FROM 7), '')::INTEGER = $4))
             ORDER BY id ASC LIMIT 1`,
            [uid, guildId, chestShopItemId, loot_box_id]
          );

          if (levelInvCheck.rows.length > 0) {
            await pool.query(
              `UPDATE user_inventory SET quantity = COALESCE(quantity, 1) + $1 WHERE id = $2`,
              [qty, levelInvCheck.rows[0].id]
            );
            sysLog('Self-Healing: Stacked Missing Level Chest', {
              user: uid,
              guild: guildId,
              detail: `Level ${level} | +${qty}x ${chest_name || 'Chest'} (Total: ${parseInt(levelInvCheck.rows[0].quantity || 1, 10) + qty})`
            });
          } else if (chestShopItemId) {
            await pool.query(
              `INSERT INTO user_inventory (user_id, guild_id, shop_item_id, role_id, is_active, source, purchase_source, quantity)
               VALUES ($1, $2, $3, $4, false, 'LEVEL', 'level', $5)`,
              [uid, guildId, chestShopItemId, chestRoleId, qty]
            );
            sysLog('Self-Healing: Granted Missing Level Chest', {
              user: uid,
              guild: guildId,
              detail: `Level ${level} | ${qty}x ${chest_name || 'Chest'} (Reward ID: ${reward_id})`
            });
          }

          await pool.query(
            `INSERT INTO user_pass_reward_claims (guild_id, user_id, level, reward_id, quantity_claimed)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (guild_id, user_id, reward_id)
             DO UPDATE SET quantity_claimed = user_pass_reward_claims.quantity_claimed + EXCLUDED.quantity_claimed`,
            [guildId, uid, level, reward_id, qty]
          );
          await pool.query(
            `INSERT INTO user_pass_claims (user_id, guild_id, level_claimed)
             VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [uid, guildId, level]
          );
          if (userId) claimedRewardMap.set(reward_id, (claimedRewardMap.get(reward_id) || 0) + qty);
          else claimedRewardMap.set(`${uid}_${reward_id}`, (claimedRewardMap.get(`${uid}_${reward_id}`) || 0) + qty);

        } else if (reward_type === 'item' && shop_item_id) {
          if (!item_role_id || item_is_active !== true || item_type === 'pack') {
            await pool.query(
              `INSERT INTO user_pass_reward_claims (guild_id, user_id, level, reward_id, quantity_claimed)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (guild_id, user_id, reward_id)
               DO UPDATE SET quantity_claimed = user_pass_reward_claims.quantity_claimed + EXCLUDED.quantity_claimed`,
              [guildId, uid, level, reward_id, qty]
            );
            if (userId) claimedRewardMap.set(reward_id, (claimedRewardMap.get(reward_id) || 0) + qty);
            else claimedRewardMap.set(`${uid}_${reward_id}`, (claimedRewardMap.get(`${uid}_${reward_id}`) || 0) + qty);
            continue;
          }

          const levelItemInvCheck = await pool.query(
            `SELECT id, quantity FROM user_inventory 
             WHERE user_id = $1 AND guild_id = $2 
               AND shop_item_id = $3
               AND (UPPER(COALESCE(source, '')) IN ('LEVEL', 'BATTLEPASS') OR LOWER(COALESCE(purchase_source, '')) IN ('level', 'battlepass'))
             ORDER BY id ASC LIMIT 1`,
            [uid, guildId, shop_item_id]
          );

          if (levelItemInvCheck.rows.length > 0) {
            await pool.query(
              `UPDATE user_inventory SET quantity = COALESCE(quantity, 1) + $1 WHERE id = $2`,
              [qty, levelItemInvCheck.rows[0].id]
            );
            sysLog('Self-Healing: Stacked Missing Level Item', {
              user: uid,
              guild: guildId,
              detail: `Level ${level} | +${qty}x ${item_name || 'Item'}`
            });
          } else {
            await pool.query(
              `INSERT INTO user_inventory (user_id, guild_id, shop_item_id, role_id, is_active, source, purchase_source, quantity)
               VALUES ($1, $2, $3, $4, false, 'LEVEL', 'level', $5)`,
              [uid, guildId, shop_item_id, item_role_id || null, qty]
            );
            sysLog('Self-Healing: Granted Missing Level Item', {
              user: uid,
              guild: guildId,
              detail: `Level ${level} | ${qty}x ${item_name || 'Item'} (Reward ID: ${reward_id})`
            });
          }

          await pool.query(
            `INSERT INTO user_pass_reward_claims (guild_id, user_id, level, reward_id, quantity_claimed)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (guild_id, user_id, reward_id)
             DO UPDATE SET quantity_claimed = user_pass_reward_claims.quantity_claimed + EXCLUDED.quantity_claimed`,
            [guildId, uid, level, reward_id, qty]
          );
          await pool.query(
            `INSERT INTO user_pass_claims (user_id, guild_id, level_claimed)
             VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [uid, guildId, level]
          );
          if (userId) claimedRewardMap.set(reward_id, (claimedRewardMap.get(reward_id) || 0) + qty);
          else claimedRewardMap.set(`${uid}_${reward_id}`, (claimedRewardMap.get(`${uid}_${reward_id}`) || 0) + qty);
        }
      }

      for (const row of missingLegacyChests) {
        const { level, reward_chest_id, shop_item_id, role_id, chest_name, valid_box_id } = row;
        if (!valid_box_id) continue;

        let chestShopItemId = shop_item_id;
        let chestRoleId = role_id || `LOOT_BOX_${reward_chest_id}`;

        if (!chestShopItemId) {
          const boxRow = await pool.query(`SELECT * FROM loot_boxes WHERE id = $1 AND guild_id = $2`, [reward_chest_id, guildId]);
          if (boxRow.rows.length > 0) {
            const newShopItem = await pool.query(
              `INSERT INTO shop_items (guild_id, name, item_type, role_id, is_pack, is_tradable, rarity, loot_box_id, is_active)
               VALUES ($1, $2, 'loot_box', $3, false, true, 'common', $4, true)
               RETURNING id, role_id`,
              [guildId, boxRow.rows[0].name, `LOOT_BOX_${reward_chest_id}`, reward_chest_id]
            );
            chestShopItemId = newShopItem.rows[0]?.id;
            chestRoleId = newShopItem.rows[0]?.role_id || chestRoleId;
          }
        }

        const levelInvCheck = await pool.query(
          `SELECT id, quantity FROM user_inventory 
           WHERE user_id = $1 AND guild_id = $2 
             AND (UPPER(COALESCE(source, '')) IN ('LEVEL', 'BATTLEPASS') OR LOWER(COALESCE(purchase_source, '')) IN ('level', 'battlepass'))
             AND (shop_item_id = $3 OR (role_id LIKE 'CHEST_%' AND NULLIF(SUBSTRING(role_id FROM 7), '')::INTEGER = $4))
           ORDER BY id ASC LIMIT 1`,
          [uid, guildId, chestShopItemId, reward_chest_id]
        );

        if (levelInvCheck.rows.length > 0) {
          await pool.query(
            `UPDATE user_inventory SET quantity = COALESCE(quantity, 1) + 1 WHERE id = $2`,
            [levelInvCheck.rows[0].id]
          );
          sysLog('Self-Healing: Stacked Legacy Config Level Chest', {
            user: uid,
            guild: guildId,
            detail: `Level ${level} | +1x ${chest_name || 'Chest'}`
          });
        } else if (chestShopItemId) {
          await pool.query(
            `INSERT INTO user_inventory (user_id, guild_id, shop_item_id, role_id, is_active, source, purchase_source, quantity)
             VALUES ($1, $2, $3, $4, false, 'LEVEL', 'level', 1)`,
            [uid, guildId, chestShopItemId, chestRoleId]
          );
          sysLog('Self-Healing: Granted Legacy Config Level Chest', {
            user: uid,
            guild: guildId,
            detail: `Level ${level} | 1x ${chest_name || 'Chest'}`
          });
        }
        await pool.query(
          `INSERT INTO user_pass_claims (user_id, guild_id, level_claimed)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [uid, guildId, level]
        );
        if (userId) claimedLegacyLevels.add(level);
        else claimedLegacyLevels.add(`${uid}_${level}`);
      }

      // 5. Chest Deficit Reconciliation: Audit total held + opened chests against expected rewards
      const configuredChestsMap = new Map();
      for (const br of allRewardsRes.rows) {
        if (br.level > reachedLevel || br.reward_type !== 'chest' || !br.loot_box_id || !br.valid_box_id) continue;
        const boxId = br.loot_box_id;
        const qty = Math.min(100, Math.max(1, parseInt(br.quantity || 1, 10)));
        if (!configuredChestsMap.has(boxId)) {
          configuredChestsMap.set(boxId, {
            boxId,
            expectedQty: 0,
            name: br.chest_name || 'Chest',
            shopItemId: null,
            roleId: null
          });
        }
        configuredChestsMap.get(boxId).expectedQty += qty;
      }

      for (const bc of legacyConfigChests.rows) {
        if (bc.level > reachedLevel || !bc.reward_chest_id || !bc.valid_box_id) continue;
        const boxId = bc.reward_chest_id;
        if (!configuredChestsMap.has(boxId)) {
          configuredChestsMap.set(boxId, {
            boxId,
            expectedQty: 0,
            name: bc.chest_name || 'Chest',
            shopItemId: bc.shop_item_id,
            roleId: bc.role_id || `LOOT_BOX_${boxId}`
          });
        }
        configuredChestsMap.get(boxId).expectedQty += 1;
      }

      for (const entry of configuredChestsMap.values()) {
        if (!entry.shopItemId) {
          const shopItemRes = await pool.query(
            `SELECT id, role_id FROM shop_items WHERE loot_box_id = $1 AND guild_id = $2 LIMIT 1`,
            [entry.boxId, guildId]
          );
          entry.shopItemId = shopItemRes.rows[0]?.id;
          entry.roleId = shopItemRes.rows[0]?.role_id || `LOOT_BOX_${entry.boxId}`;
        }
        if (!entry.shopItemId) continue;

        // Held quantity in inventory with source LEVEL/BATTLEPASS
        const heldRes = await pool.query(
          `SELECT id, COALESCE(quantity, 1) as quantity FROM user_inventory
           WHERE user_id = $1 AND guild_id = $2
             AND (UPPER(COALESCE(source, '')) IN ('LEVEL', 'BATTLEPASS') OR LOWER(COALESCE(purchase_source, '')) IN ('level', 'battlepass'))
             AND (shop_item_id = $3 OR (role_id LIKE 'CHEST_%' AND NULLIF(SUBSTRING(role_id FROM 7), '')::INTEGER = $4))
           ORDER BY id ASC`,
          [uid, guildId, entry.shopItemId, entry.boxId]
        );
        const heldQty = heldRes.rows.reduce((sum, r) => sum + parseInt(r.quantity || 1, 10), 0);

        // Count opened chests
        const openedRes = await pool.query(
          `SELECT COUNT(*)::INTEGER as count FROM transactions
           WHERE user_id = $1 AND guild_id = $2
             AND type = 'loot_box_reward'
             AND (reference_id = $3::text OR LOWER(description) = LOWER('Opened ' || $4))`,
          [uid, guildId, entry.boxId, entry.name]
        );
        const openedQty = parseInt(openedRes.rows[0]?.count || 0, 10);

        const accountedQty = heldQty + openedQty;
        const deficit = Math.max(0, entry.expectedQty - accountedQty);

        if (deficit > 0) {
          if (heldRes.rows.length > 0) {
            await pool.query(
              `UPDATE user_inventory SET quantity = COALESCE(quantity, 1) + $1 WHERE id = $2`,
              [deficit, heldRes.rows[0].id]
            );
          } else {
            await pool.query(
              `INSERT INTO user_inventory (user_id, guild_id, shop_item_id, role_id, is_active, source, purchase_source, quantity)
               VALUES ($1, $2, $3, $4, false, 'LEVEL', 'level', $5)`,
              [uid, guildId, entry.shopItemId, entry.roleId, deficit]
            );
          }

          sysLog('Self-Healing: Reconciled Level Chest Deficit', {
            user: uid,
            guild: guildId,
            detail: `Added ${deficit}x ${entry.name} (Expected: ${entry.expectedQty}, Held: ${heldQty}, Opened: ${openedQty})`
          });
        }
      }
    }
  } catch (err) {
    sysError('Reconcile Missing Level Rewards Failed', err, { guild: guildId, user: userId });
  }
}
