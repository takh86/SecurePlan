import { Injectable } from '@nestjs/common';
import nodemailer from 'nodemailer';

/**
 * Local development SMTP (Mailpit). Explicit timeouts, because the activation mail is sent
 * synchronously after the employee commit and must never hang the HTTP request:
 * - connectionTimeout: time to establish the TCP connection;
 * - greetingTimeout: time to wait for the server greeting after connecting;
 * - socketTimeout: inactivity on an open socket.
 * nodemailer does not retry a failed sendMail (no pool), so a timeout is one attempt.
 */
export const LOCAL_SMTP_OPTIONS = {
  host: '127.0.0.1',
  port: 1025,
  secure: false,
  connectionTimeout: 5_000,
  greetingTimeout: 5_000,
  socketTimeout: 10_000,
} as const;

@Injectable()
export class ActivationMailService {
  private readonly transport;
  private readonly appOrigin: string;

  constructor() {
    // This adapter is strictly for the local development demo.
    if (process.env.NODE_ENV !== 'development') {
      throw new Error('Local mail adapter is development-only');
    }

    const origin = process.env.APP_ORIGIN;

    if (!origin) {
      throw new Error('APP_ORIGIN is required');
    }

    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error('Invalid local APP_ORIGIN');
    }

    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1'].includes(url.hostname) ||
      url.origin !== origin
    ) {
      throw new Error('Invalid local APP_ORIGIN');
    }

    this.appOrigin = origin;

    this.transport = nodemailer.createTransport({ ...LOCAL_SMTP_OPTIONS });
  }

  async sendActivationEmail(email: string, rawToken: string): Promise<void> {
    // Never send demo emails to real addresses.
    if (!/^[^@\s]+@secureplan\.test$/i.test(email)) {
      throw new Error('Only synthetic test addresses are allowed');
    }

    if (!/^[A-Za-z0-9_-]{43}$/.test(rawToken)) {
      throw new Error('Invalid activation token format');
    }

    const link = new URL('/activate', this.appOrigin);
    link.hash = `token=${encodeURIComponent(rawToken)}`;

    await this.transport.sendMail({
      from: 'SecurePlan <no-reply@secureplan.test>',
      to: email,
      subject: 'SecurePlan - Konto aktivieren',
      text: [
        'Willkommen bei SecurePlan!',
        '',
        'Aktivieren Sie Ihr Konto über diesen Link:',
        link.toString(),
        '',
        'Dieser Link ist einmalig verwendbar.',
        'Er ist 24 Stunden gültig.',
      ].join('\n'),
    });
  }
}
