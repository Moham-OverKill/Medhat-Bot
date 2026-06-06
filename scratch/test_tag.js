import { Client, GatewayIntentBits } from 'discord.js';
import dotenv from 'dotenv';
import { runTagRewardsCycle } from '../src/cron/tagRewards.js';
import { sysLog } from '../src/utils/logger.js';

dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ]
});

client.once('ready', async () => {
  sysLog('Test Client Ready', { user: client.user.tag });
  
  const guild = client.guilds.cache.first();
  if (!guild) {
    console.error('Error: Bot is not in any guilds.');
    process.exit(1);
  }
  
  console.log(`Running Tag Rewards Cycle for Guild: ${guild.name} (${guild.id})...`);
  
  try {
    await runTagRewardsCycle(client, guild.id);
    console.log('Tag Rewards Cycle completed successfully.');
  } catch (err) {
    console.error('Critical Error running cycle:', err);
  }
  
  process.exit(0);
});

if (!process.env.DISCORD_TOKEN) {
  console.error('Error: DISCORD_TOKEN is missing in environment variables.');
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN);
