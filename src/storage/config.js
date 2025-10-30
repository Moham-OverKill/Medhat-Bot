import fs from 'fs/promises';
import path from 'path';

const CONFIG_DIR = './data';
const CONFIG_FILE = path.join(CONFIG_DIR, 'guildConfigs.json');

export async function initializeGuildConfigs() {
  try {
    await fs.mkdir(CONFIG_DIR, { recursive: true });
  } catch (error) {
    console.error('Failed to create config directory:', error);
  }
}

export async function loadGuildConfigs() {
  try {
    const data = await fs.readFile(CONFIG_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Error loading guild configs:', error);
    }
    return {};
  }
}

export async function saveGuildConfigs(configs) {
  try {
    await fs.writeFile(CONFIG_FILE, JSON.stringify(configs, null, 2));
  } catch (error) {
    console.error('Error saving guild configs:', error);
  }
}

export async function getGuildConfig(guildId) {
  const configs = await loadGuildConfigs();
  return configs[guildId] || null;
}

export async function setGuildConfig(guildId, config) {
  const configs = await loadGuildConfigs();
  configs[guildId] = config;
  await saveGuildConfigs(configs);
}

export async function deleteGuildConfig(guildId) {
  const configs = await loadGuildConfigs();
  delete configs[guildId];
  await saveGuildConfigs(configs);
}
