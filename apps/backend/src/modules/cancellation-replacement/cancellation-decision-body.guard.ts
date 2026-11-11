import {
  BadRequestException,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';

/** Reject own keys that Nest sanitizes away before the global DTO whitelist runs. */
@Injectable()
export class CancellationDecisionBodyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const body: unknown = context.switchToHttp().getRequest<Request>().body;
    if (
      body !== null &&
      typeof body === 'object' &&
      ['__proto__', 'prototype', 'constructor'].some((key) =>
        Object.hasOwn(body, key),
      )
    ) {
      throw new BadRequestException({ code: 'UNKNOWN_FIELD' });
    }
    return true;
  }
}
