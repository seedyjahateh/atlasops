/**
 * Time, as a dependency.
 *
 * Durations are the point of this package, so the clock cannot be `Date.now()` reached for
 * directly. A test that measures a real duration is a test that either sleeps — making the suite
 * slow for no information — or asserts something vague like "greater than zero", which passes for a
 * stopwatch that is wired backwards.
 *
 * With an injected clock a span's duration is an exact, asserted number.
 */

export interface Clock {
  /** Milliseconds, monotonic within a process. Not wall-clock time. */
  now: () => number;
}

/**
 * `performance.now()` rather than `Date.now()`.
 *
 * Wall-clock time goes backwards — NTP corrections, leap smearing, a VM resuming — and a negative
 * span duration corrupts every aggregate built on top of it. A monotonic source cannot do that.
 */
export const systemClock: Clock = {
  now: (): number => performance.now(),
};

export interface ManualClock extends Clock {
  /** Move time forward. Rejects going backwards, which a monotonic clock cannot do. */
  advance: (milliseconds: number) => void;
}

export function manualClock(startAt = 0): ManualClock {
  let current = startAt;
  return {
    now: (): number => current,
    advance: (milliseconds: number): void => {
      if (milliseconds < 0) {
        throw new RangeError(
          `a monotonic clock cannot move backwards (received ${String(milliseconds)})`,
        );
      }
      current += milliseconds;
    },
  };
}
