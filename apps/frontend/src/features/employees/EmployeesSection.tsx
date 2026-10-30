import { useMemo } from 'react';
import { Navigate, Route, Routes, useParams } from 'react-router';
import type { AppRoute } from '../../app/routes';
import { useFocusHeadingOnSubpageChange } from '../../app/use-focus-heading-on-subpage-change';
import type { SessionApi } from '../auth/session-api';
import { EmployeeCreatePage } from './EmployeeCreatePage';
import { EmployeeDetailPage } from './EmployeeDetailPage';
import { createEmployeesApi, type EmployeesApi } from './employees-api';
import { EmployeesListPage } from './EmployeesListPage';
import { createEmployeeFutureAssignmentsApi, type EmployeeFutureAssignmentsApi } from './employee-future-assignments-api';
import './Employees.css';
import { createAvailabilityApi, type AvailabilityApi } from './availability-api';

/**
 * SP-07 admin area `/mitarbeitende`: list, create (`/neu`) and detail (`/:id`).
 * Only real API data; the server enforces COMPANY_ADMIN and tenant scope.
 */
export function EmployeesSection({ route, api }: { route: AppRoute; api: SessionApi }) {
  const employees = useMemo(() => createEmployeesApi(api), [api]);
  const assignments = useMemo(() => createEmployeeFutureAssignmentsApi(api), [api]);
  const availability = useMemo(() => createAvailabilityApi(api), [api]);
  useFocusHeadingOnSubpageChange();
  return (
    <Routes>
      <Route index element={<EmployeesListPage route={route} employees={employees} />} />
      <Route path="neu" element={<EmployeeCreatePage basePath={route.path} employees={employees} />} />
      <Route path=":employeeId" element={<DetailRoute basePath={route.path} employees={employees} assignments={assignments} availability={availability} />} />
      <Route path="*" element={<Navigate to={route.path} replace />} />
    </Routes>
  );
}

function DetailRoute({ basePath, employees, assignments, availability }: { basePath: string; employees: EmployeesApi; assignments: EmployeeFutureAssignmentsApi; availability: AvailabilityApi }) {
  const { employeeId = '' } = useParams();
  // A new id is a new page: no state carries over from the previous record.
  return <EmployeeDetailPage key={employeeId} employeeId={employeeId} basePath={basePath} employees={employees} assignments={assignments} availability={availability} />;
}
