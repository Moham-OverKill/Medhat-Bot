import { cleanupExpiredItems } from '../economy/shop.js';
import { cleanupExpiredDrops } from '../commands/bank.js';
import { logSystemEvent, logSystemError } from '../utils/logger.js';
import { sanitizeError } from '../shared.js';

/**
 * Starts the background job to check for expired items
 * @param {import('discord.js').Client} client 
 */
export function startExpiryJob(client) {
  logSystemEvent('Starting expiration cron job (60s interval)...');
  
  // Run immediately on startup
  runCleanup(client);

  // Schedule every 60 seconds
  setInterval(() => runCleanup(client), 60 * 1000);
}

async function runCleanup(client) {
  try {
    // 1. Cleanup expired inventory items
    await cleanupExpiredItems(client);
    
    // 2. Cleanup expired public drops
    await cleanupExpiredDrops(client);
  } catch (error) {
    logSystemError(`Expiration job error: ${sanitizeError(error)}`);
  }
}
