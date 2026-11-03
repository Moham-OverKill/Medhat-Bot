import { getPool, query } from './postgres.js';
import { logger, sysError } from '../utils/logger.js';

/**
 * Fetch the active pause state and whitelist for a specific guild.
 * Enforces strict multi-tenant isolation by guild_id.
 * 
 * @param {string} guildId
 * @returns {Promise<{
 *   guild_id: string,
 *   is_paused: boolean,
 *   paused_at: Date|null,
 *   whitelist_channel_ids: string[],
 *   server_settings_backup: object
 * }>}
 */
export async function getServerPauseState(guildId) {
  if (!guildId) return { guild_id: '', is_paused: false, paused_at: null, whitelist_channel_ids: [], server_settings_backup: {} };

  try {
    const res = await query(`
      SELECT guild_id, is_paused, paused_at, whitelist_channel_ids, server_settings_backup
      FROM server_pause_states
      WHERE guild_id = $1
    `, [guildId]);

    if (!res || res.rows.length === 0) {
      return {
        guild_id: guildId,
        is_paused: false,
        paused_at: null,
        whitelist_channel_ids: [],
        server_settings_backup: {}
      };
    }

    const row = res.rows[0];
    return {
      guild_id: row.guild_id,
      is_paused: Boolean(row.is_paused),
      paused_at: row.paused_at ? new Date(row.paused_at) : null,
      whitelist_channel_ids: Array.isArray(row.whitelist_channel_ids) ? row.whitelist_channel_ids : [],
      server_settings_backup: row.server_settings_backup || {}
    };
  } catch (err) {
    sysError(`Failed to fetch pause state for guild ${guildId}`, err);
    return { guild_id: guildId, is_paused: false, paused_at: null, whitelist_channel_ids: [], server_settings_backup: {} };
  }
}

/**
 * Update the list of whitelisted channels for a guild.
 * 
 * @param {string} guildId
 * @param {string[]} whitelistChannelIds
 */
export async function updateServerPauseWhitelist(guildId, whitelistChannelIds) {
  if (!guildId) return;
  const safeChannels = Array.isArray(whitelistChannelIds) ? whitelistChannelIds.map(String) : [];

  await query(`
    INSERT INTO server_pause_states (guild_id, whitelist_channel_ids)
    VALUES ($1, $2)
    ON CONFLICT (guild_id) DO UPDATE SET
      whitelist_channel_ids = EXCLUDED.whitelist_channel_ids;
  `, [guildId, safeChannels]);
}

/**
 * Atomically record the pre-pause snapshot in PostgreSQL.
 * Serializes guild settings and bulk-inserts all channel overwrites via UNNEST.
 * 
 * @param {string} guildId
 * @param {object} settingsBackup
 * @param {Array<{
 *   channel_id: string,
 *   target_id: string,
 *   target_type: string,
 *   original_allow_bits: string|bigint,
 *   original_deny_bits: string|bigint,
 *   was_synthesized: boolean
 * }>} allChannelOverwrites
 */
export async function recordServerPauseSnapshot(guildId, settingsBackup, allChannelOverwrites) {
  if (!guildId) throw new Error('guildId is required to record pause snapshot');

  const pool = getPool();
  if (!pool) throw new Error('Database pool not available');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Update/Upsert server_pause_states
    await client.query(`
      INSERT INTO server_pause_states (guild_id, is_paused, paused_at, server_settings_backup)
      VALUES ($1, TRUE, NOW(), $2)
      ON CONFLICT (guild_id) DO UPDATE SET
        is_paused = TRUE,
        paused_at = NOW(),
        server_settings_backup = EXCLUDED.server_settings_backup;
    `, [guildId, JSON.stringify(settingsBackup || {})]);

    // 2. Clear any stale backups strictly for this guild
    await client.query('DELETE FROM server_channel_permission_backups WHERE guild_id = $1', [guildId]);

    // 3. Bulk insert channel overwrites via UNNEST
    if (Array.isArray(allChannelOverwrites) && allChannelOverwrites.length > 0) {
      const guildIds = allChannelOverwrites.map(() => guildId);
      const channelIds = allChannelOverwrites.map(o => String(o.channel_id));
      const targetIds = allChannelOverwrites.map(o => String(o.target_id));
      const targetTypes = allChannelOverwrites.map(o => String(o.target_type));
      const allowBits = allChannelOverwrites.map(o => String(o.original_allow_bits));
      const denyBits = allChannelOverwrites.map(o => String(o.original_deny_bits));
      const wasSynthesized = allChannelOverwrites.map(o => Boolean(o.was_synthesized));

      await client.query(`
        INSERT INTO server_channel_permission_backups (
          guild_id, channel_id, target_id, target_type, original_allow_bits, original_deny_bits, was_synthesized
        )
        SELECT * FROM UNNEST(
          $1::text[], $2::text[], $3::text[], $4::text[], $5::bigint[], $6::bigint[], $7::boolean[]
        )
      `, [guildIds, channelIds, targetIds, targetTypes, allowBits, denyBits, wasSynthesized]);
    }

    await client.query('COMMIT');
    logger.info('PAUSE', `Recorded pre-pause snapshot for guild ${guildId} with ${allChannelOverwrites.length} overwrites`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    sysError(`Failed to record pause snapshot for guild ${guildId}`, err);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Retrieve all channel permission backups for a guild.
 * 
 * @param {string} guildId
 * @returns {Promise<Array<{
 *   channel_id: string,
 *   target_id: string,
 *   target_type: string,
 *   original_allow_bits: string,
 *   original_deny_bits: string,
 *   was_synthesized: boolean
 * }>>}
 */
export async function getServerChannelPermissionBackups(guildId) {
  if (!guildId) return [];

  const res = await query(`
    SELECT channel_id, target_id, target_type, original_allow_bits, original_deny_bits, was_synthesized
    FROM server_channel_permission_backups
    WHERE guild_id = $1
    ORDER BY channel_id ASC
  `, [guildId]);

  if (!res || !res.rows) return [];

  return res.rows.map(row => ({
    channel_id: String(row.channel_id),
    target_id: String(row.target_id),
    target_type: String(row.target_type),
    original_allow_bits: String(row.original_allow_bits),
    original_deny_bits: String(row.original_deny_bits),
    was_synthesized: Boolean(row.was_synthesized)
  }));
}

/**
 * Reset pause status and delete all channel backups for a guild.
 * 
 * @param {string} guildId
 */
export async function clearServerPauseSnapshot(guildId) {
  if (!guildId) return;

  const pool = getPool();
  if (!pool) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      UPDATE server_pause_states
      SET is_paused = FALSE,
          server_settings_backup = '{}'::jsonb
      WHERE guild_id = $1
    `, [guildId]);

    await client.query('DELETE FROM server_channel_permission_backups WHERE guild_id = $1', [guildId]);

    await client.query('COMMIT');
    logger.info('PAUSE', `Cleared pause state and backups for guild ${guildId}`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    sysError(`Failed to clear pause snapshot for guild ${guildId}`, err);
    throw err;
  } finally {
    client.release();
  }
}
