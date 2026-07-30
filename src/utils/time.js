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
 * Get yesterday's date string in Cairo timezone
 * Hardened: Uses component-based subtraction to handle DST transitions
 */
export function getYesterdayCairo() {
  const now = new Date();
  
  // Get Cairo components for "now"
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Africa/Cairo',
    year: 'numeric', month: 'numeric', day: 'numeric'
  });
  const parts = formatter.formatToParts(now);
  const getPart = (type) => parseInt(parts.find(p => p.type === type).value, 10);
  
  // Create a UTC date that HAS the same Y/M/D as Cairo Today
  const year = getPart('year');
  const month = getPart('month');
  const day = getPart('day');
  
  const cairoTodayAsUtc = new Date(Date.UTC(year, month - 1, day));
  // Subtract 1 day from the UTC instance
  const cairoYesterdayAsUtc = new Date(cairoTodayAsUtc.getTime() - 24 * 60 * 60 * 1000);
  
  // Format that UTC date (which now has Cairo's yesterday Y/M/D)
  return `${cairoYesterdayAsUtc.getUTCFullYear()}-${String(cairoYesterdayAsUtc.getUTCMonth() + 1).padStart(2, '0')}-${String(cairoYesterdayAsUtc.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Check if a streak is valid (last claim was today or yesterday in Cairo time)
 * Returns true if streak should continue, false if it should reset to 0
 */
export function isStreakValid(lastClaimDate) {
  if (!lastClaimDate) return false;

  const claimDateStr = getCairoDateString(lastClaimDate);
  if (!claimDateStr) return false;

  const yesterday = getYesterdayCairo();

  // Streak is valid if last claim date is yesterday, today, or in the future (handles clock drift)
  return claimDateStr >= yesterday;
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
 * Calculate the next quest refresh timestamp based on frequency
 * @param {number} refreshesPerDay 1, 2, or 4
 * @returns {Date}
 */
export function getNextQuestRefresh(refreshesPerDay = 1) {
    const now = new Date();
    
    // 1. Get Cairo time parts
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Africa/Cairo',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
      hour12: false
    });
  
    const parts = formatter.formatToParts(now);
    const getPart = (type) => parseInt(parts.find(p => p.type === type).value, 10);
  
    const year = getPart('year');
    const month = getPart('month');
    const day = getPart('day');
    const hour = getPart('hour') % 24;
    const minute = getPart('minute');
    const second = getPart('second');
  
    // 2. Determine target refresh hours based on frequency
    // Logic from cron/quests.js:
    // 1x: 0
    // 2x: 0, 12
    // 4x: 0, 6, 12, 18
    let schedule = [0];
    if (refreshesPerDay === 2) schedule = [0, 12];
    if (refreshesPerDay === 4) schedule = [0, 6, 12, 18];
  
    // 3. Find the next hour in the schedule
    let targetHour = schedule.find(h => h > hour);
    let targetDay = day;
    
    if (targetHour === undefined) {
      targetHour = schedule[0];
      targetDay++; // Move to tomorrow
    }
  
    // 4. Calculate UTC timestamp
    // Get offset between Cairo and UTC
    const cairoComponentsAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
    const offsetMs = cairoComponentsAsUtc - now.getTime();
  
    const targetUtcParts = Date.UTC(year, month - 1, targetDay, targetHour, 0, 0);
    return new Date(targetUtcParts - offsetMs);
}

export function getNextCairoMidnight() {
  const now = new Date();

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Africa/Cairo',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    hour12: false
  });

  const parts = formatter.formatToParts(now);
  const getPart = (type) => parseInt(parts.find(p => p.type === type).value, 10);

  const year = getPart('year');
  const month = getPart('month');
  const day = getPart('day');
  const hour = getPart('hour') % 24;
  const minute = getPart('minute');
  const second = getPart('second');

  const cairoComponentsAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const offsetMs = cairoComponentsAsUtc - now.getTime();
  
  const midnightUtcParts = Date.UTC(year, month - 1, day, 0, 0, 0);
  const targetMidnight = new Date(midnightUtcParts - offsetMs);

  if (targetMidnight.getTime() <= now.getTime() + 300000) {
    targetMidnight.setTime(targetMidnight.getTime() + 24 * 60 * 60 * 1000);
  }

  if (isNaN(targetMidnight.getTime())) {
    const fallback = new Date();
    fallback.setUTCHours(21, 0, 0, 0); 
    if (fallback <= now) fallback.setUTCDate(fallback.getUTCDate() + 1);
    return fallback;
  }

  return targetMidnight;
}

export function getTimeUntilCairoMidnight() {
  const nextMidnight = getNextCairoMidnight();
  return nextMidnight.getTime() - Date.now();
}

/**
 * Calculate milliseconds until the next full hour in Cairo time.
 * Example: If Cairo is 1:45:10, this returns the ms until 2:00:00.
 */
export function getTimeUntilNextCairoHour() {
    const now = new Date();
    
    // 1. Get Cairo components
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Africa/Cairo',
        year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric',
        hour12: false
    });
    const parts = formatter.formatToParts(now);
    const getPart = (type) => parseInt(parts.find(p => p.type === type).value, 10);

    const year = getPart('year');
    const month = getPart('month');
    const day = getPart('day');
    const hour = getPart('hour') % 24;
    const minute = getPart('minute');
    const second = getPart('second');

    // 2. Calculate offset between Cairo components and UTC
    const cairoNowAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
    const offsetMs = cairoNowAsUtc - now.getTime();

    // 3. Define the next hour target
    let targetHour = hour + 1;
    let targetDay = day;
    if (targetHour >= 24) {
        targetHour = 0;
        targetDay++;
    }

    const targetUtcParts = Date.UTC(year, month - 1, targetDay, targetHour, 0, 0);
    const targetTime = new Date(targetUtcParts - offsetMs);

    return targetTime.getTime() - now.getTime();
}

/**
 * Get the UNIX timestamp (in seconds) for the next Cairo hour.
 */
export function getNextCairoHourTimestamp() {
    const delay = getTimeUntilNextCairoHour();
    return Math.floor((Date.now() + delay) / 1000);
}
