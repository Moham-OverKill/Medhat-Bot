import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { handleInventoryButton } from './bank.js';

// --- Command Definition ---
export const inventoryCommand = new SlashCommandBuilder()
  .setName('inventory')
  .setDescription('View your inventory');

// --- Handler ---
export async function handleInventoryCommand(interaction) {
  // Pass to the shared inventory handler (it detects interaction type)
  await handleInventoryButton(interaction);
}
