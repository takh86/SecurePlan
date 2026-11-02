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
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** #73: optimistic-concurrency token, sent as the `Expected-Version` header. */
  expectedVersion?: number;
  /** SP-10: one logical commit attempt, including explicit lost-response retries. */
  idempotencyKey?: string;
  /**
   * SP-12 (ADR-0006): duty edit-lease token, sent only as the `Edit-Lease-Token`
   * header. Held in memory by the caller; never put in a URL, a body or storage.
   */
  editLeaseToken?: string;
  /** Lets a lease release outlive the page (pagehide); no other effect. */
  keepalive?: boolean;
};

export interface SessionApi {
  request<T>(path: string, options?: SessionRequest): Promise<T>;
}

// The token may only ever travel to this same-origin API prefix.
const API_PREFIX = '/api/v1/';
// ADR-0006 lease token: 32 random bytes, canonical base64url (43 characters).
const EDIT_LEASE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function createSessionApi(
  csrfToken: string,
  onUnauthorized: (error: ApiError) => void,
): SessionApi {
  return {
    async request<T>(
      path: string,
      { method = 'GET', body, signal, expectedVersion, idempotencyKey, editLeaseToken, keepalive }: SessionRequest = {},
    ): Promise<T> {
      if (!path.startsWith(API_PREFIX) || path.includes('//')) {
        throw new Error('Session requests are limited to the SecurePlan API');
      }
      if (expectedVersion !== undefined && !(Number.isSafeInteger(expectedVersion) && expectedVersion > 0)) {
        throw new Error('Expected-Version must be a positive safe integer');
      }
      // Checked before sending; the value itself is never part of an error message.
      if (editLeaseToken !== undefined && !EDIT_LEASE_TOKEN.test(editLeaseToken)) {
        throw new Error('Edit-Lease-Token has an invalid format');
      }
      const unsafe = method !== 'GET';
      // DELETE (#73) and the SP-12 lease renewal (PUT) have no request body; POST and PATCH send JSON.
      const sendsBody = unsafe && method !== 'DELETE' && method !== 'PUT';
      const headers: Record<string, string> = {};
      if (sendsBody) headers['Content-Type'] = 'application/json';
      if (unsafe) headers['X-CSRF-Token'] = csrfToken;
      if (expectedVersion !== undefined) headers['Expected-Version'] = String(expectedVersion);
      if (idempotencyKey !== undefined) headers['Idempotency-Key'] = idempotencyKey;
      if (editLeaseToken !== undefined) headers['Edit-Lease-Token'] = editLeaseToken;
      try {
        return await requestJson<T>(path, {
          method,
          credentials: 'same-origin',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          signal,
          headers: Object.keys(headers).length > 0 ? headers : undefined,
          body: sendsBody ? JSON.stringify(body ?? {}) : undefined,
          ...(keepalive ? { keepalive: true } : {}),
        });
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) onUnauthorized(error);
        throw error;
      }
    },
  };
}
