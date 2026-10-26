import { describe, expect, it } from 'vitest';
import { loadAllPages } from '../../shared/data/load-all-pages';
import { fakeSessionApi } from '../employees/employees.test-support';
import { createProjectAssignmentsApi, monthStartOf } from './project-assignments-api';

// Synthetic example values.
const assignment = (id: string, monthStart = '2027-01-01') => ({ id, employeeId: 'e-1', projectId: 'p-1', monthStart });
const page = (items: unknown[], pageNumber: number, totalPages: number) => ({
  items,
  pagination: { page: pageNumber, pageSize: 100, totalItems: items.length, totalPages },
});

describe('SP-09 — project assignments API client', () => {
  it('reads one month over all pages with the documented query and keeps only known fields', async () => {
    const { api, requests } = fakeSessionApi((request) =>
      request.path.includes('page=2')
        ? page([assignment('a-2')], 2, 2)
        : page([{ ...assignment('a-1'), companyId: 'c-1' }], 1, 2));
    const result = await createProjectAssignmentsApi(api).listMonth('2027-01');
    expect(result).toEqual([assignment('a-1'), assignment('a-2')]);
    expect(requests.map((request) => request.path)).toEqual([
      '/api/v1/project-assignments?monthStart=2027-01-01&pageSize=100',
      '/api/v1/project-assignments?monthStart=2027-01-01&pageSize=100&page=2',
    ]);
  });

  it('creates with exactly the three business dimensions', async () => {
    const { api, requests } = fakeSessionApi(() => assignment('a-1', '2026-12-01'));
    await createProjectAssignmentsApi(api).create({ employeeId: 'e-1', projectId: 'p-1', monthStart: '2026-12-01' });
    expect(requests).toEqual([{
      path: '/api/v1/project-assignments',
      method: 'POST',
      body: { employeeId: 'e-1', projectId: 'p-1', monthStart: '2026-12-01' },
    }]);
  });

  it('rejects malformed payloads and an answer for another month', async () => {
    for (const body of [assignment('a-1', '2027-01-15'), { ...assignment('a-1'), employeeId: 1 }, null]) {
      const client = createProjectAssignmentsApi(fakeSessionApi(() => body).api);
      await expect(client.create({ employeeId: 'e-1', projectId: 'p-1', monthStart: '2027-01-01' }))
        .rejects.toMatchObject({ kind: 'invalid-response' });
    }
    const otherMonth = createProjectAssignmentsApi(fakeSessionApi(() => page([assignment('a-1', '2027-02-01')], 1, 1)).api);
    await expect(otherMonth.listMonth('2027-01')).rejects.toMatchObject({ kind: 'invalid-response' });
  });

  it('maps a month key to its first day', () => {
    expect(monthStartOf('2026-12')).toBe('2026-12-01');
    expect(monthStartOf('2027-01')).toBe('2027-01-01');
  });
});

describe('loadAllPages', () => {
  it('stops at the reported last page and refuses unbounded collections', async () => {
    const loaded: number[] = [];
    const items = await loadAllPages(async (n) => {
      loaded.push(n);
      return { items: [n], pagination: { totalPages: 3 } };
    });
    expect(items).toEqual([1, 2, 3]);
    expect(loaded).toEqual([1, 2, 3]);
    await expect(loadAllPages(async () => ({ items: [], pagination: { totalPages: 21 } }))).rejects.toThrow('too large');
    expect(await loadAllPages(async () => ({ items: [], pagination: { totalPages: 0 } }))).toEqual([]);
  });
});
