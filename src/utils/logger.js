import { sanitizeError } from '../shared.js';

/**
 * Structured logging utilities
 */

/**
 * Log an informational event
 * @param {string} event - Event name/type
 * @param {Object} data - Additional event data
 */
export function logEvent(event, data = {}) {
  const payload = {
    level: 'INFO',
    event,
    timestamp: new Date().toISOString(),
    ...data
  };

  if (process.env.NODE_ENV === 'production') {
    console.log(JSON.stringify(payload));
  } else {
    console.log(`[${event}]`, data);
  }
}

/**
 * Log an error
 * @param {string} context - Context where error occurred
 * @param {string} source - Source/module name
 * @param {string} message - Error message
 */
export function logError(context, source, message) {
  const payload = {
    level: 'ERROR',
    context,
    source,
    message,
    timestamp: new Date().toISOString()
  };

  if (process.env.NODE_ENV === 'production') {
    console.error(JSON.stringify(payload));
  } else {
    console.error(`[${context}/${source}]`, message);
  }
}

/**
 * Log a server event (guild-level activity)
 * @param {string} message - Event message
 */
export function logServerEvent(message) {
  console.log(`[SERVER] ${message}`);
}

/**
 * Log a system error
 * @param {string} message - Error message
 */
export function logSystemError(message) {
  console.error(`[SYSTEM ERROR] ${message}`);
}

/**
 * Log an audit event (for compliance/tracking)
 * @param {string} action - Action performed
 * @param {Object} data - Audit data
 */
export function logAudit(action, data = {}) {
  const payload = {
    level: 'AUDIT',
    action,
    timestamp: new Date().toISOString(),
    ...data
  };

  console.log(JSON.stringify(payload));
}
