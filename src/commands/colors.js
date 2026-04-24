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
import { logServerEvent, sendLog, sendBulkLog, sysLog, sysError } from '../utils/logger.js';

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
    sysError('Colors command failed', error, { user: interaction.user.id, guild: interaction.guildId });
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
    sysError('Colors mass command failed', error, { user: interaction.user.id, guild: interaction.guildId });
    await interaction.editReply('An error occurred while processing your request.');
  }
}

/**
 * Show color management panel
 */
/**
 * Render the unified Color Dashboard
 */
export async function showColorPanel(interaction, type = 'normal') {
  const guildId = interaction.guildId;
  const isBoosterTab = type === 'booster';
  const colors = await getColorRoles(guildId, isBoosterTab);

  // Fetch guild roles to get mentions and names
  const guild = await interaction.client.guilds.fetch(guildId);
  const allRoles = await guild.roles.fetch();

  const sortedColors = colors
    .map(c => ({ ...c, role: allRoles.get(c.roleId) }))
    .filter(c => c.role)
    .sort((a, b) => b.role.position - a.role.position);

  const titlePrefix = isBoosterTab ? '⭐ Booster' : '🎨 Normal';
  const colorHex = isBoosterTab ? 0xFEE75C : 0x5865F2;

  const embed = new EmbedBuilder()
    .setTitle(`${titlePrefix} Colors (${sortedColors.length} configured)`)
    .setDescription(sortedColors.length > 0 
      ? sortedColors.map((c, i) => `**${i + 1} |** <@&${c.roleId}>`).join('\n')
      : '_No colors configured yet._')
    .setColor(colorHex)
    .setFooter({ text: 'Use the tools below to manage this list' });

  const components = [];

  // Row 1: Add Role (Searchable Selector)
  const addSelector = new RoleSelectMenuBuilder()
    .setCustomId(`colors_add_${type}`)
    .setPlaceholder(`➕ Add a color to the ${titlePrefix} list...`);
  
  components.push(new ActionRowBuilder().addComponents(addSelector));

  // Row 2: Remove Role (populated with current colors)
  const removeSelector = new StringSelectMenuBuilder()
    .setCustomId(`colors_remove_${type}`)
    .setPlaceholder(`➖ Remove a color from the ${titlePrefix} list...`)
    .setDisabled(sortedColors.length === 0);

  if (sortedColors.length > 0) {
    removeSelector.addOptions(
      sortedColors.slice(0, 25).map(c => ({
        label: c.role.name,
        value: c.roleId,
        emoji: '🗑️'
      }))
    );
  } else {
    removeSelector.addOptions([{ label: 'No roles to remove', value: 'none' }]);
  }

  components.push(new ActionRowBuilder().addComponents(removeSelector));

  // Row 3: Navigation & Global Actions
  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('colors_tab_normal')
      .setLabel('Normal Colors')
      .setEmoji('🎨')
      .setStyle(isBoosterTab ? ButtonStyle.Secondary : ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('colors_tab_booster')
      .setLabel('Booster Colors')
      .setEmoji('⭐')
      .setStyle(isBoosterTab ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`colors_create_${type}`)
      .setLabel('Create Panel')
      .setEmoji('🖼️')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('settings_back')
      .setLabel('Back')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Danger) // Using Danger as requested for contrast
  );

  components.push(navRow);

  const responseMethod = (interaction.deferred || interaction.replied)
    ? 'editReply'
    : (interaction.isButton() || interaction.isAnySelectMenu() ? 'update' : 'editReply');

  await interaction[responseMethod]({
    content: '',
    embeds: [embed],
    components: components
  });
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
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
  const colors = await getColorRoles(guildId, isBooster);

  if (colors.length === 0) {
    const type = isBooster ? 'booster color' : 'color';

    const backButton = new ButtonBuilder()
      .setCustomId(isBooster ? 'boosters:back' : 'colors:back')
      .setLabel('Back')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary);

    const backRow = new ActionRowBuilder().addComponents(backButton);

    const responseMethod = interaction.deferred || interaction.replied ? 'editReply' : (interaction.isAnySelectMenu() ? 'update' : 'reply');
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

  const responseMethod = interaction.deferred || interaction.replied ? 'editReply' : (interaction.isAnySelectMenu() ? 'update' : 'reply');
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
    sysError('Failed to find last color panel number', error, { guild: channel.guild.id, channel: channel.id });
    return 0;
  }
}

/**
 * Handle color react (create button panels)
 */
async function handleColorReact(interaction, guildId, isBooster) {
  // Ensure interaction is deferred exactly once
  if (!interaction.deferred && !interaction.replied) {
    if (interaction.isAnySelectMenu() || interaction.isButton()) {
      await interaction.deferUpdate().catch(() => {});
    } else {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
    }
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

    try {
      await channel.send({
        content: content,
        components: rows
      });
    } catch (error) {
      sysError('Failed to send color panel message', error, { guild: guildId, channel: channel.id });
      
      const errorMsg = error.code === 50013 || error.code === 50007
        ? '❌ **Missing Permissions:** I do not have permission to send messages in this channel.'
        : '❌ **Error:** I could not send the color panel to this channel.';

      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: errorMsg, flags: MessageFlags.Ephemeral }).catch(() => {});
      } else {
        await interaction.reply({ content: errorMsg, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      return; // Stop processing further panels if one fails
    }
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
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => {});
    }

    const customId = interaction.customId;
    const guildId = interaction.guildId;

    // 1. Handle Tab Switching
    if (customId.startsWith('colors_tab_')) {
      const type = customId.split('_')[2];
      return await showColorPanel(interaction, type);
    }

    // 2. Handle Add/Remove via Select Menus
    if (interaction.isAnySelectMenu()) {
      const parts = customId.split('_'); // [colors, action, type]
      const action = parts[1];
      const type = parts[2];
      const isBooster = type === 'booster';

      if (action === 'add') {
        const roleId = interaction.values[0];
        return await processRoleAddition(interaction, guildId, roleId, isBooster);
      }

      if (action === 'remove') {
        const roleId = interaction.values[0];
        return await processRoleRemoval(interaction, guildId, roleId, isBooster);
      }
    }

    // 3. Handle Create Panel Button
    if (customId.startsWith('colors_create_')) {
      const type = customId.split('_')[2];
      const isBooster = type === 'booster';
      return await handleColorReact(interaction, guildId, isBooster);
    }

  } catch (error) {
    sysError('Colors dashboard component failed', error, { user: interaction.user.id, guild: interaction.guildId });
    const errorMsg = '❌ **Internal Error:** Failed to process dashboard action.';
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: errorMsg, flags: MessageFlags.Ephemeral }).catch(() => {});
    } else {
      await interaction.reply({ content: errorMsg, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
}

/**
 * Shared logic for adding a color role
 */
async function processRoleAddition(interaction, guildId, roleId, isBooster) {
  const guild = interaction.guild || await interaction.client.guilds.fetch(guildId);
  const role = await guild.roles.fetch(roleId).catch(() => null);

  if (!role) {
    return interaction.followUp({ content: '❌ Role not found.', flags: MessageFlags.Ephemeral });
  }

  // VALIDATION: Dangerous Permissions
  if (hasAnyDangerousPermission(role)) {
    return interaction.followUp({ 
      content: `❌ **Security Risk:** Role **${role.name}** has administrative or management permissions and cannot be used for colors.`, 
      flags: MessageFlags.Ephemeral 
    });
  }

  // VALIDATION: Already in list (any list to prevent confusion)
  const existingNormal = await getColorRoles(guildId, false);
  const existingBooster = await getColorRoles(guildId, true);
  
  if (existingNormal.some(c => c.roleId === roleId) || existingBooster.some(c => c.roleId === roleId)) {
    return interaction.followUp({ 
      content: `❌ Role **${role.name}** is already configured in a color list.`, 
      flags: MessageFlags.Ephemeral 
    });
  }

  // Add to DB
  const result = await addColorRole(guildId, roleId, isBooster);
  if (result.success) {
    const logName = getUserLogName(interaction);
    sendLog(guild, 'audit', 'cyan', `🎨 ${isBooster ? 'Booster ' : ''}Color Added`, 
      `**Admin:** \`${logName}\`\n**Action:** Added ${role} to the list.`
    );
    // Refresh dashboard
    return await showColorPanel(interaction, isBooster ? 'booster' : 'normal');
  } else {
    return interaction.followUp({ content: `❌ Database error: ${result.error}`, flags: MessageFlags.Ephemeral });
  }
}

/**
 * Shared logic for removing a color role
 */
async function processRoleRemoval(interaction, guildId, roleId, isBooster) {
  const result = await removeColorRole(guildId, roleId, isBooster);
  
  if (result.deleted) {
    const guild = interaction.guild || await interaction.client.guilds.fetch(guildId);
    const logName = getUserLogName(interaction);
    sendLog(guild, 'audit', 'red', `🎨 ${isBooster ? 'Booster ' : ''}Color Removed`, 
      `**Admin:** \`${logName}\`\n**Action:** Removed role ID \`${roleId}\` from the list.`
    );
    // Refresh dashboard
    return await showColorPanel(interaction, isBooster ? 'booster' : 'normal');
  } else {
    return interaction.followUp({ content: '❌ This role was not in the list.', flags: MessageFlags.Ephemeral });
  }
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
    sysError('Colors role selection failed', error, { user: interaction.user.id, guild: interaction.guildId });

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
      sysError('Failed to strip booster colors', error, { user: member.id, guild: guildId });
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
    sysError('Booster audit error', error, { guild: guild.id });
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
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }
    const [, type, roleId] = interaction.customId.split('_');
    const isBooster = type === 'booster';
    const member = interaction.member;
    const guildId = interaction.guildId;

    // Check booster status if it's a booster color
    if (isBooster && !await isMemberBooster(member, guildId)) {
      await interaction.editReply({
        content: '❌ Boost the server to unlock this color!',
      });
      return;
    }

    // Get all color roles (both normal and booster)
    const allColorRoleIds = await getAllColorRoles(guildId);

    // Check if user already has this role
    const hasRole = member.roles.cache.has(roleId);

    if (hasRole) {
      // Check hierarchy before removing
      const botMember = await interaction.guild.members.fetchMe().catch(() => null);
      const targetRole = interaction.guild.roles.cache.get(roleId);
      
      if (targetRole && botMember && targetRole.position >= botMember.roles.highest.position) {
        return interaction.editReply({
          content: '❌ I cannot remove this role because it is positioned above me in the hierarchy. Move the bot role higher!',
        });
      }

      // Remove the role
      await member.roles.remove(roleId);
      const logName = getUserLogName(member);
      sendLog(interaction.guild, 'inventory', 'blue', '🎨 Color Role Removed', 
        `**User:** \`${logName}\`\n` +
        `**Action:** Removed color role <@&${roleId}>.`
      );
      await interaction.editReply({
        content: `✅ Removed <@&${roleId}> from you.`,
      });
    } else {
      // Remove all other color roles first (ONLY if manageable)
      const botMember = await interaction.guild.members.fetchMe().catch(() => null);
      const rolesToRemove = member.roles.cache
        .filter(role => allColorRoleIds.includes(role.id) && (!botMember || role.position < botMember.roles.highest.position))
        .map(role => role.id);

      if (rolesToRemove.length > 0) {
        try {
          await member.roles.remove(rolesToRemove);
        } catch (err) {
          sysError('Non-fatal error removing old color roles', err, { user: member.id, guild: member.guild.id });
        }
      }

      // Add the new color role (Check hierarchy first)
      const targetRole = interaction.guild.roles.cache.get(roleId);
      if (targetRole && botMember && targetRole.position >= botMember.roles.highest.position) {
        return interaction.editReply({
          content: '❌ I cannot assign this role because it is positioned above me in the hierarchy. Please move the bot\'s role higher.',
        });
      }

      await member.roles.add(roleId);
      const logName = getUserLogName(member);
      sendLog(interaction.guild, 'inventory', 'green', '🎨 Color Role Selected', 
        `**User:** \`${logName}\`\n` +
        `**Action:** Picked color role <@&${roleId}>.`
      );
      await interaction.editReply({
        content: `✅ Gave you <@&${roleId}>!`,
      });
    }
  } catch (error) {
    if (error.message?.includes('already been sent') || error.message?.includes('Unknown interaction')) {
        return; // Ignore harmless noise
    }
    sysError('Error handling color button', error, { user: interaction.user.id, guild: interaction.guildId });

    let errorMsg = 'Failed to update your color role.';

    // Check for specific Discord API errors
    if (error.code === 50013 || error.message?.includes('Missing Permissions')) {
      errorMsg = '❌ The bot\'s role must be positioned ABOVE the color roles in Server Settings → Roles.';
    } else if (error.code === 50001) {
      errorMsg = '❌ The bot cannot access this role. Check role hierarchy.';
    } else {
      errorMsg = `❌ Failed to update color role: ${error.message || 'Unknown error'}`;
    }

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: errorMsg }).catch(() => { });
    } else {
      await interaction.reply({ content: errorMsg, flags: MessageFlags.Ephemeral }).catch(() => { });
    }
  }
}
