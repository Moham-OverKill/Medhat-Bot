import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  ChannelType,
  AttachmentBuilder,
  MessageFlags
} from 'discord.js';
import { generateColorPanelImage } from '../graphics/colorPaletteCard.js';
import {
  addColorRole,
  removeColorRole,
  getColorRoles,
  getAllColorRoles,
  setBoosterRole
} from '../storage/colors.js';
import { sanitizeError, getUserDisplayName, getUserLogName, hasAnyDangerousPermission } from '../shared.js';
import { logServerEvent, sendLog, sendBulkLog, sysLog, sysWarn, sysError } from '../utils/logger.js';

// Helper to check if a member is a server booster
export async function isMemberBooster(member) {
  if (!member) return false;
  // Strictly use Discord's native premiumSince property
  return Boolean(member?.premiumSinceTimestamp);
}

// Re-export canonical dangerous permissions from shared.js
export { DANGEROUS_PERMISSIONS, hasAnyDangerousPermission } from '../shared.js';

// Command definitions
export const colorsCommand = new SlashCommandBuilder()
  .setName('colors')
  .setDescription('Color roles management')
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
    const { verifyAdminAccess } = await import('../storage/admins.js');
    if (!(await verifyAdminAccess(interaction))) return;
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
 * Show color management panel
 */
/**
 * Render the unified Color Dashboard
 */
export async function showColorPanel(interaction, type = 'normal', page = 1) {
  const guildId = interaction.guildId;
  const isBoosterTab = type === 'booster';
  const colors = await getColorRoles(guildId, isBoosterTab);

  const guild = interaction.guild || await interaction.client.guilds.fetch(guildId);
  const allRoles = await guild.roles.fetch();

  const sortedColors = colors
    .map(c => ({ ...c, role: allRoles.get(c.roleId) }))
    .filter(c => c.role)
    .sort((a, b) => b.role.position - a.role.position);

  const PAGE_SIZE = 20;
  const totalItems = sortedColors.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  const currentPage = Math.min(Math.max(1, parseInt(page, 10) || 1), totalPages);

  const startIdx = (currentPage - 1) * PAGE_SIZE;
  const endIdx = startIdx + PAGE_SIZE;
  const pageColors = sortedColors.slice(startIdx, endIdx);

  const titlePrefix = isBoosterTab ? 'Booster Colors' : 'Normal Colors';
  const colorHex = isBoosterTab ? 0xFEE75C : 0x5865F2;

  const description = pageColors.length > 0 
    ? pageColors.map((c, i) => `**${startIdx + i + 1} |** <@&${c.roleId}>`).join('\n')
    : '_No colors configured yet._';

  const embed = new EmbedBuilder()
    .setTitle(`${titlePrefix} ( ${currentPage} / ${totalPages} )`)
    .setDescription(description)
    .setColor(colorHex);

  const components = [];

  // Row 1: Add Role
  const addSelector = new RoleSelectMenuBuilder()
    .setCustomId(`colors_add_${type}_${currentPage}`)
    .setPlaceholder(`➕ Add a color to the ${isBoosterTab ? 'Booster' : 'Normal'} list...`);
  components.push(new ActionRowBuilder().addComponents(addSelector));

  // Row 2: Remove Role (Native Searchable Selector for perfect symmetry)
  const removeSelector = new RoleSelectMenuBuilder()
    .setCustomId(`colors_remove_${type}_${currentPage}`)
    .setPlaceholder(`➖ Remove a color from the ${isBoosterTab ? 'Booster' : 'Normal'} list...`);
  components.push(new ActionRowBuilder().addComponents(removeSelector));

  // Row 3: Tabs & Pagination Controls
  const tabsRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('colors_tab_normal')
      .setLabel('Normal Colors')
      .setEmoji('🎨')
      .setStyle(isBoosterTab ? ButtonStyle.Secondary : ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('colors_tab_booster')
      .setLabel('Booster Colors')
      .setEmoji('🚀')
      .setStyle(isBoosterTab ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`colors_page_prev_${type}_${currentPage}`)
      .setEmoji('◀️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage <= 1),
    new ButtonBuilder()
      .setCustomId(`colors_page_next_${type}_${currentPage}`)
      .setEmoji('▶️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage >= totalPages)
  );
  components.push(tabsRow);

  // Row 4: Navigation / Actions
  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('settings_back')
      .setLabel('Back')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`colors_create_${type}`)
      .setLabel('Create Panel')
      .setEmoji('🖼️')
      .setStyle(ButtonStyle.Success)
  );
  components.push(actionRow);

  // Determine the correct response method based on the interaction state
  const responseMethod = (interaction.deferred || interaction.replied)
    ? 'editReply'
    : (interaction.isButton() || interaction.isAnySelectMenu() ? 'update' : 'editReply');

  await interaction[responseMethod]({
    content: '',
    embeds: [embed],
    components: components,
    files: []
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
 * Render the Color Panel Deployment & Live Preview Screen
 */
export async function showColorDeployPreview(interaction, type = 'normal', targetChannelId = null, previewPanelIndex = 0) {
  const guildId = interaction.guildId;
  const isBooster = type === 'booster';

  // Ensure interaction is acknowledged
  if (!interaction.deferred && !interaction.replied) {
    if (interaction.isButton() || interaction.isAnySelectMenu()) {
      await interaction.deferUpdate().catch(() => {});
    } else {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }

  const colors = await getColorRoles(guildId, isBooster);

  if (!colors || colors.length === 0) {
    const backRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`colors_preview_back_${type}`)
        .setLabel('Back to Colors')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary)
    );

    const responseMethod = (interaction.deferred || interaction.replied)
      ? 'editReply'
      : (interaction.isButton() || interaction.isAnySelectMenu() ? 'update' : 'editReply');

    return await interaction[responseMethod]({
      content: `❌ Add ${isBooster ? 'Booster ' : ''}color roles first before deploying a panel!`,
      embeds: [],
      components: [backRow],
      files: []
    });
  }

  const guild = interaction.guild || await interaction.client.guilds.fetch(guildId);
  const allRoles = await guild.roles.fetch();

  const sortedColors = colors
    .map(c => {
      const role = allRoles.get(c.roleId);
      return {
        ...c,
        role,
        hexColor: role?.hexColor || '#000000',
        name: role?.name || `Role ${c.roleId}`,
        position: role?.position || 0
      };
    })
    .filter(c => c.role)
    .sort((a, b) => b.position - a.position);

  if (sortedColors.length === 0) {
    const backRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`colors_preview_back_${type}`)
        .setLabel('Back to Colors')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary)
    );

    const responseMethod = (interaction.deferred || interaction.replied)
      ? 'editReply'
      : (interaction.isButton() || interaction.isAnySelectMenu() ? 'update' : 'editReply');

    return await interaction[responseMethod]({
      content: '❌ Configured color roles no longer exist on this server.',
      embeds: [],
      components: [backRow],
      files: []
    });
  }

  const channelId = targetChannelId || interaction.channelId;
  const PANELS_COUNT = Math.max(1, Math.ceil(sortedColors.length / 10));
  const currentPanelIdx = Math.min(Math.max(0, parseInt(previewPanelIndex, 10) || 0), PANELS_COUNT - 1);

  const startIdx = currentPanelIdx * 10;
  const endIdx = Math.min(startIdx + 10, sortedColors.length);
  const panelColors = sortedColors.slice(startIdx, endIdx).map((c, i) => ({
    ...c,
    index: startIdx + i + 1
  }));

  const imageBuffer = await generateColorPanelImage(panelColors, {
    isBooster,
    title: isBooster ? 'BOOSTER COLORS' : 'NORMAL COLORS',
    subtitle: 'Select a number button below to equip your color',
    panelIndex: currentPanelIdx,
    totalPanels: PANELS_COUNT
  });

  const attachment = new AttachmentBuilder(imageBuffer, { name: 'color_panel_preview.png' });

  const titlePrefix = isBooster ? 'Booster Colors' : 'Normal Colors';
  const colorHex = isBooster ? 0xFEE75C : 0x5865F2;

  const embed = new EmbedBuilder()
    .setTitle(`${titlePrefix} Deployment Preview ( ${currentPanelIdx + 1} / ${PANELS_COUNT} )`)
    .setDescription([
      `• **Target Channel:** <#${channelId}>`,
      `• **Total Colors:** ${sortedColors.length} (${PANELS_COUNT} panel${PANELS_COUNT > 1 ? 's' : ''})`,
      `• **Previewing Panel ${currentPanelIdx + 1}:** Colors ${startIdx + 1} – ${endIdx}`,
      '',
      'Review the panel preview image below. Select the target channel and click **Post to Channel** when ready to publish.'
    ].join('\n'))
    .setColor(colorHex)
    .setImage('attachment://color_panel_preview.png');

  const components = [];

  // Row 0: Target Channel Selector
  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId(`colors_preview_channel_${type}_${currentPanelIdx}`)
    .setPlaceholder('Select target channel for color panel deployment...')
    .setChannelTypes(ChannelType.GuildText);
  if (channelId) {
    channelSelect.setDefaultChannels([channelId]);
  }
  components.push(new ActionRowBuilder().addComponents(channelSelect));

  // Row 1: Panel Navigation (if multiple panels)
  if (PANELS_COUNT > 1) {
    const navRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`colors_preview_prev_${type}_${currentPanelIdx}_${channelId}`)
        .setEmoji('◀️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPanelIdx <= 0),
      new ButtonBuilder()
        .setCustomId(`colors_preview_next_${type}_${currentPanelIdx}_${channelId}`)
        .setEmoji('▶️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPanelIdx >= PANELS_COUNT - 1)
    );
    components.push(navRow);
  }

  // Row 2: Back and Post buttons
  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`colors_preview_back_${type}`)
      .setLabel('Back')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`colors_preview_publish_${type}_${channelId}`)
      .setLabel('Post to Channel')
      .setEmoji('🚀')
      .setStyle(ButtonStyle.Success)
  );
  components.push(actionRow);

  const responseMethod = (interaction.deferred || interaction.replied)
    ? 'editReply'
    : (interaction.isButton() || interaction.isAnySelectMenu() ? 'update' : 'editReply');

  await interaction[responseMethod]({
    content: '',
    embeds: [embed],
    components,
    files: [attachment]
  });
}

/**
 * Deploy generated color panels to the selected target channel
 */
async function deployColorPanels(interaction, type, channelId) {
  const guildId = interaction.guildId;
  const isBooster = type === 'booster';
  const guild = interaction.guild || await interaction.client.guilds.fetch(guildId);
  const targetChannel = await guild.channels.fetch(channelId).catch(() => null);

  if (!targetChannel || !targetChannel.isTextBased()) {
    return interaction.followUp({
      content: '❌ Invalid target channel. Please select an active text channel.',
      flags: MessageFlags.Ephemeral
    });
  }

  // Permission verification
  const botMember = await guild.members.fetchMe().catch(() => null);
  const perms = targetChannel.permissionsFor(botMember);
  if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles])) {
    return interaction.editReply({
      content: `❌ **Missing Permissions:** I need permissions to **View Channel**, **Send Messages**, and **Attach Files** in <#${channelId}>.`,
      embeds: [],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`colors_preview_back_${type}`)
            .setLabel('Back to Colors')
            .setEmoji('⬅️')
            .setStyle(ButtonStyle.Secondary)
        )
      ],
      files: []
    });
  }

  const colors = await getColorRoles(guildId, isBooster);
  const allRoles = await guild.roles.fetch();

  const sortedColors = colors
    .map(c => {
      const role = allRoles.get(c.roleId);
      return {
        ...c,
        role,
        hexColor: role?.hexColor || '#000000',
        name: role?.name || `Role ${c.roleId}`,
        position: role?.position || 0
      };
    })
    .filter(c => c.role)
    .sort((a, b) => b.position - a.position);

  if (sortedColors.length === 0) {
    return interaction.followUp({
      content: '❌ No valid color roles available to post.',
      flags: MessageFlags.Ephemeral
    });
  }

  const PANELS_COUNT = Math.ceil(sortedColors.length / 10);

  for (let p = 0; p < PANELS_COUNT; p++) {
    const startIdx = p * 10;
    const endIdx = Math.min(startIdx + 10, sortedColors.length);
    const panelColors = sortedColors.slice(startIdx, endIdx).map((c, i) => ({
      ...c,
      index: startIdx + i + 1
    }));

    const imageBuffer = await generateColorPanelImage(panelColors, {
      isBooster,
      title: isBooster ? 'BOOSTER COLORS' : 'NORMAL COLORS',
      subtitle: 'Select a number button below to equip your color',
      panelIndex: p,
      totalPanels: PANELS_COUNT
    });

    const panelAttachment = new AttachmentBuilder(imageBuffer, { name: `colors_${type}_${p + 1}.png` });

    // Create 2 rows of up to 5 buttons each
    const rows = [];
    for (let r = 0; r < 2; r++) {
      const rowStart = r * 5;
      const rowEnd = Math.min(rowStart + 5, panelColors.length);
      if (rowStart >= panelColors.length) break;

      const buttons = [];
      for (let i = rowStart; i < rowEnd; i++) {
        const colorItem = panelColors[i];
        const paddedLabel = String(colorItem.index).padStart(2, '0');
        buttons.push(
          new ButtonBuilder()
            .setCustomId(`color_${type}_${colorItem.roleId}`)
            .setLabel(paddedLabel)
            .setStyle(ButtonStyle.Primary)
        );
      }
      if (buttons.length > 0) {
        rows.push(new ActionRowBuilder().addComponents(buttons));
      }
    }

    try {
      await targetChannel.send({
        files: [panelAttachment],
        components: rows
      });
    } catch (sendErr) {
      sysError('Failed to send visual color panel', sendErr, { guild: guildId, channel: channelId });
      return interaction.editReply({
        content: `❌ Failed to send color panel ${p + 1} to <#${channelId}>: ${sendErr?.message || 'Discord error'}`,
        embeds: [],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`colors_preview_back_${type}`)
              .setLabel('Back to Colors')
              .setEmoji('⬅️')
              .setStyle(ButtonStyle.Secondary)
          )
        ],
        files: []
      });
    }
  }

  const logName = getUserLogName(interaction);
  sendLog(guild, 'audit', 'cyan', `🎨 ${isBooster ? 'Booster ' : ''}Color Panels Deployed`,
    `**Admin:** \`${logName}\`\n**Target Channel:** <#${channelId}>\n**Panels:** ${PANELS_COUNT} (${sortedColors.length} colors)`
  );

  const successEmbed = new EmbedBuilder()
    .setTitle('Color Panels Deployed')
    .setDescription(`Successfully published **${PANELS_COUNT}** ${isBooster ? 'Booster' : 'Normal'} color panel${PANELS_COUNT > 1 ? 's' : ''} to <#${channelId}>.`)
    .setColor(isBooster ? 0xFEE75C : 0x5865F2);

  const backRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`colors_preview_back_${type}`)
      .setLabel('Back to Colors')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary)
  );

  await interaction.editReply({
    content: '',
    embeds: [successEmbed],
    components: [backRow],
    files: []
  });
}

/**
 * Handle colors component (menu selections)
 */
export async function handleColorsComponent(interaction) {
  const customId = interaction.customId;
  const guildId = interaction.guildId;

  // D-07 FIX: Removed stray console.log debug trace (sysLog below handles structured logging)

  try {
    sysLog('Color Dashboard Interaction', { id: customId, guild: guildId, user: interaction.user.id });

    // Forced immediate acknowledgment to kill "Interaction Failed" errors
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => {});
    }

    // 1. Handle Tab Switching
    if (customId === 'colors_tab_normal') {
      return await showColorPanel(interaction, 'normal', 1);
    }
    if (customId === 'colors_tab_booster') {
      return await showColorPanel(interaction, 'booster', 1);
    }

    // 2. Handle Pagination Navigation
    if (customId.startsWith('colors_page_')) {
      const parts = customId.split('_'); // ['colors', 'page', 'prev'|'next', type, currentPage]
      const dir = parts[2];
      const type = parts[3] === 'booster' ? 'booster' : 'normal';
      const pageNum = parseInt(parts[4], 10) || 1;
      const targetPage = dir === 'next' ? pageNum + 1 : pageNum - 1;
      return await showColorPanel(interaction, type, targetPage);
    }

    // 3. Handle Add/Remove via Select Menus
    if (interaction.isAnySelectMenu()) {
      if (customId.startsWith('colors_add_')) {
        const parts = customId.split('_');
        const type = parts[2] === 'booster' ? 'booster' : 'normal';
        const page = parseInt(parts[3], 10) || 1;
        const roleId = interaction.values[0];
        sysLog('Adding color role', { roleId, type, page, guild: guildId });
        return await processRoleAddition(interaction, guildId, roleId, type === 'booster', page);
      }

      if (customId.startsWith('colors_remove_')) {
        const parts = customId.split('_');
        const type = parts[2] === 'booster' ? 'booster' : 'normal';
        const page = parseInt(parts[3], 10) || 1;
        const roleId = interaction.values[0];
        sysLog('Removing color role', { roleId, type, page, guild: guildId });
        return await processRoleRemoval(interaction, guildId, roleId, type === 'booster', page);
      }
    }

    // 4. Handle Create Panel Buttons (Open Deployment Preview)
    if (customId === 'colors_create_normal') {
      return await showColorDeployPreview(interaction, 'normal');
    }
    if (customId === 'colors_create_booster') {
      return await showColorDeployPreview(interaction, 'booster');
    }

    // 5. Handle Deployment Preview Interactions
    if (customId.startsWith('colors_preview_channel_')) {
      const parts = customId.split('_'); // ['colors', 'preview', 'channel', type, panelIdx]
      const type = parts[3];
      const panelIdx = parseInt(parts[4], 10) || 0;
      const selectedChannel = interaction.values[0];
      return await showColorDeployPreview(interaction, type, selectedChannel, panelIdx);
    }

    if (customId.startsWith('colors_preview_prev_') || customId.startsWith('colors_preview_next_')) {
      const parts = customId.split('_'); // ['colors', 'preview', 'prev'|'next', type, panelIdx, channelId]
      const dir = parts[2];
      const type = parts[3];
      const panelIdx = parseInt(parts[4], 10) || 0;
      const channelId = parts[5];
      const targetPanel = dir === 'next' ? panelIdx + 1 : panelIdx - 1;
      return await showColorDeployPreview(interaction, type, channelId, targetPanel);
    }

    if (customId.startsWith('colors_preview_back_')) {
      const parts = customId.split('_'); // ['colors', 'preview', 'back', type]
      const type = parts[3] === 'booster' ? 'booster' : 'normal';
      return await showColorPanel(interaction, type, 1);
    }

    if (customId.startsWith('colors_preview_publish_')) {
      const parts = customId.split('_'); // ['colors', 'preview', 'publish', type, channelId]
      const type = parts[3] === 'booster' ? 'booster' : 'normal';
      const channelId = parts[4];
      return await deployColorPanels(interaction, type, channelId);
    }

    sysLog('Unmatched color interaction', { id: customId });
    // If nothing matched, refresh the dashboard as a fallback
    return await showColorPanel(interaction, 'normal');

  } catch (error) {
    sysError('Colors dashboard route failed', error, { 
      user: interaction.user.id, 
      guild: guildId, 
      customId: customId,
      stack: error.stack 
    });

    const errorMsg = '❌ **Failed to process action.** The dashboard encountered an error.';
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
async function processRoleAddition(interaction, guildId, roleId, isBooster, page = 1) {
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
    return await showColorPanel(interaction, isBooster ? 'booster' : 'normal', page);
  } else {
    return interaction.followUp({ content: `❌ Database error: ${result.error}`, flags: MessageFlags.Ephemeral });
  }
}

/**
 * Shared logic for removing a color role
 */
async function processRoleRemoval(interaction, guildId, roleId, isBooster, page = 1) {
  const result = await removeColorRole(guildId, roleId, isBooster);
  
  if (result.deleted) {
    const guild = interaction.guild || await interaction.client.guilds.fetch(guildId);
    const logName = getUserLogName(interaction);
    sendLog(guild, 'audit', 'red', `🎨 ${isBooster ? 'Booster ' : ''}Color Removed`, 
      `**Admin:** \`${logName}\`\n**Action:** Removed role ID \`${roleId}\` from the list.`
    );
    // Refresh dashboard
    return await showColorPanel(interaction, isBooster ? 'booster' : 'normal', page);
  } else {
    return interaction.followUp({ 
      content: `❌ That role is not in the ${isBooster ? 'Booster' : 'Normal'} color list.`, 
      flags: MessageFlags.Ephemeral 
    });
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

    // Defer the update immediately to prevent timeout
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => {});
    }

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
      return await showColorPanel(interaction, 'booster');
    }

    if (operation === 'add') {
      return await processRoleAddition(interaction, guildId, selectedRoleId, isBooster);
    } else if (operation === 'remove') {
      return await processRoleRemoval(interaction, guildId, selectedRoleId, isBooster);
    }

    return await showColorPanel(interaction, isBooster ? 'booster' : 'normal');
  } catch (error) {
    sysError('Colors role selection failed', error, { user: interaction.user.id, guild: interaction.guildId });
    const errorMsg = '❌ Failed to process role selection.';
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: errorMsg, flags: MessageFlags.Ephemeral }).catch(() => {});
    } else {
      await interaction.reply({ content: errorMsg, flags: MessageFlags.Ephemeral }).catch(() => {});
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
      await interaction.editReply({ files: [], content: '❌ Boost the server to unlock this color!', });
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
        return interaction.editReply({ files: [], content: '❌ I cannot remove this role because it is positioned above me in the hierarchy. Move the bot role higher!', });
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

      // Add the new color role (Check hierarchy and security first)
      const targetRole = interaction.guild.roles.cache.get(roleId) || await interaction.guild.roles.fetch(roleId).catch(() => null);
      if (targetRole && botMember && targetRole.position >= botMember.roles.highest.position) {
        return interaction.editReply({ files: [], content: '❌ I cannot assign this role because it is positioned above me in the hierarchy. Please move the bot\'s role higher.', });
      }

      if (targetRole && hasAnyDangerousPermission(targetRole)) {
        sysWarn('Dangerous Color Role Assignment Blocked', { user: member.id, guild: interaction.guildId, role: roleId, detail: 'Target color role holds dangerous permissions' });
        return interaction.editReply({ files: [], content: '❌ This color role holds administrative or moderation permissions and cannot be assigned.', });
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
      await interaction.editReply({ files: [], content: errorMsg }).catch(() => { });
    } else {
      await interaction.reply({ content: errorMsg, flags: MessageFlags.Ephemeral }).catch(() => { });
    }
  }
}
