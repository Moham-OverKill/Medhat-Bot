import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { getPool } from '../../storage/postgres.js';
import { getGuildConfig } from '../../storage/config.js';
import { COIN_EMOJI } from '../../shared.js';
import { sysLog } from '../../utils/logger.js';

export async function handleEconomySettings(interaction) {
    // Prevent "interaction failed" on slow SQL queries by deferring the button update immediately
    if (interaction.isButton() && !interaction.deferred && !interaction.replied) {
        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    }

    const customId = interaction.customId;

    let view = 'day';
    if (customId === 'eco_week') view = 'week';
    if (customId === 'eco_month') view = 'month';
    if (customId === 'eco_prices') view = 'prices';

    await showEconomyDashboard(interaction, view);
}

async function showEconomyDashboard(interaction, view) {
    const guildId = interaction.guildId;
    const guildName = interaction.guild?.name || 'Unknown Server';
    const userName = interaction.user.displayName || interaction.user.username;
    const userTag = interaction.user.username;
    
    sysLog('Economy Dashboard Opened', { user: interaction.user.id, guild: guildId, detail: `View: ${view}` });
    
    const pool = getPool();

    // 1. Total Server Wealth (always same regardless of view)
    const wealthRes = await pool.query(
        `SELECT COALESCE(SUM(balance), 0) as total FROM user_balances WHERE guild_id = $1`,
        [guildId]
    );
    const totalWealth = parseInt(wealthRes.rows[0]?.total || 0, 10);

    // 2. Active User count (has balance > 0)
    const activeRes = await pool.query(
        `SELECT COUNT(*) as count FROM user_balances WHERE guild_id = $1 AND balance > 0`,
        [guildId]
    );
    const activeUsers = parseInt(activeRes.rows[0]?.count || 0, 10);
    const avgWealth = activeUsers > 0 ? Math.floor(totalWealth / activeUsers) : 0;

    const embed = new EmbedBuilder()
        .setColor(0x2ECC71) // Green
        .setTitle('📊 Economy Dashboard');

    if (view === 'prices') {
        // --- SMART PRICING VIEW ---
        const config = await getGuildConfig(guildId) || {};
        
        // Settings Variables - Synced with Rewards Dashboard
        const streakBonus = config.daily_streak_bonus !== undefined ? parseInt(config.daily_streak_bonus, 10) : 5;
        const mvpReward = config.mvpRewardAmount !== undefined ? parseInt(config.mvpRewardAmount, 10) : 100;
        const boosterMult = config.booster_multiplier !== undefined ? parseFloat(config.booster_multiplier) : 2.0;
        const streakCap = config.daily_streak_cap !== undefined ? parseInt(config.daily_streak_cap, 10) : 30;
        const baseDaily = config.daily_base_reward !== undefined ? parseInt(config.daily_base_reward, 10) : 25;
        const tagReward = config.tag_reward_amount !== undefined ? parseInt(config.tag_reward_amount, 10) : 0;
        const voteReward = config.vote_reward_amount !== undefined ? parseInt(config.vote_reward_amount, 10) : 100;

        // Fetch Quest Configuration
        const questRefreshes = config.quests_refreshes_per_day || 1;
        const questsPerRefresh = config.quests_per_refresh || 1;
        const totalQuestsPerDay = questRefreshes * questsPerRefresh;

        // Fetch Average Quest Reward (from current active pool)
        const questRes = await pool.query(`SELECT COALESCE(AVG(reward_coins), 0) as avg FROM quests WHERE guild_id = $1`, [guildId]);
        const avgQuest = parseInt(questRes.rows[0]?.avg || 0, 10) || 50; // Fallback to 50 if zero quests

        // 1. Lazy User (Base Daily Only)
        const lazyIncome = baseDaily;

        // 2. Casual User (Base Daily + ALL configured quests + Tag Reward + 1x Vote Reward)
        const casualIncome = baseDaily + (avgQuest * totalQuestsPerDay) + tagReward + voteReward;

        // 3. Grinder User (Max Daily w/ Booster + ALL configured quests + Tag Reward + 2x Vote Reward + Weekly MVP share)
        const grinderDailyMax = baseDaily + (streakBonus * streakCap);
        const grinderDailyBoosted = Math.floor(grinderDailyMax * boosterMult);
        const grinderIncome = grinderDailyBoosted + (avgQuest * totalQuestsPerDay) + tagReward + (voteReward * 2) + Math.floor(mvpReward / 7);

        embed.addFields(
            {
                name: '💰 Reward Configuration',
                value: `• **Daily Base:** ${baseDaily} ${COIN_EMOJI}\n• **Streak Bonus:** +${streakBonus} ${COIN_EMOJI}/day\n• **Boost Bonus:** ${boosterMult}x\n• **Quests:** ${avgQuest * totalQuestsPerDay} ${COIN_EMOJI}/day\n• **Tag Reward:** ${tagReward} ${COIN_EMOJI}/day\n• **Vote Reward:** ${voteReward} ${COIN_EMOJI}/vote\n• **MVP Prize:** ${mvpReward} ${COIN_EMOJI}/hour`,
                inline: false
            },
            {
                name: '📈 Estimated Daily Income',
                value: `🔹 **Lazy User:** ${lazyIncome.toLocaleString()} ${COIN_EMOJI} / day\n💠 **Casual User:** ${casualIncome.toLocaleString()} ${COIN_EMOJI} / day\n♦️ **Grinder User:** ${grinderIncome.toLocaleString()} ${COIN_EMOJI} / day`,
                inline: false
            },
            {
                name: '📦 Common Items (2 Days Work)',
                value: `🔹 **Lazy User:** ${(lazyIncome * 2).toLocaleString()} ${COIN_EMOJI}\n💠 **Casual User:** ${(casualIncome * 2).toLocaleString()} ${COIN_EMOJI}\n♦️ **Grinder User:** ${(grinderIncome * 2).toLocaleString()} ${COIN_EMOJI}`,
                inline: false
            },
            {
                name: '✨ Rare Items (1 Week Work)',
                value: `🔹 **Lazy User:** ${(lazyIncome * 7).toLocaleString()} ${COIN_EMOJI}\n💠 **Casual User:** ${(casualIncome * 7).toLocaleString()} ${COIN_EMOJI}\n♦️ **Grinder User:** ${(grinderIncome * 7).toLocaleString()} ${COIN_EMOJI}`,
                inline: false
            },
            {
                name: '👑 Legendary Items (1 Month Work)',
                value: `🔹 **Lazy User:** ${(lazyIncome * 30).toLocaleString()} ${COIN_EMOJI}\n💠 **Casual User:** ${(casualIncome * 30).toLocaleString()} ${COIN_EMOJI}\n♦️ **Grinder User:** ${(grinderIncome * 30).toLocaleString()} ${COIN_EMOJI}`,
                inline: false
            }
        );

    } else {
        // --- ANALYTICS VIEW ---
        let intervals = {
            'day': '1 day',
            'week': '7 days',
            'month': '30 days'
        };
        const intervalStr = intervals[view];

        // Fetch earnings per user type
        const earningsRes = await pool.query(`
            SELECT user_id, SUM(amount) as earned 
            FROM transactions 
            WHERE guild_id = $1 
              AND amount > 0 
              AND type IN ('mvp_reward', 'mvp_bonus', 'daily', 'quest_reward', 'mission_reward', 'admin_grant', 'admin_adjust', 'tag_reward', 'vote_reward')
              AND created_at >= NOW() - INTERVAL '${intervalStr}'
            GROUP BY user_id
            ORDER BY earned DESC
        `, [guildId]);

        let totalPrinted = 0;
        const userEarnings = earningsRes.rows.map(r => parseInt(r.earned, 10));
        for (const amt of userEarnings) {
            totalPrinted += amt;
        }

        const numUsers = userEarnings.length;
        const top1Count = Math.max(1, Math.floor(numUsers * 0.01));
        
        // Averages
        let top1Avg = 0;
        let normalAvg = 0;

        if (numUsers > 0) {
            const top1Earnings = userEarnings.slice(0, top1Count).reduce((a, b) => a + b, 0);
            const normalEarnings = userEarnings.slice(top1Count).reduce((a, b) => a + b, 0);
            
            top1Avg = Math.floor(top1Earnings / top1Count);
            if (numUsers > top1Count) {
                normalAvg = Math.floor(normalEarnings / (numUsers - top1Count));
            } else {
                normalAvg = top1Avg; // Everyone is top 1% if there's only 1 user
            }
        }

        // Fetch breakdown by type
        const breakdownRes = await pool.query(`
            SELECT type, SUM(amount) as total 
            FROM transactions 
            WHERE guild_id = $1 
              AND amount > 0 
              AND type IN ('mvp_reward', 'mvp_bonus', 'daily', 'quest_reward', 'mission_reward', 'admin_grant', 'admin_adjust', 'tag_reward', 'vote_reward')
              AND created_at >= NOW() - INTERVAL '${intervalStr}'
            GROUP BY type
            ORDER BY total DESC
        `, [guildId]);

        const typesToDisplay = [
            { id: 'mvp_reward', aliases: ['mvp_bonus'], label: 'MVP Rewards' },
            { id: 'daily', aliases: [], label: 'Daily Claims' },
            { id: 'quest_reward', aliases: ['mission_reward'], label: 'Quest Rewards' },
            { id: 'tag_reward', aliases: [], label: 'Tag Rewards' },
            { id: 'vote_reward', aliases: [], label: 'Vote Rewards' },
            { id: 'admin_grant', aliases: ['admin_adjust'], label: 'Admin Grants' }
        ];

        const rawTotals = {};
        for (const row of breakdownRes.rows) {
            rawTotals[row.type] = parseInt(row.total, 10);
        }

        // Aggregate aliases (e.g. mission_reward + quest_reward)
        const aggregatedTotals = {};
        for (const t of typesToDisplay) {
            let sum = rawTotals[t.id] || 0;
            for (const alias of t.aliases) {
                sum += rawTotals[alias] || 0;
            }
            aggregatedTotals[t.id] = sum;
        }

        let breakdownStr = '';
        for (const t of typesToDisplay) {
            const amt = aggregatedTotals[t.id] || 0;
            const percent = totalPrinted > 0 ? Math.round((amt / totalPrinted) * 100) : 0;
            breakdownStr += `• **${t.label}**: ${amt.toLocaleString()} ${COIN_EMOJI} (${percent}%)\n`;
        }


        const periodLabel = view === 'day' ? 'Daily' : view === 'week' ? 'Weekly' : 'Monthly';

        embed.addFields(
            {
                name: `💰 Total Server Wealth: ${totalWealth.toLocaleString()} ${COIN_EMOJI}`,
                value: `Average Balance: **${avgWealth.toLocaleString()}** ${COIN_EMOJI}`,
                inline: false
            },
            {
                name: `🖨️ ${periodLabel} Print Overview`,
                value: `Total Coins Added: **+${totalPrinted.toLocaleString()}** ${COIN_EMOJI}`,
                inline: false
            },
            {
                name: '👥 Average Earnings per User',
                value: `• **Top 1% Grinders**: ${top1Avg.toLocaleString()} ${COIN_EMOJI}\n• **Normal Users**: ${normalAvg.toLocaleString()} ${COIN_EMOJI}`,
                inline: false
            },
            {
                name: '📊 Source Breakdown',
                value: breakdownStr,
                inline: false
            }
        );
    }

    const navRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('settings_other')
            .setLabel('Back')
            .setEmoji('⬅️')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('eco_prices')
            .setLabel('Prices')
            .setEmoji('🏷️')
            .setStyle(view === 'prices' ? ButtonStyle.Primary : ButtonStyle.Secondary)
    );

    const timeRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('eco_day')
            .setLabel('Per Day')
            .setStyle(view === 'day' ? ButtonStyle.Primary : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('eco_week')
            .setLabel('Per Week')
            .setStyle(view === 'week' ? ButtonStyle.Primary : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('eco_month')
            .setLabel('Per Month')
            .setStyle(view === 'month' ? ButtonStyle.Primary : ButtonStyle.Secondary)
    );

    // Display the timeframe buttons on top, and navigation on the bottom
    const responseMethod = (interaction.deferred || interaction.replied) ? 'editReply' : 'update';
    await interaction[responseMethod]({
        embeds: [embed],
        components: [timeRow, navRow]
    });
}
