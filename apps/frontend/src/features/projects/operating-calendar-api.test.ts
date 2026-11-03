import { describe, expect, it } from 'vitest';
import { ApiError } from '../../shared/api/api-error';
import { fakeSessionApi } from '../employees/employees.test-support';
import { createOperatingCalendarApi, hasNoCalendarVersions, type CalendarRead } from './operating-calendar-api';

// Synthetic example values; every weekday set is an explicit example, not a default or business rule.
const PROJECT = '7a2be0c4-1d3e-4f5a-8b6c-9d0e1f2a3b4c';
const PATH = `/api/v1/projects/${PROJECT}/operating-calendar`;
const OCTOBER = '9a000000-0000-4000-8000-202610000002';
const DECEMBER = '9a000000-0000-4000-8000-202612000003';

const configured = (overrides: Record<string, unknown> = {}) => ({
  projectId: PROJECT,
  effectiveForMonth: '2026-12-01',
  state: 'CONFIGURED',
  effective: { id: DECEMBER, effectiveFromMonth: '2026-12-01', operatingWeekdays: [2, 3, 4, 5, 6], version: 3 },
  exactVersion: { id: DECEMBER, version: 3 },
  nextEffectiveFromMonth: '2027-03-01',
  ...overrides,
});
const missing = (overrides: Record<string, unknown> = {}) => ({
  projectId: PROJECT, effectiveForMonth: '2026-12-01', state: 'MISSING', effective: null, exactVersion: null,
  nextEffectiveFromMonth: null, ...overrides,
});

function clientAnswering(body: unknown) {
  const fake = fakeSessionApi(() => body);
  return { ...fake, client: createOperatingCalendarApi(fake.api) };
}

async function invalidResponse(promise: Promise<unknown>) {
  const error = await promise.then(() => null, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).kind).toBe('invalid-response');
}

describe('F-A1-2 operating calendar client — reading', () => {
  it('reads one month (YYYY-MM-01 only; no tenant, role or company parameter) and keeps only known fields', async () => {
    const { client, requests } = clientAnswering({ ...configured(), companyId: 'leak' });
    expect(await client.get(PROJECT, '2026-12')).toEqual({
      projectId: PROJECT,
      month: '2026-12',
      state: 'CONFIGURED',
      effective: { id: DECEMBER, effectiveFromMonth: '2026-12', operatingWeekdays: [2, 3, 4, 5, 6], version: 3 },
      exactVersion: { id: DECEMBER, version: 3 },
      nextEffectiveFromMonth: '2027-03',
    });
    expect(requests).toEqual([{ path: `${PATH}?effectiveForMonth=2026-12-01`, method: 'GET', body: undefined }]);
  });

  it('MISSING is a state, not an error, and never carries an invented weekday set', async () => {
    const read = await clientAnswering(missing()).client.get(PROJECT, '2026-12');
    expect([read.state, read.effective, read.exactVersion]).toEqual(['MISSING', null, null]);
  });

  it('an inherited version has no exact version for the month', async () => {
    const read = await clientAnswering(configured({
      effective: { id: OCTOBER, effectiveFromMonth: '2026-10-01', operatingWeekdays: [1, 7], version: 2 },
      exactVersion: null,
    })).client.get(PROJECT, '2026-12');
    expect(read.effective?.effectiveFromMonth).toBe('2026-10');
    expect(read.exactVersion).toBeNull();
  });

  it.each([
    ['another project', configured({ projectId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f' })],
    ['another month', configured({ effectiveForMonth: '2026-11-01' })],
    ['an unknown state', configured({ state: 'DEFAULT' })],
    ['CONFIGURED without a version', configured({ effective: null, exactVersion: null })],
    ['MISSING with a version', configured({ state: 'MISSING' })],
    ['an effective version after the month', configured({
      effective: { id: DECEMBER, effectiveFromMonth: '2027-01-01', operatingWeekdays: [2], version: 3 }, exactVersion: null })],
    ['an own-month version without exact reference', configured({ exactVersion: null })],
    ['an inherited version with exact reference', configured({
      effective: { id: OCTOBER, effectiveFromMonth: '2026-10-01', operatingWeekdays: [2], version: 2 } })],
    ['an exact reference that differs from the effective one', configured({ exactVersion: { id: DECEMBER, version: 2 } })],
    ['an empty weekday set', configured({ effective: { id: DECEMBER, effectiveFromMonth: '2026-12-01', operatingWeekdays: [], version: 3 } })],
    ['weekday 0', configured({ effective: { id: DECEMBER, effectiveFromMonth: '2026-12-01', operatingWeekdays: [0, 1], version: 3 } })],
    ['weekday 8', configured({ effective: { id: DECEMBER, effectiveFromMonth: '2026-12-01', operatingWeekdays: [7, 8], version: 3 } })],
    ['unsorted weekdays', configured({ effective: { id: DECEMBER, effectiveFromMonth: '2026-12-01', operatingWeekdays: [3, 2], version: 3 } })],
    ['duplicate weekdays', configured({ effective: { id: DECEMBER, effectiveFromMonth: '2026-12-01', operatingWeekdays: [2, 2], version: 3 } })],
    ['a non-integer version', configured({ effective: { id: DECEMBER, effectiveFromMonth: '2026-12-01', operatingWeekdays: [2], version: 1.5 }, exactVersion: { id: DECEMBER, version: 1.5 } })],
    ['a non-UUID id', configured({ effective: { id: 'x', effectiveFromMonth: '2026-12-01', operatingWeekdays: [2], version: 3 }, exactVersion: { id: 'x', version: 3 } })],
    ['a next version not after the month', configured({ nextEffectiveFromMonth: '2026-12-01' })],
    ['a mid-month next version', configured({ nextEffectiveFromMonth: '2027-03-15' })],
    ['no object', null],
  ])('rejects %s as an invalid response', async (_case, body) => {
    await invalidResponse(clientAnswering(body).client.get(PROJECT, '2026-12'));
  });

  it('only "MISSING and no later version" means: no calendar version exists at all', async () => {
    const read = (body: unknown) => clientAnswering(body).client.get(PROJECT, '2026-12');
    expect(hasNoCalendarVersions(await read(missing()))).toBe(true);
    expect(hasNoCalendarVersions(await read(missing({ nextEffectiveFromMonth: '2027-02-01' })))).toBe(false);
    expect(hasNoCalendarVersions(await read(configured({ nextEffectiveFromMonth: null })))).toBe(false);
  });
});

describe('F-A1-2 operating calendar client — writing', () => {
  const basisOf = async (body: unknown): Promise<CalendarRead> => clientAnswering(body).client.get(PROJECT, '2026-12');

  it('sends the complete, sorted set and the exact/effective/next preconditions of the reviewed read', async () => {
    const basis = await basisOf(configured());
    const { client, requests } = clientAnswering({ ...configured({
      effective: { id: DECEMBER, effectiveFromMonth: '2026-12-01', operatingWeekdays: [1, 2, 3], version: 4 },
      exactVersion: { id: DECEMBER, version: 4 },
    }), outcome: 'APPLIED' });
    const result = await client.replace(PROJECT, { basis, operatingWeekdays: [3, 1, 2, 2], bootstrap: false });
    expect(requests).toEqual([{
      path: PATH,
      method: 'PATCH',
      body: {
        effectiveFromMonth: '2026-12-01',
        expectedExactVersion: { id: DECEMBER, version: 3 },
        expectedEffective: { id: DECEMBER, version: 3 },
        expectedNextEffectiveFromMonth: '2027-03-01',
        operatingWeekdays: [1, 2, 3],
        bootstrap: false,
      },
    }]);
    expect([result.outcome, result.exactVersion?.version]).toEqual(['APPLIED', 4]);
  });

  it('MISSING basis: all preconditions null; bootstrap is sent only when requested', async () => {
    const basis = await basisOf(missing());
    const { client, requests } = clientAnswering({ ...configured({ nextEffectiveFromMonth: null }), outcome: 'APPLIED' });
    await client.replace(PROJECT, { basis, operatingWeekdays: [2, 3, 4, 5, 6], bootstrap: true });
    expect(requests[0].body).toEqual({
      effectiveFromMonth: '2026-12-01', expectedExactVersion: null, expectedEffective: null,
      expectedNextEffectiveFromMonth: null, operatingWeekdays: [2, 3, 4, 5, 6], bootstrap: true,
    });
  });

  it('an inherited basis protects the inherited version and the absence of an own version', async () => {
    const basis = await basisOf(configured({
      effective: { id: OCTOBER, effectiveFromMonth: '2026-10-01', operatingWeekdays: [1, 7], version: 2 }, exactVersion: null,
    }));
    const { client, requests } = clientAnswering({ ...configured({
      effective: { id: DECEMBER, effectiveFromMonth: '2026-12-01', operatingWeekdays: [1, 7], version: 1 },
      exactVersion: { id: DECEMBER, version: 1 },
    }), outcome: 'APPLIED' });
    await client.replace(PROJECT, { basis, operatingWeekdays: [7, 1], bootstrap: false });
    expect(requests[0].body).toMatchObject({ expectedExactVersion: null, expectedEffective: { id: OCTOBER, version: 2 } });
  });

  it('never sends an empty or out-of-range set (caller defect, no request)', async () => {
    const basis = await basisOf(missing());
    const { client, requests } = clientAnswering({});
    await expect(client.replace(PROJECT, { basis, operatingWeekdays: [], bootstrap: false })).rejects.toThrow();
    await expect(client.replace(PROJECT, { basis, operatingWeekdays: [8 as never], bootstrap: false })).rejects.toThrow();
    await expect(client.replace('1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f', { basis, operatingWeekdays: [1], bootstrap: false })).rejects.toThrow();
    expect(requests).toEqual([]);
  });

  it.each([
    ['no outcome', configured()],
    ['an unknown outcome', { ...configured(), outcome: 'DONE' }],
    ['a set other than the one sent', { ...configured(), outcome: 'APPLIED' }],
    ['no exact version after the write', { ...configured({ exactVersion: null, effective: {
      id: OCTOBER, effectiveFromMonth: '2026-10-01', operatingWeekdays: [1], version: 2 } }), outcome: 'APPLIED' }],
    ['an answer for another month', { ...configured({ effectiveForMonth: '2027-01-01' }), outcome: 'APPLIED' }],
  ])('a write answer with %s is an invalid response (outcome unknown)', async (_case, body) => {
    const basis = await basisOf(missing());
    await invalidResponse(clientAnswering(body).client.replace(PROJECT, { basis, operatingWeekdays: [1], bootstrap: false }));
  });
});
