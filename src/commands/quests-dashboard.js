import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags
} from 'discord.js';
import { getGuildConfig, setGuildConfig } from '../storage/config.js';
import {
  getQuests,
  getQuest,
  addQuest,
  updateQuest,
  deleteQuest,
  formatActionType,
  getActionsForChannelType,
  formatQuestTask
} from '../quests/quests.js';

// Temporary storage for add-Quest flow (userId -> { channelId, channelType })
const pendingQuestAdd = new Map();

// ============================================
// MAIN DASHBOARD
// ============================================

/**
 * Show the Quests Dashboard
 */
export async function showQuestsDashboard(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      if (interaction.isButton() || interaction.isAnySelectMenu()) {
        await interaction.deferUpdate();
      } else {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      }
    }

    const guildId = interaction.guildId;
    let config = await getGuildConfig(guildId) || {};
    const quests = await getQuests(guildId);

    // Migration / Standardized keys
    const enabled = config.quests_enabled ?? config.missions_enabled ?? false;
    const channelId = config.quests_channel_id ?? config.missions_channel_id;
    const refreshes = config.quests_refreshes_per_day || 1;
    const perRefresh = config.quests_per_refresh || 3;

    // Build Quest list display
    let questListText = quests.length === 0 
      ? '*No quests created yet. Click "Add Quest" to get started.*'
      : quests.map((m, i) => `**${i + 1}.** <#${m.channel_id}> → ${formatQuestTask(m).text} → **${Number(m.reward_coins).toLocaleString()}** coins`).join('\n');

    const embed = new EmbedBuilder()
      .setTitle('🎯 Passive Quests Control Panel')
      .setColor(enabled ? '#2ECC71' : '#95A5A6')
      .setDescription(
        `**Status:** ${enabled ? '✅ Passive Tracking Active' : '❌ Disabled'}\n` +
        `**Announcement Channel:** ${channelId ? `<#${channelId}>` : '*Not Set*'}\n` +
        `**Refreshes:** \`${refreshes}x\` daily (Cairo Time)\n` +
        `**Difficulty:** Pick \`${perRefresh}\` random quests from the pool each refresh.\n\n` +
        `**Current Pool (${quests.length}/10):**\n${questListText}`
      );

    // Row 1: Global Config (Enable/Disable + Refresh Settings)
    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('quests_toggle')
        .setLabel(enabled ? 'Disable' : 'Enable')
        .setEmoji(enabled ? '✖️' : '✅')
        .setStyle(enabled ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder()
          .setCustomId('quests_settings_refreshes')
          .setLabel(`Cycle: ${refreshes}x`)
          .setEmoji('🕒')
          .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
          .setCustomId('quests_settings_count')
          .setLabel(`Pool size: ${perRefresh}`)
          .setEmoji('🎲')
          .setStyle(ButtonStyle.Secondary)
    );

    // Row 2: Add Quest + Force Rotation
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('quests_add_start')
        .setLabel('Add to Pool')
        .setEmoji('➕')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(quests.length >= 10),
      new ButtonBuilder()
          .setCustomId('quests_force_rotate')
          .setLabel('Rotate Now')
          .setEmoji('🔄')
          .setStyle(ButtonStyle.Secondary)
    );

    // Row 3: Numbered buttons for Quest selection (Edit/Delete)
    const questButtons = [];
    for (let i = 0; i < quests.length; i++) {
        questButtons.push(
            new ButtonBuilder()
                .setCustomId(`quests_select_${quests[i].id}`)
                .setLabel(`${i + 1}`)
                .setStyle(ButtonStyle.Secondary)
        );
    }

    // Navigation Row
    const backRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('settings_home')
        .setLabel('Main Menu')
        .setEmoji('🏠')
        .setStyle(ButtonStyle.Secondary)
    );

    const components = [];
    
    // Announcement Channel Select
    const channelSelect = new ChannelSelectMenuBuilder()
      .setCustomId('quests_channel_select')
      .setPlaceholder('Select Announcement Channel...')
      .addChannelTypes(ChannelType.GuildText);
    if (channelId) channelSelect.setDefaultChannels([channelId]);
    components.push(new ActionRowBuilder().addComponents(channelSelect));

    components.push(row1, row2);
    
    // Group quest buttons in rows of 5
    if (questButtons.length > 0) {
        for (let i = 0; i < questButtons.length; i += 5) {
            components.push(new ActionRowBuilder().addComponents(...questButtons.slice(i, i + 5)));
        }
    }

    components.push(backRow);

    await interaction.editReply({ embeds: [embed], components, content: null });
  } catch (error) {
    console.error('[Quests] Dashboard error:', error);
  }
}

// ============================================
// SETTINGS HANDLERS (Cycle/Count)
// ============================================

export async function handleQuestsSettingsUpdate(interaction) {
    const customId = interaction.customId;
    const guildId = interaction.guildId;
    const config = await getGuildConfig(guildId) || {};

    if (customId === 'quests_settings_refreshes') {
        // Cycle 1, 2, 3, 4
        let current = config.quests_refreshes_per_day || 1;
        config.quests_refreshes_per_day = (current % 4) + 1;
    } else if (customId === 'quests_settings_count') {
        // Pool size 1-5
        let current = config.quests_per_refresh || 3;
        config.quests_per_refresh = (current % 5) + 1;
    }

    await setGuildConfig(guildId, config);
    await showQuestsDashboard(interaction);
}

export async function handleForceRotate(interaction) {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    
    const { rotateGuildQuests } = await import('../cron/quests.js');
    const guildId = interaction.guildId;
    const config = await getGuildConfig(guildId);
    
    await rotateGuildQuests(guildId, config, null); // passing null as pool will make it use getPool internally
    
    await interaction.followUp({ content: '✅ Quests rotated successfully!', flags: MessageFlags.Ephemeral });
    await showQuestsDashboard(interaction);
}

// ============================================
// Quest DETAIL VIEW
// ============================================

export async function showQuestDetail(interaction, questId) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

    const quest = await getQuest(questId);
    if (!quest) {
      await interaction.editReply({ content: '❌ Quest not found.', embeds: [], components: [] });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('🎯 Quest Details')
      .setColor('#3498DB')
      .addFields(
        { name: '📺 Channel', value: `<#${quest.channel_id}>`, inline: false },
        { name: '🎮 Actions', value: formatQuestTask(quest).text, inline: false },
        { name: '💰 Rewards', value: `**${Number(quest.reward_coins).toLocaleString()}** Coins`, inline: false }
      );

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`quests_edit_${questId}`)
        .setLabel('Edit')
        .setEmoji('✏️')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`quests_delete_${questId}`)
        .setLabel('Delete')
        .setEmoji('🗑️')
        .setStyle(ButtonStyle.Danger)
    );

    const backRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('quests_dashboard')
        .setLabel('Back')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.editReply({ embeds: [embed], components: [row, backRow], content: null });
  } catch (error) {
    console.error('[Quests] Detail error:', error);
  }
}

// ============================================
// ADD Quest FLOW
// ============================================

export async function handleAddQuestStart(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

  const embed = new EmbedBuilder()
    .setTitle('➕ Add to Pool — Step 1')
    .setDescription('Select the **target channel** for this quest.')
    .setColor('#2ECC71');

  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId('quests_add_channel')
    .setPlaceholder('Select target channel...')
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildForum);

  const backRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('quests_dashboard')
      .setLabel('Back')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary)
  );

  await interaction.editReply({
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(channelSelect),
      backRow
    ],
    content: null
  });
}

export async function handleAddChannelSelect(interaction) {
  const channelId = interaction.values[0];
  const guild = interaction.guild;
  const channel = await guild.channels.fetch(channelId).catch(() => null);

  if (!channel) {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    await interaction.editReply({ content: '❌ Channel not found.', embeds: [], components: [] });
    return;
  }

  let channelType = 'text';
  if (channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice) {
    channelType = 'voice';
  } else if (channel.type === ChannelType.GuildForum || channel.type === ChannelType.GuildMedia) {
    channelType = 'media';
  }

  pendingQuestAdd.set(interaction.user.id, { channelId, channelType });
  const actions = getActionsForChannelType(channelType);

  if (actions.length === 1) {
    pendingQuestAdd.get(interaction.user.id).actionType = actions[0].value;
    await showAddQuestModal(interaction, actions[0].value);
    return;
  }

  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

  const embed = new EmbedBuilder()
    .setTitle('➕ Add to Pool — Step 2')
    .setDescription(`Channel: <#${channelId}> (${channelType})\n\nSelect the **action type** for this quest.`)
    .setColor('#2ECC71');

  const actionSelect = new StringSelectMenuBuilder()
    .setCustomId('quests_add_action')
    .setPlaceholder('Select action type...')
    .addOptions(actions);

  const backRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('quests_dashboard')
      .setLabel('Back')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary)
  );

  await interaction.editReply({
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(actionSelect),
      backRow
    ],
    content: null
  });
}

export async function handleAddActionSelect(interaction) {
  const actionType = interaction.values[0];
  const pending = pendingQuestAdd.get(interaction.user.id);
  if (!pending) {
    await interaction.reply({ content: '❌ Session expired. Please start over.', flags: MessageFlags.Ephemeral });
    return;
  }
  pending.actionType = actionType;
  await showAddQuestModal(interaction, actionType);
}

async function showAddQuestModal(interaction, actionType) {
  const actionLabel = formatActionType(actionType);

  const modal = new ModalBuilder()
    .setCustomId('quests_add_modal')
    .setTitle('Quest Configuration');

  const countInput = new TextInputBuilder()
    .setCustomId('required_count')
    .setLabel(`How many? (${actionLabel})`)
    .setStyle(TextInputStyle.Short)
    .setPlaceholder(actionType === 'voice_minutes' ? '10' : '5')
    .setRequired(true);

  const rewardInput = new TextInputBuilder()
    .setCustomId('reward_coins')
    .setLabel('Coin Reward')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('50')
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(countInput),
    new ActionRowBuilder().addComponents(rewardInput)
  );

  await interaction.showModal(modal);
}

export async function handleAddQuestModal(interaction) {
  await interaction.deferUpdate();

  const pending = pendingQuestAdd.get(interaction.user.id);
  if (!pending) {
    await interaction.followUp({ content: '❌ Session expired. Please start over.', flags: MessageFlags.Ephemeral });
    return;
  }

  const requiredCount = parseInt(interaction.fields.getTextInputValue('required_count'), 10);
  const rewardCoins = parseInt(interaction.fields.getTextInputValue('reward_coins'), 10);

  if (isNaN(requiredCount) || requiredCount <= 0 || !Number.isInteger(requiredCount) || requiredCount > 10000) {
    await interaction.followUp({ content: '❌ Requirement must be a whole number between **1** and **10,000**.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (isNaN(rewardCoins) || rewardCoins <= 0 || !Number.isInteger(rewardCoins) || rewardCoins > 1000000) {
    await interaction.followUp({ content: '❌ Reward must be a whole number between **1** and **1,000,000**.', flags: MessageFlags.Ephemeral });
    return;
  }

  const result = await addQuest(interaction.guildId, {
    channelId: pending.channelId,
    channelType: pending.channelType,
    actionType: pending.actionType,
    requiredCount,
    rewardCoins
  });

  pendingQuestAdd.delete(interaction.user.id);

  if (result.error) {
    await interaction.followUp({ content: `❌ ${result.error}`, flags: MessageFlags.Ephemeral });
    return;
  }

  await showQuestsDashboard(interaction);
}

// ============================================
// EDIT Quest
// ============================================

export async function handleEditQuest(interaction, questId) {
  const quest = await getQuest(questId);
  if (!quest) {
    await interaction.reply({ content: '❌ Quest not found.', flags: MessageFlags.Ephemeral });
    return;
  }

  const actionLabel = formatActionType(quest.action_type);

  const modal = new ModalBuilder()
    .setCustomId(`quests_edit_modal_${questId}`)
    .setTitle('Edit Quest');

  const countInput = new TextInputBuilder()
    .setCustomId('required_count')
    .setLabel(`Required Count (${actionLabel})`)
    .setStyle(TextInputStyle.Short)
    .setValue(String(quest.required_count))
    .setRequired(true);

  const rewardInput = new TextInputBuilder()
    .setCustomId('reward_coins')
    .setLabel('Coin Reward')
    .setStyle(TextInputStyle.Short)
    .setValue(String(quest.reward_coins))
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(countInput),
    new ActionRowBuilder().addComponents(rewardInput)
  );

  await interaction.showModal(modal);
}

export async function handleEditQuestModal(interaction) {
  await interaction.deferUpdate();

  const questId = parseInt(interaction.customId.split('_').pop(), 10);
  const requiredCount = parseInt(interaction.fields.getTextInputValue('required_count'), 10);
  const rewardCoins = parseInt(interaction.fields.getTextInputValue('reward_coins'), 10);

  if (isNaN(requiredCount) || requiredCount <= 0 || !Number.isInteger(requiredCount) || requiredCount > 10000) {
    await interaction.followUp({ content: '❌ Requirement must be a whole number between **1** and **10,000**.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (isNaN(rewardCoins) || rewardCoins <= 0 || !Number.isInteger(rewardCoins) || rewardCoins > 1000000) {
    await interaction.followUp({ content: '❌ Reward must be a whole number between **1** and **1,000,000**.', flags: MessageFlags.Ephemeral });
    return;
  }

  const success = await updateQuest(questId, { requiredCount, rewardCoins });
  if (!success) {
    await interaction.followUp({ content: '❌ Failed to update Quest.', flags: MessageFlags.Ephemeral });
  }

  await showQuestDetail(interaction, questId);
}

// ============================================
// DELETE Quest
// ============================================

export async function handleDeleteQuest(interaction, questId) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

  const config = await getGuildConfig(interaction.guildId) || {};

  // If the active Quest is the one being deleted, clear it
  if (config.active_quest_ids && config.active_quest_ids.includes(questId)) {
    config.active_quest_ids = config.active_quest_ids.filter(id => id !== questId);
    await setGuildConfig(interaction.guildId, config);
  }

  const success = await deleteQuest(questId);
  if (!success) {
    await interaction.followUp({ content: '❌ Failed to delete.', flags: MessageFlags.Ephemeral });
  }

  await showQuestsDashboard(interaction);
}

// ============================================
// TOGGLE & CHANNEL
// ============================================

export async function handleToggleQuests(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

  const guildId = interaction.guildId;
  const config = await getGuildConfig(guildId) || {};
  config.quests_enabled = !(config.quests_enabled ?? config.missions_enabled ?? false);
  await setGuildConfig(guildId, config);

  await showQuestsDashboard(interaction);
}

export async function handleQuestChannelSelect(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

  const channelId = interaction.values[0];
  const guildId = interaction.guildId;
  const config = await getGuildConfig(guildId) || {};
  config.quests_channel_id = channelId;
  await setGuildConfig(guildId, config);

  await showQuestsDashboard(interaction);
}

// ============================================
// COMPONENT ROUTER
// ============================================

export async function handleQuestsComponent(interaction) {
  const customId = interaction.customId;

  if (customId === 'quests_dashboard') {
    await showQuestsDashboard(interaction);
  } else if (customId === 'quests_toggle') {
    await handleToggleQuests(interaction);
  } else if (customId === 'quests_add_start') {
    await handleAddQuestStart(interaction);
  } else if (customId === 'quests_add_channel') {
    await handleAddChannelSelect(interaction);
  } else if (customId === 'quests_add_action') {
    await handleAddActionSelect(interaction);
  } else if (customId === 'quests_channel_select') {
    await handleQuestChannelSelect(interaction);
  } else if (customId === 'quests_settings_refreshes' || customId === 'quests_settings_count') {
    await handleQuestsSettingsUpdate(interaction);
  } else if (customId === 'quests_force_rotate') {
    await handleForceRotate(interaction);
  } else if (customId.startsWith('quests_select_')) {
    const questId = parseInt(customId.split('_').pop(), 10);
    await showQuestDetail(interaction, questId);
  } else if (customId.startsWith('quests_edit_') && !customId.includes('modal')) {
    const questId = parseInt(customId.split('_').pop(), 10);
    await handleEditQuest(interaction, questId);
  } else if (customId.startsWith('quests_delete_')) {
    const questId = parseInt(customId.split('_').pop(), 10);
    await handleDeleteQuest(interaction, questId);
  }
}

export async function handleQuestsModal(interaction) {
  const customId = interaction.customId;

  if (customId === 'quests_add_modal') {
    await handleAddQuestModal(interaction);
  } else if (customId.startsWith('quests_edit_modal_')) {
    await handleEditQuestModal(interaction);
  }
}
