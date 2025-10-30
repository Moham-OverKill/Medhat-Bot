import { Client, GatewayIntentBits, MessageFlags } from 'discord.js';
import { createServer } from 'http';
import { registerSlashCommands } from './commands/register.js';
import { handleSlashCommand } from './commands/handler.js';
import { initializeGuildConfigs, loadGuildConfigs } from './storage/config.js';
import { initializeActivityTracking } from './activity/index.js';
import { scheduleAllMvpTimers } from './mvp/award.js';
import { setupComponentHandlers } from './components/handlers.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates
  ]
});

// HTTP keepalive server for Railway
createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('🌐 Web server ready');
}).listen(process.env.PORT || 3000);

client.once('clientReady', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  
  // Initialize storage and load configs
  await initializeGuildConfigs();
  const configs = await loadGuildConfigs();
  
  // Register slash commands globally
  await registerSlashCommands(client);
  console.log('✅ Slash commands registered');
  
  // Initialize activity tracking
  await initializeActivityTracking(client);
  
  // Setup component handlers
  setupComponentHandlers(client);
  
  // Schedule MVP timers for all configured guilds
  await scheduleAllMvpTimers(client);
  
  console.log(`🌐 Web server ready on port ${process.env.PORT || 3000}`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  
  try {
    await handleSlashCommand(interaction);
  } catch (error) {
    console.error('Error handling interaction:', error);
    
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: '❌ An error occurred while handling this command.',
        flags: MessageFlags.Ephemeral
      });
    } else if (interaction.deferred) {
      await interaction.followUp({
        content: '❌ An error occurred while processing this command.',
        flags: MessageFlags.Ephemeral
      });
    }
  }
});

// Validate required environment variables
if (!process.env.DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN environment variable is required');
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN);
