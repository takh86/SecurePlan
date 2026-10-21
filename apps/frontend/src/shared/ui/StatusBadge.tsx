import type { ReactNode } from 'react';
import '../styles/tokens.css';
import './StatusBadge.css';

export type StatusTone = 'info' | 'attention' | 'success' | 'neutral';

// Each tone has its own icon shape, so status never depends on color alone.
const icons: Record<StatusTone, ReactNode> = {
  info: <circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" strokeWidth="2" />,
  attention: <path d="M8 2 15 14H1Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />,
  success: <path d="m3 8.5 3.5 3.5L13 4.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />,
  neutral: <circle cx="8" cy="8" r="3.5" fill="currentColor" />,
};

export function StatusBadge({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return (
    <span className={`status-badge status-badge--${tone}`}>
      <svg className="status-badge__icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        {icons[tone]}
      </svg>
      {children}
    </span>
  );
}
