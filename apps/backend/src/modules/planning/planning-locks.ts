/**
 * Bounded waits for the new LOCK-01-L1 writers (SP11A-R1 T1 DEC-1.6/1.7):
 * planning writes and employee deactivation. Technical settings, measured in
 * PR-1, not business constants. Run as the first statement of the transaction.
 *
 * A lock timeout (55P03), deadlock (40P01) or serialization failure (40001)
 * rolls the whole transaction back and surfaces as a sanitized 500 with a
 * correlation ID: never a stale-decision 409 and never an automatic replay of
 * a human command.
 */
export const PLANNING_WRITER_TIMEOUTS = "SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '15s'";
