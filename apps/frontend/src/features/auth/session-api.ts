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
  method?: 'GET' | 'POST' | 'PATCH';
  body?: unknown;
  signal?: AbortSignal;
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
    async request<T>(path: string, { method = 'GET', body, signal }: SessionRequest = {}): Promise<T> {
      if (!path.startsWith(API_PREFIX) || path.includes('//')) {
        throw new Error('Session requests are limited to the SecurePlan API');
      }
      const unsafe = method !== 'GET';
      try {
        return await requestJson<T>(path, {
          method,
          credentials: 'same-origin',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          signal,
          headers: unsafe ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken } : undefined,
          body: unsafe ? JSON.stringify(body ?? {}) : undefined,
        });
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) onUnauthorized(error);
        throw error;
      }
    },
  };
}
