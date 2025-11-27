import { MessageFlags } from 'discord.js';
import { handleMvpComponent } from '../commands/mvp.js';
import { handleColorButton, handleColorsComponent, handleRoleSelection } from '../commands/colors.js';
import { sanitizeError } from '../shared.js';

let handlersSetup = false;

export function setupComponentHandlers(client) {
  if (handlersSetup) {
    console.warn('⚠️ Component handlers already set up');
    return;
  }
  
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isAnySelectMenu() && !interaction.isButton()) return;
    
    if (interaction.customId.startsWith('mvp_')) {
      try {
        await handleMvpComponent(interaction);
      } catch (error) {
        console.error('Error handling MVP component interaction:', sanitizeError(error));
        
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
    } else if (interaction.customId === 'colors:back' || interaction.customId === 'boosters:back') {
      try {
        const { handleColorsCommand } = await import('../commands/colors.js');
        await handleColorsCommand(interaction);
      } catch (error) {
        console.error('Error handling colors back interaction:', sanitizeError(error));
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
    } else if (interaction.customId.startsWith('colors_')) {
      try {
        if (interaction.customId.startsWith('colors_normal_') || interaction.customId.startsWith('colors_booster_')) {
          await handleColorsComponent(interaction);
        }
        // Handle role selection for colors
        else if (interaction.customId.startsWith('colors_role_')) {
          await handleRoleSelection(interaction);
        }
      } catch (error) {
        console.error('Error handling colors component interaction:', sanitizeError(error));
        
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
    } else if (interaction.customId.startsWith('color_')) {
      try {
        // Handle color button clicks
        await handleColorButton(interaction);
      } catch (error) {
        console.error('Error handling color button interaction:', sanitizeError(error));
        
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
  
  handlersSetup = true;
  console.log('✅ Component handlers set up');
}
