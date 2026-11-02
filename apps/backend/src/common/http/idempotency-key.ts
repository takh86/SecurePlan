import { BadRequestException } from '@nestjs/common';
import type { Request } from 'express';

/** Shared Phase 8.7 parser, extracted unchanged from the SP-10 HTTP boundary. */
export function parseIdempotencyKey(request: Pick<Request, 'headers' | 'rawHeaders'>): string {
  const key = request.headers['idempotency-key'];
  if (key === undefined) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
  const count = request.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'idempotency-key').length;
  if (count !== 1 || typeof key !== 'string' || !/^[\x21-\x7e]{8,128}$/.test(key)) {
    throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_INVALID' });
  }
  return key;
}
