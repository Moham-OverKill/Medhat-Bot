import { EmbedBuilder, MessageFlags } from 'discord.js';

export const SETTINGS_HINTS = {
  coins: {
    title: 'HINT: Coins',
    description:
      'Configure how members earn currency across your server.\n\n' +
      '📅 **Daily:** Recurring currency allowance members can claim every 24 hours. Configurable streak scaling and booster multipliers encourage daily retention.\n\n' +
      '🎯 **Quests:** Activity-based challenges (messages, voice time, invites) that reward coins upon completion. Members track active tasks using `/quest`.\n\n' +
      '🏷️ **Tag:** Automatic passive coin payouts for members who add your server tag to their Discord profile.\n\n' +
      '🗳️ **Vote:** Automatic bonus coins rewarded when members vote for Medhat on Top.gg via `/vote`.\n\n' +
      '🖼️ **Appearance:** Customize the currency name and emoji across all shop posts, embeds, and member balances.\n\n' +
      '💸 **Give Coins:** Manual admin grant to distribute coins directly to any member for events or giveaways.'
  },
  items: {
    title: 'HINT: Items & Roles',
    description:
      'The central catalog for all server rewards, role cosmetics, and inventory items.\n\n' +
      '⚠️ **Setup Order:** You must create items here first before you can use them as level rewards in **Leveling** or prize drops in **Chests**.\n\n' +
      '📁 **Categories (Stack vs Swap):** Categories control how items are equipped. Use **Single (Swap)** for color roles or exclusive badges where members should only hold one active at a time. Use **Multi (Stack)** for perks that stack together.\n\n' +
      '🏷️ **Items:** Individual purchasable roles or perks. You can configure rarity, permanent or temporary durations, and required prerequisites.\n\n' +
      '📦 **Packs:** Bundle multiple created items together into a single discounted package.\n\n' +
      '📢 **Publishing:** Creating items here adds them to your server catalog. To make them purchasable in chat channels, publish them via the **Post** menu.'
  },
  chests: {
    title: 'HINT: Chests & Mystery Boxes',
    description:
      'Create randomized loot boxes that reward coins and items when unboxed.\n\n' +
      '⚠️ **Item Dependency:** Chests pull their item rewards directly from your catalog. Make sure you have created items in the **Items** menu before setting up drop tables.\n\n' +
      '➕ **Create:** Build a new chest tier, define the minimum/maximum coin prize range, and configure drop weights for each item rarity tier.\n\n' +
      '🖼️ **Appearance:** Set the chest name, closed chest icon, and animated open graphic.\n\n' +
      '📦 **Chests:** Members open their chests from `/inventory` to reveal random rewards, or trade unopened chests via `/trade`.\n\n' +
      '📢 **Distribution:** Once created, you can publish chests to shop channels via **Post**, or set them as milestone rewards in the **Leveling** system.'
  },
  post: {
    title: 'HINT: Post to Shop',
    description:
      'Publish items and chests from your catalog into Discord channels for members to buy.\n\n' +
      '⚠️ **Storefront Rule:** Items and chests created in settings are hidden until you post them to a channel.\n\n' +
      '➕ **New Post:** Select an item, pack, or chest from your catalog, set the price and stock quantity, and post it to any channel with an interactive Buy button.\n\n' +
      '📝 **Edit Post:** Update live shop messages to change prices, restock inventory, or edit descriptions without deleting the post.\n\n' +
      '🛒 **Storefront:** Members click Buy directly on the message to purchase, or browse all active posts using `/items`.'
  },
  economy: {
    title: 'HINT: Economy Stats',
    description:
      'Monitor your server’s financial health, currency flow, and inflation.\n\n' +
      '💰 **Total Server Wealth:** The combined coin balance of all member accounts in your server.\n\n' +
      '🖨️ **Printed (Faucets):** Coins generated into circulation through chat activity, voice channels, daily claims, quests, and votes.\n\n' +
      '🔥 **Burned (Sinks):** Coins permanently removed from circulation through shop purchases, chest unboxings, and trade fees.\n\n' +
      '🏷️ **Prices:** Quickly inspect and adjust prices across all active shop items to manage server inflation.\n\n' +
      '📅 **Timeframes:** Toggle between Daily, Weekly, and Monthly filters to analyze your economic net flow over time.'
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
