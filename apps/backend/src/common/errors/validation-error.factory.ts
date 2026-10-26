import { BadRequestException } from '@nestjs/common';
import type { ValidationError } from 'class-validator';
import {
  type ValidationSubcode,
  type ValidationSuberror,
  validationSubcodeDetails,
} from './error-contract.js';

/** Only controlled subcodes and safe, fixed descriptions. No rejectedValue. */
function mapConstraint(constraints: Record<string, string>): ValidationSubcode | null {
  const names = Object.keys(constraints);
  if (names.includes('isDefined') || names.includes('isNotEmpty')) return 'REQUIRED';
  if (names.some((name) => ['isString', 'isInt', 'isNumber', 'isBoolean', 'isArray', 'isObject'].includes(name))) return 'INVALID_TYPE';
  // class-validator reports @IsUUID() under the constraint key 'isUuid'.
  if (names.includes('isUuid')) return 'INVALID_UUID';
  if (names.includes('isEnum')) return 'INVALID_ENUM';
  if (names.some((name) => ['isEmail', 'isDateString', 'isISO8601', 'matches', 'isUrl'].includes(name))) return 'INVALID_FORMAT';
  if (names.some((name) => ['minLength', 'arrayMinSize'].includes(name))) return 'TOO_SHORT';
  if (names.some((name) => ['maxLength', 'arrayMaxSize'].includes(name))) return 'TOO_LONG';
  if (names.some((name) => ['min', 'max', 'isPositive', 'isNegative'].includes(name))) return 'OUT_OF_RANGE';
  if (names.includes('arrayUnique')) return 'DUPLICATE_ITEM';
  return names.length > 0 ? 'INVALID_FORMAT' : null;
}

function escapePointerPart(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

function collectErrors(
  items: ValidationError[],
  path: string[],
  output: ValidationSuberror[],
): boolean {
  let containsUnknownField = false;
  for (const item of items) {
    if (item.constraints?.whitelistValidation !== undefined) {
      // Unknown property names are user-controlled and may contain sensitive text.
      // Reject the field but never echo its name/value into errors[].
      containsUnknownField = true;
      continue;
    }
    const currentPath = [...path, item.property];
    if (item.constraints !== undefined) {
      const code = mapConstraint(item.constraints);
      if (code !== null && output.length < 25) {
        output.push({
          pointer: `#/${currentPath.map(escapePointerPart).join('/')}`,
          code,
          detail: validationSubcodeDetails[code],
        });
      }
    }
    if (item.children?.length) {
      containsUnknownField = collectErrors(item.children, currentPath, output) || containsUnknownField;
    }
  }
  return containsUnknownField;
}

export function createValidationException(validationErrors: ValidationError[]): BadRequestException {
  const errors: ValidationSuberror[] = [];
  const hasUnknownField = collectErrors(validationErrors, [], errors);
  // Phase 8.5 E-002 explicitly permits UNKNOWN_FIELD as a top-level 400 code.
  // Mixed invalid/unknown input keeps VALIDATION_FAILED plus safe known-field suberrors.
  const code = hasUnknownField && errors.length === 0 ? 'UNKNOWN_FIELD' : 'VALIDATION_FAILED';
  return new BadRequestException({
    code,
    ...(errors.length > 0 ? { errors } : {}),
  });
}
