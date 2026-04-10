import { loadGuildConfigs, setGuildConfig } from '../storage/config.js';
import { getPool } from '../storage/postgres.js';
import { getQuests, resetGuildQuestProgress } from '../quests/quests.js';
import { syncQuestChannelCache } from '../activity/index.js';

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

async function checkQuests(client, forceCheck = false) {
  const now = new Date();
  
  // Normal scheduled run triggers precisely at min 0
  if (!forceCheck && now.getMinutes() !== 0) return;

  // Make sure we only run once per hour unless forced
  const hourKey = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${now.getUTCHours()}`;
  if (!forceCheck && checkQuests.lastRun === hourKey) return;
  if (!forceCheck) checkQuests.lastRun = hourKey;

  const configs = await loadGuildConfigs();
  const pool = getPool();

  for (const guildId in configs) {
    const config = configs[guildId];
    if (!config.quests_enabled) continue;
    
    // Check if current Cairo hour aligns with refresh schedule
    const cairoHour = getCairoHour();
    const refreshes = config.quests_refreshes_per_day || 1;
    
    let shouldRefresh = false;
    if (refreshes === 4 && [0, 6, 12, 18].includes(cairoHour)) shouldRefresh = true;
    else if (refreshes === 3 && [0, 8, 16].includes(cairoHour)) shouldRefresh = true;
    else if (refreshes === 2 && [0, 12].includes(cairoHour)) shouldRefresh = true;
    else if (refreshes === 1 && cairoHour === 0) shouldRefresh = true;

    // Force check runs on startup, it should only refresh if no active quests exist
    if (forceCheck) {
       if (!config.active_quest_ids || config.active_quest_ids.length === 0) {
           shouldRefresh = true;
       } else {
           shouldRefresh = false; // Already populated, let scheduled hour handle it
       }
    }

    if (!shouldRefresh) continue;

    try {
      await rotateGuildQuests(guildId, config, pool);
    } catch (err) {
      console.error(`[Quests] Auto-refresh failed for ${guildId}:`, err);
    }
  }
}

function getCairoHour() {
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Africa/Cairo',
        hour: '2-digit',
        hour12: false
    });
    // Ensure we parse correctly "24" to "0" if ICU behaves that way
    return parseInt(formatter.format(new Date()), 10) % 24;
}

export async function rotateGuildQuests(guildId, config, pool) {
    const amount = parseInt(config.quests_per_refresh) || 1;
    const allQuests = await getQuests(guildId);
    
    if (allQuests.length === 0) return;
    
    // Shuffle ignoring last_quest_ids to prevent immediate duplication
    const lastIds = config.last_quest_ids || [];
    let available = allQuests.filter(q => !lastIds.includes(q.id));
    
    // If not enough available quests to meet requested amount, fallback to selecting from all quests
    if (available.length < amount) {
        available = allQuests;
    }

    // Fisher-Yates shuffle
    for (let i = available.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [available[i], available[j]] = [available[j], available[i]];
    }

    // Safely take 'amount', if they have 3 total but request 5, it takes 3.
    const selectedIds = available.slice(0, amount).map(q => q.id);
    
    // Set config
    config.last_quest_ids = config.active_quest_ids || [];
    config.active_quest_ids = selectedIds;
    await setGuildConfig(guildId, config);

    // Delete progress for clean slate
    await resetGuildQuestProgress(guildId);
    
    // Sync memory cache for tracking engine
    await syncQuestChannelCache(guildId);

    console.log(`[Quests] Rotated ${selectedIds.length} quests for guild ${guildId}`);
}
