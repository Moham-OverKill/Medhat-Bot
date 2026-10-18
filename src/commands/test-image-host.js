import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  MessageFlags
} from 'discord.js';
import {
  IMAGE_HOST_GUILD_ID,
  CATEGORY_THEMES,
  sendTestImagesForGuild
} from '../utils/image-host.js';
import {
  runLegacyAssetSelfHealingSweep,
  getMigrationStatus
} from '../utils/legacy-asset-migrator.js';
import { handleInteractionError } from '../utils/errors.js';

export const testImageHostCommand = new SlashCommandBuilder()
  .setName('test-image-host')
  .setDescription('Test asset hosting forum threads or manage legacy asset migration')
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption(option =>
    option
      .setName('action')
      .setDescription('Action to execute')
      .setRequired(false)
      .addChoices(
        { name: 'Test Host Channels (Default)', value: 'test_channels' },
        { name: 'Migration Status & Statistics', value: 'migration_status' },
        { name: 'Trigger Migration Sweep', value: 'run_migration' }
      )
  )
  .addStringOption(option =>
    option
      .setName('server_id')
      .setDescription('Target Server ID (used when testing host channels)')
      .setRequired(false)
  );

export async function handleTestImageHostCommand(interaction) {
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const action = interaction.options.getString('action') || 'test_channels';

    // =========================================================================
    // ACTION: Migration Status & Statistics
    // =========================================================================
    if (action === 'migration_status') {
      const statusData = await getMigrationStatus();
      const stats = statusData.stats;
      const dbCounts = statusData.dbCounts;

      const embed = new EmbedBuilder()
        .setTitle('Legacy Asset Migration Status')
        .setColor(statusData.isSweepRunning ? '#FEE75C' : '#57F287')
        .setDescription(
          `**Current State:** ${statusData.isSweepRunning ? '🔄 Migration Sweep Currently Running in Background' : '✅ Idle / Complete'}\n` +
          `**Host Server ID:** \`${IMAGE_HOST_GUILD_ID}\``
        )
        .addFields(
          {
            name: 'Database Migration Cache (`migrated_assets`)',
            value:
              `• **Completed & Permanently Hosted:** \`${dbCounts.completed}\`\n` +
              `• **Unrecoverable / Failed:** \`${dbCounts.failed}\`\n` +
              `• **Total Unique Legacy URLs Tracked:** \`${dbCounts.total}\``,
            inline: false
          },
          {
            name: 'Last Startup Sweep Execution',
            value: stats.startedAt
              ? `• **Started:** <t:${Math.floor(new Date(stats.startedAt).getTime() / 1000)}:R>\n` +
                `• **Finished:** ${stats.finishedAt ? `<t:${Math.floor(new Date(stats.finishedAt).getTime() / 1000)}:R>` : 'In Progress'}\n` +
                `• **Total Scanned Across DB:** \`${stats.totalScanned}\`\n` +
                `• **Newly Migrated & Re-uploaded:** \`${stats.migrated}\`\n` +
                `• **Reused from Cache (Deduplicated):** \`${stats.reused}\`\n` +
                `• **Skipped (Already on Host Server):** \`${stats.skipped}\`\n` +
                `• **Failed (Dead Source URLs):** \`${stats.failed}\``
              : '• No migration sweep has been executed during this session yet.',
            inline: false
          }
        )
        .setTimestamp();

      if (stats.errors && stats.errors.length > 0) {
        embed.addFields({
          name: 'Recent Diagnostic Warnings',
          value: stats.errors.slice(0, 5).map(e => `• \`${e}\``).join('\n') || 'None',
          inline: false
        });
      }

      return await interaction.editReply({ embeds: [embed] });
    }

    // =========================================================================
    // ACTION: Trigger Migration Sweep
    // =========================================================================
    if (action === 'run_migration') {
      const statusData = await getMigrationStatus();
      if (statusData.isSweepRunning) {
        const embed = new EmbedBuilder()
          .setTitle('Migration Sweep Already Running')
          .setColor('#FEE75C')
          .setDescription('An asset migration sweep is currently active in the background. Use `/test-image-host action:Migration Status & Statistics` to monitor progress.')
          .setTimestamp();
        return await interaction.editReply({ embeds: [embed] });
      }

      // Start non-blocking migration sweep
      runLegacyAssetSelfHealingSweep(interaction.client).catch(() => {});

      const embed = new EmbedBuilder()
        .setTitle('Legacy Asset Migration Sweep Started')
        .setColor('#5865F2')
        .setDescription(
          `Autonomous self-healing migration sweep has been triggered in the background.\n\n` +
          `• Scanning: \`shop_items\`, \`shop_posts\`, \`loot_boxes\`, \`server_embeds\`, \`server_embed_groups\`, and \`guild_configs\`.\n` +
          `• Pacing: 500ms between uploads to avoid Discord rate limits.\n` +
          `• Check progress with: \`/test-image-host action:Migration Status & Statistics\``
        )
        .setTimestamp();

      return await interaction.editReply({ embeds: [embed] });
    }

    // =========================================================================
    // ACTION: Test Host Channels (Default)
    // =========================================================================
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
