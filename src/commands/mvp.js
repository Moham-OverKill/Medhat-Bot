import { MessageFlags, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, RoleSelectMenuBuilder, ChannelSelectMenuBuilder, ChannelType } from 'discord.js';
import { getGuildConfig, setGuildConfig } from '../storage/config.js';
import { showStats, showLeaderboard, testMvpAward } from '../mvp/panel.js';
import { scheduleMvpTimer, cancelMvpTimer } from '../mvp/scheduler.js';

// In-memory draft storage
const draftConfigs = new Map();

export async function handleMvpCommand(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  
  const guildId = interaction.guildId;
  const savedConfig = await getGuildConfig(guildId);
  
  // Show setup panel
  await showSetupPanel(interaction, savedConfig);
}

async function showSetupPanel(interaction, savedConfig) {
  const guildId = interaction.guildId;
  const draft = draftConfigs.get(guildId) || { ...savedConfig } || {};
  
  const embed = new EmbedBuilder()
    .setTitle('⚙️ MVP Control Panel')
    .setColor(0x0099FF)
    .setDescription(!savedConfig ? '⚠️ MVP system not configured yet. Please configure and save settings.' : null);

  const components = [];

  // MVP Role Selector
  const roleSelect = new RoleSelectMenuBuilder()
    .setCustomId('mvp_role_select')
    .setPlaceholder('Select MVP Role')
    .setDefaultRoles(draft.mvpRoleId ? [draft.mvpRoleId] : []);
  
  components.push(
    new ActionRowBuilder().addComponents(roleSelect)
  );

  // Announcement Channel Selector
  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId('mvp_channel_select')
    .setPlaceholder('Select Announcement Channel')
    .setChannelTypes([
      ChannelType.GuildText,
      ChannelType.GuildPublicThread,
      ChannelType.GuildPrivateThread
    ])
    .setDefaultChannels(draft.announceChannelId ? [draft.announceChannelId] : []);
  
  components.push(
    new ActionRowBuilder().addComponents(channelSelect)
  );

  // Schedule Selector
  const scheduleOptions = [
    { label: 'Every 1 hour', value: '1h' },
    { label: 'Every 12 hours', value: '12h' },
    { label: 'Every 24 hours', value: '24h' },
    { label: 'Every 1 week', value: '1w' }
  ];
  
  const currentSchedule = draft.intervalNumber && draft.intervalUnit 
    ? `${draft.intervalNumber}${draft.intervalUnit.charAt(0)}`
    : '24h';
  
  const scheduleSelect = new StringSelectMenuBuilder()
    .setCustomId('mvp_schedule_select')
    .setPlaceholder('Select Schedule')
    .addOptions(scheduleOptions.map(option => ({
      ...option,
      default: option.value === currentSchedule
    })));
  
  components.push(
    new ActionRowBuilder().addComponents(scheduleSelect)
  );

  // Winners Count Selector
  const winnersOptions = Array.from({ length: 5 }, (_, i) => ({
    label: `${i + 1}`,
    value: String(i + 1),
    default: (draft.winnersCount || 1) === i + 1
  }));
  
  const winnersSelect = new StringSelectMenuBuilder()
    .setCustomId('mvp_winners_select')
    .setPlaceholder('How many winners?')
    .addOptions(winnersOptions);
  
  components.push(
    new ActionRowBuilder().addComponents(winnersSelect)
  );

  // Action Buttons
  const buttonRow = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('mvp_stats')
        .setLabel('📊 Stats')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('mvp_leaderboard')
        .setLabel('🏆 Leaderboard')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('mvp_test')
        .setLabel('▶️ Test')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('mvp_save')
        .setLabel('💾 Save')
        .setStyle(ButtonStyle.Success)
    );
  
  components.push(buttonRow);

  await interaction.editReply({
    embeds: [embed],
    components: components
  });
}

// Handle component interactions
export async function handleMvpComponent(interaction) {
  const guildId = interaction.guildId;
  const customId = interaction.customId;
  
  // Ensure draft exists
  if (!draftConfigs.has(guildId)) {
    const savedConfig = await getGuildConfig(guildId);
    draftConfigs.set(guildId, { ...savedConfig } || {});
  }
  const draft = draftConfigs.get(guildId);

  switch (customId) {
    case 'mvp_role_select':
      draft.mvpRoleId = interaction.values[0];
      await showSetupPanel(interaction, await getGuildConfig(guildId));
      break;
      
    case 'mvp_channel_select':
      draft.announceChannelId = interaction.values[0];
      await showSetupPanel(interaction, await getGuildConfig(guildId));
      break;
      
    case 'mvp_schedule_select':
      const scheduleValue = interaction.values[0];
      if (scheduleValue === '1w') {
        draft.intervalNumber = 1;
        draft.intervalUnit = 'weeks';
      } else {
        draft.intervalNumber = parseInt(scheduleValue.slice(0, -1));
        draft.intervalUnit = 'hours';
      }
      await showSetupPanel(interaction, await getGuildConfig(guildId));
      break;
      
    case 'mvp_winners_select':
      draft.winnersCount = parseInt(interaction.values[0]);
      await showSetupPanel(interaction, await getGuildConfig(guildId));
      break;
      
    case 'mvp_stats':
      await showStats(interaction);
      break;
      
    case 'mvp_leaderboard':
      await showLeaderboard(interaction);
      break;
      
    case 'mvp_test':
      await testMvpAward(interaction);
      break;
      
    case 'mvp_save':
      await saveConfig(interaction, draft);
      break;
      
    case 'mvp_back':
      await showSetupPanel(interaction, await getGuildConfig(guildId));
      break;
  }
}

async function saveConfig(interaction, draft) {
  // Validate config
  if (!draft.mvpRoleId || !draft.announceChannelId) {
    await interaction.update({
      content: '❌ Please select both an MVP role and announcement channel before saving.',
      embeds: [],
      components: []
    });
    return;
  }

  // Save to storage
  await setGuildConfig(interaction.guildId, draft);
  
  // Clear draft
  draftConfigs.delete(interaction.guildId);
  
  // Reschedule timer
  await cancelMvpTimer(interaction.guildId);
  await scheduleMvpTimer(interaction.client, interaction.guildId);
  
  await interaction.update({
    content: '✅ Configuration saved successfully!',
    embeds: [],
    components: []
  });
}
