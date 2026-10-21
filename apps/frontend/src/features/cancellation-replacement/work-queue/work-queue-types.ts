import type { ReadSource } from '../../../shared/data/data-source';
import type { ShiftView } from '../../../shared/shift/shift-view';
import type { DateOnly } from '../../../shared/time/month';

/**
 * UI view model of one open cancellation/replacement case in the admin Work Queue.
 * This is NOT the API contract: a future contract-backed source maps the
 * approved `/admin/work-queue` read model into this shape.
 */
export interface WorkQueueCase {
  /** Display reference only; not a server identifier. */
  reference: string;
  employeeName: string;
  projectName: string;
  shift: ShiftView;
  cancellationReceivedOn: DateOnly;
  replacementOfferCount: number;
}

export type WorkQueueSource = ReadSource<null, WorkQueueCase[]>;

export type WorkQueueSegment = 'all' | 'with-offers' | 'without-offers';
