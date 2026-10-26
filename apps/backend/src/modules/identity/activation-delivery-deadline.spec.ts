import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACTIVATION_DELIVERY_DEADLINE_MS,
  ActivationDeliveryTimeoutError,
  withDeadline,
} from './activation-delivery.js';

describe('S7-1 — activation delivery deadline', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('passes through a result that arrives in time and clears its timer', async () => {
    const result = withDeadline(Promise.resolve('sent'), 1_000);
    await expect(result).resolves.toBe('sent');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('passes through the original failure (not masked as a timeout)', async () => {
    await expect(withDeadline(Promise.reject(new Error('smtp refused')), 1_000)).rejects.toThrow('smtp refused');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects with a timeout error when the work never settles', async () => {
    const outcome = withDeadline(new Promise<void>(() => {}), ACTIVATION_DELIVERY_DEADLINE_MS);
    const assertion = expect(outcome).rejects.toBeInstanceOf(ActivationDeliveryTimeoutError);
    await vi.advanceTimersByTimeAsync(ACTIVATION_DELIVERY_DEADLINE_MS);
    await assertion;
    // The message names no recipient, token or address.
    await expect(outcome).rejects.toThrow('Activation delivery exceeded its deadline');
  });

  it('the deadline is longer than the sum of the connect and greeting timeouts', () => {
    expect(ACTIVATION_DELIVERY_DEADLINE_MS).toBeGreaterThan(5_000 + 5_000);
  });
});