import { EmbedBuilder, MessageFlags } from 'discord.js';
import { sanitizeError } from '../shared.js';
import { sysLog, sysError } from './logger.js';

/**
 * Create a standardized error embed
 */
export function createErrorEmbed(title, description) {
  return new EmbedBuilder()
    .setColor(0xFF0000)
    .setTitle(`❌ ${title}`)
    .setDescription(description);
}

/**
 * Create a standardized success embed
 */
export function createSuccessEmbed(title, description) {
  return new EmbedBuilder()
    .setColor(0x00FF00)
    .setTitle(`✅ ${title}`)
    .setDescription(description);
}

/**
 * Handle interaction errors uniformly
 */
export async function handleInteractionError(interaction, error, context) {
  sysError('Interaction Audit Failure', error, { 
    user: interaction?.user?.id, 
    guild: interaction?.guildId, 
    detail: context 
  });
  
  const message = 'An error occurred while processing your request.';
  
  try {
    // If we can't reply, nothing to do
    if (!interaction) return;

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ 
        content: `❌ ${message}`, 
        flags: MessageFlags.Ephemeral 
      });
    } else {
      await interaction.reply({ 
        content: `❌ ${message}`, 
        flags: MessageFlags.Ephemeral 
      });
    }
  } catch (e) {
    sysError('Interaction Warning', e, { detail: 'Failed to send ephemeral error response' });
  }
}
