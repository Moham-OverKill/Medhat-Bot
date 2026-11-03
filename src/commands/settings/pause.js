import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  MessageFlags
} from 'discord.js';
import {
  getServerPauseState,
  updateServerPauseWhitelist
} from '../../storage/pause.js';
import {
  executeServerLockdown,
  executeServerUnpause
} from './pause-engine.js';
import { isBackDisabled } from '../../shared.js';
import { handleInteractionError } from '../../utils/errors.js';
import { sysWarn } from '../../utils/logger.js';

/**
 * Render the main Server Lockdown panel based on current pause state.
 * 
 * @param {import('discord.js').Interaction} interaction
 */
export async function showServerLockdownPanel(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      if (interaction.isMessageComponent && interaction.isMessageComponent()) {
        await interaction.deferUpdate().catch(() => {});
      } else {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }

    const guildId = interaction.guildId;
    const state = await getServerPauseState(guildId);
    const fromAdminHub = isBackDisabled(interaction);

    if (state.is_paused) {
      // --- ACTIVE LOCKDOWN VIEW ---
      const pausedTimeStr = state.paused_at
        ? `<t:${Math.floor(state.paused_at.getTime() / 1000)}:R>`
        : '_Active_';

      const whitelistSummary = state.whitelist_channel_ids.length > 0
        ? state.whitelist_channel_ids.map(id => `<#${id}>`).join(', ')
        : '_None (All channels hidden)_';

      const embed = new EmbedBuilder()
        .setTitle('⚠️ SERVER LOCKED DOWN (PAUSED)')
        .setColor(0xE74C3C)
        .setDescription(
          `**Status:** 🛑 **Locked Down**\n` +
          `**Active Since:** ${pausedTimeStr}\n\n` +
          `**Whitelisted Channels (Visible):**\n↳ ${whitelistSummary}\n\n` +
          `All non-whitelisted channels are currently hidden from non-admin members.\n` +
          `Existing permissions are securely stored in the database. Click **Unpause Server** below to restore everything.`
        );

      const actionRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('settings_back')
          .setLabel('Back')
          .setEmoji('⬅️')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(fromAdminHub),
        new ButtonBuilder()
          .setCustomId('settings_hint_pause')
          .setEmoji('❔')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('pause_unpause_prompt')
          .setLabel('Unpause Server')
          .setEmoji('🟢')
          .setStyle(ButtonStyle.Success)
      );

      return interaction.editReply({
        files: [],
        attachments: [],
        content: null,
        embeds: [embed],
        components: [actionRow]
      });
    }

    // --- PRE-PAUSE CONFIGURATION VIEW ---
    const whitelistSummary = state.whitelist_channel_ids.length > 0
      ? state.whitelist_channel_ids.map(id => `<#${id}>`).join(', ')
      : '_None (All channels will be hidden)_';

    const embed = new EmbedBuilder()
      .setTitle('Server Lockdown (Pause)')
      .setColor(0x3498DB)
      .setDescription(
        `Temporarily hide your server from regular members during emergencies, raids, or maintenance.\n\n` +
        `**Current Status:** 🟢 **Normal (Active)**\n` +
        `**Whitelisted Channels (Will Stay Visible):**\n↳ ${whitelistSummary}\n\n` +
        `*Select channels below that should remain visible to members during the lockdown.*`
      );

    const channelSelect = new ChannelSelectMenuBuilder()
      .setCustomId('pause_whitelist_select')
      .setPlaceholder('Select channels to keep visible (Whitelist)...')
      .setChannelTypes(
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement,
        ChannelType.GuildForum,
        ChannelType.GuildVoice
      )
      .setMinValues(0)
      .setMaxValues(Math.min(25, Math.max(1, interaction.guild?.channels?.cache?.size || 25)));

    // Pre-select existing whitelisted channels that still exist in the guild
    if (state.whitelist_channel_ids.length > 0) {
      const validChannels = state.whitelist_channel_ids
        .filter(id => interaction.guild?.channels?.cache?.has(id))
        .slice(0, 25);
      if (validChannels.length > 0) {
        channelSelect.setDefaultChannels(validChannels);
      }
    }

    const selectRow = new ActionRowBuilder().addComponents(channelSelect);

    const actionRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('settings_back')
        .setLabel('Back')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(fromAdminHub),
      new ButtonBuilder()
        .setCustomId('settings_hint_pause')
        .setEmoji('❔')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('pause_prompt_confirm')
        .setLabel('Pause Server')
        .setEmoji('🛑')
        .setStyle(ButtonStyle.Danger)
    );

    await interaction.editReply({
      files: [],
      attachments: [],
      content: null,
      embeds: [embed],
      components: [selectRow, actionRow]
    });
  } catch (error) {
    await handleInteractionError(interaction, error, 'show server lockdown panel');
  }
}

/**
 * Show the pre-pause confirmation warning screen.
 * 
 * @param {import('discord.js').Interaction} interaction
 */
export async function showPauseConfirmScreen(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => {});
    }

    const state = await getServerPauseState(interaction.guildId);
    const whitelistSummary = state.whitelist_channel_ids.length > 0
      ? state.whitelist_channel_ids.map(id => `<#${id}>`).join(', ')
      : '_None_';

    const embed = new EmbedBuilder()
      .setTitle('⚠️ Confirm Server Lockdown')
      .setColor(0xE67E22)
      .setDescription(
        `Are you sure you want to lock down the server?\n\n` +
        `• **All non-whitelisted channels will be hidden** from regular members immediately.\n` +
        `• **Whitelisted channels will stay visible:** ${whitelistSummary}\n` +
        `• Existing permissions will be safely backed up to the database.\n` +
        `• You can restore all channels and settings at any time by clicking **Unpause**.`
      );

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('pause_cancel_prompt')
        .setLabel('Cancel')
        .setEmoji('❌')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('pause_execute_lockdown')
        .setLabel('Confirm Lockdown')
        .setEmoji('🛑')
        .setStyle(ButtonStyle.Danger)
    );

    await interaction.editReply({
      files: [],
      attachments: [],
      content: null,
      embeds: [embed],
      components: [row]
    });
  } catch (error) {
    await handleInteractionError(interaction, error, 'show pause confirm screen');
  }
}

/**
 * Show the unpause confirmation screen.
 * 
 * @param {import('discord.js').Interaction} interaction
 */
export async function showUnpauseConfirmScreen(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => {});
    }

    const embed = new EmbedBuilder()
      .setTitle('🟢 Confirm Server Unpause')
      .setColor(0x2ECC71)
      .setDescription(
        `Are you sure you want to unpause the server?\n\n` +
        `• All channel permissions will be restored back to their exact original pre-pause state.\n` +
        `• Regular members will regain normal access to their channels.\n` +
        `• Backups will be safely verified and cleaned up.`
      );

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('pause_cancel_unpause_prompt')
        .setLabel('Cancel')
        .setEmoji('❌')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('pause_execute_unpause')
        .setLabel('Confirm Unpause')
        .setEmoji('🟢')
        .setStyle(ButtonStyle.Success)
    );

    await interaction.editReply({
      files: [],
      attachments: [],
      content: null,
      embeds: [embed],
      components: [row]
    });
  } catch (error) {
    await handleInteractionError(interaction, error, 'show unpause confirm screen');
  }
}

/**
 * Handle updating the whitelist channels from the channel select menu.
 * 
 * @param {import('discord.js').ChannelSelectMenuInteraction} interaction
 */
export async function handlePauseWhitelistSelect(interaction) {
  try {
    const selectedChannelIds = interaction.values || [];
    await updateServerPauseWhitelist(interaction.guildId, selectedChannelIds);
    await showServerLockdownPanel(interaction);
  } catch (error) {
    await handleInteractionError(interaction, error, 'pause whitelist select');
  }
}

/**
 * Execute the lockdown following explicit confirmation.
 * 
 * @param {import('discord.js').ButtonInteraction} interaction
 */
export async function handlePauseExecute(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => {});
    }

    // Show temporary progress state
    const progressEmbed = new EmbedBuilder()
      .setTitle('⏳ Locking Down Server...')
      .setColor(0xF1C40F)
      .setDescription('Backing up permissions and locking down channels. Please wait...');

    await interaction.editReply({
      files: [],
      attachments: [],
      content: null,
      embeds: [progressEmbed],
      components: []
    });

    const state = await getServerPauseState(interaction.guildId);
    const result = await executeServerLockdown(interaction.guild, interaction.user, state.whitelist_channel_ids);

    if (!result.success) {
      return interaction.followUp({
        content: `❌ Lockdown aborted: ${result.error || 'Unknown error'}`,
        flags: MessageFlags.Ephemeral
      });
    }

    await showServerLockdownPanel(interaction);

    await interaction.followUp({
      content: `🛑 **Server Lockdown Activated**: ${result.lockedCount} channels locked. (${result.whitelistedCount} whitelisted)`,
      flags: MessageFlags.Ephemeral
    });
  } catch (error) {
    await handleInteractionError(interaction, error, 'pause execute');
  }
}

/**
 * Execute unpause following explicit confirmation.
 * 
 * @param {import('discord.js').ButtonInteraction} interaction
 */
export async function handleUnpauseExecute(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => {});
    }

    // Show temporary progress state
    const progressEmbed = new EmbedBuilder()
      .setTitle('⏳ Unpausing Server...')
      .setColor(0xF1C40F)
      .setDescription('Restoring channel permissions and server settings. Please wait...');

    await interaction.editReply({
      files: [],
      attachments: [],
      content: null,
      embeds: [progressEmbed],
      components: []
    });

    const result = await executeServerUnpause(interaction.guild, interaction.user);

    if (!result.success) {
      return interaction.followUp({
        content: `❌ Unpause failed: ${result.error || 'Unknown error'}`,
        flags: MessageFlags.Ephemeral
      });
    }

    await showServerLockdownPanel(interaction);

    let feedback = `🟢 **Server Unpaused**: ${result.restoredChannelsCount} channels restored to original state.`;
    if (result.skippedChannelsCount > 0) {
      feedback += ` (${result.skippedChannelsCount} channels were deleted or inaccessible and skipped)`;
    }

    await interaction.followUp({
      content: feedback,
      flags: MessageFlags.Ephemeral
    });
  } catch (error) {
    await handleInteractionError(interaction, error, 'unpause execute');
  }
}
