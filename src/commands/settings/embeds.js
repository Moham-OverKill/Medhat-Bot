import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  PermissionFlagsBits
} from 'discord.js';
import { getPool } from '../../storage/postgres.js';
import { sysError, sysLog } from '../../utils/logger.js';
import { createErrorEmbed, handleInteractionError, diagnoseChannelPermissions } from '../../utils/errors.js';

const DEFAULT_EMBED_COLOR = 0x2F3136;

/**
 * Validate image URL: must be HTTP/HTTPS and either have an image extension or be a known image host
 */
function isValidImageUrl(string) {
  if (!string || typeof string !== 'string') return false;
  try {
    const url = new URL(string.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const pathAndSearch = (url.pathname + url.search).toLowerCase();
    const hasImageExt = /\.(png|jpe?g|gif|webp|bmp|svg)($|\?)/i.test(pathAndSearch);
    const isImageHost = /(cdn\.discordapp\.com|media\.discordapp\.net|imgur\.com|tenor\.com|giphy\.com|unsplash\.com|pinimg\.com)/i.test(url.hostname);
    return hasImageExt || isImageHost;
  } catch (_) {
    return false;
  }
}

/**
 * Validate and normalize Hex Color code.
 * Returns #RRGGBB if valid, null if empty string, false if invalid.
 */
function validateHexColor(string) {
  if (!string || typeof string !== 'string') return null;
  const trimmed = string.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^#?([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/);
  if (!match) return false;
  let hex = match[1];
  if (hex.length === 3) {
    hex = hex.split('').map(c => c + c).join('');
  }
  return `#${hex.toUpperCase()}`;
}

/**
 * Build a Discord EmbedBuilder from a server_embeds record
 */
function buildDiscordEmbed(emb) {
  const embed = new EmbedBuilder();

  // Color resolution
  if (emb.color) {
    const validHex = validateHexColor(emb.color);
    if (validHex) {
      embed.setColor(parseInt(validHex.replace('#', ''), 16));
    } else {
      embed.setColor(DEFAULT_EMBED_COLOR);
    }
  } else {
    embed.setColor(DEFAULT_EMBED_COLOR);
  }

  // Author header
  if (emb.author_name) {
    const authorObj = { name: emb.author_name };
    if (emb.author_icon_url && isValidImageUrl(emb.author_icon_url)) {
      authorObj.iconURL = emb.author_icon_url.trim();
    }
    embed.setAuthor(authorObj);
  }

  // Title
  if (emb.title) {
    embed.setTitle(emb.title);
  }

  // Content / Description
  if (emb.content && emb.content.trim().length > 0) {
    embed.setDescription(emb.content.trim());
  } else if (!emb.title && !emb.author_name && !emb.image_url && !emb.thumbnail_url && !emb.footer_text) {
    embed.setDescription('*Empty Embed*');
  }

  // Top Icon (Thumbnail)
  if (emb.thumbnail_url && isValidImageUrl(emb.thumbnail_url)) {
    embed.setThumbnail(emb.thumbnail_url.trim());
  }

  // Main Image (Banner)
  if (emb.image_url && isValidImageUrl(emb.image_url)) {
    embed.setImage(emb.image_url.trim());
  }

  // Footer
  if (emb.footer_text) {
    const footerObj = { text: emb.footer_text };
    if (emb.footer_icon_url && isValidImageUrl(emb.footer_icon_url)) {
      footerObj.iconURL = emb.footer_icon_url.trim();
    }
    embed.setFooter(footerObj);
  }

  return embed;
}

/**
 * Resolves the display name for an embed or embed group.
 * Priority: Title -> Author Name -> Footer Text -> Content/Description -> 'No Title'
 * Strictly avoids returning 'Embed #id' or 'Group #id'.
 */
function getEmbedDisplayName(emb) {
  if (!emb) return 'No Title';
  const title = emb.title?.trim();
  if (title) return title.slice(0, 100);

  const author = emb.author_name?.trim();
  if (author) return author.slice(0, 100);

  const footer = emb.footer_text?.trim();
  if (footer) return footer.slice(0, 100);

  const content = emb.content?.trim();
  if (content) return content.replace(/\n+/g, ' ').slice(0, 100);

  const name = emb.name?.trim();
  if (name && !name.startsWith('Group #') && !name.startsWith('Embed #') && name !== 'Untitled Group') {
    return name.slice(0, 100);
  }

  return 'No Title';
}

/**
 * Render the Root Embed Menu displaying saved embeds and saved embed groups
 */
export async function renderRootEmbedMenu(interaction) {
  const guildId = interaction.guildId;
  const pool = getPool();

  const [embedsResult, groupsResult] = await Promise.all([
    pool.query(
      `SELECT id, title, content, author_name, footer_text FROM server_embeds WHERE guild_id = $1 ORDER BY id ASC`,
      [guildId]
    ).catch(err => {
      sysError('Failed to fetch server embeds', err, { guild: guildId });
      return { rows: [] };
    }),
    pool.query(
      `SELECT id, name, title, content, author_name, footer_text FROM server_embed_groups WHERE guild_id = $1 ORDER BY id ASC`,
      [guildId]
    ).catch(err => {
      sysError('Failed to fetch server embed groups', err, { guild: guildId });
      return { rows: [] };
    })
  ]);

  const embeds = embedsResult.rows;
  const groups = groupsResult.rows;

  const menuEmbed = new EmbedBuilder()
    .setTitle('Embed Manager')
    .setDescription('Select an existing embed or group to manage, or create a new one.')
    .setColor(DEFAULT_EMBED_COLOR);

  // Menu 1: Individual Embeds
  const embedOptions = [
    {
      label: 'Create Embed',
      value: 'create',
      emoji: '➕'
    }
  ];

  for (const emb of embeds.slice(0, 24)) {
    const label = getEmbedDisplayName(emb);
    embedOptions.push({
      label,
      value: String(emb.id),
      emoji: '📰'
    });
  }

  const embedSelectMenu = new StringSelectMenuBuilder()
    .setCustomId('embed_root_select')
    .setPlaceholder('Select an embed to manage...')
    .addOptions(embedOptions);

  // Menu 2: Embed Groups
  const groupOptions = [
    {
      label: 'Create Group',
      value: 'create_group',
      emoji: '➕'
    }
  ];

  for (const grp of groups.slice(0, 24)) {
    const label = getEmbedDisplayName(grp);
    groupOptions.push({
      label,
      value: String(grp.id),
      emoji: '📁'
    });
  }

  const groupSelectMenu = new StringSelectMenuBuilder()
    .setCustomId('embed_group_root_select')
    .setPlaceholder('Select a group to manage...')
    .addOptions(groupOptions);

  const embedRow = new ActionRowBuilder().addComponents(embedSelectMenu);
  const groupRow = new ActionRowBuilder().addComponents(groupSelectMenu);

  // Back button strictly on the far left
  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('settings_home')
      .setLabel('Back')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary)
  );

  const responseMethod = (interaction.deferred || interaction.replied)
    ? 'editReply'
    : (interaction.isButton() || interaction.isAnySelectMenu() ? 'update' : 'editReply');

  await interaction[responseMethod]({
    content: '',
    embeds: [menuEmbed],
    components: [embedRow, groupRow, navRow]
  });
}

/**
 * Render the Manage Page for a specific embed
 * Layout:
 * Row 1: [ ✏️ Edit Text ] | [ 🖼️ Edit Images ]
 * Row 2: [ 🔄 Update ] | [ 📤 Send ]
 * Row 3: [ ⬅️ Back ]
 */
export async function renderEmbedManagePage(interaction, embedId) {
  const guildId = interaction.guildId;
  const pool = getPool();

  const result = await pool.query(
    `SELECT * FROM server_embeds WHERE id = $1 AND guild_id = $2`,
    [embedId, guildId]
  ).catch(err => {
    sysError('Failed to fetch embed by ID', err, { guild: guildId, id: embedId });
    return { rows: [] };
  });

  if (result.rows.length === 0) {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => {});
    }
    return renderRootEmbedMenu(interaction);
  }

  const emb = result.rows[0];
  const previewEmbed = buildDiscordEmbed(emb);

  // Row 1: Edit Text - Edit Images
  const actionRow1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`embed_edit_text_${emb.id}`)
      .setLabel('Edit Text')
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`embed_edit_images_${emb.id}`)
      .setLabel('Edit Images')
      .setEmoji('🖼️')
      .setStyle(ButtonStyle.Secondary)
  );

  // Row 2: Update - Send
  const actionRow2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`embed_update_${emb.id}`)
      .setLabel('Update')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`embed_send_${emb.id}`)
      .setLabel('Send')
      .setEmoji('📤')
      .setStyle(ButtonStyle.Secondary)
  );

  // Row 3: Back
  const actionRow3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('embed_back_root')
      .setLabel('Back')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary)
  );

  const responseMethod = (interaction.deferred || interaction.replied)
    ? 'editReply'
    : (interaction.isButton() || interaction.isAnySelectMenu() ? 'update' : 'editReply');

  await interaction[responseMethod]({
    content: '',
    embeds: [previewEmbed],
    components: [actionRow1, actionRow2, actionRow3]
  });
}

/**
 * Render the Channel Selection view for sending an embed
 */
export async function renderEmbedSendPage(interaction, embedId) {
  const guildId = interaction.guildId;
  const pool = getPool();

  const result = await pool.query(
    `SELECT id, title, author_name, footer_text FROM server_embeds WHERE id = $1 AND guild_id = $2`,
    [embedId, guildId]
  );

  if (result.rows.length === 0) {
    return renderRootEmbedMenu(interaction);
  }

  const emb = result.rows[0];

  const infoEmbed = new EmbedBuilder()
    .setTitle('Send Embed')
    .setDescription(`Choose the text channel where **${getEmbedDisplayName(emb)}** should be posted.`)
    .setColor(DEFAULT_EMBED_COLOR);

  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId(`embed_channel_select_${embedId}`)
    .setPlaceholder('Select target channel...')
    .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

  const selectRow = new ActionRowBuilder().addComponents(channelSelect);

  // Back button strictly on far left
  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`embed_manage_${embedId}`)
      .setLabel('Back')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary)
  );

  const responseMethod = (interaction.deferred || interaction.replied)
    ? 'editReply'
    : (interaction.isButton() ? 'update' : 'editReply');

  await interaction[responseMethod]({
    content: '',
    embeds: [infoEmbed],
    components: [selectRow, navRow]
  });
}

/**
 * Render the Manage Page for an Embed Group
 * Layout:
 * Row 1: [ ✏️ Edit Text ] | [ 🖼️ Edit Images ]
 * Row 2: [ 🔗 Manage Attached Embeds ]
 * Row 3: [ 🔄 Update ] | [ 📤 Send ]
 * Row 4: [ ⬅️ Back ]
 */
export async function renderGroupManagePage(interaction, groupId) {
  const guildId = interaction.guildId;
  const pool = getPool();

  const [groupRes, itemsRes] = await Promise.all([
    pool.query(
      `SELECT * FROM server_embed_groups WHERE id = $1 AND guild_id = $2`,
      [groupId, guildId]
    ).catch(err => {
      sysError('Failed to fetch embed group by ID', err, { guild: guildId, id: groupId });
      return { rows: [] };
    }),
    pool.query(
      `SELECT count(*) as total FROM server_embed_group_items WHERE group_id = $1`,
      [groupId]
    ).catch(() => ({ rows: [{ total: 0 }] }))
  ]);

  if (groupRes.rows.length === 0) {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => {});
    }
    return renderRootEmbedMenu(interaction);
  }

  const grp = groupRes.rows[0];
  const previewEmbed = buildDiscordEmbed(grp);
  const attachedCount = parseInt(itemsRes.rows[0]?.total || 0, 10);

  // Row 1: Edit Text - Edit Images
  const actionRow1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`embed_group_edit_text_${grp.id}`)
      .setLabel('Edit Text')
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`embed_group_edit_images_${grp.id}`)
      .setLabel('Edit Images')
      .setEmoji('🖼️')
      .setStyle(ButtonStyle.Secondary)
  );

  // Row 2: Manage Attached Embeds
  const actionRow2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`embed_group_attach_${grp.id}`)
      .setLabel(`Manage Attached Embeds (${attachedCount})`)
      .setEmoji('🔗')
      .setStyle(ButtonStyle.Primary)
  );

  // Row 3: Update - Send
  const actionRow3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`embed_group_update_${grp.id}`)
      .setLabel('Update')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`embed_group_send_${grp.id}`)
      .setLabel('Send')
      .setEmoji('📤')
      .setStyle(ButtonStyle.Secondary)
  );

  // Row 4: Back
  const actionRow4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('embed_back_root')
      .setLabel('Back')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary)
  );

  const responseMethod = (interaction.deferred || interaction.replied)
    ? 'editReply'
    : (interaction.isButton() || interaction.isAnySelectMenu() ? 'update' : 'editReply');

  await interaction[responseMethod]({
    content: '',
    embeds: [previewEmbed],
    components: [actionRow1, actionRow2, actionRow3, actionRow4]
  });
}

/**
 * Render the Attached Embeds Management Page for an Embed Group
 */
export async function renderGroupAttachedEmbedsPage(interaction, groupId) {
  const guildId = interaction.guildId;
  const pool = getPool();

  const [allEmbedsRes, attachedRes, groupRes] = await Promise.all([
    pool.query(
      `SELECT id, title, content, author_name, footer_text FROM server_embeds WHERE guild_id = $1 ORDER BY id ASC`,
      [guildId]
    ).catch(err => {
      sysError('Failed to fetch server embeds for group attach', err, { guild: guildId });
      return { rows: [] };
    }),
    pool.query(
      `SELECT embed_id FROM server_embed_group_items WHERE group_id = $1 ORDER BY display_order ASC`,
      [groupId]
    ).catch(() => ({ rows: [] })),
    pool.query(
      `SELECT id, name, title, author_name, footer_text FROM server_embed_groups WHERE id = $1 AND guild_id = $2`,
      [groupId, guildId]
    ).catch(() => ({ rows: [] }))
  ]);

  if (groupRes.rows.length === 0) return renderRootEmbedMenu(interaction);
  const grp = groupRes.rows[0];

  const allEmbeds = allEmbedsRes.rows;
  const attachedIds = new Set(attachedRes.rows.map(r => r.embed_id));
  const groupDisplayName = getEmbedDisplayName(grp);

  const infoEmbed = new EmbedBuilder()
    .setTitle(`Attach Embeds — ${groupDisplayName}`)
    .setDescription(
      allEmbeds.length === 0
        ? 'No individual embeds found in this server. Please create embeds first before attaching them.'
        : 'Select which embeds should appear in the public dropdown for this group. You can select multiple items.'
    )
    .setColor(DEFAULT_EMBED_COLOR);

  const components = [];

  if (allEmbeds.length > 0) {
    const options = allEmbeds.slice(0, 25).map(emb => {
      const label = getEmbedDisplayName(emb);
      return {
        label,
        value: String(emb.id),
        emoji: '📄',
        default: attachedIds.has(emb.id)
      };
    });

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`embed_group_save_attach_${groupId}`)
      .setPlaceholder('Select embeds to attach (check / uncheck)...')
      .setMinValues(0)
      .setMaxValues(Math.min(options.length, 25))
      .addOptions(options);

    components.push(new ActionRowBuilder().addComponents(selectMenu));
  }

  // Back button to Group Manage
  components.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`embed_group_manage_${groupId}`)
        .setLabel('Back to Group')
        .setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary)
    )
  );

  const responseMethod = (interaction.deferred || interaction.replied)
    ? 'editReply'
    : (interaction.isButton() || interaction.isAnySelectMenu() ? 'update' : 'editReply');

  await interaction[responseMethod]({
    content: '',
    embeds: [infoEmbed],
    components
  });
}

/**
 * Render the Channel Selection view for sending an Embed Group
 */
export async function renderGroupSendPage(interaction, groupId) {
  const guildId = interaction.guildId;
  const pool = getPool();

  const [groupRes, itemsRes] = await Promise.all([
    pool.query(
      `SELECT id, name, title, author_name, footer_text FROM server_embed_groups WHERE id = $1 AND guild_id = $2`,
      [groupId, guildId]
    ),
    pool.query(
      `SELECT count(*) as total FROM server_embed_group_items WHERE group_id = $1`,
      [groupId]
    )
  ]);

  if (groupRes.rows.length === 0) return renderRootEmbedMenu(interaction);
  const grp = groupRes.rows[0];
  const attachedCount = parseInt(itemsRes.rows[0]?.total || 0, 10);
  const groupDisplayName = getEmbedDisplayName(grp);

  if (attachedCount === 0) {
    const errorEmbed = createErrorEmbed(
      'No Attached Embeds',
      'You must attach at least one embed to this group before sending it to a public channel.'
    );
    await interaction.followUp?.({
      embeds: [errorEmbed],
      flags: MessageFlags.Ephemeral
    }).catch(() => {});
    return renderGroupManagePage(interaction, groupId);
  }

  const sendEmbed = new EmbedBuilder()
    .setTitle(`Send Group — ${groupDisplayName}`)
    .setDescription('Select the target channel where this group embed and public dropdown will be sent.')
    .setColor(DEFAULT_EMBED_COLOR);

  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId(`embed_group_channel_select_${groupId}`)
    .setPlaceholder('Select a channel...')
    .setChannelTypes([ChannelType.GuildText, ChannelType.GuildAnnouncement]);

  const selectRow = new ActionRowBuilder().addComponents(channelSelect);
  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`embed_group_manage_${groupId}`)
      .setLabel('Back to Group')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary)
  );

  const responseMethod = (interaction.deferred || interaction.replied)
    ? 'editReply'
    : (interaction.isButton() || interaction.isAnySelectMenu() ? 'update' : 'editReply');

  await interaction[responseMethod]({
    content: '',
    embeds: [sendEmbed],
    components: [selectRow, navRow]
  });
}

/**
 * Handle channel selection and dispatch of an Embed Group
 */
async function handleGroupChannelSend(interaction, groupId) {
  await interaction.deferUpdate().catch(() => {});

  const guildId = interaction.guildId;
  const channelId = interaction.values?.[0];
  if (!channelId) return renderGroupManagePage(interaction, groupId);

  const guild = interaction.guild;
  const channel = guild?.channels.cache.get(channelId) || await guild?.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    const errorEmbed = createErrorEmbed(
      'Channel Unavailable',
      'The selected channel could not be found or the bot lacks access to view it.'
    );
    await interaction.followUp({
      embeds: [errorEmbed],
      flags: MessageFlags.Ephemeral
    });
    return renderGroupManagePage(interaction, groupId);
  }

  const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
  const diag = diagnoseChannelPermissions(channel, botMember, [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks
  ]);

  if (!diag.hasAll) {
    const errorEmbed = createErrorEmbed(
      'Missing Permissions',
      `${diag.explanation}\n\n${diag.fixInstructions}`
    );
    await interaction.followUp({
      embeds: [errorEmbed],
      flags: MessageFlags.Ephemeral
    });
    return renderGroupManagePage(interaction, groupId);
  }

  const pool = getPool();
  const [groupRes, itemsRes] = await Promise.all([
    pool.query(
      `SELECT * FROM server_embed_groups WHERE id = $1 AND guild_id = $2`,
      [groupId, guildId]
    ),
    pool.query(
      `SELECT se.* FROM server_embeds se
       JOIN server_embed_group_items segi ON se.id = segi.embed_id
       WHERE segi.group_id = $1
       ORDER BY segi.display_order ASC`,
      [groupId]
    )
  ]);

  if (groupRes.rows.length === 0) return renderRootEmbedMenu(interaction);
  const grp = groupRes.rows[0];
  const items = itemsRes.rows;

  if (items.length === 0) {
    const errorEmbed = createErrorEmbed(
      'No Attached Embeds',
      'No embeds are attached to this group. Attach at least one embed before sending.'
    );
    await interaction.followUp({
      embeds: [errorEmbed],
      flags: MessageFlags.Ephemeral
    });
    return renderGroupManagePage(interaction, groupId);
  }

  const groupEmbed = buildDiscordEmbed(grp);

  const publicOptions = items.slice(0, 25).map(item => {
    const label = getEmbedDisplayName(item);
    return {
      label,
      value: String(item.id),
      emoji: '📄'
    };
  });

  const publicSelectMenu = new StringSelectMenuBuilder()
    .setCustomId('embed_public_group_select')
    .setPlaceholder('Select')
    .addOptions(publicOptions);

  const publicRow = new ActionRowBuilder().addComponents(publicSelectMenu);

  try {
    const sentMsg = await channel.send({
      embeds: [groupEmbed],
      components: [publicRow]
    });

    // Save to server_embed_group_posts
    await pool.query(
      `INSERT INTO server_embed_group_posts (message_id, guild_id, group_id, channel_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (message_id) DO NOTHING`,
      [sentMsg.id, guildId, groupId, channelId]
    );

    // Update group tracked message
    await pool.query(
      `UPDATE server_embed_groups
       SET tracked_message_id = $1, tracked_channel_id = $2, updated_at = NOW()
       WHERE id = $3 AND guild_id = $4`,
      [sentMsg.id, channelId, groupId, guildId]
    );

    sysLog('Embed Group Sent to Channel', {
      guild: guildId,
      user: interaction.user.id,
      detail: `Group: ${grp.name} | Channel: ${channel.name} | Message ID: ${sentMsg.id}`
    });

    const jumpUrl = `https://discord.com/channels/${guildId}/${channelId}/${sentMsg.id}`;
    await interaction.followUp({
      content: `✅ Embed group **${grp.title || grp.name}** successfully sent to <#${channelId}>! [Jump to Message](${jumpUrl})`,
      flags: MessageFlags.Ephemeral
    });

    return renderGroupManagePage(interaction, groupId);
  } catch (err) {
    sysError('Failed to send embed group to channel', err, { guild: guildId, id: groupId, channel: channelId });
    await handleInteractionError(interaction, err, 'Send Embed Group', { targetChannel: channel });
    return renderGroupManagePage(interaction, groupId);
  }
}

/**
 * Handle public interaction from the group select menu
 * Strictly delivers the requested embed ephemerally to the clicking user
 */
export async function handlePublicGroupSelect(interaction) {
  const guildId = interaction.guildId;
  const selectedEmbedId = parseInt(interaction.values?.[0], 10);
  if (isNaN(selectedEmbedId)) {
    const errorEmbed = createErrorEmbed(
      'Invalid Selection',
      'The selected topic is invalid.'
    );
    return interaction.reply({
      embeds: [errorEmbed],
      flags: MessageFlags.Ephemeral
    });
  }

  const pool = getPool();
  const result = await pool.query(
    `SELECT * FROM server_embeds WHERE id = $1 AND guild_id = $2`,
    [selectedEmbedId, guildId]
  ).catch(err => {
    sysError('Failed to fetch embed for public group selection', err, { guild: guildId, id: selectedEmbedId });
    return { rows: [] };
  });

  if (result.rows.length === 0) {
    const errorEmbed = createErrorEmbed(
      'Topic Unavailable',
      'This topic is no longer available.'
    );
    return interaction.reply({
      embeds: [errorEmbed],
      flags: MessageFlags.Ephemeral
    });
  }

  const embedItem = result.rows[0];
  const responseEmbed = buildDiscordEmbed(embedItem);

  await interaction.reply({
    embeds: [responseEmbed],
    flags: MessageFlags.Ephemeral
  });
}

/**
 * Main component interaction router for embeds
 */
export async function handleEmbedComponent(interaction) {
  const customId = interaction.customId;

  // Root Select Menu
  if (customId === 'embed_root_select') {
    const selected = interaction.values?.[0];
    if (selected === 'create') {
      const modal = new ModalBuilder()
        .setCustomId('embed_modal_create')
        .setTitle('Create Embed');

      const titleInput = new TextInputBuilder()
        .setCustomId('embed_title')
        .setLabel('Title')
        .setPlaceholder('Title at the top...')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(256)
        .setRequired(false);

      const contentInput = new TextInputBuilder()
        .setCustomId('embed_content')
        .setLabel('Content')
        .setPlaceholder('Main text in the middle...')
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(4000)
        .setRequired(false);

      modal.addComponents(
        new ActionRowBuilder().addComponents(titleInput),
        new ActionRowBuilder().addComponents(contentInput)
      );

      return interaction.showModal(modal);
    }

    const embedId = parseInt(selected, 10);
    if (isNaN(embedId)) return renderRootEmbedMenu(interaction);
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => {});
    }
    return renderEmbedManagePage(interaction, embedId);
  }

  // Back to Root
  if (customId === 'embed_back_root') {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => {});
    }
    return renderRootEmbedMenu(interaction);
  }

  // Back to Manage Page
  if (customId.startsWith('embed_manage_')) {
    const embedId = parseInt(customId.replace('embed_manage_', ''), 10);
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => {});
    }
    return renderEmbedManagePage(interaction, embedId);
  }

  // Button: Edit Text -> Show Text Modal
  if (customId.startsWith('embed_edit_text_')) {
    const embedId = parseInt(customId.replace('embed_edit_text_', ''), 10);
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM server_embeds WHERE id = $1 AND guild_id = $2`,
      [embedId, interaction.guildId]
    );

    if (result.rows.length === 0) return renderRootEmbedMenu(interaction);
    const emb = result.rows[0];

    const modal = new ModalBuilder()
      .setCustomId(`embed_modal_text_${embedId}_${Date.now()}`)
      .setTitle('Edit Text');

    const authorInput = new TextInputBuilder()
      .setCustomId('embed_author_name')
      .setLabel('Author Name')
      .setPlaceholder('Text on the top-left...')
      .setStyle(TextInputStyle.Short)
      .setMaxLength(256)
      .setRequired(false);
    if (emb.author_name != null && String(emb.author_name).trim().length > 0) {
      authorInput.setValue(String(emb.author_name).trim());
    }

    const titleInput = new TextInputBuilder()
      .setCustomId('embed_title')
      .setLabel('Title')
      .setPlaceholder('Title at the top...')
      .setStyle(TextInputStyle.Short)
      .setMaxLength(256)
      .setRequired(false);
    if (emb.title != null && String(emb.title).trim().length > 0) {
      titleInput.setValue(String(emb.title).trim());
    }

    const contentInput = new TextInputBuilder()
      .setCustomId('embed_content')
      .setLabel('Content')
      .setPlaceholder('Main text in the middle...')
      .setStyle(TextInputStyle.Paragraph)
      .setMaxLength(4000)
      .setRequired(false);
    if (emb.content != null && String(emb.content).trim().length > 0) {
      contentInput.setValue(String(emb.content).trim());
    }

    const footerInput = new TextInputBuilder()
      .setCustomId('embed_footer_text')
      .setLabel('Footer Text')
      .setPlaceholder('Text on the bottom-left...')
      .setStyle(TextInputStyle.Short)
      .setMaxLength(2048)
      .setRequired(false);
    if (emb.footer_text != null && String(emb.footer_text).trim().length > 0) {
      footerInput.setValue(String(emb.footer_text).trim());
    }

    const colorInput = new TextInputBuilder()
      .setCustomId('embed_color')
      .setLabel('Hex Code')
      .setPlaceholder('Left border color...')
      .setStyle(TextInputStyle.Short)
      .setMaxLength(7)
      .setRequired(false);
    if (emb.color != null && String(emb.color).trim().length > 0) {
      colorInput.setValue(String(emb.color).trim());
    }

    modal.addComponents(
      new ActionRowBuilder().addComponents(authorInput),
      new ActionRowBuilder().addComponents(titleInput),
      new ActionRowBuilder().addComponents(contentInput),
      new ActionRowBuilder().addComponents(footerInput),
      new ActionRowBuilder().addComponents(colorInput)
    );

    return interaction.showModal(modal);
  }

  // Button: Edit Images -> Show Images Modal
  if (customId.startsWith('embed_edit_images_')) {
    const embedId = parseInt(customId.replace('embed_edit_images_', ''), 10);
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM server_embeds WHERE id = $1 AND guild_id = $2`,
      [embedId, interaction.guildId]
    );

    if (result.rows.length === 0) return renderRootEmbedMenu(interaction);
    const emb = result.rows[0];

    const modal = new ModalBuilder()
      .setCustomId(`embed_modal_images_${embedId}_${Date.now()}`)
      .setTitle('Edit Images');

    // 1. Author Icon
    const authorIconInput = new TextInputBuilder()
      .setCustomId('embed_author_icon_url')
      .setLabel('Author Icon')
      .setPlaceholder('Icon on the top-left...')
      .setStyle(TextInputStyle.Short)
      .setRequired(false);
    if (emb.author_icon_url != null && String(emb.author_icon_url).trim().length > 0) {
      authorIconInput.setValue(String(emb.author_icon_url).trim());
    }

    // 2. Thumbnail
    const thumbInput = new TextInputBuilder()
      .setCustomId('embed_thumbnail_url')
      .setLabel('Thumbnail')
      .setPlaceholder('Image on the top-right...')
      .setStyle(TextInputStyle.Short)
      .setRequired(false);
    if (emb.thumbnail_url != null && String(emb.thumbnail_url).trim().length > 0) {
      thumbInput.setValue(String(emb.thumbnail_url).trim());
    }

    // 3. Banner
    const imageInput = new TextInputBuilder()
      .setCustomId('embed_image_url')
      .setLabel('Banner')
      .setPlaceholder('Big image under the text...')
      .setStyle(TextInputStyle.Short)
      .setRequired(false);
    if (emb.image_url != null && String(emb.image_url).trim().length > 0) {
      imageInput.setValue(String(emb.image_url).trim());
    }

    // 4. Footer Icon
    const footerIconInput = new TextInputBuilder()
      .setCustomId('embed_footer_icon_url')
      .setLabel('Footer Icon')
      .setPlaceholder('Icon on the bottom-left...')
      .setStyle(TextInputStyle.Short)
      .setRequired(false);
    if (emb.footer_icon_url != null && String(emb.footer_icon_url).trim().length > 0) {
      footerIconInput.setValue(String(emb.footer_icon_url).trim());
    }

    modal.addComponents(
      new ActionRowBuilder().addComponents(authorIconInput),
      new ActionRowBuilder().addComponents(thumbInput),
      new ActionRowBuilder().addComponents(imageInput),
      new ActionRowBuilder().addComponents(footerIconInput)
    );

    return interaction.showModal(modal);
  }

  // Send Button -> Channel Select View
  if (customId.startsWith('embed_send_')) {
    const embedId = parseInt(customId.replace('embed_send_', ''), 10);
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => {});
    }
    return renderEmbedSendPage(interaction, embedId);
  }

  // Update Button -> URL Modal (blank input for any channel link)
  if (customId.startsWith('embed_update_')) {
    const embedId = parseInt(customId.replace('embed_update_', ''), 10);

    const modal = new ModalBuilder()
      .setCustomId(`embed_modal_update_${embedId}_${Date.now()}`)
      .setTitle('Update Message');

    const urlInput = new TextInputBuilder()
      .setCustomId('embed_msg_url')
      .setLabel('Message URL')
      .setPlaceholder('Paste message link here...')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(urlInput));
    return interaction.showModal(modal);
  }

  // Channel Select Menu for Send
  if (customId.startsWith('embed_channel_select_')) {
    const embedId = parseInt(customId.replace('embed_channel_select_', ''), 10);
    return handleEmbedChannelSend(interaction, embedId);
  }

  // --- EMBED GROUPS COMPONENT ROUTING ---

  // Group Root Select Menu
  if (customId === 'embed_group_root_select') {
    const selected = interaction.values?.[0];
    if (selected === 'create_group') {
      const modal = new ModalBuilder()
        .setCustomId(`embed_modal_group_create_${Date.now()}`)
        .setTitle('Create Embed Group');

      const titleInput = new TextInputBuilder()
        .setCustomId('embed_title')
        .setLabel('Title')
        .setPlaceholder('Title at the top...')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(256)
        .setRequired(false);

      const contentInput = new TextInputBuilder()
        .setCustomId('embed_content')
        .setLabel('Content')
        .setPlaceholder('Main text in the middle...')
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(4000)
        .setRequired(false);

      modal.addComponents(
        new ActionRowBuilder().addComponents(titleInput),
        new ActionRowBuilder().addComponents(contentInput)
      );

      return interaction.showModal(modal);
    }

    const groupId = parseInt(selected, 10);
    if (isNaN(groupId)) return renderRootEmbedMenu(interaction);
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => {});
    }
    return renderGroupManagePage(interaction, groupId);
  }

  // Back to Group Manage Page
  if (customId.startsWith('embed_group_manage_')) {
    const groupId = parseInt(customId.replace('embed_group_manage_', ''), 10);
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => {});
    }
    return renderGroupManagePage(interaction, groupId);
  }

  // Group: Edit Text -> Show Modal
  if (customId.startsWith('embed_group_edit_text_')) {
    const groupId = parseInt(customId.replace('embed_group_edit_text_', ''), 10);
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM server_embed_groups WHERE id = $1 AND guild_id = $2`,
      [groupId, interaction.guildId]
    );

    if (result.rows.length === 0) return renderRootEmbedMenu(interaction);
    const grp = result.rows[0];

    const modal = new ModalBuilder()
      .setCustomId(`embed_modal_group_text_${groupId}_${Date.now()}`)
      .setTitle('Edit Group Text');

    const authorInput = new TextInputBuilder()
      .setCustomId('embed_author_name')
      .setLabel('Author Name')
      .setPlaceholder('Text on the top-left...')
      .setStyle(TextInputStyle.Short)
      .setMaxLength(256)
      .setRequired(false);
    if (grp.author_name != null && String(grp.author_name).trim().length > 0) {
      authorInput.setValue(String(grp.author_name).trim());
    }

    const titleInput = new TextInputBuilder()
      .setCustomId('embed_title')
      .setLabel('Title')
      .setPlaceholder('Title at the top...')
      .setStyle(TextInputStyle.Short)
      .setMaxLength(256)
      .setRequired(false);
    if (grp.title != null && String(grp.title).trim().length > 0) {
      titleInput.setValue(String(grp.title).trim());
    }

    const contentInput = new TextInputBuilder()
      .setCustomId('embed_content')
      .setLabel('Content')
      .setPlaceholder('Main text in the middle...')
      .setStyle(TextInputStyle.Paragraph)
      .setMaxLength(4000)
      .setRequired(false);
    if (grp.content != null && String(grp.content).trim().length > 0) {
      contentInput.setValue(String(grp.content).trim());
    }

    const footerInput = new TextInputBuilder()
      .setCustomId('embed_footer_text')
      .setLabel('Footer Text')
      .setPlaceholder('Text on the bottom-left...')
      .setStyle(TextInputStyle.Short)
      .setMaxLength(2048)
      .setRequired(false);
    if (grp.footer_text != null && String(grp.footer_text).trim().length > 0) {
      footerInput.setValue(String(grp.footer_text).trim());
    }

    const colorInput = new TextInputBuilder()
      .setCustomId('embed_color')
      .setLabel('Hex Code')
      .setPlaceholder('Left border color...')
      .setStyle(TextInputStyle.Short)
      .setMaxLength(7)
      .setRequired(false);
    if (grp.color != null && String(grp.color).trim().length > 0) {
      colorInput.setValue(String(grp.color).trim());
    }

    modal.addComponents(
      new ActionRowBuilder().addComponents(authorInput),
      new ActionRowBuilder().addComponents(titleInput),
      new ActionRowBuilder().addComponents(contentInput),
      new ActionRowBuilder().addComponents(footerInput),
      new ActionRowBuilder().addComponents(colorInput)
    );

    return interaction.showModal(modal);
  }

  // Group: Edit Images -> Show Modal
  if (customId.startsWith('embed_group_edit_images_')) {
    const groupId = parseInt(customId.replace('embed_group_edit_images_', ''), 10);
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM server_embed_groups WHERE id = $1 AND guild_id = $2`,
      [groupId, interaction.guildId]
    );

    if (result.rows.length === 0) return renderRootEmbedMenu(interaction);
    const grp = result.rows[0];

    const modal = new ModalBuilder()
      .setCustomId(`embed_modal_group_images_${groupId}_${Date.now()}`)
      .setTitle('Edit Group Images');

    // 1. Author Icon
    const authorIconInput = new TextInputBuilder()
      .setCustomId('embed_author_icon_url')
      .setLabel('Author Icon')
      .setPlaceholder('Icon on the top-left...')
      .setStyle(TextInputStyle.Short)
      .setRequired(false);
    if (grp.author_icon_url != null && String(grp.author_icon_url).trim().length > 0) {
      authorIconInput.setValue(String(grp.author_icon_url).trim());
    }

    // 2. Thumbnail
    const thumbInput = new TextInputBuilder()
      .setCustomId('embed_thumbnail_url')
      .setLabel('Thumbnail')
      .setPlaceholder('Image on the top-right...')
      .setStyle(TextInputStyle.Short)
      .setRequired(false);
    if (grp.thumbnail_url != null && String(grp.thumbnail_url).trim().length > 0) {
      thumbInput.setValue(String(grp.thumbnail_url).trim());
    }

    // 3. Banner
    const imageInput = new TextInputBuilder()
      .setCustomId('embed_image_url')
      .setLabel('Banner')
      .setPlaceholder('Big image under the text...')
      .setStyle(TextInputStyle.Short)
      .setRequired(false);
    if (grp.image_url != null && String(grp.image_url).trim().length > 0) {
      imageInput.setValue(String(grp.image_url).trim());
    }

    // 4. Footer Icon
    const footerIconInput = new TextInputBuilder()
      .setCustomId('embed_footer_icon_url')
      .setLabel('Footer Icon')
      .setPlaceholder('Icon on the bottom-left...')
      .setStyle(TextInputStyle.Short)
      .setRequired(false);
    if (grp.footer_icon_url != null && String(grp.footer_icon_url).trim().length > 0) {
      footerIconInput.setValue(String(grp.footer_icon_url).trim());
    }

    modal.addComponents(
      new ActionRowBuilder().addComponents(authorIconInput),
      new ActionRowBuilder().addComponents(thumbInput),
      new ActionRowBuilder().addComponents(imageInput),
      new ActionRowBuilder().addComponents(footerIconInput)
    );

    return interaction.showModal(modal);
  }

  // Group: Manage Attached Embeds Button
  if (customId.startsWith('embed_group_attach_')) {
    const groupId = parseInt(customId.replace('embed_group_attach_', ''), 10);
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => {});
    }
    return renderGroupAttachedEmbedsPage(interaction, groupId);
  }

  // Group: Save Attached Embeds Selection (Multi-select)
  if (customId.startsWith('embed_group_save_attach_')) {
    await interaction.deferUpdate().catch(() => {});
    const groupId = parseInt(customId.replace('embed_group_save_attach_', ''), 10);
    const selectedIds = (interaction.values || []).map(v => parseInt(v, 10)).filter(v => !isNaN(v));
    const pool = getPool();

    try {
      await pool.query('BEGIN');
      await pool.query(
        `DELETE FROM server_embed_group_items WHERE group_id = $1`,
        [groupId]
      );
      for (let i = 0; i < selectedIds.length; i++) {
        await pool.query(
          `INSERT INTO server_embed_group_items (group_id, embed_id, display_order)
           VALUES ($1, $2, $3)
           ON CONFLICT (group_id, embed_id) DO UPDATE SET display_order = $3`,
          [groupId, selectedIds[i], i]
        );
      }
      await pool.query('COMMIT');

      sysLog('Embed Group Attachments Updated', {
        guild: interaction.guildId,
        user: interaction.user.id,
        detail: `Group ID: ${groupId} | Attached Count: ${selectedIds.length}`
      });
    } catch (err) {
      await pool.query('ROLLBACK').catch(() => {});
      sysError('Failed to update group attached embeds', err, { guild: interaction.guildId, id: groupId });
      const errorEmbed = createErrorEmbed(
        'Database Error',
        'Failed to save attached embeds to the database. Please try again.'
      );
      await interaction.followUp({
        embeds: [errorEmbed],
        flags: MessageFlags.Ephemeral
      });
    }

    return renderGroupManagePage(interaction, groupId);
  }

  // Group: Send Button -> Channel Select View
  if (customId.startsWith('embed_group_send_')) {
    const groupId = parseInt(customId.replace('embed_group_send_', ''), 10);
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => {});
    }
    return renderGroupSendPage(interaction, groupId);
  }

  // Group: Channel Select Menu for Send
  if (customId.startsWith('embed_group_channel_select_')) {
    const groupId = parseInt(customId.replace('embed_group_channel_select_', ''), 10);
    return handleGroupChannelSend(interaction, groupId);
  }

  // Group: Update Button -> URL Modal
  if (customId.startsWith('embed_group_update_')) {
    const groupId = parseInt(customId.replace('embed_group_update_', ''), 10);

    const modal = new ModalBuilder()
      .setCustomId(`embed_modal_group_update_${groupId}_${Date.now()}`)
      .setTitle('Update Group Message');

    const urlInput = new TextInputBuilder()
      .setCustomId('embed_group_msg_url')
      .setLabel('Message URL')
      .setPlaceholder('Paste message link here...')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(urlInput));
    return interaction.showModal(modal);
  }

  // Group: Public Dropdown Interaction (Ephemeral delivery)
  if (customId === 'embed_public_group_select') {
    return handlePublicGroupSelect(interaction);
  }
}

/**
 * Handle Channel Selection for sending an embed
 */
async function handleEmbedChannelSend(interaction, embedId) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferUpdate().catch(() => {});
  }

  const channelId = interaction.values?.[0];
  const guild = interaction.guild;
  const targetChannel = guild?.channels.cache.get(channelId) || await guild?.channels.fetch(channelId).catch(() => null);

  if (!targetChannel) {
    const errorEmbed = createErrorEmbed(
      'Channel Unavailable',
      'The selected channel could not be found or the bot lacks access to view it.'
    );
    await interaction.followUp({
      embeds: [errorEmbed],
      flags: MessageFlags.Ephemeral
    });
    return renderEmbedManagePage(interaction, embedId);
  }

  const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
  const diag = diagnoseChannelPermissions(targetChannel, botMember, [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks
  ]);

  if (!diag.hasAll) {
    const errorEmbed = createErrorEmbed(
      'Missing Permissions',
      `${diag.explanation}\n\n${diag.fixInstructions}`
    );
    await interaction.followUp({
      embeds: [errorEmbed],
      flags: MessageFlags.Ephemeral
    });
    return renderEmbedManagePage(interaction, embedId);
  }

  const pool = getPool();
  const result = await pool.query(
    `SELECT * FROM server_embeds WHERE id = $1 AND guild_id = $2`,
    [embedId, interaction.guildId]
  );

  if (result.rows.length === 0) return renderRootEmbedMenu(interaction);
  const emb = result.rows[0];

  const postEmbed = buildDiscordEmbed(emb);

  let sentMessage;
  try {
    sentMessage = await targetChannel.send({ embeds: [postEmbed] });
  } catch (sendErr) {
    sysError('Embed Send Error', sendErr, { guild: interaction.guildId, channel: channelId });
    await handleInteractionError(interaction, sendErr, 'Send Custom Embed', { targetChannel });
    return renderEmbedManagePage(interaction, embedId);
  }

  // Update tracked message in database
  await pool.query(
    `UPDATE server_embeds
     SET tracked_message_id = $1, tracked_channel_id = $2, updated_at = NOW()
     WHERE id = $3 AND guild_id = $4`,
    [sentMessage.id, channelId, embedId, interaction.guildId]
  ).catch(err => sysError('Failed to update tracked embed message', err));

  // Record in multi-channel post ledger
  await pool.query(
    `INSERT INTO server_embed_posts (message_id, guild_id, embed_id, channel_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (message_id) DO NOTHING`,
    [sentMessage.id, interaction.guildId, embedId, channelId]
  ).catch(err => sysError('Failed to record server_embed_posts', err));

  sysLog('Custom Embed Sent', {
    guild: interaction.guildId,
    user: interaction.user.id,
    detail: `Embed #${embedId} sent to #${targetChannel.name} (MsgID: ${sentMessage.id})`
  });

  await interaction.followUp({
    content: `✅ Embed successfully sent to <#${channelId}>.`,
    flags: MessageFlags.Ephemeral
  });

  return renderEmbedManagePage(interaction, embedId);
}

/**
 * Handle Modal Submissions for embeds (create, edit text, edit images, update)
 */
export async function handleEmbedModal(interaction) {
  const customId = interaction.customId;
  const pool = getPool();
  const guildId = interaction.guildId;

  // 1. Create Modal
  if (customId === 'embed_modal_create') {
    await interaction.deferUpdate().catch(() => {});

    const title = interaction.fields.getTextInputValue('embed_title')?.trim() || null;
    const content = interaction.fields.getTextInputValue('embed_content')?.trim() || null;

    try {
      const insertResult = await pool.query(
        `INSERT INTO server_embeds (guild_id, title, content)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [guildId, title, content]
      );

      const newId = insertResult.rows[0].id;
      sysLog('Custom Embed Created', {
        guild: guildId,
        user: interaction.user.id,
        detail: `ID: ${newId} | Title: ${title || 'Untitled'}`
      });

      return renderEmbedManagePage(interaction, newId);
    } catch (err) {
      sysError('Failed to create custom embed', err, { guild: guildId });
      const errorEmbed = createErrorEmbed(
        'Database Error',
        'Failed to save custom embed to database. Please try again.'
      );
      await interaction.followUp({
        embeds: [errorEmbed],
        flags: MessageFlags.Ephemeral
      });
      return renderRootEmbedMenu(interaction);
    }
  }

  // 2. Edit Text Modal
  if (customId.startsWith('embed_modal_text_')) {
    await interaction.deferUpdate().catch(() => {});

    const parts = customId.split('_');
    const embedId = parseInt(parts[3], 10);
    const pool = getPool();

    const curRes = await pool.query(
      `SELECT * FROM server_embeds WHERE id = $1 AND guild_id = $2`,
      [embedId, guildId]
    ).catch(() => ({ rows: [] }));

    if (curRes.rows.length === 0) return renderRootEmbedMenu(interaction);
    const current = curRes.rows[0];

    // Read all fields submitted
    const rawAuthorName = interaction.fields.getTextInputValue('embed_author_name')?.trim();
    const rawTitle = interaction.fields.getTextInputValue('embed_title')?.trim();
    const rawContent = interaction.fields.getTextInputValue('embed_content')?.trim();
    const rawFooterText = interaction.fields.getTextInputValue('embed_footer_text')?.trim();
    const rawColor = interaction.fields.getTextInputValue('embed_color')?.trim();

    const skippedFields = [];

    // Author Name: max 256
    const authorName = rawAuthorName && rawAuthorName.length > 0 ? rawAuthorName.slice(0, 256) : null;

    // Title: max 256
    const title = rawTitle && rawTitle.length > 0 ? rawTitle.slice(0, 256) : null;

    // Content: optional, max 4000
    const content = rawContent && rawContent.length > 0 ? rawContent.slice(0, 4000) : null;

    // Footer Text: max 2048
    const footerText = rawFooterText && rawFooterText.length > 0 ? rawFooterText.slice(0, 2048) : null;

    // Hex Code
    let color = null;
    if (rawColor && rawColor.length > 0) {
      const validated = validateHexColor(rawColor);
      if (validated === false) {
        // Invalid hex code: skip and preserve current color
        color = current.color;
        skippedFields.push('Hex Code (invalid format)');
      } else {
        color = validated;
      }
    } else {
      // User explicitly cleared hex code
      color = null;
    }

    try {
      await pool.query(
        `UPDATE server_embeds
         SET author_name = $1, title = $2, content = $3, footer_text = $4, color = $5, updated_at = NOW()
         WHERE id = $6 AND guild_id = $7`,
        [authorName, title, content, footerText, color, embedId, guildId]
      );

      sysLog('Custom Embed Text Edited', {
        guild: guildId,
        user: interaction.user.id,
        detail: `ID: ${embedId} | Title: ${title || 'Untitled'}`
      });

      if (skippedFields.length > 0) {
        await interaction.followUp({
          content: `⚠️ Skipped invalid input: ${skippedFields.join(', ')}. All other changes were saved.`,
          flags: MessageFlags.Ephemeral
        }).catch(() => {});
      }

      return renderEmbedManagePage(interaction, embedId);
    } catch (err) {
      sysError('Failed to update custom embed text', err, { guild: guildId, id: embedId });
      const errorEmbed = createErrorEmbed(
        'Database Error',
        'Failed to update embed text in database. Please try again.'
      );
      await interaction.followUp({
        embeds: [errorEmbed],
        flags: MessageFlags.Ephemeral
      });
      return renderEmbedManagePage(interaction, embedId);
    }
  }

  // 3. Edit Images Modal
  if (customId.startsWith('embed_modal_images_')) {
    await interaction.deferUpdate().catch(() => {});

    const parts = customId.split('_');
    const embedId = parseInt(parts[3], 10);
    const pool = getPool();

    const curRes = await pool.query(
      `SELECT * FROM server_embeds WHERE id = $1 AND guild_id = $2`,
      [embedId, guildId]
    ).catch(() => ({ rows: [] }));

    if (curRes.rows.length === 0) return renderRootEmbedMenu(interaction);
    const current = curRes.rows[0];

    const rawAuthorIcon = interaction.fields.getTextInputValue('embed_author_icon_url')?.trim();
    const rawThumb = interaction.fields.getTextInputValue('embed_thumbnail_url')?.trim();
    const rawBanner = interaction.fields.getTextInputValue('embed_image_url')?.trim();
    const rawFooterIcon = interaction.fields.getTextInputValue('embed_footer_icon_url')?.trim();

    const skippedFields = [];

    // 1. Author Icon
    let authorIconUrl = null;
    if (rawAuthorIcon && rawAuthorIcon.length > 0) {
      if (isValidImageUrl(rawAuthorIcon)) {
        authorIconUrl = rawAuthorIcon;
      } else {
        authorIconUrl = current.author_icon_url;
        skippedFields.push('Author Icon (not a valid image URL)');
      }
    } else {
      authorIconUrl = null;
    }

    // 2. Thumbnail
    let thumbnailUrl = null;
    if (rawThumb && rawThumb.length > 0) {
      if (isValidImageUrl(rawThumb)) {
        thumbnailUrl = rawThumb;
      } else {
        thumbnailUrl = current.thumbnail_url;
        skippedFields.push('Thumbnail (not a valid image URL)');
      }
    } else {
      thumbnailUrl = null;
    }

    // 3. Banner
    let imageUrl = null;
    if (rawBanner && rawBanner.length > 0) {
      if (isValidImageUrl(rawBanner)) {
        imageUrl = rawBanner;
      } else {
        imageUrl = current.image_url;
        skippedFields.push('Banner (not a valid image URL)');
      }
    } else {
      imageUrl = null;
    }

    // 4. Footer Icon
    let footerIconUrl = null;
    if (rawFooterIcon && rawFooterIcon.length > 0) {
      if (isValidImageUrl(rawFooterIcon)) {
        footerIconUrl = rawFooterIcon;
      } else {
        footerIconUrl = current.footer_icon_url;
        skippedFields.push('Footer Icon (not a valid image URL)');
      }
    } else {
      footerIconUrl = null;
    }

    try {
      await pool.query(
        `UPDATE server_embeds
         SET thumbnail_url = $1, image_url = $2, author_icon_url = $3, footer_icon_url = $4, updated_at = NOW()
         WHERE id = $5 AND guild_id = $6`,
        [thumbnailUrl, imageUrl, authorIconUrl, footerIconUrl, embedId, guildId]
      );

      sysLog('Custom Embed Images Edited', {
        guild: guildId,
        user: interaction.user.id,
        detail: `ID: ${embedId} images updated`
      });

      if (skippedFields.length > 0) {
        await interaction.followUp({
          content: `⚠️ Skipped invalid input: ${skippedFields.join(', ')}. All other changes were saved.`,
          flags: MessageFlags.Ephemeral
        }).catch(() => {});
      }

      return renderEmbedManagePage(interaction, embedId);
    } catch (err) {
      sysError('Failed to update custom embed images', err, { guild: guildId, id: embedId });
      const errorEmbed = createErrorEmbed(
        'Database Error',
        'Failed to update embed images in database. Please try again.'
      );
      await interaction.followUp({
        embeds: [errorEmbed],
        flags: MessageFlags.Ephemeral
      });
      return renderEmbedManagePage(interaction, embedId);
    }
  }

  // 4. Update Modal (live edit by message URL with safety guardrails)
  if (customId.startsWith('embed_modal_update_')) {
    await interaction.deferUpdate().catch(() => {});

    const parts = customId.split('_');
    const embedId = parseInt(parts[3], 10);
    const rawUrl = interaction.fields.getTextInputValue('embed_msg_url')?.trim() || '';

    const urlMatch = rawUrl.match(/discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)/);
    if (!urlMatch) {
      const errorEmbed = createErrorEmbed(
        'Invalid Message Link',
        'Please copy and paste the full Discord message link (Right click message > Copy Message Link).'
      );
      await interaction.followUp({
        embeds: [errorEmbed],
        flags: MessageFlags.Ephemeral
      });
      return renderEmbedManagePage(interaction, embedId);
    }

    const [, urlGuildId, urlChannelId, urlMessageId] = urlMatch;

    // Cross-server isolation check
    if (urlGuildId !== guildId) {
      const errorEmbed = createErrorEmbed(
        'Cross-Server Access Prohibited',
        'You can only update messages within this server. Message links from external servers cannot be modified.'
      );
      await interaction.followUp({
        embeds: [errorEmbed],
        flags: MessageFlags.Ephemeral
      });
      return renderEmbedManagePage(interaction, embedId);
    }

    const channel = interaction.guild.channels.cache.get(urlChannelId)
      || await interaction.guild.channels.fetch(urlChannelId).catch(() => null);

    if (!channel || channel.guildId !== guildId) {
      const errorEmbed = createErrorEmbed(
        'Channel Unavailable',
        'Channel not found in this server or the bot does not have access to view it.'
      );
      await interaction.followUp({
        embeds: [errorEmbed],
        flags: MessageFlags.Ephemeral
      });
      return renderEmbedManagePage(interaction, embedId);
    }

    const targetMsg = await channel.messages.fetch(urlMessageId).catch(() => null);
    if (!targetMsg) {
      const errorEmbed = createErrorEmbed(
        'Message Not Found',
        'Could not fetch the target message. Ensure the message ID exists and the bot can read message history in that channel.'
      );
      await interaction.followUp({
        embeds: [errorEmbed],
        flags: MessageFlags.Ephemeral
      });
      return renderEmbedManagePage(interaction, embedId);
    }

    // Guardrail 1: Must be sent by this bot
    if (targetMsg.author.id !== interaction.client.user.id) {
      const errorEmbed = createErrorEmbed(
        'Author Mismatch',
        'The bot can only edit messages that were authored by this bot.'
      );
      await interaction.followUp({
        embeds: [errorEmbed],
        flags: MessageFlags.Ephemeral
      });
      return renderEmbedManagePage(interaction, embedId);
    }

    // Guardrail 2: Must be an embed message
    if (!targetMsg.embeds || targetMsg.embeds.length === 0) {
      const errorEmbed = createErrorEmbed(
        'Invalid Message Format',
        'That message is not an embed message and cannot be edited by the Custom Embed Manager.'
      );
      await interaction.followUp({
        embeds: [errorEmbed],
        flags: MessageFlags.Ephemeral
      });
      return renderEmbedManagePage(interaction, embedId);
    }

    // Guardrail 3: Must NOT have interactive components (protects Shop, Hub, Drops, Trade menus)
    if (targetMsg.components && targetMsg.components.length > 0) {
      const errorEmbed = createErrorEmbed(
        'Protected System Message',
        'That message is an interactive bot control panel or feature and cannot be modified.'
      );
      await interaction.followUp({
        embeds: [errorEmbed],
        flags: MessageFlags.Ephemeral
      });
      return renderEmbedManagePage(interaction, embedId);
    }

    // Guardrail 4: Protect Leaderboard messages
    const lbCheck = await pool.query(
      `SELECT 1 FROM leaderboard_config 
       WHERE guild_id = $1 
         AND ($2 IN (daily_message_id, coins_message_id, streak_message_id, level_message_id))`,
      [guildId, urlMessageId]
    ).catch(() => ({ rows: [] }));

    if (lbCheck.rows.length > 0) {
      const errorEmbed = createErrorEmbed(
        'Protected System Message',
        'That message is an active Leaderboard message and cannot be modified.'
      );
      await interaction.followUp({
        embeds: [errorEmbed],
        flags: MessageFlags.Ephemeral
      });
      return renderEmbedManagePage(interaction, embedId);
    }

    // Guardrail 5: Protect Community Server Hub message
    const hubCheck = await pool.query(
      `SELECT 1 FROM guild_configs WHERE guild_id = $1 AND config->>'interface_message_id' = $2`,
      [guildId, urlMessageId]
    ).catch(() => ({ rows: [] }));

    if (hubCheck.rows.length > 0) {
      const errorEmbed = createErrorEmbed(
        'Protected System Message',
        'That message is the Server Hub message and cannot be modified.'
      );
      await interaction.followUp({
        embeds: [errorEmbed],
        flags: MessageFlags.Ephemeral
      });
      return renderEmbedManagePage(interaction, embedId);
    }

    const embRes = await pool.query(
      `SELECT * FROM server_embeds WHERE id = $1 AND guild_id = $2`,
      [embedId, guildId]
    );

    if (embRes.rows.length === 0) return renderRootEmbedMenu(interaction);
    const emb = embRes.rows[0];

    const updatedEmbed = buildDiscordEmbed(emb);

    try {
      await targetMsg.edit({ embeds: [updatedEmbed] });
    } catch (editErr) {
      sysError('Live Embed Edit Failed', editErr, { guild: guildId, messageId: urlMessageId });
      await handleInteractionError(interaction, editErr, 'Live Embed Edit', { targetChannel: channel });
      return renderEmbedManagePage(interaction, embedId);
    }

    // Record or update post ledger for multi-channel tracking
    await pool.query(
      `INSERT INTO server_embed_posts (message_id, guild_id, embed_id, channel_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (message_id)
       DO UPDATE SET embed_id = $3, channel_id = $4`,
      [urlMessageId, guildId, embedId, urlChannelId]
    ).catch(() => {});

    // Also update last-tracked fields on server_embeds
    await pool.query(
      `UPDATE server_embeds
       SET tracked_channel_id = $1, tracked_message_id = $2, updated_at = NOW()
       WHERE id = $3 AND guild_id = $4`,
      [urlChannelId, urlMessageId, embedId, guildId]
    ).catch(() => {});

    sysLog('Custom Embed Live Edited', {
      guild: guildId,
      user: interaction.user.id,
      detail: `ID: ${embedId} live updated in #${channel.name} (MsgID: ${urlMessageId})`
    });

    await interaction.followUp({
      content: '✅ Message updated live successfully.',
      flags: MessageFlags.Ephemeral
    });

    return renderEmbedManagePage(interaction, embedId);
  }

  // 5. Create Group Modal
  if (customId.startsWith('embed_modal_group_create')) {
    await interaction.deferUpdate().catch(() => {});

    const title = interaction.fields.getTextInputValue('embed_title')?.trim() || null;
    const content = interaction.fields.getTextInputValue('embed_content')?.trim() || null;
    const name = title || 'Untitled Group';

    try {
      const insertResult = await pool.query(
        `INSERT INTO server_embed_groups (guild_id, name, title, content)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [guildId, name, title, content]
      );

      const newId = insertResult.rows[0].id;
      sysLog('Embed Group Created', {
        guild: guildId,
        user: interaction.user.id,
        detail: `ID: ${newId} | Title: ${title || 'Untitled Group'}`
      });

      return renderGroupManagePage(interaction, newId);
    } catch (err) {
      sysError('Failed to create embed group', err, { guild: guildId });
      const errorEmbed = createErrorEmbed(
        'Database Error',
        'Failed to save embed group to database. Please try again.'
      );
      await interaction.followUp({
        embeds: [errorEmbed],
        flags: MessageFlags.Ephemeral
      });
      return renderRootEmbedMenu(interaction);
    }
  }

  // 6. Edit Group Text Modal
  if (customId.startsWith('embed_modal_group_text_')) {
    await interaction.deferUpdate().catch(() => {});

    const parts = customId.split('_');
    const groupId = parseInt(parts[4], 10);

    const curRes = await pool.query(
      `SELECT * FROM server_embed_groups WHERE id = $1 AND guild_id = $2`,
      [groupId, guildId]
    ).catch(() => ({ rows: [] }));

    if (curRes.rows.length === 0) return renderRootEmbedMenu(interaction);
    const current = curRes.rows[0];

    const rawAuthorName = interaction.fields.getTextInputValue('embed_author_name')?.trim();
    const rawTitle = interaction.fields.getTextInputValue('embed_title')?.trim();
    const rawContent = interaction.fields.getTextInputValue('embed_content')?.trim();
    const rawFooterText = interaction.fields.getTextInputValue('embed_footer_text')?.trim();
    const rawColor = interaction.fields.getTextInputValue('embed_color')?.trim();

    const skippedFields = [];

    const authorName = rawAuthorName && rawAuthorName.length > 0 ? rawAuthorName.slice(0, 256) : null;
    const title = rawTitle && rawTitle.length > 0 ? rawTitle.slice(0, 256) : null;
    const name = title || current.name || 'Untitled Group';

    const content = rawContent && rawContent.length > 0 ? rawContent.slice(0, 4000) : null;

    const footerText = rawFooterText && rawFooterText.length > 0 ? rawFooterText.slice(0, 2048) : null;

    let color = null;
    if (rawColor && rawColor.length > 0) {
      const validated = validateHexColor(rawColor);
      if (validated === false) {
        color = current.color;
        skippedFields.push('Hex Code (invalid format)');
      } else {
        color = validated;
      }
    } else {
      color = null;
    }

    try {
      await pool.query(
        `UPDATE server_embed_groups
         SET name = $1, title = $2, author_name = $3, content = $4, footer_text = $5, color = $6, updated_at = NOW()
         WHERE id = $7 AND guild_id = $8`,
        [name, title, authorName, content, footerText, color, groupId, guildId]
      );

      sysLog('Embed Group Text Edited', {
        guild: guildId,
        user: interaction.user.id,
        detail: `ID: ${groupId} | Title: ${title || name}`
      });

      if (skippedFields.length > 0) {
        await interaction.followUp({
          content: `⚠️ Skipped invalid input: ${skippedFields.join(', ')}. All other changes were saved.`,
          flags: MessageFlags.Ephemeral
        }).catch(() => {});
      }

      return renderGroupManagePage(interaction, groupId);
    } catch (err) {
      sysError('Failed to update embed group text', err, { guild: guildId, id: groupId });
      const errorEmbed = createErrorEmbed(
        'Database Error',
        'Failed to update embed group text in database. Please try again.'
      );
      await interaction.followUp({
        embeds: [errorEmbed],
        flags: MessageFlags.Ephemeral
      });
      return renderGroupManagePage(interaction, groupId);
    }
  }

  // 7. Edit Group Images Modal
  if (customId.startsWith('embed_modal_group_images_')) {
    await interaction.deferUpdate().catch(() => {});

    const parts = customId.split('_');
    const groupId = parseInt(parts[4], 10);

    const curRes = await pool.query(
      `SELECT * FROM server_embed_groups WHERE id = $1 AND guild_id = $2`,
      [groupId, guildId]
    ).catch(() => ({ rows: [] }));

    if (curRes.rows.length === 0) return renderRootEmbedMenu(interaction);
    const current = curRes.rows[0];

    const rawAuthorIcon = interaction.fields.getTextInputValue('embed_author_icon_url')?.trim();
    const rawThumb = interaction.fields.getTextInputValue('embed_thumbnail_url')?.trim();
    const rawBanner = interaction.fields.getTextInputValue('embed_image_url')?.trim();
    const rawFooterIcon = interaction.fields.getTextInputValue('embed_footer_icon_url')?.trim();

    const skippedFields = [];

    // 1. Author Icon
    let authorIconUrl = null;
    if (rawAuthorIcon && rawAuthorIcon.length > 0) {
      if (isValidImageUrl(rawAuthorIcon)) {
        authorIconUrl = rawAuthorIcon;
      } else {
        authorIconUrl = current.author_icon_url;
        skippedFields.push('Author Icon (not a valid image URL)');
      }
    } else {
      authorIconUrl = null;
    }

    // 2. Thumbnail
    let thumbnailUrl = null;
    if (rawThumb && rawThumb.length > 0) {
      if (isValidImageUrl(rawThumb)) {
        thumbnailUrl = rawThumb;
      } else {
        thumbnailUrl = current.thumbnail_url;
        skippedFields.push('Thumbnail (not a valid image URL)');
      }
    } else {
      thumbnailUrl = null;
    }

    // 3. Banner
    let imageUrl = null;
    if (rawBanner && rawBanner.length > 0) {
      if (isValidImageUrl(rawBanner)) {
        imageUrl = rawBanner;
      } else {
        imageUrl = current.image_url;
        skippedFields.push('Banner (not a valid image URL)');
      }
    } else {
      imageUrl = null;
    }

    // 4. Footer Icon
    let footerIconUrl = null;
    if (rawFooterIcon && rawFooterIcon.length > 0) {
      if (isValidImageUrl(rawFooterIcon)) {
        footerIconUrl = rawFooterIcon;
      } else {
        footerIconUrl = current.footer_icon_url;
        skippedFields.push('Footer Icon (not a valid image URL)');
      }
    } else {
      footerIconUrl = null;
    }

    try {
      await pool.query(
        `UPDATE server_embed_groups
         SET thumbnail_url = $1, image_url = $2, author_icon_url = $3, footer_icon_url = $4, updated_at = NOW()
         WHERE id = $5 AND guild_id = $6`,
        [thumbnailUrl, imageUrl, authorIconUrl, footerIconUrl, groupId, guildId]
      );

      sysLog('Embed Group Images Edited', {
        guild: guildId,
        user: interaction.user.id,
        detail: `ID: ${groupId} images updated`
      });

      if (skippedFields.length > 0) {
        await interaction.followUp({
          content: `⚠️ Skipped invalid input: ${skippedFields.join(', ')}. All other changes were saved.`,
          flags: MessageFlags.Ephemeral
        }).catch(() => {});
      }

      return renderGroupManagePage(interaction, groupId);
    } catch (err) {
      sysError('Failed to update embed group images', err, { guild: guildId, id: groupId });
      const errorEmbed = createErrorEmbed(
        'Database Error',
        'Failed to update embed group images in database. Please try again.'
      );
      await interaction.followUp({
        embeds: [errorEmbed],
        flags: MessageFlags.Ephemeral
      });
      return renderGroupManagePage(interaction, groupId);
    }
  }

  // 8. Update Group Modal (live edit by message URL)
  if (customId.startsWith('embed_modal_group_update_')) {
    await interaction.deferUpdate().catch(() => {});

    const parts = customId.split('_');
    const groupId = parseInt(parts[4], 10);
    const rawUrl = interaction.fields.getTextInputValue('embed_group_msg_url')?.trim() || '';

    const urlMatch = rawUrl.match(/discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)/);
    if (!urlMatch) {
      const errorEmbed = createErrorEmbed(
        'Invalid Message Link',
        'Please copy and paste the full Discord message link (Right click message > Copy Message Link).'
      );
      await interaction.followUp({
        embeds: [errorEmbed],
        flags: MessageFlags.Ephemeral
      });
      return renderGroupManagePage(interaction, groupId);
    }

    const [, urlGuildId, urlChannelId, urlMessageId] = urlMatch;

    // Cross-server isolation check
    if (urlGuildId !== guildId) {
      const errorEmbed = createErrorEmbed(
        'Cross-Server Access Prohibited',
        'You can only update messages within this server. Message links from external servers cannot be modified.'
      );
      await interaction.followUp({
        embeds: [errorEmbed],
        flags: MessageFlags.Ephemeral
      });
      return renderGroupManagePage(interaction, groupId);
    }

    const channel = interaction.guild?.channels.cache.get(urlChannelId);
    if (!channel) {
      const errorEmbed = createErrorEmbed(
        'Channel Unavailable',
        'Target channel could not be found or the bot lacks access to view it.'
      );
      await interaction.followUp({
        embeds: [errorEmbed],
        flags: MessageFlags.Ephemeral
      });
      return renderGroupManagePage(interaction, groupId);
    }

    let targetMessage;
    try {
      targetMessage = await channel.messages.fetch(urlMessageId);
    } catch {
      const errorEmbed = createErrorEmbed(
        'Message Not Found',
        'Could not fetch the target message. Verify the bot has access and the message exists.'
      );
      await interaction.followUp({
        embeds: [errorEmbed],
        flags: MessageFlags.Ephemeral
      });
      return renderGroupManagePage(interaction, groupId);
    }

    if (targetMessage.author.id !== interaction.client.user.id) {
      const errorEmbed = createErrorEmbed(
        'Author Mismatch',
        'Cannot update this message: it was not authored by this bot.'
      );
      await interaction.followUp({
        embeds: [errorEmbed],
        flags: MessageFlags.Ephemeral
      });
      return renderGroupManagePage(interaction, groupId);
    }

    const [groupRes, itemsRes] = await Promise.all([
      pool.query(
        `SELECT * FROM server_embed_groups WHERE id = $1 AND guild_id = $2`,
        [groupId, guildId]
      ),
      pool.query(
        `SELECT se.* FROM server_embeds se
         JOIN server_embed_group_items segi ON se.id = segi.embed_id
         WHERE segi.group_id = $1
         ORDER BY segi.display_order ASC`,
        [groupId]
      )
    ]);

    if (groupRes.rows.length === 0) return renderRootEmbedMenu(interaction);
    const grp = groupRes.rows[0];
    const items = itemsRes.rows;

    const groupEmbed = buildDiscordEmbed(grp);

    let components = [];
    if (items.length > 0) {
      const publicOptions = items.slice(0, 25).map(item => {
        const label = getEmbedDisplayName(item);
        return {
          label,
          value: String(item.id),
          emoji: '📄'
        };
      });

      const publicSelectMenu = new StringSelectMenuBuilder()
        .setCustomId('embed_public_group_select')
        .setPlaceholder('Select')
        .addOptions(publicOptions);

      components = [new ActionRowBuilder().addComponents(publicSelectMenu)];
    }

    try {
      await targetMessage.edit({
        embeds: [groupEmbed],
        components
      });

      // Ensure logged in tracking table
      await pool.query(
        `INSERT INTO server_embed_group_posts (message_id, guild_id, group_id, channel_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (message_id) DO UPDATE SET group_id = $3`,
        [urlMessageId, guildId, groupId, urlChannelId]
      );

      await pool.query(
        `UPDATE server_embed_groups
         SET tracked_message_id = $1, tracked_channel_id = $2, updated_at = NOW()
         WHERE id = $3 AND guild_id = $4`,
        [urlMessageId, urlChannelId, groupId, guildId]
      );

      sysLog('Custom Embed Group Updated Live', {
        guild: guildId,
        user: interaction.user.id,
        detail: `ID: ${groupId} | Message: ${urlMessageId}`
      });

      await interaction.followUp({
        content: `✅ Live group message successfully updated! [Jump to Message](https://discord.com/channels/${guildId}/${urlChannelId}/${urlMessageId})`,
        flags: MessageFlags.Ephemeral
      });

      return renderGroupManagePage(interaction, groupId);
    } catch (err) {
      sysError('Failed to live update custom embed group message', err, { guild: guildId, id: groupId });
      await handleInteractionError(interaction, err, 'Live Update Embed Group', { targetChannel: channel });
      return renderGroupManagePage(interaction, groupId);
    }
  }
}
