import { query, initializeDatabase } from '../storage/postgres.js';

async function migrate() {
  try {
    console.log('Connecting to DB...');
    await initializeDatabase();
    
    console.log('Starting Shop V2 Migration...');

    // 1. Allow nullable category_id
    await query('ALTER TABLE shop_items ALTER COLUMN category_id DROP NOT NULL');
    console.log('1. category_id is now nullable.');

    // 2. Add is_pack column
    await query('ALTER TABLE shop_items ADD COLUMN IF NOT EXISTS is_pack BOOLEAN DEFAULT FALSE');
    console.log('2. is_pack column added.');

    // 3. Add contents column
    await query('ALTER TABLE shop_items ADD COLUMN IF NOT EXISTS contents JSONB DEFAULT \'[]\'::jsonb');
    console.log('3. contents column added.');

    // 4. Remove type from shop_categories
    // Note: We might want to check if it exists first, but DROP COLUMN IF EXISTS is safe
    await query('ALTER TABLE shop_categories DROP COLUMN IF EXISTS type');
    console.log('4. type column removed from shop_categories.');
    
    // 5. Migration for role_ids (Optional: if we want to strictly use array column)
    // For now, we will rely on the existing role_id column being capable of string storage
    // but we will migrate existing 'pack' items to set is_pack = true
    await query("UPDATE shop_items SET is_pack = true WHERE item_type = 'pack'");
    console.log('5. Existing packs updated (is_pack = true).');

    console.log('Migration Complete.');
    process.exit(0);
  } catch (error) {
    console.error('Migration Failed:', error);
    process.exit(1);
  }
}

migrate();
