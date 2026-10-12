import type { ApiError } from '../api/api-error';
import { describeApiError } from '../api/api-error';
import './ApiErrorAlert.css';

interface ApiErrorAlertProps {
  error: ApiError | Error | null;
  /** Only provide for operations that are safe to retry. The component never retries itself. */
  onRetry?: () => void;
}

/** Reusable error state for future SecurePlan forms/screens; no app-specific screen added. */
export function ApiErrorAlert({ error, onRetry }: ApiErrorAlertProps) {
  if (error === null) return null;

  const { title, description, correlationId, canRetry } = describeApiError(error);

  return (
    <section className="api-error-alert" role="alert">
      <h2 className="api-error-alert__title">{title}</h2>
      <p>{description}</p>
      {correlationId && (
        <p className="api-error-alert__reference">
          Referenz-ID: <code>{correlationId}</code>
        </p>
      )}
      {canRetry && onRetry && (
        <button type="button" onClick={onRetry}>
          Erneut versuchen
        </button>
      )}
    </section>
  );
}
