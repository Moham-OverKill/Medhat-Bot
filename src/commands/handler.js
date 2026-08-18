import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { handleSettingsCommand } from './settings.js';
import { handleBankCommand } from './bank.js';
import { handleInventoryCommand } from './inventory.js';
import { handleItemMassCommand } from './item-mass.js';
import { execute as handleQuestCommand } from './quest.js';
import { handleTradeCommand } from './trade.js';
import { handleHelpCommand } from './help.js';
import { handleVoteCommand } from './vote.js';
import { handleLevelCommand } from './pass.js';
import { handleNotificationsCommand } from './notifications.js';
import { sysLog, sysError } from '../utils/logger.js';

export async function handleSlashCommand(interaction) {
  const { commandName } = interaction;

  sysLog('Command Executed', {
    user: interaction.user,
    guild: interaction.guild,
    detail: `Name: /${commandName}`
  });

  // Top-Level Admin Slash Command Security Gate
  const adminCommands = ['settings', 'mass', 'shop', 'rewards', 'colors'];
  if (adminCommands.includes(commandName)) {
    const isAdmin = Boolean(
      interaction.member?.permissions?.has(PermissionFlagsBits.Administrator) ||
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
    );
    if (!isAdmin) {
      sysError('Security Violation: Unauthorized Admin Slash Command Blocked', new Error('Non-admin executed admin command'), {
        user: interaction.user?.id,
        guild: interaction.guildId,
        detail: `Command: /${commandName}`
      });
      return interaction.reply({
        content: '⛔ **Access Denied**: Administrator permission required. You cannot use admin commands.',
        flags: MessageFlags.Ephemeral
      });
    }
  }

  switch (commandName) {
    case 'help':
      await handleHelpCommand(interaction);
      break;
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
    case 'vote':
      await handleVoteCommand(interaction);
      break;
    case 'level':
    case 'pass':
      await handleLevelCommand(interaction);
      break;
    case 'notifications':
    case 'notification':
      await handleNotificationsCommand(interaction);
      break;
    default:
      await interaction.reply({
        content: '❌ Unknown command',
        flags: MessageFlags.Ephemeral
      });
  }
}
