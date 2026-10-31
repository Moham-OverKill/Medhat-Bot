import { EmbedBuilder, MessageFlags } from 'discord.js';

export const SETTINGS_HINTS = {
  coins: {
    title: 'HINT: Coins',
    description: 
      'This is where you give your server members coins when they are active.\n\n' +
      '• **Daily:** Members can type `/daily` to get free coins every day.\n' +
      '• **Quests:** Simple missions members can do to win coins.\n' +
      '• **Tag:** Free coins given to members who add your server name in their Discord profile status.\n' +
      '• **Vote:** Free coins given when members vote for your server online.\n' +
      '• **Appearance:** Change what coins look like and what they are called in your server.\n' +
      '• **Give Coins:** Instantly give free coins to any member right now.'
  },
  items: {
    title: 'HINT: Items & Roles',
    description:
      'This is your storage room where you create things for members to buy.\n\n' +
      '• **Categories:** Folders to keep your items organized (example: Colors, Special Roles).\n' +
      '• **Items:** Things people can buy (usually Discord roles that give colors or cool names).\n' +
      '• **Packs:** A bundle box that gives more than one item together in one purchase.\n\n' +
      '💡 *Note:* Creating an item here puts it in your storage room. To actually put it in a channel for people to buy, go to the **Post** page next!'
  },
  chests: {
    title: 'HINT: Chests & Mystery Boxes',
    description:
      'Mystery surprise boxes that give random coins or items when members open them.\n\n' +
      '• **Create:** Make a new mystery box and choose what prizes are hidden inside.\n' +
      '• **Appearance:** Change what the chest looks like and what it is called.\n' +
      '• Members can open chests they buy or win to get surprise rewards!'
  },
  post: {
    title: 'HINT: Post to Shop',
    description:
      'This is where you display your items inside a channel so members can see and buy them.\n\n' +
      '• **New Post:** Pick an item or chest from your storage room, set a price on it, and send it to any channel you want.\n' +
      '• **Edit Post:** Change the price, stock, or channel of a shop message you already sent before.'
  },
  economy: {
    title: 'HINT: Economy Stats',
    description:
      'This screen shows you all the money moving around inside your server.\n\n' +
      '• **Total Wealth:** All coins owned by every member in your server added together.\n' +
      '• **Printed:** New coins created and given to members.\n' +
      '• **Burned:** Coins spent by members in the shop and removed from the server.\n' +
      '• **Time Buttons:** Click Per Day, Per Week, or Per Month to see stats across different times.\n' +
      '• **Prices:** Change or inspect item prices quickly.'
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
