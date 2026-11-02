import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { APP_ROUTES } from '../../../app/routes';
import { ApiError } from '../../../shared/api/api-error';
import type { ReadSource } from '../../../shared/data/data-source';
import { useReadSource } from '../../../shared/data/use-read-source';
import { SHIFT_TYPE_LABELS } from '../../../shared/shift/shift-view';
import { dateInMonth, daysInMonth, formatDate, formatMonthLabel, type MonthKey } from '../../../shared/time/month';
import { ApiErrorAlert } from '../../../shared/ui/ApiErrorAlert';
import { ErrorState, LoadingState } from '../../../shared/ui/ViewStates';
import { civilDate } from '../../employees/availability-api';
import { fullName, type Employee } from '../../employees/employee-types';
import type { EditState } from '../../projects/edit-state';
import type { ProjectAssignment, ProjectAssignmentsApi } from '../../projects/project-assignments-api';
import type { Project } from '../../projects/project-types';
import { SHIFT_KINDS, type ShiftConfiguration, type ShiftConfigurationApi, type ShiftKind } from '../../projects/shift-configuration-api';
import { endsNextDay } from '../../projects/shift-configuration-form';
import { INELIGIBILITY_TEXT, dutyCandidates } from './duty-eligibility';
import { DUTY_ROLES, DUTY_ROLE_LABELS, type Duty, type DutyRole, type MonthlyPlan } from './monthly-plan-types';
import type { MonthlyPlansApi } from './monthly-plans-api';
import { outcomeUnknown, planningErrorText } from './planning-errors';

const PROJECTS_PATH = APP_ROUTES.find((route) => route.id === 'projects')!.path;

type FormApis = { plans: MonthlyPlansApi; assignments: ProjectAssignmentsApi; shiftConfigurations: ShiftConfigurationApi };

/** What the form needs besides the page data: this month's project assignments and shift times. */
type FormContext = { assignments: ProjectAssignment[]; configuration: ShiftConfiguration };

type FormProps = {
  plan: MonthlyPlan;
  project: Project;
  employees: Employee[];
  /** Duties known on the page (null while they load); used to catch an occupied slot before sending. */
  existingDuties: Duty[] | null;
  apis: FormApis;
  onCreated: (duty: Duty) => void;
  onReloadDuties: () => void;
  onEditStateChange: (state: EditState) => void;
};

type FieldErrors = { date?: string; kind?: string };

function monthOf(plan: MonthlyPlan): MonthKey {
  return plan.monthStart.slice(0, 7);
}

/**
 * New duty for one date and shift kind with its initial members (the roster
 * may be empty: there is no staffing minimum). Only employees the static rules
 * allow are offered; the server re-validates everything and decides absence
 * and overlaps. Nothing is retried automatically.
 */
export function DutyCreateForm(props: FormProps) {
  const { plan, project, apis } = props;
  const month = monthOf(plan);
  const source = useMemo<ReadSource<string, FormContext>>(
    () => ({
      kind: 'api',
      load: async (_planId, signal) => {
        const [assignments, configuration] = await Promise.all([
          apis.assignments.listMonth(month, signal),
          apis.shiftConfigurations.get(project.id, month, signal),
        ]);
        return { assignments, configuration };
      },
    }),
    [apis, month, project.id],
  );
  const { state, retry } = useReadSource(source, plan.id);
  if (state.status === 'loading') return <LoadingState label="Zuordnungen und Schichtzeiten werden geladen …" />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={retry} />;
  return <DutyForm {...props} month={month} context={state.data} />;
}

function DutyForm({
  plan, project, employees, existingDuties, apis, onCreated, onReloadDuties, onEditStateChange, month, context,
}: FormProps & { month: MonthKey; context: FormContext }) {
  const id = useId();
  const [date, setDate] = useState('');
  const [kind, setKind] = useState<ShiftKind | null>(null);
  // Selected employees (lower-case id) with their duty role.
  const [selected, setSelected] = useState<Record<string, DutyRole>>({});
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<Error | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const dateInput = useRef<HTMLInputElement>(null);
  const kindFieldset = useRef<HTMLFieldSetElement>(null);
  const [focusRequest, setFocusRequest] = useState<{ field: keyof FieldErrors } | null>(null);

  const first = dateInMonth(month, 1)!;
  const last = dateInMonth(month, daysInMonth(month))!;
  const monthLabel = formatMonthLabel(month);
  const validDate = civilDate(date) && date >= first && date <= last;
  const candidates = useMemo(
    () => (validDate && kind ? dutyCandidates(employees, context.assignments, project.id, plan.monthStart, date, kind) : null),
    [validDate, kind, employees, context.assignments, project.id, plan.monthStart, date],
  );
  const chosen = candidates ? candidates.eligible.filter((employee) => selected[employee.id.toLowerCase()] !== undefined) : [];
  const assignedCount = useMemo(
    () => context.assignments.filter((item) => item.projectId.toLowerCase() === project.id.toLowerCase()).length,
    [context.assignments, project.id],
  );

  const editState: EditState = submitting ? 'saving' : date !== '' || kind !== null || Object.keys(selected).length > 0 ? 'dirty' : 'clean';
  useEffect(() => {
    onEditStateChange(editState);
  }, [editState, onEditStateChange]);
  // Leaving the page (or this form unmounting) leaves nothing pending behind.
  useEffect(() => () => onEditStateChange('clean'), [onEditStateChange]);

  useEffect(() => {
    if (!focusRequest) return;
    if (focusRequest.field === 'date') dateInput.current?.focus();
    else kindFieldset.current?.querySelector<HTMLInputElement>('input')?.focus();
  }, [focusRequest]);

  function validate(): FieldErrors {
    const next: FieldErrors = {};
    if (date === '') next.date = 'Bitte wählen Sie ein Datum.';
    else if (!civilDate(date)) next.date = 'Bitte geben Sie ein gültiges Datum ein.';
    else if (date < first || date > last) next.date = `Das Datum muss im ${monthLabel} liegen.`;
    if (kind === null) next.kind = 'Bitte wählen Sie Tagdienst oder Nachtdienst.';
    if (!next.date && kind && existingDuties?.some((duty) => duty.dutyDate === date && duty.shiftKind === kind)) {
      next.date = `Am ${formatDate(date)} gibt es in diesem Plan bereits einen ${SHIFT_TYPE_LABELS[kind]}.`;
    }
    return next;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    setFormError(null);
    const found = validate();
    setErrors(found);
    if (found.date || found.kind) {
      setFocusRequest({ field: found.date ? 'date' : 'kind' });
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    try {
      const duty = await apis.plans.createDuty(plan.id, {
        dutyDate: date,
        shiftKind: kind!,
        assignments: chosen.map((employee) => ({ employeeId: employee.id, dutyRole: selected[employee.id.toLowerCase()] })),
      });
      setDate('');
      setKind(null);
      setSelected({});
      setErrors({});
      onCreated(duty);
    } catch (cause) {
      // Inputs stay as entered; nothing is retried automatically.
      setFormError(cause instanceof Error ? cause : new Error('Create failed'));
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  function toggle(employee: Employee, checked: boolean) {
    const key = employee.id.toLowerCase();
    setSelected((current) => {
      const next = { ...current };
      if (checked) next[key] = current[key] ?? 'EMPLOYEE';
      else delete next[key];
      return next;
    });
  }

  function setRole(employee: Employee, role: DutyRole) {
    setSelected((current) => ({ ...current, [employee.id.toLowerCase()]: role }));
  }

  const errorCode = formError instanceof ApiError ? formError.code : null;
  const offerReload = outcomeUnknown(formError) || errorCode === 'DUTY_ALREADY_EXISTS';
  const projectMonthPath = `${PROJECTS_PATH}/${encodeURIComponent(project.id)}/${month}`;

  return (
    <form className="employee-form planning-duty-form" noValidate aria-busy={submitting} onSubmit={(event) => { void submit(event); }}>
      <ShiftTimesInfo configuration={context.configuration} monthLabel={monthLabel} projectMonthPath={projectMonthPath} />

      <div className="employee-form__field">
        <label htmlFor={`${id}-date`}>Datum</label>
        <p id={`${id}-date-hint`} className="employee-form__hint">Ein Tag im {monthLabel}.</p>
        <input
          ref={dateInput}
          id={`${id}-date`}
          type="date"
          min={first}
          max={last}
          required
          value={date}
          disabled={submitting}
          aria-invalid={errors.date ? true : undefined}
          aria-describedby={errors.date ? `${id}-date-hint ${id}-date-error` : `${id}-date-hint`}
          onChange={(event) => {
            setDate(event.target.value);
            setErrors((current) => ({ ...current, date: undefined }));
          }}
        />
        {errors.date && <p id={`${id}-date-error`} className="employee-form__error">{errors.date}</p>}
      </div>

      <fieldset
        ref={kindFieldset}
        className="employee-form__choices"
        disabled={submitting}
        aria-describedby={errors.kind ? `${id}-kind-error` : undefined}
      >
        <legend>Dienstart</legend>
        {SHIFT_KINDS.map((option) => (
          <label key={option}>
            <input
              type="radio"
              name={`${id}-kind`}
              value={option}
              checked={kind === option}
              onChange={() => {
                setKind(option);
                setErrors((current) => ({ ...current, kind: undefined }));
              }}
            />
            {SHIFT_TYPE_LABELS[option]}
          </label>
        ))}
        {errors.kind && <p id={`${id}-kind-error`} className="employee-form__error">{errors.kind}</p>}
      </fieldset>

      <fieldset className="planning-roster" disabled={submitting}>
        <legend>Besetzung (optional)</legend>
        {assignedCount === 0 ? (
          <p className="employee-form__hint">
            Diesem Projekt ist im {monthLabel} noch niemand zugeordnet.{' '}
            <Link to={projectMonthPath}>Mitarbeitende im Projekt zuordnen</Link>. Sie können den Dienst auch ohne
            Besetzung anlegen.
          </p>
        ) : candidates === null ? (
          <p className="employee-form__hint">Wählen Sie zuerst Datum und Dienstart; dann werden die passenden Personen angezeigt.</p>
        ) : (
          <>
            <p className="employee-form__hint">
              Angeboten werden Personen, die im {monthLabel} diesem Projekt zugeordnet, am Diensttag beschäftigt und für
              die Dienstart freigegeben sind. Abwesenheiten und Überschneidungen prüft SecurePlan beim Speichern.
            </p>
            {candidates.eligible.length === 0 ? (
              <p>Für diesen Dienst ist keine der zugeordneten Personen auswählbar.</p>
            ) : (
              <ul className="planning-roster__list" aria-label="Auswählbare Personen">
                {candidates.eligible.map((employee) => {
                  const key = employee.id.toLowerCase();
                  const checked = selected[key] !== undefined;
                  const name = fullName(employee);
                  return (
                    <li key={employee.id} className="planning-roster__item">
                      <label className="planning-roster__person">
                        <input type="checkbox" checked={checked} onChange={(event) => toggle(employee, event.target.checked)} />
                        {name} <span className="planning-roster__code">({employee.employeeCode})</span>
                      </label>
                      <select
                        className="assignments__select planning-roster__role"
                        aria-label={`Funktion im Dienst für ${name}`}
                        disabled={!checked}
                        value={selected[key] ?? 'EMPLOYEE'}
                        onChange={(event) => setRole(employee, event.target.value as DutyRole)}
                      >
                        {DUTY_ROLES.map((role) => <option key={role} value={role}>{DUTY_ROLE_LABELS[role]}</option>)}
                      </select>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="employees__count" aria-live="polite">
              {chosen.length === 0 ? 'Niemand ausgewählt' : chosen.length === 1 ? '1 Person ausgewählt' : `${chosen.length} Personen ausgewählt`}
            </p>
            {candidates.ineligible.length > 0 && (
              <details className="planning-roster__excluded">
                <summary>
                  {candidates.ineligible.length === 1
                    ? '1 weitere zugeordnete Person ist nicht auswählbar'
                    : `${candidates.ineligible.length} weitere zugeordnete Personen sind nicht auswählbar`}
                </summary>
                <ul>
                  {candidates.ineligible.map(({ employee, reason }) => (
                    <li key={employee.id}>{fullName(employee)}: {INELIGIBILITY_TEXT[reason]}</li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </fieldset>

      <ApiErrorAlert error={formError} text={planningErrorText(formError, 'create-duty')} />
      {errorCode === 'SHIFT_CONFIGURATION_MISSING' && (
        <p><Link to={projectMonthPath}>Schichtzeiten im Projekt festlegen</Link></p>
      )}
      <div className="employee-form__actions">
        <button type="submit" className="employees-button employees-button--primary" disabled={submitting} aria-busy={submitting}>
          {submitting ? 'Dienst wird angelegt …' : 'Dienst anlegen'}
        </button>
        {offerReload && (
          <button type="button" className="employees-button" disabled={submitting} onClick={() => { setFormError(null); onReloadDuties(); }}>
            Dienste neu laden
          </button>
        )}
      </div>
    </form>
  );
}

/**
 * The project's shift times effective for the plan month (company local time).
 * Information only: the server resolves the duty interval from the version it
 * finds at creation; a kind missing from the effective version is not inherited.
 */
function ShiftTimesInfo({ configuration, monthLabel, projectMonthPath }: { configuration: ShiftConfiguration; monthLabel: string; projectMonthPath: string }) {
  const missing = SHIFT_KINDS.filter((option) => !configuration.shifts.some((rule) => rule.shiftKind === option));
  return (
    <div className="planning-shift-times">
      <p className="employee-form__hint">Schichtzeiten des Projekts im {monthLabel} (Ortszeit Ihres Unternehmens):</p>
      <ul>
        {configuration.shifts.map((rule) => (
          <li key={rule.shiftKind}>
            {SHIFT_TYPE_LABELS[rule.shiftKind]}: {rule.startLocal} – {rule.endLocal}{endsNextDay(rule) && ' (Folgetag)'}
          </li>
        ))}
        {missing.map((option) => (
          <li key={option}>{SHIFT_TYPE_LABELS[option]}: keine Schichtzeit hinterlegt</li>
        ))}
      </ul>
      {missing.length > 0 && (
        <p className="employee-form__hint">
          Ohne Schichtzeit kann kein {missing.map((option) => SHIFT_TYPE_LABELS[option]).join(' und kein ')} angelegt
          werden. <Link to={projectMonthPath}>Schichtzeiten im Projekt festlegen</Link>
        </p>
      )}
    </div>
  );
}
