import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { CorrelatedRequest } from '../middleware/correlation-id.middleware.js';

/**
 * Server-generated request correlation ID (never client-supplied), e.g. for
 * audit rows. Missing means configureApp() was bypassed: fail closed (500).
 */
export const CorrelationId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const correlationId = context.switchToHttp().getRequest<CorrelatedRequest>().correlationId;
    if (!correlationId) throw new Error('Correlation ID middleware did not run');
    return correlationId;
  },
);
