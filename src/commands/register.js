import { REST, Routes } from 'discord.js';
import { sysError, sysLog } from '../utils/logger.js';
import { bankCommand } from './bank.js';
import { inventoryCommand } from './inventory.js';
import { itemMassCommand } from './item-mass.js';
import { settingsCommand } from './settings.js';
import { data as questCommand } from './quest.js';
import { tradeCommand } from './trade.js';
import { voteCommand } from './vote.js';
import { levelCommand } from './pass.js';
import { notificationsCommand } from './notifications.js';
import { inviteCommand } from './invite.js';
import { itemsCommand } from './items.js';
import { profileCommand } from './profile.js';
import { getGuildConfig } from '../storage/config.js';
import { getPool } from '../storage/postgres.js';
import { getQuests } from '../quests/quests.js';

// Pre-cache JSON schemas to avoid repeated serialization across hundreds of guild syncs
const BASE_COMMANDS = [
  settingsCommand.toJSON(),
  bankCommand.toJSON(),
  inventoryCommand.toJSON(),
  itemMassCommand.toJSON(),
  tradeCommand.toJSON(),
  voteCommand.toJSON(),
  notificationsCommand.toJSON(),
  inviteCommand.toJSON(),
  itemsCommand.toJSON(),
  profileCommand.toJSON()
];
const QUEST_COMMAND_JSON = questCommand.toJSON();
const LEVEL_COMMAND_JSON = levelCommand.toJSON();

/**
 * Build the active list of slash commands for a specific guild based on its configuration.
 *
 * @param {string} guildId
 * @returns {Promise<Array<object>>}
 */
export async function buildGuildCommands(guildId) {
  const config = await getGuildConfig(guildId);
  if (!config) {
    return BASE_COMMANDS;
  }

  const pool = getPool();

  // 1. Quests Check: Must be enabled AND have at least 1 quest in database
  const questsEnabled = Boolean(config.quests_enabled ?? config.missions_enabled ?? false);
  let hasQuests = false;
  if (questsEnabled) {
    const quests = await getQuests(guildId);
    hasQuests = quests.length > 0;
  }

  // 2. Levels Check: Must be enabled AND have at least 1 level configured
  const levelsEnabled = Boolean(config.battlepass_enabled);
  let hasLevels = false;
  if (levelsEnabled) {
    const lvlRes = await pool.query('SELECT 1 FROM battlepass_config WHERE guild_id = $1 LIMIT 1', [guildId]);
    hasLevels = lvlRes.rows.length > 0;
  }

  if (!hasQuests && !hasLevels) {
    return BASE_COMMANDS;
  }

  const commands = [...BASE_COMMANDS];
  if (hasQuests) commands.push(QUEST_COMMAND_JSON);
  if (hasLevels) commands.push(LEVEL_COMMAND_JSON);

  return commands;
}

/**
 * Register or update slash commands for a specific guild in real time.
 *
 * @param {string} guildId
 * @param {import('discord.js').Client} client
 * @param {object} [options]
 * @param {boolean} [options.quiet=false] - When true, suppresses per-guild stdout log during startup
 */
export async function syncGuildSlashCommands(guildId, client, { quiet = false } = {}) {
  if (!guildId || !client?.application?.id) return { success: false };
  const restClient = client.rest || new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    const commands = await buildGuildCommands(guildId);
    await restClient.put(
      Routes.applicationGuildCommands(client.application.id, guildId),
      { body: commands }
    );

    const hasQuests = commands.some(c => c.name === 'quest');
    const hasLevels = commands.some(c => c.name === 'level');

    if (!quiet) {
      sysLog('Guild Slash Commands Synced', {
        guild: guildId,
        detail: `Registered ${commands.length} commands (Quests: ${hasQuests}, Levels: ${hasLevels})`
      });
    }

    return { success: true, count: commands.length, hasQuests, hasLevels };
  } catch (error) {
    sysError('Failed to sync guild slash commands', error, { guild: guildId });
    return { success: false, error };
  }
}

/**
 * Register slash commands dynamically across all guilds and clear any stale global commands.
 *
 * @param {import('discord.js').Client} client
 */
export async function registerSlashCommands(client) {
  const restClient = client.rest || new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    // 1. Clear any leftover global commands to prevent bleeding into unconfigured guilds
    await restClient.put(
      Routes.applicationCommands(client.application.id),
      { body: [] }
    );
    sysLog('Global Slash Commands Cleared', { detail: 'Scoped registration to guild-level' });

    // 2. Synchronize guild slash commands across all guilds in the background (non-blocking)
    // Active/configured guilds are prioritized so newly introduced commands (like /profile) appear immediately.
    setImmediate(async () => {
      try {
        const pool = getPool();
        const confRes = await pool.query('SELECT guild_id FROM guild_configs').catch(() => ({ rows: [] }));
        const priorityGuildIds = new Set(confRes.rows.map(r => r.guild_id));

        const allGuildIds = Array.from(client.guilds.cache.keys());
        allGuildIds.sort((a, b) => {
          const aPri = priorityGuildIds.has(a) ? 1 : 0;
          const bPri = priorityGuildIds.has(b) ? 1 : 0;
          return bPri - aPri;
        });

        let synced = 0;
        let withQuests = 0;
        let withLevels = 0;

        for (const guildId of allGuildIds) {
          const res = await syncGuildSlashCommands(guildId, client, { quiet: true });
          if (res?.success) {
            synced++;
            if (res.hasQuests) withQuests++;
            if (res.hasLevels) withLevels++;
          }
          await new Promise(r => setTimeout(r, 120));
        }

        sysLog('Background Slash Commands Sync Complete', {
          detail: `Synced ${synced} guilds (${withQuests} with Quests, ${withLevels} with Levels)`
        });
      } catch (bgErr) {
        sysError('Background Guild Slash Commands Sync Error', bgErr);
      }
    });

    return { registered: true, count: 0 };
  } catch (error) {
    sysError('Slash command registration failed', error, { detail: client.application?.id });
    throw error;
  }
}
