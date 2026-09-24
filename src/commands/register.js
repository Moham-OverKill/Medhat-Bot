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
import { getGuildConfig } from '../storage/config.js';
import { getPool } from '../storage/postgres.js';
import { getQuests } from '../quests/quests.js';

/**
 * Build the active list of slash commands for a specific guild based on its configuration.
 *
 * @param {string} guildId
 * @returns {Promise<Array<object>>}
 */
export async function buildGuildCommands(guildId) {
  const config = await getGuildConfig(guildId) || {};
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

  // 3. Assemble active commands (help command intentionally removed)
  const commands = [
    settingsCommand.toJSON(),
    bankCommand.toJSON(),
    inventoryCommand.toJSON(),
    itemMassCommand.toJSON(),
    tradeCommand.toJSON(),
    voteCommand.toJSON(),
    notificationsCommand.toJSON(),
    inviteCommand.toJSON(),
    itemsCommand.toJSON()
  ];

  if (hasQuests) {
    commands.push(questCommand.toJSON());
  }

  if (hasLevels) {
    commands.push(levelCommand.toJSON());
  }

  return commands;
}

/**
 * Register or update slash commands for a specific guild in real time.
 *
 * @param {string} guildId
 * @param {import('discord.js').Client} client
 */
export async function syncGuildSlashCommands(guildId, client) {
  if (!guildId || !client?.application?.id) return;
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    const commands = await buildGuildCommands(guildId);
    await rest.put(
      Routes.applicationGuildCommands(client.application.id, guildId),
      { body: commands }
    );
    sysLog('Guild Slash Commands Synced', {
      guild: guildId,
      detail: `Registered ${commands.length} commands (Quests: ${commands.some(c => c.name === 'quest')}, Levels: ${commands.some(c => c.name === 'level')})`
    });
  } catch (error) {
    sysError('Failed to sync guild slash commands', error, { guild: guildId });
  }
}

/**
 * Register slash commands dynamically across all guilds and clear any stale global commands.
 *
 * @param {import('discord.js').Client} client
 */
export async function registerSlashCommands(client) {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    // 1. Clear any leftover global commands to prevent bleeding into unconfigured guilds
    await rest.put(
      Routes.applicationCommands(client.application.id),
      { body: [] }
    );
    sysLog('Global Slash Commands Cleared', { detail: 'Scoped registration to guild-level' });

    // 2. Register dynamic commands per guild
    let count = 0;
    for (const [guildId] of client.guilds.cache) {
      await syncGuildSlashCommands(guildId, client);
      count++;
    }

    return { registered: true, count };
  } catch (error) {
    sysError('Slash command registration failed', error, { detail: client.application?.id });
    throw error;
  }
}
