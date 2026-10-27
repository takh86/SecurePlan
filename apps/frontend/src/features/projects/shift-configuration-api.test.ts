import { describe, expect, it } from 'vitest';
import { fakeSessionApi } from '../employees/employees.test-support';
import { createShiftConfigurationApi } from './shift-configuration-api';

// Synthetic example values, not business rules.
const PROJECT = '7a2be0c4-1d3e-4f5a-8b6c-9d0e1f2a3b4c';
const URL_BASE = `/api/v1/projects/${PROJECT}/shift-configuration`;
const day = { id: 's-1', shiftKind: 'DAY', startLocal: '06:00', endLocal: '18:00' } as const;
const night = { id: 's-2', shiftKind: 'NIGHT', startLocal: '18:00', endLocal: '06:00' } as const;

function clientAnswering(body: unknown) {
  const fake = fakeSessionApi(() => body);
  return { ...fake, client: createShiftConfigurationApi(fake.api) };
}

describe('SP-08b — shift configuration client', () => {
  it('reads the effective configuration for a month and keeps only known fields, DAY before NIGHT', async () => {
    const { client, requests } = clientAnswering({
      projectId: PROJECT, effectiveFromMonth: '2026-10-01', shifts: [{ ...night, extra: 'x' }, day], companyId: 'leak',
    });
    expect(await client.get(PROJECT, '2026-12')).toEqual({
      projectId: PROJECT,
      effectiveFromMonth: '2026-10',
      shifts: [day, night],
    });
    // Only the month; no tenant, role or company parameter.
    expect(requests).toEqual([{ path: `${URL_BASE}?effectiveForMonth=2026-12-01`, method: 'GET', body: undefined }]);
  });

  it('A-SP08b-01: nothing configured is null with an empty list, not an error', async () => {
    const { client } = clientAnswering({ projectId: PROJECT, effectiveFromMonth: null, shifts: [] });
    expect(await client.get(PROJECT, '2026-12')).toEqual({ projectId: PROJECT, effectiveFromMonth: null, shifts: [] });
  });

  it.each([
    ['null month with shifts', { projectId: PROJECT, effectiveFromMonth: null, shifts: [day] }],
    ['a month without shifts', { projectId: PROJECT, effectiveFromMonth: '2026-10-01', shifts: [] }],
    ['a version AFTER the requested month', { projectId: PROJECT, effectiveFromMonth: '2027-01-01', shifts: [day] }],
    ['a mid-month date', { projectId: PROJECT, effectiveFromMonth: '2026-10-15', shifts: [day] }],
    ['another project', { projectId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f', effectiveFromMonth: '2026-10-01', shifts: [day] }],
    ['seconds in a time', { projectId: PROJECT, effectiveFromMonth: '2026-10-01', shifts: [{ ...day, startLocal: '06:00:00' }] }],
    ['database vocabulary', { projectId: PROJECT, effectiveFromMonth: '2026-10-01', shifts: [{ ...day, shiftKind: 'TAG' }] }],
    ['a repeated kind', { projectId: PROJECT, effectiveFromMonth: '2026-10-01', shifts: [day, { ...day, id: 's-3' }] }],
    ['more than two rules', { projectId: PROJECT, effectiveFromMonth: '2026-10-01', shifts: [day, night, { ...night, id: 's-4' }] }],
    ['no object', ['not', 'an', 'object']],
  ])('rejects a malformed answer (%s) instead of showing it', async (_label, body) => {
    const { client } = clientAnswering(body);
    await expect(client.get(PROJECT, '2026-12')).rejects.toMatchObject({ kind: 'invalid-response' });
  });

  it('accepts the server\'s lower-case canonical id for an upper-case route id', async () => {
    const { client } = clientAnswering({ projectId: PROJECT, effectiveFromMonth: null, shifts: [] });
    expect((await client.get(PROJECT.toUpperCase(), '2026-12')).projectId).toBe(PROJECT);
  });

  it('PATCH sends the full set for exactly the selected month, without ids or tenant fields', async () => {
    const { client, requests } = clientAnswering({ projectId: PROJECT, effectiveFromMonth: '2026-12-01', shifts: [day] });
    const shift = { shiftKind: 'DAY' as const, startLocal: '06:00', endLocal: '18:00', id: 'must-not-be-sent' };
    expect(await client.replace(PROJECT, '2026-12', [shift])).toEqual({ projectId: PROJECT, effectiveFromMonth: '2026-12', shifts: [day] });
    expect(requests).toEqual([{
      path: URL_BASE,
      method: 'PATCH',
      body: { effectiveFromMonth: '2026-12-01', shifts: [{ shiftKind: 'DAY', startLocal: '06:00', endLocal: '18:00' }] },
    }]);
  });

  it('a PATCH answer for another month than the written one is a contract defect', async () => {
    const { client } = clientAnswering({ projectId: PROJECT, effectiveFromMonth: '2026-10-01', shifts: [day] });
    await expect(client.replace(PROJECT, '2026-12', [day])).rejects.toMatchObject({ kind: 'invalid-response' });
  });
});
