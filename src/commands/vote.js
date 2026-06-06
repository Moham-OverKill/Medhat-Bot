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
  const voteReward = config.vote_reward_amount || 0;

  const embed = new EmbedBuilder()
    .setTitle('🗳️ Vote for Medhat')
    .setDescription(
      `Support us by voting for **Medhat** on Top.gg!\n\n` +
      `**Reward:** \`${voteReward.toLocaleString()}\` coins per vote (can be claimed every 12 hours).`
    )
    .setColor('#F1C40F');

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('Vote on Top.gg')
      .setURL(`https://top.gg/bot/${interaction.client.user.id}/vote`)
      .setStyle(ButtonStyle.Link),
    new ButtonBuilder()
      .setCustomId('vote_verify')
      .setLabel('Verify & Claim Reward')
      .setEmoji('💸')
      .setStyle(ButtonStyle.Success)
  );

  await interaction.reply({ embeds: [embed], components: [row] });
}

export async function handleVoteVerify(interaction) {
  const isButton = interaction.isButton();
  
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }

  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  const config = await getGuildConfig(guildId) || {};
  const voteReward = config.vote_reward_amount || 0;

  if (voteReward <= 0) {
    return interaction.editReply({ content: '❌ Vote rewards are not enabled or configured for this server.' });
  }

  // 1. Check if they already claimed their vote reward in the last 12 hours
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
      const remainingMs = cooldown - (now - lastClaim);
      const remainingHours = Math.floor(remainingMs / (60 * 60 * 1000));
      const remainingMinutes = Math.floor((remainingMs % (60 * 60 * 1000)) / (60 * 1000));
      return interaction.editReply({ 
        content: `❌ You have already claimed your vote reward recently. Please try again in **${remainingHours}h ${remainingMinutes}m**.` 
      });
    }
  }

  // 2. Fetch Top.gg API to see if the user voted in the last 12 hours
  const topggToken = process.env.TOPGG_TOKEN;
  if (!topggToken) {
    sysLog('Top.gg Missing Token', { guildId, userId });
    return interaction.editReply({ 
      content: '❌ Top.gg integration is not fully configured (missing TOPGG_TOKEN on the bot host).' 
    });
  }

  try {
    const url = `https://top.gg/api/bots/${interaction.client.user.id}/check?userId=${userId}`;
    const response = await fetch(url, {
      headers: {
        'Authorization': topggToken
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      sysError('Top.gg API check failure', new Error(errorText), { status: response.status });
      return interaction.editReply({ 
        content: '❌ Failed to verify your vote with Top.gg. Please make sure you voted and try again shortly.' 
      });
    }

    const data = await response.json();
    // Top.gg check returns: { voted: 1 } or { voted: 0 }
    if (data.voted !== 1) {
      return interaction.editReply({ 
        content: '❌ Top.gg reports that you have not voted in the last 12 hours. Please vote first using the link above!' 
      });
    }

    // 3. User voted and hasn't claimed yet. Add the coins to their balance!
    const result = await updateBalance(userId, guildId, voteReward, 'vote_reward', 'Voted for the bot on Top.gg');
    if (!result.success) {
      return interaction.editReply({ 
        content: `❌ Failed to award coins: ${result.error || 'Unknown error'}` 
      });
    }

    return interaction.editReply({
      content: `🎉 Thank you for voting! You have been awarded **${voteReward.toLocaleString()}** ${COIN_EMOJI} coins. Your new balance is **${result.balance.toLocaleString()}** ${COIN_EMOJI} coins.`
    });

  } catch (error) {
    sysError('Vote verification failed', error, { user: userId, guild: guildId });
    return interaction.editReply({ 
      content: '❌ An error occurred while verifying your vote. Please try again later.' 
    });
  }
}
