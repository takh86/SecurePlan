/** One ordered policy drives both SQL discovery and final authoritative validation. */
export const replacementRules = [
  ['open', 'REPLACEMENT_NEED_NOT_OPEN'],
  ['not_self', 'REPLACEMENT_SELF_OFFER_NOT_ALLOWED'],
  ['candidate_active', 'REPLACEMENT_CANDIDATE_INELIGIBLE'],
  ['project_active', 'REPLACEMENT_CANDIDATE_INELIGIBLE'],
  ['published', 'REPLACEMENT_CANDIDATE_INELIGIBLE'],
  ['live', 'REPLACEMENT_CANDIDATE_INELIGIBLE'],
  ['before_start', 'REPLACEMENT_CANDIDATE_INELIGIBLE'],
  ['employed', 'REPLACEMENT_CANDIDATE_INELIGIBLE'],
  ['suitable', 'REPLACEMENT_CANDIDATE_INELIGIBLE'],
  ['linked', 'REPLACEMENT_CANDIDATE_INELIGIBLE'],
  ['available', 'REPLACEMENT_CANDIDATE_UNAVAILABLE'],
  ['unassigned', 'REPLACEMENT_CANDIDATE_UNAVAILABLE'],
  ['conflict_free', 'REPLACEMENT_CANDIDATE_UNAVAILABLE'],
] as const;
export type EligibilityFacts = Record<
  (typeof replacementRules)[number][0],
  boolean
>;
export const eligibleReplacementSql = replacementRules
  .map(([key]) => `${key} IS TRUE`)
  .join(' AND ');
export function replacementIneligibility(facts: EligibilityFacts) {
  return replacementRules.find(([key]) => facts[key] !== true)?.[1] ?? null;
}
