import { useEffect, useState, useSyncExternalStore } from 'react';
import { DutyEditLease, type LeaseApi, type LeaseStatus } from './duty-edit-lease';

/**
 * One edit lease for the lifetime of the calling editor (keyed by duty).
 * Acquired on mount, renewed while mounted, released on unmount and when the
 * page is hidden for good (pagehide, keepalive request). A page restored from
 * the back/forward cache acquires again, which the editor treats like any new
 * grant (it re-checks the duty's version).
 */
export function useDutyEditLease(api: LeaseApi, planId: string, dutyId: string): { lease: DutyEditLease; status: LeaseStatus } {
  // The editor is keyed by duty, so api/plan/duty never change for this instance.
  const [lease] = useState(() => new DutyEditLease(api, planId, dutyId));
  const status = useSyncExternalStore(lease.subscribe, lease.getStatus);

  useEffect(() => {
    void lease.acquire();
    const onPageHide = () => lease.stop({ keepalive: true });
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) void lease.acquire();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') lease.resume();
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      document.removeEventListener('visibilitychange', onVisibility);
      lease.stop();
    };
  }, [lease]);

  return { lease, status };
}
