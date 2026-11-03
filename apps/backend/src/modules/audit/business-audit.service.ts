/**
 * Audit module public contract (recordBusinessAction).
 *
 * Mandatory business audit is written on the caller's transaction client, so
 * a failed audit insert rolls the business change back with it. Values must be
 * bounded and minimized: never passwords, tokens, raw e-mail addresses or personal names.
 */
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { validCivilDate } from '../workforce/availability/availability.rules.js';

type Queryable = Pick<PoolClient, 'query'>;

/** Catalogue approvals are scoped: ADR-0004 and ADR-0005 do not ratify unrelated actions. */
export type BusinessAuditAction =
  /** SP-04 account activation (self-service; the actor is the activated account). */
  | 'ACCOUNT_ACTIVATED'
  | 'EMPLOYEE_CREATED'
  | 'EMPLOYEE_UPDATED'
  | 'EMPLOYEE_DEACTIVATED'
  | 'ACCOUNT_PROVISIONED'
  | 'ACCOUNT_DEACTIVATED'
  | 'ACCOUNT_ACTIVATION_DELIVERY_FAILED'
  /**
   * Development-only: written solely by scripts/reissue-employee-activation.mjs
   * (local recovery tool, NODE_ENV=development and local database only); no HTTP
   * route produces it.
   */
  | 'ACCOUNT_ACTIVATION_REISSUED'
  | 'PROJECT_CREATED'
  | 'PROJECT_UPDATED'
  | 'PROJECT_ASSIGNMENT_CREATED'
  /** PO D1 / ADR-0004: correction delta of an existing assignment; changed IDs/month and new scope only. */
  | 'PROJECT_ASSIGNMENT_CORRECTED'
  /**
   * PO D1 / ADR-0004 (D73-5, 29.10.2026): a FUTURE month assignment
   * was physically removed; old values hold the complete removed tuple (IDs and month).
   */
  | 'PROJECT_ASSIGNMENT_REMOVED'
  /** PO D1 / ADR-0004: shift set of one effective month replaced; resource = project. */
  | 'SHIFT_CONFIGURATION_UPDATED'
  /** PO P6, 2026-11-02: exact bounded calendar values, validated at this boundary. */
  | 'PROJECT_OPERATING_CALENDAR_UPDATED'
  /** SP-10 owner technical approval, 30.10.2026: date-only per-day values. */
  | 'EMPLOYEE_AVAILABILITY_SET'
  | 'EMPLOYEE_AVAILABILITY_CLEARED'
  /**
   * SP-11 owner ratification C2 (SP11A-R1 Rev3.1, 31.10.2026; ADR-0004 supplement):
   * exactly these three bounded creation events. The SP-12 approval below
   * extends membership addition to edits and adds mutation actions; publish is separate.
   */
  | 'MONTHLY_PLAN_CREATED'
  | 'DUTY_CREATED'
  | 'DUTY_MEMBERSHIP_ADDED'
  /** Owner approval 2026-11-02 / ADR-0004 SP-12 supplement; independent review separate. */
  | 'DUTY_UPDATED'
  | 'DUTY_REMOVED'
  | 'DUTY_MEMBERSHIP_UPDATED'
  | 'DUTY_MEMBERSHIP_REMOVED'
  /** SP-13 owner approval 2026-11-02: bounded first-publication transition only. */
  | 'MONTHLY_PLAN_PUBLISHED';

export type BusinessAuditEntry = {
  companyId: string;
  actorAccountId: string | null;
  action: BusinessAuditAction;
  resourceType:
    | 'EMPLOYEE' | 'ACCOUNT' | 'PROJECT' | 'PROJECT_ASSIGNMENT' | 'PROJECT_SHIFT_CONFIGURATION' | 'EMPLOYEE_AVAILABILITY'
    | 'MONTHLY_PLAN' | 'DUTY' | 'DUTY_ASSIGNMENT' | 'PROJECT_OPERATING_CALENDAR';
  resourceId: string;
  oldValues?: Readonly<Record<string, unknown>> | null;
  newValues?: Readonly<Record<string, unknown>> | null;
  correlationId: string;
};

@Injectable()
export class BusinessAuditService {
  async recordBusinessAction(client: Queryable, entry: BusinessAuditEntry): Promise<void> {
    if (entry.action === 'PROJECT_OPERATING_CALENDAR_UPDATED') {
      if (entry.resourceType !== 'PROJECT_OPERATING_CALENDAR' || entry.actorAccountId === null
        || entry.newValues == null || !calendarValues(entry.newValues, true)
        || (entry.oldValues != null && !calendarValues(entry.oldValues, false))) {
        throw new Error('Invalid bounded calendar audit');
      }
    }
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

function calendarValues(value: Readonly<Record<string, unknown>>, allowBootstrap: boolean): boolean {
  const keys = Object.keys(value).sort().join(',');
  const basic = 'effectiveFromMonth,operatingWeekdays,version';
  if (keys !== basic && !(allowBootstrap && keys === 'bootstrap,' + basic && value.bootstrap === true)) return false;
  const days = value.operatingWeekdays;
  return typeof value.effectiveFromMonth === 'string' && validCivilDate(value.effectiveFromMonth)
    && value.effectiveFromMonth.endsWith('-01') && Number.isSafeInteger(value.version) && Number(value.version) >= 1
    && Array.isArray(days) && days.length >= 1 && days.length <= 7
    && days.every((day: unknown, index: number) => Number.isInteger(day) && Number(day) >= 1 && Number(day) <= 7
      && (index === 0 || Number(days[index - 1]) < Number(day)));
}
