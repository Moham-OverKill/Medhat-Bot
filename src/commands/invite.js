import { getGuildConfig } from '../storage/config.js';
import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder
} from 'discord.js';
import { handleInteractionError } from '../utils/errors.js';

export const inviteCommand = new SlashCommandBuilder()
  .setName('invite')
  .setDescription('Invite Medhat bot to your own server');

export async function handleInviteCommand(interaction) {
  try {
    const guildId = interaction.guildId;
    const config = guildId ? await getGuildConfig(guildId) : null;
    const botName = config?.bot_name || interaction.client.user?.username || 'Medhat';
    const clientId = interaction.client.user?.id || '815148891598356502';
    const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${clientId}`;
    const topGgUrl = `https://top.gg/bot/${clientId}`;

    const embed = new EmbedBuilder()
      .setTitle(`Invite ${botName}`)
      .setDescription(`Add **${botName}** to your server to access community economy, quests, levels, and colors.`)
      .setColor('#5865F2');

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('TOP.GG')
        .setStyle(ButtonStyle.Link)
        .setURL(topGgUrl),
      new ButtonBuilder()
        .setLabel('INVITE')
        .setStyle(ButtonStyle.Link)
        .setURL(inviteUrl)
    );

    await interaction.reply({
      embeds: [embed],
      components: [row]
    });
  } catch (error) {
    await handleInteractionError(interaction, error, 'invite command');
  }
}
