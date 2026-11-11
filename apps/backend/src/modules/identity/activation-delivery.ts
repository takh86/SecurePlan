/**
 * Identity: outbound delivery of activation links.
 *
 * Runs only AFTER the provisioning transaction committed (no SMTP call inside a
 * DB transaction). The raw token is passed in memory only; never log it.
 *
 * Only a development transport exists: the local Mailpit adapter, which accepts
 * synthetic @secureplan.test recipients only. No transport is approved for any
 * other environment yet, so delivery there fails explicitly instead of
 * pretending success.
 */
import { ActivationMailService, isSyntheticTestRecipient } from '../../auth/activation-mail.service.js';

export const ACTIVATION_DELIVERY = Symbol('ACTIVATION_DELIVERY');

export interface ActivationDelivery {
  /**
   * Pre-commit recipient policy of the active transport. false means delivery
   * is known to be refused for this address, so the caller must reject the
   * request before persisting anything. true does NOT guarantee delivery.
   */
  acceptsRecipient(email: string): boolean;
  deliver(email: string, rawToken: string): Promise<void>;
}

/** Hard upper bound for one delivery attempt (all SMTP phases together). */
export const ACTIVATION_DELIVERY_DEADLINE_MS = 15_000;

export class ActivationDeliveryTimeoutError extends Error {
  constructor() {
    super('Activation delivery exceeded its deadline');
  }
}

/**
 * Rejects when work does not settle in time. The attempt itself cannot be cancelled,
 * so a late success is possible; the caller treats a timeout as a failed delivery
 * (token revoked), which is the safe side. No retry happens here.
 */
export async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ActivationDeliveryTimeoutError()), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export class ActivationDeliveryUnavailableError extends Error {
  constructor() {
    super('No activation delivery transport is configured for this environment');
  }
}

export function createActivationDelivery(): ActivationDelivery {
  if (process.env.NODE_ENV !== 'development') {
    // Production recipient policy is a separate gate; the development-only
    // allowlist is deliberately not applied here.
    return {
      acceptsRecipient: () => true,
      deliver: () => Promise.reject(new ActivationDeliveryUnavailableError()),
    };
  }
  // Lazy: a misconfigured local mail adapter must not prevent application start.
  let mailer: ActivationMailService | undefined;
  return {
    acceptsRecipient: isSyntheticTestRecipient,
    async deliver(email, rawToken) {
      mailer ??= new ActivationMailService();
      await withDeadline(mailer.sendActivationEmail(email, rawToken), ACTIVATION_DELIVERY_DEADLINE_MS);
    },
  };
}
