import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', () => ({
  app: { getPath: () => native.userData },
}));

import { MAX_LOG_BYTES, logError, logInfo, serializeErrorDetails } from '../../../src/main/logger';

describe('main-process logger', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'gtv-logger-'));
    native.userData = path.join(root, 'profile');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('appends formatted lines to the profile log', async () => {
    await logInfo('scope', 'hello', { a: 1 });
    const contents = await readFile(path.join(native.userData, 'gtv-remote.log'), 'utf8');
    expect(contents).toMatch(/\[INFO\] \[scope\] hello \{"a":1\}\n$/);
  });

  it('never rejects when the log file cannot be written', async () => {
    // A regular file where the profile directory should be makes mkdir/append fail.
    await writeFile(native.userData, 'not a directory');
    await expect(logError('scope', 'disk full', new Error('ENOSPC'))).resolves.toBeUndefined();
    await expect(logInfo('scope', 'still fine')).resolves.toBeUndefined();
  });

  it('never rejects when the console stream is closed', async () => {
    vi.mocked(console.error).mockImplementation(() => {
      throw new Error('EPIPE');
    });
    await expect(logError('scope', 'console gone')).resolves.toBeUndefined();
  });

  it('serializes circular, BigInt and nested-error details without throwing', () => {
    const circular: Record<string, unknown> = { id: 1n };
    circular.self = circular;
    circular.cause = new Error('inner');
    const text = serializeErrorDetails(circular);
    expect(text).toContain('"id":"1"');
    expect(text).toContain('[Circular]');
    expect(text).toContain('inner');
    expect(
      serializeErrorDetails({
        toJSON() {
          throw new Error('boom');
        },
      })
    ).toBe('[object Object]');
  });

  it('rotates the log once it reaches the size limit', async () => {
    await logInfo('scope', 'seed');
    const logPath = path.join(native.userData, 'gtv-remote.log');
    await writeFile(logPath, 'x'.repeat(MAX_LOG_BYTES));
    await logInfo('scope', 'after rotation');
    expect((await stat(`${logPath}.1`)).size).toBe(MAX_LOG_BYTES);
    expect(await readFile(logPath, 'utf8')).toMatch(/after rotation\n$/);
  });
});
