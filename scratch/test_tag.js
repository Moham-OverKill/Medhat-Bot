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
  
  console.log(`Guild: ${guild.name} (${guild.id})`);
  
  try {
    console.log('Fetching members to inspect primaryGuild tags...');
    const members = await guild.members.fetch({ force: true });
    console.log(`Fetched ${members.size} members.`);
    
    for (const [id, member] of members) {
      if (member.user.bot) continue;
      
      let primaryGuild = member.user.primaryGuild;
      if (primaryGuild === undefined) {
        try {
          const freshUser = await client.users.fetch(member.id, { force: true });
          primaryGuild = freshUser.primaryGuild;
        } catch {}
      }
      
      if (primaryGuild) {
        console.log(`User: ${member.user.tag} (${member.id})`);
        console.log(` - Primary Guild ID: ${primaryGuild.identityGuildId}`);
        console.log(` - Identity Enabled: ${primaryGuild.identityEnabled}`);
        console.log(` - Tag: ${primaryGuild.tag}`);
      }
    }
    
    console.log('Running full scan cycle...');
    await runTagRewardsCycle(client, guild.id);
    console.log('Tag Rewards Cycle completed successfully.');
  } catch (err) {
    console.error('Critical Error during test:', err);
  }
  
  process.exit(0);
});

if (!process.env.DISCORD_TOKEN) {
  console.error('Error: DISCORD_TOKEN is missing in environment variables.');
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN);
