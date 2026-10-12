import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api-error';
import { requestJson } from './http-client';

afterEach(() => vi.unstubAllGlobals());

describe('shared JSON HTTP client', () => {
  it('returns valid JSON and sends an Accept header', async () => {
    const mockedFetch = vi.fn(async (_input: string | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', mockedFetch);

    const result = await requestJson<{ ok: boolean }>('/api/v1/example');
    expect(result).toEqual({ ok: true });
    const init = mockedFetch.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('accept')).toContain('application/problem+json');
  });

  it('returns undefined for 204 No Content', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(requestJson<void>('/api/v1/example')).resolves.toBeUndefined();
  });

  it('converts a 409 response into a typed error with correlation ID', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 'PLAN_CONCURRENT_MODIFICATION' }), {
        status: 409,
        headers: {
          'content-type': 'application/problem+json',
          'x-correlation-id': 'request-abc',
        },
      }),
    ));
    await expect(requestJson('/api/v1/example')).rejects.toMatchObject({
      kind: 'http', status: 409,
      code: 'PLAN_CONCURRENT_MODIFICATION', correlationId: 'request-abc',
    });
  });

  it('handles offline/network errors without exposing raw messages', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('private network detail')));
    await expect(requestJson('/api/v1/example')).rejects.toMatchObject({
      kind: 'network', status: null, message: 'API request failed',
    });
  });

  it('preserves AbortError for caller-controlled cancellation', async () => {
    const abort = new DOMException('The request was aborted', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abort));
    await expect(requestJson('/api/v1/example')).rejects.toBe(abort);
  });

  it('detects invalid JSON in successful responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('<html>not JSON</html>', { status: 200 }),
    ));
    await expect(requestJson('/api/v1/example')).rejects.toBeInstanceOf(ApiError);
    await expect(requestJson('/api/v1/example')).rejects.toMatchObject({ kind: 'invalid-response' });
  });
});
