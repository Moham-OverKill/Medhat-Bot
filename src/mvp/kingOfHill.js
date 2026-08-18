import { getGuildConfig } from '../storage/config.js';
import { getTopActiveUsers } from '../activity/tracker.js';
import { getActiveMvps, setActiveMvps } from '../storage/activeMvps.js';
import { setMvpCache } from './mvpCache.js';
import { updateBalance } from '../economy/service.js';
import { sendLog, sysLog, sysError } from '../utils/logger.js';
import { COIN_EMOJI, executeWithRetry } from '../shared.js';
import { query } from '../storage/postgres.js';

// Per-guild lock to prevent concurrent KotH executions
const guildKothLocks = new Map();

function acquireKothLock(guildId) {
  if (guildKothLocks.has(guildId)) return null;
  guildKothLocks.set(guildId, Date.now());
  return { release() { guildKothLocks.delete(guildId); } };
}

/**
 * The King of the Hill hourly cycle.
 *
 * Called every hour by the leaderboard scheduler (src/cron/leaderboards.js).
 * At midnight (Cairo 00:00), this runs on the FINAL accumulated day scores,
 * acting as the "Last Payout" before the activity reset wipes points.
 *
 * Optimized for Discord API rate limits:
 * - "Continuing" MVPs (held their rank): only receive coins, NO role changes.
 * - "Incoming" MVPs (newly entered top N): receive role + coins.
 * - "Losers" (dropped out): role stripped + dependency sweep.
 *
 * @param {Client} client - Discord.js client
 * @param {string} guildId
 */
export async function runKingOfHillCycle(client, guildId, options = {}) {
  const { payCoins = true } = options;
  const lock = acquireKothLock(guildId);
  if (!lock) {
    sysLog('KotH Cycle Skipped', { guild: guildId, detail: 'Already in progress for this guild' });
    return;
  }

  try {
    // === STEP 1: GUARD — Load config ===
    const config = await getGuildConfig(guildId);
    if (!config) return;

    if (config.enabled !== true) {
      sysLog('KotH Cycle Skipped', { guild: guildId, detail: 'MVP system is disabled' });
      return;
    }

    const guildObj = await client.guilds.fetch(guildId).catch(() => null);
    if (!guildObj) return;

    // === STEP 2: GUARD — Load MVP role (graceful degradation) ===
    const mvpRoleId = config.mvpRoleId;
    let mvpRole = null;
    if (mvpRoleId) {
      mvpRole = await guildObj.roles.fetch(mvpRoleId).catch(() => null);
      if (!mvpRole) {
        sysLog('KotH Role Warning', {
          guild: guildId,
          detail: `MVP role ${mvpRoleId} not found in server. Coins will still be distributed.`
        });
      }
    }

    const winnersCount = Math.min(Math.max(1, config.winnersCount || 1), 5);
    const rewardAmount = config.mvpRewardAmount !== undefined
      ? Math.max(0, parseInt(config.mvpRewardAmount, 10))
      : 100;

    // === STEP 3: FETCH — Current live Top N ===
    const newTopUsers = await getTopActiveUsers(guildId, winnersCount, guildObj);
    const newTopUserIds = newTopUsers.map(u => u.userId);

    // === STEP 4: LOAD — Previous active MVPs from DB ===
    const oldActiveMvps = await getActiveMvps(guildId);
    const oldMvpUserIds = oldActiveMvps.map(m => m.userId);

    // === STEP 5: DIFF — Classify each user ===
    const newTopSet = new Set(newTopUserIds);
    const oldMvpSet = new Set(oldMvpUserIds);

    const losers = oldMvpUserIds.filter(id => !newTopSet.has(id));       // Were MVP, now aren't
    const incoming = newTopUserIds.filter(id => !oldMvpSet.has(id));     // Were NOT MVP, now are
    const continuing = newTopUserIds.filter(id => oldMvpSet.has(id));    // Held their rank

    sysLog('KotH Diff Resolved', {
      guild: guildId,
      detail: `TopN: ${newTopUserIds.length} | DB-Losers: ${losers.length} | ` +
              `Incoming: ${incoming.length} | Continuing: ${continuing.length}`
    });

    // === STEP 5.5: UPDATE STATE EARLY — DB + Cache (atomic) ===
    // CRITICAL: We update the state BEFORE the sweep so that isUserMvp() correctly returns
    // FALSE during the dependency unequip loop.
    const newMvpList = newTopUsers.map((u, i) => ({ userId: u.userId, rank: i + 1 }));
    await setActiveMvps(guildId, newMvpList);
    setMvpCache(guildId, newTopUserIds);

    // === STEP 6: ACTUAL LOSERS — Full Server Role Sweep ===
    // We look for ANYONE who has the role but isn't on the new winner list.
    // This catches "Ghost" MVPs (manual assignments, missed runs, previous crashes).
    let membersWithRole = [];
    if (mvpRole) {
      try {
        await guildObj.members.fetch().catch(() => null);
        const roleHolders = mvpRole.members || guildObj.members.cache.filter(m => m.roles.cache.has(mvpRole.id));
        membersWithRole = Array.from(roleHolders.values());
      } catch (e) {
        sysLog('KotH Role Fetch Failed', { guild: guildId, detail: e.message });
      }
    }

    // Combine Historical Loser IDs (from DB) with Current Role-Holders who aren't winners
    const sweepSet = new Set(losers);
    membersWithRole.forEach(m => {
      if (!newTopSet.has(m.id)) sweepSet.add(m.id);
    });

    const { runDependencySweep } = await import('../economy/shop.js');
    const dethroned = [];
    const ghostsRemoved = [];

    for (const userId of sweepSet) {
      try {
        const member = await guildObj.members.fetch(userId).catch(() => null);
        if (!member) continue;

        const isGhost = !oldMvpSet.has(userId);

        // Remove MVP role
        if (mvpRole && member.roles.cache.has(mvpRole.id)) {
          await member.roles.remove(mvpRole, 'Dropped out of Top N (KotH Dethronement)').catch(e => {
            sysLog('KotH Role Remove Warning', { guild: guildId, user: userId, detail: e.message });
          });
        }

        // Unequip any MVP-locked items
        // Since setMvpCache was called above, isUserMvp(userId) will now return FALSE inside here.
        await runDependencySweep(userId, guildId, member);
        
        if (isGhost) {
           ghostsRemoved.push(member.user?.username || userId);
        } else {
           dethroned.push(member.user?.username || userId);
        }
      } catch (error) {
        sysError('KotH Dethronement Error', error, { guild: guildId, user: userId });
      }
    }

    // === STEP 7: WINNERS — Crowning (incoming only) & Coin Payout (all) ===
    const crowned = [];
    const paid = [];

    for (let i = 0; i < newTopUsers.length; i++) {
      const user = newTopUsers[i];
      const userId = user.userId;

      try {
        const member = await executeWithRetry(
          () => guildObj.members.fetch(userId),
          { label: `Fetch ${userId}`, maxAttempts: 4 }
        ).catch(() => null);

        if (!member || member.user.bot) continue;

        // Proactively enforce role for ALL top winners every hour.
        // Discord no-ops if they already have it, which is safe.
        // This prevents the "Sticky Failure" bug where a user missed their role once and never got it back.
        if (mvpRole) {
          if (!member.roles.cache.has(mvpRole.id)) {
            await executeWithRetry(
              () => member.roles.add(mvpRole, 'Top N (KotH Cycle Enforcement)'),
              { label: `Add MVP to ${member.user.tag}`, maxAttempts: 4 }
            ).catch(e => {
              sysLog('KotH Role Add Warning', { guild: guildId, user: userId, detail: e.message });
            });
          }
          crowned.push(member.user?.username || userId);
        }

        // Pay coins to ALL winners (with a 50-minute cooldown to prevent double payouts on bot restarts)
        if (payCoins && rewardAmount > 0) {
          const checkPayout = await query(
            `SELECT created_at FROM transactions 
             WHERE user_id = $1 AND guild_id = $2 AND type = 'mvp_reward' 
             ORDER BY created_at DESC LIMIT 1`,
            [userId, guildId]
          );

          let alreadyPaid = false;
          if (checkPayout.rows.length > 0) {
            const lastPayout = new Date(checkPayout.rows[0].created_at).getTime();
            if (Date.now() - lastPayout < 50 * 60 * 1000) {
              alreadyPaid = true;
            }
          }

          if (alreadyPaid) {
            sysLog('KotH Payout Skipped', { guild: guildId, user: userId, detail: 'Already paid within the last 50 minutes' });
          } else {
            const result = await updateBalance(userId, guildId, rewardAmount, 'mvp_reward', 'Current MVP!');
            if (result?.success) {
              paid.push(userId);
            } else {
              sysError('KotH Coin Payout Failed', result?.error || 'Unknown error', { guild: guildId, user: userId });
            }
          }
        }
      } catch (error) {
        sysError('KotH Winner Processing Error', error, { guild: guildId, user: userId });
      }
    }

    // (Step 8: State update moved to Step 5.5 for atomic sweep safety)

    // === STEP 9: AUDIT LOG ===
    const logLines = [];
    if (crowned.length > 0) logLines.push(`👑 **Crowned:** ${crowned.map(n => `\`${n}\``).join(', ')}`);
    if (dethroned.length > 0) logLines.push(`💨 **Dethroned:** ${dethroned.map(n => `\`${n}\``).join(', ')}`);
    if (ghostsRemoved.length > 0) logLines.push(`👻 **Ghosts Purged:** ${ghostsRemoved.length} stray MVP(s) removed`);
    if (continuing.length > 0) logLines.push(`🔄 **Continuing:** ${continuing.length} MVP(s) held their rank`);
    if (paid.length > 0) logLines.push(`${COIN_EMOJI} **Paid:** ${paid.length} MVP(s) — \`+${rewardAmount}\` each`);

    if (logLines.length > 0) {
      sendLog(guildObj, 'economy', 'orange', '⚔️ KotH Hourly Cycle', logLines.join('\n'));
    }

    sysLog('KotH Cycle Complete', {
      guild: guildId,
      detail: `Crowned: ${crowned.length} | Dethroned: ${dethroned.length} | Paid: ${paid.length}`
    });

  } catch (error) {
    sysError('KotH Cycle Failed', error, { guild: guildId });
  } finally {
    lock.release();
  }
}
