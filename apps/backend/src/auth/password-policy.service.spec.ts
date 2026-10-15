import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PasswordPolicyService } from './password-policy.service.js';

describe('PasswordPolicyService', () => {
  const testDenylist = new Set([
    'password123456789',
    'blockedsyntheticpassphrase2026',
  ]);

  const policy = new PasswordPolicyService(testDenylist);

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('rejects passwords shorter than 15 characters', async () => {
    await expect(policy.assertAllowed('short-password')).rejects.toMatchObject({
      response: { code: 'PASSWORD_POLICY_VIOLATION' },
    });
  });

  it('rejects passwords longer than 128 characters', async () => {
    await expect(policy.assertAllowed('a'.repeat(129))).rejects.toMatchObject({
      response: { code: 'PASSWORD_POLICY_VIOLATION' },
    });
  });

  it('rejects a locally blocked common password', async () => {
    await expect(
      policy.assertAllowed('Password123456789'),
    ).rejects.toMatchObject({
      response: { code: 'PASSWORD_POLICY_VIOLATION' },
    });
  });

  it('rejects a password found in breach data', async () => {
    const password = 'A-Compromised-Test-Passphrase-2026';

    const sha1 = createHash('sha1')
      .update(password)
      .digest('hex')
      .toUpperCase();

    const suffix = sha1.slice(5);

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response(`${suffix}:12\n`, { status: 200 })),
    );

    await expect(policy.assertAllowed(password)).rejects.toMatchObject({
      response: { code: 'PASSWORD_POLICY_VIOLATION' },
    });
  });

  it('accepts a password absent from the mocked breach results', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(`${'0'.repeat(35)}:0\n`, { status: 200 }),
        ),
    );

    await expect(
      policy.assertAllowed('my long lowercase passphrase'),
    ).resolves.toBeUndefined();
  });

  it('fails closed when the breach service is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('Network unavailable')),
    );

    await expect(
      policy.assertAllowed('Another long test passphrase 2026'),
    ).rejects.toMatchObject({
      response: { code: 'SERVICE_UNAVAILABLE' },
      status: 503,
    });
  });
  it('rejects an injected denylist entry before calling HIBP', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      policy.assertAllowed('BlockedSyntheticPassphrase2026'),
    ).rejects.toMatchObject({
      response: { code: 'PASSWORD_POLICY_VIOLATION' },
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects oversized HIBP responses and cancels the stream', async () => {
    const cancel = vi.fn();

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(100_000).fill(65));

        controller.enqueue(new Uint8Array(100_001).fill(65));
      },
      cancel,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(body, { status: 200 })),
    );

    await expect(
      policy.assertAllowed('streaming test password 2026'),
    ).rejects.toMatchObject({
      response: { code: 'SERVICE_UNAVAILABLE' },
      status: 503,
    });

    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('fails closed when HIBP returns invalid UTF-8', async () => {
    const invalidUtf8 = new Uint8Array([0xc3, 0x28]);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(invalidUtf8, { status: 200 })),
    );

    await expect(
      policy.assertAllowed('UTF8 validation test password 2026'),
    ).rejects.toMatchObject({
      response: { code: 'SERVICE_UNAVAILABLE' },
      status: 503,
    });
  });

  it.each([15, 128])(
    'accepts the %i-character boundary and sends only the padded hash prefix',
    async (length) => {
      const password = 'z'.repeat(length);
      const hash = createHash('sha1')
        .update(password)
        .digest('hex')
        .toUpperCase();
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          new Response(`${hash.slice(5)}:0\r\n`, { status: 200 }),
        );
      vi.stubGlobal('fetch', fetchMock);

      await expect(policy.assertAllowed(password)).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
        `https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`,
        {
          headers: { 'Add-Padding': 'true', 'User-Agent': 'SecurePlan/1.0' },
          signal: expect.any(AbortSignal),
        },
      );
      const options = fetchMock.mock.calls[0][1] as RequestInit;
      expect(options.body).toBeUndefined();
    },
  );

  it.each([
    {
      label: 'an HTTP error',
      response: () => new Response('unavailable', { status: 503 }),
    },
    {
      label: 'a missing body',
      response: () => new Response(null, { status: 200 }),
    },
    {
      label: 'an empty body',
      response: () => new Response('', { status: 200 }),
    },
    {
      label: 'a whitespace-only body',
      response: () => new Response(' \r\n', { status: 200 }),
    },
    {
      label: 'a malformed entry',
      response: () =>
        new Response(`${'0'.repeat(35)}:0\ninvalid`, { status: 200 }),
    },
    {
      label: 'a failed body stream',
      response: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('Synthetic stream failure'));
            },
          }),
        ),
    },
  ])('fails closed for $label', async ({ response }) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response()));

    await expect(
      policy.assertAllowed('Synthetic response test passphrase'),
    ).rejects.toMatchObject({
      response: { code: 'SERVICE_UNAVAILABLE' },
      status: 503,
    });
  });

  it('applies the five-second timeout and fails closed on abort', async () => {
    const controller = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(controller.signal);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url, options: RequestInit) =>
          new Promise((_resolve, reject) => {
            options.signal!.addEventListener(
              'abort',
              () => reject(options.signal!.reason),
              { once: true },
            );
          }),
      ),
    );

    const result = policy.assertAllowed('Synthetic timeout test passphrase');
    const assertion = expect(result).rejects.toMatchObject({
      response: { code: 'SERVICE_UNAVAILABLE' },
      status: 503,
    });
    controller.abort(new DOMException('Synthetic timeout', 'TimeoutError'));
    await assertion;
    expect(timeout).toHaveBeenCalledExactlyOnceWith(5000);
  });
});
