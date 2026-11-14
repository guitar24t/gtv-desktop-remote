/**
 * Settles with `promise`, or rejects with `new Error(message)` once `ms`
 * elapses first. The timer is always cleared, and a late rejection from
 * `promise` stays handled (Promise.race subscribes to it), so a hung IPC
 * call can be abandoned without leaking an unhandled rejection.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(message));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}
