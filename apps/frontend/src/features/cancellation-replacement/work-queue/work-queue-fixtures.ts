import { syntheticExampleShift } from '../../../shared/preview/synthetic-shift-times';
import type { ShiftType } from '../../../shared/shift/shift-view';
import type { Clock } from '../../../shared/time/clock';
import { addDays, todayOf } from '../../../shared/time/month';
import type { WorkQueueCase } from './work-queue-types';

/**
 * Synthetic in-memory fixtures for the Work Queue UI preview only.
 * Names, projects, dates and shift times are invented examples. They are not
 * real persons, not an API payload and not approved business rules.
 * Dates are relative to the injected clock so the preview stays current and tests stay deterministic.
 */
const SYNTHETIC_CASES: ReadonlyArray<{
  reference: string;
  employeeName: string;
  projectName: string;
  shiftInDays: number;
  shiftType: ShiftType;
  receivedDaysAgo: number;
  replacementOfferCount: number;
}> = [
  { reference: 'VORSCHAU-101', employeeName: 'Alex Beispiel', projectName: 'Demo-Objekt Nord', shiftInDays: 1, shiftType: 'NIGHT', receivedDaysAgo: 0, replacementOfferCount: 0 },
  { reference: 'VORSCHAU-102', employeeName: 'Kim Muster', projectName: 'Demo-Objekt Hafen', shiftInDays: 2, shiftType: 'DAY', receivedDaysAgo: 1, replacementOfferCount: 2 },
  { reference: 'VORSCHAU-103', employeeName: 'Jona Probe', projectName: 'Demo-Objekt Nord', shiftInDays: 3, shiftType: 'DAY', receivedDaysAgo: 1, replacementOfferCount: 1 },
  { reference: 'VORSCHAU-104', employeeName: 'Sam Demo', projectName: 'Demo-Objekt Messe', shiftInDays: 5, shiftType: 'NIGHT', receivedDaysAgo: 2, replacementOfferCount: 3 },
  { reference: 'VORSCHAU-105', employeeName: 'Mika Test', projectName: 'Demo-Objekt Hafen', shiftInDays: 8, shiftType: 'NIGHT', receivedDaysAgo: 2, replacementOfferCount: 0 },
  { reference: 'VORSCHAU-106', employeeName: 'Robin Platzhalter', projectName: 'Demo-Objekt Messe', shiftInDays: 12, shiftType: 'DAY', receivedDaysAgo: 3, replacementOfferCount: 4 },
];

export function buildWorkQueueFixtures(clock: Clock): WorkQueueCase[] {
  const today = todayOf(clock);
  return SYNTHETIC_CASES.map((fixture) => ({
    reference: fixture.reference,
    employeeName: fixture.employeeName,
    projectName: fixture.projectName,
    shift: syntheticExampleShift(addDays(today, fixture.shiftInDays), fixture.shiftType),
    cancellationReceivedOn: addDays(today, -fixture.receivedDaysAgo),
    replacementOfferCount: fixture.replacementOfferCount,
  }));
}
