import { ApiError, parseApiError, safeCorrelationId } from './api-error';

/**
 * Shared JSON HTTP transport. Caller controls the URL, HTTP method and credentials.
 * No hard-coded API host, assumed auth mechanism or implicit unsafe retry.
 */
export async function requestJson<T>(
  input: string | URL,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has('Accept')) {
    headers.set('Accept', 'application/json, application/problem+json');
  }

  let response: Response;
  try {
    response = await fetch(input, { ...init, headers });
  } catch (error) {
    // An intentional cancellation isn't a network failure to display to users.
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new ApiError('network', null, null, null);
  }

  if (!response.ok) {
    throw await parseApiError(response);
  }

  // 204/205 explicitly have no JSON representation.
  if (response.status === 204 || response.status === 205) {
    return undefined as T;
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError(
      'invalid-response',
      response.status,
      null,
      safeCorrelationId(response.headers.get('x-correlation-id')),
    );
  }
}
