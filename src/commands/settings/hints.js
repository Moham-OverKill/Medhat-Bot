import { EmbedBuilder, MessageFlags } from 'discord.js';

export const SETTINGS_HINTS = {
  coins: {
    title: 'HINT: Coins',
    description:
      'Choose how members get coins in your server.\n\n' +
      '📅 **Daily:** Free coins members can claim every day. Claiming multiple days in a row gives bigger streak bonuses.\n\n' +
      '🎯 **Quests:** Simple tasks (like chatting or voice) that give coins when finished. Members check tasks with `/quest`.\n\n' +
      '🏷️ **Tag:** Gives free coins to members who put your server tag on their profile.\n\n' +
      '🗳️ **Vote:** Gives free coins to members who vote for Medhat on Top.gg using `/vote`.\n\n' +
      '🖼️ **Appearance:** Change the coin name and emoji for your server.\n\n' +
      '💸 **Give Coins:** Give free coins to any member right now.'
  },
  items: {
    title: 'HINT: Items',
    description:
      'Create items and roles for your server.\n\n' +
      '⚠️ **Create Items First:** You need to create items here before you can use them as level rewards in **Leveling** or prize drops in **Chests**.\n\n' +
      '📁 **Categories (Swap vs Stack):** Categories group your items together:\n' +
      '• **Single (Swap):** Equipping one item removes the old one. Best for color roles so members only have one color active.\n' +
      '• **Multi (Stack):** Members can equip and keep multiple items at the same time.\n\n' +
      '🏷️ **Items:** Roles or rewards you sell. You can set them to last forever or expire after some time.\n\n' +
      '📦 **Packs:** Bundle multiple items together into one buyable package.\n\n' +
      '📢 **Put in Shop:** Creating an item here does not put it in chat yet. Go to the **Post** page to post it in a channel for members to buy.'
  },
  chests: {
    title: 'HINT: Chests',
    description:
      'Create mystery boxes that give random rewards when opened.\n\n' +
      '⚠️ **Needs Items:** Chests give out items from your server. Make sure you create items in the **Items** page first.\n\n' +
      '➕ **Create:** Make a new chest, set how many coins it can give, and set the chance for each item rarity.\n\n' +
      '🖼️ **Appearance:** Pick the chest name, closed chest picture, and open animation.\n\n' +
      '📦 **Opening:** Members open their chests in `/inventory` to get rewards, or trade them with `/trade`.\n\n' +
      '📢 **How to Give:** You can sell chests in chat channels using the **Post** page, or give them as rewards in **Leveling**.'
  },
  post: {
    title: 'HINT: Post',
    description:
      'Put items and chests into chat channels so members can buy them.\n\n' +
      '⚠️ **Important:** Items and chests are not in the shop until you post them to a channel here.\n\n' +
      '➕ **New Post:** Pick an item or chest, set the coin price and stock limit, and send it to any channel you want.\n\n' +
      '📝 **Edit Post:** Change the price, restock, or edit a shop post you already made without deleting it.\n\n' +
      '🛒 **Buying:** Members click the Buy button on your post to purchase. They can also use `/items` to see everything for sale.'
  },
  economy: {
    title: 'HINT: Economy',
    description:
      'See all the money moving around in your server.\n\n' +
      '💰 **Total Wealth:** All coins owned by every member in your server added together.\n\n' +
      '🖨️ **Printed:** New coins given to members from chatting, talking in voice, daily claims, quests, and votes.\n\n' +
      '🔥 **Burned:** Coins spent by members in your shop or on chest openings and removed from the server.\n\n' +
      '🏷️ **Prices:** Check and change your shop prices anytime.\n\n' +
      '📅 **Time Buttons:** Click Day, Week, or Month to see stats for that time period.'
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
