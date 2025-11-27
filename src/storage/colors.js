import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '../../data/colors.db');

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

let db = null;

/**
 * Initialize the SQLite database for color roles
 */
export function initializeColorsDB() {
  if (db) return db;
  
  db = new Database(DB_PATH);
  
  // Create colors table for normal color roles
  db.exec(`
    CREATE TABLE IF NOT EXISTS colors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guildId TEXT NOT NULL,
      roleId TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      UNIQUE(guildId, roleId)
    )
  `);
  
  // Create booster_colors table for booster-exclusive color roles
  db.exec(`
    CREATE TABLE IF NOT EXISTS booster_colors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guildId TEXT NOT NULL,
      roleId TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      UNIQUE(guildId, roleId)
    )
  `);
  
  // Create booster_roles table to store which role represents boosters
  db.exec(`
    CREATE TABLE IF NOT EXISTS booster_roles (
      guildId TEXT PRIMARY KEY,
      roleId TEXT NOT NULL
    )
  `);
  
  return db;
}

/**
 * Add a color role
 */
export function addColorRole(guildId, roleId, isBooster = false) {
  const database = initializeColorsDB();
  const table = isBooster ? 'booster_colors' : 'colors';
  
  try {
    const stmt = database.prepare(`INSERT INTO ${table} (guildId, roleId, createdAt) VALUES (?, ?, ?)`);
    stmt.run(guildId, roleId, Date.now());
    return { success: true };
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT') {
      return { success: false, error: 'Role already exists in the color list' };
    }
    throw error;
  }
}

/**
 * Remove a color role
 */
export function removeColorRole(guildId, roleId, isBooster = false) {
  const database = initializeColorsDB();
  const table = isBooster ? 'booster_colors' : 'colors';
  
  const stmt = database.prepare(`DELETE FROM ${table} WHERE guildId = ? AND roleId = ?`);
  const result = stmt.run(guildId, roleId);
  
  return { success: true, deleted: result.changes > 0 };
}

/**
 * Get all color roles for a guild
 */
export function getColorRoles(guildId, isBooster = false) {
  const database = initializeColorsDB();
  const table = isBooster ? 'booster_colors' : 'colors';
  
  const stmt = database.prepare(`SELECT roleId, createdAt FROM ${table} WHERE guildId = ? ORDER BY createdAt ASC`);
  return stmt.all(guildId);
}

/**
 * Get all color roles (both normal and booster) for a guild
 */
export function getAllColorRoles(guildId) {
  const database = initializeColorsDB();
  
  const normalStmt = database.prepare(`SELECT roleId FROM colors WHERE guildId = ?`);
  const boosterStmt = database.prepare(`SELECT roleId FROM booster_colors WHERE guildId = ?`);
  
  const normal = normalStmt.all(guildId).map(r => r.roleId);
  const booster = boosterStmt.all(guildId).map(r => r.roleId);
  
  return [...normal, ...booster];
}

/**
 * Set the booster role for a guild
 */
export function setBoosterRole(guildId, roleId) {
  const database = initializeColorsDB();
  
  const stmt = database.prepare(`
    INSERT INTO booster_roles (guildId, roleId) 
    VALUES (?, ?)
    ON CONFLICT(guildId) DO UPDATE SET roleId = excluded.roleId
  `);
  
  stmt.run(guildId, roleId);
  return { success: true };
}

/**
 * Get the booster role for a guild
 */
export function getBoosterRole(guildId) {
  const database = initializeColorsDB();
  
  const stmt = database.prepare(`SELECT roleId FROM booster_roles WHERE guildId = ?`);
  const result = stmt.get(guildId);
  
  return result ? result.roleId : null;
}

/**
 * Close the database connection
 */
export function closeColorsDB() {
  if (db) {
    db.close();
    db = null;
  }
}
