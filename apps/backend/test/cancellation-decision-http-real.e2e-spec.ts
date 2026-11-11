/** SP-21 S3: real Nest/Express HTTP, production guards/DTO/filter and verified disposable PostgreSQL. */
import { randomUUID } from 'node:crypto';
import {
  request as nativeRequest,
  type IncomingHttpHeaders,
  type Server,
} from 'node:http';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import {
  bootEmployeesApp,
  ORIGIN,
  RecordingDelivery,
} from './helpers/employees-test-app.js';
import {
  createStaff,
  insertDuty,
  insertMembership,
  insertPlan,
  insertProjectAssignment,
  insertShiftConfiguration,
  planningState,
  STANDARD_SHIFTS,
} from './helpers/planning-fixtures.js';
import {
  createSyntheticProject,
  createSyntheticSession,
  createSyntheticTenant,
  openLocalTestPool,
  realSessionService,
  removeSyntheticTenants,
  type SyntheticSession,
  type TestPool,
} from './helpers/synthetic-tenants.js';

let app: INestApplication<App>;
let pool: TestPool;
let previousOrigin: string | undefined;
const companies: string[] = [];
const route = (id: string) => `/api/v1/cancellation-requests/${id}/decision`;
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture() {
  const tenant = await createSyntheticTenant(pool, 'SP21 S3 HTTP');
  const foreign = await createSyntheticTenant(pool, 'SP21 S3 foreign');
  companies.push(tenant.companyId, foreign.companyId);
  const sessions = realSessionService(pool);
  const admin = await createSyntheticSession(sessions, tenant.admin);
  const foreignAdmin = await createSyntheticSession(sessions, foreign.admin);
  const original = await createStaff(pool, tenant.companyId);
  const candidate = await createStaff(pool, tenant.companyId);
  const employee = await createSyntheticSession(sessions, original.account);
  const project = await createSyntheticProject(
    pool,
    tenant.companyId,
    'Synthetic S3 project',
  );
  const month = '2027-01-01',
    day = '2027-01-20';
  await insertShiftConfiguration(
    pool,
    tenant.companyId,
    project.projectId,
    month,
    STANDARD_SHIFTS,
  );
  for (const person of [original, candidate])
    await insertProjectAssignment(
      pool,
      tenant.companyId,
      person.employeeId,
      project.projectId,
      month,
    );
  const planId = await insertPlan(
    pool,
    tenant.companyId,
    project.projectId,
    month,
    { byAccountId: tenant.admin.accountId },
  );
  const dutyId = await insertDuty(pool, {
    companyId: tenant.companyId,
    projectId: project.projectId,
    planId,
    month,
    dutyDate: day,
    startsAt: `${day}T05:00:00Z`,
    endsAt: `${day}T17:00:00Z`,
  });
  const assignmentId = await insertMembership(
    pool,
    tenant.companyId,
    dutyId,
    original.employeeId,
  );
  const cancellation = await request(app.getHttpServer())
    .post('/api/v1/cancellation-requests')
    .set('Origin', ORIGIN)
    .set('Cookie', employee.cookie)
    .set('X-CSRF-Token', employee.csrf)
    .set('Expected-Version', '1')
    .set('Idempotency-Key', randomUUID())
    .send({ assignmentId })
    .expect(201);
  const requestId = cancellation.body.id as string;
  const needId = cancellation.body.replacementNeed.id as string;
  const candidateSession = await createSyntheticSession(
    sessions,
    candidate.account,
  );
  const offer = await request(app.getHttpServer())
    .post(`/api/v1/replacement-needs/${needId}/offers`)
    .set('Origin', ORIGIN)
    .set('Cookie', candidateSession.cookie)
    .set('X-CSRF-Token', candidateSession.csrf)
    .set('Idempotency-Key', randomUUID())
    .expect(201);
  return {
    tenant,
    foreign,
    admin,
    foreignAdmin,
    employee,
    original,
    dutyId,
    assignmentId,
    requestId,
    needId,
    offerId: offer.body.id as string,
  };
}

function post(
  f: Fixture,
  key: string = randomUUID(),
  session: SyntheticSession = f.admin,
  id = f.requestId,
) {
  return request(app.getHttpServer())
    .post(route(id))
    .set('Origin', ORIGIN)
    .set('Cookie', session.cookie)
    .set('X-CSRF-Token', session.csrf)
    .set('Idempotency-Key', key);
}

/** Includes business/audit rows and ALL idempotency rows; session touches are intentionally outside this snapshot. */
async function snapshot(f: Fixture) {
  const tables = [
    'cancellation_requests',
    'replacement_needs',
    'replacement_offers',
    'idempotency_records',
  ];
  const rows = await Promise.all(
    tables.map(
      async (table) =>
        (
          await pool.query(
            `SELECT to_jsonb(t)::text AS bytes FROM public.${table} t WHERE company_id = $1 ORDER BY id`,
            [f.tenant.companyId],
          )
        ).rows,
    ),
  );
  return { planning: await planningState(pool, f.tenant.companyId), rows };
}
function privateResponse(headers: IncomingHttpHeaders) {
  expect(headers['cache-control']).toBe('private, no-store');
  expect(headers.pragma).toBe('no-cache');
  expect(headers.vary).toContain('Cookie');
  expect(headers.etag).toBeUndefined();
  expect(headers['last-modified']).toBeUndefined();
  expect(headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
}
function problem(
  response: { status: number; headers: IncomingHttpHeaders; body: unknown },
  status: number,
  code: string,
) {
  expect(response.status).toBe(status);
  expect(response.headers['content-type']).toMatch(
    /^application\/problem\+json/,
  );
  expect(response.body).toMatchObject({
    status,
    code,
    correlationId: response.headers['x-correlation-id'],
  });
  expect(response.headers['idempotency-replayed']).toBeUndefined();
  privateResponse(response.headers);
}

/** Native HTTP preserves duplicate field lines instead of relying on Superagent's header merging. */
async function raw(
  f: Fixture,
  headers: Record<string, string | string[]> = {},
  body = '{"decision":"REJECT"}',
  id = f.requestId,
) {
  const address = (app.getHttpServer() as Server).address();
  if (address === null || typeof address === 'string')
    throw new Error('TCP listener required');
  return new Promise<{
    status: number;
    headers: IncomingHttpHeaders;
    body: unknown;
  }>((resolve, reject) => {
    const outgoing = nativeRequest(
      {
        host: '127.0.0.1',
        port: address.port,
        path: route(id),
        method: 'POST',
        headers: {
          Origin: ORIGIN,
          Cookie: f.admin.cookie,
          'X-CSRF-Token': f.admin.csrf,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Idempotency-Key': randomUUID(),
          ...headers,
        },
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.on('error', reject);
        incoming.on('end', () => {
          try {
            resolve({
              status: incoming.statusCode ?? 0,
              headers: incoming.headers,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

beforeAll(async () => {
  previousOrigin = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = ORIGIN;
  pool = openLocalTestPool(8);
  app = await bootEmployeesApp(new RecordingDelivery(), {
    clock: () => new Date('2026-12-15T12:00:00Z'),
  });
  await app.listen(0, '127.0.0.1');
}, 120000);
afterAll(async () => {
  await app?.close();
  if (pool) {
    await removeSyntheticTenants(pool, companies);
    await pool.end();
  }
  if (previousOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = previousOrigin;
});

it.each(['REJECT', 'APPROVE'] as const)(
  '%s returns the exact stored receipt; null offer and irrelevant REJECT version normalize on replay',
  async (decision) => {
    const f = await fixture(),
      key = randomUUID();
    const mark = (
      await pool.query<{ id: string }>(
        'SELECT id FROM audit_event WHERE company_id=$1',
        [f.tenant.companyId],
      )
    ).rows.map((r) => r.id);
    const body =
      decision === 'APPROVE'
        ? { decision, expectedDutyVersion: 1 }
        : { decision };
    const first = await post(f, key)
      .set('Expected-Version', decision === 'APPROVE' ? '1' : '77')
      .set('X-Correlation-ID', 'untrusted-client-value')
      .send(body)
      .expect(200);
    privateResponse(first.headers);
    expect(first.headers['content-type']).toMatch(/^application\/json/);
    expect(first.headers['idempotency-replayed']).toBeUndefined();
    expect(first.headers['x-correlation-id']).not.toBe(
      'untrusted-client-value',
    );
    expect(first.body).toMatchObject({
      cancellation: {
        id: f.requestId,
        status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
        replacementNeed: {
          id: f.needId,
          status: decision === 'APPROVE' ? 'OPEN_UNFILLED' : 'CLOSED',
          resolvedAt: null,
        },
      },
      selectedOffer: null,
      updatedDuty:
        decision === 'APPROVE' ? { id: f.dutyId, concurrencyVersion: 2 } : null,
    });
    const stored = (
      await pool.query(
        "SELECT state,result_json,result_cancellation_request_id FROM idempotency_records WHERE company_id=$1 AND operation='DECIDE_CANCELLATION'",
        [f.tenant.companyId],
      )
    ).rows;
    expect(stored).toEqual([
      {
        state: 'COMPLETED',
        result_json: first.body,
        result_cancellation_request_id: f.requestId,
      },
    ]);
    const audit = (
      await pool.query(
        'SELECT action,actor_account_id,correlation_id FROM audit_event WHERE company_id=$1 AND NOT(id=ANY($2::uuid[])) ORDER BY action',
        [f.tenant.companyId, mark],
      )
    ).rows;
    expect(audit.map((r) => r.action)).toEqual(
      decision === 'APPROVE'
        ? [
            'CANCELLATION_APPROVED',
            'DUTY_MEMBERSHIP_REMOVED',
            'DUTY_UPDATED',
            'REPLACEMENT_NEED_OPEN_UNFILLED',
            'REPLACEMENT_OFFER_NOT_SELECTED',
          ]
        : [
            'CANCELLATION_REJECTED',
            'REPLACEMENT_NEED_CLOSED',
            'REPLACEMENT_OFFER_NOT_SELECTED',
          ],
    );
    expect(
      audit.every(
        (r) =>
          r.actor_account_id === f.tenant.admin.accountId &&
          r.correlation_id === first.headers['x-correlation-id'],
      ),
    ).toBe(true);
    expect(
      (
        await pool.query('SELECT status FROM replacement_offers WHERE id=$1', [
          f.offerId,
        ])
      ).rows[0].status,
    ).toBe('NOT_SELECTED');
    expect(
      (
        await pool.query('SELECT concurrency_version FROM duties WHERE id=$1', [
          f.dutyId,
        ])
      ).rows[0].concurrency_version,
    ).toBe(decision === 'APPROVE' ? '2' : '1');
    expect(
      (
        await pool.query('SELECT state FROM plan_assignments WHERE id=$1', [
          f.assignmentId,
        ])
      ).rows[0].state,
    ).toBe(decision === 'APPROVE' ? 'REMOVED' : 'ACTIVE');
    // Mutate live data: the replay must retain the original names and duty snapshot.
    await pool.query(
      "UPDATE employees SET first_name='Changed after decision' WHERE id=$1",
      [f.original.employeeId],
    );
    await pool.query(
      'UPDATE duties SET concurrency_version=concurrency_version+1 WHERE id=$1',
      [f.dutyId],
    );
    const beforeReplay = await snapshot(f);
    const replay = await post(f, key)
      .set(
        'Expected-Version',
        decision === 'APPROVE' ? '1' : '9007199254740991',
      )
      .send({ ...body, replacementOfferId: null })
      .expect(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.text).toBe(first.text);
    expect(replay.body).toEqual(stored[0].result_json);
    privateResponse(replay.headers);
    expect(await snapshot(f)).toEqual(beforeReplay);
    if (decision === 'REJECT') {
      const withoutVersion = await post(f, key).send(body).expect(200);
      expect(withoutVersion.text).toBe(first.text);
      expect(withoutVersion.headers['idempotency-replayed']).toBe('true');
      expect(await snapshot(f)).toEqual(beforeReplay);
    }
  },
);

it.each(['REJECT', 'APPROVE'] as const)(
  '%s accepts explicit null on the first request',
  async (decision) => {
    const f = await fixture();
    await post(f)
      .set('Expected-Version', '1')
      .send({
        decision,
        replacementOfferId: null,
        ...(decision === 'APPROVE' ? { expectedDutyVersion: 1 } : {}),
      })
      .expect(200);
  },
);

it('same key with another decision, need version or duty version is a 409 without another write', async () => {
  const f = await fixture(),
    key = randomUUID();
  await post(f, key)
    .set('Expected-Version', '1')
    .send({ decision: 'APPROVE', expectedDutyVersion: 1 })
    .expect(200);
  const before = await snapshot(f);
  for (const [header, body] of [
    ['1', { decision: 'REJECT' }],
    ['2', { decision: 'APPROVE', expectedDutyVersion: 1 }],
    ['1', { decision: 'APPROVE', expectedDutyVersion: 2 }],
  ] as const) {
    problem(
      await post(f, key).set('Expected-Version', header).send(body),
      409,
      'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST',
    );
    expect(await snapshot(f)).toEqual(before);
  }
});

describe('HTTP validation refuses before any business, audit or idempotency write', () => {
  let f: Fixture;
  let baseline: Awaited<ReturnType<typeof snapshot>>;
  beforeAll(async () => {
    f = await fixture();
    baseline = await snapshot(f);
  });
  afterEach(async () => {
    expect(await snapshot(f)).toEqual(baseline);
  });

  it.each([
    {},
    { decision: 'approve' },
    { decision: 'SELECT' },
    { decision: null },
    { decision: 1 },
    { decision: 'APPROVE' },
    { decision: 'APPROVE', expectedDutyVersion: null },
    ...['1', 0, -1, 1.5, 9007199254740992, true, {}, []].map(
      (expectedDutyVersion) => ({ decision: 'APPROVE', expectedDutyVersion }),
    ),
    { decision: 'REJECT', expectedDutyVersion: 1 },
    { decision: 'REJECT', expectedDutyVersion: null },
    ...[randomUUID(), '', 0, false, {}, []].map((replacementOfferId) => ({
      decision: 'REJECT',
      replacementOfferId,
    })),
  ])('invalid body %j', async (body) => {
    problem(
      await post(f).set('Expected-Version', '1').send(body),
      400,
      'VALIDATION_FAILED',
    );
  });
  it.each([
    'companyId',
    'actorId',
    'accountId',
    'requestId',
    'expectedNeedVersion',
    'extra',
  ])('refuses client property %s', async (field) => {
    const r = await post(f).send({ decision: 'REJECT', [field]: randomUUID() });
    problem(r, 400, 'UNKNOWN_FIELD');
    expect(JSON.stringify(r.body)).not.toContain(field);
  });
  it.each(['constructor', '__proto__', 'prototype'])(
    'refuses transformer-reserved unknown property %s',
    async (field) => {
      problem(
        await raw(f, {}, `{"decision":"REJECT","${field}":{}}`),
        400,
        'UNKNOWN_FIELD',
      );
    },
  );
  it('requires Expected-Version for APPROVE', async () => {
    problem(
      await post(f).send({ decision: 'APPROVE', expectedDutyVersion: 1 }),
      400,
      'EXPECTED_VERSION_REQUIRED',
    );
  });
  it.each(['REJECT', 'APPROVE'] as const)(
    'validates every supplied Expected-Version for %s',
    async (decision) => {
      for (const header of [
        '',
        '0',
        '-1',
        '+1',
        '01',
        '1.0',
        '1e0',
        '1 2',
        '9007199254740992',
        '1, 1',
      ])
        problem(
          await post(f)
            .set('Expected-Version', header)
            .send({
              decision,
              ...(decision === 'APPROVE' ? { expectedDutyVersion: 1 } : {}),
            }),
          400,
          'INVALID_EXPECTED_VERSION',
        );
    },
  );
  it('requires Idempotency-Key', async () => {
    const r = post(f);
    r.unset('Idempotency-Key');
    problem(
      await r.send({ decision: 'REJECT' }),
      400,
      'IDEMPOTENCY_KEY_REQUIRED',
    );
  });
  it.each(['short', '', 'a'.repeat(129), 'contains space'])(
    'invalid Idempotency-Key %j',
    async (key) => {
      problem(
        await post(f, key).send({ decision: 'REJECT' }),
        400,
        'IDEMPOTENCY_KEY_INVALID',
      );
    },
  );
  it.each(['Idempotency-Key', 'Expected-Version'])(
    'rejects duplicate %s field lines',
    async (header) => {
      problem(
        await raw(f, {
          [header]:
            header === 'Expected-Version'
              ? ['1', '1']
              : ['same-key-123', 'same-key-123'],
        }),
        400,
        header === 'Expected-Version'
          ? 'INVALID_EXPECTED_VERSION'
          : 'IDEMPOTENCY_KEY_INVALID',
      );
    },
  );
  it('rejects unsupported query parameters', async () => {
    problem(
      await post(f)
        .query({ companyId: f.foreign.companyId })
        .send({ decision: 'REJECT' }),
      400,
      'VALIDATION_FAILED',
    );
  });
  it('empty JSON object fails DTO validation before missing headers', async () => {
    const r = post(f);
    r.unset('Idempotency-Key');
    problem(await r.send({}), 400, 'VALIDATION_FAILED');
  });
  it('missing JSON body fails DTO validation', async () => {
    problem(await post(f), 400, 'VALIDATION_FAILED');
  });
  it.each(['null', 'true', '"REJECT"', '[]'])(
    'rejects non-object JSON %s',
    async (body) => {
      const r = await raw(f, {}, body);
      problem(
        r,
        400,
        body === '[]' ? 'VALIDATION_FAILED' : 'INVALID_REQUEST_BODY',
      );
    },
  );
  it('malformed JSON is parsed before Origin/session guards', async () => {
    problem(
      await raw(
        f,
        {
          Origin: 'https://invalid.example',
          Cookie: 'invalid',
          'X-CSRF-Token': '',
        },
        '{',
      ),
      400,
      'INVALID_REQUEST_BODY',
    );
  });
  it('bounded JSON fails with 413 before authentication', async () => {
    problem(
      await raw(
        f,
        { Origin: 'https://invalid.example', Cookie: '' },
        ' '.repeat(100 * 1024) + '{"decision":"REJECT"}',
      ),
      413,
      'REQUEST_BODY_TOO_LARGE',
    );
  });
  it.each([
    'text/plain',
    'application/x-www-form-urlencoded',
    'application/octet-stream',
    'application/merge-patch+json',
    'application/json; charset=iso-8859-1',
  ])('rejects media type %s', async (type) => {
    problem(
      await raw(f, { 'Content-Type': type }),
      415,
      'UNSUPPORTED_MEDIA_TYPE',
    );
  });
});

describe('guard order, live authority and concealment', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture();
  });
  it('Origin precedes missing session and unsupported media type', async () => {
    const before = await snapshot(f);
    for (const origin of ['', 'https://invalid.example']) {
      const r = post(f);
      r.unset('Cookie');
      problem(
        await r.set('Origin', origin).type('text').send('ignored'),
        403,
        'CSRF_VALIDATION_FAILED',
      );
    }
    expect(await snapshot(f)).toEqual(before);
  });
  it('session precedes CSRF, role, media type and DTO validation', async () => {
    const before = await snapshot(f);
    const r = post(f);
    r.unset('Cookie');
    r.unset('X-CSRF-Token');
    problem(await r.type('text').send('ignored'), 401, 'SESSION_REQUIRED');
    expect(await snapshot(f)).toEqual(before);
  });
  it.each(['', 'invalid', 'a'.repeat(43)])(
    'CSRF failure %j precedes EMPLOYEE role refusal',
    async (csrf) => {
      const before = await snapshot(f);
      const r = post(f, randomUUID(), f.employee);
      if (csrf) r.set('X-CSRF-Token', csrf);
      else r.unset('X-CSRF-Token');
      problem(await r.send({}), 403, 'CSRF_VALIDATION_FAILED');
      expect(await snapshot(f)).toEqual(before);
    },
  );
  it('EMPLOYEE is forbidden before DTO or header validation', async () => {
    const before = await snapshot(f);
    problem(
      await post(f, randomUUID(), f.employee).send({}),
      403,
      'ACTION_FORBIDDEN',
    );
    expect(await snapshot(f)).toEqual(before);
  });
  it('rechecks live role even for a successful receipt replay', async () => {
    const own = await fixture(),
      key = randomUUID();
    await post(own, key).send({ decision: 'REJECT' }).expect(200);
    await pool.query("UPDATE accounts SET role='EMPLOYEE' WHERE id=$1", [
      own.tenant.admin.accountId,
    ]);
    const before = await snapshot(own);
    problem(
      await post(own, key).send({ decision: 'REJECT' }),
      403,
      'ACTION_FORBIDDEN',
    );
    expect(await snapshot(own)).toEqual(before);
  });
  it.each(['revoked', 'expired'] as const)(
    '%s session cannot replay a stored receipt',
    async (mode) => {
      const own = await fixture(),
        key = randomUUID();
      await post(own, key).send({ decision: 'REJECT' }).expect(200);
      await pool.query(
        mode === 'revoked'
          ? 'UPDATE sessions SET revoked_at=clock_timestamp() WHERE account_id=$1'
          : "UPDATE sessions SET created_at=clock_timestamp()-interval '2 days',last_seen_at=clock_timestamp()-interval '2 days',absolute_expires_at=clock_timestamp()-interval '1 day' WHERE account_id=$1",
        [own.tenant.admin.accountId],
      );
      const before = await snapshot(own);
      const r = post(own, key);
      r.unset('X-CSRF-Token');
      problem(
        await r.send({ decision: 'REJECT' }),
        401,
        mode === 'revoked' ? 'SESSION_REVOKED' : 'SESSION_EXPIRED',
      );
      expect(await snapshot(own)).toEqual(before);
    },
  );
  it('valid foreign/unknown/malformed IDs are concealed, without allocating a receipt in either tenant', async () => {
    const before = await snapshot(f);
    for (const id of [f.requestId, randomUUID(), 'not-a-uuid'])
      problem(
        await post(f, randomUUID(), f.foreignAdmin, id).send({
          decision: 'REJECT',
        }),
        404,
        'RESOURCE_NOT_FOUND',
      );
    expect(await snapshot(f)).toEqual(before);
    expect(
      (
        await pool.query(
          'SELECT id FROM idempotency_records WHERE company_id=$1',
          [f.foreign.companyId],
        )
      ).rows,
    ).toEqual([]);
  });
  it.each(['owned', 'foreign', 'unknown'] as const)(
    '%s UUID uses HTTP validation before S2 discovery',
    async (kind) => {
      const before = await snapshot(f);
      const session = kind === 'foreign' ? f.foreignAdmin : f.admin;
      const id = kind === 'unknown' ? randomUUID() : f.requestId;
      problem(
        await post(f, randomUUID(), session, id).send({ decision: 'bad' }),
        400,
        'VALIDATION_FAILED',
      );
      problem(
        await post(f, randomUUID(), session, id)
          .set('Expected-Version', 'bad')
          .send({ decision: 'REJECT' }),
        400,
        'INVALID_EXPECTED_VERSION',
      );
      const r = post(f, randomUUID(), session, id);
      r.unset('Idempotency-Key');
      problem(
        await r.send({ decision: 'REJECT' }),
        400,
        'IDEMPOTENCY_KEY_REQUIRED',
      );
      problem(
        await raw(
          f,
          { Cookie: session.cookie, 'X-CSRF-Token': session.csrf },
          '{',
          id,
        ),
        400,
        'INVALID_REQUEST_BODY',
      );
      expect(await snapshot(f)).toEqual(before);
    },
  );
});

it.each(['need', 'duty'] as const)(
  'stale %s version returns the existing 409 and no business or audit writes',
  async (changed) => {
    const f = await fixture();
    await pool.query(
      changed === 'need'
        ? 'UPDATE replacement_needs SET concurrency_version=2 WHERE id=$1'
        : 'UPDATE duties SET concurrency_version=2 WHERE id=$1',
      [changed === 'need' ? f.needId : f.dutyId],
    );
    const before = await planningState(pool, f.tenant.companyId);
    problem(
      await post(f)
        .set('Expected-Version', '1')
        .send({ decision: 'APPROVE', expectedDutyVersion: 1 }),
      409,
      'PLAN_CONCURRENT_MODIFICATION',
    );
    expect(await planningState(pool, f.tenant.companyId)).toEqual(before);
    expect(
      (
        await pool.query(
          "SELECT state FROM idempotency_records WHERE company_id=$1 AND operation='DECIDE_CANCELLATION'",
          [f.tenant.companyId],
        )
      ).rows,
    ).toEqual([{ state: 'FAILED' }]);
  },
);

it('concurrent real HTTP decisions commit once and map the loser to the existing 409', async () => {
  const f = await fixture();
  const results = await Promise.all([
    post(f).send({ decision: 'REJECT' }),
    post(f)
      .set('Expected-Version', '1')
      .send({ decision: 'APPROVE', expectedDutyVersion: 1 }),
  ]);
  expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
    200, 409,
  ]);
  const loser = results.find((r) => r.status === 409)!;
  expect([
    'REPLACEMENT_NEED_NOT_OPEN',
    'CANCELLATION_ALREADY_RESOLVED',
  ]).toContain(loser.body.code);
  problem(loser, 409, loser.body.code);
  expect(
    (
      await pool.query(
        "SELECT id FROM idempotency_records WHERE company_id=$1 AND operation='DECIDE_CANCELLATION' AND state='COMPLETED'",
        [f.tenant.companyId],
      )
    ).rows,
  ).toHaveLength(1);
  expect(
    (
      await pool.query(
        "SELECT id FROM audit_event WHERE company_id=$1 AND action IN ('CANCELLATION_APPROVED','CANCELLATION_REJECTED')",
        [f.tenant.companyId],
      )
    ).rows,
  ).toHaveLength(1);
});

it('SP-20 still selects an offer through its existing route, while S3 refuses non-null offers', async () => {
  const f = await fixture(),
    before = await snapshot(f);
  problem(
    await post(f).set('Expected-Version', '1').send({
      decision: 'APPROVE',
      expectedDutyVersion: 1,
      replacementOfferId: f.offerId,
    }),
    400,
    'VALIDATION_FAILED',
  );
  expect(await snapshot(f)).toEqual(before);
  const selected = await request(app.getHttpServer())
    .post(`/api/v1/replacement-needs/${f.needId}/selection`)
    .set('Origin', ORIGIN)
    .set('Cookie', f.admin.cookie)
    .set('X-CSRF-Token', f.admin.csrf)
    .set('Idempotency-Key', randomUUID())
    .set('Expected-Version', '1')
    .send({ offerId: f.offerId })
    .expect(200);
  expect(selected.body).toMatchObject({
    cancellationRequestId: f.requestId,
    status: { cancellation: 'APPROVED', need: 'RESOLVED' },
    selectedOffer: { id: f.offerId, status: 'SELECTED' },
  });
  problem(
    await post(f).send({ decision: 'REJECT' }),
    409,
    'CANCELLATION_ALREADY_RESOLVED',
  );
});
