import { getPool } from '../storage/postgres.js';
import { sysLog, sysError, sendLog } from '../utils/logger.js';

let isSweepRunning = false;

/**
 * Start the background expiration scheduler
 * @param {import('discord.js').Client} client
 */
export function startExpirationScheduler(client) {
  // Run background sweep every 30 seconds
  setInterval(() => {
    processGlobalExpiredItems(client).catch(err => {
      sysError('Expiration Scheduler Interval Error', err);
    });
  }, 30000);

  // Run immediate sweep on startup after a brief delay for Discord cache readiness
  setTimeout(() => {
    processGlobalExpiredItems(client).catch(err => {
      sysError('Expiration Scheduler Startup Error', err);
    });
  }, 5000);

  sysLog('Expiration Scheduler Initialized', { detail: 'Periodic 30s sweeper active' });
}

/**
 * Process and purge all expired items across all guilds
 * @param {import('discord.js').Client} client
 */
export async function processGlobalExpiredItems(client) {
  if (isSweepRunning) return;
  isSweepRunning = true;

  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT i.id, i.user_id, i.guild_id, i.shop_item_id, i.role_id, COALESCE(i.quantity, 1) as quantity, s.name as item_name
       FROM user_inventory i
       LEFT JOIN shop_items s ON i.shop_item_id = s.id
       WHERE i.expires_at IS NOT NULL AND i.expires_at <= NOW()`
    );

    if (result.rows.length === 0) return;

    for (const item of result.rows) {
      const currentQty = parseInt(item.quantity) || 1;
      const itemName = item.item_name || 'Temporary Item';

      // 1. Update/Delete from database
      if (currentQty > 1) {
        await pool.query(
          `UPDATE user_inventory
           SET quantity = quantity - 1, expires_at = NULL, is_active = false
           WHERE id = $1`,
          [item.id]
        );
      } else {
        await pool.query('DELETE FROM user_inventory WHERE id = $1', [item.id]);
      }

      // 2. Strip Discord Role
      let guild = null;
      let member = null;

      try {
        guild = client.guilds.cache.get(item.guild_id) || await client.guilds.fetch(item.guild_id).catch(() => null);
        if (guild) {
          member = guild.members.cache.get(item.user_id) || await guild.members.fetch(item.user_id).catch(() => null);
          if (member && item.role_id) {
            const roleIds = item.role_id.split(/[,\s]+/);
            const botHighest = guild.members.me?.roles.highest;

            for (const rId of roleIds) {
              const role = guild.roles.cache.get(rId);
              if (role && botHighest && botHighest.comparePositionTo(role) > 0) {
                await member.roles.remove(role, 'Temporary item expired (Background Sweeper)').catch(() => {});
              }
            }
          }
        }
      } catch (roleErr) {
        sysError('Expiration Role Strip Error', roleErr, { user: item.user_id, guild: item.guild_id });
      }

      // 3. System and Guild Audit Logs
      sysLog('Item Expired (Sweeper)', {
        user: item.user_id,
        guild: item.guild_id,
        detail: `Item: ${itemName} | InventoryID: ${item.id} | Remaining Quantity: ${Math.max(0, currentQty - 1)}`
      });

      if (guild) {
        const remainingNotice = currentQty > 1 ? ` (1 copy consumed, ${currentQty - 1} remaining in inventory)` : '';
        const userLabel = member ? `**${member.displayName} (${member.user.username})**` : `<@${item.user_id}>`;
        sendLog(
          guild,
          'inventory',
          'red',
          '⏳ Item Expired',
          `${userLabel}'s consumable item **${itemName}** has expired${remainingNotice}.`
        );
      }
    }
  } catch (err) {
    sysError('Global Expiration Sweep Failed', err);
  } finally {
    isSweepRunning = false;
  }
}
