// Loaded by Nest at runtime; class-transformer's @Type() needs it in isolation.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateEmployeeDto, ListEmployeesQueryDto, UpdateEmployeeDto } from './employee.dto.js';

async function failedProperties<T extends object>(type: new () => T, plain: Record<string, unknown>) {
  const errors = await validate(plainToInstance(type, plain), { whitelist: true, forbidNonWhitelisted: true });
  return errors.map((error) => error.property).sort();
}

const validCreate = {
  employeeCode: 'A-001',
  firstName: 'Alex',
  lastName: 'Beispiel',
  email: 'alex@secureplan.invalid',
  shiftEligibility: 'BOTH',
};

describe('SP-07 — CreateEmployeeDto', () => {
  it('accepts a minimal valid create and trims business text', async () => {
    const dto = plainToInstance(CreateEmployeeDto, {
      ...validCreate,
      employeeCode: '  A-001 ',
      firstName: ' Alex ',
      email: ' alex@secureplan.invalid ',
    });
    expect(await validate(dto)).toEqual([]);
    expect(dto).toMatchObject({ employeeCode: 'A-001', firstName: 'Alex', email: 'alex@secureplan.invalid' });
  });

  it('rejects invalid codes, names, e-mail, dates and API-foreign enum values', async () => {
    expect(await failedProperties(CreateEmployeeDto, { ...validCreate, employeeCode: '.leading-dot' })).toEqual(['employeeCode']);
    expect(await failedProperties(CreateEmployeeDto, { ...validCreate, employeeCode: 'has space' })).toEqual(['employeeCode']);
    expect(await failedProperties(CreateEmployeeDto, { ...validCreate, firstName: '  A  ' })).toEqual(['firstName']);
    expect(await failedProperties(CreateEmployeeDto, { ...validCreate, email: 'x'.repeat(250) + '@a.de' })).toEqual(['email']);
    expect(await failedProperties(CreateEmployeeDto, { ...validCreate, employmentStart: '2026-13-01' })).toEqual(['employmentStart']);
    expect(await failedProperties(CreateEmployeeDto, { ...validCreate, employmentStart: '2026-11-01T00:00:00Z' }))
      .toEqual(['employmentStart']);
    expect(await failedProperties(CreateEmployeeDto, { ...validCreate, shiftEligibility: 'NACHT' })).toEqual(['shiftEligibility']);
  });

  it('accepts boundary lengths (code 30, names 2/50)', async () => {
    expect(await failedProperties(CreateEmployeeDto, {
      ...validCreate,
      employeeCode: 'A'.repeat(30),
      firstName: 'Al',
      lastName: 'B'.repeat(50),
    })).toEqual([]);
  });
});

describe('SP-07 — UpdateEmployeeDto', () => {
  it('validates only sent fields and allows clearing nullable dates', async () => {
    expect(await failedProperties(UpdateEmployeeDto, {})).toEqual([]);
    expect(await failedProperties(UpdateEmployeeDto, { employmentEnd: null, employmentStart: null })).toEqual([]);
    expect(await failedProperties(UpdateEmployeeDto, { shiftEligibility: 'NIGHT' })).toEqual([]);
  });

  it('rejects null for required master data and has no e-mail field', async () => {
    expect(await failedProperties(UpdateEmployeeDto, { employeeCode: null, lastName: null })).toEqual(['employeeCode', 'lastName']);
    expect(await failedProperties(UpdateEmployeeDto, { email: 'new@secureplan.invalid' })).toEqual(['email']);
  });
});

describe('SP-07 — ListEmployeesQueryDto', () => {
  it('converts numeric query strings and enforces bounds and whitelists', async () => {
    const dto = plainToInstance(ListEmployeesQueryDto, { page: '2', pageSize: '100', sortBy: 'lastName', sortOrder: 'desc' });
    expect(await validate(dto)).toEqual([]);
    expect(dto).toMatchObject({ page: 2, pageSize: 100 });
    expect(await failedProperties(ListEmployeesQueryDto, { pageSize: '101' })).toEqual(['pageSize']);
    expect(await failedProperties(ListEmployeesQueryDto, { page: '1.5' })).toEqual(['page']);
    expect(await failedProperties(ListEmployeesQueryDto, { sortBy: 'email' })).toEqual(['sortBy']);
    expect(await failedProperties(ListEmployeesQueryDto, { q: ' x ' })).toEqual(['q']);
    expect(await failedProperties(ListEmployeesQueryDto, { status: ['ACTIVE', 'INACTIVE'] })).toEqual(['status']);
  });
});
