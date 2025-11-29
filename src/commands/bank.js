import { 
  SlashCommandBuilder, 
  EmbedBuilder, 
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  UserSelectMenuBuilder,
  MessageFlags
} from 'discord.js';
import { 
  getUserBalance, 
  claimDaily, 
  transferCoins,
  getTransactionHistory
} from '../economy/service.js';
import { getShopItems, purchaseItem } from '../economy/shop.js';
import { sanitizeError } from '../shared.js';
import { createErrorEmbed, createSuccessEmbed, createWarningEmbed, handleInteractionError } from '../utils/errors.js';
import { createBackButton, createBankButtons } from '../utils/buttons.js';
import { formatTimeRemaining, getNextDailyTime, getDailyCooldownInfo, formatDetailedTimeRemaining } from '../utils/time.js';

// Define the main bank command
export const bankCommand = new SlashCommandBuilder()
  .setName('bank')
  .setDescription('Access your OK Coins bank account')
  .setDMPermission(false);

/**
 * Main bank panel handler
 */
export async function handleBank(interaction) {
  try {
    const isButton = interaction.isButton();
    
    // Defer slash commands only if not already handled
    if (!isButton && !interaction.deferred && !interaction.replied) {
      try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      } catch (deferError) {
        // If defer fails, interaction might already be deferred
      }
    }
    
    const userId = interaction.user.id;
    const guildId = interaction.guildId;
    
    // Get user balance data
    const balanceData = await getUserBalance(userId, guildId);
    
    // Calculate time until next daily (single source of truth)
    const dailyInfo = getDailyCooldownInfo(balanceData.last_daily);
    const nextDailyText = dailyInfo.formattedTime;
    const isDailyAvailable = dailyInfo.isAvailable;
    
    // Create embed
    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('🏦 OverKill Bank')
      .setDescription(`Welcome to your personal bank account, ${interaction.user.username}!`)
      .addFields(
        { 
          name: '💰 Balance', 
          value: `**${balanceData.balance.toLocaleString()}** OK Coins`,
          inline: true 
        },
        { 
          name: '🔥 Daily Streak', 
          value: `**${balanceData.daily_streak || 0}** day${balanceData.daily_streak !== 1 ? 's' : ''}`,
          inline: true 
        },
        { 
          name: '⏰ Next Daily', 
          value: nextDailyText,
          inline: true 
        }
      )
      .setThumbnail(interaction.user.displayAvatarURL());
    
    const row = createBankButtons(isDailyAvailable);
    
    // Use update() for button interactions, editReply() for everything else
    if (isButton && !interaction.deferred) {
      await interaction.update({ embeds: [embed], components: [row] });
    } else {
      await interaction.editReply({ embeds: [embed], components: [row] });
    }
  } catch (error) {
    await handleInteractionError(interaction, error, 'bank command');
  }
}

/**
 * Handle Daily button click
 */
export async function handleDailyButton(interaction) {
  try {
    await interaction.deferUpdate();
    
    const userId = interaction.user.id;
    const guildId = interaction.guildId;
    
    // Check availability before attempting claim (button should be disabled, but double-check)
    const balanceData = await getUserBalance(userId, guildId);
    const dailyInfo = getDailyCooldownInfo(balanceData.last_daily);
    
    if (!dailyInfo.isAvailable) {
      // Button was disabled, shouldn't reach here, but handle gracefully
      return handleBank(interaction);
    }
    
    const result = await claimDaily(userId, guildId, interaction.user.username);
    
    if (!result.success) {
      if (result.error === 'daily_claimed') {
        // Shouldn't happen with button disabled, but show error if it does
        const detailedTime = result.detailedTime || 'some time';
        
        const embed = createWarningEmbed(
          'Too Early!',
          `You've already claimed your daily coins!\n\nCome back in **${detailedTime}**`
        );
        
        return interaction.editReply({ embeds: [embed], components: [createBackButton()] });
      }
      
      throw new Error(result.error);
    }
    
    // Success! Return to bank panel with updated state
    await handleBank(interaction);
  } catch (error) {
    console.error('Error in daily button:', sanitizeError(error));
    const embed = createErrorEmbed('Error', 'Failed to claim daily reward. Please try again later.');
    await interaction.editReply({ embeds: [embed], components: [createBackButton()] });
  }
}

/**
 * Handle Transfer button click - Show user select menu
 */
export async function handleTransferButton(interaction) {
  try {
    const userSelect = new UserSelectMenuBuilder()
      .setCustomId('bank_transfer_select_user')
      .setPlaceholder('Select a member to transfer coins to')
      .setMinValues(1)
      .setMaxValues(1);
    
    const row = new ActionRowBuilder().addComponents(userSelect);
    
    const backButton = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('bank_back')
          .setLabel('Back')
          .setEmoji('◀️')
          .setStyle(ButtonStyle.Secondary)
      );
    
    const embed = new EmbedBuilder()
      .setColor('#9B59B6')
      .setTitle('💸 Transfer OK Coins')
      .setDescription('Select a member from the dropdown below to transfer coins to them.');
    
    await interaction.update({ embeds: [embed], components: [row, backButton] });
  } catch (error) {
    console.error('Error showing transfer user select:', sanitizeError(error));
  }
}

/**
 * Handle user selection for transfer
 */
export async function handleTransferUserSelect(interaction) {
  try {
    const selectedUserId = interaction.values[0];
    
    // Show modal with just amount input
    const modal = new ModalBuilder()
      .setCustomId(`bank_transfer_modal_${selectedUserId}`)
      .setTitle('Transfer OK Coins');
    
    const amountInput = new TextInputBuilder()
      .setCustomId('transfer_amount')
      .setLabel('Amount to transfer')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('Enter amount (e.g., 100)')
      .setRequired(true)
      .setMinLength(1)
      .setMaxLength(10);
    
    const row = new ActionRowBuilder().addComponents(amountInput);
    modal.addComponents(row);
    
    await interaction.showModal(modal);
  } catch (error) {
    console.error('Error showing transfer modal:', sanitizeError(error));
  }
}

/**
 * Handle Transfer modal submission
 */
export async function handleTransferModal(interaction) {
  try {
    await interaction.deferUpdate();
    
    // Extract receiver ID from modal custom ID
    const receiverUserId = interaction.customId.replace('bank_transfer_modal_', '');
    
    const amountStr = interaction.fields.getTextInputValue('transfer_amount');
    
    // Parse amount
    const amount = parseInt(amountStr);
    if (isNaN(amount) || amount <= 0) {
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Invalid Amount')
        .setDescription('Please enter a valid positive number.');
      
      const backButton = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId('bank_back')
            .setLabel('Back')
            .setEmoji('◀️')
            .setStyle(ButtonStyle.Secondary)
        );
      
      return interaction.editReply({ embeds: [embed], components: [backButton] });
    }
    
    // Fetch receiver user
    let receiverUser = null;
    try {
      receiverUser = await interaction.client.users.fetch(receiverUserId);
    } catch (e) {
      // User not found
    }
    
    if (!receiverUser) {
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ User Not Found')
        .setDescription('Could not find a user with that username or ID.\n\nTry using their exact username or mentioning them.');
      
      const backButton = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId('bank_back')
            .setLabel('Back')
            .setEmoji('◀️')
            .setStyle(ButtonStyle.Secondary)
        );
      
      return interaction.editReply({ embeds: [embed], components: [backButton] });
    }
    
    // Validate receiver
    if (receiverUser.bot) {
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Invalid Receiver')
        .setDescription('You cannot transfer coins to bots!');
      
      const backButton = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId('bank_back')
            .setLabel('Back')
            .setEmoji('◀️')
            .setStyle(ButtonStyle.Secondary)
        );
      
      return interaction.editReply({ embeds: [embed], components: [backButton] });
    }
    
    if (receiverUser.id === interaction.user.id) {
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Invalid Receiver')
        .setDescription('You cannot transfer coins to yourself!');
      
      const backButton = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId('bank_back')
            .setLabel('Back')
            .setEmoji('◀️')
            .setStyle(ButtonStyle.Secondary)
        );
      
      return interaction.editReply({ embeds: [embed], components: [backButton] });
    }
    
    // Perform transfer
    const result = await transferCoins(
      interaction.user.id, 
      receiverUser.id, 
      interaction.guild, 
      amount,
      interaction.user.username,
      receiverUser.username
    );
    
    if (!result.success) {
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Transfer Failed')
        .setDescription(
          result.error === 'Insufficient balance' 
            ? `You don't have enough OK Coins! You need **${amount.toLocaleString()}** coins.`
            : 'Transfer failed. Please try again later.'
        );
      
      const backButton = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId('bank_back')
            .setLabel('Back')
            .setEmoji('◀️')
            .setStyle(ButtonStyle.Secondary)
        );
      
      return interaction.editReply({ embeds: [embed], components: [backButton] });
    }
    
    // Success!
    const embed = new EmbedBuilder()
      .setColor('#00FF00')
      .setTitle('✅ Transfer Successful')
      .setDescription(`You sent **${amount.toLocaleString()} OK Coins** to ${receiverUser.username}`)
      .addFields(
        { 
          name: '💰 Your New Balance', 
          value: `**${result.senderBalance.toLocaleString()}** OK Coins`,
          inline: true 
        },
        { 
          name: `${receiverUser.username}'s New Balance`, 
          value: `**${result.receiverBalance.toLocaleString()}** OK Coins`,
          inline: true 
        }
      );
    
    const backButton = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('bank_back')
          .setLabel('Back to Bank')
          .setEmoji('◀️')
          .setStyle(ButtonStyle.Secondary)
      );
    
    await interaction.editReply({ embeds: [embed], components: [backButton] });
  } catch (error) {
    console.error('Error in transfer modal:', sanitizeError(error));
    
    const embed = new EmbedBuilder()
      .setColor('#FF0000')
      .setTitle('❌ Error')
      .setDescription('Failed to process transfer. Please try again later.');
    
    const backButton = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('bank_back')
          .setLabel('Back')
          .setEmoji('◀️')
          .setStyle(ButtonStyle.Secondary)
      );
    
    await interaction.editReply({ embeds: [embed], components: [backButton] });
  }
}

/**
 * Handle Shop button click
 */
export async function handleShopButton(interaction) {
  try {
    await interaction.deferUpdate();
    
    const guildId = interaction.guildId;
    const userId = interaction.user.id;
    const shopItems = await getShopItems(guildId);
    
    if (shopItems.length === 0) {
      const embed = new EmbedBuilder()
        .setColor('#FFA500')
        .setTitle('🏪 Shop')
        .setDescription('The shop is empty! Ask an admin to add some items using `/shop setup`.');
      
      const backButton = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId('bank_back')
            .setLabel('Back')
            .setEmoji('◀️')
            .setStyle(ButtonStyle.Secondary)
        );
      
      return interaction.editReply({ embeds: [embed], components: [backButton] });
    }
    
    // Get user balance
    const balanceData = await getUserBalance(userId, guildId);
    
    let description = `**Your Balance:** ${balanceData.balance.toLocaleString()} OK Coins\n\n`;
    
    for (let i = 0; i < Math.min(shopItems.length, 10); i++) {
      const item = shopItems[i];
      const role = await interaction.guild.roles.fetch(item.role_id).catch(() => null);
      const roleName = role ? role.name : 'Unknown Role';
      
      description += `**${i + 1}.** ${item.name}\n`;
      description += `💰 ${item.price.toLocaleString()} coins | 🎭 ${roleName}\n`;
      
      if (item.description) {
        description += `📝 ${item.description}\n`;
      }
      
      if (item.duration_hours) {
        const days = Math.floor(item.duration_hours / 24);
        description += `⏰ Duration: ${days > 0 ? `${days}d` : `${item.duration_hours}h`}\n`;
      }
      
      description += '\n';
    }
    
    const embed = new EmbedBuilder()
      .setColor('#9B59B6')
      .setTitle('🏪 OverKill Shop')
      .setDescription(description);
    
    // Create buy buttons (max 5 per row, max 25 total)
    const rows = [];
    for (let i = 0; i < Math.min(shopItems.length, 25); i += 5) {
      const row = new ActionRowBuilder();
      for (let j = i; j < Math.min(i + 5, shopItems.length); j++) {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`shop_buy_${shopItems[j].id}`)
            .setLabel(`Buy #${j + 1}`)
            .setStyle(ButtonStyle.Success)
        );
      }
      rows.push(row);
    }
    
    // Add back button
    const backRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('bank_back')
          .setLabel('Back to Bank')
          .setEmoji('◀️')
          .setStyle(ButtonStyle.Secondary)
      );
    rows.push(backRow);
    
    await interaction.editReply({ embeds: [embed], components: rows });
  } catch (error) {
    console.error('Error in shop button:', sanitizeError(error));
    
    const embed = new EmbedBuilder()
      .setColor('#FF0000')
      .setTitle('❌ Error')
      .setDescription('Failed to load shop. Please try again later.');
    
    const backButton = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('bank_back')
          .setLabel('Back')
          .setEmoji('◀️')
          .setStyle(ButtonStyle.Secondary)
      );
    
    await interaction.editReply({ embeds: [embed], components: [backButton] });
  }
}

/**
 * Handle shop item purchase
 */
export async function handleShopPurchase(interaction, itemId) {
  try {
    await interaction.deferUpdate();
    
    const userId = interaction.user.id;
    const guildId = interaction.guildId;
    const member = await interaction.guild.members.fetch(userId);
    
    const result = await purchaseItem(userId, guildId, itemId, member);
    
    if (!result.success) {
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Purchase Failed')
        .setDescription(
          result.error === 'Insufficient balance'
            ? 'You don\'t have enough OK Coins for this item!'
            : result.error === 'You already own this item'
            ? 'You already own this item!'
            : result.error === 'Item out of stock'
            ? 'This item is out of stock!'
            : result.error || 'Purchase failed. Please try again later.'
        );
      
      const backButton = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId('bank_shop')
            .setLabel('Back to Shop')
            .setEmoji('◀️')
            .setStyle(ButtonStyle.Secondary)
        );
      
      return interaction.editReply({ embeds: [embed], components: [backButton] });
    }
    
    const role = await interaction.guild.roles.fetch(result.item.role_id).catch(() => null);
    const roleName = role ? role.name : 'Unknown Role';
    
    const embed = new EmbedBuilder()
      .setColor('#00FF00')
      .setTitle('✅ Purchase Successful!')
      .setDescription(`You purchased **${result.item.name}**!`)
      .addFields(
        { 
          name: '💰 Price Paid', 
          value: `**${result.item.price.toLocaleString()}** OK Coins`,
          inline: true 
        },
        { 
          name: '💰 New Balance', 
          value: `**${result.newBalance.toLocaleString()}** OK Coins`,
          inline: true 
        },
        {
          name: '🎭 Role Granted',
          value: roleName,
          inline: false
        }
      );
    
    if (result.expiresAt) {
      const expiryTimestamp = Math.floor(result.expiresAt.getTime() / 1000);
      embed.addFields({
        name: '⏰ Expires',
        value: `<t:${expiryTimestamp}:R>`,
        inline: false
      });
    }
    
    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('bank_shop')
          .setLabel('Back to Shop')
          .setEmoji('🏪')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('bank_back')
          .setLabel('Back to Bank')
          .setEmoji('◀️')
          .setStyle(ButtonStyle.Secondary)
      );
    
    await interaction.editReply({ embeds: [embed], components: [row] });
  } catch (error) {
    console.error('Error in shop purchase:', sanitizeError(error));
    
    const embed = new EmbedBuilder()
      .setColor('#FF0000')
      .setTitle('❌ Error')
      .setDescription('Failed to complete purchase. Please try again later.');
    
    const backButton = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('bank_shop')
          .setLabel('Back to Shop')
          .setEmoji('◀️')
          .setStyle(ButtonStyle.Secondary)
      );
    
    await interaction.editReply({ embeds: [embed], components: [backButton] });
  }
}

/**
 * Handle History button click
 */
export async function handleHistoryButton(interaction) {
  try {
    await interaction.deferUpdate();
    
    const userId = interaction.user.id;
    const guildId = interaction.guildId;
    
    const history = await getTransactionHistory(userId, guildId, 15);
    
    if (history.length === 0) {
      const embed = new EmbedBuilder()
        .setColor('#FFA500')
        .setTitle('Transaction History')
        .setDescription('No transactions yet. Start by claiming your daily reward!');
      
      const backButton = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId('bank_back')
            .setLabel('Back')
            .setEmoji('◀️')
            .setStyle(ButtonStyle.Secondary)
        );
      
      return interaction.editReply({ embeds: [embed], components: [backButton] });
    }
    
    const lines = [];
    for (const tx of history) {
      const timestamp = Math.floor(new Date(tx.created_at).getTime() / 1000);
      const amount = Math.abs(tx.amount).toLocaleString();
      let entry = '';
      
      switch (tx.type) {
        case 'daily':
          entry = `<t:${timestamp}:R> - got a daily of ${amount} coins`;
          break;
        case 'purchase': {
          const itemName = tx.description?.replace(/^Purchased:\s*/i, '') || 'an item';
          entry = `<t:${timestamp}:R> - bought ${itemName} for ${amount} coins`;
          break;
        }
        case 'transfer_out': {
          const targetName = await resolveUserName(interaction.guild, tx.reference_id);
          entry = `<t:${timestamp}:R> - transferred ${amount} coins to ${targetName}`;
          break;
        }
        case 'transfer_in': {
          const sourceName = await resolveUserName(interaction.guild, tx.reference_id);
          entry = `<t:${timestamp}:R> - received ${amount} coins from ${sourceName}`;
          break;
        }
        case 'mvp_bonus':
          entry = `<t:${timestamp}:R> - received ${amount} coins (MVP BONUS)`;
          break;
        case 'boost_bonus':
          entry = `<t:${timestamp}:R> - received ${amount} coins (BOOST BONUS)`;
          break;
        default: {
          const verb = tx.amount >= 0 ? 'received' : 'spent';
          entry = `<t:${timestamp}:R> - ${verb} ${amount} coins (${tx.type})`;
          break;
        }
      }
      
      lines.push(entry);
    }
    
    const embed = new EmbedBuilder()
      .setColor('#3498DB')
      .setTitle('Transaction History')
      .setDescription(lines.join('\n'));

    const backButton = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('bank_back')
          .setLabel('Back to Bank')
          .setEmoji('◀️')
          .setStyle(ButtonStyle.Secondary)
      );
    
    await interaction.editReply({ embeds: [embed], components: [backButton] });
  } catch (error) {
    console.error('Error in history button:', sanitizeError(error));
    
    const embed = new EmbedBuilder()
      .setColor('#FF0000')
      .setTitle('❌ Error')
      .setDescription('Failed to load transaction history. Please try again later.');
    
    const backButton = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('bank_back')
          .setLabel('Back')
          .setEmoji('◀️')
          .setStyle(ButtonStyle.Secondary)
      );
    
    await interaction.editReply({ embeds: [embed], components: [backButton] });
  }
}

/**
 * Get user-friendly label for transaction type
 */
async function resolveUserName(guild, userId) {
  if (!userId) return 'unknown user';
  try {
    const member = await guild.members.fetch(userId);
    if (member?.nickname) {
      return member.nickname;
    }
    return member?.user?.tag || member?.user?.username || `user ${userId}`;
  } catch (_) {
    try {
      const user = await guild.client.users.fetch(userId);
      return user?.tag || user?.username || `user ${userId}`;
    } catch (error) {
      return `user ${userId}`;
    }
  }
}

/**
 * Handle Back button - return to main bank panel
 */
export async function handleBackButton(interaction) {
  // Simply re-run the main bank command
  await handleBank(interaction);
}
