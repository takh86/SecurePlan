/**
 * Real-socket regression test for S7-1: a local SMTP server that accepts the TCP
 * connection but never sends a greeting must not hang the caller. Uses the REAL
 * nodemailer with the production timeout options (only the port differs).
 */
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import nodemailer from 'nodemailer';
import { LOCAL_SMTP_OPTIONS } from './activation-mail.service.js';

const servers: net.Server[] = [];
const sockets = new Set<net.Socket>();

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function silentServer() {
  const state = { connections: 0 };
  const server = net.createServer((socket) => {
    state.connections += 1;
    sockets.add(socket); // accepts, then says nothing: no 220 greeting
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { state, port: (server.address() as AddressInfo).port };
}

describe('S7-1 — SMTP that never greets', () => {
  it('fails within the greeting timeout, makes exactly one attempt and leaks nothing', async () => {
    const { state, port } = await silentServer();
    const transport = nodemailer.createTransport({ ...LOCAL_SMTP_OPTIONS, port });
    const recipient = 'sp07-timeout@secureplan.test';
    const rawToken = 'T'.repeat(43);
    const started = Date.now();

    const failure = await transport
      .sendMail({ from: 'SecurePlan <no-reply@secureplan.test>', to: recipient, subject: 's', text: `#token=${rawToken}` })
      .then(() => null, (error: unknown) => error as Error & { code?: string });
    const elapsed = Date.now() - started;

    expect(failure).toBeInstanceOf(Error);
    // greetingTimeout (5 s) fired, not the 2-minute / 10-minute defaults.
    expect(elapsed).toBeGreaterThanOrEqual(4_000);
    expect(elapsed).toBeLessThan(9_000);
    // One connection: no hidden retry that could provision twice or mail twice.
    expect(state.connections).toBe(1);
    // The error text carries neither the address nor the token.
    expect(String(failure?.message)).not.toContain(recipient);
    expect(String(failure?.message)).not.toContain(rawToken);
  }, 20_000);

  it('keeps the documented option values', () => {
    expect(LOCAL_SMTP_OPTIONS).toMatchObject({
      connectionTimeout: 5_000,
      greetingTimeout: 5_000,
      socketTimeout: 10_000,
    });
  });
});