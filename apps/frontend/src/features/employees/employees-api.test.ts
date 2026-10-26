import { describe, expect, it } from 'vitest';
import { createEmployeesApi, employeeListPath, parseListQuery } from './employees-api';
import { employee, fakeSessionApi, page } from './employees.test-support';

describe('SP-07 — employees API client', () => {
  it('builds list paths without default values', () => {
    expect(employeeListPath({})).toBe('/api/v1/employees');
    expect(employeeListPath({ page: 1 })).toBe('/api/v1/employees');
    expect(employeeListPath({ q: 'Mü ller', status: 'INACTIVE', page: 3 }))
      .toBe('/api/v1/employees?q=M%C3%BC+ller&status=INACTIVE&page=3');
  });

  it('accepts only API-valid values from the page URL', () => {
    expect(parseListQuery(new URLSearchParams('q=a&status=FOO&page=-2'))).toEqual({});
    expect(parseListQuery(new URLSearchParams('q=%20ab%20&status=ACTIVE&page=2'))).toEqual({ q: 'ab', status: 'ACTIVE', page: 2 });
    expect(parseListQuery(new URLSearchParams(`q=${'x'.repeat(101)}&page=1.5`))).toEqual({});
  });

  it('uses exactly the SP-07 endpoints and methods; ids are URL-encoded', async () => {
    const fake = fakeSessionApi(() => employee());
    const api = createEmployeesApi(fake.api);
    await api.get('a/b');
    await api.create({ employeeCode: 'A-1', firstName: 'Al', lastName: 'Be', email: 'a@b.de', shiftEligibility: 'DAY' });
    await api.update('id-1', { firstName: 'Neu' });
    await api.deactivate('id-1');
    expect(fake.requests).toEqual([
      { path: '/api/v1/employees/a%2Fb', method: 'GET', body: undefined },
      { path: '/api/v1/employees', method: 'POST', body: { employeeCode: 'A-1', firstName: 'Al', lastName: 'Be', email: 'a@b.de', shiftEligibility: 'DAY' } },
      { path: '/api/v1/employees/id-1', method: 'PATCH', body: { firstName: 'Neu' } },
      { path: '/api/v1/employees/id-1/deactivate', method: 'POST', body: {} },
    ]);
  });

  it('keeps only known fields and rejects malformed payloads as invalid responses', async () => {
    const extra = { ...employee(), companyId: 'leak', passwordHash: 'leak' };
    const api = createEmployeesApi(fakeSessionApi(() => extra).api);
    const result = await api.get('x');
    expect(result).toEqual(employee());
    expect(result).not.toHaveProperty('companyId');

    for (const broken of [null, { ...employee(), status: 'DEACTIVATED' }, { ...employee(), employmentStart: '01.11.2026' }]) {
      await expect(createEmployeesApi(fakeSessionApi(() => broken).api).get('x'))
        .rejects.toMatchObject({ kind: 'invalid-response' });
    }
    await expect(createEmployeesApi(fakeSessionApi(() => ({ items: 'x' })).api).list({}))
      .rejects.toMatchObject({ kind: 'invalid-response' });
  });

  it('lists pages', async () => {
    const api = createEmployeesApi(fakeSessionApi(() => page([employee()], { totalItems: 30, totalPages: 2 })).api);
    await expect(api.list({ page: 2 })).resolves.toMatchObject({ pagination: { totalItems: 30, totalPages: 2 } });
  });
});
