import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import {
  isApprovedErrorCode,
  isSafeValidationSuberror,
  problemType,
  validationSubcodeDetails,
} from '../errors/error-contract.js';
import type { CorrelatedRequest } from '../middleware/correlation-id.middleware.js';
import { EMPLOYMENT_PERIOD_CONFLICT, safeEmploymentPeriodConflict } from '../errors/employment-period-conflict.js';

type ErrorResolution = { status: number; code: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Only documented parser type/status pairs; never trust an arbitrary status. */
function resolveParserError(exception: unknown): ErrorResolution | undefined {
  if (!(exception instanceof Error) || !isRecord(exception)) return undefined;
  if (exception.status !== exception.statusCode) return undefined;

  // Approved parser mappings; only known type/status pairs are accepted.
  if (exception.type === 'entity.too.large' && exception.status === 413) {
    return { status: 413, code: 'REQUEST_BODY_TOO_LARGE' };
  }
  if ((exception.type === 'charset.unsupported' || exception.type === 'encoding.unsupported')
    && exception.status === 415) {
    return { status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' };
  }
  if (exception.type === 'entity.parse.failed' && exception.status === 400) {
    return { status: 400, code: 'INVALID_REQUEST_BODY' };
  }
  return undefined;
}

/** Unclassified 409 is NOT silently claimed to be a known business conflict. */
function resolveError(exception: unknown): ErrorResolution {
  if (!(exception instanceof HttpException)) {
    return resolveParserError(exception) ?? { status: 500, code: 'INTERNAL_ERROR' };
  }

  const status = exception.getStatus();
  const payload = exception.getResponse();
  const explicit = isRecord(payload) && typeof payload.code === 'string' ? payload.code : null;

  if (status === 500) return { status: 500, code: 'INTERNAL_ERROR' };
  if (status === 404) return { status: 404, code: 'RESOURCE_NOT_FOUND' };

  // Provisional operational readiness exception. Not in the approved 8.5 code catalogue.
  if (status === 503 && explicit === 'SERVICE_UNAVAILABLE') {
    return { status: 503, code: 'SERVICE_UNAVAILABLE' };
  }

  if (explicit !== null) {
    return isApprovedErrorCode(explicit, status)
      ? { status, code: explicit }
      : { status: 500, code: 'INTERNAL_ERROR' };
  }

  // Framework-generated, code-less exceptions: use only unambiguous class fallbacks.
  switch (status) {
    case 400:
      return { status, code: 'INVALID_REQUEST_BODY' };
    case 401:
      return { status, code: 'SESSION_REQUIRED' };
    case 403:
      return { status, code: 'ACTION_FORBIDDEN' };
    case 429:
      return { status, code: 'RATE_LIMITED' };
    default:
      return { status: 500, code: 'INTERNAL_ERROR' };
  }
}

function safeTitle(status: number): string {
  switch (status) {
    case 400: return 'Bad Request';
    case 401: return 'Unauthorized';
    case 403: return 'Forbidden';
    case 404: return 'Not Found';
    case 409: return 'Conflict';
    case 413: return 'Content Too Large';
    case 415: return 'Unsupported Media Type';
    case 429: return 'Too Many Requests';
    case 503: return 'Service Unavailable';
    default: return 'Internal Server Error';
  }
}

function safeDetail(status: number, code: string): string {
  if (status === 500) return 'An unexpected error occurred. Please try again later.';
  if (status === 503) return 'The service is temporarily unavailable. Please try again later.';
  if (status === 413) return 'The request body exceeds the permitted size.';
  if (status === 415) return 'The request media type, charset or content encoding is not supported.';
  if (code === 'VALIDATION_FAILED' || code === 'UNKNOWN_FIELD') return 'One or more fields are invalid.';
  if (status === 404) return 'The requested resource was not found.';
  if (code === 'PLAN_CONCURRENT_MODIFICATION') return 'The plan has changed. Reload the current state and try again.';
  if (code === EMPLOYMENT_PERIOD_CONFLICT) return 'The changed employment period would no longer cover existing future monthly project assignments. Review and correct or remove the conflicting assignments first.';
  if (status === 401) return 'Authentication is required or no longer valid.';
  if (status === 403) return 'You are not permitted to perform this action.';
  if (status === 429) return 'Too many requests. Please try again later.';
  return 'The request could not be processed.';
}

/** Never forward caller-provided validation descriptions or rejected values. */
function safeValidationErrors(exception: unknown, code: string): Array<{pointer: string; code: string; detail: string}> | undefined {
  if (code !== 'VALIDATION_FAILED' || !(exception instanceof HttpException)) return undefined;
  const payload = exception.getResponse();
  if (!isRecord(payload) || !Array.isArray(payload.errors)) return undefined;
  const entries = payload.errors
    .filter(isSafeValidationSuberror)
    .slice(0, 25)
    .map((item) => ({
      pointer: item.pointer,
      code: item.code,
      detail: validationSubcodeDetails[item.code],
    }));
  return entries.length > 0 ? entries : undefined;
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<CorrelatedRequest>();
    const response = http.getResponse<Response>();
    let { status, code } = resolveError(exception);
    const conflict = code === EMPLOYMENT_PERIOD_CONFLICT && exception instanceof HttpException
      ? safeEmploymentPeriodConflict(exception.getResponse()) : undefined;
    if (code === EMPLOYMENT_PERIOD_CONFLICT && conflict === undefined) {
      status = 500;
      code = 'INTERNAL_ERROR';
    }
    const correlationId = request.correlationId ?? randomUUID();
    const errors = safeValidationErrors(exception, code);

    // The middleware should already have set this on successful requests.
    response.setHeader('X-Correlation-ID', correlationId);
    if (conflict !== undefined) response.setHeader('Cache-Control', 'no-store');

    const problemDetails = {
      type: problemType(code),
      title: safeTitle(status),
      status,
      detail: safeDetail(status, code),
      instance: `/problems/occurrences/${correlationId}`,
      code,
      correlationId,
      ...(errors !== undefined ? { errors } : {}),
      ...(conflict !== undefined ? conflict : {}),
    };

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      // No raw exception message, stack, SQL or request body in shared logs.
      this.logger.error(JSON.stringify({
        event: 'http.request.failed',
        correlationId,
        method: request.method,
        route: request.route?.path ?? 'unmatched',
        status,
        code,
        exceptionType: exception instanceof Error ? exception.constructor.name : 'Unknown',
      }));
    }

    response.status(status).type('application/problem+json').json(problemDetails);
  }
}
