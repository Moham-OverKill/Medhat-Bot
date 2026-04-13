import { MessageFlags } from 'discord.js';
import { handleSettingsCommand } from './settings.js';
import { handleBankCommand } from './bank.js';
import { handleInventoryCommand } from './inventory.js';
import { handleItemMassCommand } from './item-mass.js';
import { execute as handleQuestCommand } from './quest.js';
import { handleTradeCommand } from './trade.js';
import { sysLog } from '../utils/logger.js';

export async function handleSlashCommand(interaction) {
  const { commandName } = interaction;

  sysLog('Command Executed', { 
    user: interaction.user, 
    guild: interaction.guild, 
    detail: `Name: /${commandName}` 
  });

  switch (commandName) {
    case 'settings':
      await handleSettingsCommand(interaction);
      break;
    case 'bank':
      await handleBankCommand(interaction);
      break;
    case 'inventory':
      await handleInventoryCommand(interaction);
      break;
    case 'mass':
      await handleItemMassCommand(interaction);
      break;
    case 'quest':
      await handleQuestCommand(interaction);
      break;
    case 'trade':
      await handleTradeCommand(interaction);
      break;
    default:
      await interaction.reply({
        content: '❌ Unknown command',
        flags: MessageFlags.Ephemeral
      });
  }
}
