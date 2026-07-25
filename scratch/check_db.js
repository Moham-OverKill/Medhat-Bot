import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';
dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function main() {
  const res = await pool.query('SELECT id, name, description FROM shop_items');
  console.log(JSON.stringify(res.rows, null, 2));
  await pool.end();
}

main().catch(console.error);
