import { EmbedBuilder, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { sanitizeError } from '../shared.js';
import { sysLog, sysError } from './logger.js';

/**
 * Create a standardized error embed
 */
export function createErrorEmbed(title, description) {
  return new EmbedBuilder()
    .setColor(0xFF0000)
    .setTitle(`❌ ${title}`)
    .setDescription(description);
}

/**
 * Create a standardized success embed
 */
export function createSuccessEmbed(title, description) {
  return new EmbedBuilder()
    .setColor(0x00FF00)
    .setTitle(`✅ ${title}`)
    .setDescription(description);
}

/**
 * Diagnose missing channel permissions for the bot
 */
export function diagnoseChannelPermissions(channel, botMember, requiredPerms = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks
]) {
  if (!channel || !channel.permissionsFor) {
    return {
      hasAll: false,
      missing: ['View Channel'],
      explanation: 'Channel not found or bot lacks access.',
      fixInstructions: 'Ensure the channel exists and the bot has access to it.'
    };
  }

  const botPermissions = channel.permissionsFor(botMember);
  if (!botPermissions) {
    return {
      hasAll: false,
      missing: ['View Channel'],
      explanation: 'Unable to evaluate bot permissions in channel.',
      fixInstructions: `Ensure the bot has "View Channel" permission in <#${channel.id}>.`
    };
  }

  const missing = [];
  if (!botPermissions.has(PermissionFlagsBits.ViewChannel)) missing.push('View Channel');
  if (!botPermissions.has(PermissionFlagsBits.SendMessages)) missing.push('Send Messages');
  if (!botPermissions.has(PermissionFlagsBits.EmbedLinks)) missing.push('Embed Links');
  if (!botPermissions.has(PermissionFlagsBits.UseExternalEmojis)) missing.push('Use External Emojis');
  if (!botPermissions.has(PermissionFlagsBits.ReadMessageHistory)) missing.push('Read Message History');

  // Check custom required permissions if passed
  const customMissing = requiredPerms
    .filter(flag => !botPermissions.has(flag))
    .map(flag => {
      if (flag === PermissionFlagsBits.ViewChannel) return 'View Channel';
      if (flag === PermissionFlagsBits.SendMessages) return 'Send Messages';
      if (flag === PermissionFlagsBits.EmbedLinks) return 'Embed Links';
      if (flag === PermissionFlagsBits.ManageRoles) return 'Manage Roles';
      if (flag === PermissionFlagsBits.ManageMessages) return 'Manage Messages';
      return 'Required Permission';
    });

  const allMissing = Array.from(new Set([...missing, ...customMissing]));
  const hasAll = allMissing.length === 0;

  let explanation = '';
  let fixInstructions = '';

  if (!hasAll) {
    const channelMention = `<#${channel.id}>`;
    explanation = `The bot is missing the following permissions in ${channelMention}: ${allMissing.map(p => `**${p}**`).join(', ')}.`;
    fixInstructions = `1. Open **Channel Settings** for ${channelMention}\n2. Navigate to **Permissions** > Add **${botMember?.displayName || 'Toru Bot'}** (or Bot Role)\n3. Enable ${allMissing.map(p => `**${p}**`).join(', ')}\n4. Click **Save Changes** and retry the action.`;
  }

  return { hasAll, missing: allMissing, explanation, fixInstructions };
}

/**
 * Diagnose missing role permissions or hierarchy locks
 */
export function diagnoseRolePermissions(guild, role, botMember) {
  if (!guild || !role || !botMember) {
    return {
      hasAll: false,
      explanation: 'Invalid guild, role, or bot member context.',
      fixInstructions: 'Ensure the role exists in the server.'
    };
  }

  const botPermissions = guild.members.me?.permissions;
  const hasManageRoles = botPermissions?.has(PermissionFlagsBits.ManageRoles);

  if (!hasManageRoles) {
    return {
      hasAll: false,
      explanation: 'The bot lacks the **Manage Roles** permission at the server level.',
      fixInstructions: '1. Go to **Server Settings** > **Roles**\n2. Edit the bot\'s role and enable **Manage Roles**.'
    };
  }

  if (role.managed) {
    return {
      hasAll: false,
      explanation: `The role **${role.name}** is managed by an integration or bot and cannot be assigned manually.`,
      fixInstructions: 'Select a standard server role instead of a bot-managed role.'
    };
  }

  const botHighestPosition = botMember.roles.highest.position;
  if (botHighestPosition <= role.position) {
    return {
      hasAll: false,
      explanation: `Role hierarchy block: The bot's highest role is lower than or equal to **${role.name}**.`,
      fixInstructions: `1. Go to **Server Settings** > **Roles**\n2. Drag the bot's highest role above **${role.name}**.`
    };
  }

  return {
    hasAll: true,
    explanation: 'Role permissions and hierarchy are valid.',
    fixInstructions: ''
  };
}

/**
 * Handle interaction errors uniformly with smart permission diagnostics
 */
export async function handleInteractionError(interaction, error, context = 'Action Handler', options = {}) {
  // 10062 is "Unknown interaction" (token expired).
  if (error?.code !== 10062) {
    sysError('Interaction Audit Failure', error, { 
      user: interaction?.user?.id, 
      guild: interaction?.guildId, 
      detail: context 
    });
  }

  if (!interaction) return;

  const rawErrorMessage = error?.message || String(error);
  const errorCode = error?.code;

  const isPermissionError = 
    errorCode === 50013 || 
    errorCode === 50001 || 
    rawErrorMessage.includes('Missing Permissions') || 
    rawErrorMessage.includes('Missing Access');

  const embed = new EmbedBuilder()
    .setColor('#E74C3C')
    .setTimestamp();

  const botMember = interaction.guild?.members?.me;
  const targetChannel = options.targetChannel || interaction.channel;
  const targetRole = options.targetRole;

  if (isPermissionError) {
    embed.setTitle('❌ Missing Permissions');

    let channelDiag = null;
    if (targetChannel) {
      channelDiag = diagnoseChannelPermissions(targetChannel, botMember);
    }

    let roleDiag = null;
    if (targetRole) {
      roleDiag = diagnoseRolePermissions(interaction.guild, targetRole, botMember);
    }

    if (channelDiag && !channelDiag.hasAll) {
      embed.setDescription(`${channelDiag.explanation}\n\n${channelDiag.fixInstructions}`);
    } else if (roleDiag && !roleDiag.hasAll) {
      embed.setDescription(`${roleDiag.explanation}\n\n${roleDiag.fixInstructions}`);
    } else {
      // General Discord Permission Error fallback
      embed.setDescription(
        `Discord API returned **${errorCode || 'Permission Error'}**: ${sanitizeError(rawErrorMessage)}\n\nEnsure the bot has **Administrator** or proper **Channel / Role Permissions** (Send Messages, Embed Links, Manage Roles) in your server settings.`
      );
    }
  } else {
    // Non-permission operational error
    embed.setTitle('❌ Action Execution Failed');
    embed.addFields(
      { name: '📍 Action', value: `\`${context}\``, inline: false },
      { name: '🔍 Error Details', value: `\`\`\`${sanitizeError(rawErrorMessage).slice(0, 500)}\`\`\``, inline: false },
      { name: '💡 Resolution', value: 'If this issue persists, please check your configuration or contact a server administrator.', inline: false }
    );
  }

  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ 
        embeds: [embed], 
        flags: MessageFlags.Ephemeral 
      }).catch(() => {
        return interaction.editReply({ embeds: [embed] }).catch(() => {});
      });
    } else {
      await interaction.reply({ 
        embeds: [embed], 
        flags: MessageFlags.Ephemeral 
      }).catch(() => {});
    }
  } catch (e) {
    // Ignore fallback failures when interaction token has expired
  }
}
