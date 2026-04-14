import { sysLog, sysError } from '../utils/logger.js';
import { updateLeaderboards } from '../commands/leaderboard.js';
import { loadGuildConfigs } from '../storage/config.js';
import { getTimeUntilNextCairoHour, getCairoHour } from '../utils/time.js';

/**
 * Static Cairo Hourly Ticker
 * Automatically refreshes all leaderboard channels every hour on the hour (Cairo Time).
 * Also runs the King of the Hill MVP cycle for each guild.
 * At midnight (Cairo 00:00): flushes voice data FIRST, runs KotH, THEN resets daily activity.
 */
export async function startLeaderboardScheduler(client) {
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
 * Logic to refresh all guilds.
 * On every hour: update leaderboard UI + run KotH MVP cycle.
 * On midnight (Cairo hour 0): voice flush BEFORE KotH, activity reset AFTER.
 */
async function runHourlyRefresh(client) {
    const isMidnight = getCairoHour() === 0;
    sysLog('Leaderboard Hourly Refresh Started', {
        detail: `Syncing all configured guilds${isMidnight ? ' [MIDNIGHT — Honors Hour]' : ''}`
    });
    
    const configs = await loadGuildConfigs();
    const guildIds = Object.keys(configs);
    
    // ── MIDNIGHT STEP 1: Flush voice time so final minutes are counted for KotH ──
    if (isMidnight) {
        for (const guildId of guildIds) {
            try {
                const { flushAllVoiceTime } = await import('../activity/tracker.js');
                await flushAllVoiceTime(guildId);
            } catch (err) {
                sysError('Midnight Voice Flush Failed', err, { guild: guildId });
            }
        }
        sysLog('Midnight Pre-Processing', { detail: `Voice time flushed for ${guildIds.length} guild(s)` });
    }

    // ── STEP 2: Refresh leaderboard UI messages ──
    for (const guildId of guildIds) {
        try {
            await updateLeaderboards(client, guildId, null, []);
        } catch (err) {
            sysError('Guild Leaderboard Sync Failed', err, { guild: guildId });
        }
    }

    // ── STEP 3: Run KotH MVP cycle (roles + coins) for each guild ──
    const { runKingOfHillCycle } = await import('../mvp/kingOfHill.js');
    for (const guildId of guildIds) {
        try {
            await runKingOfHillCycle(client, guildId);
        } catch (err) {
            sysError('KotH Cycle Error', err, { guild: guildId });
        }
    }

    // ── MIDNIGHT STEP 4: Reset activity AFTER KotH pays out final scores ──
    if (isMidnight) {
        for (const guildId of guildIds) {
            try {
                const { resetGuildActivity } = await import('../activity/tracker.js');
                await resetGuildActivity(guildId);
            } catch (err) {
                sysError('Midnight Activity Reset Failed', err, { guild: guildId });
            }
        }
        sysLog('Midnight Post-Processing', { detail: `Activity reset for ${guildIds.length} guild(s)` });
    }
    
    sysLog('Leaderboard Hourly Refresh Complete', { detail: `Processed ${guildIds.length} guild(s)` });
}
