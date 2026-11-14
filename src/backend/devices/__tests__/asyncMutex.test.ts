import { describe, expect, it } from 'vitest';

import { AsyncMutex } from '../asyncMutex';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('AsyncMutex', () => {
  it('runs critical sections one at a time in FIFO order', async () => {
    const mutex = new AsyncMutex();
    const events: string[] = [];
    const gate = deferred();

    const first = mutex.runExclusive(async () => {
      events.push('first:start');
      await gate.promise;
      events.push('first:end');
      return 1;
    });
    const second = mutex.runExclusive(() => {
      events.push('second');
      return 2;
    });

    await Promise.resolve();
    expect(events).toEqual(['first:start']);
    gate.resolve();
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    expect(events).toEqual(['first:start', 'first:end', 'second']);
  });

  it('releases the lock after a rejected section and only that caller sees the error', async () => {
    const mutex = new AsyncMutex();
    const failed = mutex.runExclusive(() => Promise.reject(new Error('boom')));
    const next = mutex.runExclusive(() => 'ok');
    await expect(failed).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
  });

  it('prevents lost updates in concurrent read-modify-write sections', async () => {
    const mutex = new AsyncMutex();
    let stored = { host: '192.0.2.1', lastConnectedAt: undefined as string | undefined };
    const read = async () => {
      await Promise.resolve();
      return { ...stored };
    };
    const write = async (value: typeof stored) => {
      await Promise.resolve();
      stored = value;
    };

    await Promise.all([
      mutex.runExclusive(async () => write({ ...(await read()), host: '192.0.2.2' })),
      mutex.runExclusive(async () => write({ ...(await read()), lastConnectedAt: 'now' })),
    ]);

    expect(stored).toEqual({ host: '192.0.2.2', lastConnectedAt: 'now' });
  });
});
