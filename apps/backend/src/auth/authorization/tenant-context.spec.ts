import type { QueryResult } from 'pg';
import type { ValidatedSession } from '../session.service.js';
import { toTenantContext } from './current-tenant.decorator.js';
import { requireRow } from './require-row.js';
import { TENANT_ROLES, isTenantRole } from './tenant-context.js';

const session: ValidatedSession = {
  sessionId: 'a7f6dd29-9f8d-4a48-9827-88529bd1de8d',
  accountId: '04c34213-314b-4798-93e3-50e64997a2b5',
  companyId: '80e455a0-a1ea-4ef4-a4d7-30c919ae48b9',
  email: 'synthetic@secureplan.invalid',
  role: 'COMPANY_ADMIN',
  csrfToken: 'b'.repeat(43),
  absoluteExpiresAt: new Date('2030-01-01T00:00:00Z'),
};

function result<T extends Record<string, unknown>>(rows: T[]): QueryResult<T> {
  return { rows, rowCount: rows.length } as QueryResult<T>;
}

describe('SP-06 — tenant context primitives', () => {
  it('knows exactly the two MVP tenant roles; PLATFORM_ADMIN is not one', () => {
    expect([...TENANT_ROLES]).toEqual(['EMPLOYEE', 'COMPANY_ADMIN']);
    expect(isTenantRole('EMPLOYEE')).toBe(true);
    expect(isTenantRole('COMPANY_ADMIN')).toBe(true);
    for (const value of ['PLATFORM_ADMIN', 'company_admin', '', null, undefined, 1]) {
      expect(isTenantRole(value)).toBe(false);
    }
  });

  it('TenantContext carries only authoritative identity, frozen, without secrets', () => {
    const tenant = toTenantContext(session);
    expect(tenant).toEqual({
      sessionId: session.sessionId,
      accountId: session.accountId,
      companyId: session.companyId,
      role: 'COMPANY_ADMIN',
    });
    expect(Object.isFrozen(tenant)).toBe(true);
    expect(JSON.stringify(tenant)).not.toContain(session.csrfToken);
    expect(JSON.stringify(tenant)).not.toContain(session.email);
  });

  it('requireRow conceals zero rows as 404 RESOURCE_NOT_FOUND', () => {
    expect(requireRow(result([{ id: 'x' }]))).toEqual({ id: 'x' });
    expect(() => requireRow(result([]))).toThrow(expect.objectContaining({
      status: 404, response: { code: 'RESOURCE_NOT_FOUND' },
    }));
  });

  it('requireRow treats multiple rows as a server defect, not as a missing resource', () => {
    let thrown: unknown;
    try {
      requireRow(result([{ id: 'x' }, { id: 'y' }]));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    // Not an HttpException: the filter maps it to 500 INTERNAL_ERROR without details.
    expect(thrown).not.toHaveProperty('status');
  });
});
