/** DDL tests need their own database, not only rolled-back DDL on shared tables. */
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { openLocalTestPool } from './synthetic-tenants.js';

/** Called after the mandatory disposable-target globalSetup, on that same cluster. */
export async function isolatedPlanningDatabase(beforeMigration?: (pool: pg.Pool, filename: string) => Promise<void>) {
  const admin = openLocalTestPool(2);
  // This identifier is generated here, never supplied by the environment/user.
  const name = `sp79_schema_${randomBytes(10).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${name}`;
  const connectionString = url.href;
  const pool = new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 5000 });
  const close = async () => {
    try {
      // Never terminate active test connections with DROP DATABASE ... FORCE:
      // PostgreSQL reports 57P01 to their clients, which becomes an unhandled
      // error in Vitest even when individual assertions have passed.
      await pool.end();
      const sessions = await admin.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname = $1',
        [name],
      );
      if (Number(sessions.rows[0].count) !== 0) {
        throw new Error('Isolated planning database still has active connections after pool shutdown');
      }
      // Normal DROP is intentionally strict: unexpected clients must be
      // diagnosed and closed, never killed in order to make a test go green.
      await admin.query(`DROP DATABASE ${name}`);
    } finally {
      await admin.end();
    }
  };
  try {
    const dir = fileURLToPath(new URL('../../migrations/', import.meta.url));
    const client = await pool.connect();
    try {
      for (const file of readdirSync(dir).filter((file) => /^\d+.*\.sql$/.test(file)).sort()) {
        await beforeMigration?.(pool, file);
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
