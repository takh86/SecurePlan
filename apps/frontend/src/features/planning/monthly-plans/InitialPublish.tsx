import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject, type SyntheticEvent } from 'react';
import { ApiError } from '../../../shared/api/api-error';
import { formatMonthLabel } from '../../../shared/time/month';
import { ApiErrorAlert } from '../../../shared/ui/ApiErrorAlert';
import { StatusBadge } from '../../../shared/ui/StatusBadge';
import {
  dutiesSignature,
  newIdempotencyKey,
  publishNeedsReload,
  publishOutcomeUnknown,
  publishSummary,
} from './initial-publish';
import type { PublishSlotProps } from './MonthlyPlanPage';
import { NO_EMPLOYEE_PLAN_VIEW } from './monthly-plan-types';
import type { MonthlyPlansApi } from './monthly-plans-api';
import { planningErrorText, unknownOutcomeText, type ErrorText } from './planning-errors';

/** One confirmed decision. The key is created on confirmation and kept for every resend of it. */
type Attempt = { key: string; planId: string; sends: number };

type Phase =
  | { step: 'idle' }
  | { step: 'confirm' }
  /** Confirmed: re-reading the duties to make sure the admin decided on the current state. */
  | { step: 'checking' }
  | { step: 'sending'; attempt: Attempt }
  /** No usable answer: reading the plan to see whether it is published. */
  | { step: 'verifying'; attempt: Attempt; cause: unknown }
  | { step: 'uncertain'; attempt: Attempt; cause: unknown; check: 'unpublished' | 'unreadable' };

type Outcome =
  | { kind: 'success'; text: string }
  | { kind: 'problem'; title: string; text: string }
  | { kind: 'error'; error: unknown; text?: ErrorText };

const AFTER_PUBLISH = 'Änderungen an Diensten gelten ab jetzt sofort, ohne erneutes Veröffentlichen.';
// Retry-After of IDEMPOTENCY_REQUEST_IN_PROGRESS (Phase 8.7: one second).
const IN_PROGRESS_DELAY_MS = 1000;

const WORKING_TEXT: Partial<Record<Phase['step'], string>> = {
  checking: 'Aktueller Stand wird geprüft …',
  sending: 'Veröffentlichung wird übertragen …',
  verifying: 'Keine Antwort erhalten – der aktuelle Stand wird geprüft …',
};

type Props = PublishSlotProps & { plans: MonthlyPlansApi };

/**
 * SP-13 First Publish of one monthly plan (UNPUBLISHED -> PUBLISHED). A modal
 * confirmation names the plan and summarises its duties; on confirmation the
 * duties are re-read, and only if they still match the screen is ONE bodyless
 * POST sent under a new Idempotency-Key. A lost or unreadable answer, a 5xx or
 * an in-progress claim never counts as success or failure: the plan is re-read,
 * and the admin may resend the SAME key (the server replays a completed
 * publication; it never publishes twice). Definitive refusals reload the plan
 * and its duties; the next attempt is a new decision with a new key. PUBLISHED
 * is shown only from a server answer or a confirming read. There is no
 * re-publish: under CR-03 later duty changes apply directly.
 *
 * Versionless contract (known gap, not closed here): the publish command
 * carries no plan version or fingerprint, so the server publishes the live
 * state it finds at commit time, after its own full re-validation. The
 * pre-send re-read only proves what the duties were when that GET completed;
 * a change another admin commits between that read and the server's plan lock
 * is published without having been shown. The dialog says so and never claims
 * that exactly the reviewed snapshot was published. Closing the gap needs a
 * server-enforced precondition (contract decision), not client retries.
 */
export function InitialPublish({ plan, project, duties, hasUnsavedChanges, onPlanChanged, onReload, plans }: Props) {
  const [phase, setPhase] = useState<Phase>({ step: 'idle' });
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [resendReady, setResendReady] = useState(true);
  const [focusRequest, setFocusRequest] = useState<{ to: 'trigger' | 'outcome' } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const uncertainHeading = useRef<HTMLHeadingElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const outcomeRef = useRef<HTMLDivElement>(null);
  /** Guards against double clicks and repeated Enter in the same tick: one request at a time. */
  const busy = useRef(false);
  const mounted = useRef(true);
  const resendTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useId();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (resendTimer.current) clearTimeout(resendTimer.current);
    };
  }, []);

  const blocked: string | null =
    project.status !== 'ACTIVE'
      ? 'Das Projekt ist inaktiv. Der Monatsplan eines inaktiven Projekts kann nicht veröffentlicht werden; reaktivieren Sie das Projekt zuerst.'
      : hasUnsavedChanges
        ? 'Im Bearbeitungsbereich gibt es ungespeicherte Eingaben oder ein Speichern läuft noch. Speichern oder verwerfen Sie sie, bevor Sie veröffentlichen.'
        : duties === null
          ? 'Veröffentlichen ist erst möglich, wenn die Dienste dieses Plans vollständig geladen sind.'
          : null;
  const canConfirm = plan.status === 'UNPUBLISHED' && blocked === null;

  // The plan became PUBLISHED while the confirmation was open (e.g. a fresh read): nothing to decide any more.
  if (phase.step === 'confirm' && plan.status !== 'UNPUBLISHED') {
    setPhase({ step: 'idle' });
    setOutcome({
      kind: 'problem',
      title: 'Bereits veröffentlicht',
      text: 'Der Monatsplan ist inzwischen veröffentlicht. Ein erneutes Veröffentlichen gibt es nicht; Änderungen an Diensten gelten sofort.',
    });
    setFocusRequest({ to: 'outcome' });
  }

  // Native modal dialog: top layer, inert page behind it. It is shown for decisions only.
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if ((phase.step === 'confirm' || phase.step === 'uncertain') && !element.open) element.showModal();
    if (phase.step === 'confirm') cancelButton.current?.focus();
    else if (phase.step === 'uncertain') uncertainHeading.current?.focus();
    // A resend replaces the focused button: keep keyboard focus inside the open dialog.
    else if (element.open && !element.contains(document.activeElement)) title.current?.focus();
  }, [phase.step]);

  useEffect(() => {
    if (!focusRequest) return;
    if (focusRequest.to === 'trigger' && trigger.current?.isConnected) trigger.current.focus();
    else outcomeRef.current?.focus();
  }, [focusRequest]);

  function finish(next: Outcome) {
    busy.current = false;
    setPhase({ step: 'idle' });
    setOutcome(next);
    setFocusRequest({ to: 'outcome' });
  }

  function open() {
    if (busy.current || phase.step !== 'idle' || !canConfirm) return;
    setOutcome(null);
    setPhase({ step: 'confirm' });
  }

  function cancel() {
    if (phase.step !== 'confirm') return;
    setPhase({ step: 'idle' });
    setFocusRequest({ to: 'trigger' });
  }

  async function confirm() {
    if (busy.current || phase.step !== 'confirm' || !canConfirm || duties === null) return;
    busy.current = true;
    const shown = dutiesSignature(duties);
    const planId = plan.id;
    setPhase({ step: 'checking' });
    let current: string;
    try {
      current = dutiesSignature(await plans.listDuties(planId));
    } catch (error) {
      if (!mounted.current) return;
      finish({
        kind: 'error',
        error,
        text: error instanceof ApiError && error.status === 401 ? undefined : {
          title: 'Stand konnte nicht geprüft werden',
          description: 'Vor dem Veröffentlichen wird der aktuelle Stand der Dienste geladen; das ist fehlgeschlagen. Der Plan wurde nicht veröffentlicht. Versuchen Sie es erneut.',
        },
      });
      return;
    }
    if (!mounted.current) return;
    if (current !== shown) {
      // Another admin (or another window) changed the duties: the admin must see them first.
      onReload();
      finish({
        kind: 'problem',
        title: 'Plan wurde inzwischen geändert',
        text: 'Seit dem Laden der Ansicht haben sich Dienste dieses Plans geändert. Der Plan wurde nicht veröffentlicht. Der aktuelle Stand wird geladen; prüfen Sie ihn und bestätigen Sie die Veröffentlichung danach erneut.',
      });
      return;
    }
    await send({ key: newIdempotencyKey(), planId, sends: 0 });
  }

  async function send(previous: Attempt) {
    busy.current = true;
    const attempt = { ...previous, sends: previous.sends + 1 };
    setPhase({ step: 'sending', attempt });
    try {
      const published = await plans.publish(attempt.planId, attempt.key);
      if (!mounted.current) return;
      onPlanChanged(published);
      finish({
        kind: 'success',
        text: attempt.sends > 1
          ? `Der Monatsplan ist veröffentlicht. Das hat die erneute Anfrage mit demselben Vorgang bestätigt; doppelt veröffentlicht wurde nicht. ${AFTER_PUBLISH}`
          : `Der Monatsplan wurde veröffentlicht. ${AFTER_PUBLISH}`,
      });
    } catch (error) {
      if (!mounted.current) return;
      if (publishOutcomeUnknown(error)) {
        await verify(attempt, error);
        return;
      }
      if (publishNeedsReload(error)) onReload();
      finish({ kind: 'error', error, text: planningErrorText(error, 'publish-plan') });
    }
  }

  /** Never infers a rollback: only a read showing PUBLISHED settles an unknown outcome. */
  async function verify(attempt: Attempt, cause: unknown) {
    setPhase({ step: 'verifying', attempt, cause });
    let check: 'unpublished' | 'unreadable' = 'unreadable';
    try {
      const current = await plans.get(attempt.planId);
      if (!mounted.current) return;
      if (current.status === 'PUBLISHED') {
        onPlanChanged(current);
        finish({
          kind: 'success',
          text: `Der Monatsplan ist veröffentlicht. Das hat das erneute Laden des aktuellen Stands bestätigt. ${AFTER_PUBLISH}`,
        });
        return;
      }
      check = 'unpublished';
    } catch {
      if (!mounted.current) return;
    }
    busy.current = false;
    if (cause instanceof ApiError && cause.code === 'IDEMPOTENCY_REQUEST_IN_PROGRESS') {
      setResendReady(false);
      if (resendTimer.current) clearTimeout(resendTimer.current);
      resendTimer.current = setTimeout(() => {
        if (mounted.current) setResendReady(true);
      }, IN_PROGRESS_DELAY_MS);
    }
    setPhase({ step: 'uncertain', attempt, cause, check });
  }

  function resend() {
    if (busy.current || phase.step !== 'uncertain' || !resendReady) return;
    void send(phase.attempt);
  }

  /** Gives up the open attempt (its key is dropped) and re-reads the state; the status shows the truth. */
  function leave() {
    if (busy.current || phase.step !== 'uncertain') return;
    onReload();
    finish({
      kind: 'problem',
      title: 'Ergebnis offen',
      text: 'Sie haben den Vorgang verlassen, bevor das Ergebnis feststand. Der aktuelle Stand wird geladen; der Planstatus zeigt danach, ob der Monatsplan veröffentlicht ist.',
    });
  }

  /** Escape and other close requests: cancel a confirmation or leave an open attempt; never during a request. */
  function dismiss() {
    if (phase.step === 'confirm') cancel();
    else if (phase.step === 'uncertain') leave();
  }

  function onDialogKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== 'Escape') return;
    // The component decides; the browser must not close the dialog behind its state.
    event.preventDefault();
    event.stopPropagation();
    dismiss();
  }

  function onDialogCancel(event: SyntheticEvent<HTMLDialogElement>) {
    event.preventDefault();
    dismiss();
  }

  /** The browser closed the dialog anyway (a repeated close request): keep the state consistent. */
  function onDialogClose() {
    dismiss();
  }

  const working = phase.step === 'checking' || phase.step === 'sending' || phase.step === 'verifying';
  const summary = duties ? publishSummary(duties) : null;
  const label = `${project.name} – ${formatMonthLabel(plan.monthStart.slice(0, 7))}`;

  return (
    <div className="planning-publish__body">
      {plan.status === 'UNPUBLISHED' && (
        <div className="planning-publish__action">
          <button
            ref={trigger}
            type="button"
            className="employees-button employees-button--primary"
            aria-disabled={!canConfirm || phase.step !== 'idle' ? true : undefined}
            aria-describedby={blocked ? `${id}-blocked` : undefined}
            aria-haspopup="dialog"
            onClick={open}
          >
            Monatsplan veröffentlichen …
          </button>
          {blocked && <p id={`${id}-blocked`} className="employee-form__hint">{blocked}</p>}
        </div>
      )}
      {/* Always mounted, so progress and results are announced even if the dialog was closed. */}
      <div role="status" aria-live="polite" className="planning-publish__live">
        {working && <p>{WORKING_TEXT[phase.step]}</p>}
      </div>
      <div ref={outcomeRef} tabIndex={-1} className="planning-publish__outcome">
        {outcome?.kind === 'success' && <p className="employees__notice">{outcome.text}</p>}
        {outcome?.kind === 'problem' && (
          <section className="api-error-alert" role="alert">
            <h2 className="api-error-alert__title">{outcome.title}</h2>
            <p>{outcome.text}</p>
          </section>
        )}
        {outcome?.kind === 'error' && <ApiErrorAlert error={asError(outcome.error)} text={outcome.text} />}
      </div>
      {phase.step !== 'idle' && (
        <dialog
          ref={dialog}
          className="planning-publish-dialog"
          role="alertdialog"
          aria-labelledby={`${id}-title`}
          aria-describedby={phase.step === 'uncertain' ? `${id}-uncertain` : `${id}-intro`}
          onKeyDown={onDialogKeyDown}
          onCancel={onDialogCancel}
          onClose={onDialogClose}
        >
          <h2 id={`${id}-title`} ref={title} tabIndex={-1}>Monatsplan veröffentlichen?</h2>
          {phase.step === 'uncertain' ? (
            <UncertainContent
              id={`${id}-uncertain`}
              headingRef={uncertainHeading}
              cause={phase.cause}
              check={phase.check}
              resendReady={resendReady}
              onResend={resend}
              onLeave={leave}
            />
          ) : (
            <>
              <p id={`${id}-intro`}>
                Sie veröffentlichen den Monatsplan <strong>{label}</strong> zum ersten Mal. Sein Status wechselt dann
                zu „Veröffentlicht“; das lässt sich nicht rückgängig machen.
              </p>
              {summary && (
                <dl className="employees-card__facts">
                  <div>
                    <dt>Dienste</dt>
                    <dd>
                      {summary.duties === 0 ? 'keine' : summary.duties}
                      {summary.unstaffed > 0 && ` (davon ${summary.unstaffed} ohne Besetzung)`}
                    </dd>
                  </div>
                  <div><dt>Eingeplante Personen</dt><dd>{summary.people}</dd></div>
                </dl>
              )}
              {summary?.duties === 0 && <p>Der Plan enthält noch keine Dienste. Auch ein Plan ohne Dienste kann veröffentlicht werden.</p>}
              {summary !== null && summary.unavailable > 0 && (
                <p className="planning-publish-dialog__hint">
                  <StatusBadge tone="attention">Hinweis</StatusBadge>{' '}
                  {summary.unavailable === 1
                    ? 'Eine Einplanung betrifft eine Person, die am Diensttag nicht verfügbar ist.'
                    : `${summary.unavailable} Einplanungen betreffen Personen, die am Diensttag nicht verfügbar sind.`}{' '}
                  Solange das so ist, lehnt der Server die Veröffentlichung ab.
                </p>
              )}
              <ul>
                <li>
                  Veröffentlicht wird der Stand, der beim Abschluss auf dem Server gespeichert ist. Der Server prüft dabei
                  alle Dienste und Einplanungen erneut; ist eine Regel verletzt, wird nichts veröffentlicht.
                </li>
                <li>
                  Vor dem Senden wird geprüft, ob die Dienste noch dieser Anzeige entsprechen. Eine Änderung, die eine
                  andere Administration unmittelbar danach speichert, kann trotzdem mitveröffentlicht werden. Dass genau
                  der angezeigte Stand veröffentlicht wird, ist nicht garantiert.
                </li>
                <li>Danach gelten Änderungen an Diensten sofort, ohne erneutes Veröffentlichen.</li>
                <li>Es wird keine Benachrichtigung versendet. {NO_EMPLOYEE_PLAN_VIEW}</li>
              </ul>
              {!canConfirm && blocked && <p id={`${id}-reason`} className="employee-form__hint">{blocked}</p>}
              <div role="status" aria-live="polite">
                {working && <p>{WORKING_TEXT[phase.step]}</p>}
              </div>
              <div className="employee-form__actions">
                <button
                  type="button"
                  className="employees-button employees-button--primary"
                  aria-disabled={working || !canConfirm ? true : undefined}
                  aria-describedby={!canConfirm && blocked ? `${id}-reason` : undefined}
                  onClick={() => void confirm()}
                >
                  {working ? 'Wird veröffentlicht …' : 'Jetzt veröffentlichen'}
                </button>
                <button
                  ref={cancelButton}
                  type="button"
                  className="employees-button"
                  aria-disabled={working ? true : undefined}
                  onClick={cancel}
                >
                  Abbrechen
                </button>
              </div>
            </>
          )}
        </dialog>
      )}
    </div>
  );
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error('Publish failed');
}

type UncertainProps = {
  id: string;
  headingRef: RefObject<HTMLHeadingElement | null>;
  cause: unknown;
  check: 'unpublished' | 'unreadable';
  resendReady: boolean;
  onResend: () => void;
  onLeave: () => void;
};

/** The outcome of the confirmed attempt is unknown: resend the same key, or leave and re-read. */
function UncertainContent({ id, headingRef, cause, check, resendReady, onResend, onLeave }: UncertainProps) {
  const inProgress = cause instanceof ApiError && cause.code === 'IDEMPOTENCY_REQUEST_IN_PROGRESS';
  const text = inProgress ? planningErrorText(cause, 'publish-plan')! : unknownOutcomeText('publish-plan');
  const correlationId = cause instanceof ApiError ? cause.correlationId : null;
  return (
    <>
      <div id={id} className="planning-publish-dialog__uncertain">
        <h3 ref={headingRef} tabIndex={-1}>{text.title}</h3>
        <p>{text.description}</p>
        <p>
          {check === 'unpublished'
            ? 'Laut aktuellem Stand ist der Plan noch nicht veröffentlicht. Die Anfrage kann aber noch verarbeitet werden; daraus folgt nicht, dass nichts veröffentlicht wird.'
            : 'Der aktuelle Stand des Plans konnte nicht geladen werden.'}
        </p>
        <p>
          „Erneut anfragen“ sendet denselben Vorgang noch einmal: Ist die Veröffentlichung schon erfolgt, wird nur ihr
          Ergebnis bestätigt.
        </p>
        {correlationId && (
          <p className="api-error-alert__reference">Referenz-ID: <code>{correlationId}</code></p>
        )}
      </div>
      <div className="employee-form__actions">
        <button
          type="button"
          className="employees-button employees-button--primary"
          aria-disabled={resendReady ? undefined : true}
          onClick={onResend}
        >
          Erneut anfragen
        </button>
        <button type="button" className="employees-button" onClick={onLeave}>
          Vorgang verlassen und Stand laden
        </button>
      </div>
    </>
  );
}
