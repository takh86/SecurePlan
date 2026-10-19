/**
 * SP-06 — the single global (APP_GUARD) access-control guard.
 *
 * One guard with a fixed internal sequence instead of several global guards,
 * so ordering never depends on provider registration and the session is
 * validated (and touched) exactly once per request:
 *
 *   1. classify  handler metadata: @Public -> allow (route guards still run);
 *                @RequireRoles -> continue; missing/ambiguous -> 403 (deny)
 *   2. origin    unsafe methods only, BEFORE cookie parsing or DB access
 *   3. session   cookie format (no DB), then one validateAndTouch()
 *   4. csrf      unsafe methods only, against the validated session
 *   5. roles     live DB role must be listed in @RequireRoles
 *
 * Resource-level decisions (tenant scope, ownership, 404 concealment) are not
 * made here; they belong to services/SQL using the trusted TenantContext.
 */
import {
  ForbiddenException,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { assertTrustedOrigin } from '../login-origin.guard.js';
import { extractSessionToken, type AuthenticatedSessionRequest } from '../session-cookie.js';
import { SessionService, assertSessionCsrf } from '../session.service.js';
import { PUBLIC_ACCESS, REQUIRED_ROLES } from './access-metadata.js';
import { isTenantRole, type TenantRole } from './tenant-context.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function forbidden(): never {
  throw new ForbiddenException({ code: 'ACTION_FORBIDDEN' });
}

@Injectable()
export class AccessControlGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Only HTTP is served. Any other transport is denied rather than guessed.
    if (context.getType() !== 'http') forbidden();

    // 1. Classification is read from the HANDLER only (never the class).
    const handler = context.getHandler();
    const isPublic = this.reflector.get<boolean | undefined>(PUBLIC_ACCESS, handler) === true;
    const roles = this.reflector.get<readonly TenantRole[] | undefined>(REQUIRED_ROLES, handler);
    const hasRoles = Array.isArray(roles) && roles.length > 0 && roles.every(isTenantRole);

    if (isPublic && roles === undefined) return true;
    if (isPublic || !hasRoles) forbidden(); // ambiguous or unclassified: default deny

    const request = context.switchToHttp().getRequest<AuthenticatedSessionRequest>();
    // Only this guard may establish session state. A second evaluation would
    // mean duplicate validation/touching: fail closed as a server error.
    if (request.validatedSession !== undefined || request.rawSessionToken !== undefined) {
      throw new Error('Session state was established before AccessControlGuard');
    }
    const unsafe = !SAFE_METHODS.has(request.method.toUpperCase());

    // 2. Origin before any session lookup.
    if (unsafe) assertTrustedOrigin(request);

    // 3. Session: format check without DB, then one authoritative validation.
    const token = extractSessionToken(request.headers.cookie);
    const session = await this.sessions.validateAndTouch(token);

    // 4. CSRF against the validated session's secret.
    if (unsafe) assertSessionCsrf(request.get('x-csrf-token'), session.csrfToken);

    // 5. Role from the live accounts row (validateAndTouch), never from input.
    if (!roles.includes(session.role)) forbidden();

    request.validatedSession = session;
    request.rawSessionToken = token;
    return true;
  }
}
