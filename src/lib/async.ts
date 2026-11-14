/** Waits for `promise` to settle, but at most `ms`. True when it settled in time. Never rejects. */
export async function settleWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** `promise`, unless `signal` aborts first: then a rejection with `reason()`. */
export function raceSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  reason: () => Error,
): Promise<T> {
  if (signal.aborted) return Promise.reject(reason());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(reason());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.finally(() => signal.removeEventListener("abort", onAbort)).then(resolve, reject);
  });
}
