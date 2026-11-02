import pg from 'pg';
import { readFile } from 'node:fs/promises';
export function createPool() {
  return new pg.Pool({ max: 10, connectionTimeoutMillis: 10000, statement_timeout: 30000,
    ...(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {}) });
}
export async function migrate(pool) { await pool.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8')); }
export async function transaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
