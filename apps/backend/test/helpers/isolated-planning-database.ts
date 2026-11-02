/** DDL tests need their own database, not only rolled-back DDL on shared tables. */
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { openLocalTestPool } from './synthetic-tenants.js';

/** Called after the mandatory disposable-target globalSetup, on that same cluster. */
export async function isolatedPlanningDatabase() {
  const admin = openLocalTestPool(2);
  // This identifier is generated here, never supplied by the environment/user.
  const name = `sp79_schema_${randomBytes(10).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${name}`;
  const connectionString = url.href;
  const pool = new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 5000 });
  const close = async () => {
    await pool.end();
    try { await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); } finally { await admin.end(); }
  };
  try {
    const dir = fileURLToPath(new URL('../../migrations/', import.meta.url));
    const client = await pool.connect();
    try {
      for (const file of readdirSync(dir).filter((file) => /^\d+.*\.sql$/.test(file)).sort()) {
        await client.query('BEGIN');
        await client.query(readFileSync(`${dir}/${file}`, 'utf8'));
        await client.query('COMMIT');
      }
    } finally { client.release(); }
    return { pool, connectionString, close };
  } catch (error) {
    await close();
    throw error;
  }
}
