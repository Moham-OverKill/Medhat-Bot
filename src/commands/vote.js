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
    .setTitle('Support Medhat!')
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
    const { getPool } = await import('../storage/postgres.js');
    const pool = getPool();
    const guildConfigs = await pool.query('SELECT guild_id, config FROM guild_configs');

    for (const row of guildConfigs.rows) {
      const guildId = row.guild_id;
      const config = row.config || {};
      const voteReward = config.vote_reward_amount !== undefined ? config.vote_reward_amount : 100;

      if (voteReward <= 0) continue;

      const guild = client.guilds.cache.get(guildId);
      if (!guild) continue;

      try {
        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member) continue; // Not in this guild

        const dbClient = await pool.connect();
        try {
          await dbClient.query('BEGIN');

          // Row lock to serialize duplicate concurrent webhook calls
          await dbClient.query(
            `INSERT INTO user_balances (user_id, guild_id, balance)
             VALUES ($1, $2, 0)
             ON CONFLICT (user_id, guild_id) DO UPDATE SET updated_at = NOW()`,
            [userId, guildId]
          );
          await dbClient.query(
            'SELECT balance FROM user_balances WHERE user_id = $1 AND guild_id = $2 FOR UPDATE',
            [userId, guildId]
          );

          // Check if claimed in last 12h within the locked transaction
          const checkClaim = await dbClient.query(
            `SELECT created_at FROM transactions 
             WHERE user_id = $1 AND guild_id = $2 AND type = 'vote_reward' 
             ORDER BY created_at DESC LIMIT 1`,
            [userId, guildId]
          );

          if (checkClaim.rows.length > 0) {
            const lastClaim = new Date(checkClaim.rows[0].created_at).getTime();
            const now = Date.now();
            const cooldown = 12 * 60 * 60 * 1000;
            if (now - lastClaim < cooldown) {
              await dbClient.query('ROLLBACK');
              sysLog('Vote webhook duplicate claim skipped', { guildId, userId });
              continue;
            }
          }

          const balUpdate = await dbClient.query(
            `UPDATE user_balances
             SET balance = balance + $1,
                 total_earned = total_earned + $1,
                 updated_at = NOW()
             WHERE user_id = $2 AND guild_id = $3
             RETURNING balance`,
            [voteReward, userId, guildId]
          );
          const newBal = parseInt(balUpdate.rows[0]?.balance || 0, 10);

          await dbClient.query(
            `INSERT INTO transactions (user_id, guild_id, amount, balance_after, type, description)
             VALUES ($1, $2, $3, $4, 'vote_reward', 'Voted on Top.gg')`,
            [userId, guildId, voteReward, newBal]
          );

          await dbClient.query('COMMIT');

          sysLog('Vote reward auto-awarded via Webhook', { guildId, userId, amount: voteReward });
          const { sendLog } = await import('../utils/logger.js');
          sendLog(guild, 'economy', 'green', 'Vote Reward Claimed', `**<@${userId}>** automatically claimed **${voteReward.toLocaleString()}** ${COIN_EMOJI} for voting on Top.gg.`);
        } catch (txErr) {
          await dbClient.query('ROLLBACK').catch(() => {});
          throw txErr;
        } finally {
          dbClient.release();
        }
      } catch (memberErr) {
        sysError('Error checking member or awarding vote reward', memberErr, { guildId, userId });
      }
    }
  } catch (error) {
    sysError('Failed to handle vote webhook', error, { userId });
  }
}
