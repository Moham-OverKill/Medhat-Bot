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
      await rotateGuildQuests(guildId, config, getPool());
      
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
}

/**
 * Shuffles and selects a new batch of quests for a specific guild
 */
export async function rotateGuildQuests(guildId, config, pool) {
    const amount = parseInt(config.quests_per_refresh) || 1;
    const allQuests = await getQuests(guildId);
    
    if (allQuests.length === 0) {
        config.active_quest_ids = [];
        config.active_quest_snapshot = null;
        await setGuildConfig(guildId, config);
        await syncQuestChannelCache(guildId);
        return;
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
                if (distance <= 1) weight = 1;      // Just used (1% base)
                else if (distance === 2) weight = 25; // Used 2 cycles ago (Low)
                else if (distance === 3) weight = 50; // Used 3 cycles ago (Medium)
                else weight = 100;                    // Used 4+ cycles ago (Max)
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
    
    // Update the DB last_active_at for the picked quests to cement their history
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

    sysLog('Quest Smart Rotation Complete', { guild: guildId, detail: `Cycle: ${currentCycle} | Quests: ${selectedIds.length} | Snapshot Saved` });
}
