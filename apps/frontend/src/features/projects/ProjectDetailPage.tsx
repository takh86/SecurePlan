import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { PageFrame } from '../../app/PageFrame';
import type { ReadSource } from '../../shared/data/data-source';
import { useReadSource } from '../../shared/data/use-read-source';
import { ApiErrorAlert } from '../../shared/ui/ApiErrorAlert';
import { StatusBadge } from '../../shared/ui/StatusBadge';
import { ErrorState, LoadingState } from '../../shared/ui/ViewStates';
import type { ProjectNotice } from './ProjectCreatePage';
import { ProjectNameForm } from './ProjectNameForm';
import { PROJECT_STATUS, type Project } from './project-types';
import type { ProjectsApi } from './projects-api';

type DetailProps = { projectId: string; basePath: string; projects: ProjectsApi };

function noticeFromLocation(state: unknown): ProjectNotice | null {
  return typeof state === 'object' && state !== null && (state as { notice?: unknown }).notice === 'created'
    ? 'created'
    : null;
}

export function ProjectDetailPage({ projectId, basePath, projects }: DetailProps) {
  const location = useLocation();
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
