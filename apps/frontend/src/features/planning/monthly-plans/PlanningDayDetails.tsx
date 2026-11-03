import { SHIFT_TYPE_LABELS } from '../../../shared/shift/shift-view';
import type { DateOnly } from '../../../shared/time/month';
import { StatusBadge } from '../../../shared/ui/StatusBadge';
import { EMPLOYEE_STATUS, SHIFT_ELIGIBILITY_LABELS } from '../../employees/employee-types';
import type { ShiftKind } from '../../projects/shift-configuration-api';
import { dutyTimeView } from './duty-time';
import { DUTY_ROLE_LABELS, type Duty } from './monthly-plan-types';
import type { MatrixRow } from './planning-matrix';

type DayDetailsProps = {
  /** The person of the selected cell; null for the day's duty summary. */
  row: MatrixRow | null;
  date: DateOnly;
  day: Partial<Record<ShiftKind, Duty>>;
  monthLabel: string;
  projectActive: boolean;
  timeZone: string;
  nameOf: (employeeId: string) => string;
  onEdit: (duty: Duty) => void;
  onCreate: (kind: ShiftKind) => void;
  onClose: () => void;
};

const byName = new Intl.Collator('de-DE', { sensitivity: 'base' });

function peopleCount(count: number): string {
  return count === 0 ? 'noch keine Besetzung' : count === 1 ? '1 Person' : `${count} Personen`;
}

/**
 * Focus panel content for a matrix cell: the person's planning facts for that
 * day (if a person was selected) and the day's two duty slots with the next
 * possible action – edit an existing duty or create a missing one. Nothing is
 * changed here; every write happens in the duty editor or the create form.
 */
export function PlanningDayDetails({ row, date, day, monthLabel, projectActive, timeZone, nameOf, onEdit, onCreate, onClose }: DayDetailsProps) {
  const entries = row?.cells.get(date) ?? [];
  const unavailable = entries.some((entry) => entry.unavailable);
  return (
    <div className="planning-day">
      {row && (
        <>
          <dl className="employees-card__facts planning-day__facts">
            {row.employee && (
              <>
                <div><dt>Eignung</dt><dd>{SHIFT_ELIGIBILITY_LABELS[row.employee.shiftEligibility]}</dd></div>
                <div>
                  <dt>Status</dt>
                  <dd><StatusBadge tone={EMPLOYEE_STATUS[row.employee.status].tone}>{EMPLOYEE_STATUS[row.employee.status].label}</StatusBadge></dd>
                </div>
              </>
            )}
            <div>
              <dt>Projektzuordnung</dt>
              <dd>{row.assigned ? `Im ${monthLabel} zugeordnet` : `Im ${monthLabel} nicht zugeordnet`}</dd>
            </div>
            <div>
              <dt>An diesem Tag</dt>
              <dd>
                {entries.length === 0
                  ? 'frei'
                  : entries.map((entry) => `${SHIFT_TYPE_LABELS[entry.duty.shiftKind]}${entry.member.dutyRole === 'SHIFT_LEAD' ? ` (${DUTY_ROLE_LABELS.SHIFT_LEAD})` : ''}`).join(', ')}
              </dd>
            </div>
          </dl>
          {unavailable && (
            <p className="planning-day__hint">
              <StatusBadge tone="attention">Hinweis</StatusBadge> Am Diensttag nicht verfügbar. Bestehende Dienste werden
              dadurch nicht automatisch geändert.
            </p>
          )}
        </>
      )}
      <h4 className="planning-day__title">Dienste an diesem Tag</h4>
      <ul className="planning-day__slots">
        {(['DAY', 'NIGHT'] as const).map((kind) => {
          const duty = day[kind];
          const label = SHIFT_TYPE_LABELS[kind];
          if (!duty) {
            return (
              <li key={kind} className="planning-day__slot">
                <p><strong>{label}</strong>: nicht angelegt</p>
                {projectActive ? (
                  <button type="button" className="employees-button" onClick={() => onCreate(kind)}>{label} anlegen</button>
                ) : (
                  <p className="employee-form__hint">Für inaktive Projekte können keine Dienste angelegt werden.</p>
                )}
              </li>
            );
          }
          const conflicts = new Set(duty.availabilityConflicts.map((conflict) => conflict.assignmentId.toLowerCase()));
          // Display order by name; the API order (by membership id) carries no meaning.
          const members = [...duty.assignments].sort((a, b) => byName.compare(nameOf(a.employeeId), nameOf(b.employeeId)));
          return (
            <li key={kind} className="planning-day__slot">
              <p>
                <strong>{label}</strong> · {dutyTimeView(duty, timeZone).text} · {peopleCount(duty.assignments.length)}
              </p>
              {duty.assignments.length > 0 && (
                <ul className="planning-members">
                  {members.map((member) => (
                    <li key={member.id}>
                      {nameOf(member.employeeId)}
                      {member.dutyRole === 'SHIFT_LEAD' && <span className="planning-members__role"> · {DUTY_ROLE_LABELS.SHIFT_LEAD}</span>}
                      {member.source === 'REPLACEMENT' && <span className="planning-members__role"> · Ersatz</span>}
                      {conflicts.has(member.id.toLowerCase()) && <> <StatusBadge tone="attention">Nicht verfügbar</StatusBadge></>}
                    </li>
                  ))}
                </ul>
              )}
              <button type="button" className="employees-button" onClick={() => onEdit(duty)}>{label} bearbeiten</button>
            </li>
          );
        })}
      </ul>
      <div className="employee-form__actions">
        <button type="button" className="employees-button" onClick={onClose}>Schließen</button>
      </div>
    </div>
  );
}
