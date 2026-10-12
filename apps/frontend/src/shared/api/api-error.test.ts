import { describe, expect, it } from 'vitest';
import { ApiError, describeApiError, parseApiError } from './api-error';

function problemResponse(
  status: number,
  body: unknown,
  correlationId?: string,
): Response {
  const headers: Record<string, string> = {
    'content-type': 'application/problem+json',
  };
  if (correlationId) headers['x-correlation-id'] = correlationId;
  return new Response(JSON.stringify(body), { status, headers });
}

describe('RFC 9457 problem-details mapping', () => {
  it('maps known 400 validation error', async () => {
    const error = await parseApiError(problemResponse(400, { code: 'VALIDATION_FAILED' }));
    expect(error).toMatchObject({ kind: 'http', status: 400, code: 'VALIDATION_FAILED' });
    expect(describeApiError(error).title).toBe('Eingaben überprüfen');
  });

  it('maps 404 resource not found', async () => {
    const error = await parseApiError(problemResponse(404, { code: 'RESOURCE_NOT_FOUND' }));
    expect(error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('maps concurrent modification and gives the user a helpful action', async () => {
    const error = await parseApiError(
      problemResponse(409, { code: 'PLAN_CONCURRENT_MODIFICATION' }),
    );
    expect(error.code).toBe('PLAN_CONCURRENT_MODIFICATION');
    expect(describeApiError(error).description).toContain('Laden Sie den Plan neu');
  });

  it('has a safe fallback for a generic 409', async () => {
    const error = await parseApiError(problemResponse(409, { title: 'Conflict' }));
    expect(error.code).toBeNull();
    expect(describeApiError(error).title).toBe('Konflikt');
  });

  it('never displays a secret in server detail or message for 500', async () => {
    const error = await parseApiError(
      problemResponse(500, {
        code: 'INTERNAL_ERROR',
        detail: 'DB password=secret-123',
        message: 'DB password=secret-123',
      }),
    );
    expect(error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(describeApiError(error))).not.toContain('secret-123');
    expect(error.message).not.toContain('secret-123');
  });

  it('maps the current 503 backend code safely', async () => {
    const error = await parseApiError(
      problemResponse(503, { code: 'SERVICE_UNAVAILABLE' }),
    );
    expect(error.code).toBe('SERVICE_UNAVAILABLE');
    expect(describeApiError(error).canRetry).toBe(true);
  });

  it('ignores unknown or status-incompatible codes', async () => {
    const unknown = await parseApiError(problemResponse(409, { code: 'SOME_UNKNOWN_CODE' }));
    const incorrect = await parseApiError(problemResponse(409, { code: 'INTERNAL_ERROR' }));
    expect(unknown.code).toBeNull();
    expect(incorrect.code).toBeNull();
  });

  it('prefers the HTTP header correlation ID over body data', async () => {
    const error = await parseApiError(
      problemResponse(500, { correlationId: 'body-id-123' }, 'header-id-456'),
    );
    expect(error.correlationId).toBe('header-id-456');
  });

  it('falls back to the body correlation ID when header is missing', async () => {
    const error = await parseApiError(problemResponse(404, { correlationId: 'body-id-123' }));
    expect(error.correlationId).toBe('body-id-123');
  });

  it('ignores malformed or non-problem-details bodies', async () => {
    const badJson = new Response('{bad json', {
      status: 500,
      headers: { 'content-type': 'application/problem+json' },
    });
    const textBody = new Response('my-secret', {
      status: 500,
      headers: { 'content-type': 'text/plain' },
    });
    const first = await parseApiError(badJson);
    const second = await parseApiError(textBody);
    expect(first.code).toBeNull();
    expect(second.code).toBeNull();
    expect(JSON.stringify(describeApiError(second))).not.toContain('my-secret');
  });

  it('gives user-facing fallback messages for 401, 403 and 429', () => {
    expect(describeApiError(new ApiError('http', 401, null, null)).title).toBe('Anmeldung erforderlich');
    expect(describeApiError(new ApiError('http', 403, null, null)).title).toBe('Kein Zugriff');
    expect(describeApiError(new ApiError('http', 429, null, null)).title).toBe('Zu viele Anfragen');
  });

  it('does not render arbitrary exception messages', () => {
    expect(JSON.stringify(describeApiError(new Error('token=secret-123')))).not.toContain('secret-123');
  });
});
