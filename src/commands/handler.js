import { MessageFlags } from 'discord.js';
import { handleMvpCommand } from './mvp.js';

export async function handleSlashCommand(interaction) {
  const { commandName } = interaction;

  switch (commandName) {
    case 'mvp':
      await handleMvpCommand(interaction);
      break;
    default:
      await interaction.reply({
        content: '❌ Unknown command',
        flags: MessageFlags.Ephemeral
      });
  }
}
