import type { TestPool } from './synthetic-tenants.js';
import { createSyntheticAccount, createSyntheticProject, createSyntheticSession, createSyntheticTenant, realSessionService } from './synthetic-tenants.js';
import { createStaff, insertDuty, insertMembership, insertPlan, insertProjectAssignment, insertShiftConfiguration, STANDARD_SHIFTS } from './planning-fixtures.js';

export const MUTATION_MONTH = '2027-01-01';
export const MUTATION_DAY = '2027-01-20';
export const MUTATION_NOW = '2026-12-15T12:00:00Z';

export async function dutyMutationFixture(pool: TestPool, companies: string[]) {
  const tenant = await createSyntheticTenant(pool, 'SP12 mutations');
  companies.push(tenant.companyId);
  const foreign = await createSyntheticTenant(pool, 'SP12 foreign');
  companies.push(foreign.companyId);
  const sessions = realSessionService(pool);
  const second = await createSyntheticAccount(pool, tenant.companyId, 'COMPANY_ADMIN');
  const admin = await createSyntheticSession(sessions, tenant.admin);
  const admin2 = await createSyntheticSession(sessions, second);
  const employeeSession = await createSyntheticSession(sessions, tenant.employee);
  const foreignAdmin = await createSyntheticSession(sessions, foreign.admin);
  const project = await createSyntheticProject(pool, tenant.companyId, 'SP12 project');
  await insertShiftConfiguration(pool, tenant.companyId, project.projectId, MUTATION_MONTH, STANDARD_SHIFTS);
  const mira = await createStaff(pool, tenant.companyId);
  const jonas = await createStaff(pool, tenant.companyId);
  const assignment = await insertProjectAssignment(pool, tenant.companyId, mira.employeeId, project.projectId, MUTATION_MONTH);
  await insertProjectAssignment(pool, tenant.companyId, jonas.employeeId, project.projectId, MUTATION_MONTH);
  const planId = await insertPlan(pool, tenant.companyId, project.projectId, MUTATION_MONTH);
  const dutyId = await insertDuty(pool, {
    companyId: tenant.companyId, projectId: project.projectId, planId, month: MUTATION_MONTH,
    dutyDate: MUTATION_DAY, startsAt: `${MUTATION_DAY}T05:00:00Z`, endsAt: `${MUTATION_DAY}T17:00:00Z`,
  });
  const membership = await insertMembership(pool, tenant.companyId, dutyId, mira.employeeId);
  return { tenant, foreign, second, admin, admin2, employeeSession, foreignAdmin, project, mira, jonas, assignment, planId, dutyId, membership };
}
export type DutyMutationFixture = Awaited<ReturnType<typeof dutyMutationFixture>>;
export const dutyPath = (f: DutyMutationFixture, dutyId = f.dutyId, planId = f.planId) => `/api/v1/monthly-plans/${planId}/entries/${dutyId}`;
