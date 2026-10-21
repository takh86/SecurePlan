import '../styles/tokens.css';
import './PreviewNotice.css';

/** Visible marker for screens backed by synthetic preview fixtures instead of a real API. */
export function PreviewNotice() {
  return (
    <aside className="preview-notice" aria-label="Hinweis zu Demodaten">
      <svg className="preview-notice__icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <circle cx="10" cy="10" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
        <rect x="9" y="8.5" width="2" height="6" fill="currentColor" />
        <rect x="9" y="5" width="2" height="2" fill="currentColor" />
      </svg>
      <p>
        <strong>Demodaten / UI-Vorschau</strong> – Namen, Projekte, Daten und Dienstzeiten sind
        synthetische Beispielwerte, keine freigegebenen Schicht- oder Planungsregeln. Es werden
        keine Daten gespeichert.
      </p>
    </aside>
  );
}
