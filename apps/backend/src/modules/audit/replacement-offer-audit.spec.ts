import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  BusinessAuditService,
  type BusinessAuditEntry,
} from './business-audit.service.js';
const base = (): BusinessAuditEntry => ({
  companyId: randomUUID(),
  actorAccountId: randomUUID(),
  correlationId: randomUUID(),
  resourceType: 'REPLACEMENT_OFFER',
  resourceId: randomUUID(),
  action: 'REPLACEMENT_OFFER_INVALIDATED',
  oldValues: { status: 'OPEN' },
  newValues: {
    status: 'INVALIDATED',
    needId: randomUUID(),
    cause: 'ASSIGNMENT_REMOVED',
  },
});
const created = (): BusinessAuditEntry => ({
  ...base(),
  action: 'REPLACEMENT_OFFER_CREATED',
  oldValues: undefined,
  newValues: { status: 'OPEN', needId: randomUUID(), employeeId: randomUUID() },
});
const client = () => ({ query: vi.fn(async () => ({ rows: [] })) });
it.each(['ASSIGNMENT_REMOVED', 'CANCELLATION_WITHDRAWN'])(
  'allows only bounded invalidation cause %s',
  async (cause) => {
    const c = client(),
      e = base();
    e.newValues = { ...e.newValues, cause };
    await new BusinessAuditService().recordBusinessAction(
      c as unknown as Pick<PoolClient, 'query'>,
      e,
    );
    expect(c.query).toHaveBeenCalledOnce();
  },
);
it('prepares the approved bounded creation audit without a creation route', async () => {
  const c = client();
  await new BusinessAuditService().recordBusinessAction(
    c as unknown as Pick<PoolClient, 'query'>,
    created(),
  );
  expect(c.query).toHaveBeenCalledOnce();
});
it.each([
  { resourceType: 'EMPLOYEE' },
  { actorAccountId: null },
  { resourceId: 'invalid' },
  { correlationId: 'invalid' },
  { companyId: 'invalid' },
  { newValues: null },
  { newValues: { status: 'INVALIDATED', needId: randomUUID(), cause: 'SICK' } },
  {
    newValues: {
      status: 'INVALIDATED',
      needId: randomUUID(),
      cause: 'ASSIGNMENT_REMOVED',
      reason: 'private',
    },
  },
  {
    newValues: {
      status: 'INVALIDATED',
      needId: 'bad',
      cause: 'ASSIGNMENT_REMOVED',
    },
  },
  { oldValues: { status: 'SELECTED' } },
  { oldValues: { status: 'OPEN', extra: [] } },
  { oldValues: null },
])('rejects malformed invalidation before SQL: %j', async (change) => {
  const c = client(),
    e = { ...base(), ...change } as BusinessAuditEntry;
  await expect(
    new BusinessAuditService().recordBusinessAction(
      c as unknown as Pick<PoolClient, 'query'>,
      e,
    ),
  ).rejects.toThrow('Invalid bounded');
  expect(c.query).not.toHaveBeenCalled();
});
it.each([
  { oldValues: { status: 'OPEN' } },
  { newValues: { status: 'OPEN', needId: randomUUID(), employeeId: 'bad' } },
  {
    newValues: {
      status: 'OPEN',
      needId: randomUUID(),
      employeeId: randomUUID(),
      token: 'private',
    },
  },
  { newValues: { status: 'OPEN', needId: randomUUID(), candidates: [] } },
])('rejects malformed creation before SQL: %j', async (change) => {
  const c = client(),
    e = { ...created(), ...change } as BusinessAuditEntry;
  await expect(
    new BusinessAuditService().recordBusinessAction(
      c as unknown as Pick<PoolClient, 'query'>,
      e,
    ),
  ).rejects.toThrow('Invalid bounded');
  expect(c.query).not.toHaveBeenCalled();
});
