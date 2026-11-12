import type { StatusTone } from '../../../shared/ui/StatusBadge';

/**
 * Read model of the SP-19 administrative work queue, as documented in
 * docs/api/admin-work-queue.openapi.json. The UI keeps the server values as
 * they are: eligibility is a current read-time assessment from the server and
 * is never recalculated in the browser.
 */
export type CaseType = 'CANCELLATION_REQUEST' | 'REPLACEMENT_NEED';
export type OfferPresence = 'WITH_ELIGIBLE' | 'WITHOUT_ELIGIBLE';
export type QueueSortBy = 'createdAt' | 'dutyDate';
export type SortOrder = 'asc' | 'desc';
export type ShiftKind = 'DAY' | 'NIGHT';
export const CANCELLATION_STATUSES_LIST = ['OPEN', 'WITHDRAWN', 'REJECTED', 'APPROVED', 'OBSOLETE'] as const;
export type CancellationStatus = (typeof CANCELLATION_STATUSES_LIST)[number];
export type NeedStatus = 'OPEN' | 'OPEN_UNFILLED' | 'RESOLVED' | 'CLOSED';
export type OfferStatus = 'OPEN' | 'SELECTED' | 'NOT_SELECTED' | 'INVALIDATED' | 'WITHDRAWN';
export type ReviewEligibility = 'ELIGIBLE' | 'INELIGIBLE' | 'NOT_APPLICABLE';

/** Page size used by both admin reads (the API default). */
export const PAGE_SIZE = 25;

export type EmployeeRef = { id: string; employeeCode: string; firstName: string; lastName: string };
export type DutyRef = {
  id: string;
  dutyDate: string;
  shiftKind: ShiftKind;
  /** UTC instants; display them in the saved duty time zone, never in the browser zone. */
  startsAt: string;
  endsAt: string;
};
export type ProjectRef = { id: string; name: string };
export type Pagination = { page: number; pageSize: number; totalItems: number; totalPages: number };

export type QueueItem = {
  type: CaseType;
  cancellationRequestId: string;
  replacementNeedId: string;
  duty: DutyRef;
  requestingEmployee: EmployeeRef;
  cancellationStatus: CancellationStatus;
  replacementNeedStatus: NeedStatus;
  /** All open offers of the need. */
  openOfferCount: number;
  /** Subset of the open offers that meets the current criteria for a new offer. Not a selection right. */
  eligibleOpenOfferCount: number;
  project: ProjectRef;
  monthStart: string;
  timeZone: string;
  createdAt: string;
};

export type QueuePage = { items: QueueItem[]; pagination: Pagination; evaluatedAt: string };

export type AdminOffer = {
  id: string;
  needId: string;
  employee: EmployeeRef;
  status: OfferStatus;
  createdAt: string;
  decidedAt: string | null;
  reviewEligibility: ReviewEligibility;
};

export type CaseCancellation = {
  id: string;
  assignmentId: string;
  employee: EmployeeRef;
  duty: DutyRef;
  status: CancellationStatus;
  createdAt: string;
  decidedAt: string | null;
  replacementNeed: { id: string; status: NeedStatus; resolvedAt: string | null };
};

export type CaseNeed = {
  id: string;
  cancellationRequestId: string;
  duty: DutyRef;
  status: NeedStatus;
  resolvedAt: string | null;
  openOfferCount: number;
  project: ProjectRef;
  timeZone: string;
  /** Need version: Expected-Version for the SP-20 selection and the SP-21 APPROVE header. */
  concurrencyVersion: number;
  /** SP-21 S5-READ-01: duty version, the `expectedDutyVersion` of an APPROVE. Never derived from the need version. */
  dutyConcurrencyVersion: number;
  /** SP-20: the selected offer of a RESOLVED need; null otherwise. */
  selectedOfferId: string | null;
};

export type ReplacementAssignmentRef = {
  id: string;
  employeeId: string;
  source: 'REPLACEMENT';
  state: 'ACTIVE';
};

export type CaseContext = {
  cancellation: CaseCancellation;
  need: CaseNeed;
  monthStart: string;
  dutyRemoved: boolean;
  originalAssignmentActive: boolean;
  eligibleOpenOfferCount: number;
  /** SP-20: CONSISTENT only when the selected offer and its membership agree. */
  consistency: 'CONSISTENT' | 'INCONSISTENT';
  replacementAssignment: ReplacementAssignmentRef | null;
  evaluatedAt: string;
};

/** SP-20: the server's answer to a successful selection (only the fields the case view uses). */
export type SelectionResult = {
  needId: string;
  cancellationRequestId: string;
  needVersion: number;
  selectedOfferId: string;
};

/**
 * SP-21: the immutable decision receipt of REJECT or APPROVE without replacement, as stored at decision time
 * (a same-key replay returns the identical receipt). It is shown as the outcome; it is never rebuilt from reads.
 */
export type DecisionReceipt =
  | { decision: 'REJECT'; cancellation: CaseCancellation & { status: 'REJECTED' }; selectedOffer: null; updatedDuty: null }
  | {
      decision: 'APPROVE';
      cancellation: CaseCancellation & { status: 'APPROVED' };
      selectedOffer: null;
      updatedDuty: DutyRef & { concurrencyVersion: number };
    };

export type OffersPage = { items: AdminOffer[]; pagination: Pagination; context: CaseContext };

/** Validated UI query. `month` is `YYYY-MM`; the API receives `YYYY-MM-01`. */
export type QueueQuery = {
  type: CaseType | null;
  offerPresence: OfferPresence | null;
  projectId: string | null;
  month: string | null;
  page: number;
  sortBy: QueueSortBy;
  sortOrder: SortOrder;
};

export type OffersQuery = { status: OfferStatus | null; page: number };

export const CASE_TYPE_LABELS: Record<CaseType, string> = {
  CANCELLATION_REQUEST: 'Absage',
  REPLACEMENT_NEED: 'Ersatzbedarf',
};

export const SHIFT_LABELS: Record<ShiftKind, string> = {
  DAY: 'Tagdienst',
  NIGHT: 'Nachtdienst',
};

// Labels match the employee views (CancellationAction, OwnCancellations) so the same status reads the same everywhere.
export const CANCELLATION_LABELS: Record<CancellationStatus, { label: string; tone: StatusTone }> = {
  OPEN: { label: 'Offen', tone: 'info' },
  WITHDRAWN: { label: 'Zurückgezogen', tone: 'neutral' },
  REJECTED: { label: 'Abgelehnt', tone: 'neutral' },
  APPROVED: { label: 'Genehmigt', tone: 'success' },
  OBSOLETE: { label: 'Gegenstandslos', tone: 'neutral' },
};

export const NEED_LABELS: Record<NeedStatus, { label: string; tone: StatusTone }> = {
  OPEN: { label: 'Offen', tone: 'info' },
  OPEN_UNFILLED: { label: 'Unbesetzt', tone: 'attention' },
  RESOLVED: { label: 'Besetzt', tone: 'success' },
  CLOSED: { label: 'Geschlossen', tone: 'neutral' },
};

export const OFFER_LABELS: Record<OfferStatus, { label: string; tone: StatusTone }> = {
  OPEN: { label: 'Offen', tone: 'info' },
  SELECTED: { label: 'Ausgewählt', tone: 'success' },
  NOT_SELECTED: { label: 'Nicht ausgewählt', tone: 'neutral' },
  INVALIDATED: { label: 'Nicht mehr gültig', tone: 'attention' },
  WITHDRAWN: { label: 'Zurückgezogen', tone: 'neutral' },
};

/** Describes the current criteria for submitting a new offer only, not a selection right. */
export const ELIGIBILITY_LABELS: Record<ReviewEligibility, { label: string; tone: StatusTone }> = {
  ELIGIBLE: { label: 'Aktuell geeignet', tone: 'success' },
  INELIGIBLE: { label: 'Aktuell nicht geeignet', tone: 'attention' },
  NOT_APPLICABLE: { label: 'Nicht anwendbar', tone: 'neutral' },
};
