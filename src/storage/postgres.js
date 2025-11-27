import pg from 'pg';
import { sanitizeError } from '../shared.js';

const { Pool } = pg;

// PostgreSQL connection pool
let pool = null;

/**
 * Get database configuration from environment variables
 * Railway provides DATABASE_URL automatically when you add a PostgreSQL database
 */
function getDatabaseConfig() {
  // Check if DATABASE_URL is provided (Railway style)
  if (process.env.DATABASE_URL) {
    return {
      connectionString: process.env.DATABASE_URL,
      ssl: {
        rejectUnauthorized: false // Required for Railway's managed PostgreSQL
      }
    };
  }
  
  // Fallback to individual environment variables
  return {
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'mvp_bot',
    password: process.env.DB_PASSWORD || 'postgres',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
  };
}

/**
 * Initialize the PostgreSQL connection pool
 */
export async function initializeDatabase() {
  if (pool) {
    console.log('⚠️  Database pool already initialized');
    return pool;
  }
  
  try {
    const config = getDatabaseConfig();
    pool = new Pool(config);
    
    // Test the connection
    const client = await pool.connect();
    console.log('✅ Connected to PostgreSQL database');
    client.release();
    
    // Create tables if they don't exist
    await createTables();
    
    return pool;
  } catch (error) {
    console.error('❌ Failed to initialize database:', sanitizeError(error));
    throw error;
  }
}

/**
 * Create required database tables
 */
async function createTables() {
  try {
    // Table for guild configurations
    await pool.query(`
      CREATE TABLE IF NOT EXISTS guild_configs (
        guild_id TEXT PRIMARY KEY,
        config JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    // Table for MVP award history
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mvp_awards (
        id SERIAL PRIMARY KEY,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        username TEXT,
        awarded_at TIMESTAMP WITH TIME ZONE NOT NULL,
        activity_score INTEGER,
        rank INTEGER,
        saved_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    // Create index for faster queries
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_mvp_awards_guild_id ON mvp_awards(guild_id);
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_mvp_awards_awarded_at ON mvp_awards(awarded_at DESC);
    `);
    
    console.log('✅ Database tables initialized');
  } catch (error) {
    console.error('❌ Failed to create tables:', sanitizeError(error));
    throw error;
  }
}

/**
 * Get the database pool
 */
export function getPool() {
  if (!pool) {
    throw new Error('Database pool not initialized. Call initializeDatabase() first.');
  }
  return pool;
}

/**
 * Close the database connection pool
 */
export async function closeDatabase() {
  if (pool) {
    await pool.end();
    pool = null;
    console.log('✅ Database connection closed');
  }
}

/**
 * Execute a query with error handling
 */
export async function query(text, params) {
  try {
    const result = await pool.query(text, params);
    return result;
  } catch (error) {
    console.error('Database query error:', sanitizeError(error));
    throw error;
  }
}
