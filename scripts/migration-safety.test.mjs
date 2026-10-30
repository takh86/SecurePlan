import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { verifyRecordedTestTarget } from './disposable-test-target.mjs';

let client;
before(async () => {
  await verifyRecordedTestTarget();
  client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
  await client.connect();
});
after(async () => { await client?.end(); });
const migrations = fileURLToPath(new URL('../apps/backend/migrations/', import.meta.url));
const ledger = async () => (await client.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows;

function runnerCopy() {
  // Only copies are edited. Applied repository migrations remain immutable.
  const root = mkdtempSync(join(tmpdir(), 'secureplan-migration-proof-'));
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'apps/backend'), { recursive: true });
  cpSync(migrations, join(root, 'apps/backend/migrations'), { recursive: true });
  const runner = join(root, 'scripts/migrate.mjs');
  const original = readFileSync(new URL('./migrate.mjs', import.meta.url), 'utf8');
  // Resolve pg in the original installation; copied runner logic is unchanged.
  assert.ok(original.includes('import pg from "pg";'));
  writeFileSync(runner, original.replace('import pg from "pg";', `import pg from ${JSON.stringify(import.meta.resolve('pg'))};`));
  return { root, runner };
}
function run(runner) {
  return spawnSync(process.execPath, [runner], { env: process.env, encoding: 'utf8', timeout: 15_000 });
}

test('migration replay preserves every applied checksum and ledger row', async () => {
  const beforeRows = await ledger(); assert.ok(beforeRows.some((row) => row.name === '0010_employee_availability.sql'));
  for (const row of beforeRows) {
    const expected = createHash('sha256').update(readFileSync(join(migrations, row.name), 'utf8')).digest('hex');
    assert.equal(row.checksum, expected);
  }
  const { runner } = runnerCopy(); assert.equal(run(runner).status, 0);
  assert.deepEqual(await ledger(), beforeRows);
});
test('runner refuses a modified copy of an applied migration without touching the ledger', async () => {
  const beforeRows = await ledger(); const { root, runner } = runnerCopy();
  const copy = join(root, 'apps/backend/migrations/0010_employee_availability.sql');
  writeFileSync(copy, `${readFileSync(copy, 'utf8')}\n-- synthetic checksum mismatch\n`);
  const result = run(runner); assert.equal(result.status, 1); assert.match(result.stderr, /Migration failed/);
  assert.deepEqual(await ledger(), beforeRows);
});
test('a failing forward migration rolls back DDL, data and its ledger entry', async () => {
  const beforeRows = await ledger(); const { root, runner } = runnerCopy();
  const table = `sp10_migration_probe_${randomUUID().replaceAll('-', '')}`;
  const name = '9999_synthetic_failure.sql';
  writeFileSync(join(root, 'apps/backend/migrations', name),
    `CREATE TABLE ${table} (id integer PRIMARY KEY); INSERT INTO ${table} VALUES (1); SELECT 1/0;`);
  const result = run(runner); assert.equal(result.status, 1); assert.match(result.stderr, /Migration failed/);
  assert.equal((await client.query('SELECT to_regclass($1) AS relation', [table])).rows[0].relation, null);
  assert.deepEqual(await ledger(), beforeRows);
});
