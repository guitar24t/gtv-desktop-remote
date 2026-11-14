/**
 * Pre-download checks that the running bundle can actually be replaced.
 *
 * The updater swaps bundles with renames inside the bundle's parent folder,
 * so both the bundle and its parent must be writable. macOS App Translocation
 * (an app launched from a quarantined download location) and read-only disk
 * images fail those requirements; discovering that only after a full download
 * wastes bandwidth, so `assertInstallLocationWritable` runs first.
 */
import path from 'node:path';

export const MOVE_TO_APPLICATIONS_HINT =
  'Move GTV Remote to your Applications folder, then try again.';

/** An updater failure whose message is written for the user and safe to show as-is. */
export class UpdaterUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpdaterUserError';
  }
}

/** True when macOS launched the bundle from a randomized, read-only translocation mount. */
export function isTranslocatedBundlePath(bundlePath: string): boolean {
  return bundlePath.split(path.sep).includes('AppTranslocation');
}

/**
 * Throws `UpdaterUserError` unless `bundlePath` and its parent folder are
 * writable and the bundle is not translocated. `canWrite` is injected so the
 * check is testable (production passes an `fs.access(W_OK)` probe).
 */
export async function assertInstallLocationWritable(
  bundlePath: string,
  canWrite: (target: string) => Promise<boolean>
): Promise<void> {
  if (isTranslocatedBundlePath(bundlePath)) {
    throw new UpdaterUserError(
      `GTV Remote is running from a temporary read-only location created by macOS (App Translocation), so it can't update itself. ${MOVE_TO_APPLICATIONS_HINT}`
    );
  }

  const parent = path.dirname(bundlePath);
  for (const target of [bundlePath, parent]) {
    if (!(await canWrite(target))) {
      throw new UpdaterUserError(
        `GTV Remote can't update itself because "${parent}" is not writable (for example, a disk image or a folder owned by another user). ${MOVE_TO_APPLICATIONS_HINT}`
      );
    }
  }
}
