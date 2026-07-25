import { sysLog, sysError } from '../utils/logger.js';
import { getGuildConfig } from '../storage/config.js';
import { sleep, executeWithRetry } from '../shared.js';
import { getTopCoinUsers, getTopStreakUsers } from '../commands/leaderboard.js';

// ── Constants (mirrors award.js patterns) ──────────────────────────────────
const CLEANUP_CONCURRENCY    = 5;
const CLEANUP_BATCH_SIZE     = 25;
const CLEANUP_DELAY_MS       = 300;
const CLEANUP_MAX_ATTEMPTS   = 3;
const CLEANUP_BACKOFF_MS     = 1500;
const ASSIGN_RETRY_ATTEMPTS  = 3;
const ASSIGN_RETRY_DELAY_MS  = 1000;

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Fetch all guild members that currently hold a given role.
 * Uses paginated member fetch to guarantee no cache misses.
 */
async function fetchMembersWithRole(guild, roleId) {
    const holders = new Map();
    
    // 1. Primary: Use cached members on the role object (instant & reliable)
    const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
    if (!role) return [];

    if (role.members && role.members.size > 0) {
        for (const [id, member] of role.members) {
            holders.set(id, member);
        }
    }

    // 2. Best-effort gateway/API fetch for uncached members with safe catch
    try {
        const batch = await guild.members.fetch({ limit: 1000, time: 4000 }).catch(() => null);
        if (batch) {
            for (const [memberId, member] of batch) {
                if (member.roles.cache.has(roleId)) {
                    holders.set(memberId, member);
                }
            }
        }
    } catch (err) {
        sysLog('Role Fetch Fallback to Cache', { guild: guild.id, role: roleId, detail: err?.message });
    }

    return Array.from(holders.values());
}

/**
 * Remove a role from a batch of members with concurrency control.
 */
async function removeRoleFromMembers(members, role, guildId) {
    let remaining = [...members];
    let removedCount = 0;

    for (let attempt = 1; attempt <= CLEANUP_MAX_ATTEMPTS; attempt++) {
        if (remaining.length === 0) break;

        const nextAttempt = [];

        for (let i = 0; i < remaining.length; i += CLEANUP_BATCH_SIZE) {
            const batch = remaining.slice(i, i + CLEANUP_BATCH_SIZE);
            const results = await Promise.allSettled(
                batch.map(member => member.roles.remove(role))
            );

            results.forEach((result, idx) => {
                if (result.status === 'fulfilled') {
                    removedCount++;
                } else {
                    const err = result.reason;
                    // Hierarchy / permission faults are fatal — abort immediately
                    if (err?.status === 403 || err?.code === 50013) {
                        sysError('Role Reward Permission Fault', err, { guild: guildId, role: role.id });
                        return; // stop processing this guild
                    }
                    nextAttempt.push(batch[idx]);
                }
            });

            if (i + CLEANUP_BATCH_SIZE < remaining.length) {
                await sleep(CLEANUP_DELAY_MS);
            }
        }

        remaining = nextAttempt;
        if (remaining.length > 0 && attempt < CLEANUP_MAX_ATTEMPTS) {
            await sleep(CLEANUP_BACKOFF_MS * attempt);
        }
    }

    return removedCount;
}

/**
 * Assign a role to a member with retry logic.
 */
async function assignRoleToMember(member, role) {
    let attempt = 0;
    while (attempt < ASSIGN_RETRY_ATTEMPTS) {
        try {
            await member.roles.add(role);
            return true;
        } catch (error) {
            attempt++;
            if (attempt < ASSIGN_RETRY_ATTEMPTS) {
                await sleep(ASSIGN_RETRY_DELAY_MS * attempt);
            } else {
                throw error;
            }
        }
    }
    return false;
}

/**
 * Validate that a role is safe for the bot to manage.
 * Returns the role object or null if invalid.
 */
async function validateRole(guild, roleId) {
    const role = await guild.roles.fetch(roleId).catch(() => null);
    if (!role) return null;
    if (role.id === guild.id) return null; // @everyone
    if (role.managed) return null;         // bot/integration role

    const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
    if (!botMember) return null;
    if (role.position >= botMember.roles.highest.position) return null; // hierarchy

    return role;
}

/**
 * Resolves up to targetCount valid, non-bot guild members from candidate user IDs.
 */
async function resolveValidGuildWinners(guild, candidates, targetCount) {
    const validMembers = [];
    for (const candidate of candidates) {
        if (validMembers.length >= targetCount) break;
        const userId = typeof candidate === 'string' ? candidate : candidate.user_id;
        if (!userId) continue;

        try {
            const member = await guild.members.fetch(userId).catch(() => null);
            if (member && !member.user.bot) {
                validMembers.push(member);
            }
        } catch {
            // Ignore fetch errors for individual users
        }
    }
    return validMembers;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Apply Richest role rewards for a guild.
 * Removes the role from members who dropped out of top-N,
 * and assigns it to the new top-N richest members.
 * Called every hour from the leaderboard cron.
 */
export async function applyRichestRole(client, guildId) {
    try {
        const config = await getGuildConfig(guildId);
        if (!config?.richest_role_enabled || !config?.richest_role_id) return;

        const guild = await client.guilds.fetch(guildId).catch(() => null);
        if (!guild) return;

        const role = await validateRole(guild, config.richest_role_id);
        if (!role) {
            sysError('Richest Role Invalid', 'Role is unmanageable or missing', { guild: guildId, role: config.richest_role_id });
            return;
        }

        const winnerCount = config.richest_role_winners || 1;

        // Fetch candidate top winners from DB (fetch buffer of 50 to skip left/invalid members)
        const candidateUsers = await getTopCoinUsers(guildId, 50);
        const validMembers = await resolveValidGuildWinners(guild, candidateUsers, winnerCount);
        const winnerIds = validMembers.map(m => m.id);

        // Sweep: remove from members who are no longer in top-N
        const currentHolders = await fetchMembersWithRole(guild, role.id);
        const toRemove = currentHolders.filter(m => !winnerIds.includes(m.id));
        if (toRemove.length > 0) {
            await removeRoleFromMembers(toRemove, role, guildId);
        }

        // Assign: add role to new top-N winners
        for (const member of validMembers) {
            try {
                if (member.roles.cache.has(role.id)) continue; // already has it
                await assignRoleToMember(member, role);
            } catch (err) {
                sysError('Richest Role Assign Failed', err, { guild: guildId, user: member.id });
            }
        }

        sysLog('Richest Role Applied', { guild: guildId, winners: winnerIds.length, removed: toRemove.length });
    } catch (error) {
        sysError('Richest Role Cycle Failed', error, { guild: guildId });
    }
}

/**
 * Apply Streaks role rewards for a guild.
 * Removes the role from members who dropped out of top-N,
 * and assigns it to the new top-N streak holders.
 * Called every hour from the leaderboard cron.
 */
export async function applyStreakRole(client, guildId) {
    try {
        const config = await getGuildConfig(guildId);
        if (!config?.streak_role_enabled || !config?.streak_role_id) return;

        const guild = await client.guilds.fetch(guildId).catch(() => null);
        if (!guild) return;

        const role = await validateRole(guild, config.streak_role_id);
        if (!role) {
            sysError('Streak Role Invalid', 'Role is unmanageable or missing', { guild: guildId, role: config.streak_role_id });
            return;
        }

        const winnerCount = config.streak_role_winners || 1;

        // Fetch candidate top streak holders from DB (fetch buffer of 50 to skip left/invalid members)
        const candidateUsers = await getTopStreakUsers(guildId, 50);
        const activeStreakCandidates = candidateUsers.filter(u => u.daily_streak > 0);
        const validMembers = await resolveValidGuildWinners(guild, activeStreakCandidates, winnerCount);
        const winnerIds = validMembers.map(m => m.id);

        // Sweep: remove from members who are no longer in top-N
        const currentHolders = await fetchMembersWithRole(guild, role.id);
        const toRemove = currentHolders.filter(m => !winnerIds.includes(m.id));
        if (toRemove.length > 0) {
            await removeRoleFromMembers(toRemove, role, guildId);
        }

        // Assign: add role to new top-N winners
        for (const member of validMembers) {
            try {
                if (member.roles.cache.has(role.id)) continue; // already has it
                await assignRoleToMember(member, role);
            } catch (err) {
                sysError('Streak Role Assign Failed', err, { guild: guildId, user: member.id });
            }
        }

        sysLog('Streak Role Applied', { guild: guildId, winners: winnerIds.length, removed: toRemove.length });
    } catch (error) {
        sysError('Streak Role Cycle Failed', error, { guild: guildId });
    }
}
