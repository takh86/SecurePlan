// Loaded by Nest at runtime; class-transformer's @Type() needs it in isolation.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateProjectDto, ListProjectsQueryDto, UpdateProjectDto } from './project.dto.js';

async function failedProperties<T extends object>(type: new () => T, plain: Record<string, unknown>) {
  const errors = await validate(plainToInstance(type, plain), { whitelist: true, forbidNonWhitelisted: true });
  return errors.map((error) => error.property).sort();
}

describe('SP-08 — CreateProjectDto', () => {
  it('trims the name and accepts the 2..100 boundaries', async () => {
    const dto = plainToInstance(CreateProjectDto, { name: '  Objekt Nord ' });
    expect(await validate(dto)).toEqual([]);
    expect(dto.name).toBe('Objekt Nord');
    expect(await failedProperties(CreateProjectDto, { name: 'AB' })).toEqual([]);
    expect(await failedProperties(CreateProjectDto, { name: 'N'.repeat(100) })).toEqual([]);
  });

  it('rejects missing, too short, too long and non-string names', async () => {
    expect(await failedProperties(CreateProjectDto, {})).toEqual(['name']);
    expect(await failedProperties(CreateProjectDto, { name: '  A  ' })).toEqual(['name']);
    expect(await failedProperties(CreateProjectDto, { name: 'N'.repeat(101) })).toEqual(['name']);
    expect(await failedProperties(CreateProjectDto, { name: 42 })).toEqual(['name']);
  });

  it('has no status, address or tenant field', async () => {
    for (const field of ['status', 'address', 'internalCode', 'companyId']) {
      expect(await failedProperties(CreateProjectDto, { name: 'Objekt', [field]: 'x' })).toEqual([field]);
    }
  });
});

describe('SP-08 — UpdateProjectDto', () => {
  it('validates only sent fields; status is ACTIVE or INACTIVE only', async () => {
    expect(await failedProperties(UpdateProjectDto, {})).toEqual([]);
    expect(await failedProperties(UpdateProjectDto, { status: 'INACTIVE' })).toEqual([]);
    expect(await failedProperties(UpdateProjectDto, { status: 'ACTIVE', name: 'Neu' })).toEqual([]);
    expect(await failedProperties(UpdateProjectDto, { status: 'ARCHIVED' })).toEqual(['status']);
    expect(await failedProperties(UpdateProjectDto, { status: 'inactive' })).toEqual(['status']);
  });

  it('rejects null for name and status', async () => {
    expect(await failedProperties(UpdateProjectDto, { name: null, status: null })).toEqual(['name', 'status']);
  });
});

describe('SP-08 — ListProjectsQueryDto', () => {
  it('converts numeric query strings and enforces bounds and whitelists', async () => {
    const dto = plainToInstance(ListProjectsQueryDto, { page: '3', pageSize: '100', sortBy: 'status', sortOrder: 'desc' });
    expect(await validate(dto)).toEqual([]);
    expect(dto).toMatchObject({ page: 3, pageSize: 100 });
    expect(await failedProperties(ListProjectsQueryDto, { pageSize: '101' })).toEqual(['pageSize']);
    expect(await failedProperties(ListProjectsQueryDto, { sortBy: 'createdAt' })).toEqual(['sortBy']);
    expect(await failedProperties(ListProjectsQueryDto, { status: 'ARCHIVED' })).toEqual(['status']);
    expect(await failedProperties(ListProjectsQueryDto, { q: ' x ' })).toEqual(['q']);
  });
});
