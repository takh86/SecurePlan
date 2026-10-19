import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Request } from 'express';

/**
 * Strict Origin check for browser-facing, state-changing requests.
 * Performs no cookie parsing and no database access, so it can run first.
 */
export function assertTrustedOrigin(request: Request): void {
  const configured = process.env.APP_ORIGIN;
  // Never silently relax Secure cookies to run the authentication over HTTP.
  if (!configured || !/^https:\/\/[^/]+$/.test(configured)) {
    throw new ServiceUnavailableException({ code: 'SERVICE_UNAVAILABLE' });
  }

  const received = request.get('origin');
  if (received !== configured) {
    throw new ForbiddenException({ code: 'CSRF_VALIDATION_FAILED' });
  }
}

/** Strict Origin check for the public login route. */
@Injectable()
export class LoginOriginGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    assertTrustedOrigin(context.switchToHttp().getRequest<Request>());
    return true;
  }
}
