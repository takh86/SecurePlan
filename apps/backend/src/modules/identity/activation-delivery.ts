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
import { ActivationMailService } from '../../auth/activation-mail.service.js';

export const ACTIVATION_DELIVERY = Symbol('ACTIVATION_DELIVERY');

export interface ActivationDelivery {
  deliver(email: string, rawToken: string): Promise<void>;
}

export class ActivationDeliveryUnavailableError extends Error {
  constructor() {
    super('No activation delivery transport is configured for this environment');
  }
}

export function createActivationDelivery(): ActivationDelivery {
  if (process.env.NODE_ENV !== 'development') {
    return { deliver: () => Promise.reject(new ActivationDeliveryUnavailableError()) };
  }
  // Lazy: a misconfigured local mail adapter must not prevent application start.
  let mailer: ActivationMailService | undefined;
  return {
    async deliver(email, rawToken) {
      mailer ??= new ActivationMailService();
      await mailer.sendActivationEmail(email, rawToken);
    },
  };
}
