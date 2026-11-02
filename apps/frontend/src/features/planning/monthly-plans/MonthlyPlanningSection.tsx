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
import { MonthlyPlanPage, type PlanPageApis } from './MonthlyPlanPage';
import { MonthlyPlansOverviewPage } from './MonthlyPlansOverviewPage';
import './MonthlyPlanning.css';

type SectionProps = {
  route: AppRoute;
  api: SessionApi;
  clock?: Clock;
  /** IANA zone used to display duty instants; defaults to the device's zone (see duty-time.ts). */
  timeZone?: string;
};

/**
 * SP-11 PR-2 admin area `/monatsplanung`: month overview of all projects with
 * their plan (`?month=YYYY-MM`) and the plan page (`/:planId`) with its duties.
 * Create and read only (SP-11 PR-1 API); no publish, edit or removal exists.
 * Only real API data; the server enforces COMPANY_ADMIN and tenant scope.
 */
export function MonthlyPlanningSection({ route, api, clock = systemClock, timeZone }: SectionProps) {
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
      <Route path=":planId" element={<PlanRoute basePath={route.path} apis={apis} timeZone={zone} />} />
      <Route path="*" element={<Navigate to={route.path} replace />} />
    </Routes>
  );
}

function PlanRoute({ basePath, apis, timeZone }: { basePath: string; apis: PlanPageApis; timeZone: string }) {
  const { planId = '' } = useParams();
  // A new id is a new page: no state carries over from the previous plan.
  return <MonthlyPlanPage key={planId} planId={planId} basePath={basePath} apis={apis} timeZone={timeZone} />;
}
