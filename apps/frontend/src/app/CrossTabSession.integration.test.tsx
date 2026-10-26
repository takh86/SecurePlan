// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost:8443/"}
/**
 * Cross-tab session signals through <App/> with the REAL BroadcastChannel:
 * the test itself plays "the other tab" by posting on the shared channel name.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import App from '../App';

const CSRF = 'c'.repeat(43);
const ADMIN = {
  accountId: '11111111-1111-4111-8111-111111111111',
  companyId: '22222222-2222-4222-8222-222222222222',
  email: 'admin@secureplan.test',
  role: 'COMPANY_ADMIN',
};

type Responder = () => Response | Promise<Response>;
const authorized: Responder = () => new Response(JSON.stringify(ADMIN), {
  status: 200,
  headers: { 'content-type': 'application/json', 'x-csrf-token': CSRF },
});
const unauthorized: Responder = () => new Response(JSON.stringify({ code: 'SESSION_REVOKED' }), {
  status: 401,
  headers: { 'content-type': 'application/problem+json' },
});

let otherTab: BroadcastChannel;

function stubApi(queues: Record<string, Responder[]>) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const next = queues[String(input)]?.shift();
    return next ? Promise.resolve(next()) : Promise.reject(new Error(`Unexpected request ${String(input)}`));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function signedInAt(path: string, queues: Record<string, Responder[]>) {
  const fetchMock = stubApi(queues);
  window.history.replaceState(null, '', path);
  render(<App />);
  expect(await screen.findByRole('navigation', { name: 'Hauptnavigation' })).toBeTruthy();
  return fetchMock;
}

beforeEach(() => {
  // Deterministic "today" for the preview landing page.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 11, 15, 12, 0, 0));
  otherTab = new BroadcastChannel('secureplan-session');
});

afterEach(() => {
  otherTab.close();
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('cross-tab session signals through <App/>', () => {
  it('a logout in another tab removes the shell and resets the URL; nothing is requested', async () => {
    const fetchMock = await signedInAt('/arbeitsuebersicht', { '/api/v1/me': [authorized] });
    act(() => otherTab.postMessage({ type: 'signed-out' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Anmelden' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Hauptnavigation' })).toBeNull();
    expect(document.body.textContent).not.toContain(ADMIN.email);
    await waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual(['/api/v1/me']);
  });

  it('a login in another tab re-checks the session; a revoked session ends in the login form', async () => {
    const fetchMock = await signedInAt('/arbeitsuebersicht', { '/api/v1/me': [authorized, unauthorized] });
    act(() => otherTab.postMessage({ type: 'signed-in' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Anmelden' })).toBeTruthy();
    expect(document.body.textContent).not.toContain(ADMIN.email);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual(['/api/v1/me', '/api/v1/me']);
  });

  it('a login in another tab keeps the shell when the server confirms the session', async () => {
    const fetchMock = await signedInAt('/arbeitsuebersicht', { '/api/v1/me': [authorized, authorized] });
    act(() => otherTab.postMessage({ type: 'signed-in' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('navigation', { name: 'Hauptnavigation' })).toBeTruthy();
    expect(window.location.pathname).toBe('/arbeitsuebersicht');
  });

  it('ignores malformed messages on the channel', async () => {
    const fetchMock = await signedInAt('/arbeitsuebersicht', { '/api/v1/me': [authorized] });
    // A second listener proves the messages were actually delivered.
    const delivered: unknown[] = [];
    const spy = new BroadcastChannel('secureplan-session');
    spy.onmessage = (event: MessageEvent) => delivered.push(event.data);
    act(() => otherTab.postMessage({ type: 'signed-out', reason: 'x' }));
    act(() => otherTab.postMessage('signed-out'));
    await waitFor(() => expect(delivered).toHaveLength(2));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    spy.close();

    expect(screen.getByRole('navigation', { name: 'Hauptnavigation' })).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 1, name: 'Anmelden' })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
