import { vi } from 'vitest';
import { BusinessAuditService, type BusinessAuditEntry } from './business-audit.service.js';

const values = { effectiveFromMonth: '2027-01-01', operatingWeekdays: [1, 3, 7], version: 1 };
const entry: BusinessAuditEntry = { companyId: 'company', actorAccountId: 'actor', action: 'PROJECT_OPERATING_CALENDAR_UPDATED',
  resourceType: 'PROJECT_OPERATING_CALENDAR', resourceId: 'project', oldValues: null, newValues: values, correlationId: 'correlation' };

it.each([
  { ...values, name: 'private-name' }, { ...values, operatingWeekdays: [] }, { ...values, operatingWeekdays: [8] },
  { ...values, operatingWeekdays: [1, 1] }, { ...values, operatingWeekdays: [3, 1] },
  { ...values, effectiveFromMonth: '2027-02-29' }, { ...values, effectiveFromMonth: '2027-01-02' },
  { ...values, version: Number.MAX_SAFE_INTEGER + 1 }, { ...values, bootstrap: false },
])('rejects unbounded/invalid calendar audit before SQL: %j', async (newValues) => {
  const client = { query: vi.fn() };
  await expect(new BusinessAuditService().recordBusinessAction(client, { ...entry, newValues })).rejects.toThrow();
  expect(client.query).not.toHaveBeenCalled();
});

it('accepts exact bounded values and the explicit bootstrap marker only on newValues', async () => {
  const client = { query: vi.fn().mockResolvedValue({}) }; const service = new BusinessAuditService();
  await service.recordBusinessAction(client, { ...entry, newValues: { ...values, bootstrap: true } });
  expect(client.query).toHaveBeenCalledTimes(1);
  expect(client.query.mock.calls[0][1][6]).toBe(JSON.stringify({ ...values, bootstrap: true }));
  await expect(service.recordBusinessAction(client, { ...entry, oldValues: { ...values, bootstrap: true } })).rejects.toThrow();
  expect(client.query).toHaveBeenCalledTimes(1);
});
