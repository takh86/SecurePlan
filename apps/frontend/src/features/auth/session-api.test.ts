import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../shared/api/api-error';
import { createSessionApi } from './session-api';

const CSRF = 'c'.repeat(43);

afterEach(() => vi.unstubAllGlobals());

function stubFetch(response: () => Response) {
  const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) => response());
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });

describe('SP-07 — session-bound API (CSRF token stays in the closure)', () => {
  it('reads without the CSRF token, same-origin and uncached', async () => {
    const fetchMock = stubFetch(ok);
    const api = createSessionApi(CSRF, vi.fn());
    await expect(api.request('/api/v1/employees')).resolves.toEqual({ ok: true });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('same-origin');
    expect(init.cache).toBe('no-store');
    expect(init.referrerPolicy).toBe('no-referrer');
    expect(new Headers(init.headers).get('x-csrf-token')).toBeNull();
    expect(init.body).toBeUndefined();
  });

  it.each(['POST', 'PATCH'] as const)('%s carries the CSRF token and a JSON body', async (method) => {
    const fetchMock = stubFetch(ok);
    await createSessionApi(CSRF, vi.fn()).request('/api/v1/employees', { method, body: { a: 1 } });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('x-csrf-token')).toBe(CSRF);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('expected-version')).toBeNull();
    expect(init.body).toBe('{"a":1}');
  });

  it('#73 DELETE carries the CSRF token and Expected-Version, but no body and no Content-Type', async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 204 }));
    await expect(createSessionApi(CSRF, vi.fn())
      .request('/api/v1/project-assignments/a-1', { method: 'DELETE', expectedVersion: 1793260800123456, body: { ignored: true } }))
      .resolves.toBeUndefined();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(init.method).toBe('DELETE');
    expect(headers.get('x-csrf-token')).toBe(CSRF);
    expect(headers.get('expected-version')).toBe('1793260800123456');
    expect(headers.get('content-type')).toBeNull();
    expect(init.body).toBeUndefined();
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])('#73 refuses Expected-Version %s before sending anything', async (version) => {
    const fetchMock = stubFetch(ok);
    await expect(createSessionApi(CSRF, vi.fn()).request('/api/v1/project-assignments/a-1', { method: 'DELETE', expectedVersion: version }))
      .rejects.toThrow('positive safe integer');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a 401 to the session boundary and still rejects', async () => {
    stubFetch(() => new Response(JSON.stringify({ code: 'SESSION_REVOKED' }), {
      status: 401,
      headers: { 'content-type': 'application/problem+json' },
    }));
    const onUnauthorized = vi.fn();
    const request = createSessionApi(CSRF, onUnauthorized).request('/api/v1/employees');
    await expect(request).rejects.toMatchObject({ status: 401, code: 'SESSION_REVOKED' });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(onUnauthorized.mock.calls[0][0]).toBeInstanceOf(ApiError);
  });

  it('does not sign out on 403 or 404', async () => {
    for (const [status, code] of [[403, 'ACTION_FORBIDDEN'], [404, 'RESOURCE_NOT_FOUND']] as const) {
      stubFetch(() => new Response(JSON.stringify({ code }), { status, headers: { 'content-type': 'application/problem+json' } }));
      const onUnauthorized = vi.fn();
      await expect(createSessionApi(CSRF, onUnauthorized).request('/api/v1/employees/x')).rejects.toMatchObject({ status });
      expect(onUnauthorized).not.toHaveBeenCalled();
    }
  });

  it('never sends the token outside the same-origin SecurePlan API', async () => {
    const fetchMock = stubFetch(ok);
    const api = createSessionApi(CSRF, vi.fn());
    for (const path of ['https://attacker.example/api/v1/x', '//attacker.example/api/v1/x', '/other/path', '/api/v1//x']) {
      await expect(api.request(path, { method: 'POST' })).rejects.toThrow('limited to the SecurePlan API');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
