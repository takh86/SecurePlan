import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useBlocker, useLocation, type BlockerFunction } from 'react-router';
import { PageFrame } from '../../app/PageFrame';
import { isSessionRedirectNavigation } from '../../app/session-redirect';
import type { ReadSource } from '../../shared/data/data-source';
import { useReadSource } from '../../shared/data/use-read-source';
import type { Clock } from '../../shared/time/clock';
import { addMonths, currentMonth, formatMonthLabel, parseMonth, type MonthKey } from '../../shared/time/month';
import { ApiErrorAlert } from '../../shared/ui/ApiErrorAlert';
import { StatusBadge } from '../../shared/ui/StatusBadge';
import { ErrorState, LoadingState } from '../../shared/ui/ViewStates';
import type { EditState } from './edit-state';
import { ProjectAssignmentsPanel, type AssignmentApis } from './ProjectAssignmentsPanel';
import type { ProjectNotice } from './ProjectCreatePage';
import { ProjectNameForm } from './ProjectNameForm';
import { PROJECT_STATUS, type Project } from './project-types';
import type { ProjectsApi } from './projects-api';
import type { ShiftConfigurationApi } from './shift-configuration-api';
import { ShiftConfigurationSection, type ShiftEditState } from './ShiftConfigurationSection';

export type ProjectDetailApis = AssignmentApis & { shiftConfigurations: ShiftConfigurationApi };

type DetailProps = {
  projectId: string;
  /** Optional YYYY-MM route segment; absent means the clock's current month. */
  monthParam: string | undefined;
  basePath: string;
  apis: ProjectDetailApis;
  clock: Clock;
};

function noticeFromLocation(state: unknown): ProjectNotice | null {
  return typeof state === 'object' && state !== null && (state as { notice?: unknown }).notice === 'created'
    ? 'created'
    : null;
}

export function ProjectDetailPage({ projectId, monthParam, basePath, apis, clock }: DetailProps) {
  const location = useLocation();
  const { projects } = apis;
  const requestedMonth = monthParam === undefined ? currentMonth(clock) : parseMonth(monthParam);
  const source = useMemo<ReadSource<string, Project>>(
    () => ({ kind: 'api', load: (id, signal) => projects.get(id, signal) }),
    [projects],
  );
  const { state, retry } = useReadSource(source, projectId);
  // Results of writes replace the loaded record without a re-fetch.
  const [updated, setUpdated] = useState<Project | null>(null);
  const [notice, setNotice] = useState<string | null>(() =>
    noticeFromLocation(location.state) === 'created' ? 'Projekt wurde angelegt.' : null,
  );
  const project = updated ?? (state.status === 'ready' ? state.data : null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const [focusNotice, setFocusNotice] = useState<object | null>(null);
  const [shiftEdit, setShiftEdit] = useState<ShiftEditState>('clean');
  const [assignmentEdit, setAssignmentEdit] = useState<EditState>('clean');

  /**
   * The page's only navigation blocker (a data router supports one at a time).
   * Any SPA navigation away from the current URL (links, sidebar, Back/Forward,
   * programmatic, REPLACE included) waits for a decision while shift times or
   * an assignment correction are unsaved or a save is unconfirmed. Only the
   * session boundary's marked REPLACE to `/` after sign-out or session loss
   * passes (UX exception, not an authorization mechanism).
   */
  const shouldBlock = useCallback<BlockerFunction>(
    ({ currentLocation, nextLocation, historyAction }) =>
      (shiftEdit !== 'clean' || assignmentEdit !== 'clean') &&
      !isSessionRedirectNavigation(historyAction, nextLocation) &&
      (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search),
    [shiftEdit, assignmentEdit],
  );
  const blocker = useBlocker(shouldBlock);

  // After a write the acting control may be gone: move focus to the confirmation message.
  useEffect(() => {
    if (focusNotice) noticeRef.current?.focus();
  }, [focusNotice]);

  // An invalid month in the URL falls back to the current month of this project.
  if (requestedMonth === null) return <Navigate to={`${basePath}/${encodeURIComponent(projectId)}`} replace />;

  function changed(next: Project, message: string) {
    setUpdated(next);
    setNotice(message);
    setFocusNotice({});
  }

  return (
    <PageFrame title={project ? project.name : 'Projektdetails'}>
      <div className="employees employees--narrow">
        <Link className="employees__back" to={basePath}>Zurück zur Übersicht</Link>
        {blocker.state === 'blocked' && (
          <UnsavedChangesPrompt
            monthLabel={formatMonthLabel(requestedMonth)}
            edits={{ shifts: shiftEdit, assignment: assignmentEdit }}
            onLeave={() => blocker.proceed()}
            onStay={() => blocker.reset()}
          />
        )}
        {/* Always mounted, so screen readers announce new messages. */}
        <div role="status" aria-live="polite">
          {notice && <p ref={noticeRef} tabIndex={-1} className="employees__notice">{notice}</p>}
        </div>
        {project ? (
          <>
            <MasterDataSection project={project} projects={projects} onChanged={changed} />
            <LifecycleSection project={project} projects={projects} onChanged={changed} />
            <MonthSection
              month={requestedMonth}
              monthPath={(month) => `${basePath}/${encodeURIComponent(project.id)}/${month}`}
            />
            <ShiftConfigurationSection
              key={requestedMonth}
              project={project}
              month={requestedMonth}
              api={apis.shiftConfigurations}
              clock={clock}
              onEditStateChange={setShiftEdit}
            />
            <AssignmentSection
              project={project}
              month={requestedMonth}
              apis={apis}
              clock={clock}
              onEditStateChange={setAssignmentEdit}
            />
          </>
        ) : state.status === 'error' ? (
          <ErrorState
            error={state.error}
            onRetry={() => {
              setUpdated(null);
              retry();
            }}
          />
        ) : (
          <LoadingState label="Projektdaten werden geladen …" />
        )}
      </div>
    </PageFrame>
  );
}

type SectionProps = {
  project: Project;
  projects: ProjectsApi;
  onChanged: (project: Project, message: string) => void;
};

function MasterDataSection({ project, projects, onChanged }: SectionProps) {
  const [editing, setEditing] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const section = useRef<HTMLElement>(null);
  const returnFocusToEdit = useRef(false);
  const status = PROJECT_STATUS[project.status];

  useEffect(() => {
    if (editing) {
      // The edit button unmounts: continue in the name field instead of <body>.
      section.current?.querySelector<HTMLElement>('input')?.focus();
    } else if (returnFocusToEdit.current) {
      returnFocusToEdit.current = false;
      editButton.current?.focus();
    }
  }, [editing]);

  async function rename(name: string) {
    if (name === project.name) {
      setEditing(false);
      onChanged(project, 'Es gab keine Änderungen zu speichern.');
      return;
    }
    const saved = await projects.update(project.id, { name });
    setEditing(false);
    onChanged(saved, 'Der Projektname wurde gespeichert.');
  }

  return (
    <section ref={section} className="employees-card" aria-labelledby="project-data-title">
      <h2 id="project-data-title">Stammdaten</h2>
      {editing ? (
        <ProjectNameForm
          initialName={project.name}
          submitLabel="Namen speichern"
          pendingLabel="Wird gespeichert …"
          onSubmit={rename}
          cancel={
            <button
              type="button"
              className="employees-button"
              onClick={() => {
                returnFocusToEdit.current = true;
                setEditing(false);
              }}
            >
              Abbrechen
            </button>
          }
        />
      ) : (
        <>
          <dl className="employees-card__facts">
            <div><dt>Projektname</dt><dd>{project.name}</dd></div>
            <div><dt>Status</dt><dd><StatusBadge tone={status.tone}>{status.label}</StatusBadge></dd></div>
          </dl>
          <button ref={editButton} type="button" className="employees-button" onClick={() => setEditing(true)}>
            Namen bearbeiten
          </button>
        </>
      )}
    </section>
  );
}

/** ACTIVE <-> INACTIVE (API v1). Setting INACTIVE is confirmed first; nothing is deleted. */
function LifecycleSection({ project, projects, onChanged }: SectionProps) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelHeading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const returnFocus = useRef(false);

  useEffect(() => {
    if (confirming) panelHeading.current?.focus();
    else if (returnFocus.current) {
      returnFocus.current = false;
      trigger.current?.focus();
    }
  }, [confirming]);

  async function setStatus(status: Project['status']) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const saved = await projects.update(project.id, { status });
      setConfirming(false);
      onChanged(saved, status === 'INACTIVE' ? 'Das Projekt ist jetzt inaktiv.' : 'Das Projekt ist wieder aktiv.');
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error('Status change failed'));
    } finally {
      setPending(false);
    }
  }

  function cancel() {
    returnFocus.current = true;
    setError(null);
    setConfirming(false);
  }

  return (
    <section className="employees-card" aria-labelledby={titleId}>
      <h2 id={titleId}>Projektstatus</h2>
      {project.status === 'INACTIVE' ? (
        <>
          <p>Das Projekt ist inaktiv. Neue Monatszuordnungen sind nicht möglich; bestehende Daten bleiben erhalten.</p>
          <ApiErrorAlert error={error} />
          <button
            type="button"
            className="employees-button"
            disabled={pending}
            aria-busy={pending}
            onClick={() => { void setStatus('ACTIVE'); }}
          >
            {pending ? 'Wird gespeichert …' : 'Projekt reaktivieren'}
          </button>
        </>
      ) : !confirming ? (
        <button ref={trigger} type="button" className="employees-button" onClick={() => setConfirming(true)}>
          Projekt auf inaktiv setzen …
        </button>
      ) : (
        <div className="employees-confirm" role="group" aria-labelledby={`${titleId}-confirm`}>
          <h3 id={`${titleId}-confirm`} ref={panelHeading} tabIndex={-1}>
            {project.name} wirklich auf inaktiv setzen?
          </h3>
          <ul>
            <li>Für dieses Projekt sind danach keine neuen Monatszuordnungen möglich.</li>
            <li>Bestehende Zuordnungen und die Historie bleiben unverändert erhalten.</li>
            <li>Das Projekt kann jederzeit reaktiviert werden.</li>
          </ul>
          <ApiErrorAlert error={error} />
          <div className="employee-form__actions">
            <button
              type="button"
              className="employees-button employees-button--primary"
              disabled={pending}
              aria-busy={pending}
              onClick={() => { void setStatus('INACTIVE'); }}
            >
              {pending ? 'Wird gespeichert …' : 'Auf inaktiv setzen'}
            </button>
            <button type="button" className="employees-button" disabled={pending} onClick={cancel}>
              Abbrechen
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

type MonthSectionProps = {
  month: MonthKey;
  monthPath: (month: MonthKey) => string;
};

/**
 * UX A09 month navigation, shared by "Schichtzeiten" and "Mitarbeiterzuordnung".
 * The month bar stays mounted across month steps, so keyboard focus stays on the link.
 */
function MonthSection({ month, monthPath }: MonthSectionProps) {
  const monthLabel = formatMonthLabel(month);
  const previous = addMonths(month, -1);
  const next = addMonths(month, 1);
  return (
    <section className="employees-card" aria-labelledby="project-month-title">
      <h2 id="project-month-title">Monat</h2>
      <p className="employees-card__hint">Schichtzeiten und Mitarbeiterzuordnung gelten für den gewählten Monat.</p>
      <div className="assignments__monthbar">
        <h3 aria-live="polite">{monthLabel}</h3>
        <Link
          className="assignments__step assignments__step--previous"
          to={monthPath(previous)}
          aria-label={`Vorheriger Monat: ${formatMonthLabel(previous)}`}
        >
          <span aria-hidden="true">‹</span>Vorheriger Monat
        </Link>
        <Link
          className="assignments__step assignments__step--next"
          to={monthPath(next)}
          aria-label={`Nächster Monat: ${formatMonthLabel(next)}`}
        >
          Nächster Monat<span aria-hidden="true">›</span>
        </Link>
      </div>
    </section>
  );
}

/** Edit states of the two forms on this page that can hold unsaved input. */
type PendingEdits = { shifts: ShiftEditState; assignment: EditState };

type UnsavedChangesPromptProps = {
  monthLabel: string;
  edits: PendingEdits;
  onLeave: () => void;
  onStay: () => void;
};

const SAVING_TEXT: Record<keyof PendingEdits, (monthLabel: string) => string> = {
  shifts: (monthLabel) => `Die Schichtzeiten ab ${monthLabel} werden gerade gespeichert.`,
  assignment: (monthLabel) => `Die Korrektur einer Zuordnung im ${monthLabel} wird gerade gespeichert.`,
};
const DIRTY_TEXT: Record<keyof PendingEdits, (monthLabel: string) => string> = {
  shifts: (monthLabel) => `Die Änderungen an den Schichtzeiten ab ${monthLabel} sind noch nicht gespeichert.`,
  assignment: (monthLabel) => `Die Korrektur einer Zuordnung im ${monthLabel} ist noch nicht gespeichert.`,
};
const CHECK_AFTERWARDS: Record<keyof PendingEdits, string> = { shifts: 'die Schichtzeiten', assignment: 'die Zuordnungen' };

/** `involved`: the forms that held changes while the prompt was open. */
function promptText(edits: PendingEdits, involved: (keyof PendingEdits)[], monthLabel: string) {
  const saving = involved.filter((area) => edits[area] === 'saving');
  const dirty = involved.filter((area) => edits[area] === 'dirty');
  if (saving.length > 0) {
    // A running save is neither safely discarded nor cancelled by leaving.
    return {
      title: 'Speichern läuft noch',
      text: [
        ...saving.map((area) => SAVING_TEXT[area](monthLabel)),
        `Ein Wechsel bricht das Speichern nicht ab: Die Änderung kann trotzdem gespeichert werden oder fehlschlagen, Sie sehen das Ergebnis aber nicht. Prüfen Sie ${saving.map((area) => CHECK_AFTERWARDS[area]).join(' und ')} danach.`,
        ...dirty.map((area) => DIRTY_TEXT[area](monthLabel)),
        ...(dirty.length > 0 ? ['Ungespeicherte Änderungen werden beim Wechsel verworfen.'] : []),
      ].join(' '),
      leave: 'Trotzdem wechseln',
      stay: 'Hier bleiben',
    };
  }
  if (dirty.length > 0) {
    return {
      title: dirty.length > 1
        ? 'Ungespeicherte Änderungen'
        : dirty[0] === 'shifts' ? 'Ungespeicherte Schichtzeiten' : 'Ungespeicherte Zuordnungskorrektur',
      text: [...dirty.map((area) => DIRTY_TEXT[area](monthLabel)), 'Wenn Sie die Ansicht wechseln, werden sie verworfen.'].join(' '),
      leave: 'Änderungen verwerfen und wechseln',
      stay: 'Weiter bearbeiten',
    };
  }
  return {
    title: involved.length > 1
      ? 'Keine ungespeicherten Änderungen mehr'
      : involved[0] === 'assignment' ? 'Keine ungespeicherte Zuordnungskorrektur mehr' : 'Keine ungespeicherten Schichtzeiten mehr',
    text: 'Es gibt keine ungespeicherten Änderungen mehr. Sie können die Ansicht jetzt wechseln.',
    leave: 'Jetzt wechseln',
    stay: 'Hier bleiben',
  };
}

/** First control of the form that still holds changes, for "stay" when the trigger is gone. */
const FORM_FOCUS: Record<keyof PendingEdits, string> = {
  shifts: '.shift-config__form input',
  assignment: '.assignment-correction select',
};

/**
 * Inline confirmation (no browser dialog) for a navigation held back by the
 * blocker. Exactly one decision per held navigation: proceed() or reset().
 */
function UnsavedChangesPrompt({ monthLabel, edits, onLeave, onStay }: UnsavedChangesPromptProps) {
  const container = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const decided = useRef(false);
  const [deciding, setDeciding] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  // Remembered from the held navigation on: a save that completes meanwhile still names its form.
  const [heldWith] = useState(() => ({ shifts: edits.shifts !== 'clean', assignment: edits.assignment !== 'clean' }));
  const involved = (['shifts', 'assignment'] as const).filter((area) => heldWith[area] || edits[area] !== 'clean');
  const copy = promptText(edits, involved, monthLabel);

  useEffect(() => {
    // Remember the control that triggered the navigation (e.g. the month link).
    // Idempotent: StrictMode runs this twice, and the second run must not
    // capture the already focused prompt heading.
    const previous = document.activeElement;
    if (
      returnFocus.current === null &&
      previous instanceof HTMLElement &&
      previous !== document.body &&
      !container.current?.contains(previous)
    ) {
      returnFocus.current = previous;
    }
    heading.current?.focus();
  }, []);

  function decide(action: () => void, stay: boolean) {
    // Guards against double clicks in the same tick: one navigation at most.
    if (decided.current) return;
    decided.current = true;
    setDeciding(true);
    const target = returnFocus.current;
    if (target?.isConnected && (stay || !target.closest('form'))) {
      target.focus();
    } else if (stay) {
      const area = involved.find((candidate) => edits[candidate] !== 'clean') ?? involved[0];
      if (area) document.querySelector<HTMLElement>(FORM_FOCUS[area])?.focus();
    }
    action();
  }

  return (
    <div ref={container} className="employees-card employees-confirm" role="group" aria-labelledby={titleId}>
      <h2 id={titleId} ref={heading} tabIndex={-1}>{copy.title}</h2>
      <p>{copy.text}</p>
      <div className="employee-form__actions">
        <button
          type="button"
          className="employees-button employees-button--danger"
          disabled={deciding}
          onClick={() => decide(onLeave, false)}
        >
          {copy.leave}
        </button>
        <button type="button" className="employees-button" disabled={deciding} onClick={() => decide(onStay, true)}>
          {copy.stay}
        </button>
      </div>
    </div>
  );
}

type AssignmentSectionProps = {
  project: Project;
  month: MonthKey;
  apis: AssignmentApis;
  clock: Clock;
  onEditStateChange: (state: EditState) => void;
};

function AssignmentSection({ project, month, apis, clock, onEditStateChange }: AssignmentSectionProps) {
  return (
    <section className="employees-card" aria-labelledby="project-assignments-title">
      <h2 id="project-assignments-title">Mitarbeiterzuordnung</h2>
      <ProjectAssignmentsPanel
        key={month}
        project={project}
        month={month}
        apis={apis}
        clock={clock}
        onEditStateChange={onEditStateChange}
      />
    </section>
  );
}
