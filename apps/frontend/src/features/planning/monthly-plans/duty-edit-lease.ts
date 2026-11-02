/**
 * Client side of one ADR-0006 duty edit lease.
 *
 * The token lives only in this object's private field: it is never part of a
 * status snapshot, React state, a URL, a log line or browser storage. Mutations
 * borrow it through `withToken`, so the token never leaves this module except
 * as the `Edit-Lease-Token` header built by the session transport.
 *
 * The server is authoritative for expiry. `expiresAt` (server clock) only
 * schedules the renewal: at half of the remaining time, between 5 and 60
 * seconds (default TTL 120 s -> about every 60 s, as ADR-0006 expects). A
 * client clock that disagrees with the server can at worst make the client
 * renew too often or give up early; it can never extend a lease, because every
 * renewal and every write is checked by the server under its own clock.
 *
 * Renewal does not change the token, so repeating a renewal after a lost
 * response is safe (it only extends the same lease). Writes are never retried
 * here. Acquiring again after a loss is an explicit user action.
 */
import { ApiError } from '../../../shared/api/api-error';
import type { EditLeaseGrant } from './monthly-plan-types';

export type LeaseApi = {
  acquireLease(planId: string, dutyId: string): Promise<EditLeaseGrant>;
  renewLease(planId: string, dutyId: string, leaseToken: string): Promise<EditLeaseGrant>;
  releaseLease(planId: string, dutyId: string, leaseToken: string, options?: { keepalive?: boolean }): Promise<void>;
};

export type LeaseStatus =
  /** Nothing requested yet, or the lease was given up deliberately (closing, page hidden). */
  | { kind: 'idle' }
  | { kind: 'acquiring' }
  /**
   * Held by this editor. `grant` counts successful acquisitions (not renewals),
   * so a caller can re-check the duty after every new grant. `renewalProblem`:
   * the last renewal attempt failed technically and is being repeated.
   */
  | { kind: 'held'; grant: number; expiresAt: string; renewalProblem: boolean }
  /** RESOURCE_EDIT_LOCKED: another account holds a live lease. */
  | { kind: 'locked' }
  /** No longer held: expired, released elsewhere or taken over (EDIT_LEASE_NOT_HELD). */
  | { kind: 'lost' }
  /** The duty is no longer visible (404): removed or out of scope. */
  | { kind: 'gone' }
  /** Acquiring failed for another reason (connection, server, permission). */
  | { kind: 'failed'; error: Error }
  /** The server released the lease as part of removing the duty. */
  | { kind: 'ended' };

export type LeaseTimers = {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

const browserTimers: LeaseTimers = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export const MIN_RENEWAL_DELAY_MS = 5_000;
export const MAX_RENEWAL_DELAY_MS = 60_000;
/** Pause before repeating a renewal that failed technically. */
export const RENEWAL_RETRY_MS = 5_000;

/** Delay until the next renewal for a grant observed at `now`. */
export function renewalDelay(expiresAt: string, now: number): number {
  const remaining = Date.parse(expiresAt) - now;
  if (!Number.isFinite(remaining) || remaining <= 0) return MIN_RENEWAL_DELAY_MS;
  return Math.min(MAX_RENEWAL_DELAY_MS, Math.max(MIN_RENEWAL_DELAY_MS, Math.floor(remaining / 2)));
}

function isCode(error: unknown, status: number, code?: string): boolean {
  return error instanceof ApiError && error.status === status && (code === undefined || error.code === code);
}

export class DutyEditLease {
  readonly #api: LeaseApi;
  readonly #planId: string;
  readonly #dutyId: string;
  readonly #timers: LeaseTimers;
  #token: string | null = null;
  #status: LeaseStatus = { kind: 'idle' };
  #grants = 0;
  /** Local time after which the last grant has expired by the client's clock. */
  #deadline = 0;
  /** Local time of the next planned renewal. */
  #renewAt = 0;
  #timer: unknown = null;
  /** Invalidates async results that belong to an earlier start/stop cycle. */
  #generation = 0;
  #renewing = false;
  /** Writes currently using the token; a stop waits for them before releasing. */
  #writes = 0;
  #releaseAfterWrites: { token: string; keepalive: boolean } | null = null;
  readonly #listeners = new Set<() => void>();

  constructor(api: LeaseApi, planId: string, dutyId: string, timers: LeaseTimers = browserTimers) {
    this.#api = api;
    this.#planId = planId;
    this.#dutyId = dutyId;
    this.#timers = timers;
  }

  /** Immutable snapshot; a new object after every change (useSyncExternalStore). */
  readonly getStatus = (): LeaseStatus => this.#status;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** True while this editor may send a write. */
  get held(): boolean {
    return this.#status.kind === 'held' && this.#token !== null;
  }

  #set(status: LeaseStatus) {
    this.#status = status;
    for (const listener of [...this.#listeners]) listener();
  }

  #clearTimer() {
    if (this.#timer !== null) this.#timers.clearTimeout(this.#timer);
    this.#timer = null;
  }

  #schedule(ms: number) {
    this.#clearTimer();
    this.#renewAt = this.#timers.now() + ms;
    const generation = this.#generation;
    this.#timer = this.#timers.setTimeout(() => {
      this.#timer = null;
      if (generation === this.#generation) void this.renew();
    }, ms);
  }

  #grant(grant: EditLeaseGrant, isNew: boolean) {
    const now = this.#timers.now();
    this.#token = grant.leaseToken;
    this.#deadline = now + Math.max(0, Date.parse(grant.expiresAt) - now);
    if (isNew) this.#grants += 1;
    this.#set({ kind: 'held', grant: this.#grants, expiresAt: grant.expiresAt, renewalProblem: false });
    this.#schedule(renewalDelay(grant.expiresAt, now));
  }

  /** Forgets the token (it can no longer authorize anything) and stops renewing. */
  #drop(status: LeaseStatus) {
    this.#clearTimer();
    this.#token = null;
    this.#set(status);
  }

  /**
   * Acquires the lease (first time, after a loss, or after a deliberate stop).
   * An account that already holds it gets a new token (server-side rotation).
   */
  async acquire(): Promise<void> {
    if (this.#status.kind === 'acquiring' || this.held) return;
    const generation = ++this.#generation;
    this.#clearTimer();
    this.#token = null;
    this.#set({ kind: 'acquiring' });
    try {
      const grant = await this.#api.acquireLease(this.#planId, this.#dutyId);
      if (generation !== this.#generation) {
        // Stopped meanwhile: give the fresh lease back instead of keeping it alive.
        this.#releaseToken(grant.leaseToken, false);
        return;
      }
      this.#grant(grant, true);
    } catch (error) {
      if (generation !== this.#generation) return;
      if (isCode(error, 409, 'RESOURCE_EDIT_LOCKED')) this.#drop({ kind: 'locked' });
      else if (isCode(error, 404)) this.#drop({ kind: 'gone' });
      else this.#drop({ kind: 'failed', error: error instanceof Error ? error : new Error('Lease failed') });
    }
  }

  /** Renews now (timer, page visible again). Ignored unless the lease is held. */
  async renew(): Promise<void> {
    if (!this.held || this.#renewing) return;
    const token = this.#token!;
    const generation = this.#generation;
    this.#renewing = true;
    try {
      const grant = await this.#api.renewLease(this.#planId, this.#dutyId, token);
      if (generation !== this.#generation || this.#token !== token) return;
      this.#grant(grant, false);
    } catch (error) {
      if (generation !== this.#generation || this.#token !== token) return;
      if (isCode(error, 409, 'EDIT_LEASE_NOT_HELD')) this.#drop({ kind: 'lost' });
      else if (isCode(error, 404)) this.#drop({ kind: 'gone' });
      else if (isCode(error, 401) || isCode(error, 403)) {
        this.#drop({ kind: 'failed', error: error instanceof Error ? error : new Error('Renewal refused') });
      } else if (this.#timers.now() >= this.#deadline) {
        // Technical failures until the end of the lease: it has expired by now.
        this.#drop({ kind: 'lost' });
      } else {
        const status = this.#status;
        if (status.kind === 'held') this.#set({ ...status, renewalProblem: true });
        this.#schedule(Math.min(RENEWAL_RETRY_MS, Math.max(1_000, this.#deadline - this.#timers.now())));
      }
    } finally {
      this.#renewing = false;
    }
  }

  /** Page became visible again: hidden tabs may have delayed the timer, so check at once. */
  resume(): void {
    // Even past the local deadline only the server can say whether the lease is gone: a renewal decides.
    if (this.held && this.#timers.now() >= this.#renewAt) void this.renew();
  }

  /**
   * Runs one write with the current token. Rejects without sending anything
   * when the lease is not held. The write's own errors are passed through.
   */
  async withToken<T>(work: (token: string) => Promise<T>): Promise<T> {
    if (!this.held) throw new Error('Edit lease not held');
    this.#writes += 1;
    try {
      return await work(this.#token!);
    } finally {
      this.#writes -= 1;
      const pending = this.#releaseAfterWrites;
      if (this.#writes === 0 && pending) {
        this.#releaseAfterWrites = null;
        this.#releaseToken(pending.token, pending.keepalive);
      }
    }
  }

  /** A write reported EDIT_LEASE_NOT_HELD: the server no longer accepts this token. */
  markLost(): void {
    if (this.#status.kind === 'held') this.#drop({ kind: 'lost' });
  }

  /** The duty was removed; the server released the lease in the same transaction. */
  markEnded(): void {
    this.#generation += 1;
    this.#releaseAfterWrites = null;
    this.#drop({ kind: 'ended' });
  }

  /**
   * Gives the lease up (closing the editor, leaving the page). Best effort:
   * a failed release only means the lease runs out after its TTL.
   */
  stop(options: { keepalive?: boolean } = {}): void {
    this.#generation += 1;
    this.#clearTimer();
    const token = this.#token;
    this.#token = null;
    if (token !== null) {
      // A write still in flight keeps its lease: releasing first would make the server refuse it.
      if (this.#writes > 0) this.#releaseAfterWrites = { token, keepalive: options.keepalive ?? false };
      else this.#releaseToken(token, options.keepalive ?? false);
    }
    if (this.#status.kind === 'held' || this.#status.kind === 'acquiring') this.#set({ kind: 'idle' });
  }

  #releaseToken(token: string, keepalive: boolean) {
    // Errors are deliberately not logged: neither the token nor a lease detail may reach a log.
    this.#api.releaseLease(this.#planId, this.#dutyId, token, keepalive ? { keepalive: true } : undefined).catch(() => undefined);
  }
}
