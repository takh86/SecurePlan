import { describe, expect, it } from 'vitest';
import { createEmployeeFutureAssignmentsApi } from './employee-future-assignments-api';
import { EMPLOYEE_ID, fakeSessionApi } from './employees.test-support';

const row = {
  id: 'assignment-1',
  employeeId: EMPLOYEE_ID,
  projectId: 'project-1',
  monthStart: '2027-01-01',
  version: 1793275200123456,
  projectName: 'Objekt Nord',
  projectStatus: 'ACTIVE',
};
const page = (items: unknown[] = [row], number = 1, totalItems = items.length) => ({
  items,
  pagination: { page: number, pageSize: 25, totalItems, totalPages: Math.ceil(totalItems / 25) },
});

describe('S-9 employee discovery client', () => {
  it('requests one page without tenant/timezone/scope hints and strips undeclared response fields', async () => {
    const fake = fakeSessionApi(() => page([{ ...row, companyId: 'hidden', accountId: 'hidden' }]));
    const api = createEmployeeFutureAssignmentsApi(fake.api);
    expect(await api.list(EMPLOYEE_ID, 1)).toEqual(page());
    expect(fake.requests).toEqual([
      {
        path: `/api/v1/employees/${EMPLOYEE_ID}/future-project-assignments?page=1&pageSize=25`,
        method: 'GET',
        body: undefined,
      },
    ]);
  });

  it('keeps masked references and distinguishes empty from an empty beyond-last page', async () => {
    const hidden = { ...row, projectName: null, projectStatus: null };
    expect(
      (await createEmployeeFutureAssignmentsApi(fakeSessionApi(() => page([hidden])).api).list(EMPLOYEE_ID, 1)).items,
    ).toEqual([hidden]);
    const beyond = page([], 2, 25);
    expect(await createEmployeeFutureAssignmentsApi(fakeSessionApi(() => beyond).api).list(EMPLOYEE_ID, 2)).toEqual(
      beyond,
    );
    expect(await createEmployeeFutureAssignmentsApi(fakeSessionApi(() => page([])).api).list(EMPLOYEE_ID, 1)).toEqual(
      page([]),
    );
  });

  it.each([
    { ...row, version: undefined },
    { ...row, version: 0 },
    { ...row, version: Number.MAX_SAFE_INTEGER + 1 },
    { ...row, employeeId: 'another-employee' },
    { ...row, monthStart: '2027-01-02' },
    { ...row, projectName: 'Hidden label', projectStatus: 'ARCHIVED' },
    { ...row, projectName: null, projectStatus: 'ACTIVE' },
    { ...row, projectName: 'Label', projectStatus: null },
  ])('rejects malformed/foreign/hidden metadata or unsafe version without passing it to UI', async (value) => {
    await expect(
      createEmployeeFutureAssignmentsApi(fakeSessionApi(() => page([value])).api).list(EMPLOYEE_ID, 1),
    ).rejects.toMatchObject({ kind: 'invalid-response' });
  });

  it.each([
    null,
    { items: [] },
    { ...page(), pagination: { ...page().pagination, page: 2 } },
    page([row], 1, 0),
    page([], 1, 1),
    { ...page(), pagination: { ...page().pagination, totalItems: -1 } },
    { ...page(), pagination: { ...page().pagination, totalPages: 2 } },
  ])('rejects malformed page metadata', async (value) => {
    await expect(
      createEmployeeFutureAssignmentsApi(fakeSessionApi(() => value).api).list(EMPLOYEE_ID, 1),
    ).rejects.toMatchObject({ kind: 'invalid-response' });
  });

  it('reuses DELETE with the exact confirmed version, no body and no automatic retry', async () => {
    const fake = fakeSessionApi(() => undefined);
    await createEmployeeFutureAssignmentsApi(fake.api).remove('a/1', Number.MAX_SAFE_INTEGER);
    expect(fake.requests).toEqual([
      {
        path: '/api/v1/project-assignments/a%2F1',
        method: 'DELETE',
        body: undefined,
        expectedVersion: Number.MAX_SAFE_INTEGER,
      },
    ]);
  });
});
