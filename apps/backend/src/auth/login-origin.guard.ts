import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Request } from 'express';

/** Strict Origin check for this browser-facing login route. */
@Injectable()
export class LoginOriginGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const configured = process.env.APP_ORIGIN;
    // Never silently relax Secure cookies to run the authentication over HTTP.
    if (!configured || !/^https:\/\/[^/]+$/.test(configured)) {
      throw new ServiceUnavailableException({ code: 'SERVICE_UNAVAILABLE' });
    }

    const request = context.switchToHttp().getRequest<Request>();
    const received = request.get('origin');
    if (received !== configured) {
      throw new ForbiddenException({ code: 'CSRF_VALIDATION_FAILED' });
    }
    return true;
  }
}
