import pg from 'pg';
import { sanitizeError } from '../shared.js';
import { logSystemEvent, sysLog, sysError } from '../utils/logger.js';

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
    const maskedUrl = process.env.DATABASE_URL.replace(/:([^:@]+)@/, ':****@');
    sysLog('Database Config Loaded', { detail: `Source: DATABASE_URL | URL: ${maskedUrl}` });

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

  sysLog('Database Config Loaded', { detail: `Source: Explicit | Host: ${host}:${port} | User: ${user} | DB: ${dbName}` });

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
    sysLog('Database Connection Maintenance', { detail: 'Pool already active' });
    return pool;
  }

  const config = getDatabaseConfig();

  // Retry logic for initial connection
  let retries = 10;
  const FIRST_RETRY_DELAY = 30000; // 30s for first retry (give DB time to wake up)
  const RETRY_DELAY = 15000; // 15s between subsequent retries

  while (retries > 0) {
    try {
      if (pool) {
        await pool.end().catch(() => { });
        databaseConnected = false;
      }

      sysLog('Database Pool Creation', { detail: `Attempt: ${11 - retries}` });
      pool = new Pool(config);

      // Handle pool errors (prevents crashes on connection loss)
      pool.on('error', (err) => {
        sysError('Database Pool Error', err);
        databaseConnected = false; // Mark as disconnected on error
        // Pool will automatically try to reconnect on next query
      });

      // Test the connection
      const host = config.host || (process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).hostname : 'unknown');
      sysLog('Database Networking', { detail: `Connecting to ${host} (Attempt ${11 - retries})` });

      // Attempt DNS lookup to debug networking issues
      try {
        const dns = await import('dns/promises');
        const addresses = await dns.lookup(host);
        sysLog('Database Networking', { detail: `Host ${host} resolved: ${JSON.stringify(addresses)}` });
      } catch (dnsErr) {
        sysLog('Database Networking Warning', { detail: `DNS lookup failed for ${host}: ${dnsErr.message}` });
      }

      const client = await pool.connect();
      sysLog('Database Connection Success', { detail: `Attempt ${11 - retries}` });
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

      sysLog('Database Connection Warning', { detail: `Attempt failed: ${error.message} | Retry in ${delay / 1000}s` });

      if (isLastAttempt) {
        sysError('Database Critical Failure', error, { detail: 'Exhausted all retries' });
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
      if (!databaseConnected) {
        databaseConnected = true;
        sysLog('Database Connection Restored', { detail: 'Link re-established' });
      }
    } catch (error) {
      if (databaseConnected) {
        databaseConnected = false;
        sysLog('Database Health Warning', { detail: `Check failed: ${error.message}` });
      }
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

    // Table for real-time active MVP holders (King of the Hill)
    // This is the single source of truth for "who is MVP right now"
    // Replaced by the KotH hourly cycle — no longer tied to the daily award history
    await pool.query(`
      CREATE TABLE IF NOT EXISTS active_mvps (
        guild_id TEXT NOT NULL,
        user_id  TEXT NOT NULL,
        rank     INTEGER NOT NULL DEFAULT 1,
        since    TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (guild_id, user_id)
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_active_mvps_guild_id ON active_mvps(guild_id);
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
        voice_valid_start BIGINT,
        PRIMARY KEY (user_id, guild_id)
      );
    `);

    // Add new columns if they don't exist (migration for existing DBs)
    await pool.query(`
      ALTER TABLE user_activity 
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
      
      // Data Integrity: Add unique constraint to prevent duplicate roles (Idempotent check)
      // Updated: Replaced strict constraint with Partial Index to allow Packs and Loot Boxes to store without colliding.
      await pool.query(`ALTER TABLE shop_items DROP CONSTRAINT IF EXISTS unique_shop_item_role`);
      await pool.query(`DROP INDEX IF EXISTS idx_unique_shop_item_role_standalone`);
      await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_shop_item_role_standalone 
        ON shop_items(guild_id, role_id) 
        WHERE (item_type != 'pack' AND is_pack = false AND item_type != 'loot_box' AND loot_box_id IS NULL);
      `);

      // Unified Image System: Store item default image at creation time
      await pool.query(`ALTER TABLE shop_items ADD COLUMN IF NOT EXISTS default_image_url TEXT`);

      // Rarity & Tradability System: Per-item rarity tier and trade eligibility flag
      await pool.query(`ALTER TABLE shop_items ADD COLUMN IF NOT EXISTS rarity TEXT DEFAULT 'common'`);
      await pool.query(`ALTER TABLE shop_items ADD COLUMN IF NOT EXISTS is_tradable BOOLEAN DEFAULT TRUE`);

      // Null-Price System: Price is now set at post-time, not creation-time
      // This drops the NOT NULL constraint so new items can be created without a price.
      // Existing items keep their prices untouched.
      await pool.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'shop_items' AND column_name = 'price'
              AND is_nullable = 'NO'
          ) THEN
            ALTER TABLE shop_items ALTER COLUMN price DROP NOT NULL;
          END IF;
        END $$;
      `);

    } catch (e) {
      sysLog('Migration Notice', { detail: `Status: ${e.message}` });
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
        last_active_at INTEGER,
        custom_title TEXT DEFAULT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_quests_guild_id ON quests(guild_id);
    `);

    // Ensure last_active_at column exists (migration for existing tables)
    await pool.query(`
      DO $$ 
      BEGIN 
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='quests' AND column_name='last_active_at') THEN 
          ALTER TABLE quests ADD COLUMN last_active_at INTEGER; 
        END IF; 
      END $$;
    `);

    // Ensure custom_title column exists (migration for existing tables)
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='quests' AND column_name='custom_title') THEN
          ALTER TABLE quests ADD COLUMN custom_title TEXT DEFAULT NULL;
        END IF;
      END $$;
    `);

    // Table for daily quest progress per user
    // Snapshot Architecture: quest_id is now decoupled from the master table to support immutability
    await pool.query(`
      CREATE TABLE IF NOT EXISTS quest_progress (
        id SERIAL PRIMARY KEY,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        quest_id INTEGER,
        quest_date DATE NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0,
        completed BOOLEAN NOT NULL DEFAULT FALSE,
        active_tracking BOOLEAN NOT NULL DEFAULT TRUE,  -- Default to true, all are tracking passively
        is_claimed BOOLEAN NOT NULL DEFAULT FALSE,    -- Still kept for safety but should be set to true at auto-claim
        completed_at TIMESTAMP WITH TIME ZONE,
        UNIQUE(guild_id, user_id, quest_id, quest_date)
      );
    `);

    // Migration: Remove Foreign Key constraint to support Snapshot Architecture
    await pool.query(`
      DO $$ 
      DECLARE
        r RECORD;
      BEGIN 
        FOR r IN 
          SELECT constraint_name 
          FROM information_schema.table_constraints 
          WHERE table_name='quest_progress' AND constraint_type='FOREIGN KEY'
        LOOP
          EXECUTE 'ALTER TABLE quest_progress DROP CONSTRAINT ' || quote_ident(r.constraint_name);
        END LOOP;
      END $$;
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
        level_channel_id TEXT,
        level_message_id TEXT,
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

    // ========== QUANTITY STACKING MIGRATION ==========
    // O(1) metadata-only operation in PostgreSQL 11+ — does NOT lock or rewrite existing rows.
    // All pre-existing rows automatically evaluate to 1 via the DEFAULT.
    await pool.query('ALTER TABLE user_inventory ADD COLUMN IF NOT EXISTS quantity INTEGER DEFAULT 1');
    await pool.query('ALTER TABLE dropped_items ADD COLUMN IF NOT EXISTS quantity INTEGER DEFAULT 1');
    // Backfill any NULLs that may exist from very old rows (safe no-op if already 1)
    await pool.query('UPDATE user_inventory SET quantity = 1 WHERE quantity IS NULL');
    await pool.query('UPDATE dropped_items SET quantity = 1 WHERE quantity IS NULL');

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

    // --- LOOT BOX MODULE TABLES ---
    await pool.query(`
      CREATE TABLE IF NOT EXISTS loot_boxes (
        id SERIAL PRIMARY KEY,
        guild_id VARCHAR(32) NOT NULL,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        image_url TEXT,
        opened_image_url TEXT,
        chance_common NUMERIC NOT NULL DEFAULT 70,
        chance_uncommon NUMERIC NOT NULL DEFAULT 20,
        chance_rare NUMERIC NOT NULL DEFAULT 5,
        chance_epic NUMERIC NOT NULL DEFAULT 0,
        chance_legendary NUMERIC NOT NULL DEFAULT 0,
        chance_coins NUMERIC NOT NULL DEFAULT 25,
        min_coins INTEGER NOT NULL DEFAULT 100,
        max_coins INTEGER NOT NULL DEFAULT 500,
        min_prizes INTEGER NOT NULL DEFAULT 1,
        max_prizes INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS loot_box_items (
        id SERIAL PRIMARY KEY,
        loot_box_id INT REFERENCES loot_boxes(id) ON DELETE CASCADE,
        reward_type VARCHAR(20) NOT NULL,
        shop_item_id INT REFERENCES shop_items(id) ON DELETE CASCADE,
        coin_amount INT DEFAULT 0,
        weight INT NOT NULL DEFAULT 10
      );
    `);

    await pool.query(`ALTER TABLE shop_items ADD COLUMN IF NOT EXISTS loot_box_id INTEGER REFERENCES loot_boxes(id) ON DELETE CASCADE`);
    await pool.query(`ALTER TABLE loot_boxes ADD COLUMN IF NOT EXISTS opened_image_url TEXT`);
    await pool.query(`ALTER TABLE loot_boxes ADD COLUMN IF NOT EXISTS chance_common NUMERIC NOT NULL DEFAULT 70`);
    await pool.query(`ALTER TABLE loot_boxes ADD COLUMN IF NOT EXISTS chance_uncommon NUMERIC NOT NULL DEFAULT 20`);
    await pool.query(`ALTER TABLE loot_boxes ADD COLUMN IF NOT EXISTS chance_rare NUMERIC NOT NULL DEFAULT 5`);
    await pool.query(`ALTER TABLE loot_boxes ADD COLUMN IF NOT EXISTS chance_epic NUMERIC NOT NULL DEFAULT 0`);
    await pool.query(`ALTER TABLE loot_boxes ADD COLUMN IF NOT EXISTS chance_legendary NUMERIC NOT NULL DEFAULT 0`);
    await pool.query(`ALTER TABLE loot_boxes ADD COLUMN IF NOT EXISTS chance_coins NUMERIC NOT NULL DEFAULT 25`);
    await pool.query(`ALTER TABLE loot_boxes ADD COLUMN IF NOT EXISTS min_coins INTEGER NOT NULL DEFAULT 100`);
    await pool.query(`ALTER TABLE loot_boxes ADD COLUMN IF NOT EXISTS max_coins INTEGER NOT NULL DEFAULT 500`);
    await pool.query(`ALTER TABLE loot_boxes ADD COLUMN IF NOT EXISTS min_prizes INTEGER NOT NULL DEFAULT 1`);
    await pool.query(`ALTER TABLE loot_boxes ADD COLUMN IF NOT EXISTS max_prizes INTEGER NOT NULL DEFAULT 1`);
    await pool.query(`ALTER TABLE loot_boxes ADD COLUMN IF NOT EXISTS items_enabled BOOLEAN NOT NULL DEFAULT TRUE`);
    await pool.query(`ALTER TABLE loot_boxes ADD COLUMN IF NOT EXISTS coins_enabled BOOLEAN NOT NULL DEFAULT TRUE`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_loot_boxes_guild ON loot_boxes(guild_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_loot_box_items_box ON loot_box_items(loot_box_id)`);

    // Master Battlepass Configuration
    await pool.query(`
      CREATE TABLE IF NOT EXISTS battlepass_config (
        guild_id VARCHAR(32) NOT NULL,
        level INT NOT NULL,
        reward_coins INT DEFAULT 0,
        reward_item_id INT REFERENCES shop_items(id) ON DELETE SET NULL,
        reward_chest_id INT REFERENCES loot_boxes(id) ON DELETE SET NULL,
        PRIMARY KEY (guild_id, level)
      );
    `);

    await pool.query(`ALTER TABLE battlepass_config ADD COLUMN IF NOT EXISTS reward_chest_id INT REFERENCES loot_boxes(id) ON DELETE SET NULL`);
    await pool.query(`ALTER TABLE battlepass_config ADD COLUMN IF NOT EXISTS reward_role_id VARCHAR(32)`);

    // Role XP Boosters (Percentage multipliers per Discord role)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS role_xp_boosters (
        guild_id VARCHAR(32) NOT NULL,
        role_id VARCHAR(32) NOT NULL,
        boost_percentage INT NOT NULL DEFAULT 50,
        PRIMARY KEY (guild_id, role_id)
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_role_xp_boosters_guild ON role_xp_boosters(guild_id)`);

    // Multi-Reward Table for Levels (supports multiple items & chests with custom quantities)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS battlepass_rewards (
        id SERIAL PRIMARY KEY,
        guild_id VARCHAR(32) NOT NULL,
        level INT NOT NULL,
        reward_type VARCHAR(20) NOT NULL,
        shop_item_id INT REFERENCES shop_items(id) ON DELETE CASCADE,
        loot_box_id INT REFERENCES loot_boxes(id) ON DELETE CASCADE,
        quantity INT NOT NULL DEFAULT 1,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (guild_id, level, reward_type, shop_item_id),
        UNIQUE (guild_id, level, reward_type, loot_box_id)
      );
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_battlepass_rewards_guild_lvl ON battlepass_rewards(guild_id, level)`);

    // Migrate existing single rewards into battlepass_rewards if not present
    await pool.query(`
      INSERT INTO battlepass_rewards (guild_id, level, reward_type, shop_item_id, quantity)
      SELECT guild_id, level, 'item', reward_item_id, 1
      FROM battlepass_config
      WHERE reward_item_id IS NOT NULL
      ON CONFLICT DO NOTHING;
    `).catch(() => {});

    await pool.query(`
      INSERT INTO battlepass_rewards (guild_id, level, reward_type, loot_box_id, quantity)
      SELECT guild_id, level, 'chest', reward_chest_id, 1
      FROM battlepass_config
      WHERE reward_chest_id IS NOT NULL
      ON CONFLICT DO NOTHING;
    `).catch(() => {});

    // User Claim History (Anti-Exploit)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_pass_claims (
        user_id VARCHAR(32) NOT NULL,
        guild_id VARCHAR(32) NOT NULL,
        level_claimed INT NOT NULL,
        claimed_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (user_id, guild_id, level_claimed)
      );
    `);

    await pool.query(`ALTER TABLE user_activity ADD COLUMN IF NOT EXISTS battlepass_xp NUMERIC(14, 2) NOT NULL DEFAULT 0`);
    await pool.query(`ALTER TABLE user_activity ALTER COLUMN battlepass_xp TYPE NUMERIC(14, 2) USING battlepass_xp::NUMERIC(14, 2)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_activity_bp_xp ON user_activity(guild_id, battlepass_xp)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_battlepass_config_guild ON battlepass_config(guild_id, level)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_pass_claims_user ON user_pass_claims(guild_id, user_id)`);

    // Self-healing migration: Fix legacy chest rows in user_inventory
    await pool.query(`
      UPDATE user_inventory ui
      SET shop_item_id = si.id,
          role_id = si.role_id,
          source = 'LEVEL',
          purchase_source = 'level'
      FROM shop_items si
      WHERE ui.shop_item_id IS NULL
        AND ui.role_id LIKE 'CHEST_%'
        AND si.loot_box_id = NULLIF(SUBSTRING(ui.role_id FROM 7), '')::INTEGER
        AND si.guild_id = ui.guild_id;
    `).catch(() => {});

    // Purge any orphaned user_inventory ghost rows whose shop_item_id no longer exists
    await pool.query(`
      DELETE FROM user_inventory 
      WHERE (shop_item_id IS NULL OR shop_item_id NOT IN (SELECT id FROM shop_items))
        AND (role_id NOT LIKE 'CHEST_%' OR role_id IS NULL);
    `).catch(() => {});

    // User DM Notification Settings (Server-Specific, Opt-in)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_notification_settings (
        guild_id VARCHAR(32) NOT NULL,
        user_id VARCHAR(32) NOT NULL,
        notif_level_up BOOLEAN DEFAULT FALSE,
        notif_daily_claim BOOLEAN DEFAULT FALSE,
        notif_trades BOOLEAN DEFAULT FALSE,
        notif_mvp_win BOOLEAN DEFAULT FALSE,
        notif_quests_refresh BOOLEAN DEFAULT FALSE,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        PRIMARY KEY (guild_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_user_notif_guild ON user_notification_settings(guild_id);
    `);

    // Level Leaderboard migration
    await pool.query(`ALTER TABLE leaderboard_config ADD COLUMN IF NOT EXISTS level_channel_id TEXT`).catch(() => {});
    await pool.query(`ALTER TABLE leaderboard_config ADD COLUMN IF NOT EXISTS level_message_id TEXT`).catch(() => {});

    // Self-healing migration: Purge legacy interface appearance customizations
    await pool.query(`
      UPDATE guild_configs
      SET config = config - 'interface_title' - 'interface_emoji' - 'interface_color' - 'interface_image_url'
      WHERE config ? 'interface_title' OR config ? 'interface_emoji' OR config ? 'interface_color' OR config ? 'interface_image_url'
    `).catch(() => {});

    sysLog('Infrastructure Audit', { detail: 'Database tables initialized' });

    // Run cleanup on startup (non-blocking)
    setImmediate(() => {
      cleanupOldData().catch(error => {
        sysError('Background Cleanup Failed', error);
      });
    });
  } catch (error) {
    sysError('Infrastructure Setup Failed', error, { detail: 'Table Creation' });
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
      sysLog('Maintenance Cleanup', { detail: `Purged ${transactionResult.rowCount} old transactions` });
    }

    // Clean inactive user activity (users with 0 activity in guilds that haven't awarded MVP in 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const activityResult = await pool.query(`
      DELETE FROM user_activity 
      WHERE message_count = 0 
        AND voice_minutes = 0 
        AND (battlepass_xp = 0 OR battlepass_xp IS NULL)
        AND last_active < $1
    `, [thirtyDaysAgo]);

    if (activityResult.rowCount > 0) {
      sysLog('Maintenance Cleanup', { detail: `Purged ${activityResult.rowCount} inactive records` });
    }

  } catch (error) {
    sysError('Maintenance Cleanup Failed', error);
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
    sysLog('Database Closed', { detail: 'Link terminated' });
  }
}

/**
 * Execute a query with error handling
 */
export async function query(text, params) {
  try {
    const result = await pool.query(text, params);
    databaseConnected = true;
    return result;
  } catch (error) {
    sysError('Database Query Error', error, { detail: text.substring(0, 100) });
    throw error;
  }
}
