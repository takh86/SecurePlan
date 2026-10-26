import { employmentCovers } from './project-assignments.service.js';

describe('SP-09 ? employmentCovers (historical employee corrections)', () => {
  const covers = (start: string | null, end: string | null, month: string) =>
    employmentCovers({ employment_start: start, employment_end: end }, month);

  it('missing employment start is "no evidence", never valid', () => {
    expect(covers(null, null, '2026-10-01')).toBe(false);
    expect(covers(null, '2027-01-01', '2026-10-01')).toBe(false);
  });

  it('requires an overlap with the whole calendar month; boundaries are inclusive', () => {
    expect(covers('2026-01-01', null, '2026-10-01')).toBe(true);
    expect(covers('2026-10-31', null, '2026-10-01')).toBe(true); // starts on the last day
    expect(covers('2026-11-01', null, '2026-10-01')).toBe(false); // starts the day after
    expect(covers('2025-01-01', '2026-10-01', '2026-10-01')).toBe(true); // ends on the first day
    expect(covers('2025-01-01', '2026-09-30', '2026-10-01')).toBe(false); // ended the day before
  });

  it('knows month lengths, including leap February', () => {
    expect(covers('2028-02-29', null, '2028-02-01')).toBe(true);
    expect(covers('2027-02-29', null, '2027-02-01')).toBe(false); // not a real date; compares after Feb 28
    expect(covers('2028-03-01', null, '2028-02-01')).toBe(false);
  });
});
