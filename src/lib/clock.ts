/** Wall-clock time as epoch milliseconds. Inject a fake in tests. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};
