/**
 * Minimal FIFO async mutex. `runExclusive` callbacks run one at a time in the
 * order they were queued; a rejected callback releases the lock and its error
 * is returned only to its own caller.
 *
 * Used to serialize read-modify-write sections of `devices.json` so that a
 * scan's host update and a connect's `lastConnectedAt` write cannot clobber
 * each other. Keep network work outside the critical section.
 */
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  runExclusive<T>(task: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
