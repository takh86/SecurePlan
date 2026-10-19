import { NotFoundException } from '@nestjs/common';
import type { QueryResult, QueryResultRow } from 'pg';

/**
 * Tenant-/owner-scoped lookups return zero rows for both unknown and foreign
 * resources. Both must surface as the same 404 RESOURCE_NOT_FOUND so that
 * existence in another tenant or of another owner is never disclosed.
 *
 * More than one row means the query is not a unique, correctly scoped lookup.
 * That is a server defect, not a missing resource: it fails closed as a plain
 * Error (500 INTERNAL_ERROR via ProblemDetailsFilter, no details exposed).
 */
export function requireRow<T extends QueryResultRow>(result: QueryResult<T>): T {
  if (result.rowCount === 0) {
    throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
  }
  if (result.rowCount !== 1) {
    throw new Error('requireRow: scoped lookup returned more than one row');
  }
  return result.rows[0];
}
