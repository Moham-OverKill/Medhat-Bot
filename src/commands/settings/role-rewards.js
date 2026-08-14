import {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    RoleSelectMenuBuilder,
    StringSelectMenuBuilder,
    MessageFlags
} from 'discord.js';
import { getGuildConfig, setGuildConfig } from '../../storage/config.js';
import { isValidSnowflake } from '../../shared.js';
import { sendLog, sysError } from '../../utils/logger.js';
import { handleInteractionError, diagnoseRolePermissions } from '../../utils/errors.js';

// ── Rate limiting (mirrors mvp.js pattern) ───────────────────────────────────
const configChangeRateLimit = new Map();
const CONFIG_RATE_LIMIT_MS  = 2000;
const RATE_LIMIT_MAX_AGE_MS = 15 * 60 * 1000;

function checkRateLimit(key) {
    const now = Date.now();
    const last = configChangeRateLimit.get(key);
    if (last && (now - last) < CONFIG_RATE_LIMIT_MS) return false;
    configChangeRateLimit.set(key, now);
    if (configChangeRateLimit.size > 1000) {
        const cutoff = now - RATE_LIMIT_MAX_AGE_MS;
        for (const [k, t] of configChangeRateLimit.entries()) {
            if (t < cutoff) configChangeRateLimit.delete(k);
        }
    }
    return true;
}

// ── Role validation helper ────────────────────────────────────────────────────
async function validateRoleChoice(interaction, roleId, currentModule) {
    const config = await getGuildConfig(interaction.guildId) || {};

    const usedRoles = [];
    if (config.mvpRoleId === roleId) usedRoles.push('MVP');
    if (currentModule !== 'richest' && config.richest_role_id === roleId) usedRoles.push('Richest');
    if (currentModule !== 'streaks' && config.streak_role_id === roleId) usedRoles.push('Streaks');

    if (usedRoles.length > 0) {
        return { ok: false, msg: `❌ This role is already assigned to ${usedRoles.join(', ')}.` };
    }

    const guild = interaction.guild;
    const role  = await guild.roles.fetch(roleId).catch(() => null);
    if (!role) return { ok: false, msg: '❌ Selected role not found.' };
    if (role.id === guild.id) return { ok: false, msg: '❌ Cannot use @everyone as a reward role.' };

    if (role.permissions.has('Administrator') || role.permissions.has('ManageGuild') || role.permissions.has('ManageRoles')) {
        return { ok: false, msg: '❌ Reward role must not have Administrator, Manage Server, or Manage Roles permissions.' };
    }

    const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
    const diag = diagnoseRolePermissions(guild, role, botMember);
    if (!diag.hasAll) {
        return { ok: false, msg: `❌ ${diag.explanation}\n\n**How to fix:**\n${diag.fixInstructions}` };
    }

    return { ok: true, role };
}

// ── Shared panel builder ──────────────────────────────────────────────────────
/**
 * Builds the config embed + components for either Richest or Streaks panels.
 * @param {'richest'|'streaks'} type
 * @param {object} config - guild config object
 */
function buildRoleRewardPanel(type, config) {
    const isRichest = type === 'richest';

    const roleId    = isRichest ? config.richest_role_id    : config.streak_role_id;
    const enabled   = isRichest ? config.richest_role_enabled : config.streak_role_enabled;
    const winners   = isRichest ? config.richest_role_winners : config.streak_role_winners;

    const title         = isRichest ? '💰 Richest Configuration' : '🔥 Streaks Configuration';
    const roleSelectId  = isRichest ? 'role_rewards_richest_role'    : 'role_rewards_streaks_role';
    const winnersId     = isRichest ? 'role_rewards_richest_winners'  : 'role_rewards_streaks_winners';
    const toggleId      = isRichest ? 'role_rewards_richest_toggle'   : 'role_rewards_streaks_toggle';

    const hasRole    = Boolean(roleId);
    const hasWinners = Boolean(winners);
    const canEnable  = hasRole && hasWinners;

    // Color: orange = incomplete, green = enabled, red = disabled
    const color = !canEnable ? 0xFFAA00 : (enabled ? 0x00FF00 : 0xFF0000);

    const statusEmoji = enabled ? '🟢' : '🔴';
    const statusText  = enabled ? 'Auto' : 'Disabled';
    const roleMention = roleId ? `<@&${roleId}>` : '`Not Set`';
    const winnersText = winners ? `${winners} Winner${winners > 1 ? 's' : ''}` : '`Not Set`';

    const embed = new EmbedBuilder()
        .setTitle(title)
        .setColor(color)
        .addFields(
            { name: `${statusEmoji} Status`, value: statusText,  inline: true },
            { name: '👤 Role',               value: roleMention, inline: true },
            { name: '🏅 Winners',            value: winnersText, inline: true }
        );

    if (!canEnable) {
        embed.setDescription('⚠️ Set a Role and Winner Count to enable this reward.');
    }

    const components = [];

    // Row 1: Role selector
    const roleSelect = new RoleSelectMenuBuilder()
        .setCustomId(roleSelectId)
        .setPlaceholder(`Select ${isRichest ? 'Richest' : 'Streaks'} Reward Role`)
        .setMinValues(1)
        .setMaxValues(1);
    if (roleId) roleSelect.setDefaultRoles([roleId]);
    components.push(new ActionRowBuilder().addComponents(roleSelect));

    // Row 2: Winners count selector (1–5)
    const winnersOptions = Array.from({ length: 5 }, (_, i) => {
        const count = i + 1;
        return {
            label: count === 1 ? '1 Winner' : `${count} Winners`,
            value: String(count),
            emoji: '🏆',
            default: winners === count
        };
    });
    const winnersSelect = new StringSelectMenuBuilder()
        .setCustomId(winnersId)
        .setPlaceholder('Select How Many Winners')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(winnersOptions);
    components.push(new ActionRowBuilder().addComponents(winnersSelect));

    // Row 3: Back + Toggle
    components.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('settings_users_roles')
            .setLabel('Back')
            .setEmoji('⬅️')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(toggleId)
            .setLabel(enabled ? 'Disable' : 'Enable')
            .setEmoji(enabled ? '✖️' : '▶️')
            .setStyle(enabled ? ButtonStyle.Danger : ButtonStyle.Success)
            .setDisabled(!canEnable && !enabled)
    ));

    return { embed, components };
}

// ── Public: Roles Sub-Menu ────────────────────────────────────────────────────
/**
 * Renders the /settings → Users → Roles sub-menu.
 * Shows MVP / Richest / Streaks buttons plus a summary of their current state.
 */
export async function showRoleRewardsMenu(interaction) {
    const config = await getGuildConfig(interaction.guildId) || {};

    // Status helpers
    const mvpStatus     = config.enabled          ? '🟢' : '🔴';
    const richestStatus = config.richest_role_enabled ? '🟢' : '🔴';
    const streakStatus  = config.streak_role_enabled  ? '🟢' : '🔴';

    const embed = new EmbedBuilder()
        .setTitle('🎭 Role Rewards')
        .setDescription(
            `Configure automated roles awarded to top members each hour.\n\n` +
            `${mvpStatus} **MVP** — Daily activity champions\n` +
            `${richestStatus} **Richest** — Top coin holders\n` +
            `${streakStatus} **Streaks** — Longest daily streaks`
        )
        .setColor(0x5865F2);

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('role_rewards_mvp')
            .setLabel('MVP')
            .setEmoji('⭐')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('role_rewards_richest')
            .setLabel('Richest')
            .setEmoji('💰')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('role_rewards_streaks')
            .setLabel('Streaks')
            .setEmoji('🔥')
            .setStyle(ButtonStyle.Secondary)
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('settings_users')
            .setLabel('Back')
            .setEmoji('⬅️')
            .setStyle(ButtonStyle.Secondary)
    );

    const responseMethod = (interaction.deferred || interaction.replied)
        ? 'editReply'
        : (interaction.isButton() || interaction.isAnySelectMenu() ? 'update' : 'editReply');

    await interaction[responseMethod]({
        embeds: [embed],
        components: [row1, row2]
    });
}

/**
 * Renders the Richest configuration panel.
 */
export async function showRichestConfig(interaction) {
    const config = await getGuildConfig(interaction.guildId) || {};
    const { embed, components } = buildRoleRewardPanel('richest', config);

    const method = (interaction.deferred || interaction.replied)
        ? 'editReply'
        : (interaction.isButton() || interaction.isAnySelectMenu() ? 'update' : 'editReply');

    await interaction[method]({ embeds: [embed], components });
}

/**
 * Renders the Streaks configuration panel.
 */
export async function showStreaksConfig(interaction) {
    const config = await getGuildConfig(interaction.guildId) || {};
    const { embed, components } = buildRoleRewardPanel('streaks', config);

    const method = (interaction.deferred || interaction.replied)
        ? 'editReply'
        : (interaction.isButton() || interaction.isAnySelectMenu() ? 'update' : 'editReply');

    await interaction[method]({ embeds: [embed], components });
}

// ── Public: Component Router ─────────────────────────────────────────────────
export async function handleRoleRewardsComponent(interaction) {
    try {
        if (!interaction.member?.permissions.has('Administrator')) {
            const deny = { content: '⛔ Administrator permission required.', flags: MessageFlags.Ephemeral };
            return interaction.deferred || interaction.replied
                ? interaction.followUp(deny)
                : interaction.reply(deny);
        }

        const customId = interaction.customId;
        const guildId  = interaction.guildId;

        // ── Navigation ───────────────────────────────────────────────────────
        if (customId === 'role_rewards_mvp') {
            // Open the exact same MVP config panel as before (from mvp.js)
            const { showSetupPanel } = await import('../mvp.js');
            const config = await getGuildConfig(guildId) || {};
            await showSetupPanel(interaction, config);
            return;
        }

        if (customId === 'role_rewards_richest') {
            await showRichestConfig(interaction);
            return;
        }

        if (customId === 'role_rewards_streaks') {
            await showStreaksConfig(interaction);
            return;
        }

        // ── Richest: Role Select ─────────────────────────────────────────────
        if (customId === 'role_rewards_richest_role') {
            const selectedRoleId = interaction.values[0];
            if (!isValidSnowflake(selectedRoleId)) {
                return interaction.reply({ content: '❌ Invalid role selection.', flags: MessageFlags.Ephemeral });
            }
            if (!checkRateLimit(`${guildId}-richest-config`)) {
                return interaction.reply({ content: '⚠️ Please wait a moment before changing settings again.', flags: MessageFlags.Ephemeral });
            }

            const { ok, msg, role } = await validateRoleChoice(interaction, selectedRoleId, 'richest');
            if (!ok) return interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });

            const config = await getGuildConfig(guildId) || {};
            config.richest_role_id = selectedRoleId;
            await setGuildConfig(guildId, config);

            sendLog(interaction.guild, 'audit', 'cyan', '⚙️ Richest Role Updated',
                `**Admin:** \`${interaction.user.tag}\`\n**Role:** ${role}`);

            await showRichestConfig(interaction);
            return;
        }

        // ── Richest: Winners Select ──────────────────────────────────────────
        if (customId === 'role_rewards_richest_winners') {
            const count = parseInt(interaction.values[0], 10);
            if (isNaN(count) || count < 1 || count > 5) {
                return interaction.update({ content: '❌ Invalid winner count.', embeds: [], components: [] });
            }
            if (!checkRateLimit(`${guildId}-richest-config`)) {
                return interaction.update({ content: '⚠️ Please wait a moment before changing settings again.', embeds: [], components: [] });
            }

            const config = await getGuildConfig(guildId) || {};
            config.richest_role_winners = count;
            await setGuildConfig(guildId, config);

            sendLog(interaction.guild, 'audit', 'cyan', '⚙️ Richest Winner Count Updated',
                `**Admin:** \`${interaction.user.tag}\`\n**Winners:** ${count}`);

            await showRichestConfig(interaction);
            return;
        }

        // ── Richest: Toggle ──────────────────────────────────────────────────
        if (customId === 'role_rewards_richest_toggle') {
            const config = await getGuildConfig(guildId) || {};
            const newState = !config.richest_role_enabled;

            if (newState && (!config.richest_role_id || !config.richest_role_winners)) {
                return interaction.reply({
                    content: '❌ Set a Role and Winner Count first.',
                    flags: MessageFlags.Ephemeral
                });
            }

            config.richest_role_enabled = newState;
            await setGuildConfig(guildId, config);

            sendLog(interaction.guild, 'audit', newState ? 'cyan' : 'crimson', '💰 Richest Role Reward',
                `**Admin:** \`${interaction.user.tag}\`\n**Status:** ${newState ? 'Enabled' : 'Disabled'}`);

            await showRichestConfig(interaction);
            return;
        }

        // ── Streaks: Role Select ─────────────────────────────────────────────
        if (customId === 'role_rewards_streaks_role') {
            const selectedRoleId = interaction.values[0];
            if (!isValidSnowflake(selectedRoleId)) {
                return interaction.reply({ content: '❌ Invalid role selection.', flags: MessageFlags.Ephemeral });
            }
            if (!checkRateLimit(`${guildId}-streaks-config`)) {
                return interaction.reply({ content: '⚠️ Please wait a moment before changing settings again.', flags: MessageFlags.Ephemeral });
            }

            const { ok, msg, role } = await validateRoleChoice(interaction, selectedRoleId, 'streaks');
            if (!ok) return interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });

            const config = await getGuildConfig(guildId) || {};
            config.streak_role_id = selectedRoleId;
            await setGuildConfig(guildId, config);

            sendLog(interaction.guild, 'audit', 'cyan', '⚙️ Streaks Role Updated',
                `**Admin:** \`${interaction.user.tag}\`\n**Role:** ${role}`);

            await showStreaksConfig(interaction);
            return;
        }

        // ── Streaks: Winners Select ──────────────────────────────────────────
        if (customId === 'role_rewards_streaks_winners') {
            const count = parseInt(interaction.values[0], 10);
            if (isNaN(count) || count < 1 || count > 5) {
                return interaction.update({ content: '❌ Invalid winner count.', embeds: [], components: [] });
            }
            if (!checkRateLimit(`${guildId}-streaks-config`)) {
                return interaction.update({ content: '⚠️ Please wait a moment before changing settings again.', embeds: [], components: [] });
            }

            const config = await getGuildConfig(guildId) || {};
            config.streak_role_winners = count;
            await setGuildConfig(guildId, config);

            sendLog(interaction.guild, 'audit', 'cyan', '⚙️ Streaks Winner Count Updated',
                `**Admin:** \`${interaction.user.tag}\`\n**Winners:** ${count}`);

            await showStreaksConfig(interaction);
            return;
        }

        // ── Streaks: Toggle ──────────────────────────────────────────────────
        if (customId === 'role_rewards_streaks_toggle') {
            const config = await getGuildConfig(guildId) || {};
            const newState = !config.streak_role_enabled;

            if (newState && (!config.streak_role_id || !config.streak_role_winners)) {
                return interaction.reply({
                    content: '❌ Set a Role and Winner Count first.',
                    flags: MessageFlags.Ephemeral
                });
            }

            config.streak_role_enabled = newState;
            await setGuildConfig(guildId, config);

            sendLog(interaction.guild, 'audit', newState ? 'cyan' : 'crimson', '🔥 Streaks Role Reward',
                `**Admin:** \`${interaction.user.tag}\`\n**Status:** ${newState ? 'Enabled' : 'Disabled'}`);

            await showStreaksConfig(interaction);
            return;
        }

    } catch (error) {
        await handleInteractionError(interaction, error, 'Role Rewards component router');
    }
}
