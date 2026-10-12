/**
 * SecurePlan API errors. Never display raw server `detail` or `message` fields.
 * The API status is authoritative; `code` is only trusted when known for that status.
 */
export type KnownErrorCode =
  | 'VALIDATION_FAILED'
  | 'RESOURCE_NOT_FOUND'
  | 'PLAN_CONCURRENT_MODIFICATION'
  | 'INTERNAL_ERROR'
  | 'SERVICE_UNAVAILABLE';

export type ApiErrorKind = 'http' | 'network' | 'invalid-response';

const codeStatuses: Record<KnownErrorCode, number> = {
  VALIDATION_FAILED: 400,
  RESOURCE_NOT_FOUND: 404,
  PLAN_CONCURRENT_MODIFICATION: 409,
  INTERNAL_ERROR: 500,
  // Provisional until the complete approved API error catalogue is checked.
  SERVICE_UNAVAILABLE: 503,
};

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

  constructor(
    kind: ApiErrorKind,
    status: number | null,
    code: KnownErrorCode | null,
    correlationId: string | null,
  ) {
    super('API request failed');

    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.correlationId = correlationId;
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

  return new ApiError('http', response.status, code, correlationId);
}

export interface UserFacingError {
  title: string;
  description: string;
  correlationId: string | null;
  canRetry: boolean;
}

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
