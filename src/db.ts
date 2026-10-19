import { Pool, types } from 'pg';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// BIGINT -> number. Safe because the API caps every value at 1e12.
types.setTypeParser(20, (v) => parseInt(v, 10));

export function createPool(url: string, max = 20): Pool {
  return new Pool({ connectionString: url, max });
}

export async function waitForDb(pool: Pool, tries = 40): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try { await pool.query('SELECT 1'); return; }
    catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
  throw new Error('Database not reachable');
}

export async function migrate(pool: Pool): Promise<void> {
  const sql = readFileSync(path.join(__dirname, '..', 'db', 'init.sql'), 'utf8');
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock(7101)'); // serialize concurrent starts
    await c.query(sql);
  } finally {
    await c.query('SELECT pg_advisory_unlock(7101)').catch(() => {});
    c.release();
  }
}
