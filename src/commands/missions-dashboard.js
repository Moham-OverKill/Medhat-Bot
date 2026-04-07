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
  getMissions,
  getMission,
  addMission,
  updateMission,
  deleteMission,
  formatActionType,
  getActionsForChannelType,
  formatMissionTask
} from '../missions/missions.js';

// Temporary storage for add-mission flow (userId -> { channelId, channelType })
const pendingMissionAdd = new Map();

// ============================================
// MAIN DASHBOARD
// ============================================

/**
 * Show the Missions Dashboard
 */
export async function showMissionsDashboard(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      if (interaction.isButton() || interaction.isAnySelectMenu()) {
        await interaction.deferUpdate();
      } else {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      }
    }

    const guildId = interaction.guildId;
    const config = await getGuildConfig(guildId) || {};
    const missions = await getMissions(guildId);

    const enabled = config.missions_enabled || false;
    const channelId = config.missions_channel_id;

    // Build mission list display
    let missionListText = missions.length === 0 
      ? '*No missions created yet. Click "Add Mission" to get started.*'
      : missions.map((m, i) => `**${i + 1}.** <#${m.channel_id}> → ${formatMissionTask(m).text} → **${Number(m.reward_coins).toLocaleString()}** coins`).join('\n');

    const embed = new EmbedBuilder()
      .setTitle('🎯 Missions Dashboard')
      .setColor(enabled ? '#2ECC71' : '#95A5A6')
      .setDescription(
        `**Status:** ${enabled ? '✅ Enabled' : '❌ Disabled'}\n` +
        `**Announcement Channel:** ${channelId ? `<#${channelId}>` : '*Not Set*'}\n\n` +
        `**Current Missions:**\n${missionListText}`
      );

    // Row 1: Enable/Disable toggle + Add Mission
    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('missions_toggle')
        .setLabel(enabled ? 'Disable' : 'Enable')
        .setEmoji(enabled ? '✖️' : '✅')
        .setStyle(enabled ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('missions_add_start')
        .setLabel('Add Mission')
        .setEmoji('➕')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(missions.length >= 5)
    );

    // Row 2: Back button
    const backRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('missions_back_rewards')
        .setLabel('Back')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary)
    );

    // Row 2: Numbered buttons for mission selection (1-7)
    const missionButtons = [];
    for (let i = 0; i < Math.max(missions.length, 1); i++) {
      if (i >= missions.length) break;
      missionButtons.push(
        new ButtonBuilder()
          .setCustomId(`missions_select_${missions[i].id}`)
          .setLabel(`${i + 1}`)
          .setStyle(ButtonStyle.Secondary)
      );
    }

    const components = [];
    
    // Row 1: Channel select for announcements (Moving to TOP as requested)
    const channelSelect = new ChannelSelectMenuBuilder()
      .setCustomId('missions_channel_select')
      .setPlaceholder('Select Announcement Channel...')
      .addChannelTypes(ChannelType.GuildText);

    if (channelId) {
      channelSelect.setDefaultChannels([channelId]);
    }
    components.push(new ActionRowBuilder().addComponents(channelSelect));

    // Row 2: Numbered mission buttons (Above main buttons)
    if (missionButtons.length > 0) {
      components.push(new ActionRowBuilder().addComponents(...missionButtons));
    }

    // Row 3: Config/Toggle buttons
    components.push(row1, backRow);

    await interaction.editReply({ embeds: [embed], components, content: null });
  } catch (error) {
    console.error('[Missions] Dashboard error:', error);
  }
}

// ============================================
// MISSION DETAIL VIEW
// ============================================

/**
 * Show details of a single mission
 */
export async function showMissionDetail(interaction, missionId) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

    const mission = await getMission(missionId);
    if (!mission) {
      await interaction.editReply({ content: '❌ Mission not found.', embeds: [], components: [] });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('🎯 Mission Details')
      .setColor('#3498DB')
      .addFields(
        { name: '📺 Channel', value: `<#${mission.channel_id}>`, inline: false },
        { name: '🎮 Actions', value: formatMissionTask(mission).text, inline: false },
        { name: '💰 Rewards', value: `**${Number(mission.reward_coins).toLocaleString()}** Coins`, inline: false }
      );

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`missions_edit_${missionId}`)
        .setLabel('Edit')
        .setEmoji('✏️')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`missions_delete_${missionId}`)
        .setLabel('Delete')
        .setEmoji('🗑️')
        .setStyle(ButtonStyle.Danger)
    );

    const backRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('missions_dashboard')
        .setLabel('Back')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.editReply({ embeds: [embed], components: [row, backRow], content: null });
  } catch (error) {
    console.error('[Missions] Detail error:', error);
  }
}

// ============================================
// ADD MISSION FLOW
// ============================================

/**
 * Step 1: Show channel select for new mission
 */
export async function handleAddMissionStart(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

  const embed = new EmbedBuilder()
    .setTitle('➕ Add Mission — Step 1')
    .setDescription('Select the **target channel** for this mission.')
    .setColor('#2ECC71');

  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId('missions_add_channel')
    .setPlaceholder('Select target channel...')
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildForum);

  const backRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('missions_dashboard')
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

/**
 * Step 2: Channel selected — detect type, show action type select
 */
export async function handleAddChannelSelect(interaction) {
  const channelId = interaction.values[0];
  const guild = interaction.guild;
  const channel = await guild.channels.fetch(channelId).catch(() => null);

  if (!channel) {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    await interaction.editReply({ content: '❌ Channel not found.', embeds: [], components: [] });
    return;
  }

  // Determine channel type
  let channelType = 'text';
  if (channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice) {
    channelType = 'voice';
  } else if (channel.type === ChannelType.GuildForum || channel.type === ChannelType.GuildMedia) {
    channelType = 'media';
  }

  // Save to pending state
  pendingMissionAdd.set(interaction.user.id, { channelId, channelType });

  const actions = getActionsForChannelType(channelType);

  if (actions.length === 1) {
    // Only one option (text → send_messages, voice → voice_minutes): go straight to modal
    pendingMissionAdd.get(interaction.user.id).actionType = actions[0].value;
    // CRITICAL: We DO NOT defer the interaction if we are going to show a modal
    await showAddMissionModal(interaction, actions[0].value);
    return;
  }

  // If we reach here, we are showing an embed (media channel), so we MUST defer if we haven't
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

  // Multiple options (media channel): show action select
  const embed = new EmbedBuilder()
    .setTitle('➕ Add Mission — Step 2')
    .setDescription(`Channel: <#${channelId}> (${channelType})\n\nSelect the **action type** for this mission.`)
    .setColor('#2ECC71');

  const actionSelect = new StringSelectMenuBuilder()
    .setCustomId('missions_add_action')
    .setPlaceholder('Select action type...')
    .addOptions(actions);

  const backRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('missions_dashboard')
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

/**
 * Step 2b: Action type selected from dropdown → show modal
 */
export async function handleAddActionSelect(interaction) {
  const actionType = interaction.values[0];
  const pending = pendingMissionAdd.get(interaction.user.id);
  if (!pending) {
    await interaction.reply({ content: '❌ Session expired. Please start over.', flags: MessageFlags.Ephemeral });
    return;
  }
  pending.actionType = actionType;
  await showAddMissionModal(interaction, actionType);
}

/**
 * Step 3: Show modal for required count + reward
 */
async function showAddMissionModal(interaction, actionType) {
  const actionLabel = formatActionType(actionType);

  const modal = new ModalBuilder()
    .setCustomId('missions_add_modal')
    .setTitle('Mission Configuration');

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

/**
 * Step 4: Modal submitted — save the mission
 */
export async function handleAddMissionModal(interaction) {
  await interaction.deferUpdate();

  const pending = pendingMissionAdd.get(interaction.user.id);
  if (!pending) {
    await interaction.followUp({ content: '❌ Session expired. Please start over.', flags: MessageFlags.Ephemeral });
    return;
  }

  const requiredCount = parseInt(interaction.fields.getTextInputValue('required_count'), 10);
  const rewardCoins = parseInt(interaction.fields.getTextInputValue('reward_coins'), 10);

  // Strict validation: must be positive whole numbers within limits
  if (isNaN(requiredCount) || requiredCount <= 0 || !Number.isInteger(requiredCount) || requiredCount > 10000) {
    await interaction.followUp({ content: '❌ Requirement must be a whole number between **1** and **10,000**.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (isNaN(rewardCoins) || rewardCoins <= 0 || !Number.isInteger(rewardCoins) || rewardCoins > 1000000) {
    await interaction.followUp({ content: '❌ Reward must be a whole number between **1** and **1,000,000**.', flags: MessageFlags.Ephemeral });
    return;
  }

  const result = await addMission(interaction.guildId, {
    channelId: pending.channelId,
    channelType: pending.channelType,
    actionType: pending.actionType,
    requiredCount,
    rewardCoins
  });

  pendingMissionAdd.delete(interaction.user.id);

  if (result.error) {
    await interaction.followUp({ content: `❌ ${result.error}`, flags: MessageFlags.Ephemeral });
    return;
  }

  await showMissionsDashboard(interaction);
}

// ============================================
// EDIT MISSION
// ============================================

export async function handleEditMission(interaction, missionId) {
  const mission = await getMission(missionId);
  if (!mission) {
    await interaction.reply({ content: '❌ Mission not found.', flags: MessageFlags.Ephemeral });
    return;
  }

  const actionLabel = formatActionType(mission.action_type);

  const modal = new ModalBuilder()
    .setCustomId(`missions_edit_modal_${missionId}`)
    .setTitle('Edit Mission');

  const countInput = new TextInputBuilder()
    .setCustomId('required_count')
    .setLabel(`Required Count (${actionLabel})`)
    .setStyle(TextInputStyle.Short)
    .setValue(String(mission.required_count))
    .setRequired(true);

  const rewardInput = new TextInputBuilder()
    .setCustomId('reward_coins')
    .setLabel('Coin Reward')
    .setStyle(TextInputStyle.Short)
    .setValue(String(mission.reward_coins))
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(countInput),
    new ActionRowBuilder().addComponents(rewardInput)
  );

  await interaction.showModal(modal);
}

export async function handleEditMissionModal(interaction) {
  await interaction.deferUpdate();

  const missionId = parseInt(interaction.customId.split('_').pop(), 10);
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

  const success = await updateMission(missionId, { requiredCount, rewardCoins });
  if (!success) {
    await interaction.followUp({ content: '❌ Failed to update mission.', flags: MessageFlags.Ephemeral });
  }

  // Stay on mission details page instead of going back to dashboard
  await showMissionDetail(interaction, missionId);
}

// ============================================
// DELETE MISSION
// ============================================

export async function handleDeleteMission(interaction, missionId) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

  const config = await getGuildConfig(interaction.guildId) || {};

  // If the active mission is the one being deleted, clear it
  if (config.active_mission_id === missionId) {
    config.active_mission_id = null;
    config.active_mission_date = null;
    await setGuildConfig(interaction.guildId, config);
  }

  const success = await deleteMission(missionId);
  if (!success) {
    await interaction.followUp({ content: '❌ Failed to delete.', flags: MessageFlags.Ephemeral });
  }

  await showMissionsDashboard(interaction);
}

// ============================================
// TOGGLE & CHANNEL
// ============================================

export async function handleToggleMissions(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

  const guildId = interaction.guildId;
  const config = await getGuildConfig(guildId) || {};
  config.missions_enabled = !config.missions_enabled;
  await setGuildConfig(guildId, config);

  await showMissionsDashboard(interaction);
}

export async function handleMissionChannelSelect(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

  const channelId = interaction.values[0];
  const guildId = interaction.guildId;
  const config = await getGuildConfig(guildId) || {};
  config.missions_channel_id = channelId;
  await setGuildConfig(guildId, config);

  await showMissionsDashboard(interaction);
}

// ============================================
// COMPONENT ROUTER
// ============================================

/**
 * Route all missions_ prefixed interactions
 */
export async function handleMissionsComponent(interaction) {
  const customId = interaction.customId;

  if (customId === 'missions_dashboard') {
    await showMissionsDashboard(interaction);
  } else if (customId === 'missions_toggle') {
    await handleToggleMissions(interaction);
  } else if (customId === 'missions_add_start') {
    await handleAddMissionStart(interaction);
  } else if (customId === 'missions_add_channel') {
    await handleAddChannelSelect(interaction);
  } else if (customId === 'missions_add_action') {
    await handleAddActionSelect(interaction);
  } else if (customId === 'missions_channel_select') {
    await handleMissionChannelSelect(interaction);
  } else if (customId === 'missions_back_rewards') {
    const { handleRewardsSetup } = await import('./rewards.js');
    await handleRewardsSetup(interaction);
  } else if (customId.startsWith('missions_select_')) {
    const missionId = parseInt(customId.split('_').pop(), 10);
    await showMissionDetail(interaction, missionId);
  } else if (customId.startsWith('missions_edit_') && !customId.includes('modal')) {
    const missionId = parseInt(customId.split('_').pop(), 10);
    await handleEditMission(interaction, missionId);
  } else if (customId.startsWith('missions_delete_')) {
    const missionId = parseInt(customId.split('_').pop(), 10);
    await handleDeleteMission(interaction, missionId);
  }
}

/**
 * Route missions modal submissions
 */
export async function handleMissionsModal(interaction) {
  const customId = interaction.customId;

  if (customId === 'missions_add_modal') {
    await handleAddMissionModal(interaction);
  } else if (customId.startsWith('missions_edit_modal_')) {
    await handleEditMissionModal(interaction);
  }
}
