import cron from 'node-cron';
import { ActivityType } from 'discord.js';
import { sysLog, sysError } from '../utils/logger.js';

/**
 * Cat-themed status list
 * XX will be replaced with client.guilds.cache.size
 */
const CAT_STATUSES = [
  "XX Servers | Meow Meow?",
  "XX Servers | I smell catnip!",
  "XX Servers | Under your bed",
  "XX Servers | Looking for dry food",
  "XX Servers | Searching your trash can",
  "XX Servers | Watching you sleep...",
  "XX Servers | Chasing a mouse!",
  "XX Servers | Chewing your cables",
  "XX Servers | Catching red dots!",
  "XX Servers | Zzz . . .",
  "XX Servers | Unrolling toilet paper",
  "XX Servers | Scratching new sofa",
  "XX Servers | Knocking cups off tables",
  "XX Servers | Walking across keyboards",
  "XX Servers | Staring at empty corners",
  "XX Servers | Hissing at the vacuum cleaner",
  "XX Servers | Sitting in a cardboard box",
  "XX Servers | Plotting world domination",
  "XX Servers | Spying from high shelves...",
  "XX Servers | Watching birds through window...",
  "XX Servers | Loaf mode activated!",
  "XX Servers | Purring like an engine!",
  "XX Servers | Demanding attention!!",
  "XX Servers | Judging your life choices..."
];

let lastStatusIndex = -1;

/**
 * Updates the bot's rich presence with a random cat status (never repeating the previous hour)
 * @param {import('discord.js').Client} client 
 */
export function updateBotPresence(client) {
  let statusText = `${client.guilds.cache.size} Servers`;
  try {
    // Exclude the immediately previous status to guarantee non-repeating rotation
    const availableIndices = [];
    for (let i = 0; i < CAT_STATUSES.length; i++) {
      if (i !== lastStatusIndex) {
        availableIndices.push(i);
      }
    }

    const selectedIndex = availableIndices.length > 0
      ? availableIndices[Math.floor(Math.random() * availableIndices.length)]
      : 0;

    lastStatusIndex = selectedIndex;

    const rawStatus = CAT_STATUSES[selectedIndex];
    statusText = rawStatus.replace('XX', client.guilds.cache.size);

    // Dynamic ActivityType: Prefer Custom, fallback to Playing
    let type = ActivityType.Custom;
    
    // Check if Custom is supported for bots (some versions/API states might vary)
    // In D.js v14, Custom is 4, but bots often display better with Playing (0) or Watching (3)
    // User requested Custom specifically.
    
    client.user.setPresence({
      status: 'online',
      activities: [{
        name: statusText,
        type: type,
        state: statusText // For Custom status, 'state' is the actual text
      }]
    });
    
    sysLog('Infrastructure Audit', { detail: `Presence updated: "${statusText}"` });
  } catch (error) {
    sysError('Infrastructure Audit Failed', error, { detail: 'Presence update failure' });
    
    // Fallback to Playing (0) if Custom fails
    try {
      client.user.setActivity(statusText, { type: ActivityType.Playing });
    } catch (e) {}
  }
}

/**
 * Starts the hourly presence rotation cron job
 * @param {import('discord.js').Client} client 
 */
export function startPresenceRotation(client) {
  // Run at minute 0 of every hour (0 * * * *)
  // Timezone: Africa/Cairo
  cron.schedule('0 * * * *', () => {
    updateBotPresence(client);
  }, {
    scheduled: true,
    timezone: "Africa/Cairo"
  });

  sysLog('Infrastructure Audit', { detail: 'Hourly Presence Rotator initialized (Timezone: Africa/Cairo)' });
}
