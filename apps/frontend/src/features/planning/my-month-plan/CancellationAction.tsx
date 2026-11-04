import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { SessionApi } from '../../auth/session-api';
import type { IdentityContext } from '../../auth/auth-api';
import { ApiError } from '../../../shared/api/api-error';
import { planDateLabel, zonedDutyTime } from '../../../shared/time/civil-time';
import type { MyDuty } from './my-month-plan-types';
import {
  parseCancellation,
  type CancellationResponse,
} from './cancellation-api';
type Attempt = { duty: MyDuty; project: string; key: string };
type State =
  | { kind: 'confirm' }
  | { kind: 'sending' }
  | { kind: 'uncertain' }
  | { kind: 'error'; message: string }
  | { kind: 'success'; result: CancellationResponse };
type Props = {
  api: SessionApi;
  identity: IdentityContext;
  duty: MyDuty;
  project: string;
  onStale: () => void;
  revalidate: () => void;
};
const cancellationLabels = {
  OPEN: 'Offen',
  WITHDRAWN: 'Zurückgezogen',
  REJECTED: 'Abgelehnt',
  APPROVED: 'Genehmigt',
  OBSOLETE: 'Gegenstandslos',
};
const needLabels = {
  OPEN: 'Offen',
  OPEN_UNFILLED: 'Unbesetzt',
  RESOLVED: 'Besetzt',
  CLOSED: 'Geschlossen',
};
/** A new API capability or identity gets a fresh private command boundary. */
export function CancellationAction(props: Props) {
  const [boundary, setBoundary] = useState({
    api: props.api,
    identity: props.identity,
    generation: 0,
  });
  if (boundary.api !== props.api || boundary.identity !== props.identity) {
    setBoundary({
      api: props.api,
      identity: props.identity,
      generation: boundary.generation + 1,
    });
  }
  return <BoundCancellationAction key={boundary.generation} {...props} />;
}
function BoundCancellationAction({
  api,
  duty,
  project,
  onStale,
  revalidate,
}: Props) {
  const [attempt, setAttempt] = useState<Attempt | null>(null),
    [state, setState] = useState<State>({ kind: 'confirm' });
  const dialog = useRef<HTMLDialogElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const active = useRef(false),
    busy = useRef(false),
    controller = useRef<AbortController | null>(null),
    deadline = useRef<ReturnType<typeof setTimeout> | null>(null);
  const title = useId(),
    description = useId();
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      controller.current?.abort();
      if (deadline.current !== null) clearTimeout(deadline.current);
    };
  }, []);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!attempt || !element) return;
    if (!element.open) element.showModal();
    if (!element.contains(document.activeElement)) {
      const target = element.querySelector<HTMLButtonElement>(
        'button:not(:disabled)',
      );
      (target ?? element).focus();
    }
  }, [attempt, state.kind]);
  const unresolved = state.kind === 'sending' || state.kind === 'uncertain';
  function close() {
    if (unresolved) return;
    dialog.current?.close();
    setAttempt(null);
    trigger.current?.focus();
  }
  async function submit() {
    if (
      !attempt ||
      busy.current ||
      !active.current ||
      !['confirm', 'uncertain'].includes(state.kind)
    )
      return;
    // This fence precedes every await and React render, including keyboard activation.
    busy.current = true;
    setState({ kind: 'sending' });
    const current = new AbortController();
    controller.current = current;
    const valid = () =>
      active.current &&
      !current.signal.aborted &&
      controller.current === current;
    const timeout = setTimeout(() => {
      if (!valid()) return;
      current.abort();
      busy.current = false;
      setState({ kind: 'uncertain' });
    }, 30_000);
    deadline.current = timeout;
    try {
      const value = await api.request<unknown>(
        '/api/v1/cancellation-requests',
        {
          method: 'POST',
          body: { assignmentId: attempt.duty.assignmentId },
          expectedVersion: attempt.duty.version,
          idempotencyKey: attempt.key,
          signal: current.signal,
        },
      );
      if (!valid()) return;
      const result = parseCancellation(
        value,
        attempt.duty.assignmentId,
        attempt.duty.dutyId,
      );
      setState({ kind: 'success', result });
    } catch (error) {
      if (!valid()) return;
      if (
        error instanceof ApiError &&
        (error.status === 401 || error.status === 403)
      ) {
        dialog.current?.close();
        setAttempt(null);
        revalidate();
        return;
      }
      if (
        error instanceof ApiError &&
        [
          'PLAN_CONCURRENT_MODIFICATION',
          'CANCELLATION_ASSIGNMENT_NOT_ACTIVE',
          'CANCELLATION_PLAN_CHANGED',
        ].includes(error.code ?? '')
      ) {
        dialog.current?.close();
        setAttempt(null);
        onStale();
        return;
      }
      if (
        !(error instanceof ApiError) ||
        error.status === null ||
        (error.status ?? 0) >= 500 ||
        error.kind === 'invalid-response' ||
        error.code === 'IDEMPOTENCY_REQUEST_IN_PROGRESS'
      ) {
        setState({ kind: 'uncertain' });
        return;
      }
      setState({
        kind: 'error',
        message:
          error.code === 'CANCELLATION_ALREADY_EXISTS'
            ? 'Für diesen Dienst liegt bereits eine offene Absage vor.'
            : 'Die Absage konnte nicht eingereicht werden. Bitte aktualisieren Sie den Monatsplan und prüfen Sie den Dienst erneut.',
      });
    } finally {
      clearTimeout(timeout);
      if (valid()) busy.current = false;
    }
  }
  return (
    <>
      <button
        ref={trigger}
        className="cancellation-action__trigger"
        type="button"
        disabled={state.kind === 'success'}
        onClick={() => {
          if (busy.current) return;
          setState({ kind: 'confirm' });
          setAttempt({ duty: { ...duty }, project, key: crypto.randomUUID() });
        }}
      >
        {state.kind === 'success' ? 'Absage eingereicht' : 'Dienst absagen'}
      </button>
      {state.kind === 'success' && !attempt && (
        <p role="status">
          Absage: {cancellationLabels[state.result.status]}. Ersatzbedarf:{' '}
          {needLabels[state.result.replacementNeed.status]}.
        </p>
      )}
      <dialog
        className="cancellation-dialog"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return;
          const buttons = [
            ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
              'button:not(:disabled)',
            ),
          ];
          const first = buttons[0],
            last = buttons.at(-1);
          if (!first) {
            event.preventDefault();
            event.currentTarget.focus();
            return;
          }
          if (
            event.shiftKey &&
            (document.activeElement === first ||
              document.activeElement === event.currentTarget)
          ) {
            event.preventDefault();
            last?.focus();
          } else if (
            !event.shiftKey &&
            (document.activeElement === last ||
              document.activeElement === event.currentTarget)
          ) {
            event.preventDefault();
            first.focus();
          }
        }}
        ref={dialog}
        aria-labelledby={title}
        aria-describedby={description}
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
      >
        {attempt && (
          <>
            <h2 id={title}>Dienst absagen</h2>
            <p>
              {planDateLabel(attempt.duty.dutyDate)} ·{' '}
              {attempt.duty.shiftKind === 'DAY' ? 'Tagdienst' : 'Nachtdienst'}
            </p>
            <p>
              {attempt.project} ·{' '}
              {zonedDutyTime(attempt.duty.startsAt, attempt.duty.timeZone).time}{' '}
              – {zonedDutyTime(attempt.duty.endsAt, attempt.duty.timeZone).time}{' '}
              ({attempt.duty.timeZone})
            </p>
            <p id={description}>
              Sie reichen einen Absageantrag ein. Ihr zugeteilter Dienst bleibt
              bestehen, bis die Administration eine Entscheidung trifft oder den
              Plan ändert.
            </p>
            {state.kind === 'sending' && (
              <p role="status">Absage wird eingereicht …</p>
            )}
            {state.kind === 'uncertain' && (
              <p role="alert">
                Das Ergebnis ist noch unklar. Versuchen Sie dieselbe Anfrage
                erneut. Dabei wird kein zweiter Antrag angelegt.
              </p>
            )}
            {state.kind === 'error' && <p role="alert">{state.message}</p>}
            {state.kind === 'success' && (
              <p role="status">
                Absage eingereicht: {cancellationLabels[state.result.status]}.
                Ersatzbedarf: {needLabels[state.result.replacementNeed.status]}.
                Ihr Dienst bleibt im Monatsplan sichtbar.
              </p>
            )}
            <div className="cancellation-dialog__actions">
              <button
                type="button"
                autoFocus
                disabled={unresolved}
                onClick={close}
              >
                {state.kind === 'success' || state.kind === 'error'
                  ? 'Schließen'
                  : 'Zurück'}
              </button>
              {(state.kind === 'confirm' ||
                state.kind === 'sending' ||
                state.kind === 'uncertain') && (
                <button
                  type="button"
                  className="cancellation-dialog__submit"
                  disabled={state.kind === 'sending'}
                  onClick={() => void submit()}
                >
                  {state.kind === 'uncertain'
                    ? 'Dieselbe Anfrage erneut versuchen'
                    : state.kind === 'sending'
                      ? 'Wird eingereicht …'
                      : 'Absage verbindlich einreichen'}
                </button>
              )}
            </div>
          </>
        )}
      </dialog>
    </>
  );
}
