/** Development-only rehearsal. Refuses anything except a verified, empty disposable target. */
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { verifyRecordedTestTarget } from './disposable-test-target.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const execute = promisify(execFile);
try {
  await verifyRecordedTestTarget();
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    const tables = await client.query("SELECT 1 FROM pg_tables WHERE schemaname = 'public' LIMIT 1");
    if (tables.rowCount) throw new Error('Empty disposable target required');
    await client.query(`CREATE TABLE schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const directory = new URL('../apps/backend/migrations/', import.meta.url);
    for (const name of (await readdir(directory)).filter((n) => /^00(0[1-9]|1[0-3])_.*\.sql$/.test(n)).sort()) {
      const sql = await readFile(new URL(name, directory), 'utf8');
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(name, checksum) VALUES ($1, $2)',
        [name, createHash('sha256').update(sql).digest('hex')]);
      await client.query('COMMIT');
      console.log(`Applied pre-A1: ${name}`);
    }
  } finally { await client.end(); }
  // The test commits legacy fixtures before invoking the normal migration runner.
  // It snapshots rows, checks read-only inventory, bootstraps and uses real HTTP.
  const result = await execute(process.execPath, ['scripts/verified-test-command.mjs', 'e2e',
    'legacy-calendar-bootstrap-real', '--maxWorkers=1'], { cwd: root, timeout: 120000 });
  process.stdout.write(result.stdout);
  const verified = await execute(process.execPath, ['scripts/verify-db.mjs'], { cwd: root, timeout: 30000 });
  process.stdout.write(verified.stdout);
} catch {
  // Child/database diagnostics may contain connection details. Preserve fail-closed output.
  console.error('A1 rehearsal failed. Use a fresh verified disposable target; run the focused E2E command for test diagnostics.');
  process.exitCode = 1;
}
