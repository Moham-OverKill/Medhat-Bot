import pg from 'pg';
import { sanitizeError } from '../shared.js';
import { logSystemEvent } from '../utils/logger.js';

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
    console.log('[System] Database: Using DATABASE_URL connection string');
    // Log masked URL for debugging (hiding password)
    const maskedUrl = process.env.DATABASE_URL.replace(/:([^:@]+)@/, ':****@');
    console.log(`[System] Database: Config: ${maskedUrl}`);

    // Railway internal network does not use/support SSL properly, which causes the 60s timeout
    const isInternal = process.env.DATABASE_URL.includes('.railway.internal');

    return {
      connectionString: process.env.DATABASE_URL,
      ssl: isInternal ? false : {
        rejectUnauthorized: false
      },
      connectionTimeoutMillis: 30000,
      idleTimeoutMillis: 15000,
      max: 20,
      min: 2,
      application_name: 'mvp-bot-railway',
      keepAlive: true,
      keepAliveInitialDelayMillis: 5000,
      allowExitOnIdle: false
    };
  }

  // Fallback to individual environment variables
  const host = process.env.DB_HOST || 'localhost';
  const user = process.env.DB_USER || 'postgres';
  const dbName = process.env.DB_NAME || 'mvp_bot';
  const port = parseInt(process.env.DB_PORT || '5432', 10);

  console.log(`[System] Database: Using explicit config - Host: ${host}:${port}, User: ${user}, DB: ${dbName}`);

  return {
    user: user,
    host: host,
    database: dbName,
    password: process.env.DB_PASSWORD || 'postgres',
    port: port,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 60000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 5000
  };
}

// Track if database is actually connected (not just pool created)
let databaseConnected = false;

/**
 * Initialize the PostgreSQL connection pool
 */
export async function initializeDatabase() {
  if (pool && databaseConnected) {
    console.log('[System] Database pool already active and connected');
    return pool;
  }

  const config = getDatabaseConfig();

  // Retry logic for initial connection
  let retries = 10;
  const FIRST_RETRY_DELAY = 30000; // 30s for first retry (give DB time to wake up)
  const RETRY_DELAY = 15000; // 15s between subsequent retries

  while (retries > 0) {
    try {
      // Create fresh pool for each attempt (prevents stale pool issues)
      if (pool) {
        await pool.end().catch(() => { });
        databaseConnected = false;
      }

      console.log(`[System] Database: Creating new connection pool...`);
      pool = new Pool(config);

      // Handle pool errors (prevents crashes on connection loss)
      pool.on('error', (err) => {
        console.error('⚠️ [System] Unexpected pool error:', err.message);
        databaseConnected = false; // Mark as disconnected on error
        // Pool will automatically try to reconnect on next query
      });

      // Test the connection
      const host = config.host || (process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).hostname : 'unknown');
      console.log(`[System] Database: Connecting to ${host} (Attempt ${11 - retries}/10)...`);

      // Attempt DNS lookup to debug networking issues
      try {
        const dns = await import('dns/promises');
        const addresses = await dns.lookup(host);
        console.log(`[System] Database: Host '${host}' resolves to: ${JSON.stringify(addresses)}`);
      } catch (dnsErr) {
        console.warn(`[System] Database: DNS lookup failed for '${host}': ${dnsErr.message}`);
      }

      const client = await pool.connect();
      logSystemEvent(`Connected to PostgreSQL successfully (Attempt ${11 - retries})`);
      client.release();

      // Mark as successfully connected
      databaseConnected = true;

      // Create tables if they don't exist
      await createTables();

      // Start periodic health check to keep connections alive
      startHealthCheck();

      return pool;
    } catch (error) {
      retries--;
      databaseConnected = false;
      const isLastAttempt = retries === 0;
      const isFirstAttempt = retries === 9;
      const delay = isFirstAttempt ? FIRST_RETRY_DELAY : RETRY_DELAY;

      console.warn(
        `⚠️ DB connection failed (${error.message}). ` +
        (isLastAttempt ? 'Giving up.' : `Retry in ${delay / 1000}s... (${retries} left)`)
      );

      if (isLastAttempt) {
        console.error('❌ Failed to initialize database after multiple attempts:', sanitizeError(error));
        throw error;
      }

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

let healthCheckInterval = null;

/**
 * Check if database is ready for queries
 * @returns {boolean} True if database pool is initialized AND successfully connected
 */
export function isDatabaseReady() {
  return pool !== null && databaseConnected === true;
}

/**
 * Periodic health check to keep database connections alive
 * Runs every 30 seconds to prevent connection timeout
 */
function startHealthCheck() {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
  }

  healthCheckInterval = setInterval(async () => {
    if (!pool) return;

    try {
      await pool.query('SELECT 1');
    } catch (error) {
      console.warn('⚠️ DB health check failed:', error.message);
      // Pool will auto-reconnect on next query
    }
  }, 30000); // Every 30 seconds
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

    // Table for MVP award history (limited to 200 per guild)
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

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_mvp_awards_guild_id ON mvp_awards(guild_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_mvp_awards_awarded_at ON mvp_awards(awarded_at DESC);
    `);

    // Table for user balances (essential data - never cleaned)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_balances (
        user_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        balance BIGINT NOT NULL DEFAULT 0,
        total_earned BIGINT NOT NULL DEFAULT 0,
        total_spent BIGINT NOT NULL DEFAULT 0,
        daily_streak INTEGER NOT NULL DEFAULT 0,
        last_daily TIMESTAMP WITH TIME ZONE,
        last_lost_streak INTEGER DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, guild_id)
      );
    `);

    // Ensure last_lost_streak column exists (migration for existing tables)
    await pool.query(`
      DO $$ 
      BEGIN 
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='user_balances' AND column_name='last_lost_streak') THEN 
          ALTER TABLE user_balances ADD COLUMN last_lost_streak INTEGER DEFAULT 0; 
        END IF; 
      END $$;
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_user_balances_guild_id ON user_balances(guild_id);
    `);

    // Table for transactions (cleanup after 6 months)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        amount BIGINT NOT NULL,
        balance_after BIGINT NOT NULL,
        type TEXT NOT NULL,
        description TEXT,
        reference_id TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_transactions_user_guild ON transactions(user_id, guild_id, created_at DESC);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at DESC);
    `);

    // Table for transaction history (seller sales, etc.)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS transaction_history (
        id SERIAL PRIMARY KEY,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        amount BIGINT NOT NULL,
        description TEXT,
        related_user_id TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_transaction_history_user ON transaction_history(guild_id, user_id, created_at DESC);
    `);

    // Table for user activity tracking (resets after MVP awards)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_activity (
        user_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        username TEXT,
        message_count INTEGER NOT NULL DEFAULT 0,
        voice_minutes INTEGER NOT NULL DEFAULT 0,
        voice_seconds_accumulated INTEGER NOT NULL DEFAULT 0,
        last_voice_check TIMESTAMP WITH TIME ZONE,
        is_voice_tracking BOOLEAN NOT NULL DEFAULT FALSE,
        last_message_time BIGINT,
        last_active TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        last_message_content TEXT,
        voice_valid_start BIGINT,
        PRIMARY KEY (user_id, guild_id)
      );
    `);

    // Add new columns if they don't exist (migration for existing DBs)
    await pool.query(`
      ALTER TABLE user_activity 
      ADD COLUMN IF NOT EXISTS last_message_content TEXT,
      ADD COLUMN IF NOT EXISTS voice_valid_start BIGINT;
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_user_activity_guild_id ON user_activity(guild_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_user_activity_voice_tracking ON user_activity(guild_id, is_voice_tracking) WHERE is_voice_tracking = TRUE;
    `);

    // Table for shop categories (essential data - never cleaned)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS shop_categories (
        id SERIAL PRIMARY KEY,
        guild_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        display_order INTEGER NOT NULL DEFAULT 0,
        category_type INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_shop_categories_guild_id ON shop_categories(guild_id, display_order);
    `);

    // Table for shop items (essential data - never cleaned)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS shop_items (
        id SERIAL PRIMARY KEY,
        guild_id TEXT NOT NULL,
        category_id INTEGER REFERENCES shop_categories(id) ON DELETE SET NULL,
        role_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        price BIGINT NOT NULL,
        item_type TEXT NOT NULL DEFAULT 'role',
        is_pack BOOLEAN NOT NULL DEFAULT FALSE,
        contents JSONB DEFAULT '[]'::jsonb,
        duration_hours INTEGER,
        duration_seconds INTEGER,
        stock INTEGER,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_shop_items_guild_id ON shop_items(guild_id, is_active);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_shop_items_category_id ON shop_items(category_id);
    `);

    // Table for item tiers (for upgrading items)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS item_tiers (
        id SERIAL PRIMARY KEY,
        parent_item_id INTEGER REFERENCES shop_items(id) ON DELETE CASCADE,
        tier_level INTEGER NOT NULL,
        role_id TEXT NOT NULL,
        upgrade_price BIGINT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(parent_item_id, tier_level)
      );
    `);

    // Table for user inventory (essential data - never cleaned)
    // Renamed from user_purchases to user_inventory to match logic
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_inventory (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        shop_item_id INTEGER REFERENCES shop_items(id) ON DELETE SET NULL,
        role_id TEXT NOT NULL,
        current_tier INTEGER DEFAULT 1,
        expires_at TIMESTAMP WITH TIME ZONE,
        purchased_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        purchase_source TEXT DEFAULT 'shop',
        requires_booster BOOLEAN DEFAULT FALSE
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_user_inventory_user_guild ON user_inventory(user_id, guild_id, is_active);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_user_inventory_expires_at ON user_inventory(expires_at) WHERE expires_at IS NOT NULL;
    `);

    // --- Schema Migrations (Idempotent) ---
    try {
      // Previous migrations
      await pool.query(`ALTER TABLE shop_items ADD COLUMN IF NOT EXISTS duration_seconds INTEGER`);
      await pool.query(`ALTER TABLE user_inventory ADD COLUMN IF NOT EXISTS current_tier INTEGER DEFAULT 1`);
      await pool.query(`ALTER TABLE user_inventory ADD COLUMN IF NOT EXISTS active_role_id TEXT`);

      // Shop V2 Refactor Migrations
      await pool.query(`ALTER TABLE shop_items ALTER COLUMN category_id DROP NOT NULL`);
      await pool.query(`ALTER TABLE shop_items ADD COLUMN IF NOT EXISTS is_pack BOOLEAN DEFAULT FALSE`);
      await pool.query(`ALTER TABLE shop_items ADD COLUMN IF NOT EXISTS contents JSONB DEFAULT '[]'::jsonb`);
      await pool.query(`ALTER TABLE shop_items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP`);
      await pool.query(`ALTER TABLE shop_items ADD COLUMN IF NOT EXISTS stock INTEGER`);
      await pool.query(`ALTER TABLE shop_categories ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP`);
      await pool.query(`ALTER TABLE shop_categories DROP COLUMN IF EXISTS type`);
      await pool.query(`UPDATE shop_items SET is_pack = true WHERE item_type = 'pack'`);

      // Source of Truth Migration: Add 'source' column to track SHOP (paid) vs SYNC (admin-granted)
      await pool.query(`ALTER TABLE user_inventory ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'SYNC'`);
      // Migrate existing items: items with purchase_source='shop' are SHOP, others are SYNC
      await pool.query(`UPDATE user_inventory SET source = 'SHOP' WHERE purchase_source = 'shop' AND source IS NULL`);
      await pool.query(`UPDATE user_inventory SET source = 'SYNC' WHERE source IS NULL`);
      
      // Trade Concurrency & Anti-Spam (March 24)
      await pool.query(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP`);
      
      // Category Upgrade: Add category_type (0=Multi, 1=Single)
      await pool.query(`ALTER TABLE shop_categories ADD COLUMN IF NOT EXISTS category_type INTEGER DEFAULT 0`);

      // Prerequisite System: Store array of shop item IDs that must be owned before purchase/equip
      await pool.query(`ALTER TABLE shop_items ADD COLUMN IF NOT EXISTS required_items JSONB DEFAULT '[]'::jsonb`);

    } catch (e) {
      console.error('Migration error (harmless if columns exist):', e.message);
    }

    // Table for audit logs
    await pool.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        action_type TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT,
        details JSONB,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_audit_logs_guild_user ON audit_logs(guild_id, user_id);
    `);

    // --- QUESTS MODULE TABLES (Formerly Missions) ---

    // Migration for tracking table rename (done before CREATE TABLE)
    try {
      await pool.query(`ALTER TABLE IF EXISTS missions RENAME TO quests;`);
      await pool.query(`ALTER INDEX IF EXISTS idx_missions_guild_id RENAME TO idx_quests_guild_id;`);
      
      await pool.query(`ALTER TABLE IF EXISTS mission_progress RENAME TO quest_progress;`);
      await pool.query(`ALTER TABLE IF EXISTS quest_progress RENAME COLUMN mission_id TO quest_id;`);
      await pool.query(`ALTER TABLE IF EXISTS quest_progress RENAME COLUMN mission_date TO quest_date;`);
      await pool.query(`ALTER INDEX IF EXISTS idx_mission_progress_lookup RENAME TO idx_quest_progress_lookup;`);
    } catch(e) {
      // Ignored if already renamed or doesn't exist
    }

    // Table for quest pool (admin-configured, max 10 per guild)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS quests (
        id SERIAL PRIMARY KEY,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        channel_type TEXT NOT NULL DEFAULT 'text',
        action_type TEXT NOT NULL DEFAULT 'send_messages',
        required_count INTEGER NOT NULL DEFAULT 1,
        reward_coins INTEGER NOT NULL DEFAULT 10,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_quests_guild_id ON quests(guild_id);
    `);

    // Table for daily quest progress per user
    await pool.query(`
      CREATE TABLE IF NOT EXISTS quest_progress (
        id SERIAL PRIMARY KEY,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        quest_id INTEGER REFERENCES quests(id) ON DELETE CASCADE,
        quest_date DATE NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0,
        completed BOOLEAN NOT NULL DEFAULT FALSE,
        active_tracking BOOLEAN NOT NULL DEFAULT TRUE,  -- Default to true, all are tracking passively
        is_claimed BOOLEAN NOT NULL DEFAULT FALSE,    -- Still kept for safety but should be set to true at auto-claim
        completed_at TIMESTAMP WITH TIME ZONE,
        UNIQUE(guild_id, user_id, quest_id, quest_date)
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_quest_progress_lookup ON quest_progress(guild_id, user_id, quest_id, quest_date);
    `);


    // --- COLORS MODULE TABLES (Migrated from SQLite) ---

    // Table for normal color roles
    await pool.query(`
      CREATE TABLE IF NOT EXISTS colors (
        id SERIAL PRIMARY KEY,
        guild_id TEXT NOT NULL,
        role_id TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(guild_id, role_id)
      );
    `);

    // Table for booster-exclusive color roles
    await pool.query(`
      CREATE TABLE IF NOT EXISTS booster_colors (
        id SERIAL PRIMARY KEY,
        guild_id TEXT NOT NULL,
        role_id TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(guild_id, role_id)
      );
    `);

    // Table for booster roles configuration
    await pool.query(`
      CREATE TABLE IF NOT EXISTS booster_roles (
        guild_id TEXT PRIMARY KEY,
        role_id TEXT NOT NULL
      );
    `);

    // Table for leaderboard channel & message tracking
    await pool.query(`
      CREATE TABLE IF NOT EXISTS leaderboard_config (
        guild_id TEXT PRIMARY KEY,
        daily_channel_id TEXT,
        daily_message_id TEXT,
        coins_channel_id TEXT,
        coins_message_id TEXT,
        streak_channel_id TEXT,
        streak_message_id TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Table for P2P Trades
    await pool.query(`
      CREATE TABLE IF NOT EXISTS trades (
        id SERIAL PRIMARY KEY,
        guild_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        sender_coins BIGINT DEFAULT 0,
        target_coins BIGINT DEFAULT 0,
        sender_items JSONB DEFAULT '[]',
        target_items JSONB DEFAULT '[]',
        status TEXT DEFAULT 'pending',
        message_id TEXT,
        channel_id TEXT,
        message_url TEXT,
        expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Table for Purchase Cooldowns (Stock Griefing Protection)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS purchase_cooldowns (
        user_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        item_id INTEGER NOT NULL,
        last_purchase_at TIMESTAMP WITH TIME ZONE NOT NULL,
        PRIMARY KEY (user_id, guild_id, item_id)
      );
    `);

    // Table for Dropped Items (Multiplayer Claim System)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dropped_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        guild_id TEXT NOT NULL,
        channel_id TEXT,
        message_id TEXT,
        shop_item_id INTEGER NOT NULL REFERENCES shop_items(id) ON DELETE CASCADE,
        dropper_id TEXT NOT NULL,
        status TEXT DEFAULT 'available',
        claimer_id TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Migration for existing table (if any)
    await pool.query('ALTER TABLE dropped_items ADD COLUMN IF NOT EXISTS channel_id TEXT');
    await pool.query('ALTER TABLE dropped_items ADD COLUMN IF NOT EXISTS message_id TEXT');

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_dropped_items_guild_status ON dropped_items(guild_id, status);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_purchase_cooldowns_lookup ON purchase_cooldowns(user_id, guild_id, item_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_trades_sender_target ON trades(sender_id, target_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_trades_guild_status ON trades(guild_id, status);
    `);

    logSystemEvent('Database tables initialized');

    // Run cleanup on startup (non-blocking)
    setImmediate(() => {
      cleanupOldData().catch(error => {
        console.error('Background cleanup failed:', sanitizeError(error));
      });
    });
  } catch (error) {
    console.error('❌ Failed to create tables:', sanitizeError(error));
    throw error;
  }
}

/**
 * Cleanup old non-essential data to keep database size manageable
 * Runs on startup and can be scheduled periodically
 */
async function cleanupOldData() {
  try {
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    // Clean transactions older than 6 months
    const transactionResult = await pool.query(
      'DELETE FROM transactions WHERE created_at < $1',
      [sixMonthsAgo]
    );

    if (transactionResult.rowCount > 0) {
      logSystemEvent(`Cleaned ${transactionResult.rowCount} old transactions`);
    }

    // Clean inactive user activity (users with 0 activity in guilds that haven't awarded MVP in 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const activityResult = await pool.query(`
      DELETE FROM user_activity 
      WHERE message_count = 0 
        AND voice_minutes = 0 
        AND last_active < $1
    `, [thirtyDaysAgo]);

    if (activityResult.rowCount > 0) {
      logSystemEvent(`Cleaned ${activityResult.rowCount} inactive records`);
    }

  } catch (error) {
    console.error('Cleanup error:', sanitizeError(error));
  }
}

/**
 * Export cleanup function for manual triggers
 */
export { cleanupOldData };

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
    logSystemEvent('Database connection closed');
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
