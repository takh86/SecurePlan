/**
 * Cross-tab session signals. All tabs of one browser profile share the same
 * HttpOnly session cookie, so a logout or a new login in one tab changes the
 * session of every other tab, which still shows protected content from its
 * own memory until its next request.
 *
 * Only the bare signal is broadcast: no identity, no CSRF token, nothing that
 * would be useful to another context. A browser without BroadcastChannel gets
 * a no-op channel; the server-side session checks stay authoritative.
 */
export type SessionSignal = 'signed-out' | 'signed-in';

export interface SessionChannel {
  post(signal: SessionSignal): void;
  close(): void;
}

export type OpenSessionChannel = (onSignal: (signal: SessionSignal) => void) => SessionChannel;

const CHANNEL_NAME = 'secureplan-session';

/** Accepts exactly `{ type: 'signed-out' | 'signed-in' }`; anything else is ignored. */
export function readSessionSignal(data: unknown): SessionSignal | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const keys = Object.keys(data);
  const type = (data as { type?: unknown }).type;
  return keys.length === 1 && (type === 'signed-out' || type === 'signed-in') ? type : null;
}

export const openSessionChannel: OpenSessionChannel = (onSignal) => {
  if (typeof BroadcastChannel === 'undefined') return { post() {}, close() {} };
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (event: MessageEvent<unknown>) => {
    const signal = readSessionSignal(event.data);
    if (signal) onSignal(signal);
  };
  return {
    post(signal) {
      channel.postMessage({ type: signal });
    },
    close() {
      channel.onmessage = null;
      channel.close();
    },
  };
};
