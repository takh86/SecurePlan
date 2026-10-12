import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

export type CorrelatedRequest = Request & {
  correlationId?: string;
};

export function correlationIdMiddleware(
  req: CorrelatedRequest,
  res: Response,
  next: NextFunction,
): void {

const correlationId = randomUUID();
req.correlationId = correlationId;
res.setHeader('X-Correlation-ID', correlationId);
next();
}