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
  getAllColorRoles,
  setBoosterRole,
  getBoosterRole
} from '../storage/colors.js';
import { sanitizeError } from '../shared.js';

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

function hasAnyDangerousPermission(role) {
  return DANGEROUS_PERMISSIONS.some(perm => role.permissions.has(perm));
}

// Command definitions
export const colorsCommand = new SlashCommandBuilder()
  .setName('colors')
  .setDescription('Color roles management')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
  .setDMPermission(false)
  .addSubcommand(subcommand =>
    subcommand
      .setName('setup')
      .setDescription('Open the color roles control panel')
  );

export const colorCommand = new SlashCommandBuilder()
  .setName('color')
  .setDescription('Batch add/remove color roles')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
  .setDMPermission(false)
  .addSubcommand(subcommand =>
    subcommand
      .setName('addmany')
      .setDescription('Add multiple color roles at once')
      .addStringOption(option =>
        option
          .setName('type')
          .setDescription('Type of colors to add')
          .setRequired(true)
          .addChoices(
            { name: 'Normal Colors', value: 'normal' },
            { name: 'Booster Colors', value: 'boosters' }
          )
      )
      .addStringOption(option =>
        option
          .setName('roles')
          .setDescription('Role IDs (separated by space, comma, or hyphen)')
          .setRequired(true)
      )
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('removemany')
      .setDescription('Remove multiple color roles at once')
      .addStringOption(option =>
        option
          .setName('type')
          .setDescription('Type of colors to remove')
          .setRequired(true)
          .addChoices(
            { name: 'Normal Colors', value: 'normal' },
            { name: 'Booster Colors', value: 'boosters' }
          )
      )
      .addStringOption(option =>
        option
          .setName('roles')
          .setDescription('Role IDs (separated by space, comma, or hyphen)')
          .setRequired(true)
      )
  );

/**
 * Handle /color command (batch operations)
 */
export async function handleColorCommand(interaction) {
  try {
    const subcommand = interaction.options.getSubcommand();
    const guildId = interaction.guildId;
    const type = interaction.options.getString('type');
    const rolesInput = interaction.options.getString('roles');
    const isBooster = type === 'boosters';

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

      if (subcommand === 'addmany') {
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
          const colorType = isBooster ? 'booster color' : 'color';
          console.log(`🎨 | Added ${colorType} role: ${role.name} (${roleId}) | guild=${guildId} | by=${interaction.user.tag}`);
        } else {
          skipped++;
        }
      } else if (subcommand === 'removemany') {
        const result = await removeColorRole(guildId, roleId, isBooster);
        if (result.deleted) {
          removed++;
          const colorType = isBooster ? 'booster color' : 'color';
          console.log(`🎨 | Removed ${colorType} role: ${role.name} (${roleId}) | guild=${guildId} | by=${interaction.user.tag}`);
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

    await interaction.editReply(summary.join('\n') || '✅ Done');
  } catch (error) {
    console.error('Error in /color command:', sanitizeError(error));
    const errorMsg = 'An error occurred while processing your request.';
    
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: errorMsg, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content: errorMsg, flags: MessageFlags.Ephemeral });
    }
  }
}

/**
 * Handle /colors command - Show control panel
 */
export async function handleColorsCommand(interaction) {
  try {
    // Handle button interactions (Back button) differently
    if (interaction.isButton()) {
      await interaction.deferUpdate();
      await showColorPanel(interaction);
    } else {
      // Chat input command - check for 'setup' subcommand
      const subcommand = interaction.options.getSubcommand();
      
      if (subcommand === 'setup') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await showColorPanel(interaction);
      }
    }
  } catch (error) {
    console.error('Error in /colors command:', sanitizeError(error));
    const errorMsg = 'An error occurred while opening the color panel.';
    
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: errorMsg, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content: errorMsg, flags: MessageFlags.Ephemeral });
    }
  }
}

/**
 * Show color management panel
 */
async function showColorPanel(interaction) {
  const guildId = interaction.guildId;
  const normalColors = await getColorRoles(guildId, false);
  const boosterColors = await getColorRoles(guildId, true);
  const boosterRoleId = await getBoosterRole(guildId);
  
  const embed = new EmbedBuilder()
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
      },
      {
        name: '🏅 Booster Role',
        value: boosterRoleId ? `<@&${boosterRoleId}>` : 'Not set',
        inline: true
      }
    );

  const components = buildControlPanelComponents();

  // Always use editReply since we defer in handleColorsCommand
  await interaction.editReply({
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
      { label: 'Create Booster Panel', value: 'react_booster', emoji: '🖼️' },
      { label: 'Set Booster Role', value: 'set_booster_role', emoji: '🏅' }
    ]);

  components.push(new ActionRowBuilder().addComponents(boosterColorActions));

  return components;
}


/**
 * Handle single color add command
 */
async function handleColorAddCommand(interaction, guildId, isBooster) {
  const role = interaction.options.getRole('role');
  
  if (!role) {
    await interaction.reply({ content: '❌ Invalid role.', flags: MessageFlags.Ephemeral });
    return;
  }
  
  // Security: Prevent adding roles with dangerous permissions
  if (hasAnyDangerousPermission(role)) {
    await interaction.reply({ 
      content: `❌ Cannot add this role as a color role. It has administrative permissions that could be exploited.`, 
      flags: MessageFlags.Ephemeral 
    });
    return;
  }
  
  const result = await addColorRole(guildId, role.id, isBooster);
  const type = isBooster ? 'booster color' : 'color';
  
  if (result.success) {
    console.log(`🎨 | Added ${type} role: ${role.name} (${role.id}) | guild=${guildId} | by=${interaction.user.tag}`);
    await interaction.reply({ 
      content: `✅ Added <@&${role.id}> as a ${type} role.`, 
      flags: MessageFlags.Ephemeral 
    });
  } else {
    await interaction.reply({ 
      content: `❌ ${result.error}`, 
      flags: MessageFlags.Ephemeral 
    });
  }
}

/**
 * Handle batch color add command
 */
async function handleColorAddManyCommand(interaction, guildId, isBooster) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  
  const rolesInput = interaction.options.getString('roles');
  const type = isBooster ? 'booster color' : 'color';
  
  // Parse role IDs from input (handles mentions <@&ID> and plain IDs)
  const roleIdMatches = rolesInput.matchAll(/<@&(\d+)>|(\d{17,20})/g);
  const roleIds = [...roleIdMatches].map(match => match[1] || match[2]);
  
  if (roleIds.length === 0) {
    await interaction.editReply('❌ No valid role IDs found. Use role mentions or IDs.');
    return;
  }
  
  // Fetch guild to validate roles
  const guild = await interaction.client.guilds.fetch(guildId);
  const allRoles = await guild.roles.fetch();
  
  let added = 0;
  let skipped = 0;
  const invalid = [];
  const dangerous = [];
  
  for (const roleId of roleIds) {
    const role = allRoles.get(roleId);
    
    if (!role) {
      invalid.push(roleId);
      skipped++;
      continue;
    }
    
    // Security: Skip roles with dangerous permissions
    if (hasAnyDangerousPermission(role)) {
      dangerous.push(role.name);
      skipped++;
      continue;
    }
    
    const result = addColorRole(guildId, roleId, isBooster);
    if (result.success) {
      added++;
    } else {
      skipped++;
    }
  }
  
  const summary = [];
  if (added > 0) summary.push(`✅ Added ${added} ${type} role(s)`);
  if (skipped > 0) summary.push(`⏭️ Skipped ${skipped} (duplicates/invalid)`);
  if (invalid.length > 0) summary.push(`❌ Invalid IDs: ${invalid.length}`);
  if (dangerous.length > 0) summary.push(`🚫 Blocked ${dangerous.length} role(s) with dangerous permissions: ${dangerous.join(', ')}`);
  
  await interaction.editReply(summary.join('\n'));
}

/**
 * Handle color remove command
 */
async function handleColorRemoveCommand(interaction, guildId, isBooster) {
  const role = interaction.options.getRole('role');
  
  if (!role) {
    await interaction.reply({ content: '❌ Invalid role.', flags: MessageFlags.Ephemeral });
    return;
  }
  
  const result = await removeColorRole(guildId, role.id, isBooster);
  const type = isBooster ? 'booster color' : 'color';
  
  if (result.deleted) {
    console.log(`🎨 | Removed ${type} role: ${role.name} (${role.id}) | guild=${guildId} | by=${interaction.user.tag}`);
  }
  
  await interaction.reply({ 
    content: result.deleted 
      ? `✅ Removed <@&${role.id}> from ${type} roles.`
      : `ℹ️ <@&${role.id}> was not in the ${type} list.`,
    flags: MessageFlags.Ephemeral 
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
 * Handle color list command
 */
async function handleColorListCommand(interaction, guildId, isBooster) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  
  const colors = await getColorRoles(guildId, isBooster);
  
  if (colors.length === 0) {
    const type = isBooster ? 'booster color' : 'color';
    
    const backButton = new ButtonBuilder()
      .setCustomId(isBooster ? 'boosters:back' : 'colors:back')
      .setLabel('← Back')
      .setStyle(ButtonStyle.Secondary);
    
    const backRow = new ActionRowBuilder().addComponents(backButton);
    
    await interaction.editReply({
      content: type === 'booster color' 
        ? `❌ Add Booster color roles first!`
        : `❌ Add color roles first!`,
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
  
  const embed = buildColorListEmbed(sortedColors);
  
  const backButton = new ButtonBuilder()
    .setCustomId(isBooster ? 'boosters:back' : 'colors:back')
    .setLabel('← Back')
    .setStyle(ButtonStyle.Secondary);
  
  const backRow = new ActionRowBuilder().addComponents(backButton);
  
  await interaction.editReply({ embeds: [embed], components: [backRow] });
}

/**
 * Handle color react command
 */
async function handleColorReactCommand(interaction, guildId, isBooster) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  
  const colors = await getColorRoles(guildId, isBooster);
  
  if (colors.length === 0) {
    const type = isBooster ? 'booster color' : 'color';
    
    const backButton = new ButtonBuilder()
      .setCustomId(isBooster ? 'boosters:back' : 'colors:back')
      .setLabel('← Back')
      .setStyle(ButtonStyle.Secondary);
    
    const backRow = new ActionRowBuilder().addComponents(backButton);
    
    await interaction.editReply({
      content: type === 'booster color' 
        ? `❌ Add Booster color roles first!`
        : `❌ Add color roles first!`,
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
  
  const panelType = isBooster ? 'booster' : 'normal';
  console.log(`🎨 | Created ${panelsCount} ${panelType} panel(s) with ${sortedColors.length} role(s) | guild=${guildId} | by=${interaction.user.tag}`);
  await interaction.editReply(`Panels created.`);
}

/**
 * Handle booster role set command
 */
async function handleBoosterRoleSetCommand(interaction, guildId) {
  const role = interaction.options.getRole('role');
  
  if (!role) {
    await interaction.reply({ content: '❌ Invalid role.', flags: MessageFlags.Ephemeral });
    return;
  }
  
  await setBoosterRole(guildId, role.id);
  console.log(`🎨 | Set booster role: ${role.name} (${role.id}) | guild=${guildId} | by=${interaction.user.tag}`);
  
  await interaction.reply({ 
    content: `✅ Set <@&${role.id}> as the booster role.`, 
    flags: MessageFlags.Ephemeral 
  });
}

/**
 * Handle color add
 */
async function handleColorAdd(interaction, guildId, isBooster) {
  const role = interaction.options.getRole('role');
  
  if (!role) {
    await interaction.reply({ content: '❌ Invalid role.', flags: MessageFlags.Ephemeral });
    return;
  }
  
  const result = await addColorRole(guildId, role.id, isBooster);
  
  if (result.success) {
    const type = isBooster ? 'booster color' : 'color';
    await interaction.reply({ 
      content: `✅ Added ${role} as a ${type} role.`, 
      flags: MessageFlags.Ephemeral 
    });
  } else {
    await interaction.reply({ 
      content: `❌ ${result.error}`, 
      flags: MessageFlags.Ephemeral 
    });
  }
}

/**
 * Handle color remove
 */
async function handleColorRemove(interaction, guildId, isBooster) {
  const role = interaction.options.getRole('role');
  
  if (!role) {
    await interaction.reply({ content: '❌ Invalid role.', flags: MessageFlags.Ephemeral });
    return;
  }
  
  const result = await removeColorRole(guildId, role.id, isBooster);
  const type = isBooster ? 'booster color' : 'color';
  
  await interaction.reply({ 
    content: result.deleted 
      ? `✅ Removed ${role} from ${type} roles.`
      : `ℹ️ ${role} was not in the ${type} list.`,
    flags: MessageFlags.Ephemeral 
  });
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
      .setLabel('← Back')
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
    .setLabel('← Back')
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
      .setLabel('← Back')
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
    const panelType = isBooster ? 'booster' : 'normal';
    console.log(`🎨 | Created ${panelsCount} ${panelType} panel(s) with ${sortedColors.length} role(s) | guild=${guildId} | by=${interaction.user.tag}`);
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
      case 'set':
        if (selectedAction === 'set_booster_role') {
          await showRoleSelector(interaction, false, 'booster_role');
        }
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
    .setLabel('← Back')
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
  
  // Show operation tip
  const tip = operation === 'add'
    ? 'use `/color addmany` to add multiple roles at once.'
    : 'use `/color removemany` to remove multiple roles at once.';

  return {
    content: tip,
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
      .setLabel('← Back')
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

    // Defer the update immediately to prevent timeout
    await interaction.deferUpdate();

    if (operation === 'booster') {
      setBoosterRole(guildId, selectedRoleId);
      console.log(`🎨 | Set booster role: ${selectedRoleId} | guild=${guildId} | by=${interaction.user.tag}`);
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
        const type = isBooster ? 'booster color' : 'color';
        console.log(`🎨 | Added ${type} role: ${selectedRole.name} (${selectedRoleId}) | guild=${guildId} | by=${interaction.user.tag}`);
      }
    } else if (operation === 'remove') {
      const result = await removeColorRole(guildId, selectedRoleId, isBooster);
      const message = result.deleted
        ? `✅ Removed <@&${selectedRoleId}>!`
        : `❌ Failed to remove <@&${selectedRoleId}>!`;

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
        const type = isBooster ? 'booster color' : 'color';
        console.log(`🎨 | Removed ${type} role: ${selectedRole.name} (${selectedRoleId}) | guild=${guildId} | by=${interaction.user.tag}`);
      }
    }
  } catch (error) {
    console.error('Error handling role selection:', sanitizeError(error));

    const errorMsg = 'Failed to process role selection.';

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: errorMsg, flags: MessageFlags.Ephemeral }).catch(() => {});
    } else {
      await interaction.reply({ content: errorMsg, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
}
/**
 * Check if a member is a booster
 */
export async function isMemberBooster(member, guildId) {
  // Check if they have the premium subscriber role (native booster)
  if (member.premiumSince) {
    return true;
  }
  
  // Check custom booster role
  const customBoosterRoleId = await getBoosterRole(guildId);
  if (customBoosterRoleId && member.roles.cache.has(customBoosterRoleId)) {
    return true;
  }
  
  return false;
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
      console.log(`[Colors] Stripped ${rolesToRemove.size} booster color(s) from ${member.user.tag}`);
    } catch (error) {
      console.error(`[Colors] Failed to strip booster colors from ${member.user.tag}:`, error);
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
    const boosterColorIds = getBoosterColorRoleIds(guildId);
    
    if (boosterColorIds.size === 0) {
      return; // No booster colors configured
    }
    
    let audited = 0;
    let stripped = 0;
    
    // Optimize: Only check members who actually have booster color roles
    // This avoids fetching all guild members
    for (const roleId of boosterColorIds) {
      const role = guild.roles.cache.get(roleId);
      if (!role) continue;
      
      // Iterate only members with this booster color (from cache, no fetch!)
      for (const [memberId, member] of role.members) {
        audited++;
        
        // Check if they're still a booster
        if (!isMemberBooster(member, guildId)) {
          await stripBoosterColorsFromMember(member, guildId);
          stripped++;
        }
      }
    }
    
    if (stripped > 0) {
      console.log(`🎨 | Audit complete for ${guild.name}: checked ${audited} members, stripped booster colors from ${stripped}`);
    }
  } catch (error) {
    console.error(`🎨 | Error auditing booster colors for ${guild.name}:`, sanitizeError(error));
  }
}

/**
 * Run audit on all guilds
 */
export async function auditAllGuilds(client) {
  console.log('[Colors] Starting booster color audit across all guilds...');
  
  for (const [guildId, guild] of client.guilds.cache) {
    await auditBoosterColors(guild);
  }
  
  console.log('[Colors] Booster color audit complete');
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
    if (isBooster && !(await isMemberBooster(member, guildId))) {
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
      console.log(`🎨 | User removed color: ${type} role (${roleId}) | user=${member.user.tag} | guild=${guildId}`);
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
      console.log(`🎨 | User selected color: ${type} role (${roleId}) | user=${member.user.tag} | guild=${guildId}`);
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
