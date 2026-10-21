import type { ReactNode } from 'react';
import { useDocumentTitle } from '../shared/ui/use-document-title';

/** Page heading and document title. The shell moves focus to `#page-title` after navigation. */
export function PageFrame({ title, lead, children }: { title: string; lead?: string; children: ReactNode }) {
  useDocumentTitle(title);
  return (
    <>
      <div className="page-header">
        <h1 id="page-title" tabIndex={-1}>{title}</h1>
        {lead && <p className="page-header__lead">{lead}</p>}
      </div>
      {children}
    </>
  );
}
