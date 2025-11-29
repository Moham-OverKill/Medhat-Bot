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
 * Supports two signatures:
 * 1. logAudit(action, data) - Simple format
 * 2. logAudit(guildId, userId, action, entityType, entityId, data) - Detailed format
 */
export function logAudit(...args) {
  let payload;
  
  if (args.length === 2) {
    // Simple format: logAudit(action, data)
    const [action, data = {}] = args;
    payload = {
      level: 'AUDIT',
      action,
      timestamp: new Date().toISOString(),
      ...data
    };
  } else if (args.length >= 3) {
    // Detailed format: logAudit(guildId, userId, action, entityType, entityId, data)
    const [guildId, userId, action, entityType = null, entityId = null, data = {}] = args;
    payload = {
      level: 'AUDIT',
      guildId,
      userId,
      action,
      entityType,
      entityId,
      timestamp: new Date().toISOString(),
      ...data
    };
  } else {
    // Fallback for invalid calls
    payload = {
      level: 'AUDIT',
      action: 'unknown',
      args,
      timestamp: new Date().toISOString()
    };
  }

  console.log(JSON.stringify(payload));
}
