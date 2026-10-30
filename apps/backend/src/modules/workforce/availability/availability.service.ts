import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { assertActorInTransaction } from '../../../auth/authorization/actor-in-transaction.js';
import { requireRow } from '../../../auth/authorization/require-row.js';
import type { TenantContext } from '../../../auth/authorization/tenant-context.js';
import { WALL_CLOCK, type WallClock } from '../../../common/time/wall-clock.js';
import { DatabaseService } from '../../../database/database.service.js';
import { BusinessAuditService } from '../../audit/business-audit.service.js';
import { assertConfirmation, assertEmployment, digest, normalizeSelection, previewDays, selectedDays, selectionDigest, validCivilDate } from './availability.rules.js';
import { AvailabilityOperation, AvailabilityStatus, type AvailabilityPreview, type AvailabilityResult, type Selection } from './availability.types.js';
import type { AvailabilityCommitDto } from './dto/availability.dto.js';

const ADMIN = ['COMPANY_ADMIN'] as const;
type Employee = { status: string; employment_start: string | null; employment_end: string | null; revision: string };
type Context = { time_zone: string; today: string | null };
type Command = { id: string; state: string; selection_hash: Buffer; context_hash: Buffer;
  expected_revision: string; commit_hash: Buffer | null; changed_day_count: number | null;
  unchanged_day_count: number | null; unexpired: boolean };
const stale = (): never => { throw new ConflictException({ code: 'AVAILABILITY_PREVIEW_STALE' }); };

@Injectable()
export class AvailabilityService {
  constructor(private readonly database: DatabaseService, private readonly audit: BusinessAuditService,
    @Inject(WALL_CLOCK) private readonly clock: WallClock) {}

  async list(tenant: TenantContext, employeeId: string, monthStart: string) {
    if (!validCivilDate(monthStart) || !monthStart.endsWith('-01')) {
      throw new BadRequestException({ code: 'INVALID_MONTH_START' });
    }
    return this.database.withTransaction(async (client) => {
      await assertActorInTransaction(client, tenant, ADMIN);
      await this.employee(client, tenant, employeeId);
      const result = await client.query<{ day: string; status: AvailabilityStatus }>(
        `SELECT to_char(day, 'YYYY-MM-DD') AS day, status FROM employee_availability_days
         WHERE company_id = $1 AND employee_id = $2 AND day >= $3::date
           AND day < ($3::date + INTERVAL '1 month') ORDER BY day`, [tenant.companyId, employeeId, monthStart]);
      return { items: result.rows.map((row) => ({ employeeId, ...row })) };
    });
  }

  async preview(tenant: TenantContext, employeeId: string, input: Selection): Promise<AvailabilityPreview> {
    const selection = normalizeSelection(input); const dates = selectedDays(selection);
    return this.database.withTransaction(async (client) => {
      await assertActorInTransaction(client, tenant, ADMIN);
      const employee = await this.employee(client, tenant, employeeId, 'SHARE');
      // New statements AFTER the parent lock: never share a pre-wait CTE snapshot.
      const context = await this.context(client, tenant);
      assertEmployment(selection, employee, context.today!);
      const current = await this.markers(client, tenant, employeeId, selection);
      const days = previewDays(selection, dates, current);
      const previewToken = randomBytes(32).toString('base64url');
      const { rows: [created] } = await client.query<{ expires_at: Date }>(
        `WITH moment AS (SELECT clock_timestamp() AS at)
         INSERT INTO availability_batch_commands
           (company_id, actor_account_id, employee_id, token_hash, selection_hash, context_hash,
            expected_revision, created_at, preview_expires_at, expires_at)
         SELECT $1, $2, $3, $4, $5, $6, $7::bigint, at, at + INTERVAL '10 minutes', at + INTERVAL '10 minutes'
         FROM moment RETURNING preview_expires_at AS expires_at`,
        [tenant.companyId, tenant.accountId, employeeId, digest(previewToken), selectionDigest(employeeId, selection),
          this.contextHash(employee, context), employee.revision]);
      await this.cleanup(client, tenant.companyId, 100);
      return { ...selection, employeeId, previewToken, expiresAt: created.expires_at.toISOString(),
        canCommit: !days.some((day) => day.effect === 'CONFLICT'), days };
    });
  }

  async commit(tenant: TenantContext, employeeId: string, input: AvailabilityCommitDto, key: string,
    correlationId: string): Promise<{ result: AvailabilityResult; replayed: boolean }> {
    const selection = normalizeSelection(input); const dates = selectedDays(selection);
    const keyHash = digest(key); const tokenHash = digest(input.previewToken);
    const selectionHash = selectionDigest(employeeId, selection);
    const commitHash = digest(JSON.stringify(['SP10-commit-v1', selectionHash.toString('hex'),
      tokenHash.toString('hex'), input.confirmation ?? null]));
    const lockId = digest(JSON.stringify(['SP10-key-v1', tenant.companyId, tenant.accountId,
      keyHash.toString('hex')])).readBigInt64BE().toString();
    return this.database.withTransaction(async (client) => {
      await assertActorInTransaction(client, tenant, ADMIN);
      await this.employee(client, tenant, employeeId); // concealment before retry lookup; no lock yet
      const { rows: [reservation] } = await client.query<{ held: boolean }>(
        'SELECT pg_try_advisory_xact_lock($1::bigint) AS held', [lockId]);
      if (!reservation.held) throw new ConflictException({ code: 'IDEMPOTENCY_REQUEST_IN_PROGRESS' });
      const prior = await client.query<Command>(
        `SELECT id, state, commit_hash, changed_day_count, unchanged_day_count,
                expires_at > clock_timestamp() AS unexpired
         FROM availability_batch_commands
         WHERE company_id = $1 AND actor_account_id = $2 AND key_hash = $3`,
        [tenant.companyId, tenant.accountId, keyHash]);
      if (prior.rowCount) {
        const row = prior.rows[0];
        if (!row.unexpired) stale();
        if (!row.commit_hash?.equals(commitHash)) {
          throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST' });
        }
        return { result: { employeeId, changedDayCount: row.changed_day_count!, unchangedDayCount: row.unchanged_day_count! }, replayed: true };
      }
      const employee = await this.employee(client, tenant, employeeId, 'NO KEY UPDATE');
      const saved = await client.query<Command>(
        `SELECT id, state, selection_hash, context_hash, expected_revision::text
         FROM availability_batch_commands
         WHERE company_id = $1 AND actor_account_id = $2 AND employee_id = $3 AND token_hash = $4 FOR UPDATE`,
        [tenant.companyId, tenant.accountId, employeeId, tokenHash]);
      if (saved.rowCount !== 1) stale();
      const preview = saved.rows[0];
      const { rows: [expiry] } = await client.query<{ fresh: boolean }>(
        `SELECT preview_expires_at > clock_timestamp() AS fresh FROM availability_batch_commands
         WHERE company_id = $1 AND id = $2`, [tenant.companyId, preview.id]);
      const context = await this.context(client, tenant);
      const current = await this.markers(client, tenant, employeeId, selection);
      if (preview.state !== 'PREVIEWED' || !expiry.fresh || !preview.selection_hash.equals(selectionHash) ||
          preview.expected_revision !== employee.revision || !preview.context_hash.equals(this.contextHash(employee, context))) stale();
      assertConfirmation(selection, input.confirmation);
      assertEmployment(selection, employee, context.today!);
      const days = previewDays(selection, dates, current);
      if (days.some((day) => day.effect === 'CONFLICT')) {
        throw new ConflictException({ code: 'AVAILABILITY_STATUS_CONFLICT' });
      }
      const changed = days.filter((day) => day.effect !== 'UNCHANGED');
      for (const day of changed) {
        if (selection.operation === AvailabilityOperation.CLEAR) {
          await client.query('DELETE FROM employee_availability_days WHERE company_id = $1 AND employee_id = $2 AND day = $3::date',
            [tenant.companyId, employeeId, day.day]);
        } else {
          await client.query(`INSERT INTO employee_availability_days (company_id, employee_id, day, status)
            VALUES ($1, $2, $3::date, $4) ON CONFLICT (company_id, employee_id, day)
            DO UPDATE SET status = EXCLUDED.status, updated_at = clock_timestamp()`,
          [tenant.companyId, employeeId, day.day, selection.status]);
        }
      }
      if (changed.length) {
        await client.query(`UPDATE employees SET availability_revision = availability_revision + 1
          WHERE company_id = $1 AND id = $2`, [tenant.companyId, employeeId]);
      }
      for (const day of changed) {
        await this.audit.recordBusinessAction(client, { companyId: tenant.companyId, actorAccountId: tenant.accountId,
          action: selection.operation === AvailabilityOperation.CLEAR ? 'EMPLOYEE_AVAILABILITY_CLEARED' : 'EMPLOYEE_AVAILABILITY_SET',
          resourceType: 'EMPLOYEE_AVAILABILITY', resourceId: employeeId,
          oldValues: day.currentStatus === null ? null : { day: day.day },
          newValues: selection.operation === AvailabilityOperation.CLEAR ? null : { day: day.day }, correlationId });
      }
      const result = { employeeId, changedDayCount: changed.length, unchangedDayCount: days.length - changed.length };
      await client.query(`WITH moment AS (SELECT clock_timestamp() AS at)
        UPDATE availability_batch_commands SET state = 'COMPLETED', key_hash = $3, commit_hash = $4,
        changed_day_count = $5, unchanged_day_count = $6, completed_at = moment.at,
        expires_at = moment.at + INTERVAL '24 hours' FROM moment WHERE company_id = $1 AND id = $2`,
      [tenant.companyId, preview.id, keyHash, commitHash, result.changedDayCount, result.unchangedDayCount]);
      await this.cleanup(client, tenant.companyId, 100);
      return { result, replayed: false };
    });
  }

  /** Absence only, not full eligibility. Caller owns transaction and any workflow locks. */
  async getDailyAvailability(client: PoolClient, tenant: TenantContext, employeeId: string, day: string): Promise<'AVAILABLE' | 'NOT_AVAILABLE'> {
    if (!validCivilDate(day)) throw new BadRequestException({ code: 'INVALID_DATE' });
    await this.employee(client, tenant, employeeId);
    const found = await client.query('SELECT 1 FROM employee_availability_days WHERE company_id = $1 AND employee_id = $2 AND day = $3::date',
      [tenant.companyId, employeeId, day]);
    return found.rowCount === 0 ? 'AVAILABLE' : 'NOT_AVAILABLE';
  }

  /** Explicit bounded maintenance application entry point; no new HTTP route. */
  async pruneExpired(tenant: TenantContext, limit = 100): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    return this.database.withTransaction(async (client) => {
      await assertActorInTransaction(client, tenant, ADMIN);
      return this.cleanup(client, tenant.companyId, limit);
    });
  }

  private async cleanup(client: PoolClient, companyId: string, limit: number): Promise<number> {
    const result = await client.query(`WITH expired AS (
      SELECT id FROM availability_batch_commands WHERE company_id = $1 AND expires_at <= clock_timestamp()
      ORDER BY expires_at, id LIMIT $2 FOR UPDATE SKIP LOCKED)
      DELETE FROM availability_batch_commands AS command USING expired
      WHERE command.company_id = $1 AND command.id = expired.id`, [companyId, limit]);
    return result.rowCount ?? 0;
  }
  private async employee(client: PoolClient, tenant: TenantContext, id: string, lock?: 'SHARE' | 'NO KEY UPDATE'): Promise<Employee> {
    // Lock mode is an internal literal union, never request input.
    return requireRow(await client.query<Employee>(`SELECT status,
      to_char(employment_start, 'YYYY-MM-DD') AS employment_start,
      to_char(employment_end, 'YYYY-MM-DD') AS employment_end, availability_revision::text AS revision
      FROM employees WHERE company_id = $1 AND id = $2 ${lock ? `FOR ${lock}` : ''}`, [tenant.companyId, id]));
  }
  private async context(client: PoolClient, tenant: TenantContext): Promise<Context> {
    const context = requireRow(await client.query<Context>(`SELECT time_zone,
      CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names tz WHERE tz.name = c.time_zone)
      THEN to_char($2::timestamptz AT TIME ZONE c.time_zone, 'YYYY-MM-DD') ELSE NULL END AS today
      FROM companies c WHERE id = $1`, [tenant.companyId, this.clock().toISOString()]));
    if (context.today === null) throw new Error('Invalid company time zone');
    return context;
  }
  private contextHash(employee: Employee, context: Context): Buffer {
    return digest(JSON.stringify(['SP10-context-v1', employee.status, employee.employment_start,
      employee.employment_end, context.time_zone, context.today]));
  }
  private async markers(client: PoolClient, tenant: TenantContext, employeeId: string, input: Selection) {
    const result = await client.query<{ day: string; status: AvailabilityStatus }>(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, status FROM employee_availability_days
       WHERE company_id = $1 AND employee_id = $2 AND day BETWEEN $3::date AND $4::date ORDER BY day`,
      [tenant.companyId, employeeId, input.fromDate, input.toDate]);
    return new Map(result.rows.map((row) => [row.day, row.status]));
  }
}
