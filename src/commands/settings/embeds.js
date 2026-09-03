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
import { diagnoseChannelPermissions } from '../../utils/errors.js';

const DEFAULT_EMBED_COLOR = 0x2F3136;

/**
 * Validate HTTP/HTTPS URL
 */
function isValidHttpUrl(string) {
  if (!string || typeof string !== 'string') return false;
  try {
    const url = new URL(string.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

/**
 * Build a Discord EmbedBuilder from a server_embeds record
 */
function buildDiscordEmbed(emb) {
  const embed = new EmbedBuilder();

  // Color resolution
  if (emb.color && /^#?[0-9A-Fa-f]{6}$/.test(emb.color.trim())) {
    const cleanHex = emb.color.trim().replace('#', '');
    embed.setColor(parseInt(cleanHex, 16));
  } else {
    embed.setColor(DEFAULT_EMBED_COLOR);
  }

  // Author header
  if (emb.author_name) {
    const authorObj = { name: emb.author_name };
    if (emb.author_icon_url && isValidHttpUrl(emb.author_icon_url)) {
      authorObj.iconURL = emb.author_icon_url.trim();
    }
    embed.setAuthor(authorObj);
  }

  // Title
  if (emb.title) {
    embed.setTitle(emb.title);
  }

  // Content / Description
  embed.setDescription(emb.content || '*No content*');

  // Top Icon (Thumbnail)
  if (emb.thumbnail_url && isValidHttpUrl(emb.thumbnail_url)) {
    embed.setThumbnail(emb.thumbnail_url.trim());
  }

  // Main Image (Banner)
  if (emb.image_url && isValidHttpUrl(emb.image_url)) {
    embed.setImage(emb.image_url.trim());
  }

  // Footer
  if (emb.footer_text) {
    const footerObj = { text: emb.footer_text };
    if (emb.footer_icon_url && isValidHttpUrl(emb.footer_icon_url)) {
      footerObj.iconURL = emb.footer_icon_url.trim();
    }
    embed.setFooter(footerObj);
  }

  return embed;
}

/**
 * Render the Root Embed Menu displaying saved embeds and [ ➕ Create ]
 */
export async function renderRootEmbedMenu(interaction) {
  const guildId = interaction.guildId;
  const pool = getPool();

  const result = await pool.query(
    `SELECT id, title, content FROM server_embeds WHERE guild_id = $1 ORDER BY id ASC`,
    [guildId]
  ).catch(err => {
    sysError('Failed to fetch server embeds', err, { guild: guildId });
    return { rows: [] };
  });

  const embeds = result.rows;

  const menuEmbed = new EmbedBuilder()
    .setTitle('Embed Manager')
    .setDescription('Select an existing embed to manage, or create a new one.')
    .setColor(DEFAULT_EMBED_COLOR);

  const selectOptions = [
    {
      label: 'Create',
      value: 'create',
      emoji: '➕',
      description: 'Create a new custom embed'
    }
  ];

  for (const emb of embeds.slice(0, 24)) {
    const label = emb.title ? emb.title.slice(0, 100) : `Embed #${emb.id}`;
    const rawDesc = emb.content ? emb.content.replace(/\n+/g, ' ').slice(0, 95) : 'No content';
    selectOptions.push({
      label,
      value: String(emb.id),
      emoji: '📰',
      description: rawDesc
    });
  }

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('embed_root_select')
    .setPlaceholder('Select an embed to manage...')
    .addOptions(selectOptions);

  const selectRow = new ActionRowBuilder().addComponents(selectMenu);

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
    components: [selectRow, navRow]
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
    `SELECT id, title FROM server_embeds WHERE id = $1 AND guild_id = $2`,
    [embedId, guildId]
  );

  if (result.rows.length === 0) {
    return renderRootEmbedMenu(interaction);
  }

  const emb = result.rows[0];

  const infoEmbed = new EmbedBuilder()
    .setTitle('Send Embed')
    .setDescription(`Choose the text channel where **${emb.title || `Embed #${emb.id}`}** should be posted.`)
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
        .setRequired(true);

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
      `SELECT author_name, title, content, footer_text, color FROM server_embeds WHERE id = $1 AND guild_id = $2`,
      [embedId, interaction.guildId]
    );

    if (result.rows.length === 0) return renderRootEmbedMenu(interaction);
    const emb = result.rows[0];

    const modal = new ModalBuilder()
      .setCustomId(`embed_modal_text_${embedId}`)
      .setTitle('Edit Text');

    const authorInput = new TextInputBuilder()
      .setCustomId('embed_author_name')
      .setLabel('Author Name')
      .setPlaceholder('Text on the top-left...')
      .setStyle(TextInputStyle.Short)
      .setMaxLength(256)
      .setRequired(false);
    if (emb.author_name) authorInput.setValue(emb.author_name);

    const titleInput = new TextInputBuilder()
      .setCustomId('embed_title')
      .setLabel('Title')
      .setPlaceholder('Title at the top...')
      .setStyle(TextInputStyle.Short)
      .setMaxLength(256)
      .setRequired(false);
    if (emb.title) titleInput.setValue(emb.title);

    const contentInput = new TextInputBuilder()
      .setCustomId('embed_content')
      .setLabel('Content')
      .setPlaceholder('Main text in the middle...')
      .setStyle(TextInputStyle.Paragraph)
      .setMaxLength(4000)
      .setRequired(true);
    if (emb.content) contentInput.setValue(emb.content);

    const footerInput = new TextInputBuilder()
      .setCustomId('embed_footer_text')
      .setLabel('Footer Text')
      .setPlaceholder('Text on the bottom-left...')
      .setStyle(TextInputStyle.Short)
      .setMaxLength(2048)
      .setRequired(false);
    if (emb.footer_text) footerInput.setValue(emb.footer_text);

    const colorInput = new TextInputBuilder()
      .setCustomId('embed_color')
      .setLabel('Hex Code')
      .setPlaceholder('Left border color...')
      .setStyle(TextInputStyle.Short)
      .setMaxLength(7)
      .setRequired(false);
    if (emb.color) colorInput.setValue(emb.color);

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
      `SELECT thumbnail_url, image_url, author_icon_url, footer_icon_url FROM server_embeds WHERE id = $1 AND guild_id = $2`,
      [embedId, interaction.guildId]
    );

    if (result.rows.length === 0) return renderRootEmbedMenu(interaction);
    const emb = result.rows[0];

    const modal = new ModalBuilder()
      .setCustomId(`embed_modal_images_${embedId}`)
      .setTitle('Edit Images');

    // 1. Author Icon
    const authorIconInput = new TextInputBuilder()
      .setCustomId('embed_author_icon_url')
      .setLabel('Author Icon')
      .setPlaceholder('Icon on the top-left...')
      .setStyle(TextInputStyle.Short)
      .setRequired(false);
    if (emb.author_icon_url) authorIconInput.setValue(emb.author_icon_url);

    // 2. Thumbnail
    const thumbInput = new TextInputBuilder()
      .setCustomId('embed_thumbnail_url')
      .setLabel('Thumbnail')
      .setPlaceholder('Image on the top-right...')
      .setStyle(TextInputStyle.Short)
      .setRequired(false);
    if (emb.thumbnail_url) thumbInput.setValue(emb.thumbnail_url);

    // 3. Banner
    const imageInput = new TextInputBuilder()
      .setCustomId('embed_image_url')
      .setLabel('Banner')
      .setPlaceholder('Big image under the text...')
      .setStyle(TextInputStyle.Short)
      .setRequired(false);
    if (emb.image_url) imageInput.setValue(emb.image_url);

    // 4. Footer Icon
    const footerIconInput = new TextInputBuilder()
      .setCustomId('embed_footer_icon_url')
      .setLabel('Footer Icon')
      .setPlaceholder('Icon on the bottom-left...')
      .setStyle(TextInputStyle.Short)
      .setRequired(false);
    if (emb.footer_icon_url) footerIconInput.setValue(emb.footer_icon_url);

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
      .setCustomId(`embed_modal_update_${embedId}`)
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
    await interaction.followUp({
      content: '❌ Channel not found or bot lacks access.',
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
    await interaction.followUp({
      content: `❌ The bot is missing required permissions in <#${channelId}>: ${diag.missing.join(', ')}.`,
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
    await interaction.followUp({
      content: `❌ Failed to send embed to <#${channelId}>: ${sendErr.message || 'Check permissions.'}`,
      flags: MessageFlags.Ephemeral
    });
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
    const content = interaction.fields.getTextInputValue('embed_content')?.trim() || '';

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
      await interaction.followUp({
        content: '❌ Failed to save embed to database.',
        flags: MessageFlags.Ephemeral
      });
      return renderRootEmbedMenu(interaction);
    }
  }

  // 2. Edit Text Modal
  if (customId.startsWith('embed_modal_text_')) {
    await interaction.deferUpdate().catch(() => {});

    const embedId = parseInt(customId.replace('embed_modal_text_', ''), 10);
    const authorName = interaction.fields.getTextInputValue('embed_author_name')?.trim() || null;
    const title = interaction.fields.getTextInputValue('embed_title')?.trim() || null;
    const content = interaction.fields.getTextInputValue('embed_content')?.trim() || '';
    const footerText = interaction.fields.getTextInputValue('embed_footer_text')?.trim() || null;
    const color = interaction.fields.getTextInputValue('embed_color')?.trim() || null;

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

      return renderEmbedManagePage(interaction, embedId);
    } catch (err) {
      sysError('Failed to update custom embed text', err, { guild: guildId, id: embedId });
      await interaction.followUp({
        content: '❌ Failed to update embed text in database.',
        flags: MessageFlags.Ephemeral
      });
      return renderEmbedManagePage(interaction, embedId);
    }
  }

  // 3. Edit Images Modal
  if (customId.startsWith('embed_modal_images_')) {
    await interaction.deferUpdate().catch(() => {});

    const embedId = parseInt(customId.replace('embed_modal_images_', ''), 10);
    const thumbnailUrl = interaction.fields.getTextInputValue('embed_thumbnail_url')?.trim() || null;
    const imageUrl = interaction.fields.getTextInputValue('embed_image_url')?.trim() || null;
    const authorIconUrl = interaction.fields.getTextInputValue('embed_author_icon_url')?.trim() || null;
    const footerIconUrl = interaction.fields.getTextInputValue('embed_footer_icon_url')?.trim() || null;

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

      return renderEmbedManagePage(interaction, embedId);
    } catch (err) {
      sysError('Failed to update custom embed images', err, { guild: guildId, id: embedId });
      await interaction.followUp({
        content: '❌ Failed to update embed images in database.',
        flags: MessageFlags.Ephemeral
      });
      return renderEmbedManagePage(interaction, embedId);
    }
  }

  // 4. Update Modal (live edit by message URL with safety guardrails)
  if (customId.startsWith('embed_modal_update_')) {
    await interaction.deferUpdate().catch(() => {});

    const embedId = parseInt(customId.replace('embed_modal_update_', ''), 10);
    const rawUrl = interaction.fields.getTextInputValue('embed_msg_url')?.trim() || '';

    const urlMatch = rawUrl.match(/discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)/);
    if (!urlMatch) {
      await interaction.followUp({
        content: '❌ Invalid message link. Please copy the full Discord message link (Right click message > Copy Message Link).',
        flags: MessageFlags.Ephemeral
      });
      return renderEmbedManagePage(interaction, embedId);
    }

    const [, urlGuildId, urlChannelId, urlMessageId] = urlMatch;

    // Cross-server isolation check
    if (urlGuildId !== guildId) {
      await interaction.followUp({
        content: '❌ You can only update messages in this server. Message links from other servers are strictly prohibited.',
        flags: MessageFlags.Ephemeral
      });
      return renderEmbedManagePage(interaction, embedId);
    }

    const channel = interaction.guild.channels.cache.get(urlChannelId)
      || await interaction.guild.channels.fetch(urlChannelId).catch(() => null);

    if (!channel || channel.guildId !== guildId) {
      await interaction.followUp({
        content: '❌ Channel not found in this server or the bot does not have access to view it.',
        flags: MessageFlags.Ephemeral
      });
      return renderEmbedManagePage(interaction, embedId);
    }

    const targetMsg = await channel.messages.fetch(urlMessageId).catch(() => null);
    if (!targetMsg) {
      await interaction.followUp({
        content: '❌ Message not found. It may have been deleted.',
        flags: MessageFlags.Ephemeral
      });
      return renderEmbedManagePage(interaction, embedId);
    }

    // Guardrail 1: Must be sent by this bot
    if (targetMsg.author.id !== interaction.client.user.id) {
      await interaction.followUp({
        content: '❌ The bot can only edit messages that were sent by this bot.',
        flags: MessageFlags.Ephemeral
      });
      return renderEmbedManagePage(interaction, embedId);
    }

    // Guardrail 2: Must be an embed message
    if (!targetMsg.embeds || targetMsg.embeds.length === 0) {
      await interaction.followUp({
        content: '❌ That message is not an embed message and cannot be edited by the Custom Embed Manager.',
        flags: MessageFlags.Ephemeral
      });
      return renderEmbedManagePage(interaction, embedId);
    }

    // Guardrail 3: Must NOT have interactive components (protects Shop, Hub, Drops, Trade menus)
    if (targetMsg.components && targetMsg.components.length > 0) {
      await interaction.followUp({
        content: '❌ That message is an interactive bot control panel or feature and cannot be modified.',
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
      await interaction.followUp({
        content: '❌ That message is an active Leaderboard message and cannot be modified.',
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
      await interaction.followUp({
        content: '❌ That message is the Server Hub message and cannot be modified.',
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
      await interaction.followUp({
        content: `❌ Failed to edit message: ${editErr.message || 'Unknown error'}`,
        flags: MessageFlags.Ephemeral
      });
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
}
