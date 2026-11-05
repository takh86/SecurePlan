import { useReadSource } from '../../../shared/data/use-read-source';
import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { parseMeIdentity, type IdentityContext } from '../../auth/auth-api';
import type { SessionApi } from '../../auth/session-api';
import { ApiError } from '../../../shared/api/api-error';
import {
  parsePlanMonth,
  planMonthLabel,
} from '../../../shared/time/civil-time';
import {
  parseWorkItems,
  type MyWorkItems,
} from '../../planning/my-month-plan/cancellation-api';
import {
  offerLabels,
  parseNeed,
  parseNeedPage,
  parseOffer,
  savedDutyTime,
  type Need,
  type NeedPage,
} from './offer-api';
import './OpenDutiesPage.css';
type Props = {
  api: SessionApi;
  identity: IdentityContext;
  requestSessionRevalidation: () => void;
};
type Attempt = { need: Need; key: string };
type CommandState = 'confirm' | 'sending' | 'uncertain' | 'success' | 'stale';
const explanation =
  'Du gibst ein Ersatzangebot ab. Das ist noch keine feste Einplanung. Das Büro entscheidet über die Übernahme.';
const stale =
  'Der Dienst ist nicht mehr verfügbar oder deine Voraussetzungen haben sich geändert. Bitte aktualisiere die Liste.';
/** Changing the session capability destroys every private read and frozen command. */
export function OpenDutiesPage(props: Props) {
  const [boundary, setBoundary] = useState({
    api: props.api,
    identity: props.identity,
    generation: 0,
  });
  if (boundary.api !== props.api || boundary.identity !== props.identity)
    setBoundary({
      api: props.api,
      identity: props.identity,
      generation: boundary.generation + 1,
    });
  const { month: raw } = useParams(),
    month = raw === undefined ? '' : parsePlanMonth(raw);
  if (month === null)
    return (
      <div role="alert">
        Ungültiger Monat. <Link to="/offene-dienste">Zum aktuellen Monat</Link>
      </div>
    );
  return (
    <BoundOpenDuties
      key={`${boundary.generation}:${month}`}
      {...props}
      month={month}
    />
  );
}
function BoundOpenDuties({
  api,
  identity,
  requestSessionRevalidation,
  month,
}: Props & { month: string }) {
  const [page, setPage] = useState(1),
    [revision, setRevision] = useState(0);
  const navigate = useNavigate();
  const [attempt, setAttempt] = useState<Attempt | null>(null),
    [status, setStatus] = useState<CommandState>('confirm'),
    [shown, setShown] = useState(false),
    [notice, setNotice] = useState('');
  const active = useRef(false),
    busy = useRef(false),
    command = useRef<AbortController | null>(null),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dialog = useRef<HTMLDialogElement>(null),
    heading = useRef<HTMLHeadingElement>(null),
    trigger = useRef<HTMLElement | null>(null);
  const titleId = useId(),
    descriptionId = useId();
  const refresh = () => setRevision((v) => v + 1);
  const authority = (e: unknown) => {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
      setShown(false);
      requestSessionRevalidation();
      return true;
    }
    return false;
  };
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      command.current?.abort();
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);
  const source = useMemo(
    () => ({
      kind: 'api' as const,
      async load(
        q: { month: string; page: number; revision: number },
        signal: AbortSignal,
      ): Promise<{
        currentMonth: string;
        needs: NeedPage | null;
        work: MyWorkItems | null;
      }> {
        try {
          const me = parseMeIdentity(
            await api.request<unknown>('/api/v1/me', { signal }),
          );
          signal.throwIfAborted();
          if (
            me.accountId.toLowerCase() !== identity.accountId.toLowerCase() ||
            me.companyId.toLowerCase() !== identity.companyId.toLowerCase() ||
            me.role !== identity.role
          ) {
            requestSessionRevalidation();
            throw new Error('Session changed');
          }
          if (!q.month)
            return {
              currentMonth: me.currentCompanyMonth.slice(0, 7),
              needs: null,
              work: null,
            };
          const [rawWork, rawNeeds] = await Promise.all([
            api.request<unknown>(
              `/api/v1/me/work-items?monthStart=${q.month}-01`,
              { signal },
            ),
            api.request<unknown>(
              `/api/v1/me/replacement-needs?monthStart=${q.month}-01&page=${q.page}&pageSize=25`,
              { signal },
            ),
          ]);
          signal.throwIfAborted();
          const work = parseWorkItems(rawWork, `${q.month}-01`),
            employee =
              work.replacementOffers[0]?.employee.id ??
              work.cancellationRequests[0]?.employee.id;
          return {
            currentMonth: me.currentCompanyMonth.slice(0, 7),
            work,
            needs: parseNeedPage(
              rawNeeds,
              `${q.month}-01`,
              q.page,
              25,
              employee,
            ),
          };
        } catch (e) {
          if (
            !signal.aborted &&
            e instanceof ApiError &&
            (e.status === 401 || e.status === 403)
          )
            requestSessionRevalidation();
          throw e;
        }
      },
    }),
    [api, identity, requestSessionRevalidation],
  );
  const query = useMemo(
    () => ({ month, page, revision }),
    [month, page, revision],
  );
  const { state } = useReadSource(source, query);
  const loaded = state.status === 'ready' ? state.data : null;
  const data =
    loaded?.needs && loaded.work
      ? { needs: loaded.needs, work: loaded.work }
      : null;
  const owner =
    data?.work.replacementOffers[0]?.employee.id ??
    data?.work.cancellationRequests[0]?.employee.id;
  const currentMonth = loaded?.currentMonth ?? '',
    loading = state.status === 'loading',
    error =
      state.status === 'error'
        ? 'Die Dienste und dein Status konnten nicht geladen werden. Bitte erneut versuchen.'
        : '';

  useLayoutEffect(() => {
    const el = dialog.current;
    if (!shown || !el) return;
    if (!el.open) el.showModal();
    el.querySelector<HTMLButtonElement>('[data-cancel]')?.focus();
    const fallback = heading.current;
    return () => {
      el.close();
      const target = trigger.current?.isConnected ? trigger.current : fallback;
      target?.focus();
    };
  }, [shown]);
  useLayoutEffect(() => {
    const el = dialog.current;
    if (
      shown &&
      el &&
      (!el.contains(document.activeElement) ||
        (document.activeElement instanceof HTMLButtonElement &&
          document.activeElement.disabled))
    )
      (
        el.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? el
      ).focus();
  }, [shown, status]);
  if (!month && currentMonth)
    return <Navigate to={`/offene-dienste/${currentMonth}`} replace />;
  async function open(need: Need, event: React.MouseEvent<HTMLButtonElement>) {
    if (busy.current) return;
    trigger.current = event.currentTarget;
    if (attempt?.need.id === need.id && status === 'uncertain') {
      setShown(true);
      return;
    }
    if (attempt && status === 'uncertain') return;
    busy.current = true;
    const c = new AbortController();
    command.current = c;
    setNotice('Dienst wird geprüft …');
    try {
      const fresh = parseNeed(
        await api.request<unknown>(`/api/v1/replacement-needs/${need.id}`, {
          signal: c.signal,
        }),
        need.id,
      );
      if (!active.current || c.signal.aborted) return;
      setAttempt({ need: fresh, key: crypto.randomUUID() });
      setStatus('confirm');
      setShown(true);
      setNotice('');
    } catch (e) {
      if (active.current && !c.signal.aborted && !authority(e)) {
        setNotice(stale);
        refresh();
      }
    } finally {
      busy.current = false;
    }
  }
  async function submit() {
    if (!attempt || busy.current || !active.current) return;
    busy.current = true;
    setStatus('sending');
    const frozen = attempt,
      c = new AbortController();
    command.current = c;
    timer.current = setTimeout(() => c.abort(), 30000);
    try {
      parseOffer(
        await api.request<unknown>(
          `/api/v1/replacement-needs/${frozen.need.id}/offers`,
          {
            method: 'POST',
            noBody: true,
            idempotencyKey: frozen.key,
            signal: c.signal,
          },
        ),
        owner,
        frozen.need.id,
      );
      if (!active.current || c.signal.aborted) {
        if (active.current) setStatus('uncertain');
        return;
      }
      setStatus('success');
      refresh();
    } catch (e) {
      if (!active.current) return;
      if (authority(e)) return;
      if (
        e instanceof ApiError &&
        (e.status === 404 ||
          (e.status === 409 &&
            !['IDEMPOTENCY_REQUEST_IN_PROGRESS'].includes(e.code ?? '')))
      ) {
        setStatus('stale');
        refresh();
      } else setStatus('uncertain');
    } finally {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      busy.current = false;
    }
  }
  async function checkStatus() {
    if (!attempt || busy.current) return;
    busy.current = true;
    const c = new AbortController();
    command.current = c;
    try {
      const work = parseWorkItems(
        await api.request<unknown>(
          `/api/v1/me/work-items?monthStart=${month}-01`,
          { signal: c.signal },
        ),
        `${month}-01`,
        owner,
      );
      if (!active.current || c.signal.aborted) return;
      const found = work.replacementOffers.find(
        (o) => o.needId === attempt.need.id,
      );
      if (found) {
        setNotice(`Dein Angebot: ${offerLabels[found.status]}`);
        setStatus('success');
        refresh();
      } else
        setNotice(
          'Noch kein Angebot bestätigt. Das Ergebnis bleibt unklar. Du kannst denselben Versuch erneut senden.',
        );
    } catch (e) {
      if (active.current && !c.signal.aborted && !authority(e))
        setNotice(
          'Status konnte nicht geprüft werden. Das Ergebnis bleibt unklar.',
        );
    } finally {
      busy.current = false;
    }
  }
  return (
    <div className="open-duties">
      <h2 ref={heading} tabIndex={-1}>
        {month ? planMonthLabel(month) : 'Offene Dienste'}
      </h2>
      <label>
        Monat auswählen{' '}
        <input
          type="month"
          min="0001-01"
          max="9999-12"
          value={month}
          onChange={(e) => {
            const m = parsePlanMonth(e.target.value);
            if (m) void navigate(`/offene-dienste/${m}`);
          }}
        />
      </label>{' '}
      <button onClick={refresh}>Liste und Status aktualisieren</button>
      <p role="status" aria-live="polite">
        {notice}
      </p>
      {loading ? (
        <p role="status">Dienste werden geladen …</p>
      ) : error ? (
        <div role="alert">
          <p>{error}</p>
          <button onClick={refresh}>Erneut laden</button>
        </div>
      ) : data ? (
        <>
          {data.needs.items.length === 0 ? (
            <p>Aktuell keine passenden offenen Dienste</p>
          ) : (
            <ul className="open-duties__list">
              {data.needs.items.map(({ need, myOffer }) => (
                <li key={need.id}>
                  <h3>
                    {need.project.name} ·{' '}
                    {need.duty.shiftKind === 'DAY'
                      ? 'Tagdienst'
                      : 'Nachtdienst'}
                  </h3>
                  <p>{savedDutyTime(need)}</p>
                  <p>Offene Angebote: {need.openOfferCount}</p>
                  {myOffer ? (
                    <p>Dein Angebot: {offerLabels[myOffer.status]}</p>
                  ) : null}
                  <button
                    disabled={
                      Boolean(
                        myOffer &&
                        ['OPEN', 'SELECTED'].includes(myOffer.status),
                      ) ||
                      Boolean(
                        attempt &&
                        status === 'uncertain' &&
                        attempt.need.id !== need.id,
                      )
                    }
                    onClick={(e) => void open(need, e)}
                  >
                    {myOffer && ['OPEN', 'SELECTED'].includes(myOffer.status)
                      ? 'Angebot bereits abgegeben'
                      : attempt?.need.id === need.id && status === 'uncertain'
                        ? 'Unklaren Versuch öffnen'
                        : 'Als Ersatz anbieten'}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <nav aria-label="Dienstseiten">
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Vorherige Seite
            </button>
            <span>
              {' '}
              Seite {page} von {data.needs.pagination.totalPages} ·{' '}
              {data.needs.pagination.totalItems} Dienste{' '}
            </span>
            <button
              disabled={page >= data.needs.pagination.totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Nächste Seite
            </button>
          </nav>
          <section aria-label="Meine Ersatzangebote">
            <h3>Meine Ersatzangebote</h3>
            {data.work.replacementOffers.length ? (
              <ul>
                {data.work.replacementOffers.map((o) => (
                  <li key={o.id}>
                    Angebot vom{' '}
                    {new Intl.DateTimeFormat('de-DE', {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                      timeZone: 'UTC',
                    }).format(new Date(o.createdAt))}{' '}
                    UTC · {offerLabels[o.status]}
                  </li>
                ))}
              </ul>
            ) : (
              <p>Noch keine Ersatzangebote in diesem Monat.</p>
            )}
          </section>
        </>
      ) : null}
      {attempt && shown ? (
        <dialog
          ref={dialog}
          tabIndex={-1}
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          onCancel={(e) => {
            e.preventDefault();
            if (!busy.current) setShown(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Tab') {
              const buttons = Array.from(
                e.currentTarget.querySelectorAll<HTMLButtonElement>(
                  'button:not(:disabled)',
                ),
              );
              const first = buttons[0],
                last = buttons.at(-1);
              if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last?.focus();
              } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first?.focus();
              }
            }
          }}
        >
          <h2 id={titleId}>Als Ersatz anbieten</h2>
          <p>{attempt.need.project.name}</p>
          <p>{savedDutyTime(attempt.need)}</p>
          <p id={descriptionId}>{explanation}</p>
          <p role="status" aria-live="polite">
            {status === 'success'
              ? 'Angebot abgegeben. Du bist noch nicht für diesen Dienst eingeplant.'
              : status === 'uncertain'
                ? 'Das Ergebnis ist noch unklar. Status prüfen oder denselben Versuch erneut senden.'
                : status === 'stale'
                  ? stale
                  : status === 'sending'
                    ? 'Angebot wird gesendet …'
                    : ''}
          </p>
          <div className="open-duties__actions">
            <button
              data-cancel
              disabled={status === 'sending'}
              onClick={() => {
                setShown(false);
                if (status !== 'uncertain') setAttempt(null);
              }}
            >
              {status === 'confirm' ? 'Abbrechen' : 'Schließen'}
            </button>
            {status === 'confirm' ? (
              <button onClick={() => void submit()}>
                Angebot verbindlich abgeben
              </button>
            ) : null}
            {status === 'uncertain' ? (
              <>
                <button onClick={() => void checkStatus()}>
                  Status prüfen
                </button>
                <button onClick={() => void submit()}>
                  Denselben Versuch erneut senden
                </button>
              </>
            ) : null}
            {status === 'stale' ? (
              <button
                onClick={() => {
                  setShown(false);
                  setAttempt(null);
                  refresh();
                }}
              >
                Liste aktualisieren
              </button>
            ) : null}
          </div>
        </dialog>
      ) : null}
    </div>
  );
}
