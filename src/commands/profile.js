import {
  SlashCommandBuilder,
  AttachmentBuilder,
  MessageFlags
} from 'discord.js';
import { generateProfileCard } from '../graphics/profileCard.js';
import { getUserPassProgress } from './settings/pass-engine.js';
import { getUserBalance } from '../economy/service.js';
import { getGuildConfig } from '../storage/config.js';
import { getPool } from '../storage/postgres.js';
import { handleInteractionError } from '../utils/errors.js';
import { sysLog, sysError } from '../utils/logger.js';

export const profileCommand = new SlashCommandBuilder()
  .setName('profile')
  .setDescription('View your profile card or inspect another member')
  .addUserOption(option =>
    option
      .setName('user')
      .setDescription('The member whose profile you want to view (defaults to yourself)')
      .setRequired(false)
  )
  .setDMPermission(false);

/**
 * Handle /profile Slash Command
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function handleProfileCommand(interaction) {
  try {
    const guild = interaction.guild;
    if (!guild) {
      return interaction.reply({
        content: 'This command can only be used inside a server.',
        flags: MessageFlags.Ephemeral
      });
    }

    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply();
    }

    const targetUser = interaction.options.getUser('user') || interaction.user;
    const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);

    const guildId = guild.id;
    const userId = targetUser.id;
    const pool = getPool();

    // 1. Fetch Economy stats, Level progress, Inventory, Quests, and Rank in parallel
    const [balanceData, passData, rankResult, invResult, questResult, config] = await Promise.all([
      getUserBalance(userId, guildId).catch(() => ({ balance: 0, total_earned: 0, daily_streak: 0 })),
      getUserPassProgress(guildId, userId).catch(() => ({
        currentLevel: 0,
        totalXp: 0,
        xpIntoCurrentLevel: 0,
        xpForNextLevel: 100,
        totalBoostPct: 0
      })),
      pool.query(
        `SELECT COUNT(*) + 1 AS rank
         FROM user_activity
         WHERE guild_id = $1
           AND battlepass_xp > (
             SELECT COALESCE(battlepass_xp, 0)
             FROM user_activity
             WHERE guild_id = $1 AND user_id = $2
           )`,
        [guildId, userId]
      ).catch(() => ({ rows: [{ rank: 1 }] })),
      pool.query(
        `SELECT COALESCE(SUM(quantity), 0)::int AS total_items
         FROM user_inventory
         WHERE guild_id = $1 AND user_id = $2`,
        [guildId, userId]
      ).catch(() => ({ rows: [{ total_items: 0 }] })),
      pool.query(
        `SELECT GREATEST(
           COALESCE((SELECT quests_completed FROM user_activity WHERE guild_id = $1 AND user_id = $2), 0),
           COALESCE((SELECT COUNT(*)::int FROM transactions WHERE user_id = $2 AND guild_id = $1 AND type IN ('quest_reward', 'mission_reward')), 0),
           COALESCE((SELECT COUNT(*)::int FROM quest_progress WHERE guild_id = $1 AND user_id = $2 AND completed = TRUE), 0)
         ) AS quests_done`,
        [guildId, userId]
      ).catch(() => ({ rows: [{ quests_done: 0 }] })),
      getGuildConfig(guildId).catch(() => ({}))
    ]);

    const rank = parseInt(rankResult.rows[0]?.rank || 1, 10);
    const itemCount = parseInt(invResult.rows[0]?.total_items || 0, 10);
    const questsDone = parseInt(questResult.rows[0]?.quests_done || 0, 10);

    const isBooster = Boolean(targetMember?.premiumSince);
    const avatarUrl = targetUser.displayAvatarURL({ extension: 'png', size: 256, forceStatic: true });

    // Derive accent color from member's highest role with color, default to cyan #00E5FF
    const roleColor = targetMember?.displayColor
      ? `#${targetMember.displayColor.toString(16).padStart(6, '0')}`
      : '#00E5FF';

    // Resolve server's custom coin image if configured as a custom Discord emoji
    let customCoinUrl = null;
    const coinEmojiStr = config?.coin_emoji || '';
    const customEmojiMatch = coinEmojiStr.match(/<a?:\w+:(\d{17,20})>/);
    if (customEmojiMatch && customEmojiMatch[1]) {
      customCoinUrl = `https://cdn.discordapp.com/emojis/${customEmojiMatch[1]}.png?size=64&quality=lossless`;
    }

    // 2. Generate Arcane-style Profile Image Buffer
    const imageBuffer = await generateProfileCard({
      displayName: targetMember?.displayName || targetUser.displayName || targetUser.username,
      username: targetUser.username,
      avatarUrl,
      currentLevel: passData.currentLevel || 0,
      rank,
      xpIntoCurrentLevel: passData.xpIntoCurrentLevel || 0,
      xpForNextLevel: passData.xpForNextLevel || 100,
      totalXp: passData.totalXp || 0,
      balance: balanceData.balance || 0,
      questsDone,
      itemCount,
      customCoinUrl,
      isBooster,
      boostPct: passData.totalBoostPct || 0,
      accentColor: roleColor
    });

    const attachment = new AttachmentBuilder(imageBuffer, {
      name: `profile-${targetUser.username}.png`
    });

    await interaction.editReply({
      files: [attachment]
    });

    sysLog('Profile Card Rendered', {
      user: userId,
      guild: guildId,
      detail: `Target: ${targetUser.username} | Level: ${passData.currentLevel} | Rank: #${rank} | Quests: ${questsDone} | Items: ${itemCount}`
    });
  } catch (error) {
    await handleInteractionError(interaction, error, 'profile command');
  }
}
