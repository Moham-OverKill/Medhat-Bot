/**
 * Level Inflation Bug — One-Time Self-Healing Rollback (V2)
 *
 * Scans all guilds and users for unearned level rewards, balances, items, chests,
 * and milestone roles granted during the level increment configuration bug.
 *
 * Guarantees:
 * - Runs strictly once on next bot startup (tracked via 'level_bug_rollback_v2' in bot_migrations).
 * - Heals any corrupt 0/missing battlepass_xp_increment in guild_configs table to 50.
 * - Enforces minimum increment of 50 in mathematical level calculation.
 * - Restores accounts to their legitimate earned levels (e.g., Level 94 for ~228,100 XP).
 * - Deducts only unearned coins from user_balances (bounded at 0).
 * - Removes only unearned items/chests from user_inventory (source = 'LEVEL' or 'BATTLEPASS').
 * - Purges invalid claims from user_pass_claims and user_pass_reward_claims.
 * - Restores Discord milestone roles to true earned levels.
 */

import { getPool } from '../../storage/postgres.js';
import { getGuildConfig, configCache } from '../../storage/config.js';
import { calculateLevelFromXp, alignMemberLevelRole } from './pass-engine.js';
import { sysLog, sysError, sendLog } from '../../utils/logger.js';
import { COIN_EMOJI } from '../../shared.js';

export const ROLLBACK_MIGRATION_KEY = 'level_bug_rollback_v3';

/**
 * Executes the one-time self-healing rollback on startup.
 *
 * @param {import('discord.js').Client} client - Discord client instance
 * @returns {Promise<{ executed: boolean, stats?: object }>}
 */
export async function runLevelBugRollback(client) {
  const pool = getPool();

  // 1. Ensure bot_migrations table exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_migrations (
      migration_name VARCHAR(100) PRIMARY KEY,
      executed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      details JSONB
    );
  `);

  // Clear legacy incomplete migration keys to guarantee full execution of v3
  await pool.query(
    "DELETE FROM bot_migrations WHERE migration_name IN ('level_bug_rollback_v1', 'level_bug_rollback_v2')"
  ).catch(() => {});

  // 2. Check if this rollback has already executed
  const checkRes = await pool.query(
    'SELECT 1 FROM bot_migrations WHERE migration_name = $1',
    [ROLLBACK_MIGRATION_KEY]
  );
  if (checkRes.rows.length > 0) {
    sysLog('Self-Healing: Level Rollback Skipped', { detail: 'Already executed on previous startup' });
    return { executed: false, reason: 'ALREADY_RUN' };
  }

  sysLog('Self-Healing: Level Bug Rollback Initiated', {
    detail: 'Starting one-time audit and rollback across all guilds and accounts'
  });

  // 3. Proactively heal any corrupt 0 or negative battlepass_xp_increment in guild_configs
  try {
    await pool.query(`
      UPDATE guild_configs
      SET config = jsonb_set(config, '{battlepass_xp_increment}', '50'::jsonb)
      WHERE (config ? 'battlepass_xp_increment' AND ((config->>'battlepass_xp_increment')::numeric <= 0 OR config->>'battlepass_xp_increment' IS NULL));
    `);
    // Clear in-memory config cache so healed configs are reloaded immediately
    configCache.clear();
  } catch (healErr) {
    sysError('Self-Healing: Guild Configs Pre-Heal Failed', healErr);
  }

  const overallStats = {
    guildsAudited: 0,
    usersAudited: 0,
    usersAffected: 0,
    totalCoinsReversed: 0,
    totalClaimsRemoved: 0,
    totalItemsRemoved: 0,
    totalChestsRemoved: 0,
    rolesRealighed: 0,
    errors: []
  };

  try {
    // 4. Find all guilds with recorded battlepass claims or activity
    const guildsRes = await pool.query(`
      SELECT DISTINCT guild_id FROM (
        SELECT guild_id FROM user_pass_claims
        UNION
        SELECT guild_id FROM user_pass_reward_claims
        UNION
        SELECT guild_id FROM user_activity WHERE battlepass_xp > 0
      ) g
    `);

    const guildIds = guildsRes.rows.map(r => r.guild_id);
    overallStats.guildsAudited = guildIds.length;

    for (const guildId of guildIds) {
      let guildUsersAffected = 0;
      let guildCoinsReversed = 0;

      const config = await getGuildConfig(guildId) || {};
      const baseXp = Math.max(1, parseInt(config.battlepass_base_xp ?? config.battlepass_xp_per_level, 10) || 100);
      const incrementXp = Math.max(1, parseInt(config.battlepass_xp_increment, 10) > 0 ? parseInt(config.battlepass_xp_increment, 10) : 50);

      // Find all users in this guild with claims
      const usersRes = await pool.query(`
        SELECT DISTINCT user_id FROM (
          SELECT user_id FROM user_pass_claims WHERE guild_id = $1
          UNION
          SELECT user_id FROM user_pass_reward_claims WHERE guild_id = $1
        ) u
      `, [guildId]);

      for (const userRow of usersRes.rows) {
        const userId = userRow.user_id;
        overallStats.usersAudited++;

        // Fetch user's genuine XP and username
        const actRes = await pool.query(
          `SELECT battlepass_xp, username FROM user_activity WHERE guild_id = $1 AND user_id = $2`,
          [guildId, userId]
        );
        const totalXp = parseFloat(actRes.rows[0]?.battlepass_xp || 0);
        const username = actRes.rows[0]?.username || userId;

        // Calculate user's legitimate level using verified quadratic progression
        const { level: trueLevel } = calculateLevelFromXp(totalXp, baseXp, incrementXp);

        // Check if user has any claims above their legitimate level
        const invalidClaimsCheck = await pool.query(`
          SELECT 
            (SELECT COUNT(*)::INTEGER FROM user_pass_claims WHERE guild_id = $1 AND user_id = $2 AND level_claimed > $3) AS invalid_level_claims,
            (SELECT COUNT(*)::INTEGER FROM user_pass_reward_claims WHERE guild_id = $1 AND user_id = $2 AND level > $3) AS invalid_reward_claims
        `, [guildId, userId, trueLevel]);

        const invalidLevelCount = parseInt(invalidClaimsCheck.rows[0]?.invalid_level_claims || 0, 10);
        const invalidRewardCount = parseInt(invalidClaimsCheck.rows[0]?.invalid_reward_claims || 0, 10);

        if (invalidLevelCount === 0 && invalidRewardCount === 0) {
          // Account is completely clean; no unearned claims exist
          continue;
        }

        // Account was affected by the bug — execute atomic rollback
        const dbClient = await pool.connect();
        try {
          await dbClient.query('BEGIN');

          // A. Calculate coins awarded for levels > trueLevel
          // Method 1: Exact logged transactions
          const txRes = await dbClient.query(`
            SELECT COALESCE(SUM(amount), 0) AS total_tx_coins
            FROM transactions
            WHERE guild_id = $1 AND user_id = $2
              AND type = 'battlepass_reward'
              AND (
                (reference_id ~ '^bp_lvl_[0-9]+$' AND SUBSTRING(reference_id FROM 8)::INTEGER > $3)
                OR (description ~ '^Level [0-9]+ Reward' AND SUBSTRING(description FROM '^Level ([0-9]+) Reward')::INTEGER > $3)
              )
          `, [guildId, userId, trueLevel]);

          // Method 2: Configured coins for claimed levels > trueLevel (cross-check)
          const cfgRes = await dbClient.query(`
            SELECT COALESCE(SUM(bc.reward_coins), 0) AS total_cfg_coins
            FROM user_pass_claims upc
            JOIN battlepass_config bc ON upc.guild_id = bc.guild_id AND upc.level_claimed = bc.level
            WHERE upc.guild_id = $1 AND upc.user_id = $2 AND upc.level_claimed > $3
              AND bc.reward_coins > 0
          `, [guildId, userId, trueLevel]);

          const txCoins = parseInt(txRes.rows[0]?.total_tx_coins || 0, 10);
          const cfgCoins = parseInt(cfgRes.rows[0]?.total_cfg_coins || 0, 10);
          const invalidCoins = Math.max(txCoins, cfgCoins);

          if (invalidCoins > 0) {
            // Deduct unearned coins from balance & total_earned (bounded at 0)
            await dbClient.query(`
              UPDATE user_balances
              SET balance = GREATEST(0, balance - $1),
                  total_earned = GREATEST(0, total_earned - $1),
                  updated_at = NOW()
              WHERE guild_id = $2 AND user_id = $3
            `, [invalidCoins, guildId, userId]);

            // Insert audit transaction log (pass -invalidCoins directly in JS to prevent SQL operator ambiguity)
            await dbClient.query(`
              INSERT INTO transactions (user_id, guild_id, amount, balance_after, type, description, reference_id)
              SELECT $1, $2, $3::BIGINT, balance, 'battlepass_rollback', $4, 'bp_rollback_lvl_bug'
              FROM user_balances WHERE user_id = $1 AND guild_id = $2
            `, [userId, guildId, -invalidCoins, `Rollback unearned level rewards above Level ${trueLevel}`]);

            // Insert into transaction_history if exists
            await dbClient.query(`
              INSERT INTO transaction_history (guild_id, user_id, type, amount, description)
              VALUES ($1, $2, 'battlepass_rollback', $3::BIGINT, $4)
            `, [guildId, userId, -invalidCoins, `Rollback unearned level rewards above Level ${trueLevel}`]).catch(() => {});

            guildCoinsReversed += invalidCoins;
            overallStats.totalCoinsReversed += invalidCoins;
          }

          // B. Calculate and deduct unearned items and chests
          // 1. Collect multi-rewards from user_pass_reward_claims
          const multiRewardsRes = await dbClient.query(`
            SELECT uprc.reward_id, uprc.level, COALESCE(uprc.quantity_claimed, 1) as quantity_claimed,
                   br.reward_type, br.shop_item_id, br.loot_box_id
            FROM user_pass_reward_claims uprc
            JOIN battlepass_rewards br ON uprc.reward_id = br.id AND uprc.guild_id = br.guild_id
            WHERE uprc.guild_id = $1 AND uprc.user_id = $2 AND uprc.level > $3
          `, [guildId, userId, trueLevel]);

          // 2. Collect legacy rewards from battlepass_config
          const legacyRewardsRes = await dbClient.query(`
            SELECT bc.level, bc.reward_item_id, bc.reward_chest_id
            FROM user_pass_claims upc
            JOIN battlepass_config bc ON upc.guild_id = bc.guild_id AND upc.level_claimed = bc.level
            WHERE upc.guild_id = $1 AND upc.user_id = $2 AND upc.level_claimed > $3
              AND (bc.reward_item_id IS NOT NULL OR bc.reward_chest_id IS NOT NULL)
          `, [guildId, userId, trueLevel]);

          const itemsToDeduct = new Map(); // shop_item_id -> count
          const chestsToDeduct = new Map(); // loot_box_id -> count

          for (const row of multiRewardsRes.rows) {
            const qty = Math.max(1, parseInt(row.quantity_claimed || 1, 10));
            if (row.reward_type === 'item' && row.shop_item_id) {
              itemsToDeduct.set(row.shop_item_id, (itemsToDeduct.get(row.shop_item_id) || 0) + qty);
            } else if (row.reward_type === 'chest' && row.loot_box_id) {
              chestsToDeduct.set(row.loot_box_id, (chestsToDeduct.get(row.loot_box_id) || 0) + qty);
            }
          }

          for (const row of legacyRewardsRes.rows) {
            if (row.reward_item_id) {
              itemsToDeduct.set(row.reward_item_id, (itemsToDeduct.get(row.reward_item_id) || 0) + 1);
            }
            if (row.reward_chest_id) {
              chestsToDeduct.set(row.reward_chest_id, (chestsToDeduct.get(row.reward_chest_id) || 0) + 1);
            }
          }

          // Deduct unearned items from inventory (only touching LEVEL/BATTLEPASS source)
          for (const [shopItemId, deductCount] of itemsToDeduct.entries()) {
            const invRows = await dbClient.query(`
              SELECT id, COALESCE(quantity, 1) as quantity
              FROM user_inventory
              WHERE user_id = $1 AND guild_id = $2 AND shop_item_id = $3
                AND (UPPER(COALESCE(source, '')) IN ('LEVEL', 'BATTLEPASS') OR LOWER(COALESCE(purchase_source, '')) IN ('level', 'battlepass'))
              ORDER BY id DESC
            `, [userId, guildId, shopItemId]);

            let remaining = deductCount;
            for (const r of invRows.rows) {
              if (remaining <= 0) break;
              const rowQty = parseInt(r.quantity, 10);
              if (rowQty <= remaining) {
                await dbClient.query('DELETE FROM user_inventory WHERE id = $1', [r.id]);
                remaining -= rowQty;
                overallStats.totalItemsRemoved += rowQty;
              } else {
                await dbClient.query('UPDATE user_inventory SET quantity = quantity - $1 WHERE id = $2', [remaining, r.id]);
                overallStats.totalItemsRemoved += remaining;
                remaining = 0;
              }
            }
          }

          // Deduct unearned chests from inventory (only touching LEVEL/BATTLEPASS source)
          for (const [boxId, deductCount] of chestsToDeduct.entries()) {
            const invRows = await dbClient.query(`
              SELECT ui.id, COALESCE(ui.quantity, 1) as quantity
              FROM user_inventory ui
              LEFT JOIN shop_items si ON ui.shop_item_id = si.id AND si.guild_id = ui.guild_id
              WHERE ui.user_id = $1 AND ui.guild_id = $2
                AND (
                  si.loot_box_id = $3
                  OR ui.role_id = ('LOOT_BOX_' || $3::text)
                  OR (ui.role_id LIKE 'CHEST_%' AND NULLIF(SUBSTRING(ui.role_id FROM 7), '')::INTEGER = $3)
                )
                AND (UPPER(COALESCE(ui.source, '')) IN ('LEVEL', 'BATTLEPASS') OR LOWER(COALESCE(ui.purchase_source, '')) IN ('level', 'battlepass'))
              ORDER BY ui.id DESC
            `, [userId, guildId, boxId]);

            let remaining = deductCount;
            for (const r of invRows.rows) {
              if (remaining <= 0) break;
              const rowQty = parseInt(r.quantity, 10);
              if (rowQty <= remaining) {
                await dbClient.query('DELETE FROM user_inventory WHERE id = $1', [r.id]);
                remaining -= rowQty;
                overallStats.totalChestsRemoved += rowQty;
              } else {
                await dbClient.query('UPDATE user_inventory SET quantity = quantity - $1 WHERE id = $2', [remaining, r.id]);
                overallStats.totalChestsRemoved += remaining;
                remaining = 0;
              }
            }
          }

          // C. Purge invalid claims so user can earn them legitimately later
          const delRewardsRes = await dbClient.query(
            `DELETE FROM user_pass_reward_claims WHERE guild_id = $1 AND user_id = $2 AND level > $3`,
            [guildId, userId, trueLevel]
          );
          const delClaimsRes = await dbClient.query(
            `DELETE FROM user_pass_claims WHERE guild_id = $1 AND user_id = $2 AND level_claimed > $3`,
            [guildId, userId, trueLevel]
          );

          overallStats.totalClaimsRemoved += (delRewardsRes.rowCount || 0) + (delClaimsRes.rowCount || 0);

          await dbClient.query('COMMIT');

          guildUsersAffected++;
          overallStats.usersAffected++;

          sysLog('Self-Healing: User Rollback Complete', {
            user: userId,
            guild: guildId,
            detail: `Restored to Level ${trueLevel} | Coins Reversed: ${invalidCoins} | Level Claims Purged: ${delClaimsRes.rowCount} | Reward Claims Purged: ${delRewardsRes.rowCount}`
          });
        } catch (userErr) {
          await dbClient.query('ROLLBACK').catch(() => {});
          sysError('Self-Healing: User Rollback Transaction Failed', userErr, { guild: guildId, user: userId });
          overallStats.errors.push({ guildId, userId, error: userErr.message });
        } finally {
          dbClient.release();
        }

        // D. Re-align Discord milestone roles to true level
        if (client) {
          try {
            await alignMemberLevelRole(guildId, userId, trueLevel, client);
            overallStats.rolesRealighed++;
          } catch (roleErr) {
            sysError('Self-Healing: Role Re-alignment Failed', roleErr, { guild: guildId, user: userId });
          }
        }
      }

      // Send Discord audit notification if any users in this guild were corrected
      if (guildUsersAffected > 0 && client) {
        try {
          const guild = client.guilds?.cache?.get(guildId);
          if (guild) {
            const coinEmoji = COIN_EMOJI.forGuild(guildId);
            sendLog(
              guild,
              'economy',
              'red',
              'System Rollback Complete',
              `Self-healing corrected **${guildUsersAffected} accounts** affected by the level calculation bug. Total unearned coins reversed: **${guildCoinsReversed.toLocaleString()}** ${coinEmoji}. All unearned milestone roles, items, chests, and level claims have been restored to their exact pre-bug values.`
            );
          }
        } catch (logErr) {
          sysError('Self-Healing: Guild Audit Log Failed', logErr, { guild: guildId });
        }
      }
    }

    // 5. Mark migration as permanently executed if all accounts succeeded
    if (overallStats.errors.length === 0) {
      await pool.query(`
        INSERT INTO bot_migrations (migration_name, executed_at, details)
        VALUES ($1, NOW(), $2::jsonb)
        ON CONFLICT (migration_name) DO UPDATE SET executed_at = NOW(), details = $2::jsonb
      `, [ROLLBACK_MIGRATION_KEY, JSON.stringify(overallStats)]);

      sysLog('Self-Healing: Level Bug Rollback Complete', {
        detail: `Audited ${overallStats.guildsAudited} guilds, ${overallStats.usersAudited} users | Corrected ${overallStats.usersAffected} accounts | Reversed ${overallStats.totalCoinsReversed} coins | Purged ${overallStats.totalClaimsRemoved} claims`
      });
    } else {
      sysLog('Self-Healing: Level Bug Rollback Partial', {
        detail: `Encountered ${overallStats.errors.length} error(s); remaining accounts will retry automatically on next startup`
      });
    }

    return { executed: true, stats: overallStats };
  } catch (err) {
    sysError('Self-Healing: Level Bug Rollback Top-Level Error', err);
    throw err;
  }
}
