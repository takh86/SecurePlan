/**
 * Injectable wall clock. Business "current month" rules read the time through
 * this token so tests can pin an exact instant (month-boundary tests); the
 * month itself is always derived in the company's IANA time zone, never in UTC.
 */
export const WALL_CLOCK = Symbol('WALL_CLOCK');

export type WallClock = () => Date;

export const systemWallClock: WallClock = () => new Date();
