/**
 * Serializes relative volume changes to one speaker. While a change is in
 * flight, further presses are summed and sent as one adjustment when it
 * settles, so holding a volume key never builds a backlog of requests.
 */
export interface RelativeVolumeCoalescer {
  /** Resolves with the speaker's volume after the batch containing `delta`. */
  adjust(delta: number): Promise<number>;
}

interface Waiter {
  resolve: (volume: number) => void;
  reject: (error: unknown) => void;
}

export const DEFAULT_VOLUME_TIMEOUT_MS = 4000;

export class VolumeTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`The speaker did not respond within ${String(timeoutMs / 1000)} seconds.`);
    this.name = 'VolumeTimeoutError';
  }
}

export function createRelativeVolumeCoalescer(
  send: (delta: number) => Promise<number>,
  {
    timeoutMs = DEFAULT_VOLUME_TIMEOUT_MS,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  }: {
    timeoutMs?: number;
    setTimer?: (callback: () => void, ms: number) => unknown;
    clearTimer?: (handle: never) => void;
  } = {}
): RelativeVolumeCoalescer {
  let inFlight = false;
  let pendingDelta = 0;
  let pendingWaiters: Waiter[] = [];

  function withTimeout(promise: Promise<number>): Promise<number> {
    return new Promise((resolve, reject) => {
      const handle = setTimer(() => {
        reject(new VolumeTimeoutError(timeoutMs));
      }, timeoutMs);
      promise.then(
        (value) => {
          clearTimer(handle as never);
          resolve(value);
        },
        (error: unknown) => {
          clearTimer(handle as never);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      );
    });
  }

  function pump(): void {
    if (inFlight || pendingWaiters.length === 0) return;
    const delta = pendingDelta;
    const waiters = pendingWaiters;
    pendingDelta = 0;
    pendingWaiters = [];
    inFlight = true;
    withTimeout(Promise.resolve().then(() => send(delta)))
      .then(
        (volume) => {
          for (const waiter of waiters) waiter.resolve(volume);
        },
        (error: unknown) => {
          for (const waiter of waiters) waiter.reject(error);
        }
      )
      .finally(() => {
        inFlight = false;
        pump();
      });
  }

  return {
    adjust(delta) {
      return new Promise<number>((resolve, reject) => {
        pendingDelta += delta;
        pendingWaiters.push({ resolve, reject });
        pump();
      });
    },
  };
}
