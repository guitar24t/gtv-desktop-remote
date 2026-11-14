/**
 * Atomic-as-possible replacement of a macOS `.app` bundle.
 *
 * Copying a new bundle over the live one (`ditto new.app live.app`) merges
 * the two trees: files removed in the new version survive, and a failure part
 * way through leaves a mixture of both versions. Instead the updater:
 *
 *   1. stages the verified bundle as a hidden sibling of the target, so it is
 *      on the same volume and the remaining steps are plain renames;
 *   2. renames the current bundle aside (another hidden sibling);
 *   3. renames the staged bundle into place;
 *   4. if step 3 fails, renames the original back before rethrowing.
 *
 * The bundle moved aside in step 2 then becomes the rollback backup (moved,
 * or copied when the backup folder is on another volume).
 *
 * File operations are injected so the algorithm can be tested against real
 * temporary directories with failures inserted at any step.
 */
import path from 'node:path';

export interface BundleFileOps {
  rename(from: string, to: string): Promise<void>;
  /** Copy a directory tree to a destination that does not exist yet. */
  copyDirectory(from: string, to: string): Promise<void>;
  /** Recursively remove a path; must succeed when the path does not exist. */
  remove(target: string): Promise<void>;
}

export type SiblingKind = 'update' | 'previous' | 'rollback';

/** Hidden sibling path used while swapping, e.g. `/Applications/.GTV Remote.app.update-<stamp>`. */
export function hiddenSiblingPath(target: string, kind: SiblingKind, stamp: string): string {
  return path.join(path.dirname(target), `.${path.basename(target)}.${kind}-${stamp}`);
}

export class BundleRestoreError extends Error {
  constructor(
    message: string,
    readonly installError: unknown,
    readonly restoreError: unknown
  ) {
    super(message, { cause: installError });
    this.name = 'BundleRestoreError';
  }
}

/**
 * Move `target` to `aside`, then `staged` to `target`. If the second rename
 * fails the original bundle is renamed back to `target` and the error is
 * rethrown, so the app is never left half-replaced. `staged` and `aside`
 * must be siblings of `target`.
 */
export async function swapBundleIntoPlace(
  ops: BundleFileOps,
  paths: { target: string; staged: string; aside: string }
): Promise<void> {
  await ops.rename(paths.target, paths.aside);
  try {
    await ops.rename(paths.staged, paths.target);
  } catch (installError) {
    try {
      await ops.rename(paths.aside, paths.target);
    } catch (restoreError) {
      throw new BundleRestoreError(
        `Installing the update failed and the original app could not be put back automatically. It was left at "${paths.aside}".`,
        installError,
        restoreError
      );
    }
    throw installError;
  }
}

function isCrossDeviceError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'EXDEV';
}

/**
 * Move a directory with `rename`, falling back to copy-then-remove when the
 * destination is on another volume (`EXDEV`). A failed copy removes its
 * partial destination and leaves the source untouched.
 */
export async function moveDirectory(
  ops: BundleFileOps,
  from: string,
  to: string
): Promise<'renamed' | 'copied'> {
  try {
    await ops.rename(from, to);
    return 'renamed';
  } catch (error) {
    if (!isCrossDeviceError(error)) throw error;
  }

  try {
    await ops.copyDirectory(from, to);
  } catch (copyError) {
    await ops.remove(to).catch(() => {
      // best-effort removal of the partial copy
    });
    throw copyError;
  }
  await ops.remove(from);
  return 'copied';
}
