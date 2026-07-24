import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  ChannelSelectMenuBuilder,
  ChannelType
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
  formatQuestTask,
  formatCompactQuest
} from '../quests/quests.js';
import { sysError, sysLog } from '../utils/logger.js';
import { handleInteractionError } from '../utils/errors.js';

// Temporary storage for add-Quest flow (userId -> { channelId, channelType })
const pendingQuestAdd = new Map();

// ============================================
// MAIN DASHBOARD
// ============================================

/**
 * Show the Quests Dashboard (Main Page)
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

    const enabled = config.quests_enabled ?? config.missions_enabled ?? false;
    const refreshes = config.quests_refreshes_per_day || 1;
    const perRefresh = config.quests_per_refresh || 3;

    // Build Quest list display
    let questListText = quests.length === 0
      ? '*No quests created yet.*'
      : quests.map((m, i) => `**${i + 1}.** <#${m.channel_id}> → ${formatQuestTask(m).text} → **${Number(m.reward_coins).toLocaleString()}** coins`).join('\n');

    const embed = new EmbedBuilder()
      .setTitle('🎯 Quests Control Panel')
      .setColor(enabled ? '#2ECC71' : '#95A5A6')
      .setDescription(
        `**Status:** ${enabled ? '✅ Enabled' : '❌ Disabled'}\n\n${questListText}`
      );

    // Row 1: Buttons 1-5
    const row1 = new ActionRowBuilder();
    for (let i = 1; i <= 5; i++) {
      const quest = quests[i - 1];
      row1.addComponents(
        new ButtonBuilder()
          .setCustomId(quest ? `quests_select_${quest.id}` : `quests_empty_${i}`)
          .setLabel(`${i}`)
          .setStyle(quest ? ButtonStyle.Secondary : ButtonStyle.Secondary)
          .setDisabled(!quest)
      );
    }

    // Row 2: Buttons 6-10
    const row2 = new ActionRowBuilder();
    for (let i = 6; i <= 10; i++) {
      const quest = quests[i - 1];
      row2.addComponents(
        new ButtonBuilder()
          .setCustomId(quest ? `quests_select_${quest.id}` : `quests_empty_${i}`)
          .setLabel(`${i}`)
          .setStyle(quest ? ButtonStyle.Secondary : ButtonStyle.Secondary)
          .setDisabled(!quest)
      );
    }

    // Row 3: Disable/Enable, Add Quest, Schedule
    const row3 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('quests_toggle')
        .setLabel(enabled ? 'Disable' : 'Enable')
        .setEmoji(enabled ? '✖️' : '▶️')
        .setStyle(enabled ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('quests_add_start')
        .setLabel('Add Quest')
        .setEmoji('➕')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(quests.length >= 10),
      new ButtonBuilder()
        .setCustomId('quests_schedule_view')
        .setLabel('Schedule')
        .setEmoji('🕒')
        .setStyle(ButtonStyle.Secondary)
    );

    // Row 4: Back
    const row4 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('settings_coins')
        .setLabel('Back to Coins')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.editReply({
      embeds: [embed],
      components: [row1, row2, row3, row4],
      content: null
    });
  } catch (error) {
    await handleInteractionError(interaction, error, 'Quest dashboard render');
  }
}

// ============================================
// SCHEDULE SUB-MENU
// ============================================

/**
 * Show the Schedule Configuration Page
 */
export async function showQuestsSchedule(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

    const guildId = interaction.guildId;
    const config = await getGuildConfig(guildId) || {};

    const refreshes = config.quests_refreshes_per_day || 1;
    let perRefresh = config.quests_per_refresh || 3;
    
    const quests = await getQuests(guildId);
    const totalQuests = quests.length;

    // AUTO-SHRINK: If pool is now smaller than the setting (e.g. after deletion), 
    // cap the setting at the max available pool size to keep UI consistent.
    if (totalQuests > 0 && perRefresh > totalQuests) {
        perRefresh = totalQuests;
        config.quests_per_refresh = perRefresh;
        await setGuildConfig(guildId, config);
        sysLog('Quest Setting Auto-Shrink', { guild: guildId, detail: `Capped per_refresh at ${perRefresh} due to pool size` });
    }

    const embed = new EmbedBuilder()
      .setTitle('📅 Quest Rotation Schedule')
      .setDescription(`Current Pool: **${totalQuests} quest(s)** available.`)
      .setColor('#3498DB');

    // Dropdown for Quests Per Refresh (1-10, limited by pool size)
    const maxOptions = Math.max(1, Math.min(10, totalQuests));
    const perRefreshMenu = new StringSelectMenuBuilder()
      .setCustomId('quests_setting_per_refresh')
      .setPlaceholder('Quests per Refresh...')
      .addOptions(
        Array.from({ length: maxOptions }, (_, i) => ({
          label: `${i + 1} Quest${i === 0 ? '' : 's'}`,
          value: `${i + 1}`,
          default: perRefresh === (i + 1)
        }))
      );

    // Dropdown for Refreshes Per Day (1x, 2x, 4x)
    const refreshesMenu = new StringSelectMenuBuilder()
      .setCustomId('quests_setting_refreshes')
      .setPlaceholder('Refreshes per Day...')
      .addOptions([
        { label: '1x Daily (12 AM)', value: '1', default: refreshes === 1 },
        { label: '2x Daily (12 AM, 12 PM)', value: '2', default: refreshes === 2 },
        { label: '4x Daily (12 AM, 6 AM, 12 PM, 6 PM)', value: '4', default: refreshes === 4 }
      ]);

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
        new ActionRowBuilder().addComponents(perRefreshMenu),
        new ActionRowBuilder().addComponents(refreshesMenu),
        backRow
      ]
    });
  } catch (error) {
    await handleInteractionError(interaction, error, 'Quest schedule view');
  }
}

/**
 * Handle schedule dropdown updates
 */
export async function handleQuestsScheduleUpdate(interaction) {
  try {
    const guildId = interaction.guildId;
    const config = await getGuildConfig(guildId) || {};
    const quests = await getQuests(guildId);
    const maxAllowed = Math.max(1, quests.length);

    if (interaction.customId === 'quests_setting_per_refresh') {
      const perRefresh = parseInt(interaction.values[0], 10);
      config.quests_per_refresh = Math.min(perRefresh, maxAllowed);
    } else if (interaction.customId === 'quests_setting_refreshes') {
      config.quests_refreshes_per_day = parseInt(interaction.values[0], 10);
    }

    await setGuildConfig(guildId, config);
    const { syncQuestChannelCache } = await import('../activity/index.js');
    await syncQuestChannelCache(guildId);
    await showQuestsSchedule(interaction);
  } catch (error) {
    await handleInteractionError(interaction, error, 'Quest schedule update');
  }
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
    await handleInteractionError(interaction, error, 'Quest detail render');
  }
}

// ============================================
// ADD Quest FLOW
// ============================================

export async function handleAddQuestStart(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

    const embed = new EmbedBuilder()
      .setTitle('➕ Add to Pool — Step 1')
      .setDescription('Select the **target channel** for this quest.')
      .setColor('#2ECC71');

    const channelSelect = new ChannelSelectMenuBuilder()
      .setCustomId('quests_add_channel')
      .setPlaceholder('Select target channel...')
      .addChannelTypes(
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement,
        ChannelType.GuildForum,
        ChannelType.GuildMedia,
        ChannelType.GuildVoice,
        ChannelType.GuildStageVoice
      );

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
  } catch (error) {
    await handleInteractionError(interaction, error, 'Add quest start');
  }
}

export async function handleAddChannelSelect(interaction) {
  try {
    // CRITICAL: Do NOT defer yet. showModal() must be the FIRST response.
    const channelId = interaction.values[0];
    const guild = interaction.guild;
    const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);

    if (!channel) {
      return interaction.reply({ content: '❌ Channel not found.', flags: MessageFlags.Ephemeral });
    }

    // Classify into our 3 internal channel type buckets:
    //   'voice'        → voice_minutes quest only
    //   'text'/'media' → full text engagement set (Send, Upload, React)
    let channelType = 'text';
    if (channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice) {
      channelType = 'voice';
    } else if (channel.type === ChannelType.GuildForum || channel.type === ChannelType.GuildMedia) {
      channelType = 'media';
    }
    // GuildText and GuildAnnouncement both fall through to 'text' (full action set)

    pendingQuestAdd.set(interaction.user.id, { channelId, channelType });
    const actions = getActionsForChannelType(channelType);

    if (actions.length === 1) {
      pendingQuestAdd.get(interaction.user.id).actionType = actions[0].value;
      await showAddQuestModal(interaction, actions[0].value);
      return;
    }

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

    await interaction.update({
      embeds: [embed],
      components: [
        new ActionRowBuilder().addComponents(actionSelect),
        backRow
      ],
      content: null
    });
  } catch (error) {
    await handleInteractionError(interaction, error, 'Add quest channel select');
  }
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
  try {
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
  } catch (error) {
    await handleInteractionError(interaction, error, 'Add quest modal submit');
  }
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

  const actionLabel = formatActionType(quest.action_type, quest.channel_type);

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
  try {
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
      return;
    }

    await showQuestDetail(interaction, questId);
  } catch (error) {
    await handleInteractionError(interaction, error, 'Edit quest modal submit');
  }
}

// ============================================
// DELETE Quest
// ============================================

export async function handleDeleteQuest(interaction, questId) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

    const success = await deleteQuest(questId);
    if (!success) {
      await interaction.followUp({ content: '❌ Failed to delete.', flags: MessageFlags.Ephemeral });
    }

    await showQuestsDashboard(interaction);
  } catch (error) {
    await handleInteractionError(interaction, error, 'Delete quest');
  }
}

// ============================================
// TOGGLE
// ============================================

export async function handleToggleQuests(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

    const guildId = interaction.guildId;
    const config = await getGuildConfig(guildId) || {};
    config.quests_enabled = !(config.quests_enabled ?? config.missions_enabled ?? false);
    const isEnabled = config.quests_enabled;

    if (!isEnabled) {
      // ── DISABLE: Full nuclear wipe ────────────────────────────────────────
      config.active_quest_snapshot = null;
      config.active_quest_ids = [];
      await setGuildConfig(guildId, config);

      // Wipe in-memory tracking caches immediately
      const { syncQuestChannelCache } = await import('../activity/index.js');
      await syncQuestChannelCache(guildId);

      // Hard-delete ALL quest_progress rows for this guild so the background
      // engine has zero rows to pay out against.
      const { getPool } = await import('../storage/postgres.js');
      await getPool().query('DELETE FROM quest_progress WHERE guild_id = $1', [guildId]);

      sysLog('Quest System Disabled', { guild: guildId, detail: 'Snapshot wiped, DB progress purged, caches cleared' });
    } else {
      // ── ENABLE: Fresh rotation right now ─────────────────────────────────
      config.active_quest_snapshot = null;
      config.active_quest_ids = [];
      await setGuildConfig(guildId, config);

      const poolQuests = await getQuests(guildId);
      if (poolQuests.length > 0) {
        const { rotateGuildQuests } = await import('../cron/quests.js');
        const { getPool } = await import('../storage/postgres.js');
        // rotateGuildQuests saves the new snapshot and calls syncQuestChannelCache internally
        await rotateGuildQuests(guildId, config, getPool());
      } else {
        // No quests in pool – still sync so cache is clean
        const { syncQuestChannelCache } = await import('../activity/index.js');
        await syncQuestChannelCache(guildId);
      }

      sysLog('Quest System Enabled', { guild: guildId, detail: 'Fresh rotation triggered immediately' });
    }

    await showQuestsDashboard(interaction);
  } catch (error) {
    await handleInteractionError(interaction, error, 'Toggle quests');
  }
}

// ============================================
// COMPONENT ROUTER
// ============================================

export async function handleQuestsComponent(interaction) {
  try {
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
    } else if (customId === 'quests_schedule_view') {
      await showQuestsSchedule(interaction);
    } else if (customId === 'quests_setting_per_refresh' || customId === 'quests_setting_refreshes') {
      await handleQuestsScheduleUpdate(interaction);
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
  } catch (error) {
    await handleInteractionError(interaction, error, 'Quest component router');
  }
}

export async function handleQuestsModal(interaction) {
  try {
    const customId = interaction.customId;

    if (customId === 'quests_add_modal') {
      await handleAddQuestModal(interaction);
    } else if (customId.startsWith('quests_edit_modal_')) {
      await handleEditQuestModal(interaction);
    }
  } catch (error) {
    await handleInteractionError(interaction, error, 'Quest modal router');
  }
}
