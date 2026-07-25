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
    let lastId;
    let hasMore = true;
    let attempt = 0;

    while (hasMore) {
        const fetchOptions = { limit: 1000, withPresences: false, force: true };
        if (lastId) fetchOptions.after = lastId;

        let batch;
        try {
            batch = await guild.members.fetch(fetchOptions);
        } catch (error) {
            const isTimeout = error.message?.toLowerCase().includes('timed out') || error.message?.toLowerCase().includes('timeout');
            if (isTimeout && attempt < CLEANUP_MAX_ATTEMPTS) {
                attempt += 1;
                await sleep(CLEANUP_BACKOFF_MS * attempt);
                continue;
            }
            sysError('Role Fetch Failed', error, { guild: guild.id, role: roleId });
            throw error;
        }

        if (!batch || batch.size === 0) break;

        for (const [memberId, member] of batch) {
            if (member.roles.cache.has(roleId)) {
                holders.set(memberId, member);
            }
        }

        const sortedIds = Array.from(batch.keys()).sort((a, b) => (BigInt(a) > BigInt(b) ? 1 : -1));
        lastId = sortedIds[sortedIds.length - 1];
        hasMore = batch.size === 1000;
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

        // Fetch top winners from DB (same query the leaderboard uses)
        const topUsers = await getTopCoinUsers(guildId, winnerCount);
        const winnerIds = topUsers.map(u => u.user_id);

        // Sweep: remove from members who are no longer in top-N
        const currentHolders = await fetchMembersWithRole(guild, role.id);
        const toRemove = currentHolders.filter(m => !winnerIds.includes(m.id));
        if (toRemove.length > 0) {
            await removeRoleFromMembers(toRemove, role, guildId);
        }

        // Assign: add role to new top-N winners
        for (const userId of winnerIds) {
            try {
                const member = await guild.members.fetch(userId).catch(() => null);
                if (!member || member.user.bot) continue;
                if (member.roles.cache.has(role.id)) continue; // already has it
                await assignRoleToMember(member, role);
            } catch (err) {
                sysError('Richest Role Assign Failed', err, { guild: guildId, user: userId });
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

        // Fetch top streak holders from DB (same query the leaderboard uses)
        const topUsers = await getTopStreakUsers(guildId, winnerCount);
        // Only include users with an actual active streak > 0
        const winnerIds = topUsers.filter(u => u.daily_streak > 0).map(u => u.user_id);

        // Sweep: remove from members who are no longer in top-N
        const currentHolders = await fetchMembersWithRole(guild, role.id);
        const toRemove = currentHolders.filter(m => !winnerIds.includes(m.id));
        if (toRemove.length > 0) {
            await removeRoleFromMembers(toRemove, role, guildId);
        }

        // Assign: add role to new top-N winners
        for (const userId of winnerIds) {
            try {
                const member = await guild.members.fetch(userId).catch(() => null);
                if (!member || member.user.bot) continue;
                if (member.roles.cache.has(role.id)) continue; // already has it
                await assignRoleToMember(member, role);
            } catch (err) {
                sysError('Streak Role Assign Failed', err, { guild: guildId, user: userId });
            }
        }

        sysLog('Streak Role Applied', { guild: guildId, winners: winnerIds.length, removed: toRemove.length });
    } catch (error) {
        sysError('Streak Role Cycle Failed', error, { guild: guildId });
    }
}
