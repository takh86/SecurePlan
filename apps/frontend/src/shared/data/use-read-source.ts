import { useEffect, useState } from 'react';
import type { ReadSource } from './data-source';

export type ReadState<T> =
  | { status: 'loading' }
  | { status: 'error'; error: Error }
  | { status: 'ready'; data: T };

type Settled<TQuery, TResult> = {
  source: ReadSource<TQuery, TResult>;
  query: TQuery;
  attempt: number;
  state: ReadState<TResult>;
};

/**
 * Loads read-only data from a source. A result only counts for the request it
 * belongs to, so switching source/query shows `loading` instead of stale data.
 * `query` must be a primitive (or stable) value.
 */
export function useReadSource<TQuery, TResult>(
  source: ReadSource<TQuery, TResult>,
  query: TQuery,
): { state: ReadState<TResult>; retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<Settled<TQuery, TResult> | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    source.load(query, controller.signal).then(
      (data) => {
        if (controller.signal.aborted) return;
        setSettled({ source, query, attempt, state: { status: 'ready', data } });
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return;
        const error = cause instanceof Error ? cause : new Error('Load failed');
        setSettled({ source, query, attempt, state: { status: 'error', error } });
      },
    );
    return () => controller.abort();
  }, [source, query, attempt]);

  const state: ReadState<TResult> =
    settled !== null &&
    settled.source === source &&
    Object.is(settled.query, query) &&
    settled.attempt === attempt
      ? settled.state
      : { status: 'loading' };

  return { state, retry: () => setAttempt((current) => current + 1) };
}
