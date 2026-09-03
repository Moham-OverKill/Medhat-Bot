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

const EMBED_COLOR = 0x2F3136;

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
  const embed = new EmbedBuilder()
    .setDescription(emb.content || '*No content*')
    .setColor(EMBED_COLOR);

  if (emb.title) {
    embed.setTitle(emb.title);
  }

  if (emb.thumbnail_url && isValidHttpUrl(emb.thumbnail_url)) {
    embed.setThumbnail(emb.thumbnail_url.trim());
  }

  if (emb.image_url && isValidHttpUrl(emb.image_url)) {
    embed.setImage(emb.image_url.trim());
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
    .setColor(EMBED_COLOR);

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
      emoji: '🖼️',
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

  if (emb.tracked_channel_id && emb.tracked_message_id) {
    previewEmbed.setFooter({ text: `Tracked: Channel ID ${emb.tracked_channel_id}` });
  }

  // Strict 4-button row: [ ⬅️ Back ] | [ ✏️ Edit ] | [ 📤 Send ] | [ 🔄 Update ]
  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('embed_back_root')
      .setLabel('Back')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`embed_edit_${emb.id}`)
      .setLabel('Edit')
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`embed_send_${emb.id}`)
      .setLabel('Send')
      .setEmoji('📤')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`embed_update_${emb.id}`)
      .setLabel('Update')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary)
  );

  const responseMethod = (interaction.deferred || interaction.replied)
    ? 'editReply'
    : (interaction.isButton() || interaction.isAnySelectMenu() ? 'update' : 'editReply');

  await interaction[responseMethod]({
    content: '',
    embeds: [previewEmbed],
    components: [actionRow]
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
    .setColor(EMBED_COLOR);

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
        .setPlaceholder('Embed title (plain text)...')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(256)
        .setRequired(false);

      const contentInput = new TextInputBuilder()
        .setCustomId('embed_content')
        .setLabel('Content')
        .setPlaceholder('Embed description / body text...')
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(4000)
        .setRequired(true);

      const thumbnailInput = new TextInputBuilder()
        .setCustomId('embed_thumbnail_url')
        .setLabel('Top Icon URL')
        .setPlaceholder('https://... (small icon at top-right)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false);

      const imageInput = new TextInputBuilder()
        .setCustomId('embed_image_url')
        .setLabel('Embed Image URL')
        .setPlaceholder('https://... (large main banner image)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false);

      modal.addComponents(
        new ActionRowBuilder().addComponents(titleInput),
        new ActionRowBuilder().addComponents(contentInput),
        new ActionRowBuilder().addComponents(thumbnailInput),
        new ActionRowBuilder().addComponents(imageInput)
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

  // Edit Button -> Show Modal
  if (customId.startsWith('embed_edit_')) {
    const embedId = parseInt(customId.replace('embed_edit_', ''), 10);
    const pool = getPool();
    const result = await pool.query(
      `SELECT title, content, thumbnail_url, image_url FROM server_embeds WHERE id = $1 AND guild_id = $2`,
      [embedId, interaction.guildId]
    );

    if (result.rows.length === 0) return renderRootEmbedMenu(interaction);
    const emb = result.rows[0];

    const modal = new ModalBuilder()
      .setCustomId(`embed_modal_edit_${embedId}`)
      .setTitle('Edit Embed');

    const titleInput = new TextInputBuilder()
      .setCustomId('embed_title')
      .setLabel('Title')
      .setPlaceholder('Embed title (plain text)...')
      .setStyle(TextInputStyle.Short)
      .setMaxLength(256)
      .setRequired(false);

    if (emb.title) titleInput.setValue(emb.title);

    const contentInput = new TextInputBuilder()
      .setCustomId('embed_content')
      .setLabel('Content')
      .setPlaceholder('Embed description / body text...')
      .setStyle(TextInputStyle.Paragraph)
      .setMaxLength(4000)
      .setRequired(true);

    if (emb.content) contentInput.setValue(emb.content);

    const thumbnailInput = new TextInputBuilder()
      .setCustomId('embed_thumbnail_url')
      .setLabel('Top Icon URL')
      .setPlaceholder('https://... (small icon at top-right)')
      .setStyle(TextInputStyle.Short)
      .setRequired(false);

    if (emb.thumbnail_url) thumbnailInput.setValue(emb.thumbnail_url);

    const imageInput = new TextInputBuilder()
      .setCustomId('embed_image_url')
      .setLabel('Embed Image URL')
      .setPlaceholder('https://... (large main banner image)')
      .setStyle(TextInputStyle.Short)
      .setRequired(false);

    if (emb.image_url) imageInput.setValue(emb.image_url);

    modal.addComponents(
      new ActionRowBuilder().addComponents(titleInput),
      new ActionRowBuilder().addComponents(contentInput),
      new ActionRowBuilder().addComponents(thumbnailInput),
      new ActionRowBuilder().addComponents(imageInput)
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

  // Update Button -> URL Modal
  if (customId.startsWith('embed_update_')) {
    const embedId = parseInt(customId.replace('embed_update_', ''), 10);
    const pool = getPool();
    const result = await pool.query(
      `SELECT tracked_channel_id, tracked_message_id FROM server_embeds WHERE id = $1 AND guild_id = $2`,
      [embedId, interaction.guildId]
    );

    const emb = result.rows[0];
    const modal = new ModalBuilder()
      .setCustomId(`embed_modal_update_${embedId}`)
      .setTitle('Update Message');

    const urlInput = new TextInputBuilder()
      .setCustomId('embed_msg_url')
      .setLabel('Message URL')
      .setPlaceholder('https://discord.com/channels/.../.../...')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    if (emb?.tracked_channel_id && emb?.tracked_message_id) {
      urlInput.setValue(`https://discord.com/channels/${interaction.guildId}/${emb.tracked_channel_id}/${emb.tracked_message_id}`);
    }

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
 * Handle Modal Submissions for embeds (create, edit, update)
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
    const thumbnailUrl = interaction.fields.getTextInputValue('embed_thumbnail_url')?.trim() || null;
    const imageUrl = interaction.fields.getTextInputValue('embed_image_url')?.trim() || null;

    try {
      const insertResult = await pool.query(
        `INSERT INTO server_embeds (guild_id, title, content, thumbnail_url, image_url)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [guildId, title, content, thumbnailUrl, imageUrl]
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

  // 2. Edit Modal
  if (customId.startsWith('embed_modal_edit_')) {
    await interaction.deferUpdate().catch(() => {});

    const embedId = parseInt(customId.replace('embed_modal_edit_', ''), 10);
    const title = interaction.fields.getTextInputValue('embed_title')?.trim() || null;
    const content = interaction.fields.getTextInputValue('embed_content')?.trim() || '';
    const thumbnailUrl = interaction.fields.getTextInputValue('embed_thumbnail_url')?.trim() || null;
    const imageUrl = interaction.fields.getTextInputValue('embed_image_url')?.trim() || null;

    try {
      await pool.query(
        `UPDATE server_embeds
         SET title = $1, content = $2, thumbnail_url = $3, image_url = $4, updated_at = NOW()
         WHERE id = $5 AND guild_id = $6`,
        [title, content, thumbnailUrl, imageUrl, embedId, guildId]
      );

      sysLog('Custom Embed Edited', {
        guild: guildId,
        user: interaction.user.id,
        detail: `ID: ${embedId} | Title: ${title || 'Untitled'}`
      });

      return renderEmbedManagePage(interaction, embedId);
    } catch (err) {
      sysError('Failed to update custom embed', err, { guild: guildId, id: embedId });
      await interaction.followUp({
        content: '❌ Failed to update embed in database.',
        flags: MessageFlags.Ephemeral
      });
      return renderEmbedManagePage(interaction, embedId);
    }
  }

  // 3. Update Modal (live edit by message URL)
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

    if (urlGuildId !== guildId) {
      await interaction.followUp({
        content: '❌ The provided message link belongs to a different server.',
        flags: MessageFlags.Ephemeral
      });
      return renderEmbedManagePage(interaction, embedId);
    }

    const channel = interaction.guild.channels.cache.get(urlChannelId)
      || await interaction.guild.channels.fetch(urlChannelId).catch(() => null);

    if (!channel) {
      await interaction.followUp({
        content: '❌ Channel not found or bot does not have access to view it.',
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

    if (targetMsg.author.id !== interaction.client.user.id) {
      await interaction.followUp({
        content: '❌ The bot can only edit messages that were sent by this bot.',
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

    // Save updated tracking info
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
