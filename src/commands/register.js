import { REST, Routes, PermissionFlagsBits } from 'discord.js';
import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { sanitizeError } from '../shared.js';
import { bankCommand } from './bank.js';
import { inventoryCommand } from './inventory.js';
import { itemMassCommand } from './item-mass.js';
import { settingsCommand } from './settings.js';
import { data as questCommand } from './quest.js';
import { tradeCommand } from './trade.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../data');
const COMMAND_HASH_FILE = path.join(DATA_DIR, 'slash_commands.sha256');

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readPreviousHash() {
  try {
    const contents = await fs.readFile(COMMAND_HASH_FILE, 'utf8');
    return contents.trim();
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function writeHash(hash) {
  await fs.writeFile(COMMAND_HASH_FILE, hash, 'utf8');
}

export async function registerSlashCommands(client) {
  // Unified /settings includes leaderboard config now
  const commands = [
    settingsCommand.toJSON(),
    bankCommand.toJSON(),
    inventoryCommand.toJSON(),
    itemMassCommand.toJSON(),
    questCommand.toJSON(),
    tradeCommand.toJSON()
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    await ensureDataDir();

    const payload = JSON.stringify(commands);
    const currentHash = createHash('sha256').update(payload).digest('hex');
    const previousHash = await readPreviousHash();

    if (false && previousHash && previousHash === currentHash) {
      return { registered: false, count: commands.length };
    }

    await rest.put(
      Routes.applicationCommands(client.application.id),
      { body: commands },
    );

    await writeHash(currentHash);
    return { registered: true, count: commands.length };
  } catch (error) {
    console.error('Error registering slash commands:', sanitizeError(error));
    throw error;
  }
}
