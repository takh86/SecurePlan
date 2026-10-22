import { useEffect, useMemo, useRef } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigationType, useParams } from 'react-router';
import type { AppRoute } from '../../app/routes';
import type { SessionApi } from '../auth/session-api';
import { EmployeeCreatePage } from './EmployeeCreatePage';
import { EmployeeDetailPage } from './EmployeeDetailPage';
import { createEmployeesApi, type EmployeesApi } from './employees-api';
import { EmployeesListPage } from './EmployeesListPage';
import './Employees.css';

/**
 * SP-07 admin area `/mitarbeitende`: list, create (`/neu`) and detail (`/:id`).
 * Only real API data; the server enforces COMPANY_ADMIN and tenant scope.
 */
export function EmployeesSection({ route, api }: { route: AppRoute; api: SessionApi }) {
  const employees = useMemo(() => createEmployeesApi(api), [api]);
  useFocusHeadingOnSubpageChange();
  return (
    <Routes>
      <Route index element={<EmployeesListPage route={route} employees={employees} />} />
      <Route path="neu" element={<EmployeeCreatePage basePath={route.path} employees={employees} />} />
      <Route path=":employeeId" element={<DetailRoute basePath={route.path} employees={employees} />} />
      <Route path="*" element={<Navigate to={route.path} replace />} />
    </Routes>
  );
}

function DetailRoute({ basePath, employees }: { basePath: string; employees: EmployeesApi }) {
  const { employeeId = '' } = useParams();
  // A new id is a new page: no state carries over from the previous record.
  return <EmployeeDetailPage key={employeeId} employeeId={employeeId} basePath={basePath} employees={employees} />;
}

/** The shell moves focus only between areas; within this area the sub-page heading gets it. */
function useFocusHeadingOnSubpageChange() {
  const { pathname } = useLocation();
  const navigationType = useNavigationType();
  const previous = useRef<string | null>(null);
  useEffect(() => {
    const last = previous.current;
    previous.current = pathname;
    if (last === null || last === pathname || navigationType === 'REPLACE') return;
    document.getElementById('page-title')?.focus();
  }, [pathname, navigationType]);
}
