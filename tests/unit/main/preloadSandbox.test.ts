import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The remote window runs with `sandbox: true`. A sandboxed preload can only
 * `require('electron')` (plus a few Node built-ins), so any runtime import of a
 * local module would break the whole renderer bridge at startup.
 */
describe('preload sandbox compatibility', () => {
  it('imports nothing at runtime except electron', () => {
    const source = readFileSync(path.resolve(__dirname, '../../../src/main/preload.ts'), 'utf8');
    const runtimeImports = [
      ...source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'([^']+)'/gms),
    ].map((match) => match[1]);
    expect(runtimeImports).toEqual(['electron']);
    expect(source).not.toMatch(/\brequire\(/);
  });
});
