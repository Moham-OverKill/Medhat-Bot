import { 
  SlashCommandBuilder, 
  EmbedBuilder, 
  ActionRowBuilder, 
  StringSelectMenuBuilder, 
  ButtonBuilder,
  ButtonStyle,
  MessageFlags, 
  PermissionFlagsBits 
} from 'discord.js';
import { handleInteractionError } from '../utils/errors.js';

export const helpCommand = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Display the help menu and guides');

export async function handleHelpCommand(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.reply({ content: 'Working on it . . .', flags: MessageFlags.Ephemeral });
    } else {
      await interaction.editReply({ files: [], content: 'Working on it . . .', embeds: [], components: [] });
    }
  } catch (error) {
    await handleInteractionError(interaction, error, 'help command');
  }
}

/**
 * Component handler for selecting a help topic from the dropdown menu
 */
export async function handleHelpSelect(interaction) {
  try {
    const selectedTopic = interaction.values[0];

    const topicTitles = {
      help_admin_colors: 'Making a colors reaction list',
      help_admin_shop: 'Adding Items to the Shop',
      help_admin_coins: 'Managing Coins and Income',
      help_admin_users: 'Managing users',
      help_admin_customizing: 'Customizing the bot',
      help_admin_leaderboards: 'Setting Top Roles and Leaderboards',
      help_admin_quests: 'Setting Quest',
      help_user_coins: 'Getting Coins',
      help_user_inventory: 'Using Inventory',
      help_user_trading: 'Trading with others'
    };

    const title = topicTitles[selectedTopic] || 'Help Topic';

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(`*(Step-by-step guide for **${title}** will be detailed here)*\n\nUse the numbered buttons below to navigate through the guide steps.`)
      .setColor('#3498DB')
      .setFooter({ text: 'Step 1' });

    // Step navigation buttons placeholders (1, 2, 3, etc.)
    const btn1 = new ButtonBuilder()
      .setCustomId(`help_step_${selectedTopic}_1`)
      .setLabel('1')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(true);

    const btn2 = new ButtonBuilder()
      .setCustomId(`help_step_${selectedTopic}_2`)
      .setLabel('2')
      .setStyle(ButtonStyle.Secondary);

    const btn3 = new ButtonBuilder()
      .setCustomId(`help_step_${selectedTopic}_3`)
      .setLabel('3')
      .setStyle(ButtonStyle.Secondary);

    const backBtn = new ButtonBuilder()
      .setCustomId('help_back_to_menu')
      .setLabel('Main Menu')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary);

    const navRow = new ActionRowBuilder().addComponents(backBtn, btn1, btn2, btn3);

    await interaction.update({
      embeds: [embed],
      components: [navRow]
    });
  } catch (error) {
    await handleInteractionError(interaction, error, 'help select');
  }
}

/**
 * Component handler for navigating between help steps or returning to main help menu
 */
export async function handleHelpStepNavigation(interaction) {
  try {
    const customId = interaction.customId;

    if (customId === 'help_back_to_menu') {
      // Re-render main help menu
      return handleHelpCommand(interaction);
    }

    // Step button click placeholder
    const parts = customId.split('_'); // help_step_<topic>_<stepNum>
    const stepNum = parts.pop();
    const topicKey = parts.slice(2).join('_');

    const topicTitles = {
      help_admin_colors: 'Making a colors reaction list',
      help_admin_shop: 'Adding Items to the Shop',
      help_admin_coins: 'Managing Coins and Income',
      help_admin_users: 'Managing users',
      help_admin_customizing: 'Customizing the bot',
      help_admin_leaderboards: 'Setting Top Roles and Leaderboards',
      help_admin_quests: 'Setting Quest',
      help_user_coins: 'Getting Coins',
      help_user_inventory: 'Using Inventory',
      help_user_trading: 'Trading with others'
    };

    const title = topicTitles[topicKey] || 'Help Topic';

    const embed = new EmbedBuilder()
      .setTitle(`${title} — Step ${stepNum}`)
      .setDescription(`*(Content for **Step ${stepNum}** of ${title} will be placed here)*`)
      .setColor('#3498DB')
      .setFooter({ text: `Step ${stepNum} of 3` });

    const btn1 = new ButtonBuilder()
      .setCustomId(`help_step_${topicKey}_1`)
      .setLabel('1')
      .setStyle(stepNum === '1' ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(stepNum === '1');

    const btn2 = new ButtonBuilder()
      .setCustomId(`help_step_${topicKey}_2`)
      .setLabel('2')
      .setStyle(stepNum === '2' ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(stepNum === '2');

    const btn3 = new ButtonBuilder()
      .setCustomId(`help_step_${topicKey}_3`)
      .setLabel('3')
      .setStyle(stepNum === '3' ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(stepNum === '3');

    const backBtn = new ButtonBuilder()
      .setCustomId('help_back_to_menu')
      .setLabel('Main Menu')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary);

    const navRow = new ActionRowBuilder().addComponents(backBtn, btn1, btn2, btn3);

    await interaction.update({
      embeds: [embed],
      components: [navRow]
    });
  } catch (error) {
    await handleInteractionError(interaction, error, 'help step navigation');
  }
}
