import { getPool } from '../storage/postgres.js';
import { sysLog, sysError } from '../utils/logger.js';
import { refreshShopMessageUI } from '../commands/bank.js';
import { publishOrUpdateHub } from '../commands/interface.js';

let isSelfHealingRunning = false;

/**
 * Sweeps and heals all active shop posts across Discord channels.
 * Replaces corrupted error embeds, restores buttons, and cleans up deleted message orphans.
 *
 * @param {import('discord.js').Client} client
 */
export async function healShopPosts(client) {
  const pool = getPool();
  try {
    const result = await pool.query(
      `SELECT sp.message_id, sp.guild_id, sp.channel_id, sp.item_id,
              sp.custom_image_url, sp.post_mode, sp.claim_limit_per_user,
              sp.restock_interval_seconds, sp.last_restocked_at,
              sp.max_stock, sp.current_stock, sp.override_price, sp.auto_equip,
              sp.created_at,
              si.name as item_name
       FROM shop_posts sp
       LEFT JOIN shop_items si ON sp.item_id = si.id
       ORDER BY sp.created_at DESC`
    );

    if (result.rows.length === 0) {
      sysLog('Shop Self-Healing Check', { detail: 'No active shop posts found in database' });
      return;
    }

    sysLog('Shop Self-Healing Audit Started', { detail: `Verifying ${result.rows.length} posted shop items` });

    for (const row of result.rows) {
      try {
        // 1. Verify item exists in shop catalog
        if (!row.item_name) {
          await pool.query('DELETE FROM shop_posts WHERE message_id = $1', [row.message_id]).catch(() => {});
          await pool.query('DELETE FROM shop_drop_claims WHERE message_id = $1', [row.message_id]).catch(() => {});
          sysLog('Shop Post Orphan Pruned', { detail: `Item ${row.item_id} deleted from catalog; removed post ${row.message_id}` });
          continue;
        }

        // 2. Verify guild accessibility
        const guild = client.guilds.cache.get(row.guild_id) || await client.guilds.fetch(row.guild_id).catch(() => null);
        if (!guild) continue;

        // 3. Verify channel accessibility
        const channel = guild.channels.cache.get(row.channel_id) || await guild.channels.fetch(row.channel_id).catch(() => null);
        if (!channel || !channel.isTextBased()) {
          await pool.query('DELETE FROM shop_posts WHERE message_id = $1', [row.message_id]).catch(() => {});
          await pool.query('DELETE FROM shop_drop_claims WHERE message_id = $1', [row.message_id]).catch(() => {});
          sysLog('Shop Post Orphan Pruned', { detail: `Channel ${row.channel_id} inaccessible; removed post ${row.message_id}` });
          continue;
        }

        // 4. Fetch the message from Discord
        let message = null;
        try {
          message = await channel.messages.fetch(row.message_id);
        } catch (fetchErr) {
          if (fetchErr.code === 10008 || fetchErr.status === 404) {
            // Unknown Message: deleted by an administrator in Discord
            await pool.query('DELETE FROM shop_posts WHERE message_id = $1', [row.message_id]).catch(() => {});
            await pool.query('DELETE FROM shop_drop_claims WHERE message_id = $1', [row.message_id]).catch(() => {});
            sysLog('Shop Post Orphan Pruned', { detail: `Message ${row.message_id} was deleted; removed DB record` });
            continue;
          }
          sysError('Startup Heal Message Fetch Error', fetchErr, { messageId: row.message_id, itemId: row.item_id });
          continue;
        }

        if (!message) continue;

        // 5. Inspect message integrity
        const firstEmbed = message.embeds?.[0];
        const title = firstEmbed?.title || '';
        const isCorrupted = !firstEmbed ||
          !title ||
          title.includes('Action Execution Failed') ||
          title.includes('Error') ||
          title.includes('❌') ||
          title.includes('Missing Permissions') ||
          title !== row.item_name;

        const hasValidButton = message.components?.[0]?.components?.some(c =>
          c.customId?.startsWith('bank_shop_buy_') || c.customId?.startsWith('force_buy_')
        );

        // Always heal if corrupted or missing buttons; otherwise sync stock and buttons cleanly
        await refreshShopMessageUI({ message, client, guildId: row.guild_id }, row.item_id, row.guild_id);

        if (isCorrupted || !hasValidButton) {
          sysLog('Shop Post Restored from Corruption', {
            guild: row.guild_id,
            channel: row.channel_id,
            messageId: row.message_id,
            item: row.item_name
          });
        }
      } catch (postErr) {
        sysError('Single Shop Post Self-Heal Error', postErr, { messageId: row.message_id, itemId: row.item_id });
      }

      // Throttling to prevent Discord API rate limits
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } catch (err) {
    sysError('Shop Posts Self-Healing Sweep Failed', err);
  }
}

/**
 * Sweeps and heals community hub interfaces across all guilds.
 * Ensures any corrupted hub message is restored to the clean grid.
 *
 * @param {import('discord.js').Client} client
 */
export async function healHubInterfaces(client) {
  try {
    for (const guild of client.guilds.cache.values()) {
      try {
        const updated = await publishOrUpdateHub(client, guild.id, { allowCreate: false });
        if (updated) {
          sysLog('Hub Interface Self-Healed', { guild: guild.id });
        }
      } catch (hubErr) {
        sysError('Hub Interface Self-Heal Error', hubErr, { guild: guild.id });
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } catch (err) {
    sysError('Hub Interfaces Self-Healing Sweep Failed', err);
  }
}

/**
 * Initializes startup self-healing for shop posts and hub interfaces.
 * Runs non-blocking after a short delay to allow Discord gateway caching.
 *
 * @param {import('discord.js').Client} client
 */
export function startStartupSelfHealing(client) {
  if (isSelfHealingRunning) return;

  setTimeout(async () => {
    if (isSelfHealingRunning) return;
    isSelfHealingRunning = true;
    try {
      sysLog('Startup Self-Healing Initiated', { detail: 'Scanning shop posts and community hub interfaces' });
      await healShopPosts(client);
      await healHubInterfaces(client);
      sysLog('Startup Self-Healing Complete', { detail: 'All posted shop items and community hub interfaces verified and synchronized' });
    } catch (err) {
      sysError('Startup Self-Healing Failed', err);
    } finally {
      isSelfHealingRunning = false;
    }
  }, 5000);
}
