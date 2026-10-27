// Loaded by Nest at runtime; class-transformer's @Type() needs it in isolation.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateProjectAssignmentDto,
  ListProjectAssignmentsQueryDto,
  UpdateProjectAssignmentDto,
} from './project-assignment.dto.js';

async function failedProperties<T extends object>(type: new () => T, plain: Record<string, unknown>) {
  const errors = await validate(plainToInstance(type, plain), { whitelist: true, forbidNonWhitelisted: true });
  return errors.map((error) => error.property).sort();
}

const EMPLOYEE = '6f1ad9a6-3a0c-4b7c-9c5e-0d4f2a1e8b11';
const PROJECT = '01890a5d-ac96-774b-bcce-b302099a8057'; // UUID v7 shape (design: app-generated v7)
const valid = { employeeId: EMPLOYEE, projectId: PROJECT, monthStart: '2026-11-01' };

describe('SP-09 — CreateProjectAssignmentDto', () => {
  it('accepts the three required business dimensions', async () => {
    expect(await failedProperties(CreateProjectAssignmentDto, valid)).toEqual([]);
  });

  it('requires all three fields and rejects malformed ids and dates', async () => {
    expect(await failedProperties(CreateProjectAssignmentDto, {})).toEqual(['employeeId', 'monthStart', 'projectId']);
    expect(await failedProperties(CreateProjectAssignmentDto, { ...valid, employeeId: 'not-a-uuid' })).toEqual(['employeeId']);
    expect(await failedProperties(CreateProjectAssignmentDto, { ...valid, projectId: 42 })).toEqual(['projectId']);
    for (const monthStart of ['2026-13-01', '2026-02-30', '2026-11', '01.11.2026', '2026-11-01T00:00:00Z', 20261101]) {
      expect(await failedProperties(CreateProjectAssignmentDto, { ...valid, monthStart }), String(monthStart))
        .toEqual(['monthStart']);
    }
  });

  it('leaves the first-of-month rule to the service (dedicated INVALID_MONTH_START)', async () => {
    expect(await failedProperties(CreateProjectAssignmentDto, { ...valid, monthStart: '2026-11-15' })).toEqual([]);
  });

  it('has no tenant, id or status field', async () => {
    for (const field of ['companyId', 'id', 'status', 'accountId']) {
      expect(await failedProperties(CreateProjectAssignmentDto, { ...valid, [field]: 'x' })).toEqual([field]);
    }
  });
});

describe('SP-09 — ListProjectAssignmentsQueryDto', () => {
  it('requires monthStart and validates optional filters and paging', async () => {
    expect(await failedProperties(ListProjectAssignmentsQueryDto, {})).toEqual(['monthStart']);
    const dto = plainToInstance(ListProjectAssignmentsQueryDto, {
      monthStart: '2027-01-01', projectId: PROJECT, employeeId: EMPLOYEE, page: '2', pageSize: '100',
    });
    expect(await validate(dto)).toEqual([]);
    expect(dto).toMatchObject({ page: 2, pageSize: 100 });
    expect(await failedProperties(ListProjectAssignmentsQueryDto, { monthStart: '2027-01-01', projectId: 'x' })).toEqual(['projectId']);
    expect(await failedProperties(ListProjectAssignmentsQueryDto, { monthStart: '2027-01-01', pageSize: '101' })).toEqual(['pageSize']);
    expect(await failedProperties(ListProjectAssignmentsQueryDto, { monthStart: ['2027-01-01', '2027-02-01'] })).toEqual(['monthStart']);
    expect(await failedProperties(ListProjectAssignmentsQueryDto, { monthStart: '2027-01-01', sortBy: 'name' })).toEqual(['sortBy']);
  });
});

describe('SP-09 — UpdateProjectAssignmentDto (correction only)', () => {
  it('validates only sent fields; every field is optional here (EMPTY_PATCH is a service rule)', async () => {
    expect(await failedProperties(UpdateProjectAssignmentDto, {})).toEqual([]);
    expect(await failedProperties(UpdateProjectAssignmentDto, { projectId: PROJECT })).toEqual([]);
    expect(await failedProperties(UpdateProjectAssignmentDto, { employeeId: EMPLOYEE, projectId: PROJECT, monthStart: '2027-01-01' })).toEqual([]);
  });

  it('rejects null, malformed ids/dates and any foreign field', async () => {
    expect(await failedProperties(UpdateProjectAssignmentDto, { employeeId: null, projectId: null, monthStart: null }))
      .toEqual(['employeeId', 'monthStart', 'projectId']);
    expect(await failedProperties(UpdateProjectAssignmentDto, { employeeId: 'x' })).toEqual(['employeeId']);
    expect(await failedProperties(UpdateProjectAssignmentDto, { monthStart: '2027-13-01' })).toEqual(['monthStart']);
    for (const field of ['companyId', 'id', 'status', 'accountId']) {
      expect(await failedProperties(UpdateProjectAssignmentDto, { [field]: 'x' })).toEqual([field]);
    }
  });
});