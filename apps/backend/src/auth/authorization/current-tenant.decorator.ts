/**
 * SP-06 — typed accessors for state established by AccessControlGuard.
 * All fail closed (401 SESSION_REQUIRED) instead of a non-null assertion crash
 * if a handler is ever reached without validated session state.
 */
import {
  UnauthorizedException,
  createParamDecorator,
  type ExecutionContext,
} from '@nestjs/common';
import type { AuthenticatedSessionRequest } from '../session-cookie.js';
import type { ValidatedSession } from '../session.service.js';
import type { TenantContext } from './tenant-context.js';

function sessionRequest(context: ExecutionContext): AuthenticatedSessionRequest {
  return context.switchToHttp().getRequest<AuthenticatedSessionRequest>();
}

function requireSession(context: ExecutionContext): ValidatedSession {
  const session = sessionRequest(context).validatedSession;
  if (!session) throw new UnauthorizedException({ code: 'SESSION_REQUIRED' });
  return session;
}

export function toTenantContext(session: ValidatedSession): TenantContext {
  return Object.freeze({
    sessionId: session.sessionId,
    accountId: session.accountId,
    companyId: session.companyId,
    role: session.role,
  });
}

/** Authorization identity for services and tenant-scoped SQL. */
export const CurrentTenant = createParamDecorator(
  (_data: unknown, context: ExecutionContext): TenantContext =>
    toTenantContext(requireSession(context)),
);

/**
 * Full server-validated session for identity/session endpoints only
 * (e.g. /me needs email and the CSRF response header). Business services
 * should depend on TenantContext instead.
 */
export const CurrentSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext): ValidatedSession => requireSession(context),
);

/** Raw session token for logout revocation only. Never log or serialize it. */
export const CurrentSessionToken = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    requireSession(context);
    const token = sessionRequest(context).rawSessionToken;
    if (!token) throw new UnauthorizedException({ code: 'SESSION_REQUIRED' });
    return token;
  },
);
