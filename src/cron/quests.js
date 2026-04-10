import { loadGuildConfigs, setGuildConfig } from '../storage/config.js';
import { getPool } from '../storage/postgres.js';
import { getQuests, resetGuildQuestProgress } from '../quests/quests.js';
import { syncQuestChannelCache } from '../activity/index.js';
import { getCairoHour } from '../utils/time.js';

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
      console.error(`[Quests] Independent refresh failed for guild ${guildId}:`, err);
    }
  }
}

/**
 * Shuffles and selects a new batch of quests for a specific guild
 */
export async function rotateGuildQuests(guildId, config, pool) {
    const amount = parseInt(config.quests_per_refresh) || 1;
    const allQuests = await getQuests(guildId);
    
    if (allQuests.length === 0) return;
    
    // Shuffle logic with duplication prevention (don't repeat immediately previous quest IDs)
    const lastIds = config.last_quest_ids || [];
    let available = allQuests.filter(q => !lastIds.includes(q.id));
    
    if (available.length < amount) {
        available = allQuests;
    }

    // Fisher-Yates shuffle
    for (let i = available.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [available[i], available[j]] = [available[j], available[i]];
    }

    const selectedIds = available.slice(0, amount).map(q => q.id);
    
    // Atomic Update to Guild Configuration
    config.last_quest_ids = config.active_quest_ids || [];
    config.active_quest_ids = selectedIds;
    await setGuildConfig(guildId, config);

    // Atomic Wipe of All User Progress for this guild on refresh
    await resetGuildQuestProgress(guildId);
    
    // Broadcast to tracking engine memory
    await syncQuestChannelCache(guildId);

    console.log(`[Quests] [Guild ${guildId}] Isolated rotation complete. ${selectedIds.length} quests active.`);
}
