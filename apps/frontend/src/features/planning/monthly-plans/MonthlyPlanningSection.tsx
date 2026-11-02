import { useMemo } from 'react';
import { Navigate, Route, Routes, useParams } from 'react-router';
import type { AppRoute } from '../../../app/routes';
import { useFocusHeadingOnSubpageChange } from '../../../app/use-focus-heading-on-subpage-change';
import { systemClock, type Clock } from '../../../shared/time/clock';
import type { SessionApi } from '../../auth/session-api';
import { createEmployeesApi } from '../../employees/employees-api';
import { createProjectAssignmentsApi } from '../../projects/project-assignments-api';
import { createProjectsApi } from '../../projects/projects-api';
import { createShiftConfigurationApi } from '../../projects/shift-configuration-api';
// Shared admin list/form/card styles (introduced with SP-07) and the SP-09 month bar.
import '../../employees/Employees.css';
import '../../projects/Projects.css';
import { deviceTimeZone } from './duty-time';
import { createMonthlyPlansApi } from './monthly-plans-api';
import { MonthlyPlanPage, type PlanPageApis, type PublishSlot } from './MonthlyPlanPage';
import { MonthlyPlansOverviewPage } from './MonthlyPlansOverviewPage';
import './MonthlyPlanning.css';

type SectionProps = {
  route: AppRoute;
  api: SessionApi;
  clock?: Clock;
  /** IANA zone used to display duty instants; defaults to the device's zone (see duty-time.ts). */
  timeZone?: string;
  /** SP-13 integration point for the Initial Publish action; none in this slice. */
  publishSlot?: PublishSlot;
};

/**
 * Admin area `/monatsplanung`: month overview of all projects with their plan
 * (`?month=YYYY-MM`) and the A10 plan page (`/:planId`): employee-by-day matrix
 * with a focus panel to create, edit and remove duties (SP-11/SP-12 API). No
 * publish action exists yet (SP-13, see `publishSlot`). Only real API data;
 * the server enforces COMPANY_ADMIN, tenant scope, leases and versions.
 */
export function MonthlyPlanningSection({ route, api, clock = systemClock, timeZone, publishSlot }: SectionProps) {
  const apis = useMemo<PlanPageApis>(
    () => ({
      plans: createMonthlyPlansApi(api),
      projects: createProjectsApi(api),
      employees: createEmployeesApi(api),
      assignments: createProjectAssignmentsApi(api),
      shiftConfigurations: createShiftConfigurationApi(api),
    }),
    [api],
  );
  const zone = useMemo(() => timeZone ?? deviceTimeZone(), [timeZone]);
  useFocusHeadingOnSubpageChange();
  return (
    <Routes>
      <Route index element={<MonthlyPlansOverviewPage route={route} apis={apis} clock={clock} />} />
      <Route path=":planId" element={<PlanRoute basePath={route.path} apis={apis} timeZone={zone} publishSlot={publishSlot} />} />
      <Route path="*" element={<Navigate to={route.path} replace />} />
    </Routes>
  );
}

type PlanRouteProps = { basePath: string; apis: PlanPageApis; timeZone: string; publishSlot?: PublishSlot };

function PlanRoute({ basePath, apis, timeZone, publishSlot }: PlanRouteProps) {
  const { planId = '' } = useParams();
  // A new id is a new page: no state (and no edit lease) carries over from the previous plan.
  return <MonthlyPlanPage key={planId} planId={planId} basePath={basePath} apis={apis} timeZone={timeZone} publishSlot={publishSlot} />;
}
