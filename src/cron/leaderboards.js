import { logger, sysLog, sysWarn, sysError } from '../utils/logger.js';
import { updateLeaderboards, cleanupAllLeaderboardChannels } from '../commands/leaderboard.js';
import { loadGuildConfigs } from '../storage/config.js';
import { getTimeUntilNextCairoHour, getCairoHour } from '../utils/time.js';
import { runInGuildContext } from '../shared.js';

const isTestEnv = Boolean(
    process.env.NODE_ENV === 'test' ||
    process.argv.some(arg => typeof arg === 'string' && (arg.includes('test') || arg.includes('verify_'))) ||
    process.execArgv?.some(arg => typeof arg === 'string' && arg.includes('test'))
);

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

    // --- STARTUP CLEANUP & CATCH-UP ---
    // Clean up any duplicate or orphaned leaderboard headers from prior restarts before dispatching
    try {
        await cleanupAllLeaderboardChannels(client);
    } catch (err) {
        sysError('Startup Leaderboard Cleanup Failed', err);
    }

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
    const cycleStart = performance.now();
    const isMidnight = !isStartup && getCairoHour() === 0;
    const todayStr = (await import('../utils/time.js')).getTodayCairo();

    sysLog('Leaderboard Hourly Refresh Started', {
        detail: `Syncing all configured guilds${isMidnight ? ' [MIDNIGHT — Honors Hour]' : ''}${isStartup ? ' [STARTUP CATCH-UP]' : ''}`
    });
    
    const configs = await loadGuildConfigs();
    const candidateGuildIds = Object.keys(configs || {});
    const { deleteLeaderboardConfig } = await import('../commands/leaderboard.js');

    // Filter to guilds where client is currently present to avoid redundant REST calls and 404s
    const guildIds = [];
    for (const gid of candidateGuildIds) {
        if (client.guilds?.cache?.has?.(gid)) {
            guildIds.push(gid);
        } else {
            // Not in cache; check if the guild is still accessible before dispatching
            try {
                const g = await client.guilds.fetch(gid);
                if (g) guildIds.push(gid);
            } catch (err) {
                if (err?.code === 10004 || err?.status === 404) {
                    logger.warn('CONFIG', 'Departed guild detected during hourly refresh; pruning stale leaderboard config', {
                        guildId: gid,
                        error: err?.message || 'Unknown Guild'
                    });
                    await deleteLeaderboardConfig(gid).catch(() => {});
                }
            }
        }
    }
    
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

    // ── STEP 2: Refresh leaderboard UI messages ──
    for (const guildId of guildIds) {
        await runInGuildContext(guildId, async () => {
            try {
                await updateLeaderboards(client, guildId, null, []);
            } catch (err) {
                sysError('Guild Leaderboard Sync Failed', err, { guild: guildId });
            }
        });
        const interGuildDelay = isTestEnv ? 0 : 500;
        if (interGuildDelay > 0) {
            await new Promise(r => setTimeout(r, interGuildDelay));
        }
    }

    // ── STEP 2.2: Refresh Community Interface Hubs at Midnight ──
    if (isMidnight) {
        for (const guildId of guildIds) {
            await runInGuildContext(guildId, async () => {
                try {
                    const { publishOrUpdateHub } = await import('../commands/interface.js');
                    await publishOrUpdateHub(client, guildId, { allowCreate: false });
                } catch (err) {
                    sysError('Midnight Hub Sync Failed', err, { guild: guildId });
                }
            });
            const interGuildDelay = isTestEnv ? 0 : 500;
        if (interGuildDelay > 0) {
            await new Promise(r => setTimeout(r, interGuildDelay));
        }
        }
    }

    // ── STEP 2.5: Apply Richest & Streak role rewards ──
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
        const interGuildDelay = isTestEnv ? 0 : 500;
        if (interGuildDelay > 0) {
            await new Promise(r => setTimeout(r, interGuildDelay));
        }
    }

    // ── STEP 3: Run KotH MVP cycle (roles + coins) for each guild ──
    const { runKingOfHillCycle } = await import('../mvp/kingOfHill.js');
    for (const guildId of guildIds) {
        await runInGuildContext(guildId, async () => {
            try {
                await runKingOfHillCycle(client, guildId, { payCoins: !isStartup });
            } catch (err) {
                sysError('KotH Cycle Error', err, { guild: guildId });
            }
        });
        const interGuildDelay = isTestEnv ? 0 : 500;
        if (interGuildDelay > 0) {
            await new Promise(r => setTimeout(r, interGuildDelay));
        }
    }

    // ── STEP 3.5: Run Tag Rewards cycle for each guild (Hourly & Startup Catch-up) ──
    for (const guildId of guildIds) {
        await runInGuildContext(guildId, async () => {
            try {
                const { runTagRewardsCycle } = await import('./tagRewards.js');
                await runTagRewardsCycle(client, guildId);
            } catch (err) {
                sysError('Tag Rewards Cycle Failed', err, { guild: guildId });
            }
        });
    }

    // ── MIDNIGHT STEP 4: Reset activity AFTER KotH pays out final scores ──
    for (const guildId of guildIds) {
        await runInGuildContext(guildId, async () => {
            try {
                const config = configs[guildId] || {};
                const lastReset = config.last_mvp_reset;
                const needsReset = lastReset !== todayStr;

                if (needsReset) {
                    const { resetGuildActivity } = await import('../activity/tracker.js');
                    await resetGuildActivity(guildId);
                    
                    // Track reset persistently
                    const { setGuildConfig } = await import('../storage/config.js');
                    await setGuildConfig(guildId, { last_mvp_reset: todayStr });

                    sysLog('Activity Reset Performed', { guild: guildId, detail: isMidnight ? 'Midnight Reset' : 'Catch-up Reset' });
                }
            } catch (err) {
                sysError('Activity Reset Processing Failed', err, { guild: guildId });
            }
        });
    }
    
    const durationMs = Math.round(performance.now() - cycleStart);
    logger.info('CRON', `Leaderboard hourly refresh completed in ${durationMs}ms`, { guildCount: guildIds.length, durationMs });
}
