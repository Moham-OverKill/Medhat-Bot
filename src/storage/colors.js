import { getPool } from './postgres.js';
import { sysLog, sysError } from '../utils/logger.js';

// No initialization needed here as tables are created in postgres.js
export function initializeColorsDB() {
  // Kept for backward compatibility with imports, but does nothing now
  return true;
}

/**
 * Add a color role (Migrated to Postgres)
 */
export async function addColorRole(guildId, roleId, isBooster = false) {
  const pool = getPool();
  const table = isBooster ? 'booster_colors' : 'colors';
  
  try {
    await pool.query(
      `INSERT INTO ${table} (guild_id, role_id) VALUES ($1, $2)
       ON CONFLICT (guild_id, role_id) DO NOTHING`,
      [guildId, roleId]
    );
    // Postgres doesn't return "rows affected" easily for ON CONFLICT DO NOTHING unless we check,
    // but generally if no error, it succeeded (or already existed).
    // We can assume success for this UI.
    return { success: true };
  } catch (error) {
    sysError('Infrastructure Audit Failed', error, { guild: guildId, detail: `Adding color role: ${roleId}` });
    return { success: false, error: 'Database error' };
  }
}

/**
 * Remove a color role (Migrated to Postgres)
 */
export async function removeColorRole(guildId, roleId, isBooster = false) {
  const pool = getPool();
  const table = isBooster ? 'booster_colors' : 'colors';
  
  try {
    const result = await pool.query(
      `DELETE FROM ${table} WHERE guild_id = $1 AND role_id = $2`,
      [guildId, roleId]
    );
    return { success: true, deleted: result.rowCount > 0 };
  } catch (error) {
    sysError('Infrastructure Audit Failed', error, { guild: guildId, detail: `Removing color role: ${roleId}` });
    return { success: false, error: 'Database error' };
  }
}

/**
 * Get all color roles for a guild (Migrated to Postgres)
 */
export async function getColorRoles(guildId, isBooster = false) {
  const pool = getPool();
  const table = isBooster ? 'booster_colors' : 'colors';
  
  try {
    const result = await pool.query(
      `SELECT role_id as "roleId", created_at as "createdAt" 
       FROM ${table} 
       WHERE guild_id = $1 
       ORDER BY created_at ASC`,
      [guildId]
    );
    return result.rows;
  } catch (error) {
    sysError('Infrastructure Audit Failed', error, { guild: guildId, detail: 'Fetching color roles' });
    return [];
  }
}

/**
 * Get all color roles (both normal and booster) for a guild (Migrated to Postgres)
 */
export async function getAllColorRoles(guildId) {
  const pool = getPool();
  
  try {
    // Parallel fetch
    const [normal, booster] = await Promise.all([
      pool.query('SELECT role_id FROM colors WHERE guild_id = $1', [guildId]),
      pool.query('SELECT role_id FROM booster_colors WHERE guild_id = $1', [guildId])
    ]);
    
    return [...normal.rows.map(r => r.role_id), ...booster.rows.map(r => r.role_id)];
  } catch (error) {
    sysError('Infrastructure Audit Failed', error, { guild: guildId, detail: 'Fetching all color roles' });
    return [];
  }
}

/**
 * Set the booster role for a guild (Migrated to Postgres)
 */
export async function setBoosterRole(guildId, roleId) {
  const pool = getPool();
  
  try {
    await pool.query(
      `INSERT INTO booster_roles (guild_id, role_id) 
       VALUES ($1, $2)
       ON CONFLICT(guild_id) DO UPDATE SET role_id = excluded.role_id`,
      [guildId, roleId]
    );
    return { success: true };
  } catch (error) {
    sysError('Infrastructure Audit Failed', error, { guild: guildId, detail: `Setting booster role: ${roleId}` });
    return { success: false, error: 'Database error' };
  }
}

/**
 * Get the booster role for a guild (Migrated to Postgres)
 */
export async function getBoosterRole(guildId) {
  const pool = getPool();
  
  try {
    const result = await pool.query(
      'SELECT role_id FROM booster_roles WHERE guild_id = $1',
      [guildId]
    );
    return result.rows[0]?.role_id || null;
  } catch (error) {
    sysError('Infrastructure Audit Failed', error, { guild: guildId, detail: 'Fetching booster role' });
    return null;
  }
}

/**
 * Close the database connection (Deprecated)
 */
export function closeColorsDB() {
  // Postgres pool is managed globally
}
