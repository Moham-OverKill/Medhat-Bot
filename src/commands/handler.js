import { MessageFlags } from 'discord.js';
import { handleMvpCommand } from './mvp.js';
import { handleColorsCommand, handleColorCommand } from './colors.js';

export async function handleSlashCommand(interaction) {
  const { commandName } = interaction;

  switch (commandName) {
    case 'mvp':
      await handleMvpCommand(interaction);
      break;
    case 'colors':
      await handleColorsCommand(interaction);
      break;
    case 'color':
      await handleColorCommand(interaction);
      break;
    default:
      await interaction.reply({
        content: '❌ Unknown command',
        flags: MessageFlags.Ephemeral
      });
  }
}
