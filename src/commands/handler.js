import { MessageFlags } from 'discord.js';
import { handleMvpCommand } from './mvp.js';
import { handleColorsCommand, handleColorCommand } from './colors.js';
import { handleBank } from './bank.js';
import { handleShopSetupCommand } from './shop-setup.js';

export async function handleSlashCommand(interaction) {
  const { commandName } = interaction;

  switch (commandName) {
    case 'bank':
      await handleBank(interaction);
      break;
    case 'mvp':
      await handleMvpCommand(interaction);
      break;
    case 'colors':
      await handleColorsCommand(interaction);
      break;
    case 'color':
      await handleColorCommand(interaction);
      break;
    case 'shop-setup':
      await handleShopSetupCommand(interaction);
      break;
    default:
      await interaction.reply({
        content: '❌ Unknown command',
        flags: MessageFlags.Ephemeral
      });
  }
}
