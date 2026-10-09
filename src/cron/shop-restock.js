import { getPool } from '../storage/postgres.js';
import { sysLog, sysError } from '../utils/logger.js';
import { refreshShopMessageUI } from '../commands/bank.js';

let isRestockRunning = false;

/**
 * Start the background auto-restock scheduler.
 * @param {import('discord.js').Client} client
 */
export function startShopRestockScheduler(client) {
  // Run background check every 60 seconds
  setInterval(() => {
    processAutoRestocks(client).catch(err => {
      sysError('Shop Restock Interval Error', err);
    });
  }, 60000);

  // Initial run 10 seconds after startup
  setTimeout(() => {
    processAutoRestocks(client).catch(err => {
      sysError('Shop Restock Startup Error', err);
    });
  }, 10000);

  sysLog('Shop Restock Scheduler Initialized', { detail: 'Periodic 60s sweeper active' });
}

/**
 * Scan for eligible auto-restock shop posts and refill their stocks.
 * Sequential execution with 1,500ms pause between Discord updates to prevent rate limiting.
 * @param {import('discord.js').Client} client
 */
export async function processAutoRestocks(client) {
  if (isRestockRunning) return;
  isRestockRunning = true;

  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT sp.message_id, sp.guild_id, sp.channel_id, sp.item_id,
              sp.max_stock, sp.restock_interval_seconds, sp.last_restocked_at,
              si.name as item_name, si.stock as current_stock
       FROM shop_posts sp
       JOIN shop_items si ON sp.item_id = si.id
       WHERE sp.post_mode = 'auto'
         AND sp.max_stock IS NOT NULL
         AND sp.restock_interval_seconds IS NOT NULL
         AND (si.stock IS NULL OR si.stock < sp.max_stock)
         AND (
           sp.last_restocked_at IS NULL
           OR sp.last_restocked_at <= NOW() - (sp.restock_interval_seconds || ' seconds')::interval
         )
       ORDER BY sp.last_restocked_at ASC NULLS FIRST
       LIMIT 10`
    );

    if (result.rows.length === 0) return;

    for (const row of result.rows) {
      try {
        // 1. Update database stock and timestamp
        await pool.query(
          `UPDATE shop_items SET stock = $1 WHERE id = $2`,
          [row.max_stock, row.item_id]
        );
        await pool.query(
          `UPDATE shop_posts SET last_restocked_at = NOW() WHERE message_id = $1`,
          [row.message_id]
        );

        // 2. Fetch Discord message
        const guild = client.guilds.cache.get(row.guild_id) || await client.guilds.fetch(row.guild_id).catch(() => null);
        if (!guild) continue;

        const channel = guild.channels.cache.get(row.channel_id) || await guild.channels.fetch(row.channel_id).catch(() => null);
        if (!channel) {
          // Channel missing or deleted
          continue;
        }

        let message = null;
        try {
          message = await channel.messages.fetch(row.message_id);
        } catch (fetchErr) {
          if (fetchErr.code === 10008) {
            // Unknown Message: delete orphan record
            await pool.query('DELETE FROM shop_posts WHERE message_id = $1', [row.message_id]).catch(() => {});
            sysLog('Shop Post Orphan Cleaned', { detail: `Message ${row.message_id} was deleted by admin` });
          }
          continue;
        }

        if (message) {
          await refreshShopMessageUI({ message, guildId: row.guild_id }, row.item_id, row.guild_id);
          sysLog('Auto Shop Restock Executed', {
            guild: row.guild_id,
            detail: `Item ${row.item_name} restocked to ${row.max_stock} (Message: ${row.message_id})`
          });
        }
      } catch (postErr) {
        sysError('Auto Restock Single Post Error', postErr, { messageId: row.message_id, itemId: row.item_id });
      }

      // Throttling delay between posts to prevent 429 rate limits
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  } catch (err) {
    sysError('Shop Restock Sweeper Failed', err);
  } finally {
    isRestockRunning = false;
  }
}
