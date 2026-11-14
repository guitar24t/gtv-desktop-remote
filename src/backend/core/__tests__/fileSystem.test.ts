import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNodeFileSystem } from '../fileSystem';

describe('createNodeFileSystem().writeFile', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'gtv-fs-test-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('creates a private file with the requested mode', async () => {
    const target = path.join(directory, 'secret.key.pem');
    await createNodeFileSystem().writeFile(target, 'secret', 'utf8', 0o600);
    expect(await readFile(target, 'utf8')).toBe('secret');
    expect((await stat(target)).mode & 0o777).toBe(0o600);
  });

  it('tightens the mode of a file that already existed', async () => {
    const target = path.join(directory, 'existing.key.pem');
    await writeFile(target, 'old', { mode: 0o644 });
    await createNodeFileSystem().writeFile(target, 'new', 'utf8', 0o600);
    expect(await readFile(target, 'utf8')).toBe('new');
    expect((await stat(target)).mode & 0o777).toBe(0o600);
  });

  it('keeps default behaviour when no mode is given', async () => {
    const target = path.join(directory, 'plain.txt');
    await createNodeFileSystem().writeFile(target, 'plain', 'utf8');
    expect(await readFile(target, 'utf8')).toBe('plain');
  });
});
