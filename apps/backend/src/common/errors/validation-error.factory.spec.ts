// Loaded by Nest at runtime; decorators need it in isolation.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { IsDefined, IsUUID, MaxLength, validate } from 'class-validator';
import { createValidationException } from './validation-error.factory.js';

class Probe {
  @IsDefined()
  @IsUUID('all')
  id!: string;

  @IsDefined()
  @MaxLength(3)
  name!: string;
}

async function errorsFor(plain: Record<string, unknown>) {
  const failures = await validate(plainToInstance(Probe, plain), { whitelist: true, forbidNonWhitelisted: true });
  return createValidationException(failures).getResponse();
}

describe('validation error factory — subcode mapping', () => {
  it('maps a malformed UUID to INVALID_UUID (class-validator key "isUuid"), without echoing the value', async () => {
    const response = await errorsFor({ id: 'not-a-uuid', name: 'abc' });
    expect(response).toEqual({
      code: 'VALIDATION_FAILED',
      errors: [{ pointer: '#/id', code: 'INVALID_UUID', detail: 'The field must contain a valid identifier.' }],
    });
    expect(JSON.stringify(response)).not.toContain('not-a-uuid');
  });

  it('keeps REQUIRED and TOO_LONG mappings', async () => {
    const response = await errorsFor({ name: 'abcd' }) as { errors: { pointer: string; code: string }[] };
    expect(response.errors.map(({ pointer, code }) => ({ pointer, code }))).toEqual([
      { pointer: '#/id', code: 'REQUIRED' },
      { pointer: '#/name', code: 'TOO_LONG' },
    ]);
  });
});
