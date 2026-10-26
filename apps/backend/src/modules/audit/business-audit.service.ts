/**
 * Audit module public contract (recordBusinessAction).
 *
 * Mandatory business audit is written on the caller's transaction client, so
 * a failed audit insert rolls the business change back with it. Values must be
 * non-sensitive: never passwords, tokens, raw e-mail addresses or personal names.
 */
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';

type Queryable = Pick<PoolClient, 'query'>;

/** Action names chosen for SP-07..SP-09; no approved audit-action catalogue exists yet. */
export type BusinessAuditAction =
  | 'EMPLOYEE_CREATED'
  | 'EMPLOYEE_UPDATED'
  | 'EMPLOYEE_DEACTIVATED'
  | 'ACCOUNT_PROVISIONED'
  | 'ACCOUNT_DEACTIVATED'
  | 'ACCOUNT_ACTIVATION_DELIVERY_FAILED'
  | 'ACCOUNT_ACTIVATION_REISSUED'
  | 'PROJECT_CREATED'
  | 'PROJECT_UPDATED'
  | 'PROJECT_ASSIGNMENT_CREATED';

export type BusinessAuditEntry = {
  companyId: string;
  actorAccountId: string | null;
  action: BusinessAuditAction;
  resourceType: 'EMPLOYEE' | 'ACCOUNT' | 'PROJECT' | 'PROJECT_ASSIGNMENT';
  resourceId: string;
  oldValues?: Readonly<Record<string, unknown>> | null;
  newValues?: Readonly<Record<string, unknown>> | null;
  correlationId: string;
};

@Injectable()
export class BusinessAuditService {
  async recordBusinessAction(client: Queryable, entry: BusinessAuditEntry): Promise<void> {
    await client.query(
      `INSERT INTO audit_event (
         company_id, actor_account_id, action, resource_type, resource_id,
         old_values, new_values, correlation_id
       )
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)`,
      [
        entry.companyId,
        entry.actorAccountId,
        entry.action,
        entry.resourceType,
        entry.resourceId,
        entry.oldValues ? JSON.stringify(entry.oldValues) : null,
        entry.newValues ? JSON.stringify(entry.newValues) : null,
        entry.correlationId,
      ],
    );
  }
}
