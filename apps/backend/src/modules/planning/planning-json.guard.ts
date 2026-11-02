import { Injectable, UnsupportedMediaTypeException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/** Planning creates accept JSON; global access control runs before this guard. */
@Injectable()
export class PlanningJsonGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    // Unframed/empty content keeps the DTO's required-field 400 contract.
    if (request.headers['transfer-encoding'] === undefined
      && Number(request.headers['content-length'] ?? 0) === 0) return true;
    if (!request.is('application/json')) {
      throw new UnsupportedMediaTypeException({ code: 'UNSUPPORTED_MEDIA_TYPE' });
    }
    return true;
  }
}
