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
    
    // Economy System Tables
    
    // User balances table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_balances (
        user_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        balance INTEGER NOT NULL DEFAULT 0,
        daily_streak INTEGER NOT NULL DEFAULT 0,
        last_claim_time TIMESTAMP WITH TIME ZONE,
        total_earned INTEGER NOT NULL DEFAULT 0,
        total_spent INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, guild_id)
      );
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_user_balances_guild ON user_balances(guild_id);
    `);
    
    // Transactions table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        amount INTEGER NOT NULL,
        balance_after INTEGER NOT NULL,
        type TEXT NOT NULL,
        description TEXT,
        reference_id TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id, guild_id, created_at DESC);
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type, created_at DESC);
    `);
    
    // Shop categories table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS shop_categories (
        id SERIAL PRIMARY KEY,
        guild_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        display_order INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_shop_categories_guild ON shop_categories(guild_id, is_active);
    `);
    
    // Shop items table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS shop_items (
        id SERIAL PRIMARY KEY,
        guild_id TEXT NOT NULL,
        category_id INTEGER REFERENCES shop_categories(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        description TEXT,
        price INTEGER NOT NULL,
        stock INTEGER,
        is_active BOOLEAN DEFAULT true,
        requires_booster BOOLEAN DEFAULT false,
        booster_only BOOLEAN DEFAULT false,
        role_id TEXT,
        role_valid BOOLEAN DEFAULT true,
        role_invalid_since TIMESTAMP WITH TIME ZONE,
        item_type TEXT DEFAULT 'role',
        duration_hours INTEGER,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_shop_items_guild ON shop_items(guild_id, is_active);
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_shop_items_category ON shop_items(category_id);
    `);
    
    // User inventory table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_inventory (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        item_id INTEGER REFERENCES shop_items(id) ON DELETE CASCADE,
        shop_item_id INTEGER REFERENCES shop_items(id) ON DELETE CASCADE,
        role_id TEXT,
        quantity INTEGER NOT NULL DEFAULT 1,
        is_active BOOLEAN DEFAULT true,
        expires_at TIMESTAMP WITH TIME ZONE,
        purchase_source TEXT DEFAULT 'shop',
        requires_booster BOOLEAN DEFAULT false,
        purchased_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, guild_id, item_id)
      );
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_user_inventory_lookup ON user_inventory(user_id, guild_id);
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_user_inventory_item ON user_inventory(item_id);
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
