import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { parseBaseIdentity, type IdentityContext } from '../../auth/auth-api';
import type { SessionApi } from '../../auth/session-api';
import { ApiError } from '../../../shared/api/api-error';
import { useReadSource } from '../../../shared/data/use-read-source';
import { planDateLabel } from '../../../shared/time/civil-time';
import {
  parseCancellation,
  parseWorkItems,
  type CancellationResponse,
} from './cancellation-api';

type Props = {
  api: SessionApi;
  identity: IdentityContext;
  monthStart: string;
  revision: number;
  revalidate: () => void;
};
type State =
  'confirm' | 'sending' | 'uncertain' | 'success' | 'stale' | 'error';
const labels = {
  OPEN: 'Offen',
  WITHDRAWN: 'Zurückgezogen',
  APPROVED: 'Genehmigt',
  REJECTED: 'Abgelehnt',
  OBSOLETE: 'Gegenstandslos',
};
const needs = {
  OPEN: 'Offen',
  CLOSED: 'Geschlossen',
  OPEN_UNFILLED: 'Unbesetzt',
  RESOLVED: 'Besetzt',
};

/** Clear command identity synchronously on account/session capability changes. */
export function OwnCancellations(props: Props) {
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
  return (
    <BoundOwnCancellations
      key={`${boundary.generation}:${props.monthStart}`}
      {...props}
    />
  );
}
function BoundOwnCancellations({
  api,
  identity,
  monthStart,
  revision,
  revalidate,
}: Props) {
  const [refresh, setRefresh] = useState(0);
  const [attempt, setAttempt] = useState<CancellationResponse | null>(null);
  const [status, setStatus] = useState<State>('confirm');
  const [message, setMessage] = useState('');
  const dialog = useRef<HTMLDialogElement>(null),
    heading = useRef<HTMLHeadingElement>(null),
    trigger = useRef<HTMLElement | null>(null);
  const active = useRef(false),
    busy = useRef(false),
    controller = useRef<AbortController | null>(null),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const headingId = useId(),
    titleId = useId(),
    descriptionId = useId();
  const source = useMemo(
    () => ({
      kind: 'api' as const,
      async load(
        query: { monthStart: string; revision: number; refresh: number },
        signal: AbortSignal,
      ) {
        const month = query.monthStart;
        try {
          const principal = parseBaseIdentity(
            await api.request<unknown>('/api/v1/me', { signal }),
          );
          signal.throwIfAborted();
          if (
            principal.accountId.toLowerCase() !==
              identity.accountId.toLowerCase() ||
            principal.companyId.toLowerCase() !==
              identity.companyId.toLowerCase() ||
            principal.role !== identity.role
          ) {
            revalidate();
            throw new Error('Session identity changed');
          }
          return parseWorkItems(
            await api.request<unknown>(
              `/api/v1/me/work-items?monthStart=${month}`,
              { signal },
            ),
            month,
          );
        } catch (error) {
          if (
            !signal.aborted &&
            error instanceof ApiError &&
            (error.status === 401 || error.status === 403)
          )
            revalidate();
          throw error;
        }
      },
    }),
    [api, identity, revalidate],
  );
  const query = useMemo(
    () => ({ monthStart, revision, refresh }),
    [monthStart, revision, refresh],
  );
  const { state, retry } = useReadSource(source, query);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      controller.current?.abort();
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!attempt || !element) return;
    if (!element.open) element.showModal();
    if (
      !element.contains(document.activeElement) ||
      (document.activeElement instanceof HTMLButtonElement &&
        document.activeElement.disabled)
    ) {
      (
        element.querySelector<HTMLButtonElement>('button:not(:disabled)') ??
        element
      ).focus();
    }
  }, [attempt, status]);
  useEffect(() => {
    const refreshOnFocus = () => {
      if (!attempt && document.visibilityState === 'visible')
        setRefresh((v) => v + 1);
    };
    window.addEventListener('focus', refreshOnFocus);
    return () => window.removeEventListener('focus', refreshOnFocus);
  }, [attempt]);
  const unresolved = status === 'sending' || status === 'uncertain';
  function close() {
    if (unresolved) return;
    dialog.current?.close();
    setAttempt(null);
    if (status === 'confirm' && trigger.current?.isConnected)
      trigger.current.focus();
    else {
      heading.current?.focus();
      setRefresh((v) => v + 1);
    }
  }
  async function submit() {
    if (
      !attempt ||
      busy.current ||
      !active.current ||
      !['confirm', 'uncertain'].includes(status)
    )
      return;
    busy.current = true;
    setStatus('sending');
    const current = new AbortController();
    controller.current = current;
    const valid = () =>
      active.current &&
      !current.signal.aborted &&
      controller.current === current;
    const deadline = setTimeout(() => {
      if (!valid()) return;
      current.abort();
      busy.current = false;
      setStatus('uncertain');
    }, 30_000);
    timer.current = deadline;
    try {
      const value = await api.request<unknown>(
        `/api/v1/cancellation-requests/${attempt.id}/withdraw`,
        { method: 'POST', noBody: true, signal: current.signal },
      );
      if (!valid()) return;
      const result = parseCancellation(
        value,
        attempt.assignmentId,
        attempt.duty.id,
      );
      if (
        result.id.toLowerCase() !== attempt.id.toLowerCase() ||
        result.employee.id.toLowerCase() !==
          attempt.employee.id.toLowerCase() ||
        result.status !== 'WITHDRAWN'
      )
        throw new ApiError('invalid-response', 200, null, null);
      setStatus('success');
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
        (error.status === 404 || error.code === 'CANCELLATION_NOT_WITHDRAWABLE')
      ) {
        setStatus('stale');
        setMessage(
          'Der Antrag kann nicht mehr zurückgezogen werden. Laden Sie den aktuellen Status.',
        );
        return;
      }
      if (
        !(error instanceof ApiError) ||
        error.status === null ||
        error.status >= 500 ||
        error.kind === 'invalid-response'
      ) {
        setStatus('uncertain');
        return;
      }
      setStatus('error');
      setMessage(
        'Die Absage konnte nicht zurückgezogen werden. Laden Sie den aktuellen Status und prüfen Sie den Antrag erneut.',
      );
    } finally {
      clearTimeout(deadline);
      if (valid()) busy.current = false;
    }
  }
  return (
    <section className="own-cancellations" aria-labelledby={headingId}>
      <h3 id={headingId} ref={heading} tabIndex={-1}>
        Meine Absagen
      </h3>
      <p>Der aktuelle Status Ihrer Absagen im ausgewählten Monat.</p>
      <button type="button" disabled={attempt !== null} onClick={retry}>
        Absagestatus aktualisieren
      </button>
      {state.status === 'loading' && (
        <p role="status">Absagen werden geladen …</p>
      )}
      {state.status === 'error' && (
        <p role="alert">
          Der Absagestatus konnte nicht geladen werden. Bitte versuchen Sie es
          erneut.
        </p>
      )}
      {state.status === 'ready' &&
        (state.data.cancellationRequests.length === 0 ? (
          <p>Keine Absagen für diesen Monat.</p>
        ) : (
          <ul className="my-plan__duties">
            {state.data.cancellationRequests.map((item) => (
              <li key={item.id}>
                <article
                  className="duty-card"
                  aria-label={`Absage ${planDateLabel(item.duty.dutyDate)}`}
                >
                  <h4>
                    {planDateLabel(item.duty.dutyDate)} ·{' '}
                    {item.duty.shiftKind === 'DAY'
                      ? 'Tagdienst'
                      : 'Nachtdienst'}
                  </h4>
                  <p>
                    Absage: {labels[item.status]}. Ersatzbedarf:{' '}
                    {needs[item.replacementNeed.status]}.
                  </p>
                  {item.status === 'OPEN' &&
                    item.replacementNeed.status === 'OPEN' && (
                      <button
                        type="button"
                        className="cancellation-action__trigger"
                        onClick={(event) => {
                          if (busy.current || attempt !== null) return;
                          trigger.current = event.currentTarget;
                          setAttempt(item);
                          setStatus('confirm');
                          setMessage('');
                        }}
                      >
                        Absage zurückziehen
                      </button>
                    )}
                </article>
              </li>
            ))}
          </ul>
        ))}
      <dialog
        ref={dialog}
        className="cancellation-dialog"
        tabIndex={-1}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return;
          const buttons = [
              ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                'button:not(:disabled)',
              ),
            ],
            first = buttons[0],
            last = buttons.at(-1);
          if (!first) {
            event.preventDefault();
            event.currentTarget.focus();
          } else if (
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
      >
        {attempt && (
          <>
            <h2 id={titleId}>Absage zurückziehen</h2>
            <p>
              {planDateLabel(attempt.duty.dutyDate)} ·{' '}
              {attempt.duty.shiftKind === 'DAY' ? 'Tagdienst' : 'Nachtdienst'}
            </p>
            <p id={descriptionId}>
              Sie ziehen Ihren Absageantrag zurück. Der Ersatzbedarf wird
              geschlossen. Sie bleiben dem ursprünglichen Dienst zugeteilt.
            </p>
            {status === 'sending' && (
              <p role="status">Absage wird zurückgezogen …</p>
            )}
            {status === 'uncertain' && (
              <p role="alert">
                Das Ergebnis ist noch unklar. Versuchen Sie dieselbe Rücknahme
                erneut. Dabei wird kein weiterer Vorgang angelegt.
              </p>
            )}
            {status === 'success' && (
              <p role="status">
                Absage zurückgezogen. Sie bleiben dem Dienst zugeteilt.
              </p>
            )}
            {(status === 'stale' || status === 'error') && (
              <p role="alert">{message}</p>
            )}
            <div className="cancellation-dialog__actions">
              <button
                type="button"
                autoFocus
                disabled={unresolved}
                onClick={close}
              >
                {status === 'confirm'
                  ? 'Zurück'
                  : status === 'success'
                    ? 'Schließen'
                    : 'Aktuellen Status laden'}
              </button>
              {['confirm', 'sending', 'uncertain'].includes(status) && (
                <button
                  type="button"
                  className="cancellation-dialog__submit"
                  disabled={status === 'sending'}
                  onClick={() => void submit()}
                >
                  {status === 'sending'
                    ? 'Wird zurückgezogen …'
                    : status === 'uncertain'
                      ? 'Dieselbe Rücknahme erneut versuchen'
                      : 'Absage verbindlich zurückziehen'}
                </button>
              )}
            </div>
          </>
        )}
      </dialog>
    </section>
  );
}
