import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  MessageFlags
} from 'discord.js';
import {
  IMAGE_HOST_GUILD_ID,
  IMAGE_HOST_CHANNELS,
  CATEGORY_THEMES,
  sendTestImagesForGuild
} from '../utils/image-host.js';
import { handleInteractionError } from '../utils/errors.js';

export const testImageHostCommand = new SlashCommandBuilder()
  .setName('test-image-host')
  .setDescription('Test asset hosting forum threads and test image uploads')
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption(option =>
    option
      .setName('server_id')
      .setDescription('Target Server ID to test forum thread creation for (default: current server)')
      .setRequired(false)
  );

export async function handleTestImageHostCommand(interaction) {
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const targetServerId = interaction.options.getString('server_id')?.trim() || interaction.guildId;
    let targetGuild = interaction.client.guilds.cache.get(targetServerId);

    if (!targetGuild) {
      targetGuild = await interaction.client.guilds.fetch(targetServerId).catch(() => null);
    }

    if (!targetGuild) {
      targetGuild = {
        id: targetServerId,
        name: `Server ${targetServerId}`
      };
    }

    const results = await sendTestImagesForGuild(interaction.client, targetGuild);

    const embed = new EmbedBuilder()
      .setTitle('Asset Host Pipeline Verification Report')
      .setColor('#5865F2')
      .setDescription(
        `**Target Server:** ${targetGuild.name} (\`${targetGuild.id}\`)\n` +
        `**Host Server ID:** \`${IMAGE_HOST_GUILD_ID}\`\n\n` +
        `Verification results for the 4 dedicated forum channels:`
      )
      .setTimestamp();

    let allSuccessful = true;

    for (const res of results) {
      const theme = CATEGORY_THEMES[res.category] || { name: res.category.toUpperCase() };
      if (res.success) {
        embed.addFields({
          name: `${theme.name} Channel (<#${res.channelId}>)`,
          value:
            `• **Thread:** <#${res.threadId}> (\`${res.threadName}\`)\n` +
            `• **Permanent Asset URL:** [Open Discord CDN Link](${res.url})\n` +
            `• **Status:** Operational`,
          inline: false
        });
      } else {
        allSuccessful = false;
        embed.addFields({
          name: `${theme.name} Channel (<#${res.channelId}>)`,
          value:
            `• **Error:** \`${res.error}\`\n` +
            `• **Status:** Failed`,
          inline: false
        });
      }
    }

    if (allSuccessful) {
      embed.setFooter({ text: 'All 4 asset channels verified successfully' });
    } else {
      embed.setFooter({ text: 'One or more channels encountered an error' });
    }

    await interaction.editReply({
      embeds: [embed]
    });
  } catch (error) {
    await handleInteractionError(interaction, error, 'test-image-host command');
  }
}
