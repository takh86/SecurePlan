/**
 * Name of the violated UNIQUE constraint for a PostgreSQL 23505 error, else null.
 * Callers map known constraint names to catalogued 409 codes; the name itself
 * is never exposed to clients.
 */
export function uniqueViolationConstraint(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return code === '23505' && typeof constraint === 'string' ? constraint : null;
}
