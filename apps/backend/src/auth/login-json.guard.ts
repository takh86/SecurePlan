import {
  Injectable,
  UnsupportedMediaTypeException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';

/** APPROVED Issue #51 transport amendment: nonempty login bodies must be JSON. */
@Injectable()
export class LoginJsonGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    // A zero Content-Length still counts as a body in Express's MIME helper.
    // Keep existing DTO validation for requests with no framed content.
    if (request.headers['transfer-encoding'] === undefined
      && Number(request.headers['content-length'] ?? 0) === 0) return true;
    // Its MIME parser handles parameters and case without accepting JSON lookalikes.
    if (request.is('application/json') === false) {
      throw new UnsupportedMediaTypeException({ code: 'UNSUPPORTED_MEDIA_TYPE' });
    }
    return true;
  }
}
