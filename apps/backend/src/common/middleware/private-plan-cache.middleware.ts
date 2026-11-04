import type { Request, Response, NextFunction } from 'express';

/** Runs before guards/pipes, including their error paths and automatic HEAD. */
export function privatePlanCache(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  if (
    !/^\/api\/v1\/(?:me(?:\/(?:monthly-plans|planning-statistics|work-items))?\/?|cancellation-requests(?:\/.*)?)$/i.test(
      request.path,
    )
  ) {
    next();
    return;
  }
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('Pragma', 'no-cache');
  response.vary('Cookie');
  // Express computes freshness inside send(), before writing response headers.
  delete request.headers['if-none-match'];
  delete request.headers['if-modified-since'];
  const writeHead = response.writeHead.bind(response);
  response.writeHead = function (...args: Parameters<typeof writeHead>) {
    response.removeHeader('ETag');
    response.removeHeader('Last-Modified');
    return writeHead(...args);
  } as typeof response.writeHead;
  next();
}
