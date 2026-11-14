/**
 * Background update-check throttling.
 *
 * The renderer asks for a background check on every window focus, and the
 * unauthenticated GitHub API allows 60 requests per hour per network. Every
 * completed check (up to date, skipped, no compatible asset, update available)
 * starts the normal interval; a failed check starts a shorter back-off, which a
 * GitHub rate-limit reset time can extend.
 */

export const BACKGROUND_CHECK_INTERVAL_MS = 15 * 60 * 1_000;
export const FAILED_CHECK_BACKOFF_MS = 5 * 60 * 1_000;

export interface CheckAttempt {
  /** Epoch ms when the check finished. */
  readonly at: number;
  readonly ok: boolean;
  /** Epoch ms before which no background check should run (e.g. rate-limit reset). */
  readonly retryNotBefore?: number;
}

export function nextBackgroundCheckAt(attempt: CheckAttempt): number {
  const interval = attempt.ok ? BACKGROUND_CHECK_INTERVAL_MS : FAILED_CHECK_BACKOFF_MS;
  return Math.max(attempt.at + interval, attempt.retryNotBefore ?? 0);
}

export function shouldRunBackgroundCheck(attempt: CheckAttempt | undefined, now: number): boolean {
  if (!attempt) return true;
  // A clock that moved backwards must not suppress checks indefinitely.
  if (now < attempt.at) return true;
  return now >= nextBackgroundCheckAt(attempt);
}
