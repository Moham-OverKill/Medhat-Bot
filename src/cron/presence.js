import cron from 'node-cron';
import { ActivityType, Events } from 'discord.js';
import { sysLog, sysError } from '../utils/logger.js';

/**
 * Cat-themed status list
 */
const CAT_STATUSES = [
  "Meow Meow?",
  "I smell catnip!",
  "Under your bed",
  "Looking for dry food",
  "Searching your trash can",
  "Watching you sleep...",
  "Chasing a mouse!",
  "Chewing your cables",
  "Catching red dots!",
  "Zzz . . .",
  "Unrolling toilet paper",
  "Scratching new sofa",
  "Knocking cups off tables",
  "Walking across keyboards",
  "Staring at empty corners",
  "Hissing at the vacuum cleaner",
  "Sitting in a cardboard box",
  "Plotting world domination",
  "Spying from high shelves...",
  "Watching birds through window...",
  "Loaf mode activated!",
  "Purring like an engine!",
  "Demanding attention!!",
  "Judging your life choices..."
];

let lastStatusIndex = -1;

/**
 * Updates the bot's rich presence with a random cat status
 * @param {import('discord.js').Client} client 
 * @param {boolean} [preservePhrase=false] If true, retains current phrase
 */
export function updateBotPresence(client, preservePhrase = false) {
  if (!client?.user) return;
  let statusText = 'Medhat';
  try {
    let selectedIndex = lastStatusIndex;

    if (!preservePhrase || selectedIndex < 0 || selectedIndex >= CAT_STATUSES.length) {
      // Exclude the immediately previous status to guarantee non-repeating rotation
      const availableIndices = [];
      for (let i = 0; i < CAT_STATUSES.length; i++) {
        if (i !== lastStatusIndex) {
          availableIndices.push(i);
        }
      }

      selectedIndex = availableIndices.length > 0
        ? availableIndices[Math.floor(Math.random() * availableIndices.length)]
        : 0;

      lastStatusIndex = selectedIndex;
    }

    statusText = CAT_STATUSES[selectedIndex] || 'Medhat';

    client.user.setPresence({
      status: 'online',
      activities: [{
        name: statusText,
        type: ActivityType.Custom,
        state: statusText // For Custom status, 'state' is the actual text
      }]
    });
    
    sysLog('Infrastructure Audit', { detail: `Presence updated: "${statusText}"` });
  } catch (error) {
    sysError('Infrastructure Audit Failed', error, { detail: 'Presence update failure' });
    
    // Fallback to Playing (0) if Custom fails
    try {
      client.user.setActivity(statusText, { type: ActivityType.Playing });
    } catch (_) {}
  }
}

/**
 * Starts the hourly presence rotation cron job and attaches live guild event listeners
 * @param {import('discord.js').Client} client 
 */
export function startPresenceRotation(client) {
  // Run at minute 0 of every hour (0 * * * *)
  // Timezone: Africa/Cairo
  cron.schedule('0 * * * *', () => {
    updateBotPresence(client, false);
  }, {
    scheduled: true,
    timezone: "Africa/Cairo"
  });

  client.on(Events.GuildCreate, (guild) => {
    sysLog('Infrastructure Audit', { detail: `Bot added to server: "${guild.name}" (${guild.id}). Live count: ${client.guilds.cache.size}` });
  });

  client.on(Events.GuildDelete, (guild) => {
    sysLog('Infrastructure Audit', { detail: `Bot removed from server: "${guild.name || 'Unknown'}" (${guild.id}). Live count: ${client.guilds.cache.size}` });
  });

  sysLog('Infrastructure Audit', { detail: 'Hourly Presence Rotator & Live Guild Listeners initialized (Timezone: Africa/Cairo)' });
}
