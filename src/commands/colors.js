import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  RoleSelectMenuBuilder,
  MessageFlags
} from 'discord.js';
import {
  addColorRole,
  removeColorRole,
  getColorRoles,
  getAllColorRoles
} from '../storage/colors.js';
import { sanitizeError, getUserDisplayName, getUserLogName } from '../shared.js';
import { logServerEvent, sendLog, sendBulkLog } from '../utils/logger.js';

// Helper to check if a member is a server booster
export async function isMemberBooster(member) {
  if (!member) return false;
  // Strictly use Discord's native premiumSince property
  return member.premiumSinceTimestamp !== null;
}

// Dangerous permissions that color roles should never have
const DANGEROUS_PERMISSIONS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.ManageGuildExpressions,
  PermissionFlagsBits.MentionEveryone
];

export function hasAnyDangerousPermission(role) {
  return DANGEROUS_PERMISSIONS.some(perm => role.permissions.has(perm));
}

// Command definitions
export const colorsCommand = new SlashCommandBuilder()
  .setName('colors')
  .setDescription('Color roles management')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false)
  .addSubcommand(subcommand =>
    subcommand
      .setName('setup')
      .setDescription('Open the color roles control panel')
  );

/**
 * Handle /colors command
 */
export async function handleColorsCommand(interaction) {
  try {
    // Handle button interactions (Back button) differently
    if (interaction.isButton()) {
      await interaction.deferUpdate();
      await showColorPanel(interaction);
      return;
    }

    // Chat input command
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'setup') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await showColorPanel(interaction);
    }
  } catch (error) {
    console.error('Error in /colors command:', sanitizeError(error));
    const errorMsg = 'An error occurred while processing the command.';

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: errorMsg, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content: errorMsg, flags: MessageFlags.Ephemeral });
    }
  }
}

/**
 * Handle /colors mass command (batch operations)
 */
async function handleColorMassCommand(interaction) {
  try {
    const mode = interaction.options.getString('mode');
    const guildId = interaction.guildId;
    const type = interaction.options.getString('type');
    const rolesInput = interaction.options.getString('roles');
    const isBooster = type === 'booster';

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Parse role IDs (flexible separators: space, comma, hyphen)
    const roleIds = rolesInput
      .trim()
      .split(/[\s,\-]+/)
      .filter(id => /^\d{17,20}$/.test(id));

    if (roleIds.length === 0) {
      await interaction.editReply('❌ No valid role IDs found. Separate IDs with spaces, commas, or hyphens.');
      return;
    }

    const guild = await interaction.client.guilds.fetch(guildId);
    let added = 0, removed = 0, skipped = 0;
    const errors = [];

    for (const roleId of roleIds) {
      const role = await guild.roles.fetch(roleId).catch(() => null);

      if (!role) {
        errors.push(`<@&${roleId}> not found`);
        skipped++;
        continue;
      }

      if (mode === 'add') {
        if (role.managed) {
          errors.push(`${role.name}: managed role`);
          skipped++;
          continue;
        }
        if (hasAnyDangerousPermission(role)) {
          errors.push(`${role.name}: dangerous permissions`);
          skipped++;
          continue;
        }

        const result = await addColorRole(guildId, roleId, isBooster);
        if (result.success) {
          added++;
        } else {
          skipped++;
        }
      } else if (mode === 'remove') {
        const result = await removeColorRole(guildId, roleId, isBooster);
        if (result.deleted) {
          removed++;
        } else {
          skipped++;
        }
      }
    }

    const typeLabel = isBooster ? 'booster ' : '';
    const summary = [];
    if (added > 0) summary.push(`✅ Added ${added} ${typeLabel}role(s)`);
    if (removed > 0) summary.push(`✅ Removed ${removed} ${typeLabel}role(s)`);
    if (skipped > 0) summary.push(`⏭️ Skipped ${skipped}`);
    if (errors.length > 0 && errors.length <= 5) summary.push(`\n${errors.join(', ')}`);
    if (errors.length > 5) summary.push(`\n...and ${errors.length - 5} more errors`);

    // Log administrative action
    const logName = getUserLogName(interaction);
    if (added > 0) {
      sendBulkLog(guild, 'audit', 'cyan', 'Mass Colors Added', `Admin **${logName}** added **${added}** ${typeLabel}color role(s) to the system.`);
    }
    if (removed > 0) {
      sendBulkLog(guild, 'audit', 'red', 'Mass Colors Removed', `Admin **${logName}** removed **${removed}** ${typeLabel}color role(s) from the system.`);
    }

    await interaction.editReply(summary.join('\n') || '✅ Done');
  } catch (error) {
    console.error('Error in /colors mass command:', sanitizeError(error));
    await interaction.editReply('An error occurred while processing your request.');
  }
}

/**
 * Show color management panel
 */
export async function showColorPanel(interaction) {
  const guildId = interaction.guildId;
  const normalColors = await getColorRoles(guildId, false);
  const boosterColors = await getColorRoles(guildId, true);

  const embed = new EmbedBuilder()
    .setTitle('🎨 Color Role Manager')
    .setDescription('Configure exclusive name colors for your members.')
    .setColor(0x5865F2)
    .addFields(
      {
        name: '🎨 Normal Colors',
        value: normalColors.length > 0
          ? `${normalColors.length} color(s) configured`
          : 'No colors set',
        inline: true
      },
      {
        name: '⭐ Booster Colors',
        value: boosterColors.length > 0
          ? `${boosterColors.length} color(s) configured`
          : 'No colors set',
        inline: true
      }
    );

  const components = buildControlPanelComponents();

  // Handle different interaction states
  const responseMethod = (interaction.deferred || interaction.replied)
    ? 'editReply'
    : (interaction.isButton() || interaction.isAnySelectMenu() ? 'update' : 'editReply');

  await interaction[responseMethod]({
    content: '',
    embeds: [embed],
    components: components
  });
}

function buildControlPanelComponents() {
  const components = [];

  const normalColorActions = new StringSelectMenuBuilder()
    .setCustomId('colors_normal_action')
    .setPlaceholder('🎨 Normal Colors')
    .addOptions([
      { label: 'Add Color', value: 'add_normal', emoji: '➕' },
      { label: 'Remove Color', value: 'remove_normal', emoji: '➖' },
      { label: 'List Colors', value: 'list_normal', emoji: '📋' },
      { label: 'Create Panel', value: 'react_normal', emoji: '🖼️' }
    ]);

  components.push(new ActionRowBuilder().addComponents(normalColorActions));

  const boosterColorActions = new StringSelectMenuBuilder()
    .setCustomId('colors_booster_action')
    .setPlaceholder('⭐ Booster Colors')
    .addOptions([
      { label: 'Add Booster Color', value: 'add_booster', emoji: '➕' },
      { label: 'Remove Booster Color', value: 'remove_booster', emoji: '➖' },
      { label: 'List Booster Colors', value: 'list_booster', emoji: '📋' },
      { label: 'Create Booster Panel', value: 'react_booster', emoji: '🖼️' }
    ]);

  components.push(new ActionRowBuilder().addComponents(boosterColorActions));

  // Back button to return to settings menu
  const backRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('settings_back')
      .setLabel('Back')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary)
  );

  components.push(backRow);

  return components;
}





/**
 * Build unified color list embed (description-based, no padding)
 */
function buildColorListEmbed(sortedColors, startIdx = 0) {
  const lines = [];

  for (let i = 0; i < sortedColors.length; i++) {
    const globalIndex = startIdx + i + 1;
    const color = sortedColors[i];
    lines.push(`**${globalIndex} | <@&${color.roleId}>**`);
  }

  const description = lines.join('\n');

  const embed = new EmbedBuilder()
    .setDescription(description)
    .setColor(0x5865F2);

  return embed;
}

/**
 * Build plain text panel content with quoted headings
 */
function buildColorPanelContent(sortedColors, startIdx = 0, isBooster = false) {
  const lines = [];

  for (let i = 0; i < sortedColors.length; i++) {
    const globalIndex = startIdx + i + 1;
    const paddedIndex = String(globalIndex).padStart(2, '0');
    const color = sortedColors[i];
    const boosterEmoji = isBooster ? ' (🚀)' : '';
    lines.push(`> # ${paddedIndex} | <@&${color.roleId}>${boosterEmoji}`);
  }

  return lines.join('\n');
}





/**
 * Handle color list
 */
async function handleColorList(interaction, guildId, isBooster) {
  const colors = await getColorRoles(guildId, isBooster);

  if (colors.length === 0) {
    const type = isBooster ? 'booster color' : 'color';

    const backButton = new ButtonBuilder()
      .setCustomId(isBooster ? 'boosters:back' : 'colors:back')
      .setLabel('Back')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary);

    const backRow = new ActionRowBuilder().addComponents(backButton);

    const responseMethod = interaction.isAnySelectMenu() ? 'update' : 'reply';
    await interaction[responseMethod]({
      content: type === 'booster color'
        ? `❌ Add Booster color roles first!`
        : `❌ Add color roles first!`,
      components: [backRow],
      embeds: [],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  // Fetch guild and roles to get positions and colors
  const guild = await interaction.client.guilds.fetch(guildId);
  const allRoles = await guild.roles.fetch();

  // Map colors with role data and sort by position (descending)
  const sortedColors = colors
    .map(color => {
      const role = allRoles.get(color.roleId);
      return {
        ...color,
        role: role,
        position: role?.position || 0,
        hexColor: role?.hexColor || '#000000'
      };
    })
    .filter(c => c.role) // Remove deleted roles
    .sort((a, b) => b.position - a.position); // Sort by position DESC

  const embed = buildColorListEmbed(sortedColors);

  // Add Back button
  const backButton = new ButtonBuilder()
    .setCustomId(isBooster ? 'boosters:back' : 'colors:back')
    .setLabel('Back')
    .setEmoji('⬅️')
    .setStyle(ButtonStyle.Secondary);

  const backRow = new ActionRowBuilder().addComponents(backButton);

  const responseMethod = interaction.isAnySelectMenu() ? 'update' : 'reply';
  await interaction[responseMethod]({
    embeds: [embed],
    components: [backRow],
    flags: MessageFlags.Ephemeral
  });
}

/**
 * Find the highest number used in recent color panel messages
 */
async function findLastPanelNumber(channel, botId) {
  try {
    // Fetch recent messages (last 50)
    const recentMessages = await channel.messages.fetch({ limit: 50 });

    let highestNumber = 0;

    for (const [, message] of recentMessages) {
      // Only check messages from this bot with components
      if (message.author.id !== botId || !message.components || message.components.length === 0) continue;

      // Look for color panel buttons (customId starts with color_normal_ or color_booster_)
      for (const row of message.components) {
        for (const component of row.components) {
          if (component.customId?.startsWith('color_normal_') || component.customId?.startsWith('color_booster_')) {
            // Extract number from button label
            const buttonLabel = component.label;
            const number = parseInt(buttonLabel, 10);
            if (!isNaN(number) && number > highestNumber) {
              highestNumber = number;
            }
          }
        }
      }
    }

    return highestNumber;
  } catch (error) {
    console.error('Error finding last panel number:', error);
    return 0;
  }
}

/**
 * Handle color react (create button panels)
 */
async function handleColorReact(interaction, guildId, isBooster) {
  // Defer without touching the control panel
  if (interaction.isAnySelectMenu()) {
    await interaction.deferUpdate(); // Keep control panel visible
  } else if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }

  const colors = await getColorRoles(guildId, isBooster);

  if (colors.length === 0) {
    const type = isBooster ? 'booster color' : 'color';
    const errorMessage = type === 'booster color'
      ? `❌ Add Booster color roles first!`
      : `❌ Add color roles first!`;

    // Show error screen with Back button (replace entire view)
    const backButton = new ButtonBuilder()
      .setCustomId(isBooster ? 'boosters:back' : 'colors:back')
      .setLabel('Back')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary);

    const backRow = new ActionRowBuilder().addComponents(backButton);

    await interaction.editReply({
      content: errorMessage,
      embeds: [],
      components: [backRow]
    });
    return;
  }

  // Fetch guild and roles to get positions and colors
  const guild = await interaction.client.guilds.fetch(guildId);
  const allRoles = await guild.roles.fetch();

  // Map colors with role data and sort by position (descending)
  const sortedColors = colors
    .map(color => {
      const role = allRoles.get(color.roleId);
      return {
        ...color,
        role: role,
        position: role?.position || 0,
        hexColor: role?.hexColor || '#000000'
      };
    })
    .filter(c => c.role) // Remove deleted roles
    .sort((a, b) => b.position - a.position); // Sort by position DESC

  const channel = interaction.channel;
  const type = isBooster ? 'booster' : 'normal';

  // Find the highest number from recent color panels to continue numbering
  const startOffset = await findLastPanelNumber(channel, interaction.client.user.id);

  // Create panels with up to 10 colors each
  const panelsCount = Math.ceil(sortedColors.length / 10);

  for (let panelIndex = 0; panelIndex < panelsCount; panelIndex++) {
    const startIdx = panelIndex * 10;
    const endIdx = Math.min(startIdx + 10, sortedColors.length);
    const panelColors = sortedColors.slice(startIdx, endIdx);

    const content = buildColorPanelContent(panelColors, startIdx + startOffset, isBooster);

    // Create buttons (2 rows of 5)
    const rows = [];

    for (let rowIndex = 0; rowIndex < 2; rowIndex++) {
      const rowStart = rowIndex * 5;
      const rowEnd = Math.min(rowStart + 5, panelColors.length);

      if (rowStart >= panelColors.length) break;

      const buttons = [];
      for (let i = rowStart; i < rowEnd; i++) {
        const globalIndex = startIdx + startOffset + i + 1;
        const paddedLabel = String(globalIndex).padStart(2, '0');
        buttons.push(
          new ButtonBuilder()
            .setCustomId(`color_${type}_${panelColors[i].roleId}`)
            .setLabel(paddedLabel)
            .setStyle(ButtonStyle.Primary) // Blue buttons
        );
      }

      if (buttons.length > 0) {
        rows.push(new ActionRowBuilder().addComponents(buttons));
      }
    }

    await channel.send({
      content: content,
      components: rows
    });
  }

  // Send quiet confirmation without touching control panel
  if (interaction.isAnySelectMenu()) {
    // Control panel stays visible, no message needed
  } else {
    await interaction.editReply(`Panels created.`);
  }
}

/**
 * Handle colors component (menu selections)
 */
export async function handleColorsComponent(interaction) {
  try {
    const [, category, action] = interaction.customId.split('_');
    const selectedAction = interaction.values[0];
    const guildId = interaction.guildId;

    // Parse action
    const [actionType, colorType] = selectedAction.split('_');
    const isBooster = colorType === 'booster';

    switch (actionType) {
      case 'add':
        // Show role select menu for adding
        await showRoleSelector(interaction, isBooster, 'add');
        break;
      case 'remove':
        // Show role select menu for removing
        await showRoleSelector(interaction, isBooster, 'remove');
        break;
      case 'list':
        await handleColorList(interaction, guildId, isBooster);
        break;
      case 'react':
        await handleColorReact(interaction, guildId, isBooster);
        break;
    }
  } catch (error) {
    console.error('Error handling colors component:', sanitizeError(error));

    const errorMsg = 'An error occurred while processing your selection.';

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: errorMsg, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content: errorMsg, flags: MessageFlags.Ephemeral });
    }
  }
}

const MAX_SELECTOR_OPTIONS = 25;

async function buildRoleSelectorResponse(client, guildId, isBooster, operation) {
  const guild = await client.guilds.fetch(guildId);
  const allRoles = await guild.roles.fetch();

  const backButton = new ButtonBuilder()
    .setCustomId(isBooster ? 'boosters:back' : 'colors:back')
    .setLabel('Back')
    .setEmoji('⬅️')
    .setStyle(ButtonStyle.Secondary);
  const backRow = new ActionRowBuilder().addComponents(backButton);

  const currentColors = await getColorRoles(guildId, isBooster);
  const currentColorIds = new Set(currentColors.map(c => c.roleId));
  const otherCategoryColors = await getColorRoles(guildId, !isBooster);
  const otherCategoryIds = new Set(otherCategoryColors.map(c => c.roleId));

  let filteredRoles;
  if (operation === 'add') {
    filteredRoles = allRoles.filter(role =>
      !currentColorIds.has(role.id) &&
      !otherCategoryIds.has(role.id) &&
      !role.managed &&
      role.id !== guild.id &&
      !hasAnyDangerousPermission(role)
    );
  } else {
    filteredRoles = allRoles.filter(role => currentColorIds.has(role.id));
  }

  const sortedRoles = Array.from(filteredRoles.values())
    .sort((a, b) => b.position - a.position);

  if (sortedRoles.length === 0) {
    const message = operation === 'add'
      ? '❌ No available roles to add. Everything eligible is already in the list or blocked.'
      : '❌ No roles to remove. Add some roles first.';
    return {
      content: message,
      components: [backRow]
    };
  }

  const limitedRoles = sortedRoles.slice(0, MAX_SELECTOR_OPTIONS);

  const roleSelect = new StringSelectMenuBuilder()
    .setCustomId(`colors_role_${operation}_${isBooster ? 'booster' : 'normal'}`)
    .setPlaceholder('Search or Select a role')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      limitedRoles.map(role => ({
        label: role.name.length > 100 ? `${role.name.slice(0, 97)}...` : role.name,
        value: role.id,
        emoji: role.unicodeEmoji || undefined
      }))
    );

  const selectRow = new ActionRowBuilder().addComponents(roleSelect);

  const prompt = operation === 'add'
    ? 'Select a role to add.'
    : 'Select a role to remove.';

  return {
    content: prompt,
    components: [selectRow, backRow]
  };
}

/**
 * Show role selector for color operations
 */
async function showRoleSelector(interaction, isBooster, operation) {
  const guildId = interaction.guildId;

  if (operation === 'booster_role') {
    const roleSelect = new RoleSelectMenuBuilder()
      .setCustomId(`colors_role_${operation}_normal`)
      .setPlaceholder('Search or Select a role')
      .setMinValues(1)
      .setMaxValues(1);

    const selectRow = new ActionRowBuilder().addComponents(roleSelect);

    const backButton = new ButtonBuilder()
      .setCustomId('colors:back')
      .setLabel('Back')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary);

    const backRow = new ActionRowBuilder().addComponents(backButton);

    await interaction.update({
      content: 'Select the booster role:',
      components: [selectRow, backRow],
      embeds: [],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const { content, components } = await buildRoleSelectorResponse(
    interaction.client,
    guildId,
    isBooster,
    operation
  );

  await interaction.update({
    content,
    components,
    embeds: [],
    flags: MessageFlags.Ephemeral
  });
}

/**
 * Handle role selection
 */
export async function handleRoleSelection(interaction) {
  try {
    const [, , operation, colorType] = interaction.customId.split('_');
    const guildId = interaction.guildId;
    const selectedRoleId = interaction.values[0];
    const isBooster = colorType === 'booster';
    const username = getUserDisplayName(interaction.member);

    // Defer the update immediately to prevent timeout
    await interaction.deferUpdate();

    if (operation === 'booster') {
      await setBoosterRole(guildId, selectedRoleId);
      const guild = await interaction.client.guilds.fetch(guildId).catch(() => null);
      if (guild) {
        const role = guild.roles.cache.get(selectedRoleId);
        const logName = getUserLogName(interaction);
        sendLog(guild, 'audit', 'cyan', '⚙️ Booster Role Changed', 
          `**Admin:** \`${logName}\`\n` +
          `**Action:** Set server booster role to ${role || `\`${selectedRoleId}\``}`
        );
      }
      await showColorPanel(interaction);
      return;
    }

    const guild = await interaction.client.guilds.fetch(guildId);
    const selectedRole = await guild.roles.fetch(selectedRoleId).catch(() => null);

    if (!selectedRole) {
      const { content, components } = await buildRoleSelectorResponse(
        interaction.client,
        guildId,
        isBooster,
        operation
      );

      await interaction.editReply({
        content: [`❌ That role no longer exists!`, content].filter(Boolean).join('\n\n'),
        components,
        embeds: []
      });
      return;
    }

    if (operation === 'add') {
      const result = await addColorRole(guildId, selectedRoleId, isBooster);
      const message = result.success
        ? `✅ Added <@&${selectedRoleId}>!`
        : `❌ ${result.error}`;

      if (result.success) {
        const typeLabel = isBooster ? 'booster color' : 'color';
        const logName = getUserLogName(interaction);
        sendLog(guild, 'audit', 'cyan', `🎨 ${isBooster ? 'Booster ' : ''}Color Added`, 
          `**Admin:** \`${logName}\`\n` +
          `**Action:** Added ${selectedRole} to the available colors list.`
        );
      }

      const { content, components } = await buildRoleSelectorResponse(
        interaction.client,
        guildId,
        isBooster,
        operation
      );

      await interaction.editReply({
        content: [message, content].filter(Boolean).join('\n\n'),
        components,
        embeds: []
      });

      if (result.success) {
        // Role added
      }
    } else if (operation === 'remove') {
      const result = await removeColorRole(guildId, selectedRoleId, isBooster);
      const message = result.deleted
        ? `✅ Removed <@&${selectedRoleId}>!`
        : `❌ Failed to remove <@&${selectedRoleId}>!`;

      if (result.deleted) {
        const typeLabel = isBooster ? 'booster color' : 'color';
        const logName = getUserLogName(interaction);
        sendLog(guild, 'audit', 'red', `🎨 ${isBooster ? 'Booster ' : ''}Color Removed`, 
          `**Admin:** \`${logName}\`\n` +
          `**Action:** Removed ${selectedRole} from the available colors list.`
        );
      }

      const { content, components } = await buildRoleSelectorResponse(
        interaction.client,
        guildId,
        isBooster,
        operation
      );

      await interaction.editReply({
        content: [message, content].filter(Boolean).join('\n\n'),
        components,
        embeds: []
      });

      if (result.deleted) {
        // Role removed
      }
    }
  } catch (error) {
    console.error('Error handling role selection:', sanitizeError(error));

    const errorMsg = 'Failed to process role selection.';

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: errorMsg, flags: MessageFlags.Ephemeral }).catch(() => { });
    } else {
      await interaction.reply({ content: errorMsg, flags: MessageFlags.Ephemeral }).catch(() => { });
    }
  }
}
/**
 * Get all booster color role IDs for a guild
 */
export async function getBoosterColorRoleIds(guildId) {
  const boosterColors = await getColorRoles(guildId, true);
  return new Set(boosterColors.map(c => c.roleId));
}

/**
 * Strip all booster color roles from a member
 */
export async function stripBoosterColorsFromMember(member, guildId) {
  const boosterColorIds = await getBoosterColorRoleIds(guildId);
  const rolesToRemove = member.roles.cache.filter(role => boosterColorIds.has(role.id));

  if (rolesToRemove.size > 0) {
    try {
      await member.roles.remove(rolesToRemove);
      
      const logName = getUserLogName(member);
      sendLog(member.guild, 'inventory', 'crimson', '🎨 Color Role Revoked', 
        `**User:** \`${logName}\`\n` +
        `**Reason:** Lost Booster status or required role.\n` +
        `**Roles Stripped:** ${rolesToRemove.map(r => `\`${r.name}\``).join(', ')}`
      );
    } catch (error) {
      console.error(`Failed to strip booster colors:`, error);
    }
  }
}

/**
 * Audit all members with booster colors and remove from non-boosters
 * Optimized: Only iterates over members who have booster color roles (from cache)
 */
export async function auditBoosterColors(guild) {
  try {
    const guildId = guild.id;
    const boosterColorIds = await getBoosterColorRoleIds(guildId);

    if (boosterColorIds.size === 0) {
      return; // No booster colors configured
    }

    let audited = 0;
    let stripped = 0;

    // Optimize: Only check members who actually have booster color roles
    const strippedMembers = [];
    
    for (const roleId of boosterColorIds) {
      const role = guild.roles.cache.get(roleId);
      if (!role) continue;

      // Iterate only members with this booster color (from cache, no fetch!)
      for (const [memberId, member] of role.members) {
        audited++;

        // Check if they're still a booster
        if (!await isMemberBooster(member, guildId)) {
          await stripBoosterColorsFromMember(member, guildId);
          strippedMembers.push(getUserLogName(member));
          stripped++;
        }
      }
    }

    if (stripped > 0) {
        sendBulkLog(guild, 'inventory', 'crimson', 'Booster Audit Cleanup', 
            `**Action:** Processed automated booster audit.\n` +
            `**Result:** Stripped color roles from **${stripped}** members who are no longer boosting.\n` +
            `**Members:** ${strippedMembers.join(', ')}`
        );
    }

  } catch (error) {
    console.error(`Booster audit error:`, sanitizeError(error));
  }
}

/**
 * Run audit on all guilds
 */
export async function auditAllGuilds(client) {
  for (const [guildId, guild] of client.guilds.cache) {
    await auditBoosterColors(guild);
  }
}

/**
 * Handle color button click
 */
export async function handleColorButton(interaction) {
  try {
    const [, type, roleId] = interaction.customId.split('_');
    const isBooster = type === 'booster';
    const member = interaction.member;
    const guildId = interaction.guildId;

    // Check booster status if it's a booster color
    if (isBooster && !await isMemberBooster(member, guildId)) {
      await interaction.reply({
        content: '❌ Boost the server to unlock this color!',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    // Get all color roles (both normal and booster)
    const allColorRoleIds = await getAllColorRoles(guildId);

    // Check if user already has this role
    const hasRole = member.roles.cache.has(roleId);

    if (hasRole) {
      // Remove the role
      await member.roles.remove(roleId);
      const logName = getUserLogName(member);
      sendLog(interaction.guild, 'inventory', 'blue', '🎨 Color Role Removed', 
        `**User:** \`${logName}\`\n` +
        `**Action:** Removed color role <@&${roleId}>.`
      );
      await interaction.reply({
        content: `✅ Removed <@&${roleId}> from you.`,
        flags: MessageFlags.Ephemeral
      });
    } else {
      // Remove all other color roles first
      const rolesToRemove = member.roles.cache
        .filter(role => allColorRoleIds.includes(role.id))
        .map(role => role.id);

      if (rolesToRemove.length > 0) {
        await member.roles.remove(rolesToRemove);
      }

      // Add the new color role
      await member.roles.add(roleId);
      const logName = getUserLogName(member);
      sendLog(interaction.guild, 'inventory', 'green', '🎨 Color Role Selected', 
        `**User:** \`${logName}\`\n` +
        `**Action:** Picked color role <@&${roleId}>.`
      );
      await interaction.reply({
        content: `✅ Gave you <@&${roleId}>!`,
        flags: MessageFlags.Ephemeral
      });
    }
  } catch (error) {
    console.error('Error handling color button:', sanitizeError(error));
    console.error('Full error details:', error);

    let errorMsg = 'Failed to update your color role.';

    // Check for specific Discord API errors
    if (error.code === 50013 || error.message?.includes('Missing Permissions')) {
      errorMsg = '❌ The bot\'s role must be positioned ABOVE the color roles in Server Settings → Roles.';
    } else if (error.code === 50001) {
      errorMsg = '❌ The bot cannot access this role. Check role hierarchy.';
    } else {
      errorMsg = `❌ Failed to update color role: ${error.message || 'Unknown error'}`;
    }

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: errorMsg, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content: errorMsg, flags: MessageFlags.Ephemeral });
    }
  }
}
