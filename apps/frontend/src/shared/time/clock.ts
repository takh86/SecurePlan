/**
 * Source of the current time. Only `systemClock` reads the real date, so views
 * and fixtures stay deterministic when tests inject a fixed clock.
 */
export type Clock = () => Date;

export const systemClock: Clock = () => new Date();
