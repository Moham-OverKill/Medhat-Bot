import { PermissionFlagsBits } from 'discord.js';
import { getPool } from '../storage/postgres.js';
import { logger, sysLog, sysError } from '../utils/logger.js';
import { refreshShopMessageUI } from '../commands/bank.js';
import { publishOrUpdateHub } from '../commands/interface.js';
import { getColorRoles } from '../storage/colors.js';
import { buildColorPanelPayload } from '../commands/colors.js';

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
              sp.custom_description,
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
 * Sweeps and heals color panel messages across Discord channels.
 * Detects messages overwritten by "Color <@&...>" or missing components/attachments,
 * resolves the target color role and panel index, and restores the full visual palette card.
 *
 * @param {import('discord.js').Client} client
 */
export async function healColorPanels(client) {
  const pool = getPool();
  try {
    const healedMessageIds = new Set();

    // 1. Audit tracked color_panels table
    const trackedResult = await pool.query(
      `SELECT message_id, guild_id, channel_id, panel_type, panel_index FROM color_panels ORDER BY created_at DESC`
    ).catch(() => ({ rows: [] }));

    for (const row of trackedResult.rows) {
      try {
        const guild = client.guilds.cache.get(row.guild_id) || await client.guilds.fetch(row.guild_id).catch(() => null);
        if (!guild) continue;

        const channel = guild.channels.cache.get(row.channel_id) || await guild.channels.fetch(row.channel_id).catch(() => null);
        if (!channel || !channel.isTextBased()) {
          await pool.query('DELETE FROM color_panels WHERE message_id = $1', [row.message_id]).catch(() => {});
          continue;
        }

        let message = null;
        try {
          message = await channel.messages.fetch(row.message_id);
        } catch (fetchErr) {
          if (fetchErr.code === 10008 || fetchErr.status === 404) {
            await pool.query('DELETE FROM color_panels WHERE message_id = $1', [row.message_id]).catch(() => {});
            continue;
          }
          continue;
        }
        if (!message) continue;

        healedMessageIds.add(message.id);

        const hasCorruptedContent = Boolean(message.content && message.content.includes('Color <@&'));
        const hasMissingComponents = !message.components || message.components.length === 0;
        const hasMissingAttachments = !message.attachments || message.attachments.size === 0;

        if (hasCorruptedContent || hasMissingComponents || hasMissingAttachments) {
          const payload = await buildColorPanelPayload(guild, row.panel_type, row.panel_index);
          if (payload) {
            await message.edit(payload).catch(() => {});
            sysLog('Tracked Color Panel Self-Healed', {
              guild: row.guild_id,
              channel: row.channel_id,
              messageId: row.message_id,
              panelIndex: row.panel_index,
              type: row.panel_type
            });
          }
        }
      } catch (err) {
        sysError('Single Tracked Color Panel Heal Error', err, { messageId: row.message_id });
      }
      await new Promise(r => setTimeout(r, 1000));
    }

    // 2. Discover and heal untracked / corrupted color panel messages in Discord channels
    for (const guild of client.guilds.cache.values()) {
      try {
        const [normalColors, boosterColors] = await Promise.all([
          getColorRoles(guild.id, false),
          getColorRoles(guild.id, true)
        ]);

        if (normalColors.length === 0 && boosterColors.length === 0) continue;

        const allRoles = await guild.roles.fetch().catch(() => guild.roles.cache);

        const sortedNormal = normalColors
          .map(c => ({ ...c, role: allRoles.get(c.roleId), position: allRoles.get(c.roleId)?.position || 0 }))
          .filter(c => c.role)
          .sort((a, b) => b.position - a.position);

        const sortedBooster = boosterColors
          .map(c => ({ ...c, role: allRoles.get(c.roleId), position: allRoles.get(c.roleId)?.position || 0 }))
          .filter(c => c.role)
          .sort((a, b) => b.position - a.position);

        const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
        if (!botMember) continue;

        const textChannels = guild.channels.cache.filter(c =>
          c.isTextBased() &&
          c.permissionsFor(botMember)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])
        );

        for (const channel of textChannels.values()) {
          try {
            const recentMessages = await channel.messages.fetch({ limit: 25 }).catch(() => null);
            if (!recentMessages) continue;

            for (const msg of recentMessages.values()) {
              if (msg.author.id !== client.user.id || healedMessageIds.has(msg.id)) continue;

              const match = msg.content?.match(/Color\s+<@&(\d+)>\s+(Selected|Removed)/i);
              let targetRoleId = match ? match[1] : null;
              let inferredType = null;
              let inferredIndex = -1;

              if (targetRoleId) {
                const normIdx = sortedNormal.findIndex(c => c.roleId === targetRoleId);
                if (normIdx !== -1) {
                  inferredType = 'normal';
                  inferredIndex = Math.floor(normIdx / 10);
                } else {
                  const bstIdx = sortedBooster.findIndex(c => c.roleId === targetRoleId);
                  if (bstIdx !== -1) {
                    inferredType = 'booster';
                    inferredIndex = Math.floor(bstIdx / 10);
                  }
                }
              } else if (msg.components && msg.components.length > 0) {
                const btn = msg.components[0]?.components?.find(c => c.customId?.startsWith('color_'));
                if (btn?.customId && (!msg.attachments || msg.attachments.size === 0)) {
                  const parts = btn.customId.split('_');
                  inferredType = parts[1] || 'normal';
                  const list = inferredType === 'booster' ? sortedBooster : sortedNormal;
                  const idx = list.findIndex(c => c.roleId === parts[2]);
                  if (idx !== -1) {
                    inferredIndex = Math.floor(idx / 10);
                  }
                }
              }

              if (inferredType && inferredIndex !== -1) {
                const preloaded = inferredType === 'booster' ? sortedBooster : sortedNormal;
                const payload = await buildColorPanelPayload(guild, inferredType, inferredIndex, preloaded);
                if (payload) {
                  await msg.edit(payload).catch(() => {});
                  healedMessageIds.add(msg.id);

                  await pool.query(
                    `INSERT INTO color_panels (message_id, guild_id, channel_id, panel_type, panel_index, created_at)
                     VALUES ($1, $2, $3, $4, $5, NOW())
                     ON CONFLICT (message_id) DO UPDATE SET
                       panel_type = EXCLUDED.panel_type,
                       panel_index = EXCLUDED.panel_index`,
                    [msg.id, guild.id, channel.id, inferredType, inferredIndex]
                  ).catch(() => {});

                  sysLog('Discovered Corrupted Color Panel Restored', {
                    guild: guild.id,
                    channel: channel.id,
                    messageId: msg.id,
                    type: inferredType,
                    panelIndex: inferredIndex
                  });
                }
              }
            }
          } catch (_) {}
          await new Promise(r => setTimeout(r, 500));
        }
      } catch (guildErr) {
        sysError('Guild Color Panels Discovery Error', guildErr, { guild: guild.id });
      }
    }
  } catch (err) {
    sysError('Color Panels Self-Healing Sweep Failed', err);
  }
}

/**
 * Initializes startup self-healing for shop posts, hub interfaces, and color panels.
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
      const healStart = performance.now();
      sysLog('Startup Self-Healing Initiated', { detail: 'Scanning shop posts, community hub interfaces, and color panels' });
      await healShopPosts(client);
      await healHubInterfaces(client);
      await healColorPanels(client);
      const durationMs = Math.round(performance.now() - healStart);
      logger.info('SERVER', `Startup self-healing completed in ${durationMs}ms`, { durationMs });
    } catch (err) {
      sysError('Startup Self-Healing Failed', err);
    } finally {
      isSelfHealingRunning = false;
    }
  }, 5000);
}
