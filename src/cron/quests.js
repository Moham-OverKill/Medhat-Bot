import cron from 'node-cron';
import { loadGuildConfigs, setGuildConfig } from '../storage/config.js';
import { getPool } from '../storage/postgres.js';
import { getQuests, resetGuildQuestProgress } from '../quests/quests.js';
import { syncQuestChannelCache } from '../activity/index.js';
import { getCairoHour, getTodayCairo } from '../utils/time.js';
import { sysLog, sysError } from '../utils/logger.js';

export function startQuestScheduler(client) {
  // Reliable node-cron running at minute 0 of every hour in Africa/Cairo timezone
  cron.schedule('0 * * * *', () => {
    checkQuests(client, false);
  }, {
    scheduled: true,
    timezone: "Africa/Cairo"
  });

  // Run on startup after a brief delay to catch up if a rotation window was missed
  setTimeout(() => {
    checkQuests(client, true);
  }, 5000);

  sysLog('Infrastructure Audit', { detail: 'Hourly Quest Scheduler initialized (Timezone: Africa/Cairo)' });
}

/**
 * Scheduled task to rotate quests for all guilds independently
 */
async function checkQuests(client, forceCheck = false) {
  const configs = await loadGuildConfigs();
  const currentCairoHour = getCairoHour();
  const todayCairo = getTodayCairo();

  // We track completion per guild+hour to ensure reliability in large clusters
  if (!checkQuests.lastRunMap) checkQuests.lastRunMap = new Map();

  const rotatedGuilds = [];

  for (const guildId in configs) {
    const config = configs[guildId];
    const questsEnabled = config.quests_enabled ?? config.missions_enabled ?? false;
    if (!questsEnabled) continue;
    
    const guildHourKey = `${guildId}:${todayCairo}:${currentCairoHour}`;
    if (!forceCheck && checkQuests.lastRunMap.get(guildHourKey)) continue;

    const refreshes = config.quests_refreshes_per_day || 1;
    const targetAmount = parseInt(config.quests_per_refresh) || 1;
    let shouldRefresh = false;

    // Strict independent schedule check
    if (refreshes === 4 && [0, 6, 12, 18].includes(currentCairoHour)) shouldRefresh = true;
    else if (refreshes === 2 && [0, 12].includes(currentCairoHour)) shouldRefresh = true;
    else if (refreshes === 1 && currentCairoHour === 0) shouldRefresh = true;

    // Force check (startup): rotate if missing, if count mismatch, or if overdue for today
    if (forceCheck) {
       const activeIds = config.active_quest_ids || [];
       if (activeIds.length === 0 || activeIds.length !== targetAmount) {
         shouldRefresh = true;
       } else if (!config.last_quest_rotated_date || config.last_quest_rotated_date !== todayCairo) {
         shouldRefresh = true;
       } else {
         shouldRefresh = false;
       }
    }

    if (!shouldRefresh) continue;

    try {
      const { getPool } = await import('../storage/postgres.js');
      const rotated = await rotateGuildQuests(guildId, config, getPool(), client, { skipNotifications: true });
      
      if (rotated) {
        const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
        rotatedGuilds.push({ guildId, guildName: guild?.name || 'Your Server' });
      }

      // TRIGGER VOICE SWEEP (Fix for ghosting on rotation)
      const guild = client.guilds.cache.get(guildId);
      if (guild) {
        const { syncVoicePresence } = await import('../activity/tracker.js');
        await syncVoicePresence(guild);
      }

      // Mark as run for THIS guild at THIS hour
      if (!forceCheck) checkQuests.lastRunMap.set(guildHourKey, true);
      
      // Cleanup old entries from map to preserve memory
      if (checkQuests.lastRunMap.size > 500) {
          const hoursAgo = (currentCairoHour - 2 + 24) % 24;
          for (const [key] of checkQuests.lastRunMap) {
              if (key.endsWith(`:${hoursAgo}`)) checkQuests.lastRunMap.delete(key);
          }
      }
    } catch (err) {
      sysError('Quest Independent Refresh Failed', err, { guild: guildId });
    }
  }

  // Consolidated dispatch of quest rotation DMs across all rotated guilds (Single DM per user)
  if (client && rotatedGuilds.length > 0 && !forceCheck) {
    try {
      const { getUsersForNotification, NOTIFICATION_KEYS, disableUserNotificationsOnLeave } = await import('../storage/notifications.js');
      const { EmbedBuilder } = await import('discord.js');

      const userGuildsMap = new Map();

      for (const { guildId, guildName } of rotatedGuilds) {
        const guild = client.guilds?.cache?.get(guildId) || await client.guilds?.fetch(guildId).catch(() => null);
        const userIds = await getUsersForNotification(guildId, NOTIFICATION_KEYS.QUESTS_REFRESH);
        for (const uid of userIds) {
          const isStillMember = guild?.members?.cache?.has(uid) || !!(await guild?.members?.fetch(uid).catch(() => null));
          if (!isStillMember) {
            await disableUserNotificationsOnLeave(guildId, uid);
            continue;
          }
          if (!userGuildsMap.has(uid)) userGuildsMap.set(uid, new Set());
          userGuildsMap.get(uid).add(guildName);
        }
      }

      await Promise.allSettled(
        Array.from(userGuildsMap.entries()).map(async ([uid, guildNameSet]) => {
          const guildNames = Array.from(guildNameSet);
          const rotationTargetText = guildNames.length > 3
            ? `**${guildNames.length} servers**`
            : guildNames.map(name => `**${name}**`).join(', ');

          const embed = new EmbedBuilder()
            .setTitle('New Quests Available! - 🎯')
            .setDescription(`Server quests have rotated in ${rotationTargetText}!\nType \`/quest\` in servers to view and complete new tasks.`)
            .setColor(0x2ECC71);

          const user = client.users?.cache?.get(uid) || await client.users?.fetch(uid).catch(() => null);
          if (user) await user.send({ embeds: [embed] }).catch(() => {});
        })
      );
    } catch (dmErr) {
      sysError('Batch Quest Notification Dispatch Failed', dmErr);
    }
  }
}

/**
 * Shuffles and selects a new batch of quests for a specific guild with guaranteed anti-repeat deck cycling
 */
export async function rotateGuildQuests(guildId, config, pool, client = null, options = {}) {
    const { skipNotifications = false } = options;
    const amount = parseInt(config.quests_per_refresh) || 1;
    const allQuests = await getQuests(guildId);
    
    if (allQuests.length === 0) {
        config.active_quest_ids = [];
        config.active_quest_snapshot = null;
        config.quest_history_ids = [];
        await setGuildConfig(guildId, config);
        await syncQuestChannelCache(guildId);
        return false;
    }
    
    // Increment or initialize cycle
    const currentCycle = (config.current_quest_cycle || 0) + 1;
    
    // Guaranteed Anti-Repeat Deck Shuffle Algorithm
    const validQuestMap = new Map(allQuests.map(q => [Number(q.id), q]));
    
    // Clean history of any deleted quest IDs
    let historyIds = (config.quest_history_ids || [])
      .map(Number)
      .filter(id => validQuestMap.has(id));
      
    const currentActiveIds = (config.active_quest_ids || [])
      .map(Number)
      .filter(id => validQuestMap.has(id));

    // Ensure currently active quests are registered in history
    for (const id of currentActiveIds) {
      if (!historyIds.includes(id)) {
        historyIds.push(id);
      }
    }

    // Candidate quests are those NOT in recent history
    let unplayedQuests = allQuests.filter(q => !historyIds.includes(Number(q.id)));

    // If remaining unplayed quests are fewer than 'amount', the deck cycle has been completed!
    // Start a new cycle while strictly excluding currently active quests so they don't repeat immediately
    if (unplayedQuests.length < amount) {
      // Keep only currently active IDs in history to prevent back-to-back repeats
      historyIds = historyIds.filter(id => currentActiveIds.includes(id));
      unplayedQuests = allQuests.filter(q => !historyIds.includes(Number(q.id)));

      // If pool size itself is smaller than or equal to amount, allow all quests
      if (unplayedQuests.length === 0) {
        unplayedQuests = [...allQuests];
        historyIds = [];
      }
    }

    // Fisher-Yates shuffle of the unplayed candidate pool
    for (let i = unplayedQuests.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [unplayedQuests[i], unplayedQuests[j]] = [unplayedQuests[j], unplayedQuests[i]];
    }

    // Pick required amount from the unplayed pool
    const pickedQuests = unplayedQuests.slice(0, Math.min(amount, allQuests.length));
    const selectedIds = pickedQuests.map(q => Number(q.id));

    // Record newly selected IDs into history
    for (const id of selectedIds) {
      if (!historyIds.includes(id)) {
        historyIds.push(id);
      }
    }

    // If history now contains all quests in the pool, reset it to just the current selection
    if (historyIds.length >= allQuests.length) {
      historyIds = [...selectedIds];
    }

    // Final shuffle of the selected batch for UI variety
    for (let i = selectedIds.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [selectedIds[i], selectedIds[j]] = [selectedIds[j], selectedIds[i]];
    }

    // Atomic Update to Guild Configuration
    config.last_quest_ids = currentActiveIds;
    config.active_quest_ids = selectedIds;
    config.quest_history_ids = historyIds;
    config.current_quest_cycle = currentCycle;
    config.last_quest_rotated_date = getTodayCairo();
    config.last_quest_rotated_hour = getCairoHour();
    config.last_quest_rotated_at = new Date().toISOString();

    // Snapshot Architecture: Capture full objects to freeze the cycle
    const selectedQuests = allQuests.filter(q => selectedIds.includes(Number(q.id)));
    config.active_quest_snapshot = selectedQuests;

    await setGuildConfig(guildId, config);
    
    // Update quests table last_active_at tracking
    if (selectedIds.length > 0) {
        const placeholders = selectedIds.map((_, i) => `$${i + 2}`).join(',');
        await pool.query(
            `UPDATE quests SET last_active_at = $1 WHERE id IN (${placeholders})`,
            [currentCycle, ...selectedIds]
        ).catch(e => sysError('Quest History Update Failed', e, { guild: guildId }));
    }

    // Atomic Wipe of All User Progress for this guild on refresh (Garbage Collection)
    // This prevents database bloat now that the FK cascade is removed.
    await resetGuildQuestProgress(guildId);
    
    // Broadcast to tracking engine memory
    await syncQuestChannelCache(guildId);

    // Opt-in Quest Rotation DM Notifications (Standalone fallback)
    if (client && selectedQuests.length > 0 && !skipNotifications) {
      try {
        const { getUsersForNotification, NOTIFICATION_KEYS, disableUserNotificationsOnLeave } = await import('../storage/notifications.js');
        const userIds = await getUsersForNotification(guildId, NOTIFICATION_KEYS.QUESTS_REFRESH);
        const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);

        if (userIds.length > 0 && guild) {
          const validUserIds = [];
          for (const uid of userIds) {
            const isStillMember = guild.members.cache.has(uid) || !!(await guild.members.fetch(uid).catch(() => null));
            if (!isStillMember) {
              await disableUserNotificationsOnLeave(guildId, uid);
            } else {
              validUserIds.push(uid);
            }
          }

          if (validUserIds.length > 0) {
            const { EmbedBuilder } = await import('discord.js');
            const embed = new EmbedBuilder()
              .setTitle('New Quests Available! - 🎯')
              .setDescription(`Server quests have rotated in **${guild.name}**!\nType \`/quest\` in servers to view and complete new tasks.`)
              .setColor(0x2ECC71);

            await Promise.allSettled(
              validUserIds.map(async (uid) => {
                const user = client.users?.cache?.get(uid) || await client.users?.fetch(uid).catch(() => null);
                if (user) await user.send({ embeds: [embed] }).catch(() => {});
              })
            );
          }
        }
      } catch (dmErr) {
        sysError('Quest Rotation DM Failed', dmErr, { guild: guildId });
      }
    }

    // Auto-sync public community interface / server hub
    if (client) {
      try {
        const { publishOrUpdateHub } = await import('../commands/interface.js');
        await publishOrUpdateHub(client, guildId, { allowCreate: false });
      } catch (hubErr) {
        sysError('Hub Auto-Update Failed on Quest Rotation', hubErr, { guild: guildId });
      }
    }

    sysLog('Quest Smart Rotation Complete', { guild: guildId, detail: `Cycle: ${currentCycle} | Quests: ${selectedIds.length} | Snapshot Saved` });
    return true;
}
