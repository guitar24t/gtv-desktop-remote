import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { withTimeout } from '../async';

describe('withTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the value when the promise settles first', async () => {
    await expect(withTimeout(Promise.resolve('done'), 100, 'late')).resolves.toBe('done');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('passes through a rejection that arrives first', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 100, 'late')).rejects.toThrow(
      'boom'
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects with the timeout message when the promise never settles', async () => {
    const result = withTimeout(new Promise<never>(() => undefined), 100, 'took too long');
    const assertion = expect(result).rejects.toThrow('took too long');
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
  });

  it('keeps a rejection that arrives after the timeout handled', async () => {
    let reject!: (error: Error) => void;
    const late = new Promise<never>((_resolve, rejectLate) => {
      reject = rejectLate;
    });
    const result = withTimeout(late, 50, 'took too long');
    const assertion = expect(result).rejects.toThrow('took too long');
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    reject(new Error('late failure'));
    await Promise.resolve();
  });
});
