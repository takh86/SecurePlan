import { useEffect, useRef } from 'react';
import { useLocation, useNavigationType } from 'react-router';

/**
 * The shell moves focus only between areas; within a nested area (e.g.
 * list -> detail) the sub-page heading `#page-title` gets it. `samePage` marks
 * path changes that stay on the same page (e.g. a month step), where focus
 * must remain on the control the user just used.
 */
export function useFocusHeadingOnSubpageChange(samePage?: (previous: string, next: string) => boolean) {
  const { pathname } = useLocation();
  const navigationType = useNavigationType();
  const previous = useRef<string | null>(null);
  useEffect(() => {
    const last = previous.current;
    previous.current = pathname;
    if (last === null || last === pathname || navigationType === 'REPLACE') return;
    if (samePage?.(last, pathname)) return;
    document.getElementById('page-title')?.focus();
  }, [pathname, navigationType, samePage]);
}
