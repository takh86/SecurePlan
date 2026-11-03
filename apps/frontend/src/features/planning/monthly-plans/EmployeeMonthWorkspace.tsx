import { useCallback, useMemo, useState } from 'react';
import type { ReadSource } from '../../../shared/data/data-source';
import { useReadSource } from '../../../shared/data/use-read-source';
import type { MonthKey } from '../../../shared/time/month';
import { ErrorState, LoadingState } from '../../../shared/ui/ViewStates';
import type { EditState } from '../../projects/edit-state';
import type { Project } from '../../projects/project-types';
import { EmployeeMonthPlanner } from './EmployeeMonthPlanner';
import type { EmployeeMonthApi, EmployeeMonthRead } from './employee-month-api';
import { calendarOfRead, monthBase, monthBaseFromRead, othersFromDuties, type SlotBase } from './employee-month-draft';
import type { Duty, MonthlyPlan } from './monthly-plan-types';
import type { MatrixRow } from './planning-matrix';

type CommonProps = {
  plan: MonthlyPlan;
  project: Project;
  month: MonthKey;
  person: MatrixRow;
  /** The page's duty read: the preview's base, and context (other members) for the A2 workflow. */
  duties: readonly Duty[];
  nameOf: (employeeId: string) => string;
  /** Re-reads the page's duties. */
  onReloadDuties: () => void;
  dutiesReloading: boolean;
  onEditStateChange: (state: EditState) => void;
};

/**
 * #88 preview: the planner on the page's duty read, without a save. The base
 * is memoised, so only a new duty read moves the draft.
 */
export function EmployeeMonthPreview({ plan, project, month, person, duties, nameOf, onReloadDuties, dutiesReloading, onEditStateChange }: CommonProps) {
  const base = useMemo(() => monthBase(duties, person.employeeId, month), [duties, person.employeeId, month]);
  return (
    <EmployeeMonthPlanner
      plan={plan}
      project={project}
      month={month}
      person={person}
      base={base}
      nameOf={nameOf}
      onReload={onReloadDuties}
      reloading={dutiesReloading}
      onEditStateChange={onEditStateChange}
    />
  );
}

/**
 * #88 A2 workflow (contract A2-GATE-1): loads the consistent employee-month
 * read and plans on it; "Monat speichern" sends the one atomic command. A
 * re-read keeps the planner and the draft on screen; only the first read
 * shows the loading or error state.
 */
export function EmployeeMonthWorkspace({ api, ...props }: CommonProps & { api: EmployeeMonthApi }) {
  const { plan, person, duties, onReloadDuties } = props;
  const source = useMemo<ReadSource<string, EmployeeMonthRead>>(
    () => ({ kind: 'api', load: (_key, signal) => api.read(plan.id, person.employeeId, signal) }),
    [api, plan.id, person.employeeId],
  );
  const { state, retry } = useReadSource(source, `${plan.id}|${person.employeeId}`.toLowerCase());
  const loaded = state.status === 'ready' ? state.data : null;
  const [shown, setShown] = useState<EmployeeMonthRead | null>(null);
  // A new read replaces the shown one during render ("adjust state on change").
  if (loaded !== null && shown !== loaded) setShown(loaded);
  const read = loaded ?? shown;
  const base = useMemo(() => (read ? monthBaseFromRead(read) : null), [read]);
  const calendar = useMemo(() => (read ? calendarOfRead(read) : null), [read]);
  const othersOf = useCallback((slot: SlotBase) => othersFromDuties(duties, slot, person.employeeId), [duties, person.employeeId]);

  if (base === null || calendar === null) {
    return state.status === 'error'
      ? <ErrorState error={state.error} onRetry={retry} />
      : <LoadingState label="Monat der Person wird geladen …" />;
  }
  return (
    <>
      {state.status === 'loading' && <LoadingState label="Aktueller Stand wird geladen …" />}
      {state.status === 'error' && <ErrorState error={state.error} onRetry={retry} />}
      <EmployeeMonthPlanner
        plan={props.plan}
        project={props.project}
        month={props.month}
        person={person}
        base={base}
        calendar={calendar}
        othersOf={othersOf}
        nameOf={props.nameOf}
        api={api}
        onReload={() => {
          retry();
          onReloadDuties();
        }}
        reloading={state.status === 'loading'}
        reloadFailed={state.status === 'error'}
        onEditStateChange={props.onEditStateChange}
      />
    </>
  );
}
