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
import { logServerEvent, sendLog, sysError } from '../utils/logger.js';
import { handleInteractionError } from '../utils/errors.js';
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

  const boosterMultiplier = config.booster_multiplier !== undefined ? config.booster_multiplier : 2;
  const streakBonus = config.daily_streak_bonus !== undefined ? config.daily_streak_bonus : 5;
  const baseDaily = config.daily_base_reward !== undefined ? config.daily_base_reward : 25;
  const streakCap = config.daily_streak_cap !== undefined ? config.daily_streak_cap : 20;

  const boosterText = boosterMultiplier > 1 ? `\`${boosterMultiplier}x mult\`` : '`Disabled`';
  const streakText = streakBonus > 0 ? `\`${streakBonus} coins\`` : '`Disabled`';
  const baseText = `\`${baseDaily} coins\``;
  const capText = `\`${streakCap} days\``;

  const embed = new EmbedBuilder()
    .setTitle(`${COIN_EMOJI} Daily Configuration`)
    .setColor('#F1C40F')
    .addFields(
      { name: 'Base Daily', value: baseText, inline: true },
      { name: 'Boost Mult', value: boosterText, inline: true },
      { name: '\u200B', value: '\u200B', inline: true },
      { name: 'Streak Bonus', value: streakText, inline: true },
      { name: 'Streak Cap', value: capText, inline: true },
      { name: '\u200B', value: '\u200B', inline: true }
    );

  // Row 1: Config Buttons (2 Primary)
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('rewards_daily_base_btn').setLabel('Base Daily').setStyle(ButtonStyle.Primary).setEmoji('💰'),
    new ButtonBuilder().setCustomId('rewards_booster_btn').setLabel('Boost Multiplier').setStyle(ButtonStyle.Primary).setEmoji('🚀')
  );

  // Row 2: Config Buttons (2 Primary)
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('rewards_streak_btn').setLabel('Streak Bonus').setStyle(ButtonStyle.Primary).setEmoji('🔥'),
    new ButtonBuilder().setCustomId('rewards_streak_cap_btn').setLabel('Streak Cap').setStyle(ButtonStyle.Primary).setEmoji('♾️')
  );

  // Row 3: Navigation
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('settings_coins').setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row1, row2, row3] };
}

export async function handleRewardsSetup(interaction) {
  try {
    const payload = await getRewardsPayload(interaction.guildId);

    // Handle different interaction states
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload);
    } else if (interaction.isButton() || interaction.isAnySelectMenu()) {
      await interaction.update(payload);
    } else {
      await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    }
  } catch (error) {
    sysError('Rewards setup error', error, { user: interaction.user.id, guild: interaction.guildId });
    const reply = { content: '❌ An error occurred loading rewards setup.', flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) await interaction.followUp(reply);
    else await interaction.reply(reply);
  }
}

export async function handleRewardsComponent(interaction) {
  const customId = interaction.customId;
  const guildId = interaction.guildId;

  try {
    if (customId === 'rewards_home') {
      await interaction.deferUpdate().catch(() => {});
      const payload = await getRewardsPayload(guildId);
      await interaction.editReply({
        content: null,
        embeds: payload.embeds,
        components: payload.components
      });
      return;
    }

    // MODALS
    if (customId === 'rewards_booster_btn') {
      const config = await getGuildConfig(guildId) || {};
      const modal = new ModalBuilder().setCustomId('rewards_booster_modal').setTitle('Booster Multiplier');
      const input = new TextInputBuilder()
        .setCustomId('multiplier')
        .setLabel('Multiplier')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('2')
        .setValue(String(Math.floor(config.booster_multiplier || 2)))
        .setRequired(false);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
    }
    else if (customId === 'rewards_streak_btn') {
      const config = await getGuildConfig(guildId) || {};
      const modal = new ModalBuilder().setCustomId('rewards_streak_modal').setTitle('Daily Streak Bonus');
      const input = new TextInputBuilder()
        .setCustomId('amount')
        .setLabel('Coins per streak day')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('5')
        .setValue(String(config.daily_streak_bonus !== undefined ? config.daily_streak_bonus : 5))
        .setRequired(false);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
    }
    else if (customId === 'rewards_daily_base_btn') {
      const config = await getGuildConfig(guildId) || {};
      const modal = new ModalBuilder().setCustomId('rewards_daily_base_modal').setTitle('Base Daily Reward');
      const input = new TextInputBuilder()
        .setCustomId('amount')
        .setLabel('Base Coins (Day 1)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('25')
        .setValue(String(config.daily_base_reward !== undefined ? config.daily_base_reward : 25))
        .setRequired(false);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
    }
    else if (customId === 'rewards_streak_cap_btn') {
      const config = await getGuildConfig(guildId) || {};
      const modal = new ModalBuilder().setCustomId('rewards_streak_cap_modal').setTitle('Max Streak Bonus Cap');
      const input = new TextInputBuilder()
        .setCustomId('cap')
        .setLabel('Maximum streak days')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('20')
        .setValue(String(config.daily_streak_cap !== undefined ? config.daily_streak_cap : 20))
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
        new ButtonBuilder().setCustomId('settings_coins').setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary)
      );

      await interaction.editReply({ content: 'Select a user to give coins to:', embeds: [], components: [row, backRow] });
    }
    else if (customId === 'rewards_give_select') {
      const targetUserId = interaction.users?.first()?.id || (interaction.values ? interaction.values[0] : null);

      if (!targetUserId) {
        return interaction.reply({ content: '❌ Could not determine selected user.', flags: MessageFlags.Ephemeral });
      }

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
  } catch (error) {
    sysError('Rewards component router failed', error, { user: interaction.user.id, guild: interaction.guildId });
    const reply = { content: '❌ An error occurred processing this interaction.', flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) await interaction.followUp(reply);
    else await interaction.reply(reply);
  }
}

export async function handleRewardsModal(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
  const customId = interaction.customId;
  const guildId = interaction.guildId;

  try {
    const config = await getGuildConfig(guildId) || {};

    if (customId === 'rewards_booster_modal') {
      const inputVal = interaction.fields.getTextInputValue('multiplier');
      const mult = inputVal ? Math.max(0, parseInt(inputVal, 10)) : 2;

      if (inputVal && isNaN(mult)) {
        return interaction.followUp({ content: '❌ Invalid multiplier.', flags: MessageFlags.Ephemeral });
      }
      config.booster_multiplier = mult;
      await setGuildConfig(guildId, config);

      const logName = getUserLogName(interaction);
      sendLog(interaction.guild, 'audit', 'cyan', '⚙️ Reward Config Changed',
        `**Admin:** \`${logName}\`\n` +
        `**Setting:** Booster Multiplier\n` +
        `**New Value:** \`${mult}x\``
      );

      const payload = await getRewardsPayload(interaction.guildId);
      await interaction.editReply(payload);
    }
    else if (customId === 'rewards_streak_modal') {
      const inputVal = interaction.fields.getTextInputValue('amount');
      const amount = inputVal ? Math.max(0, parseInt(inputVal, 10)) : 5;

      if (inputVal && isNaN(amount)) {
        return interaction.followUp({ content: '❌ Invalid amount.', flags: MessageFlags.Ephemeral });
      }
      config.daily_streak_bonus = amount;
      await setGuildConfig(guildId, config);

      const logName = getUserLogName(interaction);
      sendLog(interaction.guild, 'audit', 'cyan', '⚙️ Reward Config Changed',
        `**Admin:** \`${logName}\`\n` +
        `**Setting:** Daily Streak Bonus\n` +
        `**New Value:** \`${amount.toLocaleString()}\` ${COIN_EMOJI}`
      );

      const payload = await getRewardsPayload(interaction.guildId);
      await interaction.editReply(payload);
    }
    else if (customId === 'rewards_daily_base_modal') {
      const inputVal = interaction.fields.getTextInputValue('amount');
      const amount = inputVal ? Math.max(0, parseInt(inputVal, 10)) : 25;

      if (inputVal && isNaN(amount)) {
        return interaction.followUp({ content: '❌ Invalid amount.', flags: MessageFlags.Ephemeral });
      }
      config.daily_base_reward = amount;
      await setGuildConfig(guildId, config);

      const logName = getUserLogName(interaction);
      sendLog(interaction.guild, 'audit', 'cyan', '⚙️ Reward Config Changed',
        `**Admin:** \`${logName}\`\n` +
        `**Setting:** Base Daily Reward\n` +
        `**New Value:** \`${amount.toLocaleString()}\` ${COIN_EMOJI}`
      );

      const payload = await getRewardsPayload(interaction.guildId);
      await interaction.editReply(payload);
    }
    else if (customId === 'rewards_streak_cap_modal') {
      const inputVal = interaction.fields.getTextInputValue('cap');
      const cap = inputVal ? Math.max(1, parseInt(inputVal, 10)) : 20;

      if (inputVal && (isNaN(cap) || cap < 1)) {
        return interaction.followUp({ content: '❌ Invalid cap. Must be at least 1.', flags: MessageFlags.Ephemeral });
      }
      config.daily_streak_cap = cap;
      await setGuildConfig(guildId, config);

      const logName = getUserLogName(interaction);
      sendLog(interaction.guild, 'audit', 'cyan', '⚙️ Reward Config Changed',
        `**Admin:** \`${logName}\`\n` +
        `**Setting:** Daily Streak Cap\n` +
        `**New Value:** \`${cap} days\``
      );

      const payload = await getRewardsPayload(interaction.guildId);
      await interaction.editReply(payload);
    }
    else if (customId === 'rewards_mvp_modal') {
      const inputVal = interaction.fields.getTextInputValue('amount');
      const amount = inputVal ? Math.max(0, parseInt(inputVal, 10)) : 100;

      if (inputVal && isNaN(amount)) {
        return interaction.followUp({ content: '❌ Invalid reward amount.', flags: MessageFlags.Ephemeral });
      }

      config.mvpRewardAmount = amount;
      await setGuildConfig(guildId, config);

      const logName = getUserLogName(interaction);
      sendLog(interaction.guild, 'audit', 'cyan', '⚙️ MVP Reward Updated',
        `**Admin:** \`${logName}\`\n` +
        `**Action:** Set daily MVP reward to **${amount.toLocaleString()}** ${COIN_EMOJI}.`
      );

      // Return to MVP panel instead of Rewards panel
      const { showSetupPanel } = await import('./mvp.js');
      await showSetupPanel(interaction, config);
    }
    else if (customId.startsWith('rewards_give_modal_')) {
      const targetUserId = customId.split('_').pop();
      const amountStr = interaction.fields.getTextInputValue('amount');
      const amount = parseInt(amountStr, 10);
      const reason = interaction.fields.getTextInputValue('reason') || 'Admin Grant';

      if (isNaN(amount) || amount <= 0) {
        return interaction.followUp({ content: '❌ Invalid amount. Must be greater than 0.', flags: MessageFlags.Ephemeral });
      }

      try {
        await updateBalance(targetUserId, guildId, amount, 'admin_grant', reason);

        const logName = getUserLogName(interaction);
        const recipientUser = await interaction.client.users.fetch(targetUserId).catch(() => null);
        const recipientLogName = recipientUser ? getUserLogName(recipientUser) : targetUserId;

        sendLog(interaction.guild, 'economy', 'green', '💰 Admin Coins Granted',
          `**Target:** \`${recipientLogName}\`\n` +
          `**Amount:** \`${amount.toLocaleString()}\` ${COIN_EMOJI}\n` +
          `**Admin:** \`${logName}\`\n` +
          `**Reason:** ${reason}`
        );

        // Return to user selector instead of main menu
        const userSelect = new UserSelectMenuBuilder()
          .setCustomId('rewards_give_select')
          .setPlaceholder('Select user to give coins to')
          .setMinValues(1)
          .setMaxValues(1);

        const row = new ActionRowBuilder().addComponents(userSelect);
        const backRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('settings_coins').setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary)
        );

        await interaction.editReply({ content: 'Select a user to give coins to:', embeds: [], components: [row, backRow] });
        await interaction.followUp({ content: `✅ Gave **${amount.toLocaleString()} coins** to <@${targetUserId}>.`, flags: MessageFlags.Ephemeral });
      } catch (error) {
        sysError('Give coins error', error, { user: interaction.user.id, guild: interaction.guildId, target: targetUserId });
        await interaction.followUp({ content: '❌ Failed to give coins. Please try again.', flags: MessageFlags.Ephemeral });
      }
    }
  } catch (error) {
    sysError('Rewards modal error', error, { user: interaction.user.id, guild: interaction.guildId });
    const reply = { content: '❌ An error occurred processing this configuration.', flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) await interaction.followUp(reply);
    else await interaction.reply(reply);
  }
}
