import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { handleInventoryButton } from './bank.js';
import { getSynthesizedInventory } from '../economy/shop.js';

// --- Command Definition ---
export const inventoryCommand = new SlashCommandBuilder()
  .setName('inventory')
  .setDescription('View your inventory')
  .setDMPermission(false);

// --- Handler ---
export async function handleInventoryCommand(interaction) {
  const guildId = interaction.guildId;
  const userId = interaction.user.id;

  // Pre-check: If user has an empty inventory, inform them ephemerally
  const inventory = await getSynthesizedInventory(userId, guildId, interaction.member);
  const items = inventory.filter(i => i.item_type !== 'pack' && !i.is_pack);
  const totalCount = items.reduce((sum, i) => sum + (parseInt(i.quantity, 10) || 1), 0);

  if (totalCount === 0) {
    return interaction.reply({
      content: 'Your inventory is currently empty. Visit the shop or participate in server activities to acquire items.',
      flags: MessageFlags.Ephemeral
    });
  }

  // Pass to the shared inventory handler (it detects interaction type)
  await handleInventoryButton(interaction);
}
