import { EmbedBuilder, MessageFlags } from 'discord.js';

export const SETTINGS_HINTS = {
  coins: {
    title: 'HINT: Coins',
    description: 
      'Set up ways for your server members to earn free coins.\n\n' +
      '📅 **Daily:** Free coins members can claim every 24 hours. They can check their coins with `/bank`.\n\n' +
      '🎯 **Quests:** Fun challenges members can complete to earn coins. They can check active tasks with `/quest`.\n\n' +
      '🏷️ **Tag:** Reward members who add your official Discord server tag to their profile.\n\n' +
      '🗳️ **Vote:** Free bonus coins given to members who vote for Medhat on Top.gg using `/vote`.\n\n' +
      '🖼️ **Appearance:** Change what your server coins are called and what icon they use.\n\n' +
      '💸 **Give Coins:** Instantly send free coins to any member.'
  },
  items: {
    title: 'HINT: Items & Roles',
    description:
      'Your storage room where you create rewards for members to buy.\n\n' +
      '📁 **Categories:** Folders to organize your shop items.\n\n' +
      '🏷️ **Items:** The rewards members can buy, like Discord roles. Members view what they own with `/inventory` and browse the catalog with `/items`.\n\n' +
      '📦 **Packs:** Bundle boxes that sell multiple items together in one purchase.\n\n' +
      '❔ **Note:** Creating an item here puts it in your storage room. Go to the **Post** page next to put it in a channel for members to buy.'
  },
  chests: {
    title: 'HINT: Chests & Mystery Boxes',
    description:
      'Surprise boxes that give random coins and items when opened.\n\n' +
      '➕ **Create:** Make a new mystery box and choose what prizes and chances are hidden inside.\n\n' +
      '🖼️ **Appearance:** Change what your chests are called and what icon they use.\n\n' +
      '📦 **Chests:** Members open their chests using `/inventory` to reveal prizes, or trade them with `/trade`.'
  },
  post: {
    title: 'HINT: Post to Shop',
    description:
      'Put items from your storage room into chat channels so members can buy them.\n\n' +
      '➕ **New Post:** Pick an item or chest, set the price, and send it into any channel you choose.\n\n' +
      '📝 **Edit Post:** Change the price, stock, or channel of a shop message you already posted.\n\n' +
      '🛒 **Buying:** Members click the Buy button on your post to purchase, or browse the catalog with `/items`.'
  },
  economy: {
    title: 'HINT: Economy Stats',
    description:
      'Track all the coins moving through your server.\n\n' +
      '💰 **Total Wealth:** All coins currently owned by every server member combined.\n\n' +
      '🖨️ **Printed & Burned:** See how many coins were created (from chat, voice, quests, and daily) versus spent in your shop.\n\n' +
      '🏷️ **Prices:** Inspect and quickly adjust the prices of your shop items.\n\n' +
      '📅 **Time Buttons:** Click Per Day, Per Week, or Per Month to see stats across different times.'
  }
};

/**
 * Handle clicking a settings hint button
 * @param {import('discord.js').ButtonInteraction} interaction
 */
export async function handleSettingsHint(interaction) {
  const parts = interaction.customId.split('_');
  const pageKey = parts[2]; // e.g. 'coins', 'items', 'chests', 'post', 'economy'
  const hint = SETTINGS_HINTS[pageKey];

  if (!hint) {
    return interaction.reply({
      content: 'No hint available for this page.',
      flags: MessageFlags.Ephemeral
    });
  }

  const embed = new EmbedBuilder()
    .setTitle(hint.title)
    .setDescription(hint.description)
    .setColor(0xF1C40F);

  return interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral
  });
}
