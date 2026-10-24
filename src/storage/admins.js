/**
 * Bot Administrator Access Control — Strict Multi-Tenant Security Module
 * Implements Zero-Trust verification:
 * 1. Server Owner always has permanent bypass.
 * 2. Whitelisted bot admins in server_admins table have access for their specific guild.
 * 3. Discord Administrator permissions or roles grant ZERO access.
 * 4. Real-time revocation check on every interaction.
 */
import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { getPool, isDatabaseReady } from './postgres.js';
import { sysError, sysLog } from '../utils/logger.js';
import { hasAnyDangerousPermission } from '../shared.js';

/**
 * Fetch all authorized bot admin roles for a specific guild.
 *
 * @param {string} guildId
 * @returns {Promise<Array<{ role_id: string, added_at: string }>>}
 */
export async function getServerAdminRoles(guildId) {
  if (!guildId) return [];
  if (!isDatabaseReady()) return [];
  try {
    const pool = getPool();
    const res = await pool.query(
      'SELECT role_id, added_at FROM server_admin_roles WHERE guild_id = $1 ORDER BY added_at ASC',
      [guildId]
    );
    return res.rows;
  } catch (err) {
    sysError('Database error fetching server_admin_roles', err, { guildId });
    return [];
  }
}

/**
 * Check if a role is designated as a bot admin role for a guild.
 *
 * @param {string} guildId
 * @param {string} roleId
 * @returns {Promise<boolean>}
 */
export async function isServerAdminRole(guildId, roleId) {
  if (!guildId || !roleId) return false;
  if (!isDatabaseReady()) return false;
  try {
    const pool = getPool();
    const res = await pool.query(
      'SELECT 1 FROM server_admin_roles WHERE guild_id = $1 AND role_id = $2 LIMIT 1',
      [guildId, roleId]
    );
    return res.rows.length > 0;
  } catch (err) {
    sysError('Database error querying server_admin_roles', err, { guildId, roleId });
    return false;
  }
}

/**
 * Check if an array of role IDs contains any designated bot admin role for a guild.
 *
 * @param {string} guildId
 * @param {string[]} roleIds
 * @returns {Promise<boolean>}
 */
export async function hasAdminRole(guildId, roleIds) {
  if (!guildId || !Array.isArray(roleIds) || roleIds.length === 0) return false;
  if (!isDatabaseReady()) return false;
  try {
    const pool = getPool();
    const res = await pool.query(
      'SELECT 1 FROM server_admin_roles WHERE guild_id = $1 AND role_id = ANY($2::text[]) LIMIT 1',
      [guildId, roleIds]
    );
    return res.rows.length > 0;
  } catch (err) {
    sysError('Database error checking hasAdminRole', err, { guildId });
    return false;
  }
}

/**
 * Toggle a role's admin status in the server_admin_roles table.
 * If already an admin role, removes it. If not an admin role, adds it.
 *
 * @param {string} guildId
 * @param {string} roleId
 * @returns {Promise<{ action: 'added' | 'removed', roleId: string }>}
 */
export async function toggleServerAdminRole(guildId, roleId) {
  if (!guildId || !roleId) throw new Error('Missing guildId or roleId');
  const pool = getPool();

  const checkRes = await pool.query(
    'SELECT 1 FROM server_admin_roles WHERE guild_id = $1 AND role_id = $2',
    [guildId, roleId]
  );

  if (checkRes.rows.length > 0) {
    await pool.query(
      'DELETE FROM server_admin_roles WHERE guild_id = $1 AND role_id = $2',
      [guildId, roleId]
    );
    return { action: 'removed', roleId };
  } else {
    await pool.query(
      'INSERT INTO server_admin_roles (guild_id, role_id) VALUES ($1, $2) ON CONFLICT (guild_id, role_id) DO NOTHING',
      [guildId, roleId]
    );
    return { action: 'added', roleId };
  }
}

/**
 * Purge a role from the server_admin_roles table (e.g. when deleted from the server).
 *
 * @param {string} guildId
 * @param {string} roleId
 * @returns {Promise<boolean>}
 */
export async function removeServerAdminRole(guildId, roleId) {
  if (!guildId || !roleId) return false;
  try {
    const pool = getPool();
    const res = await pool.query(
      'DELETE FROM server_admin_roles WHERE guild_id = $1 AND role_id = $2 RETURNING role_id',
      [guildId, roleId]
    );
    if (res.rowCount > 0) {
      sysLog('Bot Admin Role Purged', { guild: guildId, role: roleId });
      return true;
    }
    return false;
  } catch (err) {
    sysError('Failed to remove server admin role', err, { guildId, roleId });
    return false;
  }
}

/**
 * Audit sweep to prune any deleted roles from server_admin_roles.
 *
 * @param {import('discord.js').Client} client
 */
export async function auditAndPruneDepartedAdminRoles(client) {
  if (!client?.guilds?.cache) return;
  try {
    const pool = getPool();
    const res = await pool.query('SELECT guild_id, role_id FROM server_admin_roles');
    if (res.rows.length === 0) return;

    let purgedCount = 0;
    for (const row of res.rows) {
      const guild = client.guilds.cache.get(row.guild_id) || await client.guilds.fetch(row.guild_id).catch(() => null);
      if (!guild) continue;

      const role = guild.roles.cache.get(row.role_id) || await guild.roles.fetch(row.role_id).catch(() => null);
      if (!role) {
        await removeServerAdminRole(row.guild_id, row.role_id);
        purgedCount++;
      }
    }
    if (purgedCount > 0) {
      sysLog('Ghost Admin Roles Purged in Audit', { count: purgedCount });
    }
  } catch (err) {
    sysError('Failed to audit departed admin roles', err);
  }
}

/**
 * Centralized Conflict Validator for Mutual Role Exclusion:
 * Enforces: Item Role != Top Reward Role != Admin Role
 *
 * @param {import('discord.js').Guild} guild
 * @param {string|import('discord.js').Role} roleOrId
 * @param {'ADMIN_ROLE'|'ITEM_ROLE'|'REWARD_ROLE'} targetCategory
 * @param {object} [options]
 * @param {string} [options.excludeItemId] - Item ID to exclude when swapping roles on existing items
 * @param {string} [options.currentModule] - Module name for reward role checks ('richest', 'streaks', 'mvp')
 * @returns {Promise<{ valid: boolean, error?: string, role?: import('discord.js').Role }>}
 */
export async function validateRoleConflict(guild, roleOrId, targetCategory, options = {}) {
  if (!guild) return { valid: false, error: 'Guild context missing.' };
  const roleId = typeof roleOrId === 'object' && roleOrId?.id ? roleOrId.id : String(roleOrId);
  const role = typeof roleOrId === 'object' && roleOrId?.name
    ? roleOrId
    : (guild.roles?.cache?.get(roleId) || await guild.roles?.fetch(roleId).catch(() => null));

  if (!role) {
    return { valid: false, error: 'Selected role was not found in this server.' };
  }

  // Common: Block @everyone
  if (role.id === guild.id) {
    return { valid: false, error: 'Cannot use @everyone.' };
  }

  // Common: Block managed/bot integration roles for Admin and Reward roles
  if ((targetCategory === 'ADMIN_ROLE' || targetCategory === 'REWARD_ROLE') && role.managed) {
    return { valid: false, error: 'Managed or integration roles cannot be used.' };
  }

  const pool = getPool();
  const { getGuildConfig } = await import('./config.js');
  const config = await getGuildConfig(guild.id) || {};

  if (targetCategory === 'ADMIN_ROLE') {
    // 1. Check if connected to any active shop item
    const itemRes = await pool.query(
      'SELECT name FROM shop_items WHERE guild_id = $1 AND role_id = $2 AND is_active = true LIMIT 1',
      [guild.id, role.id]
    );
    if (itemRes.rows.length > 0) {
      return { valid: false, error: `This role is linked to the shop item "${itemRes.rows[0].name}" and cannot be an administrator role.` };
    }

    // 2. Check if connected to color roles
    const colorRes = await pool.query(
      'SELECT 1 FROM colors WHERE guild_id = $1 AND role_id = $2 UNION SELECT 1 FROM booster_colors WHERE guild_id = $1 AND role_id = $2 LIMIT 1',
      [guild.id, role.id]
    );
    if (colorRes.rows.length > 0) {
      return { valid: false, error: 'This role is configured as a color role and cannot be an administrator role.' };
    }

    // 3. Check if Booster role
    if (guild.roles.premiumSubscriberRole?.id === role.id) {
      return { valid: false, error: 'Server Booster role cannot be an administrator role.' };
    }
    const boosterRes = await pool.query(
      'SELECT 1 FROM booster_roles WHERE guild_id = $1 AND role_id = $2 LIMIT 1',
      [guild.id, role.id]
    );
    if (boosterRes.rows.length > 0) {
      return { valid: false, error: 'This role is configured as a Booster role and cannot be an administrator role.' };
    }

    // 4. Check if MVP role or Top X role
    if (config.mvpRoleId === role.id) {
      return { valid: false, error: 'MVP role cannot be an administrator role.' };
    }
    if (config.richest_role_id === role.id) {
      return { valid: false, error: 'Top Richest reward role cannot be an administrator role.' };
    }
    if (config.streak_role_id === role.id) {
      return { valid: false, error: 'Top Streak reward role cannot be an administrator role.' };
    }
  }

  if (targetCategory === 'ITEM_ROLE') {
    // 1. Check dangerous permissions
    if (hasAnyDangerousPermission(role)) {
      return { valid: false, error: 'Security Violation: This role holds administrative or moderation permissions and cannot be added to the shop.' };
    }

    // 2. Check if Admin Role
    const adminRoleRes = await pool.query(
      'SELECT 1 FROM server_admin_roles WHERE guild_id = $1 AND role_id = $2 LIMIT 1',
      [guild.id, role.id]
    );
    if (adminRoleRes.rows.length > 0) {
      return { valid: false, error: 'Security Violation: This role is an authorized Bot Admin Role and cannot be linked to a shop item.' };
    }

    // 3. Check if MVP role
    if (config.mvpRoleId === role.id) {
      return { valid: false, error: "MVP Role can't be a shop item. Use Requirements to gate items behind MVP status." };
    }

    // 4. Check if Top X / Leaderboard role
    if (config.richest_role_id === role.id) {
      return { valid: false, error: "Top Richest reward role can't be a shop item." };
    }
    if (config.streak_role_id === role.id) {
      return { valid: false, error: "Top Streak reward role can't be a shop item." };
    }

    // 5. Check if Booster role
    if (guild.roles.premiumSubscriberRole?.id === role.id) {
      return { valid: false, error: "Server Booster Role can't be a shop item." };
    }
    const boosterRes = await pool.query(
      'SELECT 1 FROM booster_roles WHERE guild_id = $1 AND role_id = $2 LIMIT 1',
      [guild.id, role.id]
    );
    if (boosterRes.rows.length > 0) {
      return { valid: false, error: "Booster Role can't be a shop item." };
    }
  }

  if (targetCategory === 'REWARD_ROLE') {
    const currentModule = options.currentModule;

    // 1. Check dangerous permissions
    if (hasAnyDangerousPermission(role)) {
      return { valid: false, error: 'Reward role must not possess any administrative or moderation permissions.' };
    }

    // 2. Check if Admin Role
    const adminRoleRes = await pool.query(
      'SELECT 1 FROM server_admin_roles WHERE guild_id = $1 AND role_id = $2 LIMIT 1',
      [guild.id, role.id]
    );
    if (adminRoleRes.rows.length > 0) {
      return { valid: false, error: 'Security Violation: This role is an authorized Bot Admin Role and cannot be used as a reward role.' };
    }

    // 3. Check if connected to active shop item
    const itemRes = await pool.query(
      'SELECT name FROM shop_items WHERE guild_id = $1 AND role_id = $2 AND is_active = true LIMIT 1',
      [guild.id, role.id]
    );
    if (itemRes.rows.length > 0) {
      return { valid: false, error: `This role is linked to the shop item "${itemRes.rows[0].name}" and cannot be used as a reward role.` };
    }

    // 4. Check if already used by another reward module
    const usedRoles = [];
    if (currentModule !== 'mvp' && config.mvpRoleId === role.id) usedRoles.push('MVP');
    if (currentModule !== 'richest' && config.richest_role_id === role.id) usedRoles.push('Richest');
    if (currentModule !== 'streaks' && config.streak_role_id === role.id) usedRoles.push('Streaks');
    if (usedRoles.length > 0) {
      return { valid: false, error: `This role is already assigned to ${usedRoles.join(', ')}.` };
    }
  }

  return { valid: true, role };
}

/**
 * Check if a user is an authorized bot administrator for a guild.
 * Strictly partitioned by guild_id and user_id.
 *
 * @param {string} guildId
 * @param {string} userId
 * @param {string|null} [ownerId]
 * @returns {Promise<boolean>}
 */
export async function isServerAdmin(guildId, userId, ownerId = null) {
  if (!guildId || !userId || guildId === 'null' || guildId === 'undefined' || userId === 'null' || userId === 'undefined') return false;
  if (ownerId && userId === ownerId) return true;
  if (!isDatabaseReady()) return false;

  try {
    const pool = getPool();
    const res = await pool.query(
      'SELECT 1 FROM server_admins WHERE guild_id = $1 AND user_id = $2 LIMIT 1',
      [guildId, userId]
    );
    return res.rows.length > 0;
  } catch (err) {
    sysError('Database error querying server_admins', err, { guildId, userId });
    return false;
  }
}

/**
 * Fetch all authorized bot admins for a specific guild.
 *
 * @param {string} guildId
 * @returns {Promise<Array<{ user_id: string, added_at: string }>>}
 */
export async function getServerAdmins(guildId) {
  if (!guildId) return [];
  try {
    const pool = getPool();
    const res = await pool.query(
      'SELECT user_id, added_at FROM server_admins WHERE guild_id = $1 ORDER BY added_at ASC',
      [guildId]
    );
    return res.rows;
  } catch (err) {
    sysError('Database error fetching server_admins', err, { guildId });
    return [];
  }
}

/**
 * Toggle a user's admin status in the server_admins table.
 * If already an admin, removes them. If not an admin, adds them.
 *
 * @param {string} guildId
 * @param {string} userId
 * @returns {Promise<{ action: 'added' | 'removed', userId: string }>}
 */
export async function toggleServerAdmin(guildId, userId) {
  if (!guildId || !userId) throw new Error('Missing guildId or userId');
  const pool = getPool();

  const checkRes = await pool.query(
    'SELECT 1 FROM server_admins WHERE guild_id = $1 AND user_id = $2',
    [guildId, userId]
  );

  if (checkRes.rows.length > 0) {
    await pool.query(
      'DELETE FROM server_admins WHERE guild_id = $1 AND user_id = $2',
      [guildId, userId]
    );
    return { action: 'removed', userId };
  } else {
    await pool.query(
      'INSERT INTO server_admins (guild_id, user_id) VALUES ($1, $2) ON CONFLICT (guild_id, user_id) DO NOTHING',
      [guildId, userId]
    );
    return { action: 'added', userId };
  }
}

/**
 * Purge a user from the server_admins table (e.g. when leaving the server).
 *
 * @param {string} guildId
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
export async function removeServerAdmin(guildId, userId) {
  if (!guildId || !userId) return false;
  try {
    const pool = getPool();
    const res = await pool.query(
      'DELETE FROM server_admins WHERE guild_id = $1 AND user_id = $2 RETURNING user_id',
      [guildId, userId]
    );
    if (res.rowCount > 0) {
      sysLog('Bot Admin Purged on Leave', { guild: guildId, user: userId });
      return true;
    }
    return false;
  } catch (err) {
    sysError('Failed to remove server admin on leave', err, { guildId, userId });
    return false;
  }
}

/**
 * Audit sweep to prune any departed members from server_admins
 * that might have left while the bot was offline.
 *
 * @param {import('discord.js').Client} client
 */
export async function auditAndPruneDepartedAdmins(client) {
  if (!client?.guilds?.cache) return;
  try {
    const pool = getPool();
    const res = await pool.query('SELECT guild_id, user_id FROM server_admins');
    if (res.rows.length === 0) return;

    let purgedCount = 0;
    for (const row of res.rows) {
      const guild = client.guilds.cache.get(row.guild_id) || await client.guilds.fetch(row.guild_id).catch(() => null);
      if (!guild) continue;

      let member = guild.members.cache.get(row.user_id);
      if (!member) {
        member = await guild.members.fetch(row.user_id).catch(() => null);
      }
      if (!member) {
        await removeServerAdmin(row.guild_id, row.user_id);
        purgedCount++;
      }
    }
    if (purgedCount > 0) {
      sysLog('Departed Admins Purged in Audit', { count: purgedCount });
    }
  } catch (err) {
    sysError('Failed to audit departed admins', err);
  }
}

/**
 * Mandatory Zero-Trust Security Pre-Check
 * Validates whether the interacting user has administrative clearance.
 *
 * Checks:
 * 1. Server Owner: Always allowed (permanent bypass).
 * 2. Whitelisted Bot Admin: Real-time query to server_admins (guild-isolated).
 *
 * If unauthorized:
 * Sends an immediate hard denial ephemeral error and returns false.
 *
 * @param {import('discord.js').Interaction} interaction
 * @returns {Promise<boolean>} true if allowed, false if hard-denied
 */
export async function verifyAdminAccess(interaction) {
  const guildId = interaction.guildId;
  const userId = interaction.user?.id;

  if (!guildId || !userId || guildId === 'null' || guildId === 'undefined' || userId === 'null' || userId === 'undefined') {
    const denyPayload = {
      content: '❌ **Access Denied**: Administrative actions can only be performed within a server.',
      flags: MessageFlags.Ephemeral
    };
    if (interaction.deferred || interaction.replied) {
      if (typeof interaction.followUp === 'function') {
        await Promise.resolve(interaction.followUp(denyPayload)).catch(() => {});
      }
    } else {
      if (typeof interaction.reply === 'function') {
        await Promise.resolve(interaction.reply(denyPayload)).catch(() => {});
      }
    }
    return false;
  }

  // 1. Owner Bypass: Check ownerId from guild cache or fetch if missing
  let ownerId = interaction.guild?.ownerId;
  if (!ownerId && interaction.guild?.fetch) {
    try {
      const g = await interaction.guild.fetch();
      ownerId = g.ownerId;
    } catch {}
  }
  if (!ownerId && interaction.client) {
    try {
      const g = await interaction.client.guilds.fetch(guildId).catch(() => null);
      ownerId = g?.ownerId;
    } catch {}
  }

  if (ownerId && userId === ownerId) {
    return true;
  }

  // 2. Discord Administrator Permission Bypass
  // Fast path: gateway permission bitfield on interaction payload
  if (interaction.memberPermissions?.has?.(PermissionFlagsBits.Administrator)) {
    return true;
  }

  // Fallback: check cached member or fetch from guild
  let member = interaction.member;
  if (!member || typeof member.permissions?.has !== 'function') {
    let guild = interaction.guild;
    if (!guild && interaction.client) {
      guild = await interaction.client.guilds.fetch(guildId).catch(() => null);
    }
    member = await guild?.members?.fetch(userId).catch(() => null);
  }
  if (member?.permissions?.has?.(PermissionFlagsBits.Administrator)) {
    return true;
  }

  // 3. Database Whitelist Check: strictly scoped to guild_id and user_id
  const isWhitelisted = await isServerAdmin(guildId, userId);
  if (isWhitelisted) {
    return true;
  }

  // 4. Database Role Whitelist Check: strictly scoped to guild_id and member roles
  let roleIds = [];
  if (interaction.member?.roles) {
    if (Array.isArray(interaction.member.roles)) {
      roleIds = interaction.member.roles;
    } else if (typeof interaction.member.roles.cache?.keys === 'function') {
      roleIds = Array.from(interaction.member.roles.cache.keys());
    }
  }
  if (roleIds.length === 0 && (interaction.guild || interaction.client)) {
    const guild = interaction.guild || await interaction.client.guilds.fetch(guildId).catch(() => null);
    const m = await guild?.members?.fetch(userId).catch(() => null);
    if (m?.roles?.cache) {
      roleIds = Array.from(m.roles.cache.keys());
    }
  }

  if (roleIds.length > 0) {
    const hasRole = await hasAdminRole(guildId, roleIds);
    if (hasRole) {
      return true;
    }
  }

  // 5. Hard Denial
  sysError('Security Violation: Unauthorized Admin Action Blocked', new Error('User not on server_admins/server_admin_roles whitelist and not a Discord administrator'), {
    user: userId,
    guild: guildId,
    detail: interaction.commandName ? `Command: /${interaction.commandName}` : `CustomID: ${interaction.customId}`
  });

  const denyMsg = {
    content: "❌ **Access Denied**: You are not authorized to manage this server's admin settings.",
    flags: MessageFlags.Ephemeral
  };

  if (interaction.deferred || interaction.replied) {
    if (typeof interaction.followUp === 'function') {
      await Promise.resolve(interaction.followUp(denyMsg)).catch(() => {});
    }
  } else {
    if (typeof interaction.reply === 'function') {
      await Promise.resolve(interaction.reply(denyMsg)).catch(() => {});
    }
  }

  return false;
}

/**
 * Check if the user executing the interaction is either the server owner or has Discord Administrator permission.
 * These are the only users authorized to view/click the "Admins" button and manage authorized bot admins.
 *
 * @param {import('discord.js').Interaction} interaction
 * @returns {Promise<boolean>}
 */
export async function hasAdminManagerAccess(interaction) {
  const userId = interaction.user?.id;
  const guildId = interaction.guildId;
  if (!userId || !guildId || guildId === 'null' || guildId === 'undefined' || userId === 'null' || userId === 'undefined') return false;

  let guild = interaction.guild;
  if (!guild && interaction.client) {
    guild = await interaction.client.guilds.fetch(guildId).catch(() => null);
  }

  // 1. Owner check
  let ownerId = guild?.ownerId;
  if (!ownerId && guild?.fetch) {
    try {
      const g = await guild.fetch();
      ownerId = g.ownerId;
    } catch {}
  }
  if (!ownerId && interaction.client) {
    try {
      const g = await interaction.client.guilds.fetch(guildId).catch(() => null);
      ownerId = g?.ownerId;
    } catch {}
  }

  if (ownerId && userId === ownerId) {
    return true;
  }

  // 2. Discord Administrator permission check
  // Fast path: gateway permission bitfield on interaction payload
  if (interaction.memberPermissions?.has?.(PermissionFlagsBits.Administrator)) {
    return true;
  }

  // Fallback: check cached member or fetch from guild
  let member = interaction.member;
  if (!member || typeof member.permissions?.has !== 'function') {
    member = await guild?.members?.fetch(userId).catch(() => null);
  }

  if (member?.permissions?.has?.(PermissionFlagsBits.Administrator)) {
    return true;
  }

  return false;
}

/**
 * Strictly verifies that the interacting user is either the server owner or a Discord Administrator.
 * If not, sends an ephemeral denial and returns false.
 *
 * @param {import('discord.js').Interaction} interaction
 * @returns {Promise<boolean>}
 */
export async function verifyAdminManagerAccess(interaction) {
  const isAuthorized = await hasAdminManagerAccess(interaction);
  if (isAuthorized) return true;

  sysError('Security Violation: Unauthorized Admin Management Blocked', new Error('Only server owner and Discord administrators can manage authorized admins'), {
    user: interaction.user?.id,
    guild: interaction.guildId,
    detail: interaction.customId || interaction.commandName
  });

  const denyMsg = {
    content: '❌ **Access Denied**: Only the server owner and administrators can manage authorized bot administrators.',
    flags: MessageFlags.Ephemeral
  };

  if (interaction.deferred || interaction.replied) {
    if (typeof interaction.followUp === 'function') {
      await Promise.resolve(interaction.followUp(denyMsg)).catch(() => {});
    }
  } else {
    if (typeof interaction.reply === 'function') {
      await Promise.resolve(interaction.reply(denyMsg)).catch(() => {});
    }
  }

  return false;
}

// Aliases for compatibility
export const isGuildOwner = hasAdminManagerAccess;
export const verifyOwnerAccess = verifyAdminManagerAccess;

/**
 * Check if a user is the server owner or an administrator in a specific guild.
 * Zero-leak multi-tenant evaluation:
 * - Checks if the user is the owner of THIS specific guild.
 * - Checks if the user has Administrator or ManageGuild permissions in THIS specific guild.
 * - Checks if the user is registered in server_admins for THIS specific guild.
 * - Being an owner or admin in a different server will NEVER grant access here.
 *
 * @param {import('discord.js').Guild|string} guild - The guild object or guild ID
 * @param {import('discord.js').User|import('discord.js').GuildMember|string} userOrMember - User, Member, or User ID
 * @returns {Promise<boolean>}
 */
export async function isGuildOwnerOrAdmin(guild, userOrMember) {
  if (!guild || !userOrMember) return false;

  const guildId = typeof guild === 'string' ? guild : guild.id;
  const userId = typeof userOrMember === 'string' ? userOrMember : userOrMember.id;

  if (!guildId || !userId) return false;

  try {
    const guildObj = typeof guild === 'object' ? guild : null;

    // 1. Owner check in THIS specific guild
    let ownerId = guildObj?.ownerId;
    if (ownerId && userId === ownerId) {
      return true;
    }

    // 2. Member permission check in THIS specific guild
    let member = (typeof userOrMember === 'object' && userOrMember.permissions?.has)
      ? userOrMember
      : guildObj?.members?.cache?.get(userId);

    if (!member && guildObj?.members?.fetch) {
      member = await guildObj.members.fetch(userId).catch(() => null);
    }

    if (member?.permissions?.has) {
      if (
        member.permissions.has(PermissionFlagsBits.Administrator) ||
        member.permissions.has(PermissionFlagsBits.ManageGuild)
      ) {
        return true;
      }
    }

    // 3. Fallback check for ownerId if guild was partial
    if (!ownerId && guildObj?.fetch) {
      const freshGuild = await guildObj.fetch().catch(() => null);
      if (freshGuild?.ownerId && userId === freshGuild.ownerId) {
        return true;
      }
    }

    // 4. Database whitelist check for THIS specific guild
    const isDbAdmin = await isServerAdmin(guildId, userId, ownerId);
    if (isDbAdmin) {
      return true;
    }

    // 5. Database role whitelist check for THIS specific guild
    let roleIds = [];
    if (member?.roles?.cache) {
      roleIds = Array.from(member.roles.cache.keys());
    } else if (Array.isArray(member?.roles)) {
      roleIds = member.roles;
    }
    if (roleIds.length > 0) {
      const hasRole = await hasAdminRole(guildId, roleIds);
      if (hasRole) {
        return true;
      }
    }

    return false;
  } catch {
    // Fail-safe: Any error returns false without breaking caller
    return false;
  }
}

