import { afterEach, describe, expect, it, vi } from 'vitest';
import nodemailer from 'nodemailer';
import { ActivationMailService } from './activation-mail.service.js';
import { generateAccountToken } from './account-token.js';

vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn() } }));

describe('Local activation mail safety', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetAllMocks();
  });

  function configure() {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('APP_ORIGIN', 'http://127.0.0.1:5173');
    const sendMail = vi.fn().mockResolvedValue({});
    vi.mocked(nodemailer.createTransport).mockReturnValue({
      sendMail,
    } as unknown as ReturnType<typeof nodemailer.createTransport>);
    return sendMail;
  }

  it('sends a fragment link only through local SMTP', async () => {
    const sendMail = configure();
    const { rawToken } = generateAccountToken();
    await new ActivationMailService().sendActivationEmail(
      'sp04-synthetic@secureplan.test',
      rawToken,
    );

    expect(nodemailer.createTransport).toHaveBeenCalledExactlyOnceWith({
      host: '127.0.0.1',
      port: 1025,
      secure: false,
    });
    expect(sendMail).toHaveBeenCalledTimes(1);
    const message = sendMail.mock.calls[0][0] as { text: string; to: string };
    const link = new URL(
      message.text.split('\n').find((line) => line.startsWith('http:'))!,
    );
    expect(link.pathname).toBe('/activate');
    expect(link.search).toBe('');
    expect(link.hash === `#token=${rawToken}`).toBe(true);
    expect(message.to).toBe('sp04-synthetic@secureplan.test');
    expect(message.text).toContain('Aktivieren Sie Ihr Konto \u00fcber diesen Link:');
    expect(message.text).toContain('Er ist 24 Stunden g\u00fcltig.');
  });

  it.each([
    { name: 'NODE_ENV', value: 'production' },
    { name: 'APP_ORIGIN', value: 'https://example.invalid' },
    { name: 'APP_ORIGIN', value: 'synthetic-private-config' },
  ])(
    'refuses unsafe $name before constructing a transport',
    ({ name, value }) => {
      configure();
      vi.stubEnv(name, value);
      let error: unknown;
      try {
        new ActivationMailService();
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect(String(error).includes(value)).toBe(false);
      expect(nodemailer.createTransport).not.toHaveBeenCalled();
    },
  );

  it('rejects non-demo recipients and malformed tokens before sending', async () => {
    const sendMail = configure();
    const service = new ActivationMailService();
    await expect(
      service.sendActivationEmail(
        'synthetic@example.invalid',
        generateAccountToken().rawToken,
      ),
    ).rejects.toThrow('Only synthetic test addresses are allowed');
    await expect(
      service.sendActivationEmail(
        'sp04-synthetic@secureplan.test',
        'malformed',
      ),
    ).rejects.toThrow('Invalid activation token format');
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('propagates SMTP rejection so the caller can revoke the issued token', async () => {
    const sendMail = configure();
    sendMail.mockRejectedValue(new Error('Synthetic SMTP failure'));
    await expect(
      new ActivationMailService().sendActivationEmail(
        'sp04-synthetic@secureplan.test',
        generateAccountToken().rawToken,
      ),
    ).rejects.toThrow('Synthetic SMTP failure');
  });
});
