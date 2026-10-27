/**
 * SecurePlan API codes: Phase 8.5 FINAL (06.10.2026), plus the Phase 8.7 additions
 * consolidated by Phase 8.11 FINAL. Status mappings are immutable public v1 contracts.
 *
 * Operational 503/SERVICE_UNAVAILABLE is a PROVISIONAL exception for readiness;
 * it is NOT listed in the approved Phase 8.5 application-code catalogue.
 */
const codesByStatus = {
  400: [
    'VALIDATION_FAILED',
    'INVALID_REQUEST_BODY',
    'INVALID_DATE',
    'INVALID_MONTH_START',
    'UNKNOWN_FIELD',
    'EMPTY_PATCH',
    'INVALID_FIELD_COMBINATION',
    'EMPLOYMENT_DATE_CONFLICT',
    'PASSWORD_POLICY_VIOLATION',
    'ACTIVATION_TOKEN_INVALID_OR_EXPIRED',
    'RESET_TOKEN_INVALID_OR_EXPIRED',
    'SHIFT_CONFIGURATION_INVALID',
    'DUTY_DATE_OUTSIDE_PLAN_MONTH',
    'IDEMPOTENCY_KEY_REQUIRED',
    'IDEMPOTENCY_KEY_INVALID',
    'EXPECTED_VERSION_REQUIRED',
    'INVALID_EXPECTED_VERSION',
    'EDIT_LEASE_TOKEN_REQUIRED',
  ],
  401: [
    'INVALID_CREDENTIALS',
    'SESSION_REQUIRED',
    'SESSION_EXPIRED',
    'SESSION_REVOKED',
  ],
  403: ['ACTION_FORBIDDEN', 'CSRF_VALIDATION_FAILED'],
  404: ['RESOURCE_NOT_FOUND'],
  409: [
    'EMPLOYEE_CODE_ALREADY_EXISTS',
    'EMAIL_ALREADY_IN_USE',
    'EMPLOYEE_INACTIVE',
    'EMPLOYEE_HAS_FUTURE_ASSIGNMENTS',
    'PROJECT_NAME_ALREADY_EXISTS',
    'PROJECT_INACTIVE',
    'EMPLOYEE_NOT_EMPLOYED_FOR_MONTH',
    'PROJECT_ASSIGNMENT_ALREADY_EXISTS',
    'PROJECT_ASSIGNMENT_CONFLICT',
    'PROJECT_ASSIGNMENT_CORRECTION_CONFLICT',
    'SHIFT_CONFIGURATION_CONFLICT',
    'SHIFT_CONFIGURATION_MISSING',
    'MONTHLY_PLAN_ALREADY_EXISTS',
    'MONTHLY_PLAN_ALREADY_PUBLISHED',
    'DUTY_ALREADY_EXISTS',
    'EMPLOYEE_NOT_ASSIGNED_TO_PROJECT_MONTH',
    'EMPLOYEE_NOT_ELIGIBLE_FOR_SHIFT',
    'EMPLOYEE_UNAVAILABLE',
    'DUTY_ASSIGNMENT_CONFLICT',
    'PLAN_CONCURRENT_MODIFICATION',
    'CANCELLATION_ALREADY_EXISTS',
    'CANCELLATION_ALREADY_RESOLVED',
    'CANCELLATION_NOT_WITHDRAWABLE',
    'CANCELLATION_ASSIGNMENT_NOT_ACTIVE',
    'CANCELLATION_PLAN_CHANGED',
    'REPLACEMENT_NEED_NOT_OPEN',
    'REPLACEMENT_OFFER_ALREADY_EXISTS',
    'REPLACEMENT_OFFER_NOT_SELECTABLE',
    'REPLACEMENT_CANDIDATE_INELIGIBLE',
    'REPLACEMENT_CANDIDATE_UNAVAILABLE',
    'REPLACEMENT_SELF_OFFER_NOT_ALLOWED',
    'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST',
    'RESOURCE_EDIT_LOCKED',
    'EDIT_LEASE_NOT_HELD',
    'IDEMPOTENCY_REQUEST_IN_PROGRESS',
  ],
  429: ['LOGIN_RATE_LIMITED', 'RATE_LIMITED'],
  500: ['INTERNAL_ERROR'],
} as const;

/** A list of known code/status pairs, not permission to introduce new endpoints. */
export function isApprovedErrorCode(code: string, status: number): boolean {
  const candidates = codesByStatus[status as keyof typeof codesByStatus];
  return candidates !== undefined && (candidates as readonly string[]).includes(code);
}

export function problemType(code: string): string {
  return `/problems/${code.toLowerCase().replaceAll('_', '-')}`;
}

export const validationSubcodeDetails = {
  REQUIRED: 'A required field is missing.',
  INVALID_TYPE: 'The field has an invalid type.',
  INVALID_FORMAT: 'The field has an invalid format.',
  INVALID_UUID: 'The field must contain a valid identifier.',
  INVALID_ENUM: 'The field contains an unsupported option.',
  TOO_SHORT: 'The value is too short.',
  TOO_LONG: 'The value is too long.',
  OUT_OF_RANGE: 'The value is out of the permitted range.',
  DUPLICATE_ITEM: 'The array contains a duplicate item.',
} as const;

export type ValidationSubcode = keyof typeof validationSubcodeDetails;
export type ValidationSuberror = {
  pointer: string;
  code: ValidationSubcode;
  detail: string;
};

export function isSafeValidationSuberror(value: unknown): value is ValidationSuberror {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.code === 'string' &&
    Object.hasOwn(validationSubcodeDetails, item.code) &&
    typeof item.pointer === 'string' &&
    item.pointer.length <= 192 &&
    /^#(?:\/(?:[A-Za-z0-9_-]|~[01])+)+$/.test(item.pointer)
  );
}
