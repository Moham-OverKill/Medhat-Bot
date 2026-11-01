import { EmbedBuilder, MessageFlags } from 'discord.js';
import { getLootBoxCategoryName, getLootBoxCategoryEmoji } from '../../economy/lootbox.js';
import { getCurrencyName, getCurrencyEmoji } from '../../shared.js';

export function getSettingsHint(pageKey, lootBoxName = 'Chests', lootBoxEmoji = '🎁', coinName = 'Coins', coinEmoji = '🪙') {
  const boxTag = `**[${lootBoxEmoji} ${lootBoxName}]**`;
  const hints = {
    coins: {
      title: `HINT: ${coinName}`,
      description:
        `Choose how members get ${coinName.toLowerCase()} in your server.\n\n` +
        `📅 **Daily:** Free ${coinName.toLowerCase()} members can claim every day. Claiming multiple days in a row gives bigger streak bonuses.\n\n` +
        `🎯 **Quests:** Simple tasks (like chatting or voice) that give ${coinName.toLowerCase()} when finished. Members check tasks with \`/quest\`.\n\n` +
        `🏷️ **Tag:** Gives daily ${coinName.toLowerCase()} to members who put your server tag on their profile.\n\n` +
        `🗳️ **Vote:** Gives daily ${coinName.toLowerCase()} to members who vote for Medhat on Top.gg using \`/vote\`.\n\n` +
        `🖼️ **Appearance:** Change the ${coinName.toLowerCase()} name and emoji for your server.\n\n` +
        `💸 **Give ${coinName}:** Give free ${coinName.toLowerCase()} to any member right now.`
    },
    items: {
      title: 'HINT: Items',
      description:
        'This is where all your server items are stored and managed.\n\n' +
        `⚠️ **Create First:** It is recommended to create items here before setting up other features. You can then add items as level rewards or XP boosters in **[⭐ Levels]**, or as prizes inside ${boxTag}.\n\n` +
        '🏷️ **Item Roles:** When you create an item, a Discord role is created and attached to it. When members equip an item using `/inventory`, they get that role. If they unequip, drop, sell, or trade the item, the role is removed automatically, unless they still own more copies of the item.\n\n' +
        `⚙️ **Config:** You can make an item Untradable if you want it to be exclusive so it cannot be traded or won in ${boxTag}. You can also set a Duration (like 7 days or 30 days) for temporary items, such as XP boost items or VIP.\n\n` +
        '📁 **Categories:** Organize your items and control how roles behave:\n' +
        '• **Single (Swap):** Equipping an item removes the previous one. Best for Colors or Role Icons so roles switch smoothly without clashing or overwriting each other.\n' +
        '• **Multi (Stack):** Members can equip and wear multiple items from this category at the same time.\n\n' +
        '📦 **Packs:** Bundle multiple items together into one package so members can buy everything in one click. Great for special offers, limited-time sales, and discounts.\n\n' +
        "🗑️ **Editing & Deleting:** You can edit any item anytime (change name, image, or see who holds it). When deleting an item, it will be removed from everyone's inventory and the role will be removed from all users. You can choose to keep the role or delete it with the item when confirming the deletion.\n\n" +
        `✅ **What's Next?:** Creating items here adds them to your storage, but members cannot buy them yet. Go to **[📢 Post]** to post items in channels for members to buy, add them as level rewards in **[⭐ Levels]**, or set them to "tradable" so they can be found in ${boxTag}.`
    },
    chests: {
      title: `HINT: ${lootBoxName}`,
      description:
        `Create ${lootBoxName.toLowerCase()} that give random rewards and ${coinName.toLowerCase()} when opened.\n\n` +
        `⚠️ **Note:** Items must be created in **[🏷️ Items]** first and set to \`Tradable\`\n` +
        `so they can be won as prizes here.\n\n` +
        `⚙️ **Config:** Set min and max ${coinName.toLowerCase()} rewards, and drop chances for each item rarity.\n\n` +
        `🖼️ **Appearance:** Customize what ${lootBoxName.toLowerCase()} are called and their emoji.\n` +
        `You can also set custom closed and opened images for each one.\n\n` +
        `✏️ **Edit:** Select from the menu above anytime to edit it later.\n\n` +
        `📦 **Opening:** Members open their ${lootBoxName.toLowerCase()} in \`/inventory\`\n` +
        `or trade them with \`/trade\`.\n\n` +
        `✅ **What's Next?:** Go to **[📢 Post]** to sell ${lootBoxName.toLowerCase()}\n` +
        `or add them as level rewards in **[⭐ Levels]**.`
    },
    post: {
      title: 'HINT: Post',
      description:
        `Put items, packs, and ${lootBoxName.toLowerCase()} into chat channels so members can buy them.\n\n` +
        `⚠️ **Note:** Anything created in **[🏷️ Items]** or ${boxTag} stays in storage until you post it to a channel here.\n\n` +
        `✝️ **New Post:** Pick an item, pack, or ${lootBoxName.toLowerCase()}, select the channel, set the price and stock, and publish it into chat.\n\n` +
        `⚙️ **Config:** Set price, stock, restock timer, and per-user limits. You can make free items with timers (like a daily free ${lootBoxName.toLowerCase()}) or limit purchases per member.\n\n` +
        '📝 **Edit Post:** Paste the message link of any shop post you already made to edit it.\n\n' +
        '🛒 **Buying:** Members click the Buy button directly on the post in chat. They can also use `/items` to browse everything currently available in your shop.'
    },
    economy: {
      title: 'HINT: Economy',
      description:
        `Track and monitor all ${coinName.toLowerCase()} moving across your server.\n\n` +
        `💰 **Total Wealth:** The total sum of all ${coinName.toLowerCase()} currently held by all members in your server combined.\n\n` +
        `🖨️ **Printed (New ${coinName}):** ${coinName} created and given out from chatting in text channels, spending time in voice, daily claims, quests, and votes.\n\n` +
        `🔥 **Burned (Spent ${coinName}):** ${coinName} removed from the server when members buy shop items, purchase ${lootBoxName.toLowerCase()}, or pay trade taxes.\n\n` +
        `🏷️ **Prices:** View and adjust the ${coinName.toLowerCase()} prices across all your shop items in one place.\n\n` +
        '📅 **Time Filters:** Click **Per Day**, **Per Week**, or **Per Month** to see your server economy stats over different time periods.'
    }
  };

  return hints[pageKey] || null;
}

export const SETTINGS_HINTS = new Proxy({}, {
  get: (_, key) => getSettingsHint(key)
});

/**
 * Handle clicking a settings hint button
 * @param {import('discord.js').ButtonInteraction} interaction
 */
export async function handleSettingsHint(interaction) {
  const parts = interaction.customId.split('_');
  const pageKey = parts[2]; // e.g. 'coins', 'items', 'chests', 'post', 'economy'
  const [lootBoxName, lootBoxEmoji, coinName, coinEmoji] = await Promise.all([
    getLootBoxCategoryName(interaction.guildId).catch(() => 'Chests'),
    getLootBoxCategoryEmoji(interaction.guildId).catch(() => '🎁'),
    getCurrencyName(interaction.guildId).catch(() => 'Coins'),
    getCurrencyEmoji(interaction.guildId).catch(() => '🪙')
  ]);
  const hint = getSettingsHint(pageKey, lootBoxName, lootBoxEmoji, coinName, coinEmoji);

  if (!hint) {
    const payload = {
      content: 'No hint available for this page.',
      flags: MessageFlags.Ephemeral
    };
    return (interaction.deferred || interaction.replied)
      ? interaction.followUp(payload)
      : interaction.reply(payload);
  }

  const embed = new EmbedBuilder()
    .setTitle(hint.title)
    .setDescription(hint.description)
    .setColor(0xF1C40F);

  const payload = {
    embeds: [embed],
    flags: MessageFlags.Ephemeral
  };

  return (interaction.deferred || interaction.replied)
    ? interaction.followUp(payload)
    : interaction.reply(payload);
}
