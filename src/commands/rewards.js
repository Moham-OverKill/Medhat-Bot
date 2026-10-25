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
import { getUserDisplayName, getUserLogName, sanitizeError, COIN_EMOJI, getCurrencyName } from '../shared.js';

export const rewardsCommand = new SlashCommandBuilder()
  .setName('rewards')
  .setDescription('Manage server rewards')
  .addSubcommand(sub =>
    sub.setName('setup')
      .setDescription('Configure reward settings')
  );

export async function handleRewardsCommand(interaction) {
  const { verifyAdminAccess } = await import('../storage/admins.js');
  if (!(await verifyAdminAccess(interaction))) return;

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'setup') {
    await handleRewardsSetup(interaction);
  }
}

export async function getRewardsPayload(guildId) {
  const config = await getGuildConfig(guildId) || {};
  const isEnabled = config.daily_enabled === true;

  const boosterMultiplier = config.booster_multiplier !== undefined ? config.booster_multiplier : 2;
  const streakBonus = config.daily_streak_bonus !== undefined ? config.daily_streak_bonus : 5;
  const baseDaily = config.daily_base_reward !== undefined ? config.daily_base_reward : 25;
  const streakCap = config.daily_streak_cap !== undefined ? config.daily_streak_cap : 20;

  const coinName = await getCurrencyName(guildId);
  const boosterText = boosterMultiplier > 1 ? `\`${boosterMultiplier}x mult\`` : '`Disabled`';
  const streakText = streakBonus > 0 ? `\`+${streakBonus} each day\`` : '`Disabled`';
  const baseText = `\`${baseDaily} ${coinName}\``;
  const capText = `\`${streakCap} days\``;

  const embed = new EmbedBuilder()
    .setTitle('Daily Configuration')
    .setColor(isEnabled ? 0x2ECC71 : 0xE74C3C)
    .setDescription(
      `Status: ${isEnabled ? '🟢 Enabled' : '🔴 Disabled'}\n\n` +
      `💰 Base Daily: ${baseText}\n` +
      `🚀 Boosters: ${boosterText}\n` +
      `🔥 Streak Bonus: ${streakText}\n` +
      `♾️ Streak Cap: ${capText}`
    );

    const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('rewards_config_btn')
      .setLabel('Config')
      .setEmoji('⚙️')
      .setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('settings_coins')
      .setLabel('Back')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('rewards_daily_toggle')
      .setLabel(isEnabled ? 'Disable' : 'Enable')
      .setEmoji(isEnabled ? '✖️' : '▶️')
      .setStyle(isEnabled ? ButtonStyle.Danger : ButtonStyle.Success)
  );

  return { embeds: [embed], components: [row1, row2] };
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
      await interaction.editReply({ files: [], content: null,
        embeds: payload.embeds,
        components: payload.components });
      return;
    }

        // UNIFIED CONFIG MODAL
    if (customId === 'rewards_config_btn') {
      const config = await getGuildConfig(guildId) || {};
      const modal = new ModalBuilder()
        .setCustomId('rewards_config_modal')
        .setTitle('Daily Configuration');

      const hasCustomBase = config.daily_base_reward !== undefined && config.daily_base_reward !== null && Number(config.daily_base_reward) !== 25;
      const baseInput = new TextInputBuilder()
        .setCustomId('base_reward')
        .setLabel('Base Daily')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('25')
        .setRequired(false);
      if (hasCustomBase) {
        baseInput.setValue(String(config.daily_base_reward));
      }

      const hasCustomBooster = config.booster_multiplier !== undefined && config.booster_multiplier !== null && Number(config.booster_multiplier) !== 2;
      const boosterInput = new TextInputBuilder()
        .setCustomId('booster_multiplier')
        .setLabel('Boost Multiplier')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('2')
        .setRequired(false);
      if (hasCustomBooster) {
        boosterInput.setValue(String(config.booster_multiplier));
      }

      const hasCustomBonus = config.daily_streak_bonus !== undefined && config.daily_streak_bonus !== null && Number(config.daily_streak_bonus) !== 5;
      const streakInput = new TextInputBuilder()
        .setCustomId('streak_bonus')
        .setLabel('Streak Bonus')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('5')
        .setRequired(false);
      if (hasCustomBonus) {
        streakInput.setValue(String(config.daily_streak_bonus));
      }

      const hasCustomCap = config.daily_streak_cap !== undefined && config.daily_streak_cap !== null && Number(config.daily_streak_cap) !== 20;
      const capInput = new TextInputBuilder()
        .setCustomId('streak_cap')
        .setLabel('Streak Cap')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('20')
        .setRequired(false);
      if (hasCustomCap) {
        capInput.setValue(String(config.daily_streak_cap));
      }

      modal.addComponents(
        new ActionRowBuilder().addComponents(baseInput),
        new ActionRowBuilder().addComponents(boosterInput),
        new ActionRowBuilder().addComponents(streakInput),
        new ActionRowBuilder().addComponents(capInput)
      );

      await interaction.showModal(modal);
      return;
    }
    else if (customId === 'rewards_daily_toggle') {
      const config = await getGuildConfig(guildId) || {};
      const newEnabled = !(config.daily_enabled === true);
      config.daily_enabled = newEnabled;
      await setGuildConfig(guildId, config);

      import('./register.js').then(({ syncGuildSlashCommands }) => {
        syncGuildSlashCommands(guildId, interaction.client).catch(() => {});
      }).catch(() => {});

      const logName = getUserLogName(interaction);
      sendLog(interaction.guild, 'audit', newEnabled ? 'cyan' : 'crimson',
        newEnabled ? '⚙️ Daily Rewards Enabled' : '⚙️ Daily Rewards Disabled',
        `**Admin:** \`${logName}\`\n` +
        `**Status:** Daily rewards system is now **${newEnabled ? 'ON' : 'OFF'}**.`
      );

      const payload = await getRewardsPayload(guildId);
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload);
      } else {
        await interaction.update(payload);
      }
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
      const coinName = await getCurrencyName(guildId);
      const modal = new ModalBuilder().setCustomId('rewards_streak_modal').setTitle('Daily Streak Bonus');
      const input = new TextInputBuilder()
        .setCustomId('amount')
        .setLabel(`${coinName} per streak day`)
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('5')
        .setValue(String(config.daily_streak_bonus !== undefined ? config.daily_streak_bonus : 5))
        .setRequired(false);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
    }
    else if (customId === 'rewards_daily_base_btn') {
      const config = await getGuildConfig(guildId) || {};
      const coinName = await getCurrencyName(guildId);
      const modal = new ModalBuilder().setCustomId('rewards_daily_base_modal').setTitle('Base Daily Reward');
      const input = new TextInputBuilder()
        .setCustomId('amount')
        .setLabel(`Base ${coinName} (Day 1)`)
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
      const coinName = await getCurrencyName(guildId);
      const userSelect = new UserSelectMenuBuilder()
        .setCustomId('rewards_give_select')
        .setPlaceholder(`Select user to give ${coinName.toLowerCase()} to`)
        .setMinValues(1)
        .setMaxValues(1);

      const row = new ActionRowBuilder().addComponents(userSelect);
      const backRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('settings_coins').setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary)
      );

      await interaction.editReply({ files: [], content: `Select a user to give ${coinName.toLowerCase()} to:`, embeds: [], components: [row, backRow] });
    }
    else if (customId === 'rewards_give_select') {
      const targetUserId = interaction.users?.first()?.id || (interaction.values ? interaction.values[0] : null);

      if (!targetUserId) {
        return interaction.reply({ content: '❌ Could not determine selected user.', flags: MessageFlags.Ephemeral });
      }

      const coinName = await getCurrencyName(guildId);
      const modal = new ModalBuilder().setCustomId(`rewards_give_modal_${targetUserId}`).setTitle((`Give ${coinName}`).slice(0, 45));
      const input = new TextInputBuilder()
        .setCustomId('amount')
        .setLabel(`${coinName} Amount`)
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

    if (customId === 'rewards_config_modal') {
      const baseStr = interaction.fields.getTextInputValue('base_reward')?.trim();
      const boosterStr = interaction.fields.getTextInputValue('booster_multiplier')?.trim();
      const streakStr = interaction.fields.getTextInputValue('streak_bonus')?.trim();
      const capStr = interaction.fields.getTextInputValue('streak_cap')?.trim();

      // Empty = default values = placeholder text
      const base = baseStr ? parseInt(baseStr, 10) : 25;
      const booster = boosterStr ? parseFloat(boosterStr) : 2;
      const bonus = streakStr ? parseInt(streakStr, 10) : 5;
      const cap = capStr ? parseInt(capStr, 10) : 20;

      if (isNaN(base) || base < 0) {
        return interaction.followUp({ content: '❌ Invalid Base Daily reward amount.', flags: MessageFlags.Ephemeral });
      }
      if (isNaN(booster) || booster < 0) {
        return interaction.followUp({ content: '❌ Invalid Booster Multiplier.', flags: MessageFlags.Ephemeral });
      }
      if (isNaN(bonus) || bonus < 0) {
        return interaction.followUp({ content: '❌ Invalid Streak Bonus amount.', flags: MessageFlags.Ephemeral });
      }
      if (isNaN(cap) || cap < 1) {
        return interaction.followUp({ content: '❌ Invalid Streak Cap. Must be at least 1.', flags: MessageFlags.Ephemeral });
      }

      config.daily_base_reward = base;
      config.booster_multiplier = booster;
      config.daily_streak_bonus = bonus;
      config.daily_streak_cap = cap;
      await setGuildConfig(guildId, config);

      const logName = getUserLogName(interaction);
      const coinName = await getCurrencyName(guildId);
      sendLog(interaction.guild, 'audit', 'cyan', '⚙️ Daily Rewards Configured',
        `**Admin:** \`${logName}\`\n` +
        `**Base Daily:** \`${base.toLocaleString()} ${coinName}\`\n` +
        `**Boost Multiplier:** \`${booster}x\`\n` +
        `**Streak Bonus:** \`+${bonus.toLocaleString()} each day\`\n` +
        `**Streak Cap:** \`${cap} days\``
      );

      const payload = await getRewardsPayload(guildId);
      await interaction.editReply(payload);
    }
    else if (customId === 'rewards_booster_modal') {
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
        const coinName = await getCurrencyName(guildId);

        sendLog(interaction.guild, 'economy', 'green', `💰 Admin ${coinName} Granted`,
          `**Target:** \`${recipientLogName}\`\n` +
          `**Amount:** \`${amount.toLocaleString()}\` ${COIN_EMOJI}\n` +
          `**Admin:** \`${logName}\`\n` +
          `**Reason:** ${reason}`
        );

        // Return to user selector instead of main menu
        const userSelect = new UserSelectMenuBuilder()
          .setCustomId('rewards_give_select')
          .setPlaceholder(`Select user to give ${coinName.toLowerCase()} to`)
          .setMinValues(1)
          .setMaxValues(1);

        const row = new ActionRowBuilder().addComponents(userSelect);
        const backRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('settings_coins').setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary)
        );

        await interaction.editReply({ files: [], content: `Select a user to give ${coinName.toLowerCase()} to:`, embeds: [], components: [row, backRow] });
        await interaction.followUp({ content: `✅ Gave **${amount.toLocaleString()} ${coinName.toLowerCase()}** to <@${targetUserId}>.`, flags: MessageFlags.Ephemeral });

        // Real-time role re-evaluation for Richest Role
        import('../mvp/role-assignment.js').then(({ applyRichestRole }) => {
            applyRichestRole(interaction.client, guildId).catch(err => {
                sysError('Richest Role Auto-update Failed', err, { guild: guildId });
            });
        }).catch(() => {});
      } catch (error) {
        const coinName = await getCurrencyName(guildId);
        sysError('Give coins error', error, { user: interaction.user.id, guild: interaction.guildId, target: targetUserId });
        await interaction.followUp({ content: `❌ Failed to give ${coinName.toLowerCase()}. Please try again.`, flags: MessageFlags.Ephemeral });
      }
    }
  } catch (error) {
    sysError('Rewards modal error', error, { user: interaction.user.id, guild: interaction.guildId });
    const reply = { content: '❌ An error occurred processing this configuration.', flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) await interaction.followUp(reply);
    else await interaction.reply(reply);
  }
}
