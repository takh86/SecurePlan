/** D18 catalog/DDL proofs on a separate database of the verified disposable PG17 cluster. */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { DatabaseService } from '../src/database/database.service.js';
import type { TenantContext } from '../src/auth/authorization/tenant-context.js';
import { MonthlyPlansService } from '../src/modules/planning/monthly-plans.service.js';
import { EmployeeMonthService } from '../src/modules/planning/employee-month.service.js';
import {
  assertPlanningSchemaComplete,
  PlanningSchemaError,
} from '../src/modules/planning/planning-schema.js';
import { isolatedPlanningDatabase } from './helpers/isolated-planning-database.js';
import { dutyMutationFixture } from './helpers/duty-mutation-fixtures.js';
import {
  bootEmployeesApp,
  RecordingDelivery,
} from './helpers/employees-test-app.js';
import { backendPid, waitUntilBlockedBy } from './helpers/synthetic-tenants.js';

let db: Awaited<ReturnType<typeof isolatedPlanningDatabase>>;
beforeAll(async () => {
  db = await isolatedPlanningDatabase();
}, 30000);
afterAll(async () => {
  await db?.close();
});

it.each(
  (['list', 'listEntries', 'getEntry', 'employeeMonth'] as const).flatMap(
    (method) =>
      (['COMMIT', 'ROLLBACK'] as const).map((finish) => ({ method, finish })),
  ),
)(
  '$method REPEATABLE READ observes DDL $finish after its schema protection waits',
  async ({ method, finish }) => {
    const f = await dutyMutationFixture(db.pool, []);
    const ddl = await db.pool.connect();
    let readerPid = 0;
    let readerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      readerStarted = resolve;
    });
    const database = {
      withTransaction: async <T>(work: (c: PoolClient) => Promise<T>) => {
        const c = await db.pool.connect();
        try {
          await c.query('BEGIN');
          // Reading driver identity must not establish a snapshot before SET TRANSACTION.
          readerPid = (c as unknown as { processID: number }).processID;
          readerStarted();
          const value = await work(c);
          await c.query('COMMIT');
          return value;
        } catch (error) {
          await c.query('ROLLBACK');
          throw error;
        } finally {
          c.release();
        }
      },
    } as DatabaseService;
    const app = await bootEmployeesApp(new RecordingDelivery(), { database });
    try {
      await ddl.query('BEGIN');
      await ddl.query(
        'ALTER TABLE public.replacement_offers ADD COLUMN stale_catalog_probe text',
      );
      const blockerPid = await backendPid(ddl);
      const service = app.get(MonthlyPlansService);
      const tenant: TenantContext = {
        companyId: f.tenant.companyId,
        accountId: f.tenant.admin.accountId,
        sessionId: randomUUID(),
        role: 'COMPANY_ADMIN',
      };
      const operation =
        method === 'list'
          ? service.list(tenant, {})
          : method === 'listEntries'
            ? service.listEntries(tenant, f.planId, {})
            : method === 'employeeMonth'
              ? app
                  .get(EmployeeMonthService)
                  .read(tenant, f.planId, f.mira.employeeId)
              : service.getEntry(tenant, f.planId, f.dutyId);
      const result = operation.then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      await started;
      await waitUntilBlockedBy(db.pool, readerPid, blockerPid);
      await ddl.query(finish);
      const outcome = await result;
      if (finish === 'COMMIT') {
        expect(outcome.error).toBeInstanceOf(PlanningSchemaError);
        expect(outcome.value).toBeUndefined();
      } else {
        expect(outcome.error).toBeUndefined();
        expect(outcome.value).toBeDefined();
      }
    } finally {
      await ddl.query('ROLLBACK');
      ddl.release();
      await app.close();
      await db.pool.query(
        'ALTER TABLE public.replacement_offers DROP COLUMN IF EXISTS stale_catalog_probe',
      );
    }
  },
  30000,
);

it('holds ACCESS SHARE on all eight canonical tables through commit and blocks offer-table DDL', async () => {
  const reader = await db.pool.connect(),
    ddl = await db.pool.connect();
  try {
    await reader.query('BEGIN');
    await assertPlanningSchemaComplete(reader);
    const pid = await backendPid(reader),
      ddlPid = await backendPid(ddl);
    const locks = (
      await db.pool.query<{ name: string }>(
        `SELECT c.relname AS name FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
       WHERE l.pid=$1 AND l.mode='AccessShareLock' AND l.granted AND c.relname=ANY($2::text[]) ORDER BY c.relname`,
        [
          pid,
          [
            'monthly_plans',
            'duties',
            'plan_assignments',
            'edit_leases',
            'project_operating_calendars',
            'cancellation_requests',
            'replacement_needs',
            'replacement_offers',
          ],
        ],
      )
    ).rows;
    expect(locks).toHaveLength(8);
    await ddl.query('BEGIN');
    const alter = ddl.query(
      'ALTER TABLE public.replacement_offers ADD COLUMN lock_probe text',
    );
    await waitUntilBlockedBy(db.pool, ddlPid, pid);
    await reader.query('COMMIT');
    await alter;
    await ddl.query('ROLLBACK');
  } finally {
    await reader.query('ROLLBACK');
    await ddl.query('ROLLBACK');
    reader.release();
    ddl.release();
  }
});
