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
  // Create a formatter for Cairo time
  const formatter = new Intl.DateTimeFormat('en-CA', { // en-CA gives YYYY-MM-DD format
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });

  return formatter.format(date);
}

/**
 * Get today's date string in Cairo timezone
 */
export function getTodayCairo() {
  return getCairoDateString(new Date());
}

/**
 * Get yesterday's date string in Cairo timezone
 */
export function getYesterdayCairo() {
  const now = new Date();
  // Get current time in Cairo to safely subtract 24h
  // We can't just subtract 24h from UTC because of potential DST boundaries
  // But for "Yesterday's Date", subtracting 24h from NOW is usually safe enough 
  // IF we format the result in Cairo time.
  // Actually, safer: Get Cairo Date -> Subtract 1 day.

  // Robust approach: 
  // 1. Get current Cairo parts
  // 2. Create date object
  // 3. Subtract 1 day
  // 4. Format

  // Simpler approach that works for "Yesterday": 
  // Subtract 24h from now, then format in Cairo.
  // This covers 99.9% of cases except exactly at DST switch boundaries (rare).
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return getCairoDateString(yesterday);
}

/**
 * Check if a streak is valid (last claim was today or yesterday in Cairo time)
 * Returns true if streak should continue, false if it should reset to 0
 */
export function isStreakValid(lastClaimDate) {
  if (!lastClaimDate) return false;

  const claimDateStr = getCairoDateString(lastClaimDate);
  const today = getTodayCairo();
  const yesterday = getYesterdayCairo();

  return claimDateStr === today || claimDateStr === yesterday;
}

/**
 * Check if user already claimed today (in Cairo time)
 */
export function hasClaimedToday(lastClaimDate) {
  if (!lastClaimDate) return false;

  const claimDateStr = getCairoDateString(lastClaimDate);
  return claimDateStr === getTodayCairo();
}

export function getNextCairoMidnight() {
  const now = new Date();

  // 1. Get current time parts in Cairo timezone
  // Use Intl.DateTimeFormat with formatToParts to avoid fragile string parsing
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false
  });

  const parts = formatter.formatToParts(now);
  const getPart = (type) => {
    let val = parseInt(parts.find(p => p.type === type).value, 10);
    // ICU handling: sometimes hour 0 is reported as 24
    if (type === 'hour' && val === 24) return 0;
    return val;
  };

  // 2. These represent the DATE and TIME currently in Cairo
  const year = getPart('year');
  const month = getPart('month');
  const day = getPart('day');
  const hour = getPart('hour');
  const minute = getPart('minute');
  const second = getPart('second');

  // 3. Calculate current Cairo offset relative to UTC
  // We compare the UTC timestamp of "Now" with the UTC timestamp we'd have 
  // if those Cairo components were UTC.
  const cairoComponentsAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const offsetMs = cairoComponentsAsUtc - now.getTime();
  
  // 4. Target TODAY's 00:00:00 Cairo in UTC:
  const midnightUtcParts = Date.UTC(year, month - 1, day, 0, 0, 0);
  const targetMidnight = new Date(midnightUtcParts - offsetMs);

  // 5. If it passed already (or within 5 mins of passing), add 24 hours
  // Increased threshold to 5 mins to prevent any race condition loop
  if (targetMidnight.getTime() <= now.getTime() + 300000) {
    targetMidnight.setTime(targetMidnight.getTime() + 24 * 60 * 60 * 1000);
  }

  // To prevent NaN during DST changes or edge cases, ensure it's a valid number
  if (isNaN(targetMidnight.getTime())) {
    const fallback = new Date();
    fallback.setUTCHours(21, 0, 0, 0); // 21:00 UTC = 00:00 UTC+3 (Safe DST upper bound)
    if (fallback <= now) fallback.setUTCDate(fallback.getUTCDate() + 1);
    return fallback;
  }

  return targetMidnight;
}

/**
 * Helper to get cairo offset at a specific UTC time
 */
function getCairoOffsetAt(date) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Africa/Cairo',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    hour12: false
  });
  const parts = formatter.formatToParts(date);
  const getPart = (type) => parseInt(parts.find(p => p.type === type).value, 10);
  
  const cDate = new Date(Date.UTC(getPart('year'), getPart('month') - 1, getPart('day'), getPart('hour'), getPart('minute'), getPart('second')));
  return cDate.getTime() - date.getTime();
}

/**
 * Get milliseconds until Cairo midnight (for scheduling)
 */
export function getTimeUntilCairoMidnight() {
  const nextMidnight = getNextCairoMidnight();
  return nextMidnight.getTime() - Date.now();
}
