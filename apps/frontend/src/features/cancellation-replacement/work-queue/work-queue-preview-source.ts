import { systemClock, type Clock } from '../../../shared/time/clock';
import { buildWorkQueueFixtures } from './work-queue-fixtures';
import type { WorkQueueSource } from './work-queue-types';

/**
 * Preview adapter: serves synthetic fixtures from memory. No network call, no
 * persistence, no invented endpoint. Replace with a contract-backed source
 * once the Work Queue API exists.
 */
export function createWorkQueuePreviewSource(clock: Clock): WorkQueueSource {
  return {
    kind: 'preview',
    load: () => Promise.resolve(buildWorkQueueFixtures(clock)),
  };
}

export const defaultWorkQueueSource = createWorkQueuePreviewSource(systemClock);
