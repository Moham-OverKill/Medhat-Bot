import { REST, Routes } from 'discord.js';
import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { sanitizeError } from '../shared.js';
import { colorsCommand, colorCommand } from './colors.js';

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
  const commands = [
    {
      name: 'mvp',
      description: 'MVP system management',
      default_member_permissions: '268435456', // MANAGE_ROLES permission
      dm_permission: false,
      options: [
        {
          name: 'setup',
          type: 1, // SUB_COMMAND
          description: 'Open the MVP control panel to configure and manage the MVP system'
        }
      ]
    },
    colorsCommand.toJSON(),
    colorCommand.toJSON()
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    await ensureDataDir();

    const payload = JSON.stringify(commands);
    const currentHash = createHash('sha256').update(payload).digest('hex');
    const previousHash = await readPreviousHash();

    if (previousHash && previousHash === currentHash) {
      if (process.env.NODE_ENV !== 'production') {
        console.log('⚡ Slash commands unchanged; skipping re-registration');
      }
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
