import { sysLog, sysError } from '../utils/logger.js';
import { updateLeaderboards } from '../commands/leaderboard.js';
import { loadGuildConfigs } from '../storage/config.js';
import { getTimeUntilNextCairoHour } from '../utils/time.js';

/**
 * Static Cairo Hourly Ticker
 * Automatically refreshes all leaderboard channels every hour on the hour (Cairo Time).
 */
export async function startLeaderboardScheduler(client) {
    // 1. Initial run to sync at startup (optional, but good for immediate feedback)
    // We'll skip it here because updateLeaderboards might run during MVP cycles too.
    
    const scheduleNext = () => {
        const delay = getTimeUntilNextCairoHour();
        
        sysLog('Leaderboard Cron Scheduled', { detail: `Next sync in ${Math.round(delay / 60000)}m (Cairo Hourly)` });
        
        setTimeout(async () => {
            try {
                await runHourlyRefresh(client);
            } catch (err) {
                sysError('Hourly Leaderboard Refresh Failed', err);
            }
            // Re-schedule for the next top-of-the-hour
            scheduleNext();
        }, delay);
    };

    scheduleNext();
}

/**
 * Logic to refresh all guilds
 */
async function runHourlyRefresh(client) {
    sysLog('Leaderboard Hourly Refresh Started', { detail: 'Syncing all configured guilds' });
    
    const configs = await loadGuildConfigs();
    const guildIds = Object.keys(configs);
    
    for (const guildId of guildIds) {
        try {
            // Pass null for activityData to trigger the "Live Race" view
            await updateLeaderboards(client, guildId, null, []);
        } catch (err) {
            sysError('Guild Leaderboard Sync Failed', err, { guild: guildId });
        }
    }
    
    sysLog('Leaderboard Hourly Refresh Complete', { detail: `Processed ${guildIds.length} guilds` });
}
