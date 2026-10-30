/**
 * SecurePlan API errors. Never display raw server `detail` or `message` fields.
 * The API status is authoritative; `code` is only trusted when known for that status.
 */
export type KnownErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNKNOWN_FIELD'
  | 'INVALID_REQUEST_BODY'
  | 'SESSION_REQUIRED'
  | 'SESSION_EXPIRED'
  | 'SESSION_REVOKED'
  | 'INVALID_CREDENTIALS'
  | 'ACTION_FORBIDDEN'
  | 'CSRF_VALIDATION_FAILED'
  | 'LOGIN_RATE_LIMITED'
  | 'RATE_LIMITED'
  | 'RESOURCE_EDIT_LOCKED'
  | 'EDIT_LEASE_NOT_HELD'
  | 'IDEMPOTENCY_REQUEST_IN_PROGRESS'
  | 'RESOURCE_NOT_FOUND'
  | 'PLAN_CONCURRENT_MODIFICATION'
  | 'INTERNAL_ERROR'
  | 'SERVICE_UNAVAILABLE'
  | 'ACTIVATION_TOKEN_INVALID_OR_EXPIRED'
  | 'PASSWORD_POLICY_VIOLATION'
  // SP-07 employee administration (all already in the approved backend catalogue).
  | 'EMPTY_PATCH'
  | 'EMPLOYMENT_DATE_CONFLICT'
  | 'EMPLOYEE_CODE_ALREADY_EXISTS'
  | 'EMAIL_ALREADY_IN_USE'
  | 'EMPLOYEE_INACTIVE'
  | 'EMPLOYEE_HAS_FUTURE_ASSIGNMENTS'
  | 'EMPLOYMENT_PERIOD_EXCLUDES_FUTURE_PROJECT_ASSIGNMENTS'
  // SP-08 projects (approved backend catalogue).
  | 'PROJECT_NAME_ALREADY_EXISTS'
  | 'PROJECT_INACTIVE'
  // SP-09 month assignments (approved backend catalogue).
  | 'INVALID_MONTH_START'
  | 'EMPLOYEE_NOT_EMPLOYED_FOR_MONTH'
  | 'PROJECT_ASSIGNMENT_ALREADY_EXISTS'
  | 'PROJECT_ASSIGNMENT_CONFLICT'
  | 'PROJECT_ASSIGNMENT_CORRECTION_CONFLICT'
  // SP-08b shift configuration (approved backend catalogue). SHIFT_CONFIGURATION_MISSING
  // is reserved for duty creation (SP-11) and deliberately NOT known here.
  | 'SHIFT_CONFIGURATION_INVALID'
  | 'SHIFT_CONFIGURATION_CONFLICT'
  | 'AVAILABILITY_RANGE_INVALID'
  | 'EMPLOYEE_NOT_EMPLOYED_FOR_DAY'
  | 'AVAILABILITY_STATUS_CONFLICT'
  | 'AVAILABILITY_PREVIEW_STALE'
  | 'INVALID_FIELD_COMBINATION'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'IDEMPOTENCY_KEY_INVALID'
  | 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST';

export type ApiErrorKind = 'http' | 'network' | 'invalid-response';

/** Field-level validation subcodes the backend may send in `errors[]`. */
export const FIELD_ERROR_CODES = [
  'REQUIRED',
  'INVALID_TYPE',
  'INVALID_FORMAT',
  'INVALID_UUID',
  'INVALID_ENUM',
  'TOO_SHORT',
  'TOO_LONG',
  'OUT_OF_RANGE',
  'DUPLICATE_ITEM',
] as const;
export type FieldErrorCode = (typeof FIELD_ERROR_CODES)[number];
export type FieldError = Readonly<{ pointer: string; code: FieldErrorCode }>;

const codeStatuses: Record<KnownErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNKNOWN_FIELD: 400,
  INVALID_REQUEST_BODY: 400,
  SESSION_REQUIRED: 401,
  SESSION_EXPIRED: 401,
  SESSION_REVOKED: 401,
  INVALID_CREDENTIALS: 401,
  ACTION_FORBIDDEN: 403,
  CSRF_VALIDATION_FAILED: 403,
  LOGIN_RATE_LIMITED: 429,
  RATE_LIMITED: 429,
  RESOURCE_EDIT_LOCKED: 409,
  EDIT_LEASE_NOT_HELD: 409,
  IDEMPOTENCY_REQUEST_IN_PROGRESS: 409,
  RESOURCE_NOT_FOUND: 404,
  PLAN_CONCURRENT_MODIFICATION: 409,
  INTERNAL_ERROR: 500,
  // Operational 503 extension is NOT in the approved 8.5 catalogue; decision pending.
  SERVICE_UNAVAILABLE: 503,
  ACTIVATION_TOKEN_INVALID_OR_EXPIRED: 400,
  PASSWORD_POLICY_VIOLATION: 400,
  EMPTY_PATCH: 400,
  EMPLOYMENT_DATE_CONFLICT: 400,
  EMPLOYEE_CODE_ALREADY_EXISTS: 409,
  EMAIL_ALREADY_IN_USE: 409,
  EMPLOYEE_INACTIVE: 409,
  EMPLOYEE_HAS_FUTURE_ASSIGNMENTS: 409,
  EMPLOYMENT_PERIOD_EXCLUDES_FUTURE_PROJECT_ASSIGNMENTS: 409,
  PROJECT_NAME_ALREADY_EXISTS: 409,
  PROJECT_INACTIVE: 409,
  INVALID_MONTH_START: 400,
  EMPLOYEE_NOT_EMPLOYED_FOR_MONTH: 409,
  PROJECT_ASSIGNMENT_ALREADY_EXISTS: 409,
  PROJECT_ASSIGNMENT_CONFLICT: 409,
  PROJECT_ASSIGNMENT_CORRECTION_CONFLICT: 409,
  SHIFT_CONFIGURATION_INVALID: 400,
  SHIFT_CONFIGURATION_CONFLICT: 409,
  AVAILABILITY_RANGE_INVALID: 400,
  EMPLOYEE_NOT_EMPLOYED_FOR_DAY: 409,
  AVAILABILITY_STATUS_CONFLICT: 409,
  AVAILABILITY_PREVIEW_STALE: 409,
  INVALID_FIELD_COMBINATION: 400,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  IDEMPOTENCY_KEY_INVALID: 400,
  IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST: 409,
};

const POINTER_PATTERN = /^#(?:\/(?:[A-Za-z0-9_-]|~[01])+)+$/;

/** Keeps only well-formed pointer/subcode pairs; server `detail` text is never used. */
function safeFieldErrors(value: unknown): FieldError[] {
  if (!Array.isArray(value)) return [];
  const result: FieldError[] = [];
  for (const item of value.slice(0, 25)) {
    if (!isRecord(item)) continue;
    const { pointer, code } = item;
    if (
      typeof pointer === 'string' &&
      pointer.length <= 192 &&
      POINTER_PATTERN.test(pointer) &&
      typeof code === 'string' &&
      (FIELD_ERROR_CODES as readonly string[]).includes(code)
    ) {
      result.push({ pointer, code: code as FieldErrorCode });
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function knownCode(value: unknown, status: number): KnownErrorCode | null {
  if (typeof value !== 'string') return null;
  if (!Object.prototype.hasOwnProperty.call(codeStatuses, value)) return null;
  const code = value as KnownErrorCode;
  return codeStatuses[code] === status ? code : null;
}

export function safeCorrelationId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  // Only retain display-safe reference identifiers, never arbitrary header/body text.
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(trimmed) ? trimmed : null;
}

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  readonly code: KnownErrorCode | null;
  readonly correlationId: string | null;
  /** Only for 400 VALIDATION_FAILED: which fields failed, as safe subcodes. */
  readonly fieldErrors: readonly FieldError[];
  readonly employmentPeriodConflict: EmploymentPeriodConflict | undefined;

  constructor(
    kind: ApiErrorKind,
    status: number | null,
    code: KnownErrorCode | null,
    correlationId: string | null,
    fieldErrors: readonly FieldError[] = [],
    employmentPeriodConflict?: EmploymentPeriodConflict,
  ) {
    super('API request failed');
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.correlationId = correlationId;
    this.fieldErrors = fieldErrors;
    this.employmentPeriodConflict = employmentPeriodConflict;
  }
}

/** Converts an HTTP error response to a safe, typed error. */
export async function parseApiError(response: Response): Promise<ApiError> {
  let body: unknown = null;
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';

  if (contentType.includes('application/problem+json')) {
    try {
      body = await response.json();
    } catch {
      // Malformed/empty response: use HTTP status fallback, don't leak raw content.
    }
  }

  const details = isRecord(body) ? body : null;
  const code = knownCode(details?.code, response.status);
  const correlationId =
    safeCorrelationId(response.headers.get('x-correlation-id')) ??
    safeCorrelationId(details?.correlationId);

  const fieldErrors = code === 'VALIDATION_FAILED' ? safeFieldErrors(details?.errors) : [];
  const conflict = code === 'EMPLOYMENT_PERIOD_EXCLUDES_FUTURE_PROJECT_ASSIGNMENTS'
    ? safeEmploymentPeriodConflict(details) : undefined;
  return new ApiError('http', response.status, code, correlationId, fieldErrors, conflict);
}

export type EmploymentPeriodConflict = Readonly<{
  conflictCount: number;
  conflictingAssignments: readonly Readonly<{ assignmentId: string; monthStart: string }>[];
}>;

/** An optional hint only. Reject malformed summaries as a unit; ignore additive fields. */
function safeEmploymentPeriodConflict(value: unknown): EmploymentPeriodConflict | undefined {
  if (!isRecord(value)) return undefined;
  const { conflictCount, conflictingAssignments } = value;
  if (typeof conflictCount !== 'number' || !Number.isSafeInteger(conflictCount) || conflictCount < 1
    || !Array.isArray(conflictingAssignments) || conflictingAssignments.length !== Math.min(conflictCount, 25)) return undefined;
  const refs: { assignmentId: string; monthStart: string }[] = [];
  const ids = new Set<string>();
  let previous = '';
  for (const item of conflictingAssignments) {
    if (!isRecord(item) || typeof item.assignmentId !== 'string' || typeof item.monthStart !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item.assignmentId)
      || !/^(?!0000)\d{4}-(?:0[1-9]|1[0-2])-01$/.test(item.monthStart)) return undefined;
    const key = `${item.monthStart}/${item.assignmentId}`;
    if (key <= previous || ids.has(item.assignmentId)) return undefined;
    previous = key;
    ids.add(item.assignmentId);
    refs.push({ assignmentId: item.assignmentId, monthStart: item.monthStart });
  }
  return { conflictCount, conflictingAssignments: refs };
}

export interface UserFacingError {
  title: string;
  description: string;
  correlationId: string | null;
  canRetry: boolean;
}

/**
 * SP-07 texts. EMAIL_ALREADY_IN_USE is deliberately neutral: e-mail addresses
 * are unique across ALL companies, so the UI must not say where an address is
 * already registered.
 */
const EMPLOYEE_ERROR_TEXT: Partial<Record<string, { title: string; description: string }>> = {
  AVAILABILITY_RANGE_INVALID: {
    title: 'Zeitraum prüfen', description: 'Wählen Sie einen zusammenhängenden Zeitraum von höchstens 93 Kalendertagen einschließlich Anfang und Ende.',
  },
  EMPLOYEE_NOT_EMPLOYED_FOR_DAY: {
    title: 'Beschäftigungsnachweis fehlt', description: 'Der gesamte Zeitraum muss innerhalb der dokumentierten Beschäftigung liegen. Ein Beschäftigungsbeginn ist erforderlich.',
  },
  AVAILABILITY_STATUS_CONFLICT: {
    title: 'Abweichende Einträge vorhanden', description: 'Erstellen Sie eine neue Vorschau zum Ersetzen und bestätigen Sie diese ausdrücklich.',
  },
  AVAILABILITY_PREVIEW_STALE: {
    title: 'Vorschau nicht mehr gültig', description: 'Der Stand oder die Voraussetzungen haben sich geändert. Prüfen Sie eine neue Vorschau und bestätigen Sie diese erneut.',
  },
  IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST: {
    title: 'Vorgang stimmt nicht überein', description: 'Dieser Vorgang kann nicht mit geänderten Eingaben wiederholt werden. Laden und prüfen Sie den aktuellen Stand.',
  },
  EMPLOYMENT_PERIOD_EXCLUDES_FUTURE_PROJECT_ASSIGNMENTS: {
    title: 'Beschäftigungszeitraum steht im Konflikt mit Projektzuordnungen',
    description: 'Der geänderte Zeitraum würde bisher abgedeckte zukünftige Projektzuordnungen ausschließen. Prüfen Sie die betroffenen Zuordnungen und korrigieren oder entfernen Sie diese bei Bedarf einzeln. Speichern Sie Ihre Änderungen anschließend erneut.',
  },
  EMPLOYEE_CODE_ALREADY_EXISTS: {
    title: 'Mitarbeiter-ID bereits vergeben',
    description: 'Diese Mitarbeiter-ID wird in Ihrem Unternehmen bereits verwendet. Bitte wählen Sie eine andere.',
  },
  EMAIL_ALREADY_IN_USE: {
    title: 'E-Mail-Adresse nicht verwendbar',
    description: 'Mit dieser E-Mail-Adresse kann kein neues Konto angelegt werden. Bitte verwenden Sie eine andere Adresse.',
  },
  EMPLOYEE_INACTIVE: {
    title: 'Bereits deaktiviert',
    description: 'Diese Person ist bereits deaktiviert. Bitte laden Sie die Ansicht neu.',
  },
  EMPLOYEE_HAS_FUTURE_ASSIGNMENTS: {
    title: 'Deaktivierung nicht möglich',
    description: 'Für diese Person bestehen noch zukünftige Einsätze. Bitte klären Sie diese zuerst.',
  },
  EMPTY_PATCH: {
    title: 'Keine Änderungen',
    description: 'Es wurden keine Änderungen übermittelt.',
  },
  EMPLOYMENT_DATE_CONFLICT: {
    title: 'Beschäftigungszeitraum prüfen',
    description: 'Das Beschäftigungsende darf nicht vor dem Beschäftigungsbeginn liegen.',
  },

  // SP-08 projects.
  PROJECT_NAME_ALREADY_EXISTS: {
    title: 'Projektname bereits vergeben',
    description: 'Dieser Projektname wird in Ihrem Unternehmen bereits verwendet. Bitte wählen Sie einen anderen Namen.',
  },
  PROJECT_INACTIVE: {
    title: 'Projekt ist inaktiv',
    description: 'Für ein inaktives Projekt sind keine neuen Zuordnungen und keine Änderungen der Schichtzeiten möglich. Reaktivieren Sie das Projekt zuerst oder laden Sie die Ansicht neu.',
  },
  // SP-09 month assignments.
  PROJECT_ASSIGNMENT_CONFLICT: {
    title: 'Bereits einem anderen Projekt zugeordnet',
    description: 'Diese Person ist im gewählten Monat bereits einem anderen Projekt zugeordnet. Je Kalendermonat ist nur ein Projekt möglich; die Zuordnung wurde nicht geändert.',
  },
  EMPLOYEE_NOT_EMPLOYED_FOR_MONTH: {
    title: 'Nicht beschäftigt in diesem Monat',
    description: 'Der dokumentierte Beschäftigungszeitraum dieser Person deckt den gewählten Monat nicht ab oder es ist kein Beschäftigungsbeginn hinterlegt. Bitte Beschäftigungsdaten prüfen oder einen anderen Monat wählen.',
  },
  PROJECT_ASSIGNMENT_ALREADY_EXISTS: {
    title: 'Zuordnung besteht bereits',
    description: 'Diese Person ist dem Projekt für diesen Monat bereits zugeordnet.',
  },
  INVALID_MONTH_START: {
    title: 'Monat ungültig',
    description: 'Bitte wählen Sie einen gültigen Kalendermonat.',
  },
  // Covers both server reasons without revealing plan details (missing employment evidence, planning data).
  PROJECT_ASSIGNMENT_CORRECTION_CONFLICT: {
    title: 'Korrektur nicht möglich',
    description: 'Diese Korrektur ist derzeit nicht zulässig. Ein Personenwechsel im aktuellen oder einem vergangenen Monat setzt einen dokumentierten Beschäftigungszeitraum in diesem Monat voraus; außerdem können bestehende Planungsdaten eine Korrektur verhindern. Die Zuordnung wurde nicht geändert.',
  },
  // SP-08b shift configuration.
  SHIFT_CONFIGURATION_INVALID: {
    title: 'Schichtzeiten nicht zulässig',
    description: 'Beginn und Ende müssen sich unterscheiden, und eine Tagschicht endet am selben Tag. Schichtzeiten vergangener Monate können nicht geändert werden. Es wurde nichts gespeichert.',
  },
  SHIFT_CONFIGURATION_CONFLICT: {
    title: 'Schichtzeiten derzeit nicht änderbar',
    description: 'Die Schichtzeiten können im Moment nicht geändert werden, weil die Änderung bestehende Planungen betreffen könnte. Es wurde nichts gespeichert.',
  },
};

/** German, user-facing text based on status + approved codes, not raw server strings. */
export function describeApiError(error: unknown): UserFacingError {
  const correlationId = error instanceof ApiError ? error.correlationId : null;

  if (!(error instanceof ApiError)) {
    return {
      title: 'Ein Fehler ist aufgetreten',
      description: 'Die Aktion konnte nicht abgeschlossen werden.',
      correlationId: null,
      canRetry: false,
    };
  }

  if (error.kind === 'network') {
    return {
      title: 'Verbindung fehlgeschlagen',
      description: 'Bitte prüfen Sie Ihre Internetverbindung und versuchen Sie es erneut.',
      correlationId,
      canRetry: true,
    };
  }

  if (error.kind === 'invalid-response') {
    return {
      title: 'Antwort konnte nicht verarbeitet werden',
      description: 'Bitte versuchen Sie es später erneut.',
      correlationId,
      canRetry: true,
    };
  }

  if (error.code === 'PLAN_CONCURRENT_MODIFICATION') {
    return {
      title: 'Plan wurde inzwischen geändert',
      description: 'Laden Sie den Plan neu und prüfen Sie Ihre Änderungen, bevor Sie erneut speichern.',
      correlationId,
      canRetry: false,
    };
  }
  if (error.code === 'ACTIVATION_TOKEN_INVALID_OR_EXPIRED') {
    return {
      title: 'Aktivierungslink ungültig',
      description:
        'Dieser Aktivierungslink ist ungültig oder abgelaufen. Bitte wenden Sie sich an Ihre Administration.',
      correlationId,
      canRetry: false,
    };
  }

  if (error.code === 'PASSWORD_POLICY_VIOLATION') {
    return {
      title: 'Passwort nicht zulässig',
      description:
        'Bitte wählen Sie ein anderes, sicheres Passwort.',
      correlationId,
      canRetry: false,
    };
  }
  const employeeError = EMPLOYEE_ERROR_TEXT[error.code ?? ''];
  if (employeeError) return { ...employeeError, correlationId, canRetry: false };
  switch (error.status) {
    case 400:
      return {
        title: 'Eingaben überprüfen',
        description: 'Bitte prüfen Sie Ihre Angaben und versuchen Sie es erneut.',
        correlationId,
        canRetry: false,
      };
    case 401:
      return {
        title: 'Anmeldung erforderlich',
        description: 'Bitte melden Sie sich an, um fortzufahren.',
        correlationId,
        canRetry: false,
      };
    case 403:
      return {
        title: 'Kein Zugriff',
        description: 'Sie sind für diese Aktion nicht berechtigt.',
        correlationId,
        canRetry: false,
      };
    case 404:
      return {
        title: 'Nicht gefunden',
        description: 'Die angeforderte Information ist nicht verfügbar.',
        correlationId,
        canRetry: false,
      };
    case 409:
      return {
        title: 'Konflikt',
        description: 'Die Aktion steht im Konflikt mit dem aktuellen Stand. Bitte aktualisieren Sie die Ansicht.',
        correlationId,
        canRetry: false,
      };
    case 429:
      return {
        title: 'Zu viele Anfragen',
        description: 'Bitte warten Sie kurz, bevor Sie es erneut versuchen.',
        correlationId,
        canRetry: true,
      };
    case 503:
      return {
        title: 'Dienst vorübergehend nicht verfügbar',
        description: 'Bitte versuchen Sie es später erneut.',
        correlationId,
        canRetry: true,
      };
    default:
      return {
        title: 'Ein Fehler ist aufgetreten',
        description: 'Die Aktion konnte nicht abgeschlossen werden. Bitte versuchen Sie es später erneut.',
        correlationId,
        canRetry: error.status !== null && error.status >= 500,
      };
  }
}
