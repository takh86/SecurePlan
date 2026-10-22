import { NotFoundException } from '@nestjs/common';
import { uniqueViolationConstraint } from '../database/unique-violation.js';
import { ResourceIdPipe } from './resource-id.pipe.js';

describe('SP-07 — ResourceIdPipe', () => {
  const pipe = new ResourceIdPipe();

  it('passes canonical UUIDs through (normalized to lower case)', () => {
    expect(pipe.transform('6F1AD9A6-3A0C-4B7C-9C5E-0D4F2A1E8B11')).toBe('6f1ad9a6-3a0c-4b7c-9c5e-0d4f2a1e8b11');
  });

  it('answers 404 RESOURCE_NOT_FOUND for anything that cannot be an id', () => {
    for (const value of ['', 'not-a-uuid', '6f1ad9a6-3a0c-4b7c-9c5e-0d4f2a1e8b1', "1' OR '1'='1", '../me']) {
      expect(() => pipe.transform(value)).toThrow(NotFoundException);
      try {
        pipe.transform(value);
      } catch (error) {
        expect((error as NotFoundException).getResponse()).toEqual({ code: 'RESOURCE_NOT_FOUND' });
      }
    }
  });
});

describe('SP-07 — uniqueViolationConstraint', () => {
  it('returns the constraint name only for PostgreSQL unique violations', () => {
    expect(uniqueViolationConstraint({ code: '23505', constraint: 'uq_accounts_email_lower' })).toBe('uq_accounts_email_lower');
    expect(uniqueViolationConstraint({ code: '23503', constraint: 'fk_employees__accounts' })).toBeNull();
    expect(uniqueViolationConstraint({ code: '23505' })).toBeNull();
    expect(uniqueViolationConstraint(new Error('boom'))).toBeNull();
    expect(uniqueViolationConstraint(null)).toBeNull();
  });
});
