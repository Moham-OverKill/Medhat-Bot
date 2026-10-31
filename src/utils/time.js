/**
 * Format a date into a relative time string (e.g. "23h 59m")
 */
export function formatDetailedTimeRemaining(targetDate) {
  const now = new Date();
  const diff = targetDate.getTime() - now.getTime();

  if (diff <= 0) return 'Available now';

  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

/**
 * Get the next time a daily reward can be claimed
 * NOW USES CAIRO MIDNIGHT instead of 24h rolling
 */
export function getNextDailyTime(lastDailyDate) {
  // Next claim is at the next Cairo midnight
  return getNextCairoMidnight();
}

// ============================================
// CAIRO TIME HELPERS (UTC+2 / UTC+3 DST)
// ============================================

/**
 * Get a date string (YYYY-MM-DD) in Cairo timezone
 * Uses Intl.DateTimeFormat for robust DST handling
 */
export function getCairoDateString(date) {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return '';

  // Create a formatter for Cairo time
  const formatter = new Intl.DateTimeFormat('en-CA', { // en-CA gives YYYY-MM-DD format
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });

  return formatter.format(d);
}

/**
 * Get today's date string in Cairo timezone
 */
export function getTodayCairo() {
  return getCairoDateString(new Date());
}

/**
 * Get date string (YYYY-MM-DD) for Cairo timezone with a day offset
 * @param {number} daysOffset Negative for past days (-1 = yesterday), positive for future
 * @param {Date|string|number} [baseDate] Optional reference date (defaults to now)
 */
export function getCairoDateOffset(daysOffset = 0, baseDate = new Date()) {
  const d = baseDate instanceof Date ? baseDate : new Date(baseDate);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Africa/Cairo',
    year: 'numeric', month: 'numeric', day: 'numeric'
  });
  const parts = formatter.formatToParts(d);
  const getPart = (type) => parseInt(parts.find(p => p.type === type).value, 10);
  
  const year = getPart('year');
  const month = getPart('month');
  const day = getPart('day');
  
  const targetUtc = new Date(Date.UTC(year, month - 1, day + daysOffset));
  return `${targetUtc.getUTCFullYear()}-${String(targetUtc.getUTCMonth() + 1).padStart(2, '0')}-${String(targetUtc.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Get yesterday's date string in Cairo timezone
 * Hardened: Uses component-based subtraction to handle DST transitions
 */
export function getYesterdayCairo() {
  return getCairoDateOffset(-1);
}

// Downtime recovery grace window tracker (Cairo/UTC timestamp in ms)
let downtimeGraceExpiry = 0;

/**
 * Configure global post-downtime streak grace window
 * @param {number|Date|string} expiry Timestamp or Date when grace window ends
 */
export function setDowntimeGraceWindow(expiry) {
  if (!expiry) {
    downtimeGraceExpiry = 0;
    return;
  }
  const ts = expiry instanceof Date ? expiry.getTime() : (typeof expiry === 'number' ? expiry : new Date(expiry).getTime());
  downtimeGraceExpiry = isNaN(ts) ? 0 : ts;
}

/**
 * Check if the post-downtime grace window is actively protecting streaks
 * @returns {boolean}
 */
export function isDowntimeGraceWindowActive() {
  return downtimeGraceExpiry > 0 && Date.now() < downtimeGraceExpiry;
}

/**
 * Check if a streak is valid (last claim was today or yesterday in Cairo time)
 * Returns true if streak should continue, false if it should reset to 0
 * @param {Date|string} lastClaimDate
 * @param {number|null} extraGraceDays Optional extra days allowed (defaults to 2 if grace window is active)
 */
export function isStreakValid(lastClaimDate, extraGraceDays = null) {
  if (!lastClaimDate) return false;

  const claimDateStr = getCairoDateString(lastClaimDate);
  if (!claimDateStr) return false;

  const effectiveGrace = extraGraceDays !== null
    ? Math.max(0, extraGraceDays)
    : (isDowntimeGraceWindowActive() ? 2 : 0);

  if (effectiveGrace <= 0) {
    const yesterday = getYesterdayCairo();
    return claimDateStr >= yesterday;
  }

  const thresholdDate = getCairoDateOffset(-(1 + effectiveGrace));
  return claimDateStr >= thresholdDate;
}

/**
 * Check if user already claimed today (in Cairo time)
 */
export function hasClaimedToday(lastClaimDate) {
  if (!lastClaimDate) return false;

  const claimDateStr = getCairoDateString(lastClaimDate);
  return claimDateStr === getTodayCairo();
}

/**
 * Get the current hour in Cairo (0-23)
 */
export function getCairoHour() {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Africa/Cairo',
        hour: 'numeric',
        hour12: false
    });
    const parts = formatter.formatToParts(new Date());
    let hour = parseInt(parts.find(p => p.type === 'hour').value, 10);
    return hour % 24;
}

/**
 * Helper to extract calendar date and time parts in Africa/Cairo timezone
 */
function getCairoParts(date) {
  const d = date instanceof Date ? date : new Date(date);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Africa/Cairo',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    hour12: false
  });
  const parts = formatter.formatToParts(d);
  const getPart = (type) => parseInt(parts.find(p => p.type === type).value, 10);
  return {
    year: getPart('year'),
    month: getPart('month'),
    day: getPart('day'),
    hour: getPart('hour') % 24,
    minute: getPart('minute'),
    second: getPart('second')
  };
}

/**
 * Resolves the exact UTC timestamp for a target Cairo calendar date and hour.
 * Robust against seasonal clock shifts (Daylight Saving Time / Summer Time UTC+3 and Standard Time / Winter Time UTC+2).
 */
function resolveCairoTargetTime(targetYear, targetMonth, targetDay, targetHour, minTimestampMs) {
  const targetDateStr = `${targetYear}-${String(targetMonth).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`;

  // Cairo is UTC+3 in summer (targetHour - 3 UTC) and UTC+2 in winter (targetHour - 2 UTC)
  const candidateUtcHours = [targetHour - 3, targetHour - 2, targetHour - 4, targetHour - 1];
  const candidates = candidateUtcHours.map(h => {
    return new Date(Date.UTC(targetYear, targetMonth - 1, targetDay, h, 0, 0, 0));
  }).sort((a, b) => a.getTime() - b.getTime());

  for (const c of candidates) {
    if (c.getTime() > minTimestampMs) {
      const parts = getCairoParts(c);
      const cDateStr = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
      if (cDateStr === targetDateStr && parts.hour === targetHour) {
        return c;
      }
    }
  }

  // Fallback to UTC+2 standard time
  return new Date(Date.UTC(targetYear, targetMonth - 1, targetDay, targetHour - 2, 0, 0, 0));
}

/**
 * Calculate the next quest refresh timestamp based on frequency
 * @param {number} refreshesPerDay 1, 2, or 4
 * @param {Date|string|number} [fromTime] Optional reference time (defaults to now)
 * @returns {Date}
 */
export function getNextQuestRefresh(refreshesPerDay = 1, fromTime = new Date()) {
  const now = fromTime instanceof Date ? fromTime : new Date(fromTime);
  const parts = getCairoParts(now);

  let schedule = [0];
  if (refreshesPerDay === 2) schedule = [0, 12];
  if (refreshesPerDay === 4) schedule = [0, 6, 12, 18];

  let targetHour = schedule.find(h => h > parts.hour);
  let targetYear = parts.year;
  let targetMonth = parts.month;
  let targetDay = parts.day;

  if (targetHour === undefined) {
    targetHour = schedule[0];
    const tomorrowUtc = new Date(Date.UTC(targetYear, targetMonth - 1, targetDay + 1));
    targetYear = tomorrowUtc.getUTCFullYear();
    targetMonth = tomorrowUtc.getUTCMonth() + 1;
    targetDay = tomorrowUtc.getUTCDate();
  }

  return resolveCairoTargetTime(targetYear, targetMonth, targetDay, targetHour, now.getTime());
}

/**
 * Get the next midnight in Cairo timezone.
 * Robust against seasonal clock shifts (Winter Standard Time vs Summer Daylight Saving Time).
 * @param {Date|string|number} [fromTime] Optional reference time (defaults to now)
 * @returns {Date}
 */
export function getNextCairoMidnight(fromTime = new Date()) {
  const now = fromTime instanceof Date ? fromTime : new Date(fromTime);
  const parts = getCairoParts(now);

  // Tomorrow in Cairo calendar components
  const tomorrowUtc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  const tYear = tomorrowUtc.getUTCFullYear();
  const tMonth = tomorrowUtc.getUTCMonth() + 1;
  const tDay = tomorrowUtc.getUTCDate();

  return resolveCairoTargetTime(tYear, tMonth, tDay, 0, now.getTime());
}

export function getTimeUntilCairoMidnight() {
  const nextMidnight = getNextCairoMidnight();
  return Math.max(0, nextMidnight.getTime() - Date.now());
}

/**
 * Calculate milliseconds until the next full hour in Cairo time.
 * Because Egypt uses whole-hour offsets (UTC+2 or UTC+3), the top of the hour
 * occurs simultaneously worldwide at :00:00.000.
 */
export function getTimeUntilNextCairoHour() {
  const now = Date.now();
  const msUntilNextHour = 3600000 - (now % 3600000);
  return msUntilNextHour <= 0 ? 3600000 : msUntilNextHour;
}

/**
 * Get the UNIX timestamp (in seconds) for the next Cairo hour.
 */
export function getNextCairoHourTimestamp() {
    const delay = getTimeUntilNextCairoHour();
    return Math.floor((Date.now() + delay) / 1000);
}
