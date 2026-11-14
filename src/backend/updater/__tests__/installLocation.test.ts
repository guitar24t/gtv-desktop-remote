import { describe, expect, it, vi } from 'vitest';

import {
  assertInstallLocationWritable,
  isTranslocatedBundlePath,
  MOVE_TO_APPLICATIONS_HINT,
  UpdaterUserError,
} from '../installLocation';

const bundle = '/Applications/GTV Remote.app';

describe('install location preflight', () => {
  it('detects App Translocation mounts', () => {
    expect(
      isTranslocatedBundlePath(
        '/private/var/folders/x1/abc/T/AppTranslocation/0F1E2D3C/d/GTV Remote.app'
      )
    ).toBe(true);
    expect(isTranslocatedBundlePath(bundle)).toBe(false);
    expect(isTranslocatedBundlePath('/Users/me/AppTranslocationNotes/GTV Remote.app')).toBe(false);
  });

  it('accepts a writable bundle in a writable folder', async () => {
    const canWrite = vi.fn().mockResolvedValue(true);
    await expect(assertInstallLocationWritable(bundle, canWrite)).resolves.toBeUndefined();
    expect(canWrite.mock.calls.map(([target]: unknown[]) => target)).toEqual([
      bundle,
      '/Applications',
    ]);
  });

  it('refuses a translocated bundle without probing the file system', async () => {
    const canWrite = vi.fn().mockResolvedValue(true);
    const translocated = '/private/var/folders/x/T/AppTranslocation/ID/d/GTV Remote.app';
    const failure = assertInstallLocationWritable(translocated, canWrite);
    await expect(failure).rejects.toBeInstanceOf(UpdaterUserError);
    await expect(failure).rejects.toThrow(MOVE_TO_APPLICATIONS_HINT);
    expect(canWrite).not.toHaveBeenCalled();
  });

  it.each([
    ['the bundle', bundle],
    ['its parent folder (e.g. a read-only disk image)', '/Applications'],
  ])('refuses when %s is not writable', async (_label, readOnly) => {
    const canWrite = vi.fn((target: string) => Promise.resolve(target !== readOnly));
    const failure = assertInstallLocationWritable(bundle, canWrite);
    await expect(failure).rejects.toBeInstanceOf(UpdaterUserError);
    await expect(failure).rejects.toThrow(
      /"\/Applications" is not writable.*Move GTV Remote to your Applications folder, then try again\./
    );
  });
});
