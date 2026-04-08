import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  MessageFlags
} from 'discord.js';
import { getGuildConfig, setGuildConfig } from '../storage/config.js';
import { updateBalance } from '../economy/service.js';
import { sendLog } from '../utils/logger.js';
import { getUserDisplayName, getUserLogName, sanitizeError, COIN_EMOJI } from '../shared.js';

export const rewardsCommand = new SlashCommandBuilder()
  .setName('rewards')
  .setDescription('Manage server rewards')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(sub =>
    sub.setName('setup')
      .setDescription('Configure reward settings')
  );

export async function handleRewardsCommand(interaction) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({ content: '❌ Administrator permission required.', flags: MessageFlags.Ephemeral });
  }

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'setup') {
    await handleRewardsSetup(interaction);
  }
}

async function getRewardsPayload(guildId) {
  const config = await getGuildConfig(guildId) || {};

  const mvpReward = config.mvpRewardAmount !== undefined ? config.mvpRewardAmount : 100;
  const boosterMult = config.booster_multiplier !== undefined ? config.booster_multiplier : 2;
  const streakBonus = config.daily_streak_bonus !== undefined ? config.daily_streak_bonus : 5;

  const mvpText = mvpReward > 0 ? `${mvpReward} coins` : 'Disabled (0 coins)';
  const boosterText = boosterMult > 1 ? `${boosterMult}x` : 'Disabled (1x)';
  const streakText = streakBonus > 0 ? `${streakBonus} coins/day` : 'Disabled (0 coins/day)';

  const embed = new EmbedBuilder()
    .setTitle('💰 Rewards Configuration')
    .setColor('#F1C40F')
    .setDescription('Configure the automated rewards for your server.')
    .addFields(
      { name: '🏆 MVP Reward', value: mvpText, inline: true },
      { name: '🚀 Boost Multiplier', value: boosterText, inline: true },
      { name: '🔥 Streak Bonus', value: streakText, inline: true }
    );

  // Row 1: MVP, Booster, Streak
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('rewards_mvp_btn').setLabel('MVP Reward').setStyle(ButtonStyle.Primary).setEmoji('🏆'),
    new ButtonBuilder().setCustomId('rewards_booster_btn').setLabel('Boost Multiplier').setStyle(ButtonStyle.Primary).setEmoji('🚀'),
    new ButtonBuilder().setCustomId('rewards_streak_btn').setLabel('Streak Bonus').setStyle(ButtonStyle.Primary).setEmoji('🔥')
  );

  // Row 2: Missions, Give Coins
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('missions_dashboard').setLabel('Missions').setStyle(ButtonStyle.Secondary).setEmoji('🎯'),
    new ButtonBuilder().setCustomId('rewards_give_btn').setLabel('Give Coins').setStyle(ButtonStyle.Success).setEmoji('💸')
  );

  // Row 3: Back Button
  const rowBack = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('settings_back').setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row1, row2, rowBack] };
}

export async function handleRewardsSetup(interaction) {
  try {
    const payload = await getRewardsPayload(interaction.guildId);

    // Handle different interaction states
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload);
    } else {
      await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    }
  } catch (error) {
    console.error('Rewards setup error:', error);
    const reply = { content: '❌ An error occurred loading rewards setup.', flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) await interaction.followUp(reply);
    else await interaction.reply(reply);
  }
}

export async function handleRewardsComponent(interaction) {
  const customId = interaction.customId;
  const guildId = interaction.guildId;

  if (customId === 'rewards_home') {
    const payload = await getRewardsPayload(guildId);
    // Ensure we clear any previous content (like "Select user...")
    await interaction.editReply({
      content: null,
      embeds: payload.embeds,
      components: payload.components
    });
    return;
  }

  // MODALS
  if (customId === 'rewards_mvp_btn') {
    const config = await getGuildConfig(guildId) || {};
    const modal = new ModalBuilder().setCustomId('rewards_mvp_modal').setTitle('MVP Reward Settings');
    const input = new TextInputBuilder()
      .setCustomId('amount')
      .setLabel('Amount')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('100')
      .setValue(String(config.mvpRewardAmount || 0))
      .setRequired(false);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
  }
  else if (customId === 'rewards_booster_btn') {
    const config = await getGuildConfig(guildId) || {};
    const modal = new ModalBuilder().setCustomId('rewards_booster_modal').setTitle('Booster Multiplier');
    const input = new TextInputBuilder()
      .setCustomId('multiplier')
      .setLabel('Amount')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('2')
      .setValue(String(config.booster_multiplier || 0))
      .setRequired(false);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
  }
  else if (customId === 'rewards_streak_btn') {
    const config = await getGuildConfig(guildId) || {};
    const modal = new ModalBuilder().setCustomId('rewards_streak_modal').setTitle('Daily Streak Bonus');
    const input = new TextInputBuilder()
      .setCustomId('amount')
      .setLabel('Amount')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('5')
      .setValue(String(config.daily_streak_bonus || 0))
      .setRequired(false);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
  }
  else if (customId === 'rewards_give_btn') {
    await interaction.deferUpdate();
    const userSelect = new UserSelectMenuBuilder()
      .setCustomId('rewards_give_select')
      .setPlaceholder('Select user to give coins to')
      .setMinValues(1)
      .setMaxValues(1);

    const row = new ActionRowBuilder().addComponents(userSelect);
    const backRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('rewards_home').setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary)
    );

    await interaction.editReply({ content: 'Select a user to give coins to:', embeds: [], components: [row, backRow] });
  }
  else if (customId === 'rewards_give_select') {
    const targetUserId = interaction.values[0];
    const modal = new ModalBuilder().setCustomId(`rewards_give_modal_${targetUserId}`).setTitle('Give Coins');
    const input = new TextInputBuilder()
      .setCustomId('amount')
      .setLabel('Amount')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('1-9999')
      .setRequired(true);
    const reasonInput = new TextInputBuilder()
      .setCustomId('reason')
      .setLabel('Reason (Optional)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('for winning the event')
      .setRequired(false);

    modal.addComponents(new ActionRowBuilder().addComponents(input), new ActionRowBuilder().addComponents(reasonInput));
    await interaction.showModal(modal);
  }
}

export async function handleRewardsModal(interaction) {
  const customId = interaction.customId;
  const guildId = interaction.guildId;
  const config = await getGuildConfig(guildId) || {};

  if (customId === 'rewards_mvp_modal') {
    const inputVal = interaction.fields.getTextInputValue('amount');
    const amount = inputVal ? parseInt(inputVal, 10) : 0;

    if (inputVal && (isNaN(amount) || amount < 0)) {
      return interaction.reply({ content: '❌ Invalid amount.', flags: MessageFlags.Ephemeral });
    }
    config.mvpRewardAmount = amount;
    await setGuildConfig(guildId, config);

    // Standard Audit Log
    const logName = getUserLogName(interaction);
    sendLog(interaction.guild, 'audit', 'cyan', '⚙️ Reward Config Changed', 
        `**Admin:** \`${logName}\`\n` +
        `**Setting:** MVP Reward Amount\n` +
        `**New Value:** \`${amount.toLocaleString()}\` ${COIN_EMOJI}`
    );

    const payload = await getRewardsPayload(interaction.guildId);
    await interaction.update(payload);
  }
  else if (customId === 'rewards_booster_modal') {
    const inputVal = interaction.fields.getTextInputValue('multiplier');
    const mult = inputVal ? parseFloat(inputVal) : 0;

    if (inputVal && (isNaN(mult) || mult < 0)) {
      return interaction.reply({ content: '❌ Invalid multiplier. Must be >= 0.', flags: MessageFlags.Ephemeral });
    }
    config.booster_multiplier = mult;
    await setGuildConfig(guildId, config);

    // Standard Audit Log
    const logName = getUserLogName(interaction);
    sendLog(interaction.guild, 'audit', 'cyan', '⚙️ Reward Config Changed', 
        `**Admin:** \`${logName}\`\n` +
        `**Setting:** Booster Multiplier\n` +
        `**New Value:** \`${mult}x\``
    );

    const payload = await getRewardsPayload(interaction.guildId);
    await interaction.update(payload);
  }
  else if (customId === 'rewards_streak_modal') {
    const inputVal = interaction.fields.getTextInputValue('amount');
    const amount = inputVal ? parseInt(inputVal, 10) : 0;

    if (inputVal && (isNaN(amount) || amount < 0)) {
      return interaction.reply({ content: '❌ Invalid amount.', flags: MessageFlags.Ephemeral });
    }
    config.daily_streak_bonus = amount;
    await setGuildConfig(guildId, config);

    // Standard Audit Log
    const logName = getUserLogName(interaction);
    sendLog(interaction.guild, 'audit', 'cyan', '⚙️ Reward Config Changed', 
        `**Admin:** \`${logName}\`\n` +
        `**Setting:** Daily Streak Bonus\n` +
        `**New Value:** \`${amount.toLocaleString()}\` ${COIN_EMOJI}`
    );

    const payload = await getRewardsPayload(interaction.guildId);
    await interaction.update(payload);
  }
  else if (customId.startsWith('rewards_give_modal_')) {
    const targetUserId = customId.split('_').pop();
    const amount = parseInt(interaction.fields.getTextInputValue('amount'), 10);
    const reason = interaction.fields.getTextInputValue('reason') || 'Admin Grant';

    if (isNaN(amount) || amount <= 0) {
      return interaction.reply({ content: '❌ Invalid amount. Must be greater than 0.', flags: MessageFlags.Ephemeral });
    }

    try {
      await updateBalance(targetUserId, guildId, amount, 'admin_grant', reason);

      const logName = getUserLogName(interaction);
      const recipientUser = await interaction.client.users.fetch(targetUserId).catch(() => null);
      const recipientLogName = recipientUser ? getUserLogName(recipientUser) : targetUserId;

      // Standard Rewards Log
      sendLog(interaction.guild, 'economy', 'orange', '🎁 Rewards Claimed', 
        `**User:** \`${recipientLogName}\`\n` +
        `**Amount:** \`${amount.toLocaleString()}\` ${COIN_EMOJI}\n` +
        `**Source:** Admin Grant (By \`${logName}\`)\n` +
        `**Reason:** ${reason}`
      );

      // Return to rewards menu and send success message
      const payload = await getRewardsPayload(interaction.guildId);
      await interaction.update(payload);
      await interaction.followUp({ content: `✅ Gave **${amount} coins** to <@${targetUserId}>.`, flags: MessageFlags.Ephemeral });
    } catch (error) {
      console.error('Give coins error:', error);
      await interaction.reply({ content: '❌ Failed to give coins. Please try again.', flags: MessageFlags.Ephemeral });
    }
  }
}
