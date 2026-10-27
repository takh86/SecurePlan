import { useEffect, useRef } from 'react';
import { useLocation, useNavigationType } from 'react-router';

/**
 * The shell moves focus only between areas; within a nested area (e.g.
 * list -> detail) the sub-page heading `#page-title` gets it.
 */
export function useFocusHeadingOnSubpageChange() {
  const { pathname } = useLocation();
  const navigationType = useNavigationType();
  const previous = useRef<string | null>(null);
  useEffect(() => {
    const last = previous.current;
    previous.current = pathname;
    if (last === null || last === pathname || navigationType === 'REPLACE') return;
    document.getElementById('page-title')?.focus();
  }, [pathname, navigationType]);
}
