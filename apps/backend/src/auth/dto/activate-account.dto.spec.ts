import { validate } from 'class-validator';
import { ActivateAccountDto } from './activate-account.dto.js';

describe('ActivateAccountDto', () => {
  it('rejects a password shorter than 15 characters', async () => {
    const dto = Object.assign(new ActivateAccountDto(), {
      token: 'example-token',
      password: '12345678',
    });

    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'password')).toBe(true);
  });

  it('accepts a valid activation DTO', async () => {
    const dto = Object.assign(new ActivateAccountDto(), {
      token: 'valid-example-token',
      password: '1234567812345678',
    });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });

  it('rejects an empty activation token', async () => {
    const dto = Object.assign(new ActivateAccountDto(), {
      token: '',
      password: '1234567812345678',
    });

    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'token')).toBe(true);
  });

  it('accepts a password with exactly 15 characters', async () => {
    const password = 'a'.repeat(15);
    const dto = Object.assign(new ActivateAccountDto(), {
      token: 'example-token',
      password: password,
    });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });

  it('rejects a password longer than 128 characters', async () => {
    const password = 'a'.repeat(129);
    const dto = Object.assign(new ActivateAccountDto(), {
      token: 'example-token',
      password: password,
    });

    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'password')).toBe(true);
  });
});
