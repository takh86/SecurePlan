import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../shared/api/api-error';
import {
  DutyEditLease,
  MAX_RENEWAL_DELAY_MS,
  MIN_RENEWAL_DELAY_MS,
  renewalDelay,
  type LeaseApi,
  type LeaseTimers,
} from './duty-edit-lease';
import type { EditLeaseGrant } from './monthly-plan-types';

// Synthetic identifiers and tokens (canonical 43-character shape), not real data.
const PLAN = 'p-1';
const DUTY = 'd-1';
const TOKEN_A = 'A'.repeat(43);
const TOKEN_B = 'B'.repeat(43);
const T0 = Date.UTC(2026, 11, 3, 8, 0, 0);

/** Manual clock and timer queue: nothing runs until the test advances time. */
function manualTimers() {
  let now = T0;
  let seq = 0;
  const pending = new Map<number, { at: number; callback: () => void }>();
  const timers: LeaseTimers = {
    now: () => now,
    setTimeout: (callback, ms) => {
      seq += 1;
      pending.set(seq, { at: now + ms, callback });
      return seq;
    },
    clearTimeout: (handle) => {
      pending.delete(handle as number);
    },
  };
  return {
    timers,
    pending,
    /** Moves the clock and runs due timers in order; awaits the work they start. */
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, entry]) => entry.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].callback();
        await flush();
      }
      now = target;
    },
  };
}

async function flush() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

const grant = (token: string, at: number, ttlMs = 120_000): EditLeaseGrant => ({
  leaseToken: token,
  expiresAt: new Date(at + ttlMs).toISOString().replace('Z', '123Z'),
});

function fakeApi(overrides: Partial<LeaseApi> = {}) {
  const api = {
    acquireLease: vi.fn(async () => grant(TOKEN_A, T0)),
    renewLease: vi.fn(async (_plan: string, _duty: string, token: string) => grant(token, T0 + 60_000)),
    releaseLease: vi.fn(async () => undefined),
    ...overrides,
  };
  return api;
}

const http = (status: number, code: ConstructorParameters<typeof ApiError>[2]) => new ApiError('http', status, code, 'req-12');

describe('ADR-0006 — renewal delay', () => {
  it('renews at half the remaining time, bounded to 5–60 s; an implausible clock renews soon', () => {
    expect(renewalDelay(new Date(T0 + 120_000).toISOString(), T0)).toBe(60_000);
    expect(renewalDelay(new Date(T0 + 30_000).toISOString(), T0)).toBe(15_000);
    expect(renewalDelay(new Date(T0 + 3_600_000).toISOString(), T0)).toBe(MAX_RENEWAL_DELAY_MS);
    expect(renewalDelay(new Date(T0 + 4_000).toISOString(), T0)).toBe(MIN_RENEWAL_DELAY_MS);
    // Client clock ahead of the server by more than the TTL.
    expect(renewalDelay(new Date(T0 - 10_000).toISOString(), T0)).toBe(MIN_RENEWAL_DELAY_MS);
  });
});

describe('ADR-0006 — client lease lifecycle', () => {
  it('acquires, renews with the SAME token about every 60 s, and never exposes the token in its status', async () => {
    const clock = manualTimers();
    const api = fakeApi();
    const lease = new DutyEditLease(api, PLAN, DUTY, clock.timers);
    const seen: string[] = [];
    lease.subscribe(() => seen.push(lease.getStatus().kind));
    await lease.acquire();
    expect(lease.getStatus()).toMatchObject({ kind: 'held', grant: 1, renewalProblem: false });
    expect(JSON.stringify(lease.getStatus())).not.toContain(TOKEN_A);
    expect(seen).toEqual(['acquiring', 'held']);

    await clock.advance(59_999);
    expect(api.renewLease).not.toHaveBeenCalled();
    await clock.advance(1);
    expect(api.renewLease).toHaveBeenCalledWith(PLAN, DUTY, TOKEN_A);
    expect(lease.getStatus()).toMatchObject({ kind: 'held', grant: 1 });
    await clock.advance(60_000);
    expect(api.renewLease).toHaveBeenCalledTimes(2);
  });

  it('maps acquire refusals: another holder -> locked, not found -> gone, anything else -> failed', async () => {
    for (const [error, kind] of [
      [http(409, 'RESOURCE_EDIT_LOCKED'), 'locked'],
      [http(404, 'RESOURCE_NOT_FOUND'), 'gone'],
      [new ApiError('network', null, null, null), 'failed'],
      [http(403, 'ACTION_FORBIDDEN'), 'failed'],
    ] as const) {
      const clock = manualTimers();
      const lease = new DutyEditLease(fakeApi({ acquireLease: vi.fn(async () => { throw error; }) }), PLAN, DUTY, clock.timers);
      await lease.acquire();
      expect(lease.getStatus().kind, String(error.code)).toBe(kind);
      expect(lease.held).toBe(false);
      expect(clock.pending.size).toBe(0);
    }
  });

  it('a refused renewal (EDIT_LEASE_NOT_HELD) drops the token; no write can use it afterwards', async () => {
    const clock = manualTimers();
    const api = fakeApi({ renewLease: vi.fn(async () => { throw http(409, 'EDIT_LEASE_NOT_HELD'); }) });
    const lease = new DutyEditLease(api, PLAN, DUTY, clock.timers);
    await lease.acquire();
    await clock.advance(60_000);
    expect(lease.getStatus()).toEqual({ kind: 'lost' });
    const work = vi.fn(async () => 'written');
    await expect(lease.withToken(work)).rejects.toThrow('Edit lease not held');
    expect(work).not.toHaveBeenCalled();
    expect(clock.pending.size).toBe(0);
  });

  it('technical renewal failures are repeated within the lease; past its end the lease counts as lost', async () => {
    const clock = manualTimers();
    const renewLease = vi.fn(async (): Promise<EditLeaseGrant> => { throw new ApiError('network', null, null, null); });
    const lease = new DutyEditLease(fakeApi({ renewLease }), PLAN, DUTY, clock.timers);
    await lease.acquire();
    await clock.advance(60_000);
    expect(lease.getStatus()).toMatchObject({ kind: 'held', renewalProblem: true });
    // Retries every 5 s until the 120 s grant has run out by the local clock.
    await clock.advance(55_000);
    expect(renewLease.mock.calls.length).toBeGreaterThan(5);
    await clock.advance(10_000);
    expect(lease.getStatus()).toEqual({ kind: 'lost' });
    expect(clock.pending.size).toBe(0);
  });

  it('a renewal that recovers clears the problem flag and keeps the same grant number', async () => {
    const clock = manualTimers();
    let fail = true;
    const renewLease = vi.fn(async (_p: string, _d: string, token: string) => {
      if (fail) throw new ApiError('network', null, null, null);
      return grant(token, clock.timers.now());
    });
    const lease = new DutyEditLease(fakeApi({ renewLease }), PLAN, DUTY, clock.timers);
    await lease.acquire();
    await clock.advance(60_000);
    expect(lease.getStatus()).toMatchObject({ renewalProblem: true });
    fail = false;
    await clock.advance(5_000);
    expect(lease.getStatus()).toMatchObject({ kind: 'held', grant: 1, renewalProblem: false });
  });

  it('resume() renews at once when the planned renewal is overdue (throttled background tab)', async () => {
    const clock = manualTimers();
    const api = fakeApi();
    const lease = new DutyEditLease(api, PLAN, DUTY, clock.timers);
    await lease.acquire();
    lease.resume();
    expect(api.renewLease).not.toHaveBeenCalled();
    // The tab's timer was held back: time passed without the callback running.
    clock.pending.clear();
    await clock.advance(70_000);
    lease.resume();
    await flush();
    expect(api.renewLease).toHaveBeenCalledTimes(1);
  });

  it('withToken lends the token to one write; stop() during the write releases only after it settles', async () => {
    const clock = manualTimers();
    const api = fakeApi();
    const lease = new DutyEditLease(api, PLAN, DUTY, clock.timers);
    await lease.acquire();
    let finish!: () => void;
    const write = lease.withToken((token) => {
      expect(token).toBe(TOKEN_A);
      return new Promise<void>((done) => { finish = done; });
    });
    lease.stop();
    expect(api.releaseLease).not.toHaveBeenCalled();
    expect(lease.getStatus()).toEqual({ kind: 'idle' });
    finish();
    await write;
    expect(api.releaseLease).toHaveBeenCalledWith(PLAN, DUTY, TOKEN_A, undefined);
  });

  it('stop() releases (keepalive on pagehide) and stops renewing; a later acquire starts a new grant', async () => {
    const clock = manualTimers();
    const acquireLease = vi.fn()
      .mockResolvedValueOnce(grant(TOKEN_A, T0))
      .mockResolvedValueOnce(grant(TOKEN_B, T0));
    const api = fakeApi({ acquireLease });
    const lease = new DutyEditLease(api, PLAN, DUTY, clock.timers);
    await lease.acquire();
    lease.stop({ keepalive: true });
    expect(api.releaseLease).toHaveBeenCalledWith(PLAN, DUTY, TOKEN_A, { keepalive: true });
    expect(clock.pending.size).toBe(0);
    await lease.acquire();
    expect(lease.getStatus()).toMatchObject({ kind: 'held', grant: 2 });
    await clock.advance(60_000);
    expect(api.renewLease).toHaveBeenLastCalledWith(PLAN, DUTY, TOKEN_B);
  });

  it('StrictMode-like start/stop/start: the first, late grant is released, never kept alive', async () => {
    const clock = manualTimers();
    let resolveFirst!: (value: EditLeaseGrant) => void;
    const acquireLease = vi.fn()
      .mockImplementationOnce(() => new Promise<EditLeaseGrant>((done) => { resolveFirst = done; }))
      .mockResolvedValueOnce(grant(TOKEN_B, T0));
    const api = fakeApi({ acquireLease });
    const lease = new DutyEditLease(api, PLAN, DUTY, clock.timers);
    const first = lease.acquire();
    lease.stop();
    await lease.acquire();
    resolveFirst(grant(TOKEN_A, T0));
    await first;
    expect(api.releaseLease).toHaveBeenCalledWith(PLAN, DUTY, TOKEN_A, undefined);
    expect(lease.getStatus()).toMatchObject({ kind: 'held', grant: 1 });
    await lease.withToken(async (token) => expect(token).toBe(TOKEN_B));
  });

  it('markEnded() after a removal: no release request, no renewal', async () => {
    const clock = manualTimers();
    const api = fakeApi();
    const lease = new DutyEditLease(api, PLAN, DUTY, clock.timers);
    await lease.acquire();
    lease.markEnded();
    lease.stop();
    await clock.advance(180_000);
    expect(api.releaseLease).not.toHaveBeenCalled();
    expect(api.renewLease).not.toHaveBeenCalled();
    expect(lease.getStatus()).toEqual({ kind: 'ended' });
  });

  it('a failed release is swallowed silently (no log line can carry the token)', async () => {
    const clock = manualTimers();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const api = fakeApi({ releaseLease: vi.fn(async () => { throw http(409, 'EDIT_LEASE_NOT_HELD'); }) });
    const lease = new DutyEditLease(api, PLAN, DUTY, clock.timers);
    await lease.acquire();
    lease.stop();
    await flush();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
