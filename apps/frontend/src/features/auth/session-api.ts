/**
 * SP-07 — authenticated API access for the protected UI.
 *
 * The CSRF token is captured in this closure only: screens receive a bound
 * `request` function, never the token itself, so it cannot reach React state,
 * the DOM, the URL or storage. Unsafe methods carry the token; the browser adds
 * the Origin header. A 401 means the server session is gone: the session
 * boundary is told (central sign-out) and the error is still rethrown.
 */
import { ApiError } from '../../shared/api/api-error';
import { requestJson } from '../../shared/api/http-client';

export type SessionRequest = {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** #73: optimistic-concurrency token, sent as the `Expected-Version` header. */
  expectedVersion?: number;
  /** SP-10: one logical commit attempt, including explicit lost-response retries. */
  idempotencyKey?: string;
};

export interface SessionApi {
  request<T>(path: string, options?: SessionRequest): Promise<T>;
}

// The token may only ever travel to this same-origin API prefix.
const API_PREFIX = '/api/v1/';

export function createSessionApi(
  csrfToken: string,
  onUnauthorized: (error: ApiError) => void,
): SessionApi {
  return {
    async request<T>(path: string, { method = 'GET', body, signal, expectedVersion, idempotencyKey }: SessionRequest = {}): Promise<T> {
      if (!path.startsWith(API_PREFIX) || path.includes('//')) {
        throw new Error('Session requests are limited to the SecurePlan API');
      }
      if (expectedVersion !== undefined && !(Number.isSafeInteger(expectedVersion) && expectedVersion > 0)) {
        throw new Error('Expected-Version must be a positive safe integer');
      }
      const unsafe = method !== 'GET';
      // DELETE has no request body (#73); POST and PATCH send JSON.
      const sendsBody = unsafe && method !== 'DELETE';
      const headers: Record<string, string> = {};
      if (sendsBody) headers['Content-Type'] = 'application/json';
      if (unsafe) headers['X-CSRF-Token'] = csrfToken;
      if (expectedVersion !== undefined) headers['Expected-Version'] = String(expectedVersion);
      if (idempotencyKey !== undefined) headers['Idempotency-Key'] = idempotencyKey;
      try {
        return await requestJson<T>(path, {
          method,
          credentials: 'same-origin',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          signal,
          headers: Object.keys(headers).length > 0 ? headers : undefined,
          body: sendsBody ? JSON.stringify(body ?? {}) : undefined,
        });
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) onUnauthorized(error);
        throw error;
      }
    },
  };
}
