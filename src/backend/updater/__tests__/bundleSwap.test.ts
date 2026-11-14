import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BundleRestoreError,
  hiddenSiblingPath,
  moveDirectory,
  swapBundleIntoPlace,
  type BundleFileOps,
} from '../bundleSwap';

let root: string;

async function writeBundle(bundle: string, files: Record<string, string>) {
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(bundle, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
  }
}

async function listFiles(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const entries = await fs.readdir(directory, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolute = path.join(entry.parentPath, entry.name);
    result[path.relative(directory, absolute)] = await fs.readFile(absolute, 'utf8');
  }
  return result;
}

function realOps(overrides: Partial<BundleFileOps> = {}): BundleFileOps {
  return {
    rename: (from, to) => fs.rename(from, to),
    copyDirectory: (from, to) => fs.cp(from, to, { recursive: true, errorOnExist: true }),
    remove: (target) => fs.rm(target, { recursive: true, force: true }),
    ...overrides,
  };
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

const OLD = { 'Contents/Info.plist': 'old', 'Contents/Resources/stale.txt': 'stale' };
const NEW = { 'Contents/Info.plist': 'new', 'Contents/MacOS/GTV Remote': 'new binary' };

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'gtv-bundle-swap-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('hiddenSiblingPath', () => {
  it('builds a hidden sibling in the same folder', () => {
    expect(hiddenSiblingPath('/Applications/GTV Remote.app', 'update', '1-ab')).toBe(
      '/Applications/.GTV Remote.app.update-1-ab'
    );
  });
});

describe('swapBundleIntoPlace', () => {
  it('replaces the bundle wholesale (no merged stale files) and keeps the old one aside', async () => {
    const target = path.join(root, 'GTV Remote.app');
    const staged = hiddenSiblingPath(target, 'update', '1');
    const aside = hiddenSiblingPath(target, 'previous', '1');
    await writeBundle(target, OLD);
    await writeBundle(staged, NEW);

    await swapBundleIntoPlace(realOps(), { target, staged, aside });

    expect(await listFiles(target)).toEqual(NEW);
    expect(await listFiles(aside)).toEqual(OLD);
    await expect(fs.access(staged)).rejects.toThrow();
  });

  it('puts the original back when moving the staged bundle into place fails', async () => {
    const target = path.join(root, 'GTV Remote.app');
    const staged = hiddenSiblingPath(target, 'update', '1');
    const aside = hiddenSiblingPath(target, 'previous', '1');
    await writeBundle(target, OLD);
    await writeBundle(staged, NEW);
    const ops = realOps({
      rename: async (from, to) => {
        if (from === staged) throw errno('EIO');
        await fs.rename(from, to);
      },
    });

    await expect(swapBundleIntoPlace(ops, { target, staged, aside })).rejects.toThrow('EIO');

    expect(await listFiles(target)).toEqual(OLD);
    await expect(fs.access(aside)).rejects.toThrow();
  });

  it('leaves the live bundle untouched when it cannot be moved aside', async () => {
    const target = path.join(root, 'GTV Remote.app');
    const staged = hiddenSiblingPath(target, 'update', '1');
    const aside = hiddenSiblingPath(target, 'previous', '1');
    await writeBundle(target, OLD);
    await writeBundle(staged, NEW);
    const ops = realOps({
      rename: async (from, to) => {
        if (from === target) throw errno('EACCES');
        await fs.rename(from, to);
      },
    });

    await expect(swapBundleIntoPlace(ops, { target, staged, aside })).rejects.toThrow('EACCES');
    expect(await listFiles(target)).toEqual(OLD);
    expect(await listFiles(staged)).toEqual(NEW);
  });

  it('reports where the original was left if restoring it also fails', async () => {
    const target = path.join(root, 'GTV Remote.app');
    const staged = hiddenSiblingPath(target, 'update', '1');
    const aside = hiddenSiblingPath(target, 'previous', '1');
    await writeBundle(target, OLD);
    await writeBundle(staged, NEW);
    const ops = realOps({
      rename: async (from, to) => {
        if (from === staged || from === aside) throw errno('EIO');
        await fs.rename(from, to);
      },
    });

    const failure = swapBundleIntoPlace(ops, { target, staged, aside });
    await expect(failure).rejects.toBeInstanceOf(BundleRestoreError);
    await expect(failure).rejects.toThrow(aside);
    expect(await listFiles(aside)).toEqual(OLD);
  });
});

describe('moveDirectory', () => {
  it('renames within a volume', async () => {
    const from = path.join(root, 'from.app');
    const to = path.join(root, 'backup', 'to.app');
    await writeBundle(from, OLD);
    await fs.mkdir(path.dirname(to));

    await expect(moveDirectory(realOps(), from, to)).resolves.toBe('renamed');
    expect(await listFiles(to)).toEqual(OLD);
    await expect(fs.access(from)).rejects.toThrow();
  });

  it('copies then removes the source when rename crosses volumes (EXDEV)', async () => {
    const from = path.join(root, 'from.app');
    const to = path.join(root, 'backup', 'to.app');
    await writeBundle(from, OLD);
    await fs.mkdir(path.dirname(to));
    const ops = realOps({
      rename: () => Promise.reject(errno('EXDEV')),
    });

    await expect(moveDirectory(ops, from, to)).resolves.toBe('copied');
    expect(await listFiles(to)).toEqual(OLD);
    await expect(fs.access(from)).rejects.toThrow();
  });

  it('keeps the source and removes a partial copy when the EXDEV copy fails', async () => {
    const from = path.join(root, 'from.app');
    const to = path.join(root, 'backup', 'to.app');
    await writeBundle(from, OLD);
    const ops = realOps({
      rename: () => Promise.reject(errno('EXDEV')),
      copyDirectory: async (_from, destination) => {
        await writeBundle(destination, { partial: 'x' });
        throw errno('ENOSPC');
      },
    });

    await expect(moveDirectory(ops, from, to)).rejects.toThrow('ENOSPC');
    expect(await listFiles(from)).toEqual(OLD);
    await expect(fs.access(to)).rejects.toThrow();
  });

  it('does not copy on other rename errors', async () => {
    const from = path.join(root, 'from.app');
    await writeBundle(from, OLD);
    let copied = false;
    const ops = realOps({
      rename: () => Promise.reject(errno('EACCES')),
      copyDirectory: () => {
        copied = true;
        return Promise.resolve();
      },
    });

    await expect(moveDirectory(ops, from, path.join(root, 'to.app'))).rejects.toThrow('EACCES');
    expect(copied).toBe(false);
  });
});
