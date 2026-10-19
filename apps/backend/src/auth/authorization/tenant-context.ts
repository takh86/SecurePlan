/**
 * SP-06 — trusted tenant identity.
 *
 * Single source of truth for MVP tenant roles. PLATFORM_ADMIN is deliberately
 * NOT a TenantRole: it has no implicit access to operational tenant data and
 * cannot obtain a tenant session.
 */
export const TENANT_ROLES = ['EMPLOYEE', 'COMPANY_ADMIN'] as const;

export type TenantRole = (typeof TENANT_ROLES)[number];

export function isTenantRole(value: unknown): value is TenantRole {
  return typeof value === 'string' && (TENANT_ROLES as readonly string[]).includes(value);
}

/**
 * Authoritative identity for authorization decisions and tenant-scoped SQL.
 * Built only from the server-validated session; never from client input.
 * Deliberately excludes email, CSRF secret and raw session token.
 */
export type TenantContext = Readonly<{
  sessionId: string;
  accountId: string;
  companyId: string;
  role: TenantRole;
}>;
