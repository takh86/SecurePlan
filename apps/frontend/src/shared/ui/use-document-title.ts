import { useEffect } from 'react';

/** Sets `<Seite> – SecurePlan` as document title; `null` leaves the title untouched. */
export function useDocumentTitle(title: string | null) {
  useEffect(() => {
    if (title !== null) document.title = `${title} – SecurePlan`;
  }, [title]);
}
