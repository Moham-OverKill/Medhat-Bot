import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { handleSettingsCommand } from './settings.js';
import { handleBankCommand } from './bank.js';
import { handleInventoryCommand } from './inventory.js';
import { handleItemMassCommand } from './item-mass.js';
import { execute as handleQuestCommand } from './quest.js';
import { handleTradeCommand } from './trade.js';
import { handleVoteCommand } from './vote.js';
import { handleLevelCommand } from './pass.js';
import { handleNotificationsCommand } from './notifications.js';
import { handleInviteCommand } from './invite.js';
import { handleItemsCommand } from './items.js';
import { handleProfileCommand } from './profile.js';
import { getGuildConfig } from '../storage/config.js';
import { sysLog, sysError } from '../utils/logger.js';

export async function handleSlashCommand(interaction) {
  const { commandName } = interaction;

  if (interaction.guildId) {
    await getGuildConfig(interaction.guildId).catch(() => {});
  }

  sysLog('Command Executed', {
    user: interaction.user,
    guild: interaction.guild,
    detail: `Name: /${commandName}`
  });

  // Top-Level Admin Slash Command Security Gate (Zero Trust Multi-Tenant Pre-Check)
  const adminCommands = ['settings', 'mass', 'shop', 'rewards', 'colors'];
  if (adminCommands.includes(commandName)) {
    const { verifyAdminAccess } = await import('../storage/admins.js');
    const hasAccess = await verifyAdminAccess(interaction);
    if (!hasAccess) return;
  }

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
    case 'invite':
      await handleInviteCommand(interaction);
      break;
    case 'items':
      await handleItemsCommand(interaction);
      break;
    case 'profile':
      await handleProfileCommand(interaction);
      break;
    default:
      await interaction.reply({
        content: '❌ Unknown command',
        flags: MessageFlags.Ephemeral
      });
  }
}
