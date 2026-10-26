import { describe, expect, it } from 'vitest';
import { ApiError } from '../../shared/api/api-error';
import { fakeSessionApi } from '../employees/employees.test-support';
import { createProjectsApi, parseProjectListQuery, projectListSearch } from './projects-api';

const valid = { id: 'p-1', name: 'Demo-Objekt Hafen', status: 'ACTIVE' };

describe('SP-08 — projects API client', () => {
  it('calls only the documented endpoints and sends only name/status', async () => {
    const { api, requests } = fakeSessionApi((request) =>
      request.method === 'GET' && !request.path.startsWith('/api/v1/projects/')
        ? { items: [valid], pagination: { page: 1, pageSize: 25, totalItems: 1, totalPages: 1 } }
        : valid,
    );
    const projects = createProjectsApi(api);
    await projects.list({});
    await projects.list({ status: 'INACTIVE', page: 2 });
    await projects.get('p 1');
    await projects.create('Neu');
    await projects.update('p-1', { status: 'INACTIVE' });
    expect(requests).toEqual([
      { path: '/api/v1/projects', method: 'GET', body: undefined },
      { path: '/api/v1/projects?status=INACTIVE&page=2', method: 'GET', body: undefined },
      { path: '/api/v1/projects/p%201', method: 'GET', body: undefined },
      { path: '/api/v1/projects', method: 'POST', body: { name: 'Neu' } },
      { path: '/api/v1/projects/p-1', method: 'PATCH', body: { status: 'INACTIVE' } },
    ]);
  });

  it('rejects malformed payloads and statuses outside API v1 (e.g. ARCHIVED)', async () => {
    for (const body of [{ ...valid, status: 'ARCHIVED' }, { ...valid, name: 3 }, null, []]) {
      const projects = createProjectsApi(fakeSessionApi(() => body).api);
      await expect(projects.get('p-1')).rejects.toMatchObject({ kind: 'invalid-response' });
    }
    const badPage = createProjectsApi(fakeSessionApi(() => ({ items: [valid], pagination: { page: -1 } })).api);
    await expect(badPage.list({})).rejects.toBeInstanceOf(ApiError);
  });

  it('drops fields that are not part of the v1 response', async () => {
    const projects = createProjectsApi(fakeSessionApi(() => ({ ...valid, companyId: 'c-1', address: 'x' })).api);
    expect(await projects.get('p-1')).toEqual(valid);
  });

  it('parses URL query input defensively', () => {
    expect(parseProjectListQuery(new URLSearchParams('status=ARCHIVED&page=0'))).toEqual({});
    expect(parseProjectListQuery(new URLSearchParams('status=ACTIVE&page=3'))).toEqual({ status: 'ACTIVE', page: 3 });
    expect(projectListSearch({ page: 1 })).toBe('');
  });
});
