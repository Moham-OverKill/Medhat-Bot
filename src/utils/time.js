/**
 * Time formatting utilities
 */

/**
 * Format milliseconds to a human-readable time string
 * @param {number} milliseconds - Time in milliseconds
 * @returns {string} Formatted time (e.g., "2h 30m" or "45m 12s")
 */
export function formatTimeRemaining(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  } else if (minutes > 0) {
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  } else {
    return `${seconds}s`;
  }
}

/**
 * Format milliseconds to a detailed human-readable time string
 * @param {number} milliseconds - Time in milliseconds
 * @returns {string} Detailed formatted time (e.g., "2 hours and 30 minutes")
 */
export function formatDetailedTimeRemaining(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) {
    const remainingHours = hours % 24;
    return `${days} day${days !== 1 ? 's' : ''} and ${remainingHours} hour${remainingHours !== 1 ? 's' : ''}`;
  } else if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return `${hours} hour${hours !== 1 ? 's' : ''} and ${remainingMinutes} minute${remainingMinutes !== 1 ? 's' : ''}`;
  } else if (minutes > 0) {
    const remainingSeconds = seconds % 60;
    return `${minutes} minute${minutes !== 1 ? 's' : ''} and ${remainingSeconds} second${remainingSeconds !== 1 ? 's' : ''}`;
  } else {
    return `${seconds} second${seconds !== 1 ? 's' : ''}`;
  }
}

/**
 * Get the next daily reset time (midnight UTC)
 * @param {string|Date|number} lastClaimTimestamp - Last claim timestamp
 * @returns {number} Next claim time in milliseconds
 */
export function getNextDailyTime(lastClaimTimestamp) {
  if (!lastClaimTimestamp) return Date.now();
  
  const lastClaim = new Date(lastClaimTimestamp);
  const nextClaim = new Date(lastClaim);
  
  // Set to next day at midnight UTC
  nextClaim.setUTCDate(nextClaim.getUTCDate() + 1);
  nextClaim.setUTCHours(0, 0, 0, 0);
  
  return nextClaim.getTime();
}

/**
 * Get daily cooldown information
 * @param {string|Date|number} lastClaimTimestamp - Last claim timestamp
 * @returns {Object} { canClaim: boolean, timeRemaining: number, nextClaimTime: number }
 */
export function getDailyCooldownInfo(lastClaimTimestamp) {
  const nextClaimTime = getNextDailyTime(lastClaimTimestamp);
  const now = Date.now();
  const timeRemaining = nextClaimTime - now;
  
  return {
    canClaim: timeRemaining <= 0,
    timeRemaining: Math.max(0, timeRemaining),
    nextClaimTime
  };
}

/**
 * Format a date to a human-readable string
 * @param {Date|string|number} date - Date to format
 * @returns {string} Formatted date
 */
export function formatDate(date) {
  const d = new Date(date);
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}
