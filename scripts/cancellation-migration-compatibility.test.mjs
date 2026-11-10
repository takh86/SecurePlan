/** Real staged migration-runner proof on an isolated database of the verified disposable cluster. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  copyFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { verifyRecordedTestTarget } from './disposable-test-target.mjs';

test('populated D15 -> D16 -> D17 through actual migration runner preserves receipts and second-pass checksums', async () => {
  await verifyRecordedTestTarget();
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  const name = `sp16_upgrade_${randomBytes(10).toString('hex')}`;
  const isolatedUrl = new URL(process.env.DATABASE_URL);
  isolatedUrl.pathname = `/${name}`;
  let c;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    const scratch = mkdtempSync(
      join(tmpdir(), 'secureplan-cancellation-upgrade-'),
    );
    mkdirSync(join(scratch, 'scripts'));
    mkdirSync(join(scratch, 'apps/backend/migrations'), { recursive: true });
    const migrationDir = fileURLToPath(
      new URL('../apps/backend/migrations/', import.meta.url),
    );
    const files = readdirSync(migrationDir)
      .filter((f) => /^\d+.*\.sql$/.test(f))
      .sort();
    const runner = join(scratch, 'scripts/migrate.mjs');
    writeFileSync(
      runner,
      readFileSync(new URL('./migrate.mjs', import.meta.url), 'utf8').replace(
        'import pg from "pg";',
        `import pg from ${JSON.stringify(import.meta.resolve('pg'))};`,
      ),
    );
    const run = () => {
      const r = spawnSync(process.execPath, [runner], {
        env: { ...process.env, DATABASE_URL: isolatedUrl.href },
        encoding: 'utf8',
        timeout: 30000,
      });
      assert.equal(r.status, 0, 'staged migration runner succeeds');
    };
    for (const file of files.filter((f) => Number(f.slice(0, 4)) <= 15))
      copyFileSync(
        join(migrationDir, file),
        join(scratch, 'apps/backend/migrations', file),
      );
    run();
    c = new pg.Client({ connectionString: isolatedUrl.href });
    await c.connect();
    const company = randomUUID(),
      adminId = randomUUID(),
      account = randomUUID(),
      employee = randomUUID(),
      project = randomUUID(),
      plan = randomUUID();
    await c.query(
      "INSERT INTO companies(id,name,status,time_zone) VALUES($1,'Synthetic cancellation upgrade','ACTIVE','Europe/Berlin')",
      [company],
    );
    for (const [id, role] of [
      [adminId, 'COMPANY_ADMIN'],
      [account, 'EMPLOYEE'],
    ])
      await c.query(
        "INSERT INTO accounts(id,company_id,email,account_scope,role,status,password_hash) VALUES($1,$2,$3,'TENANT',$4,'ACTIVE','synthetic-unverified-hash')",
        [id, company, `${id}@example.invalid`, role],
      );
    await c.query(
      "INSERT INTO employees(id,company_id,account_id,employee_number,first_name,last_name,shift_eligibility) VALUES($1,$2,$3,'SYN-1','Synthetic','Upgrade','BOTH')",
      [employee, company, account],
    );
    await c.query(
      "INSERT INTO projects(id,company_id,name,status) VALUES($1,$2,'Synthetic upgrade','ACTIVE')",
      [project, company],
    );
    await c.query(
      "INSERT INTO monthly_plans(id,company_id,project_id,planning_month,status,published_at,published_by_account_id) VALUES($1,$2,$3,'2027-01-01','PUBLISHED','2026-11-01T12:00:00Z',$4)",
      [plan, company, project, adminId],
    );
    const receipt = {
      commandId: randomUUID(),
      outcome: 'NO_OP',
      completedAt: '2026-11-04T12:00:00.123456Z',
      plan: {
        id: plan,
        projectId: project,
        monthStart: '2027-01-01',
        status: 'PUBLISHED',
        publishedAt: '2026-11-01T12:00:00Z',
      },
      employeeId: employee,
      counts: {
        createdDuties: 0,
        changedDuties: 0,
        addedMemberships: 0,
        removedMemberships: 0,
        updatedMemberships: 0,
      },
      changes: [],
    };
    for (const operation of ['INITIAL_PUBLISH', 'EMPLOYEE_MONTH_SAVE'])
      for (const state of ['IN_PROGRESS', 'FAILED', 'COMPLETED'])
        await c.query(
          `INSERT INTO idempotency_records(company_id,actor_account_id,operation,key_hash,request_hash,state,result_plan_id,completed_at,expires_at,context_plan_id,context_employee_id,result_json,result_schema_version)
    VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $6='COMPLETED' THEN clock_timestamp() END,clock_timestamp()+interval '24 hours',$8,$9,$10::jsonb,$11)`,
          [
            company,
            adminId,
            operation,
            randomBytes(32),
            randomBytes(32),
            state,
            state === 'COMPLETED' ? plan : null,
            operation === 'EMPLOYEE_MONTH_SAVE' ? plan : null,
            operation === 'EMPLOYEE_MONTH_SAVE' ? employee : null,
            operation === 'EMPLOYEE_MONTH_SAVE' && state === 'COMPLETED'
              ? JSON.stringify(receipt)
              : null,
            operation === 'EMPLOYEE_MONTH_SAVE' && state === 'COMPLETED'
              ? 2
              : null,
          ],
        );
    const old = await c.query(
      'SELECT to_jsonb(r)::text AS bytes FROM idempotency_records r ORDER BY id',
    );
    const signature = async () =>
      (
        await c.query(
          "SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='public.idempotency_records'::regclass ORDER BY conname",
        )
      ).rows;
    const d15 = await signature();
    copyFileSync(
      join(migrationDir, '0016_cr03_reconciliation.sql'),
      join(scratch, 'apps/backend/migrations/0016_cr03_reconciliation.sql'),
    );
    run();
    assert.deepEqual(
      (
        await c.query(
          'SELECT to_jsonb(r)::text AS bytes FROM idempotency_records r ORDER BY id',
        )
      ).rows,
      old.rows,
    );
    assert.deepEqual(await signature(), d15);
    copyFileSync(
      join(migrationDir, '0017_cancellation_idempotency.sql'),
      join(
        scratch,
        'apps/backend/migrations/0017_cancellation_idempotency.sql',
      ),
    );
    run();
    assert.deepEqual(
      (
        await c.query(
          "SELECT (to_jsonb(r)-'result_cancellation_request_id')::text AS bytes FROM idempotency_records r ORDER BY id",
        )
      ).rows,
      old.rows,
    );
    assert.deepEqual(
      (
        await c.query(
          "SELECT result_json FROM idempotency_records WHERE operation='EMPLOYEE_MONTH_SAVE' AND state='COMPLETED'",
        )
      ).rows[0].result_json,
      receipt,
    );
    const ledger = (
      await c.query('SELECT name,checksum FROM schema_migrations ORDER BY name')
    ).rows;
    assert.equal(ledger.length, 17);
    run();
    assert.deepEqual(
      (
        await c.query(
          'SELECT name,checksum FROM schema_migrations ORDER BY name',
        )
      ).rows,
      ledger,
    );
    for (const row of ledger)
      assert.equal(
        row.checksum,
        createHash('sha256')
          .update(readFileSync(join(migrationDir, row.name)))
          .digest('hex'),
      );
    const d17 = (await c.query('SELECT to_jsonb(r)::text AS bytes FROM idempotency_records r ORDER BY id')).rows;
    copyFileSync(join(migrationDir, '0018_replacement_offers.sql'), join(scratch, 'apps/backend/migrations/0018_replacement_offers.sql'));
    run();
    assert.deepEqual((await c.query("SELECT (to_jsonb(r)-'result_replacement_offer_id')::text AS bytes FROM idempotency_records r ORDER BY id")).rows, d17);
    const d18 = (await c.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows;
    assert.equal(d18.length, 18);
    run();
    assert.deepEqual((await c.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows, d18);
    // SP-21 S1: populated D18 -> D19 -> D20 keeps every historical receipt byte-identical.
    for (const file of ['0019_replacement_selection.sql', '0020_cancellation_decision_receipt.sql'])
      copyFileSync(join(migrationDir, file), join(scratch, 'apps/backend/migrations', file));
    run();
    assert.deepEqual((await c.query("SELECT (to_jsonb(r)-'result_replacement_offer_id')::text AS bytes FROM idempotency_records r ORDER BY id")).rows, d17);
    const d20 = (await c.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows;
    assert.equal(d20.length, 20);
    run();
    assert.deepEqual((await c.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows, d20);
    for (const row of d20)
      assert.equal(row.checksum, createHash('sha256').update(readFileSync(join(migrationDir, row.name))).digest('hex'));
    const verified = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./verify-db.mjs', import.meta.url))],
      {
        env: { ...process.env, DATABASE_URL: isolatedUrl.href },
        encoding: 'utf8',
        timeout: 15000,
      },
    );
    assert.equal(
      verified.status,
      0,
      'database verification after populated D17 -> D20',
    );
  } finally {
    await c?.end();
    const remaining = await admin.query(
      'SELECT 1 FROM pg_database WHERE datname=$1',
      [name],
    );
    if (remaining.rowCount) await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  }
});
