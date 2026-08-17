import { loadGuildConfigs, setGuildConfig } from '../storage/config.js';
import { getPool } from '../storage/postgres.js';
import { getQuests, resetGuildQuestProgress } from '../quests/quests.js';
import { syncQuestChannelCache } from '../activity/index.js';
import { getCairoHour } from '../utils/time.js';
import { sysLog, sysError } from '../utils/logger.js';

export function startQuestScheduler(client) {
  // Check every minute
  setInterval(() => {
    checkQuests(client);
  }, 60000);
  
  // also run on startup after a small delay
  setTimeout(() => {
    checkQuests(client, true);
  }, 10000);
}

/**
 * Scheduled task to rotate quests for all guilds independently
 */
async function checkQuests(client, forceCheck = false) {
  const now = new Date();
  
  // Normal scheduled run triggers precisely at min 0 in Cairo
  // Note: we check minutes locally but refresh logic is gated by hours
  if (!forceCheck && now.getMinutes() !== 0) return;

  const configs = await loadGuildConfigs();
  const currentCairoHour = getCairoHour();

  // We track completion per guild+hour to ensure reliability in large clusters
  if (!checkQuests.lastRunMap) checkQuests.lastRunMap = new Map();

  const rotatedGuilds = [];

  for (const guildId in configs) {
    const config = configs[guildId];
    if (!config.quests_enabled) continue;
    
    const guildHourKey = `${guildId}:${currentCairoHour}`;
    if (!forceCheck && checkQuests.lastRunMap.get(guildHourKey)) continue;

    const refreshes = config.quests_refreshes_per_day || 1;
    let shouldRefresh = false;

    // Strict independent schedule check
    if (refreshes === 4 && [0, 6, 12, 18].includes(currentCairoHour)) shouldRefresh = true;
    else if (refreshes === 2 && [0, 12].includes(currentCairoHour)) shouldRefresh = true;
    else if (refreshes === 1 && currentCairoHour === 0) shouldRefresh = true;

    // Force check (startup) only populates if empty
    if (forceCheck) {
       if (!config.active_quest_ids || config.active_quest_ids.length === 0) shouldRefresh = true;
       else shouldRefresh = false;
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
            .setTitle('🎯 New Quests Available!')
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
 * Shuffles and selects a new batch of quests for a specific guild
 */
export async function rotateGuildQuests(guildId, config, pool, client = null, options = {}) {
    const { skipNotifications = false } = options;
    const amount = parseInt(config.quests_per_refresh) || 1;
    const allQuests = await getQuests(guildId);
    
    if (allQuests.length === 0) {
        config.active_quest_ids = [];
        config.active_quest_snapshot = null;
        await setGuildConfig(guildId, config);
        await syncQuestChannelCache(guildId);
        return false;
    }
    
    // Increment or initialize cycle
    const currentCycle = (config.current_quest_cycle || 0) + 1;
    
    // Build weighted items remaining
    let availableQuests = [...allQuests];
    const lastIds = config.active_quest_ids || [];
    
    // Count how many of the currently existing quests were active in the previous cycle
    const existingLastActiveCount = allQuests.filter(q => lastIds.includes(q.id)).length;
    
    // Strict exclusion: if the pool is large enough, filter out the quests that were active in the previous cycle
    const canStrictlyAvoid = (allQuests.length - existingLastActiveCount) >= amount;
    if (canStrictlyAvoid) {
        availableQuests = availableQuests.filter(q => !lastIds.includes(q.id));
    }
    
    let selectedIds = [];
    
    // Pick required amount of quests (or as many as we have available)
    for (let c = 0; c < Math.min(amount, allQuests.length); c++) {
        let totalWeight = 0;
        const weightedPool = [];

        for (const q of availableQuests) {
            let weight = 100; // Default max priority
            
            if (q.last_active_at === null || q.last_active_at === undefined) {
                weight = 150; // Brand New priority override
            } else {
                const distance = currentCycle - q.last_active_at;
                if (distance <= 1) weight = 0;      // Exclude immediately active quests
                else if (distance === 2) weight = 5;  // 5% relative weight (extremely low)
                else if (distance === 3) weight = 15; // 15% relative weight (low)
                else if (distance === 4) weight = 45; // 45% relative weight (medium)
                else weight = 100;                    // Used 5+ cycles ago (Max)
            }
            
            totalWeight += weight;
            weightedPool.push({ quest: q, weight, cumulativeWeight: totalWeight });
        }
        
        let randomNum = Math.random() * totalWeight;
        let pickedQuest = null;
        let pickedIndex = -1;
        
        for (let i = 0; i < weightedPool.length; i++) {
            if (randomNum <= weightedPool[i].cumulativeWeight) {
                pickedQuest = weightedPool[i].quest;
                pickedIndex = i;
                break;
            }
        }
        
        // Failsafe condition (mathematically shouldn't be needed)
        if (!pickedQuest && weightedPool.length > 0) {
             pickedQuest = weightedPool[weightedPool.length - 1].quest;
             pickedIndex = weightedPool.length - 1;
        }

        if (pickedQuest) {
            selectedIds.push(pickedQuest.id);
            availableQuests.splice(pickedIndex, 1);
        }
    }

    // Final shuffle of the selected batch for UI variety
    for (let i = selectedIds.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [selectedIds[i], selectedIds[j]] = [selectedIds[j], selectedIds[i]];
    }

    // Atomic Update to Guild Configuration
    config.last_quest_ids = lastIds;
    config.active_quest_ids = selectedIds;
    config.current_quest_cycle = currentCycle;

    // Snapshot Architecture: Capture full objects to freeze the cycle
    const selectedQuests = allQuests.filter(q => selectedIds.includes(q.id));
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
              .setTitle('🎯 New Quests Available!')
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
