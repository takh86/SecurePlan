import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSessionChannel, readSessionSignal, type SessionSignal } from './session-channel';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cross-tab session channel', () => {
  it('accepts only the two bare signals', () => {
    expect(readSessionSignal({ type: 'signed-out' })).toBe('signed-out');
    expect(readSessionSignal({ type: 'signed-in' })).toBe('signed-in');
    for (const data of [
      null, 'signed-out', ['signed-out'], {}, { type: 'logout' },
      { type: 'signed-out', csrfToken: 'x' }, { type: 'signed-in', accountId: 'a-1' },
    ]) {
      expect(readSessionSignal(data), JSON.stringify(data)).toBeNull();
    }
  });

  it('delivers a signal to other tabs only, carries nothing but the signal, and stops after close', async () => {
    const received: SessionSignal[] = [];
    const echoed: SessionSignal[] = [];
    const sender = openSessionChannel((signal) => echoed.push(signal));
    const raw: unknown[] = [];
    const spy = new BroadcastChannel('secureplan-session');
    spy.onmessage = (event: MessageEvent) => raw.push(event.data);
    const other = openSessionChannel((signal) => received.push(signal));

    sender.post('signed-out');
    await vi.waitFor(() => expect(received).toEqual(['signed-out']));
    expect(raw).toEqual([{ type: 'signed-out' }]);

    other.close();
    sender.post('signed-in');
    await vi.waitFor(() => expect(raw).toHaveLength(2));
    // The closed tab received nothing more; the sender never hears its own signal.
    expect(received).toEqual(['signed-out']);
    expect(echoed).toEqual([]);
    sender.close();
    spy.close();
  });

  it('ignores malformed messages from other contexts', async () => {
    const received: SessionSignal[] = [];
    const tab = openSessionChannel((signal) => received.push(signal));
    const foreign = new BroadcastChannel('secureplan-session');
    foreign.postMessage({ type: 'signed-out', extra: 1 });
    foreign.postMessage({ type: 'signed-in' });
    await vi.waitFor(() => expect(received).toEqual(['signed-in']));
    tab.close();
    foreign.close();
  });

  it('is a safe no-op where BroadcastChannel is unavailable', () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const channel = openSessionChannel(() => {
      throw new Error('must not be called');
    });
    expect(() => {
      channel.post('signed-out');
      channel.close();
    }).not.toThrow();
  });
});
