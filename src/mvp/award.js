import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { getGuildActivity, resetGuildActivity } from '../activity/tracker.js';
import { getGuildConfig, setGuildConfig, loadGuildConfigs } from '../storage/config.js';
import { appendAwardRecord } from '../storage/mvpHistory.js';
import { sanitizeError, formatGuildForLog, getUserDisplayName, parseIsoTimestamp } from '../shared.js';

/**
 * Active MVP award timers per guild
 * Key: guildId (string)
 * Value: Node.js Timeout object
 * TTL: None (cleared on cancelMvpTimer or reschedule)
 * Purpose: Track active setTimeout timers for MVP awards
 */
const mvpTimers = new Map();

// Constants
const MILLIS_PER_HOUR = 60 * 60 * 1000;
const MILLIS_PER_DAY = 24 * MILLIS_PER_HOUR;
const MILLIS_PER_WEEK = 7 * MILLIS_PER_DAY;
const HOURS_PER_WEEK = 168;
const MIN_INTERVAL_HOURS = 1;
const MAX_INTERVAL_HOURS = HOURS_PER_WEEK;
const MAX_WINNERS = 5;
const ROLE_CLEANUP_BATCH_SIZE = 25;
const ROLE_CLEANUP_DELAY_MS = 250;
const ROLE_CLEANUP_MAX_ATTEMPTS = 3;
const ROLE_CLEANUP_ATTEMPT_BACKOFF_MS = 1500;
const ROLE_CLEANUP_TIMEOUT_MS = 4 * 60 * 1000; // 4 minutes hard cap
const CLEANUP_CONCURRENCY = 5;

const guildAwardLocks = new Map();
const LOCK_MAX_DURATION_MS = 5 * 60 * 1000;
const API_TIMEOUT_MS = 15_000;
const ROLE_ASSIGN_BATCH_SIZE = 10;

function acquireGuildLock(guildId) {
  const existing = guildAwardLocks.get(guildId);
  const now = Date.now();
  if (existing) {
    const age = now - existing.startedAt;
    if (age < LOCK_MAX_DURATION_MS) {
      return null;
    }
    console.warn(`[MVP][LOCK] releasing stale lock for ${formatGuildForLog(guildId)} (${Math.round(age / 1000)}s old)`);
    guildAwardLocks.delete(guildId);
  }

  const lock = {
    startedAt: now,
    released: false,
    release() {
      if (!this.released) {
        this.released = true;
        guildAwardLocks.delete(guildId);
      }
    }
  };
  guildAwardLocks.set(guildId, lock);
  return lock;
}

function logStep(guildId, step, message) {
  console.log(`[MVP][${step}] ${message} | guild=${formatGuildForLog(guildId)}`);
}

function shouldRetry(error) {
  if (!error) return false;
  const status = error.status ?? error.httpStatus ?? error.code;
  if (status === 429) return true;
  if (typeof status === 'number' && status >= 500) return true;
  const message = String(error.message ?? '').toLowerCase();
  if (message.includes('rate limit')) return true;
  if (message.includes('server error')) return true;
  if (message.includes('timed out') || message.includes('timeout')) return true;
  if (message.includes('ecconn') || message.includes('socket hang up')) return true;
  return false;
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    })
  ]);
}

async function executeWithRetry(promiseFactory, { label, timeoutMs = API_TIMEOUT_MS, maxAttempts = 2 } = {}) {
  let attempt = 1;
  while (attempt <= maxAttempts) {
    try {
      return await withTimeout(promiseFactory(), timeoutMs, label);
    } catch (error) {
      if (attempt >= maxAttempts || !shouldRetry(error)) {
        throw error;
      }
      console.warn(`[MVP] ${label} failed (attempt ${attempt}): ${sanitizeError(error)} — retrying`);
      await sleep(ROLE_CLEANUP_ATTEMPT_BACKOFF_MS * attempt);
    }
    attempt += 1;
  }
  throw new Error(`${label} failed after ${maxAttempts} attempts`);
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

const isProduction = process.env.NODE_ENV === 'production';

// Use formatGuildForLog from shared.js for consistent guild logging

export function getScheduleIntervalMs(config) {
  if (!config) return null;
  if (Number.isFinite(config.schedule_interval_ms)) {
    return config.schedule_interval_ms;
  }

  const number = Number(config.intervalNumber);
  const unit = config.intervalUnit;
  if (!Number.isFinite(number) || number <= 0 || !unit) {
    return null;
  }

  if (unit === 'hours') {
    return number * MILLIS_PER_HOUR;
  }

  if (unit === 'weeks') {
    return number * MILLIS_PER_WEEK;
  }

  return null;
}

// Use parseIsoTimestamp from shared.js

function ensureActivatedAt(config, nowMs) {
  if (!config.activated_at) {
    config.activated_at = new Date(nowMs).toISOString();
    return true;
  }
  return false;
}

function computeNextFromAnchor(config, nowMs, intervalMs) {
  const lastMs = parseIsoTimestamp(config.last_award_at);
  const activatedMs = parseIsoTimestamp(config.activated_at);
  let anchorMs = lastMs ?? activatedMs ?? nowMs;
  if (!Number.isFinite(anchorMs)) {
    anchorMs = nowMs;
  }

  let nextMs = anchorMs + intervalMs;
  if (nextMs <= nowMs) {
    const steps = Math.floor((nowMs - anchorMs) / intervalMs) + 1;
    nextMs = anchorMs + steps * intervalMs;
  }

  return nextMs;
}

function resolveNextAward(config, { nowMs = Date.now(), force = false } = {}) {
  const intervalMs = getScheduleIntervalMs(config);
  if (!intervalMs) {
    return { intervalMs: null, nextMs: null, mutated: false };
  }

  let mutated = ensureActivatedAt(config, nowMs);

  if (Object.prototype.hasOwnProperty.call(config, 'nextCheckTime')) {
    delete config.nextCheckTime;
    mutated = true;
  }

  let nextMs = force ? null : parseIsoTimestamp(config.next_award_at);

  if (nextMs === null) {
    nextMs = computeNextFromAnchor(config, nowMs, intervalMs);
    config.next_award_at = new Date(nextMs).toISOString();
    mutated = true;
  } else if (nextMs <= nowMs) {
    const steps = Math.floor((nowMs - nextMs) / intervalMs) + 1;
    nextMs += steps * intervalMs;
    config.next_award_at = new Date(nextMs).toISOString();
    mutated = true;
  }

  return { intervalMs, nextMs, mutated };
}

export async function scheduleMvpTimer(client, guildId, forceReschedule = false) {
  const config = await getGuildConfig(guildId);
  if (!config) return;

  // Cancel existing timer for this guild
  cancelMvpTimer(guildId);
  
  // Only schedule if enabled
  if (config.enabled === false) return;
  
  const { intervalMs, nextMs, mutated } = resolveNextAward(config, { force: forceReschedule });
  if (!intervalMs || !nextMs) {
    console.warn(`Skipping MVP schedule for ${formatGuildForLog(guildId)} — missing interval metadata`);
    return;
  }

  const maxHours = intervalMs / MILLIS_PER_HOUR;
  if (maxHours < MIN_INTERVAL_HOURS || maxHours > MAX_INTERVAL_HOURS) {
    console.warn(`Invalid interval detected for guild ${formatGuildForLog(guildId)}, skipping schedule`);
    return;
  }

  if (mutated) {
    await setGuildConfig(guildId, config);
  }

  const now = Date.now();
  const delay = Math.max(0, nextMs - now);

  if (process.env.NODE_ENV !== 'production') {
    console.log(`🕒 [TIMER] Scheduled MVP check for guild ${formatGuildForLog(guildId)}`);
    console.log(`   ├─ Interval: ${intervalMs}ms`);
    console.log(`   └─ Next check: ${new Date(nextMs).toISOString()} (in ${Math.ceil(delay / 60000)} min)`);
  }

  const timer = setTimeout(async () => {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`⏰ [TIMER] Firing MVP check for guild ${formatGuildForLog(guildId)}`);
    }
    try {
      // Check if still enabled before running
      const currentConfig = await getGuildConfig(guildId);
      if (currentConfig && currentConfig.enabled !== false) {
        await awardMvp(client, guildId, { isTest: false, trigger: 'timer' });
      }
      // Reschedule for next interval (force new calculation)
      await scheduleMvpTimer(client, guildId, true);
    } catch (error) {
      console.error(`❌ [TIMER] MVP award failed for guild ${formatGuildForLog(guildId)}:`, sanitizeError(error));
      // Still reschedule even if award fails
      await scheduleMvpTimer(client, guildId, true); // Force reschedule after error
    }
  }, delay);

  mvpTimers.set(guildId, timer);
}

export async function scheduleAllMvpTimers(client) {
  const configs = await loadGuildConfigs();
  
  for (const guildId of Object.keys(configs)) {
    const config = configs[guildId];
    // Only schedule if enabled
    if (config.enabled !== false) {
      await scheduleMvpTimer(client, guildId);
    }
  }
}

function resolvePeriodWindow(config) {
  const now = new Date();
  const intervalMs = calculateIntervalMs(config) ?? (7 * 24 * 60 * 60 * 1000);
  const start = new Date(now.getTime() - intervalMs);
  return {
    periodStart: formatTimestamp(start),
    periodEnd: formatTimestamp(now)
  };
}

function calculateIntervalMs(config) {
  if (!config?.intervalNumber || !config?.intervalUnit) return null;
  const number = Number(config.intervalNumber);
  if (!Number.isFinite(number) || number <= 0) return null;

  if (config.intervalUnit === 'weeks') {
    return number * 7 * 24 * 60 * 60 * 1000;
  }

  if (config.intervalUnit === 'hours') {
    return number * 60 * 60 * 1000;
  }

  return null;
}

function formatTimestamp(date) {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC'
  }).format(date) + ' UTC';
}

// Use getUserDisplayName from shared.js for consistent name resolution

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeRemovalError(error) {
  if (!error) return 'unknown error';
  if (error.code === 50013) return 'missing permission';
  if (typeof error.message === 'string') {
    if (error.message.toLowerCase().includes('higher role')) {
      return 'hierarchy';
    }
    if (error.message.toLowerCase().includes('missing permissions')) {
      return 'missing permission';
    }
    if (error.message.toLowerCase().includes('rate limit')) {
      return 'rate limit';
    }
  }
  if (error.status === 429) return 'rate limit';
  return 'unknown error';
}

/**
 * Fallback: Fetch members with a specific role via API when cache is empty
 * This handles cases where the bot just joined or roles were assigned manually
 */
async function fetchMembersWithRoleFallback(guild, roleId) {
  logStep(guild.id, 'ROLE-FALLBACK', `Falling back to API fetch for role ${roleId}`);

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
      const isTimeout = error?.code === 'GUILD_MEMBERS_TIMEOUT' || error?.message?.includes("Members didn't arrive in time");
      if (isTimeout && attempt < ROLE_CLEANUP_MAX_ATTEMPTS) {
        attempt += 1;
        await sleep(ROLE_CLEANUP_ATTEMPT_BACKOFF_MS * attempt);
        continue;
      }
      console.error(`Failed fallback fetch for guild ${formatGuildForLog(guild.id)}:`, sanitizeError(error));
      throw error;
    }

    if (!batch || batch.size === 0) {
      break;
    }

    for (const [memberId, member] of batch) {
      if (member.roles.cache.has(roleId)) {
        holders.set(memberId, member);
      }
    }

    const sortedIds = Array.from(batch.keys()).sort((a, b) => (BigInt(a) > BigInt(b) ? 1 : -1));
    lastId = sortedIds[sortedIds.length - 1];
    hasMore = batch.size === 1000;
  }

  logStep(guild.id, 'ROLE-FALLBACK', `Fetched ${holders.size} holder(s) for role ${roleId}`);
  return Array.from(holders.values());
}

/**
 * Get members with a specific role from the cache (no API call, instant)
 * This uses Discord.js's built-in role.members collection which is populated
 * from the gateway cache and doesn't require fetching all guild members.
 * Falls back to API fetch if cache is empty (handles manual assignments)
 */
async function getMembersWithRoleFromCache(guild, roleId) {
  const role = guild.roles.cache.get(roleId);
  
  if (!role) {
    logStep(guild.id, 'ROLE-FETCH', `Role ${roleId} not found in cache, fetching from API`);
    const fetchedRole = await guild.roles.fetch(roleId).catch((error) => {
      console.error(`Failed to fetch MVP role (${roleId}) in guild ${formatGuildForLog(guild.id)}:`, sanitizeError(error));
      throw error;
    });
    
    if (!fetchedRole) {
      logStep(guild.id, 'ROLE-FETCH', `Role ${roleId} not found`);
      return [];
    }
    
    const members = Array.from(fetchedRole.members.values());
    if (members.length === 0) {
      // Cache is empty, fallback to API fetch
      return fetchMembersWithRoleFallback(guild, roleId);
    }
    return members;
  }
  
  const members = Array.from(role.members.values());
  logStep(guild.id, 'ROLE-CACHE', `Found ${members.length} member(s) with role ${role.name} (${roleId}) from cache`);
  
  if (members.length === 0) {
    // Cache is empty, fallback to API fetch (handles manual assignments after bot restart)
    return fetchMembersWithRoleFallback(guild, roleId);
  }

  return members;
}

async function removeRoleFromMembersBatch(members, role, guildId) {
  const results = [];

  for (let index = 0; index < members.length; index += CLEANUP_CONCURRENCY) {
    const chunk = members.slice(index, index + CLEANUP_CONCURRENCY);
    
    const chunkResults = await Promise.allSettled(
      chunk.map(async (member) => {
        try {
          await member.roles.remove(role);
          return { success: true };
        } catch (error) {
          // Log rate limit specifically
          if (error.status === 429 || error.code === 429) {
            const retryAfter = error.retry_after || error.retryAfter || 'unknown';
            console.warn(`[MVP][RATE-LIMIT] Hit rate limit removing role from ${member.user?.tag || member.id} | retry_after=${retryAfter}s | guild=${formatGuildForLog(guildId)}`);
          }
          throw error;
        }
      })
    );
    
    chunkResults.forEach((result, idx) => {
      results.push({ member: chunk[idx], result });
    });
    
    // Small delay between chunks to avoid rate limits
    if (index + CLEANUP_CONCURRENCY < members.length) {
      await sleep(ROLE_CLEANUP_DELAY_MS);
    }
  }

  return results;
}

/**
 * Remove MVP role from all current holders
 * Optimized: Uses role.members cache instead of fetching all guild members
 * Works efficiently even on large guilds (10k+ members)
 */
export async function clear_all_current_mvp_holders(guild, mvpRole) {
  const start = Date.now();
  const guildId = guild.id;
  
  logStep(guildId, 'CLEANUP-START', `Starting MVP role cleanup for role ${mvpRole.name} (${mvpRole.id})`);
  
  // Get members with the role from cache - NO full member scan
  const membersWithRole = await getMembersWithRoleFromCache(guild, mvpRole.id);
  const totalCount = membersWithRole.length;
  const noun = totalCount === 1 ? 'holder' : 'holders';

  if (totalCount === 0) {
    logStep(guildId, 'CLEANUP-DONE', 'No MVP holders to remove');
    return { removedCount: 0, remainingCount: 0, failures: [] };
  }

  logStep(guildId, 'CLEANUP-PROGRESS', `Removing MVP from ${totalCount} ${noun}`);

  let remainingMembers = membersWithRole;
  let removedCount = 0;
  const failures = new Map();
  let rateLimitHits = 0;

  for (let attempt = 1; attempt <= ROLE_CLEANUP_MAX_ATTEMPTS; attempt += 1) {
    if (remainingMembers.length === 0) break;
    if (Date.now() - start > ROLE_CLEANUP_TIMEOUT_MS) {
      logStep(guildId, 'CLEANUP-TIMEOUT', `Cleanup timeout reached after ${Math.round((Date.now() - start) / 1000)}s`);
      break;
    }

    const batched = [];
    for (let index = 0; index < remainingMembers.length; index += ROLE_CLEANUP_BATCH_SIZE) {
      batched.push(remainingMembers.slice(index, index + ROLE_CLEANUP_BATCH_SIZE));
    }

    const nextAttempt = [];

    for (const batch of batched) {
      const results = await removeRoleFromMembersBatch(batch, mvpRole, guildId);

      for (const { member, result } of results) {
        if (result.status === 'fulfilled') {
          removedCount += 1;
          failures.delete(member.id);
        } else {
          const reason = describeRemovalError(result.reason);
          const error = result.reason;
          
          // Track rate limits
          if (error?.status === 429 || error?.code === 429) {
            rateLimitHits += 1;
          }
          
          failures.set(member.id, {
            member,
            reason,
            error: result.reason
          });

          if (reason === 'hierarchy' || reason === 'missing permission') {
            console.error(`❌ [MVP][CLEANUP-FATAL] Cannot remove MVP role due to ${reason} | member=${member.user?.tag ?? member.id} | guild=${formatGuildForLog(guildId)}`);
            return {
              removedCount,
              remainingCount: remainingMembers.length,
              failures: Array.from(failures.values()),
              fatal: true,
              rateLimitHits
            };
          }

          nextAttempt.push(member);
        }
      }
    }

    if (nextAttempt.length === 0) break;
    if (attempt < ROLE_CLEANUP_MAX_ATTEMPTS) {
      const backoff = ROLE_CLEANUP_ATTEMPT_BACKOFF_MS * attempt;
      logStep(guildId, 'CLEANUP-RETRY', `Retrying ${nextAttempt.length} failed removals (attempt ${attempt + 1}/${ROLE_CLEANUP_MAX_ATTEMPTS}) after ${backoff}ms`);
      await sleep(backoff);
    }
    remainingMembers = nextAttempt;
  }

  failures.forEach(({ member, reason, error }) => {
    const tag = member.user?.tag ?? member.id;
    const details = sanitizeError(error);
    console.warn(`⚠️ [MVP][CLEANUP-FAILED] Couldn't remove MVP role | member=${tag} | reason=${reason}${details ? ` | error=${details}` : ''} | guild=${formatGuildForLog(guildId)}`);
  });
  
  const duration = Math.round((Date.now() - start) / 1000);
  logStep(guildId, 'CLEANUP-DONE', `Removed ${removedCount}/${totalCount} holders in ${duration}s | failures=${failures.size} | rate_limits=${rateLimitHits}`);

  return {
    removedCount,
    remainingCount: remainingMembers.length,
    failures: Array.from(failures.values()),
    fatal: false,
    rateLimitHits
  };
}

function formatVoiceDuration(totalMinutes) {
  const rounded = Math.max(0, Math.round(totalMinutes));
  const hours = Math.floor(rounded / 60);
  const remainingMinutes = rounded % 60;
  const parts = [];

  if (hours > 0) {
    parts.push(`${hours} ${hours === 1 ? 'hr' : 'hrs'}`);
  }

  if (remainingMinutes > 0 || parts.length === 0) {
    parts.push(`${remainingMinutes} min`);
  }

  return parts.join(' ');
}

function buildWinnerDisplay(winner, medal, { preferMention = true } = {}) {
  const baseName = winner.tag || winner.displayName || winner.username || (winner.userId ? `User ${winner.userId}` : 'Unknown user');
  const score = formatNumber(winner.score);
  const messageCount = formatNumber(winner.messages);
  const messageLabel = winner.messages === 1 ? 'message' : 'messages';
  const voiceDuration = formatVoiceDuration(winner.voiceMinutes);

  return {
    headline: `- ${medal} **${baseName}** (Score: ${score})`,
    details: `-# 💬 ${messageCount} ${messageLabel} • ⏱️ ${voiceDuration}`
  };
}

function formatNumber(value) {
  return new Intl.NumberFormat('en-US').format(value);
}

function buildMvpEmbed(winners) {
  const medals = assignMedals(winners);
  const display = winners.slice(0, 6);
  const lines = ['────────────────────────'];

  for (let index = 0; index < display.length; index += 1) {
    const winner = display[index];
    const medal = medals[index] ?? '🏅';
    const { headline, details } = buildWinnerDisplay(winner, medal);
    lines.push(headline, details);
  }

  if (winners.length > 6) {
    lines.push('…', `-# …and +${winners.length - 6} more`);
  }

  const title = winners.length === 1
    ? '🏆 New MVP'
    : `🏆 New MVPs (${winners.length})`;

  return new EmbedBuilder()
    .setTitle(title)
    .setColor(0xF39C12)
    .setDescription(lines.join('\n'));
}

function assignMedals(winners) {
  return winners.map((_, index) => medalForPlace(index + 1));
}

function medalForPlace(place) {
  if (place === 1) return '🥇';
  if (place === 2) return '🥈';
  if (place === 3) return '🥉';
  return '🏅';
}

export function cancelMvpTimer(guildId) {
  if (mvpTimers.has(guildId)) {
    clearTimeout(mvpTimers.get(guildId));
    mvpTimers.delete(guildId);
  }
}

/**
 * Awards MVP to top active members in a guild
 * @param {Client} client - Discord client instance
 * @param {string} guildId - ID of the guild
 * @param {boolean} isTest - Whether this is a test run (won't actually assign roles)
 * @returns {Promise<{winners: Array, error: string|null}>} - Result of the operation
 */
export async function awardMvp(client, guildId, options = {}) {
  const { isTest = false, trigger = 'manual', interaction = null } = options;
  // Input validation
  if (!client || !client.guilds) {
    console.error('Invalid client provided to awardMvp');
    return { winners: [], error: 'Invalid client' };
  }
  // Fetch guild and configuration
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) {
    const message = 'Guild not found';
    console.error(`awardMvp: ${message} for ${formatGuildForLog(guildId)}`);
    return { winners: [], error: message };
  }

  const config = await getGuildConfig(guildId);
  if (!config || !config.mvpRoleId) {
    const message = 'MVP configuration incomplete';
    if (!isProduction) {
      console.warn(`awardMvp: ${message} for ${formatGuildForLog(guildId)}`);
    }
    return { winners: [], error: message };
  }

  const maxWinners = Math.min(Math.max(1, config.winnersCount || 1), MAX_WINNERS);
  console.info(`⚙️ Award started — guild ${formatGuildForLog(guildId)}, winners target: ${maxWinners}`);

  const lock = acquireGuildLock(guildId);
  if (!lock) {
    const message = 'Award already in progress';
    console.warn(`awardMvp: ${message} for ${formatGuildForLog(guildId)}`);
    return { winners: [], error: message };
  }

  try {
    // Determine winners from activity data
    const activity = getGuildActivity(guildId);
  const users = activity?.users ?? new Map();

    const userScores = Array.from(users.entries())
    .map(([userId, data]) => {
      const messages = Math.max(0, data.messages || 0);
      const voiceMinutes = Math.max(0, data.voiceMinutes || 0);
      const score = messages + voiceMinutes;
      return {
        userId,
        username: data.username,
        messages,
        voiceMinutes,
        score,
        lastActive: data.lastActive
      };
    })
    .filter(entry => entry.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.lastActive || 0) - new Date(a.lastActive || 0);
    });

    const winners = userScores.slice(0, maxWinners);

    if (winners.length === 0) {
      if (!isProduction) {
        console.log(`No activity to award MVP for guild ${formatGuildForLog(guildId)}`);
      }
      if (!isTest) {
        resetGuildActivity(guildId);
      }
      return { winners: [], error: null };
    }

    const mvpRole = await guild.roles.fetch(config.mvpRoleId);
    if (!mvpRole) {
      throw new Error('MVP role not found');
    }

    if (!mvpRole.editable) {
      throw new Error('Cannot manage MVP role — adjust role hierarchy');
    }

    const cleanupResult = await clear_all_current_mvp_holders(guild, mvpRole);

    if (cleanupResult.fatal) {
      throw new Error('Cannot manage MVP role — adjust role hierarchy');
    }

    const resultMembers = [];
    let assignmentRateLimits = 0;

    if (!isTest) {
      logStep(guildId, 'ASSIGN-START', `Assigning MVP role to ${winners.length} winner(s)`);
      
      for (const winner of winners) {
        try {
          // Fetch only the specific winner member (efficient, targeted fetch)
          const member = await executeWithRetry(
            () => guild.members.fetch(winner.userId),
            { label: `Fetch winner ${winner.userId}`, timeoutMs: API_TIMEOUT_MS, maxAttempts: 2 }
          );
          
          if (!member) {
            logStep(guildId, 'ASSIGN-SKIP', `Member ${winner.userId} not found`);
            continue;
          }
          
          if (member.user.bot) {
            logStep(guildId, 'ASSIGN-SKIP', `Skipping bot ${member.user.tag}`);
            continue;
          }
          
          // Assign the MVP role with retry logic
          await executeWithRetry(
            () => member.roles.add(mvpRole),
            { label: `Assign MVP to ${member.user.tag}`, timeoutMs: API_TIMEOUT_MS, maxAttempts: 2 }
          );
          
          resultMembers.push(member);
          logStep(guildId, 'ASSIGN-SUCCESS', `Assigned MVP to ${member.user.tag} (${member.id})`);
          
        } catch (error) {
          // Track rate limits
          if (error?.status === 429 || error?.code === 429 || error?.message?.includes('rate limit')) {
            assignmentRateLimits += 1;
            const retryAfter = error.retry_after || error.retryAfter || 'unknown';
            console.error(`❌ [MVP][RATE-LIMIT] Failed to assign MVP role to ${winner.userId} | retry_after=${retryAfter}s | guild=${formatGuildForLog(guildId)}`);
          } else {
            console.error(`❌ [MVP][ASSIGN-FAILED] Failed to assign MVP role to ${winner.userId} | error=${sanitizeError(error)} | guild=${formatGuildForLog(guildId)}`);
          }
        }
      }

      if (resultMembers.length > 0) {
        const friendlyNames = resultMembers.map((member) => {
          const tag = member.user?.tag;
          const display = member.displayName;
          const fallback = member.user?.username ?? member.id;
          return tag ?? display ?? fallback;
        }).join(', ');
        logStep(guildId, 'ASSIGN-DONE', `Successfully assigned MVP role to ${resultMembers.length} member(s): ${friendlyNames}`);
      }
      
      if (assignmentRateLimits > 0) {
        console.warn(`⚠️ [MVP][RATE-LIMIT-SUMMARY] Hit ${assignmentRateLimits} rate limit(s) during role assignment | guild=${formatGuildForLog(guildId)}`);
      }
    }

    if (resultMembers.length > 0 && !isTest) {
      await announceWinners(guild, config, resultMembers, winners.slice(0, resultMembers.length));
      if (!isProduction) {
        console.log(`✅ MVP awarded to ${resultMembers.length} winner(s) in guild ${formatGuildForLog(guildId)}`);
      }
    }

    resetGuildActivity(guildId);
    if (!isProduction) {
      console.log(`♻️ Scores reset for guild ${formatGuildForLog(guildId)}`);
    }

    const nowIso = new Date().toISOString();
    config.last_award_at = nowIso;
    delete config.nextCheckTime;
    delete config.next_award_at;
    try {
      await setGuildConfig(guildId, config);
      if (process.env.NODE_ENV !== 'production') {
        console.log(`🗓️ Updated award timestamps for guild ${formatGuildForLog(guildId)} — last_award_at=${nowIso}`);
      }
    } catch (error) {
      console.error(`Failed to persist award metadata for guild ${formatGuildForLog(guildId)}:`, sanitizeError(error));
    }

    return { winners, winnerMembers: resultMembers };
  } finally {
    lock.release();
  }
}

export async function reconcileMvpHolders(client, guildId) {
  const config = await getGuildConfig(guildId);
  if (!config?.mvpRoleId) return { removedCount: 0, remainingCount: 0 };

  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return { removedCount: 0, remainingCount: 0 };

  const role = await guild.roles.fetch(config.mvpRoleId).catch(() => null);
  if (!role) return { removedCount: 0, remainingCount: 0 };

  const result = await clear_all_current_mvp_holders(guild, role);
  return result;
}

export async function reconcileAllMvpHolders(client) {
  const configs = await loadGuildConfigs();
  for (const [guildId, config] of Object.entries(configs)) {
    if (!config?.mvpRoleId) continue;
    try {
      const result = await reconcileMvpHolders(client, guildId);
      console.info(`🧹 Startup reconciliation for guild ${formatGuildForLog(guildId)} — removed ${result.removedCount}, remaining ${result.remainingCount}`);
    } catch (error) {
      console.error(`Startup reconciliation failed for guild ${formatGuildForLog(guildId)}:`, sanitizeError(error));
    }
  }
}

async function announceWinners(guild, config, winnerMembers, winnerData) {
  // Skip announcement if no channel is configured
  if (!config.announceChannelId) {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`No announcement channel configured for guild ${formatGuildForLog(guild.id)}, skipping announcement`);
    }
    return;
  }
  
  const channel = await guild.channels.fetch(config.announceChannelId).catch(() => null);
  if (!channel) {
    console.warn(`Announcement channel not found in guild ${formatGuildForLog(guild.id)}`);
    return;
  }

  if (!channel.isTextBased()) {
    console.warn(`Announcement channel is not a text-based channel in guild ${formatGuildForLog(guild.id)}`);
    return;
  }
  const { periodStart, periodEnd } = resolvePeriodWindow(config);
  if (process.env.NODE_ENV !== 'production') {
    console.log(`🗓️ MVP period for guild ${formatGuildForLog(guild.id)}: ${periodStart} → ${periodEnd}`);
  }

  const formattedWinners = winnerData.map((winner, index) => {
    const member = winnerMembers[index] ?? winnerMembers.find(m => m.id === winner.userId);
    const displayName = getUserDisplayName(member || winner, winner.username);
    if (displayName === 'Unknown user') {
      console.warn(`Unable to resolve display name for user ${winner.userId} in guild ${formatGuildForLog(guild.id)}`);
    }
    return {
      userId: member ? member.id : winner.userId,
      displayName,
      username: winner.username,
      tag: member?.user?.tag ?? winner.username,
      messages: winner.messages,
      voiceMinutes: winner.voiceMinutes,
      score: winner.score
    };
  });

  const embed = buildMvpEmbed(formattedWinners);

  try {
    await channel.send({
      embeds: [embed],
      allowedMentions: { parse: [] }
    });
  } catch (error) {
    console.error(`Failed to send MVP announcement in guild ${formatGuildForLog(guild.id)}:`, sanitizeError(error));
    throw error;
  }
}
