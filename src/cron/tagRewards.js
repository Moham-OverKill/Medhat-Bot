import { getGuildConfig } from '../storage/config.js';
import { query } from '../storage/postgres.js';
import { updateBalance } from '../economy/service.js';
import { sendLog, sysLog, sysWarn, sysError } from '../utils/logger.js';
import { COIN_EMOJI } from '../shared.js';

/**
 * Scans all guild members, identifies who has the server's official Server Tag enabled,
 * and awards them daily coins (once per Cairo calendar day).
 * 
 * @param {import('discord.js').Client} client - Discord client instance
 * @param {string} guildId - Target guild ID
 * @param {Object} [options={}] - Execution options
 * @returns {Promise<{success: boolean, paidCount: number, totalCoins: number, error?: string}>}
 */
export async function runTagRewardsCycle(client, guildId, options = {}) {
  try {
    const config = await getGuildConfig(guildId);
    if (!config) return { success: false, paidCount: 0, totalCoins: 0, error: 'No configuration found' };

    const rewardAmount = parseInt(config.tag_reward_amount, 10);

    if (isNaN(rewardAmount) || rewardAmount <= 0) {
      sysLog('Tag Rewards Skipped', { guild: guildId, detail: 'Tag rewards disabled or reward amount not set' });
      return { success: false, paidCount: 0, totalCoins: 0, error: 'Tag rewards disabled or reward amount is 0' };
    }

    const guildObj = await client.guilds.fetch(guildId).catch(() => null);
    if (!guildObj) {
      sysLog('Tag Rewards Skipped', { guild: guildId, detail: 'Guild not found by client' });
      return { success: false, paidCount: 0, totalCoins: 0, error: 'Guild not accessible' };
    }

    const coinEmoji = COIN_EMOJI.forGuild(guildId);
    sysLog('Tag Rewards Scan Started', { guild: guildId, rewardAmount });

    // Use the in-memory member cache directly.
    // primaryGuild (used for server tag detection below) is populated by gateway
    // presence/join events and does not require a full member list fetch.
    // Calling guildObj.members.fetch() fires Gateway opcode 8 (REQUEST_GUILD_MEMBERS)
    // across all guilds simultaneously, which Discord rate-limits heavily.
    const members = guildObj.members.cache;

    if (!members || members.size === 0) {
      sysLog('Tag Rewards Scan Aborted', { guild: guildId, detail: 'No members retrieved' });
      return { success: false, paidCount: 0, totalCoins: 0, error: 'No members available in cache or fetch' };
    }

    let paidUsersCount = 0;
    const now = new Date();
    const nowIso = now.toISOString();

    for (const [memberId, member] of members) {
      if (!member || member.user?.bot) continue;

      try {
        const primaryGuild = member.user.primaryGuild;

        const hasOfficialTag = primaryGuild && 
                               primaryGuild.identityGuildId === guildId && 
                               primaryGuild.identityEnabled;

        if (!hasOfficialTag) continue;

        // Enforce once-per-day Cairo calendar day limit via transaction history check
        const checkPayout = await query(
          `SELECT 1 FROM transactions 
           WHERE user_id = $1 AND guild_id = $2 AND type = 'tag_reward'
             AND (created_at AT TIME ZONE 'Africa/Cairo')::date = ($3::timestamptz AT TIME ZONE 'Africa/Cairo')::date`,
          [member.id, guildId, nowIso]
        );

        if (checkPayout.rows.length > 0) {
          // Already rewarded today
          continue;
        }

        // Payout the coins
        const result = await updateBalance(member.id, guildId, rewardAmount, 'tag_reward', 'Server Tag Reward');
        if (result?.success) {
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
        `**Server Tag:** \`Active Server Tag\`\n` +
        `**Reward Value:** \`${rewardAmount.toLocaleString()}\` ${coinEmoji} per member\n` +
        `**Members Rewarded:** \`${paidUsersCount.toLocaleString()}\`\n` +
        `**Total Distributed:** \`${(paidUsersCount * rewardAmount).toLocaleString()}\` ${coinEmoji}`
      );
    }

    return {
      success: true,
      paidCount: paidUsersCount,
      totalCoins: paidUsersCount * rewardAmount
    };

  } catch (error) {
    sysError('Tag Rewards Cycle Critical Failure', error, { guild: guildId });
    return { success: false, paidCount: 0, totalCoins: 0, error: error.message };
  }
}
