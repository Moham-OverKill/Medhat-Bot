import { getPool } from './postgres.js';

/**
 * Initialize color role tables in PostgreSQL
 */
export async function initializeColorsDB() {
  const pool = getPool();
  
  // Create colors table for normal color roles
  await pool.query(`
    CREATE TABLE IF NOT EXISTS color_roles (
      id SERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(guild_id, role_id)
    )
  `);
  
  // Create booster_color_roles table for booster-exclusive color roles
  await pool.query(`
    CREATE TABLE IF NOT EXISTS booster_color_roles (
      id SERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(guild_id, role_id)
    )
  `);
  
  // Create booster_role_config table to store which role represents boosters
  await pool.query(`
    CREATE TABLE IF NOT EXISTS booster_role_config (
      guild_id TEXT PRIMARY KEY,
      role_id TEXT NOT NULL
    )
  `);
}

/**
 * Add a color role
 */
export async function addColorRole(guildId, roleId, isBooster = false) {
  const pool = getPool();
  const table = isBooster ? 'booster_color_roles' : 'color_roles';
  
  try {
    await pool.query(
      `INSERT INTO ${table} (guild_id, role_id) VALUES ($1, $2)`,
      [guildId, roleId]
    );
    return { success: true };
  } catch (error) {
    if (error.code === '23505') { // PostgreSQL unique violation
      return { success: false, error: 'Role already exists in the color list' };
    }
    throw error;
  }
}

/**
 * Remove a color role
 */
export async function removeColorRole(guildId, roleId, isBooster = false) {
  const pool = getPool();
  const table = isBooster ? 'booster_color_roles' : 'color_roles';
  
  const result = await pool.query(
    `DELETE FROM ${table} WHERE guild_id = $1 AND role_id = $2`,
    [guildId, roleId]
  );
  
  return { success: true, deleted: result.rowCount > 0 };
}

/**
 * Get all color roles for a guild
 */
export async function getColorRoles(guildId, isBooster = false) {
  const pool = getPool();
  const table = isBooster ? 'booster_color_roles' : 'color_roles';
  
  const result = await pool.query(
    `SELECT role_id as "roleId", created_at as "createdAt" FROM ${table} WHERE guild_id = $1 ORDER BY created_at ASC`,
    [guildId]
  );
  return result.rows;
}

/**
 * Get all color roles (both normal and booster) for a guild
 */
export async function getAllColorRoles(guildId) {
  const pool = getPool();
  
  const normalResult = await pool.query(
    `SELECT role_id FROM color_roles WHERE guild_id = $1`,
    [guildId]
  );
  const boosterResult = await pool.query(
    `SELECT role_id FROM booster_color_roles WHERE guild_id = $1`,
    [guildId]
  );
  
  const normal = normalResult.rows.map(r => r.role_id);
  const booster = boosterResult.rows.map(r => r.role_id);
  
  return [...normal, ...booster];
}

/**
 * Set the booster role for a guild
 */
export async function setBoosterRole(guildId, roleId) {
  const pool = getPool();
  
  await pool.query(
    `INSERT INTO booster_role_config (guild_id, role_id) 
     VALUES ($1, $2)
     ON CONFLICT(guild_id) DO UPDATE SET role_id = excluded.role_id`,
    [guildId, roleId]
  );
  
  return { success: true };
}

/**
 * Get the booster role for a guild
 */
export async function getBoosterRole(guildId) {
  const pool = getPool();
  
  const result = await pool.query(
    `SELECT role_id FROM booster_role_config WHERE guild_id = $1`,
    [guildId]
  );
  
  return result.rows.length > 0 ? result.rows[0].role_id : null;
}
