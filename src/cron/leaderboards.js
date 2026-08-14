import { sysLog, sysError } from '../utils/logger.js';
import { updateLeaderboards } from '../commands/leaderboard.js';
import { loadGuildConfigs } from '../storage/config.js';
import { getTimeUntilNextCairoHour, getCairoHour } from '../utils/time.js';
import { runInGuildContext } from '../shared.js';

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
                await runHourlyRefresh(client, false);
            } catch (err) {
                sysError('Hourly Leaderboard Refresh Failed', err);
            }
            // Re-schedule for the next top-of-the-hour
            scheduleNext();
        }, delay);
    };

    // --- STARTUP CATCH-UP ---
    // Perform an immediate initial check in case we missed midnight due to maintenance
    // Pass isStartup = true to prevent running KotH role updates and duplicate resets on boot.
    runHourlyRefresh(client, true).catch(err => sysError('Initial Leaderboard Check Failed', err));

    scheduleNext();
}

/**
 * Logic to refresh all guilds.
 * On every hour: update leaderboard UI + run KotH MVP cycle.
 * On midnight (Cairo hour 0): voice flush BEFORE KotH, activity reset AFTER.
 */
async function runHourlyRefresh(client, isStartup = false) {
    const isMidnight = !isStartup && getCairoHour() === 0;
    const todayStr = (await import('../utils/time.js')).getTodayCairo();

    sysLog('Leaderboard Hourly Refresh Started', {
        detail: `Syncing all configured guilds${isMidnight ? ' [MIDNIGHT — Honors Hour]' : ''}${isStartup ? ' [STARTUP CATCH-UP]' : ''}`
    });
    
    const configs = await loadGuildConfigs();
    const guildIds = Object.keys(configs);
    
    // ── MIDNIGHT STEP 1: Flush voice time so final minutes are counted for KotH ──
    if (isMidnight) {
        for (const guildId of guildIds) {
            await runInGuildContext(guildId, async () => {
                try {
                    const { flushAllVoiceTime } = await import('../activity/tracker.js');
                    await flushAllVoiceTime(guildId);
                } catch (err) {
                    sysError('Midnight Voice Flush Failed', err, { guild: guildId });
                }
            });
        }
        sysLog('Midnight Pre-Processing', { detail: `Voice time flushed for ${guildIds.length} guild(s)` });
    }

    // ── STEP 2: Refresh leaderboard UI messages & Community Interface Hubs ──
    for (const guildId of guildIds) {
        await runInGuildContext(guildId, async () => {
            try {
                await updateLeaderboards(client, guildId, null, []);
                const { publishOrUpdateHub } = await import('../commands/interface.js');
                await publishOrUpdateHub(client, guildId);
            } catch (err) {
                sysError('Guild Leaderboard/Hub Sync Failed', err, { guild: guildId });
            }
        });
    }

    // ── STEP 2.5: Apply Richest & Streak role rewards ──
    if (!isStartup) {
        const { applyRichestRole, applyStreakRole } = await import('../mvp/role-assignment.js');
        for (const guildId of guildIds) {
            await runInGuildContext(guildId, async () => {
                try {
                    await applyRichestRole(client, guildId);
                } catch (err) {
                    sysError('Richest Role Apply Failed', err, { guild: guildId });
                }
                try {
                    await applyStreakRole(client, guildId);
                } catch (err) {
                    sysError('Streak Role Apply Failed', err, { guild: guildId });
                }
            });
        }
    }

    // ── STEP 3: Run KotH MVP cycle (roles + coins) for each guild ──
    if (!isStartup) {
        const { runKingOfHillCycle } = await import('../mvp/kingOfHill.js');
        for (const guildId of guildIds) {
            await runInGuildContext(guildId, async () => {
                try {
                    await runKingOfHillCycle(client, guildId);
                } catch (err) {
                    sysError('KotH Cycle Error', err, { guild: guildId });
                }
            });
        }
    } else {
        sysLog('KotH Cycle Skipped on Startup', { detail: 'Active MVPs are loaded from DB cache' });
    }

    // ── MIDNIGHT STEP 4: Reset activity AFTER KotH pays out final scores ──
    for (const guildId of guildIds) {
        await runInGuildContext(guildId, async () => {
            try {
                const config = configs[guildId] || {};
                const lastReset = config.last_mvp_reset;
                const needsReset = lastReset !== todayStr;

                if (needsReset) {
                    // ── STEP 3.5: Run Tag Rewards cycle (daily) before reset ──
                    try {
                        const { runTagRewardsCycle } = await import('./tagRewards.js');
                        await runTagRewardsCycle(client, guildId);
                    } catch (err) {
                        sysError('Tag Rewards Cycle Failed', err, { guild: guildId });
                    }

                    const { resetGuildActivity } = await import('../activity/tracker.js');
                    await resetGuildActivity(guildId);
                    
                    // Track reset persistently
                    const { getGuildConfig, setGuildConfig } = await import('../storage/config.js');
                    const fresh = await getGuildConfig(guildId) || config;
                    fresh.last_mvp_reset = todayStr;
                    await setGuildConfig(guildId, fresh);

                    sysLog('Activity Reset Performed', { guild: guildId, detail: isMidnight ? 'Midnight Reset' : 'Catch-up Reset' });
                }
            } catch (err) {
                sysError('Activity Reset Processing Failed', err, { guild: guildId });
            }
        });
    }
    
    sysLog('Leaderboard Hourly Refresh Complete', { detail: `Processed ${guildIds.length} guild(s)` });
}
