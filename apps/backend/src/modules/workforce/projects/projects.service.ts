/**
 * SP-08 Workforce & Projects: administrative project management (COMPANY_ADMIN only).
 *
 * Tenant rules (SP-06), as in EmployeesService:
 * - companyId/accountId/role come ONLY from the trusted TenantContext;
 * - every statement on `projects` is scoped by `company_id = tenant.companyId`;
 * - unknown and foreign IDs are indistinguishable (404 via requireRow);
 * - every write re-asserts the acting account under row locks first.
 *
 * API v1 exposes name + ACTIVE/INACTIVE only (owner decision 26.10.2026).
 * INACTIVE blocks new month assignments; history stays readable (Phase 8.4
 * D-8.4-12). Shift configuration is not part of this slice.
 */
import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../../database/database.service.js';
import { assertActorInTransaction } from '../../../auth/authorization/actor-in-transaction.js';
import { requireRow } from '../../../auth/authorization/require-row.js';
import type { TenantContext } from '../../../auth/authorization/tenant-context.js';
import { uniqueViolationConstraint } from '../../../common/database/unique-violation.js';
import { BusinessAuditService } from '../../audit/business-audit.service.js';
import type { CreateProjectDto, ListProjectsQueryDto, UpdateProjectDto } from './dto/project.dto.js';
import {
  PROJECT_COLUMNS,
  PROJECT_SORT_COLUMNS,
  projectStatusFromDb,
  toProjectResponse,
  type ProjectRow,
} from './project.mapper.js';
import type { ProjectPage, ProjectResponse } from './project.types.js';

const ADMIN_ONLY = ['COMPANY_ADMIN'] as const;
const DEFAULT_PAGE_SIZE = 25;
const PROJECT_NAME_CONSTRAINT = 'uq_projects__company_name';

function nameTaken(): never {
  throw new ConflictException({ code: 'PROJECT_NAME_ALREADY_EXISTS' });
}

/** Escapes LIKE metacharacters so `q` is matched literally (ESCAPE '\'). */
function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`;
}

@Injectable()
export class ProjectsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: BusinessAuditService,
  ) {}

  async list(tenant: TenantContext, query: ListProjectsQueryDto): Promise<ProjectPage> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const params: unknown[] = [tenant.companyId];
    const where = ['company_id = $1'];
    if (query.status !== undefined) {
      params.push(query.status);
      where.push(`status = $${params.length}`);
    }
    if (query.q !== undefined) {
      params.push(likeContains(query.q));
      where.push(`name ILIKE $${params.length} ESCAPE '\\'`);
    }
    const direction = query.sortOrder === 'desc' ? 'DESC' : 'ASC';
    const orderBy = [
      ...(query.sortBy !== undefined ? [`${PROJECT_SORT_COLUMNS[query.sortBy]} ${direction}`] : []),
      'name ASC',
      'id ASC',
    ].join(', ');
    const filter = where.join(' AND ');

    return this.database.withTransaction(async (client) => {
      // Count and page from ONE snapshot, so totals match the returned page.
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const counted = await client.query<{ total: number }>(
        `SELECT count(*)::int AS total FROM projects WHERE ${filter}`,
        params,
      );
      const rows = await client.query<ProjectRow>(
        `SELECT ${PROJECT_COLUMNS} FROM projects WHERE ${filter}
         ORDER BY ${orderBy}
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, pageSize, (page - 1) * pageSize],
      );
      const totalItems = counted.rows[0].total;
      return {
        items: rows.rows.map(toProjectResponse),
        pagination: { page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) },
      };
    });
  }

  async get(tenant: TenantContext, projectId: string): Promise<ProjectResponse> {
    return this.database.withTransaction(async (client) => {
      const row = requireRow(
        await client.query<ProjectRow>(
          `SELECT ${PROJECT_COLUMNS} FROM projects WHERE company_id = $1 AND id = $2`,
          [tenant.companyId, projectId],
        ),
      );
      return toProjectResponse(row);
    });
  }

  /** New projects start ACTIVE (UX 5.5). */
  async create(tenant: TenantContext, dto: CreateProjectDto, correlationId: string): Promise<ProjectResponse> {
    return this.database.withTransaction(async (client) => {
      await assertActorInTransaction(client, tenant, ADMIN_ONLY);
      // Deterministic 409 for the common case; the UNIQUE constraint remains
      // the authority for concurrent creates (mapped below).
      const taken = await client.query(
        'SELECT 1 FROM projects WHERE company_id = $1 AND name = $2',
        [tenant.companyId, dto.name],
      );
      if (taken.rowCount !== 0) nameTaken();

      let row: ProjectRow;
      try {
        const inserted = await client.query<ProjectRow>(
          `INSERT INTO projects (company_id, name) VALUES ($1, $2) RETURNING ${PROJECT_COLUMNS}`,
          [tenant.companyId, dto.name],
        );
        row = inserted.rows[0];
      } catch (error) {
        if (uniqueViolationConstraint(error) === PROJECT_NAME_CONSTRAINT) nameTaken();
        throw error;
      }

      await this.audit.recordBusinessAction(client, {
        companyId: tenant.companyId,
        actorAccountId: tenant.accountId,
        action: 'PROJECT_CREATED',
        resourceType: 'PROJECT',
        resourceId: row.id,
        newValues: { name: row.name, status: row.status },
        correlationId,
      });
      return toProjectResponse(row);
    });
  }

  /** Rename and/or ACTIVE <-> INACTIVE. ARCHIVED rows are read-only (not reachable via API v1). */
  async update(
    tenant: TenantContext,
    projectId: string,
    dto: UpdateProjectDto,
    correlationId: string,
  ): Promise<ProjectResponse> {
    if (dto.name === undefined && dto.status === undefined) {
      throw new BadRequestException({ code: 'EMPTY_PATCH' });
    }

    return this.database.withTransaction(async (client) => {
      await assertActorInTransaction(client, tenant, ADMIN_ONLY);
      // NO KEY UPDATE: conflicts with the FOR SHARE taken by concurrent
      // assignment writes (status re-check), but not with FK KEY SHARE locks.
      const current = requireRow(
        await client.query<ProjectRow>(
          `SELECT ${PROJECT_COLUMNS} FROM projects
           WHERE company_id = $1 AND id = $2
           FOR NO KEY UPDATE`,
          [tenant.companyId, projectId],
        ),
      );
      // ARCHIVED is not writable through API v1: a stored value fails closed (500).
      projectStatusFromDb(current.status);

      const nextName = dto.name ?? current.name;
      const nextStatus = dto.status ?? current.status;
      if (nextName === current.name && nextStatus === current.status) return toProjectResponse(current);

      if (nextName !== current.name) {
        const taken = await client.query(
          'SELECT 1 FROM projects WHERE company_id = $1 AND name = $2 AND id <> $3',
          [tenant.companyId, nextName, projectId],
        );
        if (taken.rowCount !== 0) nameTaken();
      }

      let updated: ProjectRow;
      try {
        updated = requireRow(
          await client.query<ProjectRow>(
            `UPDATE projects SET name = $3, status = $4, updated_at = clock_timestamp()
             WHERE company_id = $1 AND id = $2
             RETURNING ${PROJECT_COLUMNS}`,
            [tenant.companyId, projectId, nextName, nextStatus],
          ),
        );
      } catch (error) {
        if (uniqueViolationConstraint(error) === PROJECT_NAME_CONSTRAINT) nameTaken();
        throw error;
      }

      const oldValues: Record<string, unknown> = {};
      const newValues: Record<string, unknown> = {};
      if (updated.name !== current.name) {
        oldValues.name = current.name;
        newValues.name = updated.name;
      }
      if (updated.status !== current.status) {
        oldValues.status = current.status;
        newValues.status = updated.status;
      }
      await this.audit.recordBusinessAction(client, {
        companyId: tenant.companyId,
        actorAccountId: tenant.accountId,
        action: 'PROJECT_UPDATED',
        resourceType: 'PROJECT',
        resourceId: projectId,
        oldValues,
        newValues,
        correlationId,
      });
      return toProjectResponse(updated);
    });
  }
}
