import { BadRequestException } from '@nestjs/common';

/**
 * `Expected-Version` request header (Phase 8.7 v1 contract; no If-Match/412/428).
 *
 * Call it as the FIRST statement of the handler with the raw
 * `@Headers('expected-version')` value. NestJS does not run pipes on `@Headers()`
 * parameters, so a validation pipe there would be skipped silently (fail open).
 *
 * - missing                     -> 400 EXPECTED_VERSION_REQUIRED
 * - anything but one positive decimal safe integer without sign, leading zero,
 *   inner whitespace or exponent -> 400 INVALID_EXPECTED_VERSION. Node joins a
 *   header sent twice into "a, b" (even with equal values), which is invalid
 *   here; surrounding optional whitespace is already stripped by the HTTP parser.
 */
export function parseExpectedVersion(header: string | string[] | undefined): number {
  if (header === undefined) throw new BadRequestException({ code: 'EXPECTED_VERSION_REQUIRED' });
  if (typeof header === 'string' && /^[1-9][0-9]{0,15}$/.test(header)) {
    const version = Number(header);
    if (Number.isSafeInteger(version)) return version;
  }
  throw new BadRequestException({ code: 'INVALID_EXPECTED_VERSION' });
}
