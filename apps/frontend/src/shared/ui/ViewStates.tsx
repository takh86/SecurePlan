import { ApiErrorAlert } from './ApiErrorAlert';
import '../styles/tokens.css';
import './ViewStates.css';

export function LoadingState({ label }: { label: string }) {
  return (
    <div className="view-state view-state--loading" role="status" aria-live="polite">
      <span className="view-state__spinner" aria-hidden="true" />
      {label}
    </div>
  );
}

export function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="view-state view-state--empty">
      <p className="view-state__title">{title}</p>
      <p>{description}</p>
    </div>
  );
}

/** Read errors reuse the shared safe API error text; retry is offered only where the error allows it. */
export function ErrorState({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <div className="view-state view-state--error">
      <ApiErrorAlert error={error} onRetry={onRetry} />
    </div>
  );
}
