/** CR-03 prerequisite only: real HTTP/PG17; workflow creation is synthetic fixture SQL. */
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { PoolClient } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import {
  BusinessAuditService,
  type BusinessAuditEntry,
  type BusinessAuditAction,
} from '../src/modules/audit/business-audit.service.js';
import { DatabaseService } from '../src/database/database.service.js';
import { PlanningMutationDispatcher } from '../src/common/transactions/planning-mutation.js';
import type { SaveEmployeeMonth } from '../src/modules/planning/employee-month.contract.js';
import {
  bootEmployeesApp,
  RecordingDelivery,
  ORIGIN,
} from './helpers/employees-test-app.js';
import {
  dutyMutationFixture,
  dutyPath,
  MUTATION_MONTH,
  MUTATION_NOW,
  type DutyMutationFixture,
} from './helpers/duty-mutation-fixtures.js';
import {
  openLocalTestPool,
  removeSyntheticTenants,
  backendPid,
  waitUntilBlockedBy,
  type TestPool,
} from './helpers/synthetic-tenants.js';
import {
  insertDuty,
  insertMembership,
  planningState,
} from './helpers/planning-fixtures.js';

let pool: TestPool,
  app: INestApplication<App> | undefined,
  f: DutyMutationFixture;
const companies: string[] = [];
let previousOrigin: string | undefined;
let token = '';
const actions = ['CANCELLATION_OBSOLETED', 'REPLACEMENT_NEED_CLOSED'];
class FailureAfterAudit extends BusinessAuditService {
  constructor(private readonly action: BusinessAuditAction) {
    super();
  }
  override async recordBusinessAction(
    c: Pick<PoolClient, 'query'>,
    entry: BusinessAuditEntry,
  ) {
    await super.recordBusinessAction(c, entry);
    if (entry.action === this.action) await c.query('SELECT 1/0');
  }
}
async function boot(audit?: BusinessAuditService) {
  await app?.close();
  app = await bootEmployeesApp(new RecordingDelivery(), {
    clock: () => new Date(MUTATION_NOW),
    ...(audit ? { audit } : {}),
  });
}
const http = (method: 'post' | 'patch' | 'delete', path = dutyPath(f)) =>
  request(app!.getHttpServer())
    [method](path)
    .set('Origin', ORIGIN)
    .set('Cookie', f.admin.cookie)
    .set('X-CSRF-Token', f.admin.csrf);
async function lease() {
  token = (await http('post', `${dutyPath(f)}/edit-lease`).expect(200)).body
    .leaseToken;
}
const patch = (body: object) =>
  http('patch')
    .set('Expected-Version', '1')
    .set('Edit-Lease-Token', token)
    .send(body);
const remove = () =>
  http('delete').set('Expected-Version', '1').set('Edit-Lease-Token', token);
async function pair(
  c: Pick<PoolClient, 'query'>,
  options: {
    assignment?: string;
    duty?: string;
    employee?: string;
    company?: string;
    status?: string;
    needStatus?: string;
  } = {},
) {
  const cancellation = randomUUID(),
    need = randomUUID();
  const company = options.company ?? f.tenant.companyId,
    duty = options.duty ?? f.dutyId;
  const status = options.status ?? 'OPEN';
  // Terminal fixture metadata must share one database instant, including microseconds.
  const {
    rows: [clock],
  } = await c.query<{ at: string }>('SELECT clock_timestamp()::text AS at');
  await c.query(
    `INSERT INTO public.cancellation_requests
    (id,company_id,assignment_id,duty_id,employee_id,submission_version,status,decided_at,decided_by_account_id,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,1,$6,CASE WHEN $6 IN ('APPROVED','REJECTED') THEN $8::timestamptz END,
      CASE WHEN $6 IN ('APPROVED','REJECTED') THEN $7::uuid END,$8::timestamptz,$8::timestamptz)`,
    [
      cancellation,
      company,
      options.assignment ?? f.membership,
      duty,
      options.employee ?? f.mira.employeeId,
      status,
      f.tenant.admin.accountId,
      clock.at,
    ],
  );
  await c.query(
    `INSERT INTO public.replacement_needs(id,company_id,cancellation_request_id,duty_id,status)
    VALUES($1,$2,$3,$4,$5)`,
    [need, company, cancellation, duty, options.needStatus ?? 'OPEN'],
  );
  return { cancellation, need };
}
async function committedPair(options: Parameters<typeof pair>[1] = {}) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const ids = await pair(c, options);
    await c.query('COMMIT');
    return ids;
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    c.release();
  }
}
const workflow = async () =>
  (
    await pool.query(
      `SELECT cr.id,cr.status,rn.status AS need_status,cr.updated_at=rn.updated_at AS same_time
  FROM public.cancellation_requests cr JOIN public.replacement_needs rn ON rn.company_id=cr.company_id AND rn.cancellation_request_id=cr.id
  WHERE cr.company_id=$1 ORDER BY cr.id`,
      [f.tenant.companyId],
    )
  ).rows;
const workflowAudits = async () =>
  (
    await pool.query(
      `SELECT action,resource_id,actor_account_id,old_values,new_values,correlation_id
  FROM audit_event WHERE company_id=$1 AND action=ANY($2::text[]) ORDER BY action,resource_id`,
      [f.tenant.companyId, actions],
    )
  ).rows;
const mutation = () => ({
  companyId: f.tenant.companyId,
  actorAccountId: f.tenant.admin.accountId,
  correlationId: randomUUID(),
  cause: 'DUTY_PATCH' as const,
  changes: [{ dutyId: f.dutyId, removedAssignmentIds: [f.membership] }],
});
async function saveDraft(): Promise<SaveEmployeeMonth> {
  const r = await request(app!.getHttpServer())
    .get(
      `/api/v1/monthly-plans/${f.planId}/employee-months/${f.mira.employeeId}`,
    )
    .set('Cookie', f.admin.cookie)
    .expect(200);
  return {
    expectedPlan: {
      status: r.body.plan.status,
      publishedAt: r.body.plan.publishedAt,
    },
    expectedCreationContext: r.body.creationContextFingerprint,
    expectedCalendar:
      r.body.operatingCalendar.effective === null
        ? null
        : {
            id: r.body.operatingCalendar.effective.id,
            version: r.body.operatingCalendar.effective.version,
          },
    days: r.body.days.map(
      (d: {
        date: string;
        day: { dutyId: string; version: number } | null;
        night: { dutyId: string; version: number } | null;
      }) => ({
        date: d.date,
        expected: {
          day: d.day ? { id: d.day.dutyId, version: d.day.version } : null,
          night: d.night
            ? { id: d.night.dutyId, version: d.night.version }
            : null,
        },
        desired: { state: 'OFF' },
      }),
    ),
  };
}
const save = (body: SaveEmployeeMonth, key = randomUUID()) =>
  http(
    'post',
    `/api/v1/monthly-plans/${f.planId}/employee-months/${f.mira.employeeId}/save`,
  )
    .set('Idempotency-Key', key)
    .send(body);

beforeAll(() => {
  pool = openLocalTestPool(10);
  previousOrigin = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = ORIGIN;
});
beforeEach(async () => {
  f = await dutyMutationFixture(pool, companies);
  token = '';
  await pool.query(
    "UPDATE monthly_plans SET status='PUBLISHED',published_at=clock_timestamp(),published_by_account_id=$2 WHERE id=$1",
    [f.planId, f.tenant.admin.accountId],
  );
  await boot();
});
afterEach(async () => {
  await app?.close();
  app = undefined;
});
afterAll(async () => {
  try {
    await removeSyntheticTenants(pool, companies);
  } finally {
    await pool.end();
  }
  if (previousOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = previousOrigin;
});

it.each(['PATCH', 'DELETE'] as const)(
  'published %s atomically removes the historical assignment and reconciles exactly one pair',
  async (method) => {
    const ids = await committedPair();
    await lease();
    const r =
      method === 'PATCH'
        ? await patch({ assignments: [] }).expect(200)
        : await remove().expect(204);
    expect(await workflow()).toEqual([
      {
        id: ids.cancellation,
        status: 'OBSOLETE',
        need_status: 'CLOSED',
        same_time: true,
      },
    ]);
    expect(
      (
        await pool.query('SELECT state FROM plan_assignments WHERE id=$1', [
          f.membership,
        ])
      ).rows[0].state,
    ).toBe('REMOVED');
    const audits = await workflowAudits();
    expect(audits.map((a) => a.action)).toEqual(actions);
    for (const audit of audits) {
      expect(audit.actor_account_id).toBe(f.tenant.admin.accountId);
      expect(audit.correlation_id).toBe(r.headers['x-correlation-id']);
      expect(audit.old_values).toEqual({ status: 'OPEN' });
    }
  },
);

it.each([
  { dutyDate: '2027-01-21' },
  { shiftKind: 'NIGHT' },
  { assignments: 'ROLE' },
] as const)(
  'retained assignment edit %j preserves OPEN cancellation and OPEN need',
  async (change) => {
    await committedPair();
    await lease();
    const body =
      'assignments' in change && change.assignments === 'ROLE'
        ? {
            assignments: [
              { employeeId: f.mira.employeeId, dutyRole: 'SHIFT_LEAD' },
            ],
          }
        : change;
    await patch(body).expect(200);
    expect((await workflow())[0]).toMatchObject({
      status: 'OPEN',
      need_status: 'OPEN',
    });
    expect(await workflowAudits()).toEqual([]);
  },
);

it('mixed roster removal affects only the removed employee and preserves terminal cases including APPROVED/OPEN_UNFILLED', async () => {
  const other = await insertMembership(
    pool,
    f.tenant.companyId,
    f.dutyId,
    f.jonas.employeeId,
  );
  const retained = await committedPair({
    assignment: other,
    employee: f.jonas.employeeId,
  });
  const removed = await committedPair();
  for (const status of ['WITHDRAWN', 'REJECTED', 'APPROVED', 'OBSOLETE']) {
    await committedPair({
      status,
      needStatus: status === 'APPROVED' ? 'OPEN_UNFILLED' : 'CLOSED',
    });
  }
  const before = await workflow();
  await lease();
  await patch({
    assignments: [{ employeeId: f.jonas.employeeId, dutyRole: 'EMPLOYEE' }],
  }).expect(200);
  const after = await workflow();
  for (const row of before)
    if (row.id !== removed.cancellation)
      expect(after.find((x) => x.id === row.id)).toEqual(row);
  expect(after.find((x) => x.id === retained.cancellation)?.status).toBe(
    'OPEN',
  );
  expect(await workflowAudits()).toHaveLength(2);
});

it.each([
  'CANCELLATION_OBSOLETED',
  'REPLACEMENT_NEED_CLOSED',
  'DUTY_UPDATED',
] as const)(
  'failure after real %s audit rolls back planning, workflow, version and audits',
  async (action) => {
    await committedPair();
    await boot(new FailureAfterAudit(action));
    await lease();
    const before = await planningState(pool, f.tenant.companyId),
      wf = await workflow();
    const r = await patch({ assignments: [] }).expect(500);
    expect(r.body.code).toBe('INTERNAL_ERROR');
    expect(await planningState(pool, f.tenant.companyId)).toEqual(before);
    expect(await workflow()).toEqual(wf);
    expect(await workflowAudits()).toEqual([]);
  },
);

it('inconsistent OPEN cancellation/CLOSED need fails as a technical integrity error and rolls everything back', async () => {
  await committedPair({ needStatus: 'CLOSED' });
  await lease();
  const before = await planningState(pool, f.tenant.companyId);
  expect((await patch({ assignments: [] }).expect(500)).body.code).toBe(
    'INTERNAL_ERROR',
  );
  expect(await planningState(pool, f.tenant.companyId)).toEqual(before);
  expect((await workflow())[0]).toMatchObject({
    status: 'OPEN',
    need_status: 'CLOSED',
  });
});

it('tenant-scoped repeated handler calls produce exactly one transition audit pair', async () => {
  await committedPair();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      'SELECT id FROM duties WHERE company_id=$1 AND id=$2 FOR UPDATE',
      [f.tenant.companyId, f.dutyId],
    );
    await c.query(
      "UPDATE plan_assignments SET state='REMOVED',removed_at=clock_timestamp() WHERE id=$1",
      [f.membership],
    );
    const dispatcher = app!.get(PlanningMutationDispatcher),
      event = mutation();
    await dispatcher.dispatch(c, { ...event, companyId: f.foreign.companyId });
    expect(await workflowAudits()).toHaveLength(0);
    await dispatcher.dispatch(c, event);
    await dispatcher.dispatch(c, event);
    await c.query('COMMIT');
    expect(await workflowAudits()).toHaveLength(2);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});

it('employee-month batch reconciles every removal before any planning audit, preserving receipt replay', async () => {
  const secondDuty = await insertDuty(pool, {
    companyId: f.tenant.companyId,
    projectId: f.project.projectId,
    planId: f.planId,
    month: MUTATION_MONTH,
    dutyDate: '2027-01-21',
    startsAt: '2027-01-21T05:00:00Z',
    endsAt: '2027-01-21T17:00:00Z',
  });
  const secondAssignment = await insertMembership(
    pool,
    f.tenant.companyId,
    secondDuty,
    f.mira.employeeId,
  );
  await committedPair();
  await committedPair({ assignment: secondAssignment, duty: secondDuty });
  class InspectAudit extends BusinessAuditService {
    override async recordBusinessAction(
      c: Pick<PoolClient, 'query'>,
      entry: BusinessAuditEntry,
    ) {
      if (entry.companyId === f.tenant.companyId) {
        const rows = (
          await c.query(
            'SELECT status FROM cancellation_requests WHERE company_id=$1',
            [entry.companyId],
          )
        ).rows;
        expect(rows).toHaveLength(2);
        expect(rows.every((r) => r.status === 'OBSOLETE')).toBe(true);
      }
      await super.recordBusinessAction(c, entry);
    }
  }
  await boot(new InspectAudit());
  const body = await saveDraft(),
    key = randomUUID();
  const r = await save(body, key).expect(200);
  expect(r.body.counts.removedMemberships).toBe(2);
  expect(
    (await workflow()).every(
      (r) => r.status === 'OBSOLETE' && r.need_status === 'CLOSED',
    ),
  ).toBe(true);
  expect(await workflowAudits()).toHaveLength(4);
  await save(body, key).expect(200);
  expect(await workflowAudits()).toHaveLength(4);
});

it('batch failure after reconciliation and planning audit rolls back every duty and receipt completion', async () => {
  await committedPair();
  await boot(new FailureAfterAudit('DUTY_UPDATED'));
  const before = await planningState(pool, f.tenant.companyId),
    wf = await workflow(),
    body = await saveDraft();
  const key = randomUUID();
  expect((await save(body, key).expect(500)).body.code).toBe('INTERNAL_ERROR');
  const after = await planningState(pool, f.tenant.companyId);
  expect(after).toEqual(before);
  expect(await workflow()).toEqual(wf);
  expect(await workflowAudits()).toEqual([]);
  const rows = (
    await pool.query(
      "SELECT state,result_json FROM idempotency_records WHERE company_id=$1 AND operation='EMPLOYEE_MONTH_SAVE'",
      [f.tenant.companyId],
    )
  ).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0].state).not.toBe('COMPLETED');
  expect(rows[0].result_json).toBeNull();
});

it.each(['COMMIT', 'ROLLBACK'] as const)(
  'two clients: synthetic cancellation holds D; PATCH waits; first %s yields coherent outcome',
  async (finish) => {
    await lease();
    const holder = await pool.connect();
    let flight: Promise<unknown> | undefined;
    try {
      await holder.query('BEGIN');
      const pid = await backendPid(holder);
      await holder.query('SELECT id FROM duties WHERE id=$1 FOR UPDATE', [
        f.dutyId,
      ]);
      await pair(holder);
      flight = patch({ assignments: [] })
        .expect(200)
        .then((r) => r);
      let waiter: number | undefined;
      for (let i = 0; i < 2000; i++) {
        const row = (
          await pool.query(
            'SELECT pid FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))',
            [pid],
          )
        ).rows[0];
        if (row) {
          waiter = row.pid;
          break;
        }
      }
      expect(waiter).toBeDefined();
      await waitUntilBlockedBy(pool, waiter!, pid);
      await holder.query(finish);
      await flight;
      if (finish === 'COMMIT')
        expect((await workflow())[0]).toMatchObject({
          status: 'OBSOLETE',
          need_status: 'CLOSED',
        });
      else expect(await workflow()).toEqual([]);
      expect(await workflowAudits()).toHaveLength(finish === 'COMMIT' ? 2 : 0);
    } finally {
      await holder.query('ROLLBACK');
      await flight;
      holder.release();
    }
  },
);

it.each(['COMMIT', 'ROLLBACK'] as const)(
  'two clients: removal holds D; fixture admission waits and rereads after %s',
  async (finish) => {
    const holder = await pool.connect(),
      waiter = await pool.connect();
    let flight: Promise<unknown> | undefined;
    try {
      await holder.query('BEGIN');
      await waiter.query('BEGIN');
      const holderPid = await backendPid(holder),
        waiterPid = await backendPid(waiter);
      await holder.query('SELECT id FROM duties WHERE id=$1 FOR UPDATE', [
        f.dutyId,
      ]);
      await holder.query(
        "UPDATE plan_assignments SET state='REMOVED',removed_at=clock_timestamp() WHERE id=$1",
        [f.membership],
      );
      flight = (async () => {
        await waiter.query('SELECT id FROM duties WHERE id=$1 FOR UPDATE', [
          f.dutyId,
        ]);
        const row = (
          await waiter.query('SELECT state FROM plan_assignments WHERE id=$1', [
            f.membership,
          ])
        ).rows[0];
        if (row.state === 'ACTIVE') await pair(waiter);
        await waiter.query('COMMIT');
        return row.state;
      })();
      await waitUntilBlockedBy(pool, waiterPid, holderPid);
      await holder.query(finish);
      expect(await flight).toBe(finish === 'COMMIT' ? 'REMOVED' : 'ACTIVE');
      expect(await workflow()).toHaveLength(finish === 'COMMIT' ? 0 : 1);
    } finally {
      await holder.query('ROLLBACK');
      await flight;
      await waiter.query('ROLLBACK');
      holder.release();
      waiter.release();
    }
  },
);

it('all batch W1 locks precede waiting for W2 and no audit/completion is committed early', async () => {
  const secondDuty = await insertDuty(pool, {
    companyId: f.tenant.companyId,
    projectId: f.project.projectId,
    planId: f.planId,
    month: MUTATION_MONTH,
    dutyDate: '2027-01-21',
    startsAt: '2027-01-21T05:00:00Z',
    endsAt: '2027-01-21T17:00:00Z',
  });
  const secondAssignment = await insertMembership(
    pool,
    f.tenant.companyId,
    secondDuty,
    f.mira.employeeId,
  );
  const pairs = [
    await committedPair(),
    await committedPair({ assignment: secondAssignment, duty: secondDuty }),
  ];
  const body = await saveDraft(),
    holder = await pool.connect(),
    probe = await pool.connect();
  let flight: Promise<unknown> | undefined;
  try {
    await holder.query('BEGIN');
    const pid = await backendPid(holder);
    await holder.query(
      'SELECT id FROM replacement_needs WHERE id=$1 FOR UPDATE',
      [pairs[1].need],
    );
    flight = save(body)
      .expect(200)
      .then((r) => r);
    let waiting: number | undefined;
    for (let i = 0; i < 2000; i++) {
      const row = (
        await pool.query(
          'SELECT pid FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))',
          [pid],
        )
      ).rows[0];
      if (row) {
        waiting = row.pid;
        break;
      }
    }
    expect(waiting).toBeDefined();
    await waitUntilBlockedBy(pool, waiting!, pid);
    for (const item of pairs) {
      await probe.query('BEGIN');
      await expect(
        probe.query(
          'SELECT id FROM cancellation_requests WHERE id=$1 FOR UPDATE NOWAIT',
          [item.cancellation],
        ),
      ).rejects.toMatchObject({ code: '55P03' });
      await probe.query('ROLLBACK');
    }
    expect(await workflowAudits()).toEqual([]);
    expect(
      (
        await pool.query(
          "SELECT state FROM idempotency_records WHERE company_id=$1 AND operation='EMPLOYEE_MONTH_SAVE'",
          [f.tenant.companyId],
        )
      ).rows[0].state,
    ).toBe('IN_PROGRESS');
    await holder.query('ROLLBACK');
    await flight;
    expect(await workflowAudits()).toHaveLength(4);
  } finally {
    await holder.query('ROLLBACK');
    await probe.query('ROLLBACK');
    await flight;
    holder.release();
    probe.release();
  }
});

it('failure after real batch receipt completion rolls planning/workflow/audits/completion back together', async () => {
  await committedPair();
  const body = await saveDraft();
  class CompletionFailure extends DatabaseService {
    override async withTransaction<T>(
      work: (c: PoolClient) => Promise<T>,
    ): Promise<T> {
      return super.withTransaction(async (c) => {
        const value = await work(c);
        const done = await c.query(
          "SELECT id FROM idempotency_records WHERE company_id=$1 AND operation='EMPLOYEE_MONTH_SAVE' AND state='COMPLETED'",
          [f.tenant.companyId],
        );
        if (done.rowCount) await c.query('SELECT 1/0');
        return value;
      });
    }
  }
  await app?.close();
  app = await bootEmployeesApp(new RecordingDelivery(), {
    clock: () => new Date(MUTATION_NOW),
    database: new CompletionFailure(),
  });
  const before = await planningState(pool, f.tenant.companyId),
    wf = await workflow();
  await save(body).expect(500);
  expect(await planningState(pool, f.tenant.companyId)).toEqual(before);
  expect(await workflow()).toEqual(wf);
  expect(await workflowAudits()).toEqual([]);
  expect(
    (
      await pool.query(
        "SELECT state,result_json FROM idempotency_records WHERE company_id=$1 AND operation='EMPLOYEE_MONTH_SAVE'",
        [f.tenant.companyId],
      )
    ).rows,
  ).toEqual([{ state: 'FAILED', result_json: null }]);
});

it('DELETE failure after reconciliation and removal audit restores duty, lease, assignment and workflow', async () => {
  await committedPair();
  await boot(new FailureAfterAudit('DUTY_REMOVED'));
  await lease();
  const before = await planningState(pool, f.tenant.companyId),
    wf = await workflow();
  expect((await remove().expect(500)).body.code).toBe('INTERNAL_ERROR');
  expect(await planningState(pool, f.tenant.companyId)).toEqual(before);
  expect(await workflow()).toEqual(wf);
  expect(await workflowAudits()).toEqual([]);
});

it('deferred FK failure at real PATCH commit rolls back reconciled workflow, planning and audits', async () => {
  await committedPair();
  class DeferredFailure extends BusinessAuditService {
    override async recordBusinessAction(
      c: Pick<PoolClient, 'query'>,
      entry: BusinessAuditEntry,
    ) {
      await super.recordBusinessAction(c, entry);
      if (entry.action === 'DUTY_MEMBERSHIP_REMOVED') {
        // Synthetic corruption injection: missing need is checked only by the real COMMIT.
        await c.query(
          `INSERT INTO cancellation_requests(company_id,assignment_id,duty_id,employee_id,submission_version)
          VALUES($1,$2,$3,$4,1)`,
          [f.tenant.companyId, f.membership, f.dutyId, f.mira.employeeId],
        );
      }
    }
  }
  await boot(new DeferredFailure());
  await lease();
  const before = await planningState(pool, f.tenant.companyId),
    wf = await workflow();
  expect((await patch({ assignments: [] }).expect(500)).body.code).toBe(
    'INTERNAL_ERROR',
  );
  expect(await planningState(pool, f.tenant.companyId)).toEqual(before);
  expect(await workflow()).toEqual(wf);
  expect(await workflowAudits()).toEqual([]);
  expect(
    (
      await pool.query(
        'SELECT id FROM cancellation_requests WHERE company_id=$1',
        [f.tenant.companyId],
      )
    ).rows,
  ).toHaveLength(1);
});
