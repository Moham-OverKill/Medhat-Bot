/**
 * Bot Administrator Access Control — Strict Multi-Tenant Security Module
 * Implements Zero-Trust verification:
 * 1. Server Owner always has permanent bypass.
 * 2. Whitelisted bot admins in server_admins table have access for their specific guild.
 * 3. Discord Administrator permissions or roles grant ZERO access.
 * 4. Real-time revocation check on every interaction.
 */
import { MessageFlags } from 'discord.js';
import { getPool } from './postgres.js';
import { sysError, sysLog } from '../utils/logger.js';

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
  if (!guildId || !userId) return false;
  if (ownerId && userId === ownerId) return true;

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

  if (!guildId || !userId) {
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

  // 2. Database Whitelist Check: strictly scoped to guild_id and user_id
  const isWhitelisted = await isServerAdmin(guildId, userId);
  if (isWhitelisted) {
    return true;
  }

  // 3. Hard Denial
  sysError('Security Violation: Unauthorized Admin Action Blocked', new Error('User not on server_admins whitelist'), {
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
 * Check if the user executing the interaction is the server owner.
 * @param {import('discord.js').Interaction} interaction
 * @returns {Promise<boolean>}
 */
export async function isGuildOwner(interaction) {
  const userId = interaction.user?.id;
  const guildId = interaction.guildId;
  if (!userId || !guildId) return false;

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

  return Boolean(ownerId && userId === ownerId);
}

/**
 * Strictly verifies that the interacting user is the server owner.
 * If not, sends an ephemeral denial and returns false.
 * @param {import('discord.js').Interaction} interaction
 * @returns {Promise<boolean>}
 */
export async function verifyOwnerAccess(interaction) {
  const isOwner = await isGuildOwner(interaction);
  if (isOwner) return true;

  sysError('Security Violation: Non-Owner Admin Management Blocked', new Error('Only server owner can manage authorized admins'), {
    user: interaction.user?.id,
    guild: interaction.guildId,
    detail: interaction.customId || interaction.commandName
  });

  const denyMsg = {
    content: '❌ **Access Denied**: Only the server owner can manage authorized bot administrators.',
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
