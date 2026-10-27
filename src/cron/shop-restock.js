import { getPool } from '../storage/postgres.js';
import { logger, sysLog, sysError } from '../utils/logger.js';
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
  const cycleStart = performance.now();

  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT sp.message_id, sp.guild_id, sp.channel_id, sp.item_id,
              sp.max_stock, sp.restock_interval_seconds, sp.last_restocked_at,
              sp.claim_limit_per_user, sp.current_stock,
              si.name as item_name
       FROM shop_posts sp
       JOIN shop_items si ON sp.item_id = si.id
       WHERE sp.restock_interval_seconds IS NOT NULL
         AND sp.restock_interval_seconds > 0
         AND (
           sp.last_restocked_at IS NULL
           OR sp.last_restocked_at <= NOW() - (sp.restock_interval_seconds * INTERVAL '1 second')
         )
       ORDER BY sp.last_restocked_at ASC NULLS FIRST
       LIMIT 10`
    );

    if (result.rows.length === 0) return;

    logger.debug('CRON:RESTOCK', 'Starting auto-restock cycle', { eligibleCount: result.rows.length });
    let restockedCount = 0;

    for (const row of result.rows) {
      try {
        // 1. Verify guild exists
        const guild = client.guilds.cache.get(row.guild_id) || await client.guilds.fetch(row.guild_id).catch(() => null);
        if (!guild) continue;

        // 2. Verify channel exists
        const channel = guild.channels.cache.get(row.channel_id) || await guild.channels.fetch(row.channel_id).catch(() => null);
        if (!channel) {
          // Channel missing or deleted: clean up orphan post without restocking
          await pool.query('DELETE FROM shop_posts WHERE message_id = $1', [row.message_id]).catch(() => {});
          await pool.query('DELETE FROM shop_drop_claims WHERE message_id = $1', [row.message_id]).catch(() => {});
          sysLog('Shop Post Orphan Cleaned', { detail: `Channel ${row.channel_id} was deleted; removed post ${row.message_id} without restocking` });
          continue;
        }

        // 3. Verify message exists in Discord BEFORE modifying shop_items or resetting claims
        let message = null;
        try {
          message = await channel.messages.fetch(row.message_id);
        } catch (fetchErr) {
          if (fetchErr.code === 10008 || fetchErr.status === 404) {
            // Unknown Message: message was deleted to disable the item. Clean up post and DO NOT restock.
            await pool.query('DELETE FROM shop_posts WHERE message_id = $1', [row.message_id]).catch(() => {});
            await pool.query('DELETE FROM shop_drop_claims WHERE message_id = $1', [row.message_id]).catch(() => {});
            sysLog('Shop Post Orphan Cleaned', { detail: `Message ${row.message_id} was deleted; post removed and restock skipped` });
            continue;
          }
          sysError('Auto Restock Message Fetch Error', fetchErr, { messageId: row.message_id, itemId: row.item_id });
          continue;
        }

        if (!message) {
          await pool.query('DELETE FROM shop_posts WHERE message_id = $1', [row.message_id]).catch(() => {});
          await pool.query('DELETE FROM shop_drop_claims WHERE message_id = $1', [row.message_id]).catch(() => {});
          continue;
        }

        // 4. Message exists. Proceed with database restock and UI update:
        // Refill post-level stock independently without touching global catalog stock (shop_items)
        const refilledStock = (row.max_stock !== null && row.max_stock > 0) ? row.max_stock : null;

        // Clear user claims for this post so users can claim again in the new cycle
        await pool.query(
          `DELETE FROM shop_drop_claims WHERE message_id = $1`,
          [row.message_id]
        );

        // Update shop_posts current_stock, timestamp, and post_mode
        await pool.query(
          `UPDATE shop_posts SET current_stock = $1, last_restocked_at = NOW(), post_mode = 'auto', updated_at = NOW() WHERE message_id = $2`,
          [refilledStock, row.message_id]
        );

        await refreshShopMessageUI({ message, client, guildId: row.guild_id }, row.item_id, row.guild_id);
        restockedCount++;
        logger.info('CRON:RESTOCK', `Restocked item "${row.item_name}"`, {
          guildId: row.guild_id,
          messageId: row.message_id,
          itemId: row.item_id
        });
      } catch (postErr) {
        logger.error('CRON:RESTOCK', 'Auto Restock Single Post Error', { messageId: row.message_id, itemId: row.item_id }, postErr);
      }

      // Throttling delay between posts to prevent 429 rate limits
      await new Promise(resolve => setTimeout(resolve, 1500));
    }

    const durationMs = Math.round(performance.now() - cycleStart);
    logger.info('CRON:RESTOCK', `Restock cycle finished in ${durationMs}ms`, {
      evaluatedCount: result.rows.length,
      restockedCount,
      durationMs
    });
  } catch (err) {
    logger.error('CRON:RESTOCK', 'Shop Restock Sweeper Failed', null, err);
  } finally {
    isRestockRunning = false;
  }
}
