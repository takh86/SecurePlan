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
import type { CorrelatedRequest } from '../middleware/correlation-id.middleware.js';

/**
 * Temporary, explicitly scoped mapping for SP-02.
 * Extend only after verifying new codes against the canonical section 8.5 catalogue.
 */
function resolveErrorCode(
  status: number,
  explicitCode?: string,
): string | undefined {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return explicitCode === 'VALIDATION_FAILED' ? explicitCode : undefined;
    case HttpStatus.NOT_FOUND:
      return 'RESOURCE_NOT_FOUND';
    case HttpStatus.CONFLICT:
      return explicitCode === 'PLAN_CONCURRENT_MODIFICATION'
        ? explicitCode
        : undefined;
    case HttpStatus.INTERNAL_SERVER_ERROR:
      return 'INTERNAL_ERROR';
    case HttpStatus.SERVICE_UNAVAILABLE:
      // Present in the current health endpoint; verify against catalogue 8.5.
      return explicitCode === 'SERVICE_UNAVAILABLE' ? explicitCode : undefined;
    default:
      // Don't make up canonical error codes for future endpoints.
      return undefined;
  }
}

function resolveTitle(status: number): string {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return 'Bad Request';
    case HttpStatus.UNAUTHORIZED:
      return 'Unauthorized';
    case HttpStatus.FORBIDDEN:
      return 'Forbidden';
    case HttpStatus.NOT_FOUND:
      return 'Not Found';
    case HttpStatus.CONFLICT:
      return 'Conflict';
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'Too Many Requests';
    case HttpStatus.INTERNAL_SERVER_ERROR:
      return 'Internal Server Error';
    case HttpStatus.SERVICE_UNAVAILABLE:
      return 'Service Unavailable';
    default:
      return 'HTTP Error';
  }
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<CorrelatedRequest>();
    const response = http.getResponse<Response>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const exceptionResponse =
      exception instanceof HttpException ? exception.getResponse() : null;

    let explicitCode: string | undefined;
    if (
      exceptionResponse !== null &&
      typeof exceptionResponse === 'object' &&
      'code' in exceptionResponse &&
      typeof exceptionResponse.code === 'string'
    ) {
      explicitCode = exceptionResponse.code;
    }

    const code = resolveErrorCode(status, explicitCode);
    const correlationId = request.correlationId ?? randomUUID();

    // Normally set by the middleware. Maintain parity for a fallback path, too.
    response.setHeader('X-Correlation-ID', correlationId);

    const problemDetails = {
      type: 'about:blank',
      title: resolveTitle(status),
      status,
      detail:
        status >= 500
          ? 'An internal server error occurred'
          : 'The request could not be processed',
      instance: request.path,
      code,
      correlationId,
    };

    if (status >= 500) {
      this.logger.error(
        JSON.stringify({
          event: 'http.request.failed',
          correlationId,
          method: request.method,
          status,
          code,
        }),
      );
    }

    response
      .status(status)
      .type('application/problem+json')
      .json(problemDetails);
  }
}
