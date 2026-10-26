import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router';
import { PageFrame } from '../../app/PageFrame';
import type { ReadSource } from '../../shared/data/data-source';
import { useReadSource } from '../../shared/data/use-read-source';
import type { Clock } from '../../shared/time/clock';
import { addMonths, currentMonth, formatMonthLabel, parseMonth, type MonthKey } from '../../shared/time/month';
import { ApiErrorAlert } from '../../shared/ui/ApiErrorAlert';
import { StatusBadge } from '../../shared/ui/StatusBadge';
import { ErrorState, LoadingState } from '../../shared/ui/ViewStates';
import { ProjectAssignmentsPanel, type AssignmentApis } from './ProjectAssignmentsPanel';
import type { ProjectNotice } from './ProjectCreatePage';
import { ProjectNameForm } from './ProjectNameForm';
import { PROJECT_STATUS, type Project } from './project-types';
import type { ProjectsApi } from './projects-api';

type DetailProps = {
  projectId: string;
  /** Optional YYYY-MM route segment; absent means the clock's current month. */
  monthParam: string | undefined;
  basePath: string;
  apis: AssignmentApis;
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
        {/* Always mounted, so screen readers announce new messages. */}
        <div role="status" aria-live="polite">
          {notice && <p ref={noticeRef} tabIndex={-1} className="employees__notice">{notice}</p>}
        </div>
        {project ? (
          <>
            <MasterDataSection project={project} projects={projects} onChanged={changed} />
            <LifecycleSection project={project} projects={projects} onChanged={changed} />
            <AssignmentSection
              project={project}
              month={requestedMonth}
              monthPath={(month) => `${basePath}/${encodeURIComponent(project.id)}/${month}`}
              apis={apis}
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

type AssignmentSectionProps = {
  project: Project;
  month: MonthKey;
  monthPath: (month: MonthKey) => string;
  apis: AssignmentApis;
};

/** UX A09: the month bar stays mounted across month steps, so keyboard focus stays on the link. */
function AssignmentSection({ project, month, monthPath, apis }: AssignmentSectionProps) {
  const monthLabel = formatMonthLabel(month);
  const previous = addMonths(month, -1);
  const next = addMonths(month, 1);
  return (
    <section className="employees-card" aria-labelledby="project-assignments-title">
      <h2 id="project-assignments-title">Mitarbeiterzuordnung</h2>
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
      <ProjectAssignmentsPanel key={month} project={project} month={month} apis={apis} />
    </section>
  );
}
