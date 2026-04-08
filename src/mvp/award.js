import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { getGuildActivity, resetGuildActivity, getTopActiveUsers } from '../activity/tracker.js';
import { getGuildConfig, setGuildConfig, loadGuildConfigs } from '../storage/config.js';
import { appendAwardRecord } from '../storage/mvpHistory.js';
import { 
  sanitizeError, 
  formatGuildForLog, 
  getUserDisplayName, 
  parseIsoTimestamp,
  getUserLogName,
  COIN_EMOJI 
} from '../shared.js';
import { sendLog } from '../utils/logger.js';
import { getPool } from '../storage/postgres.js';

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
      console.warn(`Retry ${attempt}: ${sanitizeError(error)}`);
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

/**
 * Cairo Timezone Scheduler
 * All award times are fixed to Cairo time (Africa/Cairo, GMT+2/+3 with DST)
 * 
 * Schedule times:
 * - 6h:  00:00, 06:00, 12:00, 18:00 Cairo
 * - 12h: 00:00, 12:00 Cairo
 * - 24h: 00:00 (midnight) Cairo
 * - 1w:  Saturday 00:00 Cairo (end of Friday)
 */

function getCairoDate(date = new Date()) {
  // Use Intl to get Cairo time components (handles DST automatically)
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  const parts = formatter.formatToParts(date);
  const values = {};
  for (const part of parts) {
    values[part.type] = part.value;
  }

  return {
    year: parseInt(values.year, 10),
    month: parseInt(values.month, 10) - 1, // 0-indexed
    day: parseInt(values.day, 10),
    hour: parseInt(values.hour, 10),
    minute: parseInt(values.minute, 10),
    second: parseInt(values.second, 10),
    dayOfWeek: date.getDay() // 0 = Sunday, 6 = Saturday
  };
}

function cairoToUtc(year, month, day, hour, minute = 0, second = 0) {
  // Create a date string in Cairo time, then parse it as Cairo timezone
  // This correctly handles DST transitions
  const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;

  // Use Intl to format a reference date and calculate offset
  const refDate = new Date();
  const utcFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hour: 'numeric', hour12: false });
  const cairoFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Cairo', hour: 'numeric', hour12: false });

  // Create the date assuming it's in Cairo timezone
  // We need to find when this Cairo time occurs in UTC
  const targetDate = new Date(`${dateStr}Z`);

  // Get the Cairo offset at that approximate time
  const testDate = new Date(targetDate);
  const utcHour = parseInt(utcFormatter.format(testDate), 10);
  const cairoHour = parseInt(cairoFormatter.format(testDate), 10);
  let offset = cairoHour - utcHour;
  if (offset < 0) offset += 24;

  // Apply offset to get UTC time
  return new Date(targetDate.getTime() - offset * MILLIS_PER_HOUR);
}

function getNextCairoTime(scheduleValue) {
  const now = new Date();
  const cairo = getCairoDate(now);
  const currentMs = now.getTime();

  let targetHours;
  let isWeekly = false;

  switch (scheduleValue) {
    case '6h':
      targetHours = [0, 6, 12, 18];
      break;
    case '12h':
      targetHours = [0, 12];
      break;
    case '24h':
      targetHours = [0];
      break;
    case '1w':
      targetHours = [0];
      isWeekly = true;
      break;
    default:
      // Fallback: 24h at midnight
      targetHours = [0];
  }

  if (isWeekly) {
    // Weekly: Saturday 00:00 Cairo (end of Friday night)
    // Cairo dayOfWeek: 0=Sun, 1=Mon, ..., 5=Fri, 6=Sat
    let daysUntilSaturday = (6 - cairo.dayOfWeek + 7) % 7;

    // If it's Saturday already, check if we're past midnight
    if (daysUntilSaturday === 0 && cairo.hour >= 0) {
      // We're on Saturday, so next Saturday is 7 days away
      daysUntilSaturday = 7;
    }

    const nextDate = cairoToUtc(
      cairo.year,
      cairo.month,
      cairo.day + daysUntilSaturday,
      0, 0, 0
    );

    // If calculated time is in the past, add a week
    if (nextDate.getTime() <= currentMs) {
      return new Date(nextDate.getTime() + MILLIS_PER_WEEK);
    }
    return nextDate;
  }

  // Find the next target hour
  for (const targetHour of targetHours) {
    if (targetHour > cairo.hour || (targetHour === cairo.hour && cairo.minute === 0 && cairo.second < 5)) {
      // This target is in the future today
      const nextDate = cairoToUtc(cairo.year, cairo.month, cairo.day, targetHour);
      if (nextDate.getTime() > currentMs) {
        return nextDate;
      }
    }
  }

  // All target hours today have passed, use first target hour tomorrow
  const nextDate = cairoToUtc(cairo.year, cairo.month, cairo.day + 1, targetHours[0]);
  return nextDate;
}

function resolveNextAward(config, { nowMs = Date.now(), force = false } = {}) {
  // MVP is now hardcoded to 24h at 00:00 Cairo daily
  const intervalMs = MILLIS_PER_DAY; // Always 24 hours

  let mutated = ensureActivatedAt(config, nowMs);

  if (Object.prototype.hasOwnProperty.call(config, 'nextCheckTime')) {
    delete config.nextCheckTime;
    mutated = true;
  }

  // Always target 00:00 Cairo (midnight)
  const nextCairoTime = getNextCairoTime('24h');
  const nextMs = nextCairoTime.getTime();

  // Update config if changed
  const storedNextMs = parseIsoTimestamp(config.next_award_at);
  if (storedNextMs !== nextMs || force) {
    config.next_award_at = nextCairoTime.toISOString();
    mutated = true;
  }

  return { intervalMs, nextMs, mutated };
}


export async function scheduleMvpTimer(client, guildId, forceReschedule = false) {
  const config = await getGuildConfig(guildId);
  if (!config) return;

  // Cancel existing timer for this guild
  cancelMvpTimer(guildId);

  // Only schedule if explicitly set to Auto mode (enabled === true)
  if (config.enabled !== true) return;

  const { intervalMs, nextMs, mutated } = resolveNextAward(config, { force: forceReschedule });
  if (!intervalMs || !nextMs) {
    return;
  }

  const maxHours = intervalMs / MILLIS_PER_HOUR;
  if (maxHours < MIN_INTERVAL_HOURS || maxHours > MAX_INTERVAL_HOURS) {
    return;
  }

  if (mutated) {
    await setGuildConfig(guildId, config);
  }

  const now = Date.now();
  const delay = Math.max(0, nextMs - now);


  const timer = setTimeout(async () => {
    try {
      // Timer has fired at 00:00 Cairo time
      const guild = client.guilds.cache.get(guildId);
      const guildName = guild ? guild.name : guildId;
      console.log(`[System] MVP Timer - 00:00 Cairo - Running daily cycle for ${guildName}`);

      // Check if still in Auto mode
      const currentConfig = await getGuildConfig(guildId);
      if (!currentConfig || currentConfig.enabled !== true) {
        console.log(`[System] MVP Timer - ${guildName} no longer in Auto mode, skipping`);
        await scheduleMvpTimer(client, guildId, true);
        return;
      }

      // === ATOMIC DAILY RESET SEQUENCE (00:00 Cairo) ===
      
      // 1. Finalize Day: Award any pending voice time
      const { flushAllVoiceTime, resetGuildActivity, getTopActiveUsers } = await import('../activity/tracker.js');
      await flushAllVoiceTime(guildId).catch(e => console.error(`[System] Voice flush error for ${guildId}:`, e));

      // 2. Snapshot & Leaderboards: Capture final data BEFORE any resets
      const { updateLeaderboards } = await import('../commands/leaderboard.js');
      const finalSnapshotData = await getTopActiveUsers(guildId, 15);
      const configuredWinnerCount = currentConfig.winner_count || 1;
      const potentialWinners = finalSnapshotData.slice(0, configuredWinnerCount).map(u => u.userId);
      
      await updateLeaderboards(client, guildId, finalSnapshotData, potentialWinners);

      // 3. Clear stale streaks
      await resetCairoStaleStreaks(guildId).catch(e => console.error(`[System] Streak reset error for ${guildId}:`, e));

      // 4. Perform Award Ceremony (Roles, Coins, History)
      // awardMvp manages the Role Sweep and new assignments
      const awardResult = await awardMvp(client, guildId, { isTest: false, trigger: 'timer' });

      // 5. DEEP RESET: Wipe points and reset voice laps for the new day
      await resetGuildActivity(guildId);
      
      sendLog(guild, 'audit', 'cyan', '📊 Daily MVP Cycle Complete', 
        `**Action:** \`Daily Reset\`\n` +
        `**Status:** Winners awarded, Leaderboards updated, and progress reset for the next 24h.`
      );

      console.log(`[System] MVP Timer - Daily cycle complete for ${guildName}`);
      await scheduleMvpTimer(client, guildId, true);
    } catch (error) {
      console.error(`[System] MVP timer error for guild ${guildId}:`, sanitizeError(error));
      // ALWAYS reschedule to prevent the system from getting stuck forever
      await scheduleMvpTimer(client, guildId, true).catch(() => {});
    }
  }, delay);

  mvpTimers.set(guildId, timer);
}

export async function scheduleAllMvpTimers(client) {
  const configs = await loadGuildConfigs();

  for (const guildId of Object.keys(configs)) {
    const config = configs[guildId];
    // Only schedule if explicitly set to Auto mode
    if (config.enabled === true) {
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
      console.error(`Role fetch failed:`, sanitizeError(error));
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

  return Array.from(holders.values());
}

/**
 * Get members with a specific role from the cache (no API call, instant)
 * This uses Discord.js's built-in role.members collection which is populated
 * from the gateway cache and doesn't require fetching all guild members.
 * Falls back to API fetch if cache is empty (handles manual assignments)
 */
/**
 * Proactive Role Sweep: Fetches all members with the role from Discord API
 * ensures we catch manually assigned roles even if not in bot memory.
 */
async function getMembersWithRole(guild, roleId) {
  // Always use the robust fallback fetch to guarantee no cache misses
  return fetchMembersWithRoleFallback(guild, roleId);
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
 * Proactive Removal: Fetches every member holding the role from Discord API
 * ensure manually assigned holders are cleared.
 * @param {Guild} guild - The Discord guild
 * @param {Role} mvpRole - The MVP role
 * @param {string[]} keepUserIds - IDs of users who should keep their role
 */
export async function clear_all_current_mvp_holders(guild, mvpRole, keepUserIds = []) {
  const start = Date.now();
  const guildId = guild.id;

  // Proactive Sweep: Fetch fresh from API
  const membersWithRole = await getMembersWithRole(guild, mvpRole.id);
  
  // FILTER: Skip users who won again
  const toProcess = membersWithRole.filter(m => !keepUserIds.includes(m.id));
  const totalCount = toProcess.length;
  
  if (totalCount === 0) {
    return { removedCount: 0, remainingCount: 0, failures: [] };
  }

  let remainingMembers = toProcess;
  let removedCount = 0;
  const failures = new Map();
  let rateLimitHits = 0;

  for (let attempt = 1; attempt <= ROLE_CLEANUP_MAX_ATTEMPTS; attempt += 1) {
    if (remainingMembers.length === 0) break;
    if (Date.now() - start > ROLE_CLEANUP_TIMEOUT_MS) {
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
            console.error(`Cannot manage MVP role: ${reason}`);
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
      await sleep(backoff);
    }
    remainingMembers = nextAttempt;
  }



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

function buildMvpEmbed(winners, rewardAmount = 0) {
  const medals = assignMedals(winners);
  const display = winners.slice(0, 6);
  const lines = ['────────────────────────'];

  if (rewardAmount > 0) {
    lines.push(`💰 **Reward:** ${formatNumber(rewardAmount)} coins deposited to bank!`, '────────────────────────');
  }

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
 * OVERHAULED: Implements strict SQL selection, wipe-first cleanup, and robust assignment
 * @param {Client} client - Discord client instance
 * @param {string} guildId - ID of the guild
 * @param {Object} options - Options including isTest, trigger, interaction
 * @returns {Promise<{winners: Array, error: string|null}>} - Result of the operation
 */
export async function awardMvp(client, guildId, options = {}) {
  const { isTest = false, trigger = 'manual', interaction = null } = options;

  // Input validation
  if (!client || !client.guilds) {
    console.error('[System] Invalid client provided');
    return { winners: [], error: 'Invalid client' };
  }

  // ========== STEP 1: FETCH CONFIG ==========
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) {
    console.error(`[System] Guild ${guildId} not found`);
    return { winners: [], error: 'Guild not found' };
  }

  const tag = `[${guild.name}]`;

  const config = await getGuildConfig(guildId);
  if (!config || !config.mvpRoleId) {
    console.error(`${tag} MVP config incomplete`);
    return { winners: [], error: 'MVP configuration incomplete' };
  }

  // Get configured winner count (clamped to 1-5)
  const configuredWinnerCount = Math.min(Math.max(1, config.winnersCount || 1), MAX_WINNERS);
  console.log(`${tag} Config: Winners=${configuredWinnerCount}, Role=${config.mvpRoleId}`);

  const lock = acquireGuildLock(guildId);
  if (!lock) {
    console.warn(`${tag} Award already in progress`);
    return { winners: [], error: 'Award already in progress' };
  }

  try {
    // ========== STEP 2: SELECT WINNERS (SQL-BASED) ==========
    const winners = await getTopActiveUsers(guildId, configuredWinnerCount, guild.name);

    console.log(`${tag} Found ${winners.length} candidates (limit: ${configuredWinnerCount})`);

    if (winners.length > 0) {
      winners.forEach((w, i) => {
        console.log(`${tag}   ${i + 1}. ${w.username || w.userId} - Score: ${w.score}`);
      });
    }

    if (winners.length === 0) {
      console.log(`${tag} No eligible winners found today.`);
      return { winners: [], error: null };
    }

    // ========== STEP 3: WIPE-FIRST ROLE CLEANUP ==========
    const mvpRole = await guild.roles.fetch(config.mvpRoleId);
    if (!mvpRole) {
      throw new Error('MVP role not found');
    }

    if (!mvpRole.editable) {
      throw new Error('Cannot manage MVP role - adjust hierarchy');
    }

    const winnerUserIds = winners.map(w => w.userId);
    const cleanupResult = await clear_all_current_mvp_holders(guild, mvpRole, winnerUserIds);

    if (cleanupResult.removedCount > 0) {
      console.log(`${tag} Cleared ${cleanupResult.removedCount} old MVP holder(s)`);
    }

    if (cleanupResult.failures && cleanupResult.failures.length > 0) {
      console.warn(`${tag} Failed to clear ${cleanupResult.failures.length} member(s)`);
    }

    if (cleanupResult.fatal) {
      throw new Error('Cannot manage MVP role - adjust hierarchy');
    }

    // ========== STEP 4: ASSIGN ROLES TO NEW WINNERS ==========
    const resultMembers = [];
    const assignmentFailures = [];

    if (!isTest) {
      for (const winner of winners) {
        try {
          const member = await executeWithRetry(
            () => guild.members.fetch(winner.userId),
            { label: `Fetch ${winner.userId}`, timeoutMs: API_TIMEOUT_MS, maxAttempts: 2 }
          );

          if (!member) {
            assignmentFailures.push({ userId: winner.userId, reason: 'not in server' });
            continue;
          }

          if (member.user.bot) {
            assignmentFailures.push({ userId: winner.userId, reason: 'is a bot' });
            continue;
          }

          await executeWithRetry(
            () => member.roles.add(mvpRole),
            { label: `Assign MVP to ${member.user.tag}`, timeoutMs: API_TIMEOUT_MS, maxAttempts: 2 }
          );

          console.log(`${tag} Assigned MVP -> ${member.user.tag} (Score: ${winner.score})`);
          resultMembers.push(member);

        } catch (error) {
          console.error(`${tag} Failed to assign MVP to ${winner.username}:`, sanitizeError(error));
          assignmentFailures.push({ userId: winner.userId, username: winner.username, reason: sanitizeError(error) });
        }
      }

      if (assignmentFailures.length > 0) {
        console.warn(`${tag} ${assignmentFailures.length} assignment(s) failed`);
        const failureList = assignmentFailures.map(f => `<@${f.userId}>: \`${f.reason}\``).join('\n');
        sendLog(guild, 'audit', 'red', '❌ MVP Assignment Failed', 
          `**Action:** \`Award Ceremony\`\n` +
          `**Errors:**\n${failureList}\n\n` +
          `**Tip:** Ensure the bot's role is HIGHER than the MVP role in the server settings.`
        );
      }
    }

    // ========== STEP 5: ANNOUNCE & REWARD ==========
    if (resultMembers.length > 0 && !isTest) {
      const rewardAmount = config.mvpRewardAmount !== undefined ? parseInt(config.mvpRewardAmount, 10) : 0;

      if (rewardAmount > 0) {
        for (const member of resultMembers) {
          try {
            await awardCoinReward(guildId, member.id, rewardAmount, guild.name);
          } catch (error) {
            console.error(`${tag} Failed to award coins to ${member.id}:`, sanitizeError(error));
          }
        }
      }

      await announceWinners(guild, config, resultMembers, winners.slice(0, resultMembers.length), rewardAmount);

      // ========== SAVE WINNERS TO MVP HISTORY ==========
      const awardedAt = new Date().toISOString();
      for (let i = 0; i < resultMembers.length; i++) {
        const member = resultMembers[i];
        const winnerData = winners[i];
        await appendAwardRecord({
          guildId: guildId,
          userId: member.id,
          username: member.user?.tag || member.displayName || 'Unknown',
          awardedAt: awardedAt,
          activityScore: winnerData?.score || 0,
          rank: i + 1
        });
      }
      console.log(`${tag} Saved ${resultMembers.length} winner(s) to MVP history`);

      const winnerLogList = resultMembers.map(m => `\`${getUserLogName(m)}\``).join(', ');
      const totalReward = config.mvpRewardAmount !== undefined ? parseInt(config.mvpRewardAmount, 10) : 0;

      sendLog(guild, 'economy', 'orange', '🎁 Rewards Claimed', 
        `**Type:** \`MVP Payout\`\n` +
        `**Winners:** ${winnerLogList}\n` +
        `**Reward:** \`${totalReward.toLocaleString()}\` ${COIN_EMOJI} per winner`
      );
    }

    // Points reset is now handled by the primary daily cycle loop after successful awarding.
    // This ensures consistency between awards and historical leaderboard display.

    // Update config with last award timestamp
    // IMPORTANT: Do NOT delete next_award_at here!
    // Manual runs (Run/Skip) should NOT affect the Cairo-based schedule.
    // The schedule is only recalculated by the timer callback after it fires.
    const nowIso = new Date().toISOString();
    config.last_award_at = nowIso;
    delete config.nextCheckTime;
    // Removed: delete config.next_award_at;
    // This preserves the scheduled time so manual runs don't cause drift
    try {
      await setGuildConfig(guildId, config);
    } catch (error) {
      console.error(`${tag} Failed to save MVP metadata:`, sanitizeError(error));
    }

    console.log(`${tag} Cycle complete`);
    return { winners, winnerMembers: resultMembers, assignmentFailures };
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
    } catch (error) {
      console.error(`Startup reconciliation failed:`, sanitizeError(error));
    }
  }
}

async function announceWinners(guild, config, winnerMembers, winnerData, rewardAmount = 0) {
  if (!config.announceChannelId) {
    return;
  }

  const channel = await guild.channels.fetch(config.announceChannelId).catch(() => null);
  if (!channel) {
    return;
  }

  if (!channel.isTextBased()) {
    return;
  }
  const { periodStart, periodEnd } = resolvePeriodWindow(config);

  const formattedWinners = winnerData.map((winner, index) => {
    const member = winnerMembers[index] ?? winnerMembers.find(m => m.id === winner.userId);
    const displayName = getUserDisplayName(member || winner, winner.username);
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

  const embed = buildMvpEmbed(formattedWinners, rewardAmount);

  try {
    await channel.send({
      embeds: [embed],
      allowedMentions: { parse: [] }
    });
  } catch (error) {
    console.error(`[System] Failed to send MVP announcement:`, sanitizeError(error));
    throw error;
  }
}

/**
 * Award coins to a user transactionally
 * @param {string} guildId - Guild ID
 * @param {string} userId - User ID
 * @param {number} amount - Coin amount
 * @param {string} guildName - Guild name for logging
 */
async function awardCoinReward(guildId, userId, amount, guildName) {
  const pool = getPool();
  const client = await pool.connect();
  const tag = guildName ? `[${guildName}]` : '[System]';
  try {
    await client.query('BEGIN');

    // Atomic Upsert: Add coins safely
    const updateResult = await client.query(
      `INSERT INTO user_balances (guild_id, user_id, balance, total_earned)
       VALUES ($1, $2, $3, $3)
       ON CONFLICT (guild_id, user_id) 
       DO UPDATE SET 
         balance = user_balances.balance + $3,
         total_earned = user_balances.total_earned + $3
       RETURNING balance`,
      [guildId, userId, amount]
    );

    const newBalance = parseInt(updateResult.rows[0].balance, 10);

    // Transaction record
    await client.query(
      `INSERT INTO transactions (user_id, guild_id, amount, balance_after, type, description)
       VALUES ($1, $2, $3, $4, 'mvp_reward', $5)`,
      [userId, guildId, amount, newBalance, 'Won MVP of the Day']
    );

    await client.query('COMMIT');
    console.log(`${tag} Awarded ${amount} coins to user ${userId}`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Global streak reset scheduler (Relocated from index.js)
 * Resets stale streaks globally at Cairo midnight
 */
export async function scheduleCairoMidnightReset(client) {
  const { getTimeUntilCairoMidnight } = await import('../utils/time.js');
  let msUntilMidnight = getTimeUntilCairoMidnight();
  
  // Safety: Prevent tight loops if math error or near-zero time
  // Minimum 1 minute between resets to stop spam
  if (isNaN(msUntilMidnight) || msUntilMidnight < 60000) {
    msUntilMidnight = 60000; 
  }

  setTimeout(async () => {
    console.log('[System] ⏰ Cairo midnight - running global reset (streaks & missions)...');
    
    // 1. Reset streaks globally
    await resetCairoStaleStreaks();
    
    // 2. Rotate missions for all guilds
    try {
      const { loadGuildConfigs } = await import('../storage/config.js');
      const { rotateGuildMission } = await import('../missions/missions.js');
      const configs = await loadGuildConfigs();
      
      for (const [guildId, config] of Object.entries(configs)) {
        if (config.missions_enabled) {
          await rotateGuildMission(client, guildId);
        }
      }
    } catch (error) {
      console.error('[System] Global mission rotation error:', error);
    }

    scheduleCairoMidnightReset(client); // Recurse
  }, msUntilMidnight);
}

/**
 * Reset streaks where users haven't claimed in over 24 hours
 * @param {string} [guildId] - Optional guild ID to reset for a specific guild only
 */
export async function resetCairoStaleStreaks(guildId = null) {
  const { getYesterdayCairo } = await import('../utils/time.js');
  const pool = getPool();
  const yesterday = getYesterdayCairo();

  const whereClause = guildId 
    ? "AND guild_id = $2" 
    : "";
  const params = guildId ? [yesterday, guildId] : [yesterday];

  try {
    // 1. Archive lost streaks
    await pool.query(`
      UPDATE user_balances
      SET last_lost_streak = daily_streak
      WHERE last_daily IS NOT NULL 
        AND date(last_daily AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Cairo') < $1::date
        AND daily_streak > 0
        ${whereClause}
    `, params);

    // 2. Reset to zero
    const result = await pool.query(`
      UPDATE user_balances 
      SET daily_streak = 0 
      WHERE last_daily IS NOT NULL 
        AND date(last_daily AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Cairo') < $1::date
        AND daily_streak > 0
        ${whereClause}
    `, params);

    if (result.rowCount > 0) {
      const scope = guildId ? `for guild ${guildId}` : 'globally';
      console.log(`[System] Reset ${result.rowCount} expired streaks ${scope}`);
    }
  } catch (error) {
    console.error('[System] Streak reset error:', sanitizeError(error));
  }
}
