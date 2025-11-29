import { EmbedBuilder, MessageFlags } from 'discord.js';
import { sanitizeError } from '../shared.js';

/**
 * Error handling and embed utilities
 */

/**
 * Create an error embed
 * @param {string} title - Error title
 * @param {string} description - Error description
 * @returns {EmbedBuilder} Discord embed
 */
export function createErrorEmbed(title, description) {
  return new EmbedBuilder()
    .setColor('#FF0000')
    .setTitle(`❌ ${title}`)
    .setDescription(description)
    .setTimestamp();
}

/**
 * Create a success embed
 * @param {string} title - Success title
 * @param {string} description - Success description
 * @returns {EmbedBuilder} Discord embed
 */
export function createSuccessEmbed(title, description) {
  return new EmbedBuilder()
    .setColor('#00FF00')
    .setTitle(`✅ ${title}`)
    .setDescription(description)
    .setTimestamp();
}

/**
 * Create a warning embed
 * @param {string} title - Warning title
 * @param {string} description - Warning description
 * @returns {EmbedBuilder} Discord embed
 */
export function createWarningEmbed(title, description) {
  return new EmbedBuilder()
    .setColor('#FFA500')
    .setTitle(`⚠️ ${title}`)
    .setDescription(description)
    .setTimestamp();
}

/**
 * Create an info embed
 * @param {string} title - Info title
 * @param {string} description - Info description
 * @returns {EmbedBuilder} Discord embed
 */
export function createInfoEmbed(title, description) {
  return new EmbedBuilder()
    .setColor('#0099FF')
    .setTitle(`ℹ️ ${title}`)
    .setDescription(description)
    .setTimestamp();
}

/**
 * Handle interaction errors gracefully
 * @param {Interaction} interaction - Discord interaction
 * @param {Error} error - Error object
 * @param {string} context - Context where error occurred
 */
export async function handleInteractionError(interaction, error, context = 'command') {
  console.error(`Error in ${context}:`, sanitizeError(error));
  
  const embed = createErrorEmbed(
    'Error',
    'An error occurred while processing your request. Please try again later.'
  );
  
  try {
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral
      });
    } else if (interaction.deferred) {
      await interaction.editReply({ embeds: [embed] });
    } else {
      await interaction.followUp({
        embeds: [embed],
        flags: MessageFlags.Ephemeral
      });
    }
  } catch (replyError) {
    console.error('Failed to send error message:', sanitizeError(replyError));
  }
}

/**
 * Validate required fields in an object
 * @param {Object} obj - Object to validate
 * @param {string[]} requiredFields - Array of required field names
 * @returns {Object} { valid: boolean, missing: string[] }
 */
export function validateRequiredFields(obj, requiredFields) {
  const missing = requiredFields.filter(field => !obj[field]);
  return {
    valid: missing.length === 0,
    missing
  };
}

/**
 * Safe parseInt with fallback
 * @param {any} value - Value to parse
 * @param {number} fallback - Fallback value
 * @returns {number} Parsed integer or fallback
 */
export function safeParseInt(value, fallback = 0) {
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? fallback : parsed;
}
