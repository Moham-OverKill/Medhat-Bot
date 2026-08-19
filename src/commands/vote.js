import {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} from 'discord.js';
import { getGuildConfig } from '../storage/config.js';
import { updateBalance } from '../economy/service.js';
import { query } from '../storage/postgres.js';
import { sysLog, sysError } from '../utils/logger.js';
import { COIN_EMOJI } from '../shared.js';

export const voteCommand = new SlashCommandBuilder()
  .setName('vote')
  .setDescription('Get the link to vote for the bot and claim your coin reward.');

export async function handleVoteCommand(interaction) {
  const guildId = interaction.guildId;
  const config = await getGuildConfig(guildId) || {};
  const voteReward = config.vote_reward_amount !== undefined ? config.vote_reward_amount : 100;

  const desc = voteReward > 0
    ? `Vote for Medhat on [top.gg](https://top.gg/bot/${interaction.client.user.id}) and get ${voteReward.toLocaleString()} ${COIN_EMOJI}`
    : `Vote for Medhat on [top.gg](https://top.gg/bot/${interaction.client.user.id})`;

  const embed = new EmbedBuilder()
    .setTitle('🗳️ Support Medhat!')
    .setDescription(desc)
    .setColor('#F1C40F');

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('VOTE NOW!')
      .setURL(`https://top.gg/bot/${interaction.client.user.id}/vote`)
      .setStyle(ButtonStyle.Link)
  );

  const responseMethod = interaction.deferred || interaction.replied ? 'editReply' : 'reply';
  await interaction[responseMethod]({ embeds: [embed], components: [row] });
}

export async function handleVoteWebhook(client, userId, weight = 1) {
  try {
    // 1. Fetch all guild configurations from the database
    const { query } = await import('../storage/postgres.js');
    const guildConfigs = await query('SELECT guild_id, config FROM guild_configs');

    // 2. Loop through each guild config to see if they have vote reward enabled (> 0)
    for (const row of guildConfigs.rows) {
      const guildId = row.guild_id;
      const config = row.config || {};
      const voteReward = config.vote_reward_amount !== undefined ? config.vote_reward_amount : 100;

      if (voteReward <= 0) continue;

      // Check if the user is a member of this guild
      const guild = client.guilds.cache.get(guildId);
      if (!guild) continue;

      try {
        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member) continue; // Not in this guild

        // 3. Check if they already claimed their vote reward in the last 12 hours in this guild
        const checkClaim = await query(
          `SELECT created_at FROM transactions 
           WHERE user_id = $1 AND guild_id = $2 AND type = 'vote_reward' 
           ORDER BY created_at DESC LIMIT 1`,
          [userId, guildId]
        );

        if (checkClaim.rows.length > 0) {
          const lastClaim = new Date(checkClaim.rows[0].created_at).getTime();
          const now = Date.now();
          const cooldown = 12 * 60 * 60 * 1000; // 12 hours
          if (now - lastClaim < cooldown) {
            sysLog('Vote webhook duplicate claim skipped', { guildId, userId });
            continue;
          }
        }

        // 4. Award the coins (ignoring the Top.gg weekend multiplier to keep rewards consistent)
        const finalReward = voteReward;
        const result = await updateBalance(userId, guildId, finalReward, 'vote_reward', 'Voted on Top.gg');
        if (result.success) {
          sysLog('Vote reward auto-awarded via Webhook', { guildId, userId, amount: finalReward });
          const { sendLog } = await import('../utils/logger.js');
          sendLog(guild, 'economy', 'green', '🗳️ Vote Reward Claimed', `**<@${userId}>** automatically claimed **${finalReward.toLocaleString()}** ${COIN_EMOJI} for voting on Top.gg!`);
        }
      } catch (memberErr) {
        sysError('Error checking member or awarding vote reward', memberErr, { guildId, userId });
      }
    }
  } catch (error) {
    sysError('Failed to handle vote webhook', error, { userId });
  }
}
