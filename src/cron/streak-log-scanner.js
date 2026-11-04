import { getPool, query } from '../storage/postgres.js';
import { sysLog, sysWarn, sysError } from '../utils/logger.js';
import { ChannelType, PermissionFlagsBits } from 'discord.js';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Scan Discord economy log channels for historical streak logs.
 * Runs non-blocking in the background after bot startup.
 * 
 * @param {import('discord.js').Client} client
 */
export async function runDiscordStreakLogSweep(client) {
  if (!client || !client.isReady()) return;

  try {
    const pool = getPool();
    if (!pool) return;

    // 1. Check if already executed
    const checkMig = await query(
      "SELECT 1 FROM bot_migrations WHERE migration_name = 'discord_log_streak_sweep_v1'"
    ).catch(() => ({ rows: [] }));

    if (checkMig.rows && checkMig.rows.length > 0) {
      return;
    }

    sysLog('Streak Log Sweep Started', { detail: 'Scanning economy log channels for historical streaks' });

    // 2. Fetch all guilds with log_eco_channel_id or log_audit_channel_id configured
    const configRes = await query(`
      SELECT guild_id, 
             config->>'log_eco_channel_id' as eco_chan,
             config->>'log_audit_channel_id' as audit_chan
      FROM guild_configs
      WHERE (config->>'log_eco_channel_id') IS NOT NULL 
         OR (config->>'log_audit_channel_id') IS NOT NULL
    `);

    if (!configRes.rows || configRes.rows.length === 0) {
      await query(
        `INSERT INTO bot_migrations (migration_name, details)
         VALUES ('discord_log_streak_sweep_v1', '{"scanned_channels": 0, "streaks_updated": 0}'::jsonb)
         ON CONFLICT DO NOTHING`
      ).catch(() => {});
      return;
    }

    const userBestStreaks = new Map(); // key: `${guildId}_${userId}` -> maxStreak
    let totalMessagesScanned = 0;
    let channelsProcessed = 0;

    for (const row of configRes.rows) {
      const guildId = row.guild_id;
      const targetChannelId = row.eco_chan || row.audit_chan;
      if (!targetChannelId) continue;

      try {
        const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
        if (!guild) continue;

        const channel = guild.channels.cache.get(targetChannelId) || await guild.channels.fetch(targetChannelId).catch(() => null);
        if (!channel || channel.type !== ChannelType.GuildText) continue;

        const me = guild.members?.me;
        if (!me || !channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
          continue;
        }

        channelsProcessed++;
        let lastMessageId = null;
        let batchCount = 0;
        const maxBatches = 5; // Up to 500 messages per server

        while (batchCount < maxBatches) {
          batchCount++;
          const options = { limit: 100 };
          if (lastMessageId) options.before = lastMessageId;

          const messages = await channel.messages.fetch(options).catch(() => null);
          if (!messages || messages.size === 0) break;

          totalMessagesScanned += messages.size;

          for (const msg of messages.values()) {
            if (msg.author.id !== client.user.id) continue;
            if (!msg.embeds || msg.embeds.length === 0) continue;

            for (const embed of msg.embeds) {
              const desc = embed.description || '';
              if (!desc.includes('Streak:') || !desc.includes('User:')) continue;

              const userMatch = desc.match(/User:\s*`?<@!?(\d+)>`?/i);
              const streakMatch = desc.match(/Streak:\s*`?(\d+)\s*days?`?/i);

              if (userMatch && streakMatch) {
                const targetUserId = userMatch[1];
                const streakNum = parseInt(streakMatch[1], 10);

                if (Number.isFinite(streakNum) && streakNum > 0) {
                  const key = `${guildId}_${targetUserId}`;
                  const currentBest = userBestStreaks.get(key) || 0;
                  if (streakNum > currentBest) {
                    userBestStreaks.set(key, streakNum);
                  }
                }
              }
            }
          }

          lastMessageId = messages.last()?.id;
          if (messages.size < 100) break; // Reached end of channel history

          await sleep(150); // Rate limit protection
        }
      } catch (channelErr) {
        sysWarn(`Failed to scan channel ${targetChannelId} in guild ${guildId}`, channelErr);
      }
    }

    // 3. Batch apply findings to user_balances
    let updatedDbCount = 0;
    if (userBestStreaks.size > 0) {
      for (const [key, maxStreak] of userBestStreaks.entries()) {
        const [gId, uId] = key.split('_');
        const updateRes = await query(`
          UPDATE user_balances
          SET highest_streak = $1
          WHERE user_id = $2 AND guild_id = $3 AND highest_streak < $1
        `, [maxStreak, uId, gId]).catch(() => null);

        if (updateRes && updateRes.rowCount > 0) {
          updatedDbCount++;
        }
      }
    }

    // 4. Record migration completion
    await query(
      `INSERT INTO bot_migrations (migration_name, details)
       VALUES ('discord_log_streak_sweep_v1', jsonb_build_object(
         'channels_scanned', $1::int,
         'messages_scanned', $2::int,
         'candidates_found', $3::int,
         'promoted_accounts', $4::int
       ))
       ON CONFLICT DO NOTHING`,
      [channelsProcessed, totalMessagesScanned, userBestStreaks.size, updatedDbCount]
    ).catch(() => {});

    sysLog('Streak Log Sweep Complete', {
      detail: `Scanned: ${channelsProcessed} channels, ${totalMessagesScanned} messages | Promoted: ${updatedDbCount} records`
    });
  } catch (error) {
    sysError('Streak Log Sweep Failed', error);
  }
}
