/** SP-21 S2: bounded validators for the ADR-0004 SP-21 decision actions (no database). */
import { randomUUID } from 'node:crypto';
import { BusinessAuditService, type BusinessAuditEntry } from './business-audit.service.js';

const service = new BusinessAuditService();
const queries: string[] = [];
const client = { query: (sql: string) => (queries.push(sql), Promise.resolve({ rows: [], rowCount: 1 })) };
const entry = (over: Partial<BusinessAuditEntry>): BusinessAuditEntry => ({
  companyId: randomUUID(), actorAccountId: randomUUID(), correlationId: randomUUID(), resourceId: randomUUID(),
  action: 'CANCELLATION_REJECTED', resourceType: 'CANCELLATION_REQUEST',
  oldValues: { status: 'OPEN' }, newValues: { status: 'REJECTED' }, ...over,
});

describe('SP-21 decision audit validators', () => {
  it.each([
    entry({}),
    entry({ action: 'REPLACEMENT_NEED_OPEN_UNFILLED', resourceType: 'REPLACEMENT_NEED', newValues: { status: 'OPEN_UNFILLED' } }),
    entry({ action: 'REPLACEMENT_NEED_CLOSED', resourceType: 'REPLACEMENT_NEED', newValues: { status: 'CLOSED' } }),
    entry({ action: 'REPLACEMENT_NEED_CLOSED', resourceType: 'REPLACEMENT_NEED', newValues: { status: 'CLOSED' }, actorAccountId: null }),
  ])('accepts the exact approved payload %#', async (e) => {
    await expect(service.recordBusinessAction(client as never, e)).resolves.toBeUndefined();
  });
  it.each([
    ['wrong target status', entry({ newValues: { status: 'APPROVED' } })],
    ['extra key (free text)', entry({ newValues: { status: 'REJECTED', reason: 'x' } })],
    ['name in payload', entry({ newValues: { status: 'REJECTED', lastName: 'x' } })],
    ['wrong old status', entry({ oldValues: { status: 'WITHDRAWN' } })],
    ['missing old values', entry({ oldValues: null })],
    ['wrong resource type', entry({ resourceType: 'REPLACEMENT_NEED' })],
    ['no actor', entry({ actorAccountId: null })],
    ['non-UUID correlation', entry({ correlationId: 'x' })],
    ['OPEN_UNFILLED on a cancellation', entry({ action: 'REPLACEMENT_NEED_OPEN_UNFILLED', newValues: { status: 'OPEN_UNFILLED' } })],
    ['CLOSED need with extra key', entry({ action: 'REPLACEMENT_NEED_CLOSED', resourceType: 'REPLACEMENT_NEED', newValues: { status: 'CLOSED', cause: 'x' } })],
  ])('refuses %s before any insert', async (_n, e) => {
    queries.length = 0;
    await expect(service.recordBusinessAction(client as never, e)).rejects.toThrow('Invalid bounded cancellation decision audit');
    expect(queries).toHaveLength(0);
  });
});
