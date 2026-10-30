import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../../shared/api/api-error';
import { useReadSource } from '../../shared/data/use-read-source';
import { ApiErrorAlert } from '../../shared/ui/ApiErrorAlert';
import type { Employee } from './employee-types';
import { AVAILABILITY_LABELS, rangeCount, type AvailabilityApi, type AvailabilityCommit,
  type AvailabilityPreview, type AvailabilitySelection, type AvailabilityStatus, type PreviewDay } from './availability-api';
import './EmployeeAvailabilitySection.css';

const EFFECT: Record<PreviewDay['effect'], string> = { CREATE: 'Neu eintragen', UNCHANGED: 'Unverändert',
  CONFLICT: 'Abweichender Status', REPLACE: 'Ersetzen', CLEAR: 'Entfernen' };
const failure = (value: unknown) => value instanceof Error ? value : new Error('Availability request failed');
type Attempt = { body: AvailabilityCommit; key: string };

function AvailabilityMonthList({ api, employeeId, month, onRetry }: {
  api: AvailabilityApi; employeeId: string; month: string; onRetry?: () => void;
}) {
  const source = useMemo(() => ({ kind: 'api' as const,
    load: (start: string, signal: AbortSignal) => api.list(employeeId, start, signal) }), [api, employeeId]);
  const { state } = useReadSource(source, `${month}-01`);
  if (state.status === 'loading') return <p role="status">Verfügbarkeit wird geladen …</p>;
  if (state.status === 'error') return <ApiErrorAlert error={state.error} onRetry={onRetry} />;
  return state.data.length ? <ul aria-label="Gespeicherte Verfügbarkeit">{state.data.map((day) =>
    <li key={day.day}>{day.day}: {AVAILABILITY_LABELS[day.status]}</li>)}</ul> : <p>Keine Verfügbarkeitseinträge in diesem Monat.</p>;
}

export function EmployeeAvailabilitySection({ employee, api }: { employee: Employee; api: AvailabilityApi }) {
  const id = useId(); const [open, setOpen] = useState(false);
  // Initial browser month is only a navigation hint; all lifecycle rules use server company time.
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [from, setFrom] = useState(`${month}-01`); const [to, setTo] = useState(`${month}-01`);
  const [operation, setOperation] = useState<'SET' | 'CLEAR'>('SET'); const [status, setStatus] = useState<AvailabilityStatus>('SICK');
  const [reload, setReload] = useState(0);
  const [shown, setShown] = useState<AvailabilityPreview | null>(null); const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<'preview' | 'commit' | null>(null); const [error, setError] = useState<Error | null>(null);
  const [notice, setNotice] = useState<string | null>(null); const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [retryReady, setRetryReady] = useState(true);
  const previewHeading = useRef<HTMLHeadingElement>(null); const outcome = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null); const alive = useRef(true); const inFlight = useRef(false);
  const context = JSON.stringify([employee.status, employee.employmentStart, employee.employmentEnd]);
  const [lifecycle, setLifecycle] = useState(() => ({ value: context }));
  // Discard confirmation on every observed transition, including A -> B -> A.
  // Dates and unsaved employee master data remain available to the administrator.
  if (lifecycle.value !== context) { setLifecycle({ value: context }); setShown(null); setConfirmed(false); }
  const currentContext = useRef(lifecycle);
  useLayoutEffect(() => { currentContext.current = lifecycle; }, [lifecycle]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!shown) return;
    previewHeading.current?.focus();
    const timer = setTimeout(() => { setShown(null); setConfirmed(false); setNotice('Die Vorschau ist abgelaufen. Bitte erneut prüfen.'); },
      Math.max(0, Date.parse(shown.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [shown]);
  useEffect(() => { if (error || notice) outcome.current?.focus(); }, [error, notice]);
  function invalidate() { setShown(null); setConfirmed(false); setError(null); setNotice(null); }
  function selection(policy: 'REJECT' | 'REPLACE' = 'REJECT'): AvailabilitySelection {
    return operation === 'CLEAR' ? { operation, fromDate: from, toDate: to } :
      { operation, fromDate: from, toDate: to, status, conflictPolicy: policy };
  }
  async function preview(policy: 'REJECT' | 'REPLACE' = 'REJECT') {
    if (inFlight.current || attempt) return;
    const count = rangeCount(from, to);
    if (count < 1 || count > 93) { setError(new ApiError('http', 400, 'AVAILABILITY_RANGE_INVALID', null)); return; }
    inFlight.current = true; setBusy('preview'); invalidate(); const at = lifecycle;
    try {
      const next = await api.preview(employee.id, selection(policy));
      if (alive.current) {
        if (currentContext.current !== at) setError(new ApiError('http', 409, 'AVAILABILITY_PREVIEW_STALE', null));
        else setShown(next);
      }
    } catch (cause) { if (alive.current) setError(failure(cause)); }
    finally { inFlight.current = false; if (alive.current) setBusy(null); }
  }
  async function save(retry?: Attempt) {
    if (inFlight.current || (!retry && (!shown?.canCommit || (destructive && !confirmed)))) return;
    if (!retry && shown && Date.parse(shown.expiresAt) <= Date.now()) {
      invalidate(); setError(new ApiError('http', 409, 'AVAILABILITY_PREVIEW_STALE', null)); return;
    }
    const work = retry ?? { key: crypto.randomUUID(), body: { ...selection(shown?.operation === 'SET' ? shown.conflictPolicy : 'REJECT'),
      previewToken: shown!.previewToken, ...(destructive ? { confirmation: operation === 'CLEAR' ? 'CLEAR' as const : 'REPLACE' as const } : {}) } };
    inFlight.current = true; setBusy('commit'); setAttempt(work); setError(null); setNotice(null);
    try {
      const result = await api.commit(employee.id, work.body, work.key);
      if (alive.current) {
        setAttempt(null); setShown(null); setConfirmed(false); setReload((n) => n + 1);
        setNotice(`${result.changedDayCount} Tage geändert, ${result.unchangedDayCount} Tage unverändert. Bestehende Dienste wurden nicht geändert.`);
      }
    } catch (cause) {
      if (!alive.current) return;
      const caught = failure(cause); setError(caught);
      const uncertain = !(caught instanceof ApiError) || caught.kind !== 'http' || caught.status === 500 || caught.code === 'IDEMPOTENCY_REQUEST_IN_PROGRESS';
      if (!uncertain) { setAttempt(null); setShown(null); setConfirmed(false); }
      if (caught instanceof ApiError && caught.code === 'IDEMPOTENCY_REQUEST_IN_PROGRESS') {
        setRetryReady(false); setTimeout(() => { if (alive.current) setRetryReady(true); }, 1000);
      }
    } finally { inFlight.current = false; if (alive.current) setBusy(null); }
  }
  const destructive = shown?.operation === 'CLEAR' || (shown?.operation === 'SET' && shown.conflictPolicy === 'REPLACE');
  const locked = busy !== null || attempt !== null;
  return (
    <section className="employees-card availability" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Verfügbarkeit</h2>
      <p>Krankheit und bereits genehmigten Urlaub verwalten. Bestehende Dienste bleiben unverändert.</p>
      <button ref={trigger} type="button" className="employees-button" aria-expanded={open} aria-controls={`${id}-panel`}
        disabled={busy !== null} onClick={() => setOpen(!open)}>{open ? 'Verfügbarkeit ausblenden' : 'Verfügbarkeit anzeigen'}</button>
      {open && <div id={`${id}-panel`}>
        <label htmlFor={`${id}-month`}>Anzeigemonat</label>
        <input id={`${id}-month`} type="month" value={month} disabled={locked} onChange={(e) => { invalidate(); setMonth(e.target.value); }} />
        {/^[0-9]{4}-[0-9]{2}$/.test(month) && <AvailabilityMonthList key={reload} api={api} employeeId={employee.id} month={month}
          onRetry={locked ? undefined : () => { invalidate(); setReload((n) => n + 1); }} />}
        <form onSubmit={(event) => { event.preventDefault(); void preview(); }}>
          <fieldset disabled={locked}>
            <legend>Zeitraum bearbeiten</legend>
            <label htmlFor={`${id}-from`}>Von einschließlich</label>
            <input id={`${id}-from`} type="date" required value={from} onChange={(e) => { invalidate(); setFrom(e.target.value); }} />
            <label htmlFor={`${id}-to`}>Bis einschließlich</label>
            <input id={`${id}-to`} type="date" required value={to} onChange={(e) => { invalidate(); setTo(e.target.value); }} />
            <p>Höchstens 93 Kalendertage. Die Unternehmenszeitzone ist maßgeblich.</p>
            <label><input type="radio" name={`${id}-operation`} checked={operation === 'SET'} onChange={() => { invalidate(); setOperation('SET'); }} />Eintragen</label>
            <label><input type="radio" name={`${id}-operation`} checked={operation === 'CLEAR'} onChange={() => { invalidate(); setOperation('CLEAR'); }} />Einträge entfernen</label>
            {operation === 'SET' && <fieldset><legend>Status</legend>{(['SICK', 'LEAVE'] as const).map((value) =>
              <label key={value}><input type="radio" name={`${id}-status`} checked={status === value} onChange={() => { invalidate(); setStatus(value); }} />{AVAILABILITY_LABELS[value]}</label>)}</fieldset>}
            <button type="submit" className="employees-button">Vorschau erstellen</button>
          </fieldset>
        </form>
        <div ref={outcome} tabIndex={-1}>
          <ApiErrorAlert error={error} text={error instanceof ApiError && error.code === 'EMPLOYEE_INACTIVE' ?
            { title: 'Nur historische Korrektur möglich', description: 'Für deaktivierte Personen sind Einträge nur innerhalb dokumentierter Beschäftigung und vor dem heutigen Unternehmenstag zulässig.' } : undefined} />
          <div role="status" aria-live="polite">{notice && <p>{notice}</p>}{busy && <p>{busy === 'preview' ? 'Vorschau wird erstellt …' : 'Vorgang wird gespeichert …'}</p>}</div>
        </div>
        {shown && !attempt && <div className="availability__preview">
          <h3 ref={previewHeading} tabIndex={-1}>Vorschau: {shown.fromDate} bis {shown.toDate}</h3>
          <table><caption>Auswirkungen auf die ausgewählten Kalendertage</caption><thead><tr><th scope="col">Datum</th><th scope="col">Bisher</th><th scope="col">Aktion</th></tr></thead>
            <tbody>{shown.days.map((day) => <tr key={day.day}><th scope="row">{day.day}</th><td>{day.currentStatus ? AVAILABILITY_LABELS[day.currentStatus] : 'Kein Eintrag'}</td><td>{EFFECT[day.effect]}</td></tr>)}</tbody></table>
          {!shown.canCommit && <><p>Abweichende Einträge werden ohne ausdrückliche Bestätigung nicht ersetzt.</p>
            <button type="button" className="employees-button" disabled={busy !== null} onClick={() => void preview('REPLACE')}>Vorschau zum Ersetzen erstellen</button></>}
          {destructive && <label><input type="checkbox" checked={confirmed} disabled={busy !== null} onChange={(e) => setConfirmed(e.target.checked)} />
            {shown.operation === 'CLEAR' ? 'Ich bestätige das Entfernen der angezeigten Einträge.' : 'Ich bestätige das Ersetzen der abweichenden Einträge.'}</label>}
          {shown.canCommit && <button type="button" className="employees-button" disabled={busy !== null || (destructive && !confirmed)} onClick={() => void save()}>
            {shown.operation === 'CLEAR' ? 'Bestätigte Entfernung speichern' : destructive ? 'Bestätigte Ersetzung speichern' : 'Einträge speichern'}</button>}
          <button type="button" className="employees-button" disabled={busy !== null} onClick={() => { invalidate(); trigger.current?.focus(); }}>Vorschau verwerfen</button>
        </div>}
        {attempt && !busy && <div className="availability__recovery"><p>Der Ausgang ist noch unklar. Eine Wiederholung sendet denselben Vorgang und erzeugt keine doppelte Änderung.</p>
          <button type="button" className="employees-button" disabled={!retryReady} onClick={() => void save(attempt)}>Denselben Vorgang erneut prüfen</button>
          <button type="button" className="employees-button" onClick={() => { setAttempt(null); invalidate(); setReload((n) => n + 1); }}>Vorgang verlassen und aktuellen Stand laden</button></div>}
      </div>}
    </section>
  );
}
