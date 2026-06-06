import { getGuildConfig } from '../storage/config.js';
import { query } from '../storage/postgres.js';
import { updateBalance } from '../economy/service.js';
import { sendLog, sysLog, sysError } from '../utils/logger.js';
import { COIN_EMOJI } from '../shared.js';

/**
 * Scans all guild members, identifies who has the server tag in their username/nickname,
 * and awards them daily coins (once per Cairo calendar day).
 * 
 * @param {Client} client - Discord client instance
 * @param {string} guildId - Target guild ID
 */
export async function runTagRewardsCycle(client, guildId) {
  try {
    const config = await getGuildConfig(guildId);
    if (!config) return;

    const rewardAmount = parseInt(config.tag_reward_amount, 10);
    const tag = config.server_tag?.trim();

    if (isNaN(rewardAmount) || rewardAmount <= 0 || !tag) {
      sysLog('Tag Rewards Skipped', { guild: guildId, detail: 'Tag rewards disabled or incomplete config' });
      return;
    }

    const guildObj = await client.guilds.fetch(guildId).catch(() => null);
    if (!guildObj) {
      sysLog('Tag Rewards Skipped', { guild: guildId, detail: 'Guild not found by client' });
      return;
    }

    sysLog('Tag Rewards Scan Started', { guild: guildId, tag, rewardAmount });

    // Fetch all guild members from Discord API
    const members = await guildObj.members.fetch({ force: true }).catch((err) => {
      sysError('Tag Rewards Member Fetch Failed', err, { guild: guildId });
      return new Map();
    });

    if (members.size === 0) {
      sysLog('Tag Rewards Scan Aborted', { guild: guildId, detail: 'No members retrieved' });
      return;
    }

    let paidUsersCount = 0;
    const now = new Date();

    for (const [memberId, member] of members) {
      if (member.user.bot) continue;

      const username = member.user.username || '';
      const nickname = member.nickname || '';
      
      const hasTag = username.toLowerCase().includes(tag.toLowerCase()) || 
                     nickname.toLowerCase().includes(tag.toLowerCase());

      if (!hasTag) continue;

      try {
        // Enforce once-per-day Cairo calendar day limit via transaction history check
        const checkPayout = await query(
          `SELECT 1 FROM transactions 
           WHERE user_id = $1 AND guild_id = $2 AND type = 'tag_reward'
             AND (created_at AT TIME ZONE 'Africa/Cairo')::date = ($3 AT TIME ZONE 'Africa/Cairo')::date`,
          [member.id, guildId, now]
        );

        if (checkPayout.rows.length > 0) {
          // Already rewarded today
          continue;
        }

        // Payout the coins
        const result = await updateBalance(member.id, guildId, rewardAmount, 'tag_reward', 'Using Server Tag');
        if (result.success) {
          paidUsersCount++;
        }
      } catch (err) {
        sysError('Tag Payout Member Error', err, { guild: guildId, user: member.id });
      }
    }

    sysLog('Tag Rewards Scan Complete', { guild: guildId, paidMembersCount: paidUsersCount });

    if (paidUsersCount > 0) {
      sendLog(guildObj, 'economy', 'green', '🏷️ Daily Tag Rewards Distributed', 
        `**Action:** \`Daily Tag Scan\`\n` +
        `**Server Tag:** \`${tag}\`\n` +
        `**Reward Value:** \`${rewardAmount.toLocaleString()}\` ${COIN_EMOJI} per member\n` +
        `**Members Rewarded:** \`${paidUsersCount.toLocaleString()}\`\n` +
        `**Total Distributed:** \`${(paidUsersCount * rewardAmount).toLocaleString()}\` ${COIN_EMOJI}`
      );
    }

  } catch (error) {
    sysError('Tag Rewards Cycle Critical Failure', error, { guild: guildId });
  }
}
