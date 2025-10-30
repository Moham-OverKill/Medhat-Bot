import { MessageFlags } from 'discord.js';
import { handleMvpComponent } from '../commands/mvp.js';

export function setupComponentHandlers(client) {
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isAnySelectMenu() && !interaction.isButton()) return;
    
    if (interaction.customId.startsWith('mvp_')) {
      try {
        await handleMvpComponent(interaction);
      } catch (error) {
        console.error('Error handling MVP component interaction:', error);
        
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: '❌ An error occurred while handling this interaction.',
            flags: MessageFlags.Ephemeral
          });
        } else if (interaction.deferred) {
          await interaction.followUp({
            content: '❌ An error occurred while processing this interaction.',
            flags: MessageFlags.Ephemeral
          });
        }
      }
    }
  });
}
