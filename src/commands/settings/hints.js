import { EmbedBuilder, MessageFlags } from 'discord.js';

export const SETTINGS_HINTS = {
  coins: {
    title: 'HINT: Coins',
    description: 
      'This is where you set up ways for your server members to earn free coins.\n\n' +
      '• **Daily:** Free coins members can claim once every 24 hours. They can check their balance anytime with `/bank`.\n' +
      '• **Quests:** Fun challenges members can complete to win coins. Members check their tasks with `/quest`.\n' +
      '• **Tag:** Gives free coins to anyone who puts your server name in their Discord profile status.\n' +
      '• **Vote:** Free bonus coins given when members vote for your bot online using `/vote`.\n' +
      '• **Appearance:** Change what your coins are called and what icon they use (like Gold, Stars, or Credits).\n' +
      '• **Give Coins:** Instantly give free coins to any member with one click.'
  },
  items: {
    title: 'HINT: Items & Roles',
    description:
      'This is your storage room. You create the rewards you want to sell here.\n\n' +
      '• **Categories:** Folders to keep your items tidy (like "Colors" or "VIP Roles").\n' +
      '• **Items:** The rewards people can buy (usually Discord roles that give cool colors or names). Members browse your catalog with `/items` and view what they own with `/inventory`.\n' +
      '• **Packs:** Bundle boxes that sell multiple items together as one package.\n\n' +
      '❔ *Important:* Creating an item here puts it in your storage room. To display it in a channel so members can buy it, go to the **Post** page next!'
  },
  chests: {
    title: 'HINT: Chests & Mystery Boxes',
    description:
      'Mystery surprise boxes! When members open them, they win random coins or items.\n\n' +
      '• **Create:** Make a new mystery box and pick what prizes and chances are hidden inside.\n' +
      '• **Appearance:** Change what the chest looks like and what it is called.\n' +
      '• **Opening Chests:** Members view and open their chests using `/inventory` to reveal their rewards. Members can also trade them with `/trade`.'
  },
  post: {
    title: 'HINT: Post to Shop',
    description:
      'This is where you put your items into chat channels so members can see and buy them.\n\n' +
      '• **New Post:** Pick an item or chest from your storage room, set the coin price, and send it directly into any channel you choose.\n' +
      '• **Edit Post:** Change the price, stock quantity, or channel of a shop message you already posted.\n' +
      '• **Buying:** Members click the Buy button on your shop message. They can also check the full shop list anytime with `/items`.'
  },
  economy: {
    title: 'HINT: Economy Stats',
    description:
      'This screen shows you all the money moving around inside your server.\n\n' +
      '• **Total Wealth:** All coins currently owned by every member combined.\n' +
      '• **Printed:** New coins given out through chatting, talking in voice channels, quests, or daily claims.\n' +
      '• **Burned:** Coins spent by members in the shop and removed from the server.\n' +
      '• **Prices:** Inspect and quickly adjust the prices of your shop items.\n' +
      '• **Time Buttons:** Click Day, Week, or Month to see how active your server economy was over time.'
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
