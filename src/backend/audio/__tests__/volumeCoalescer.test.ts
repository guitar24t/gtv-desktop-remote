import { describe, expect, it, vi } from 'vitest';

import { createRelativeVolumeCoalescer, VolumeTimeoutError } from '../volumeCoalescer';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('relative volume coalescer', () => {
  it('sends presses made while a request is in flight as one combined adjustment', async () => {
    const calls: number[] = [];
    const firstReply = deferred<number>();
    const secondReply = deferred<number>();
    const send = vi.fn((delta: number) => {
      calls.push(delta);
      return calls.length === 1 ? firstReply.promise : secondReply.promise;
    });
    const coalescer = createRelativeVolumeCoalescer(send);

    const first = coalescer.adjust(2);
    await Promise.resolve();
    const second = coalescer.adjust(2);
    const third = coalescer.adjust(2);
    expect(calls).toEqual([2]);

    firstReply.resolve(22);
    await expect(first).resolves.toBe(22);
    await vi.waitFor(() => {
      expect(calls).toEqual([2, 4]);
    });
    secondReply.resolve(26);
    await expect(Promise.all([second, third])).resolves.toEqual([26, 26]);
  });

  it('nets out opposite presses in the same batch', async () => {
    const calls: number[] = [];
    const gate = deferred<number>();
    const coalescer = createRelativeVolumeCoalescer((delta) => {
      calls.push(delta);
      return calls.length === 1 ? gate.promise : Promise.resolve(30);
    });
    const first = coalescer.adjust(-2);
    await Promise.resolve();
    void coalescer.adjust(2);
    const last = coalescer.adjust(2);
    gate.resolve(28);
    await first;
    await expect(last).resolves.toBe(30);
    expect(calls).toEqual([-2, 4]);
  });

  it('rejects the failed batch but keeps serving later presses', async () => {
    let attempt = 0;
    const coalescer = createRelativeVolumeCoalescer(() => {
      attempt += 1;
      return attempt === 1 ? Promise.reject(new Error('unreachable')) : Promise.resolve(12);
    });
    await expect(coalescer.adjust(1)).rejects.toThrow('unreachable');
    await expect(coalescer.adjust(1)).resolves.toBe(12);
  });

  it('times out a request that never answers', async () => {
    vi.useFakeTimers();
    try {
      const coalescer = createRelativeVolumeCoalescer(() => new Promise<number>(() => undefined), {
        timeoutMs: 1000,
      });
      const pending = coalescer.adjust(2);
      const assertion = expect(pending).rejects.toBeInstanceOf(VolumeTimeoutError);
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
