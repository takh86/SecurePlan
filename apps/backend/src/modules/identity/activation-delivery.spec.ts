import { ActivationDeliveryUnavailableError, createActivationDelivery } from './activation-delivery.js';

describe('SP-07 — activation delivery port', () => {
  const original = { NODE_ENV: process.env.NODE_ENV, APP_ORIGIN: process.env.APP_ORIGIN };

  afterEach(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('outside development there is no approved transport: delivery fails explicitly, never silently', async () => {
    for (const environment of ['production', 'test', 'staging']) {
      process.env.NODE_ENV = environment;
      const delivery = createActivationDelivery();
      await expect(delivery.deliver('a@secureplan.test', 'x'.repeat(43))).rejects.toBeInstanceOf(
        ActivationDeliveryUnavailableError,
      );
    }
  });

  it('in development the local mail adapter is created lazily, so a bad mail config cannot block start-up', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.APP_ORIGIN;
    const delivery = createActivationDelivery(); // must not throw
    // The adapter's own guard fails on first use and surfaces as a delivery failure.
    await expect(delivery.deliver('a@secureplan.test', 'x'.repeat(43))).rejects.toThrow('APP_ORIGIN is required');
  });

  it('issue #129: development accepts only synthetic @secureplan.test recipients up front', () => {
    process.env.NODE_ENV = 'development';
    const delivery = createActivationDelivery();
    expect(delivery.acceptsRecipient('mira@secureplan.test')).toBe(true);
    expect(delivery.acceptsRecipient('MIRA@SECUREPLAN.TEST')).toBe(true);
    for (const email of ['mira@gmail.com', 'mira@secureplan.test.example.com', 'mira@sub.secureplan.testx']) {
      expect(delivery.acceptsRecipient(email)).toBe(false);
    }
  });

  it('issue #129: the development-only allowlist is not applied outside development', () => {
    process.env.NODE_ENV = 'production';
    expect(createActivationDelivery().acceptsRecipient('mira@example.com')).toBe(true);
  });
});
