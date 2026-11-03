/**
 * SP-13 First Publish: pure rules of the publish dialog. What the dialog
 * summarises, whether the duties on screen still match the server, and how a
 * failed attempt is classified: either its outcome is unknown (the SAME key may
 * be resent; the server replays a completed publication instead of repeating
 * it) or it is a definitive refusal (nothing was published; another attempt is
 * a new decision with a new key). No staffing minimum or completeness rule is
 * implied: an empty plan is publishable and the server re-validates everything.
 */
import { ApiError } from '../../../shared/api/api-error';
import type { Duty } from './monthly-plan-types';

export type PublishSummary = {
  duties: number;
  /** Duties without any member (allowed; shown for information only). */
  unstaffed: number;
  /** Distinct employees with at least one membership. */
  people: number;
  /** E-04 neutral hints: memberships of people unavailable on their duty date. */
  unavailable: number;
};

export function publishSummary(duties: readonly Duty[]): PublishSummary {
  const people = new Set(duties.flatMap((duty) => duty.assignments.map((member) => member.employeeId.toLowerCase())));
  return {
    duties: duties.length,
    unstaffed: duties.filter((duty) => duty.assignments.length === 0).length,
    people: people.size,
    unavailable: duties.reduce((sum, duty) => sum + duty.availabilityConflicts.length, 0),
  };
}

/**
 * Order-independent form of everything the server validates on publication and
 * the admin saw: identity and version of each duty, date, kind, interval,
 * members with role and source, and the neutral availability hints (these can
 * change without a new duty version).
 */
export function dutiesSignature(duties: readonly Duty[]): string {
  const canonical = duties
    .map((duty) => [
      duty.id.toLowerCase(),
      duty.version,
      duty.dutyDate,
      duty.shiftKind,
      duty.startsAt,
      duty.endsAt,
      duty.assignments
        .map((member) => [member.id.toLowerCase(), member.employeeId.toLowerCase(), member.dutyRole, member.source].join('|'))
        .sort(),
      duty.availabilityConflicts.map((conflict) => conflict.assignmentId.toLowerCase()).sort(),
    ] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return JSON.stringify(canonical);
}

/**
 * True when a failed publish request may still have published (or may still
 * publish): no or an unreadable response, a technical 5xx, rate limiting, or
 * the server still executing this key's claim (IDEMPOTENCY_REQUEST_IN_PROGRESS).
 * Anything that is not an API error is treated the same way: a rollback is
 * never inferred from a missing answer.
 */
export function publishOutcomeUnknown(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  if (error.kind !== 'http' || error.status === null) return true;
  return error.status >= 500 || error.status === 429 || error.code === 'IDEMPOTENCY_REQUEST_IN_PROGRESS';
}

/**
 * A definitive refusal after which plan, project and duties are re-read before
 * the next decision. Never true for an unknown outcome (e.g. the in-progress 409).
 */
export function publishNeedsReload(error: unknown): boolean {
  return !publishOutcomeUnknown(error) && error instanceof ApiError && (error.status === 404 || error.status === 409);
}

/** One key per confirmed decision; Phase 8.7 accepts 8-128 visible ASCII characters (a UUIDv4 qualifies). */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
