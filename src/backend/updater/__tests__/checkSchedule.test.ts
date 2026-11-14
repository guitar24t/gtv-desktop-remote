import { describe, expect, it } from 'vitest';

import {
  BACKGROUND_CHECK_INTERVAL_MS,
  FAILED_CHECK_BACKOFF_MS,
  nextBackgroundCheckAt,
  shouldRunBackgroundCheck,
} from '../checkSchedule';

const T0 = 1_800_000_000_000;

describe('background check schedule', () => {
  it('runs when no check has happened yet', () => {
    expect(shouldRunBackgroundCheck(undefined, T0)).toBe(true);
  });

  it('waits the full interval after a completed check', () => {
    const attempt = { at: T0, ok: true };
    expect(shouldRunBackgroundCheck(attempt, T0 + BACKGROUND_CHECK_INTERVAL_MS - 1)).toBe(false);
    expect(shouldRunBackgroundCheck(attempt, T0 + BACKGROUND_CHECK_INTERVAL_MS)).toBe(true);
  });

  it('backs off for a shorter interval after a failed check', () => {
    expect(FAILED_CHECK_BACKOFF_MS).toBeLessThan(BACKGROUND_CHECK_INTERVAL_MS);
    const attempt = { at: T0, ok: false };
    expect(shouldRunBackgroundCheck(attempt, T0 + 60_000)).toBe(false);
    expect(shouldRunBackgroundCheck(attempt, T0 + FAILED_CHECK_BACKOFF_MS)).toBe(true);
  });

  it('honours a rate-limit reset that is later than the back-off', () => {
    const retryNotBefore = T0 + 40 * 60_000;
    const attempt = { at: T0, ok: false, retryNotBefore };
    expect(nextBackgroundCheckAt(attempt)).toBe(retryNotBefore);
    expect(shouldRunBackgroundCheck(attempt, T0 + FAILED_CHECK_BACKOFF_MS)).toBe(false);
    expect(shouldRunBackgroundCheck(attempt, retryNotBefore)).toBe(true);
  });

  it('does not stay suppressed when the clock moves backwards', () => {
    expect(shouldRunBackgroundCheck({ at: T0, ok: true }, T0 - 1)).toBe(true);
  });
});
