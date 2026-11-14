import { readFileSync } from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { IFileSystem } from '../../../core/fileSystem';
import type { ILogger } from '../../../core/logger';
import type { IPathProvider } from '../../../core/pathProvider';
import type { generateCertificate } from '../../../protocol/androidtv/certificate';
import { AndroidTvCertStore, isValidPemPair } from '../androidTvCertStore';

/**
 * In-memory IFileSystem for tests. Files are stored as a Map<absPath, content>.
 * Directories are implicit — `mkdir` is a no-op (Map keys are flat). Write
 * modes and the write/rename sequence are recorded.
 */
function makeFakeFs(seed?: Record<string, string>): IFileSystem & {
  dump: () => Record<string, string>;
  modes: Map<string, number | undefined>;
  operations: string[];
} {
  const files = new Map<string, string>(Object.entries(seed ?? {}));
  const modes = new Map<string, number | undefined>();
  const operations: string[] = [];
  return {
    readFile: (p, _enc) => {
      const v = files.get(p);
      if (v === undefined) {
        return Promise.reject(Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' }));
      }
      return Promise.resolve(v);
    },
    writeFile: (p, contents, _enc, mode) => {
      operations.push(`write ${p}`);
      files.set(p, contents);
      modes.set(p, mode);
      return Promise.resolve();
    },
    mkdir: () => Promise.resolve(),
    rm: (p, _opts) => {
      operations.push(`rm ${p}`);
      files.delete(p);
      return Promise.resolve();
    },
    rmRecursive: (prefix) => {
      // Best-effort recursive delete: drop every key starting with the prefix.
      for (const key of [...files.keys()]) {
        if (key === prefix || key.startsWith(`${prefix}/`)) {
          files.delete(key);
        }
      }
      return Promise.resolve();
    },
    rename: (from, to) => {
      operations.push(`rename ${from} -> ${to}`);
      const v = files.get(from);
      if (v === undefined) {
        return Promise.reject(Object.assign(new Error(`ENOENT: ${from}`), { code: 'ENOENT' }));
      }
      files.delete(from);
      files.set(to, v);
      modes.set(to, modes.get(from));
      modes.delete(from);
      return Promise.resolve();
    },
    exists: (p) => Promise.resolve(files.has(p)),
    chmod: (p, mode) => {
      operations.push(`chmod ${p} ${mode.toString(8)}`);
      modes.set(p, mode);
      return Promise.resolve();
    },
    dump: () => Object.fromEntries(files),
    modes,
    operations,
  };
}

const STATE_DIR = '/tmp/cert-state';
const paths: IPathProvider = {
  getCertStateDir: () => STATE_DIR,
  getAppDataPath: (...segments) => [STATE_DIR, ...segments].join('/'),
};

// Real, matching PEM pairs (public protocol fixtures) so the store's
// node:crypto validation runs for real.
const FIXTURES = path.resolve(__dirname, '../../../../../tests/integration/fixtures/protocol');
const CLIENT_CERT = readFileSync(path.join(FIXTURES, 'client-certificate.pem'), 'utf8');
const CLIENT_KEY = readFileSync(path.join(FIXTURES, 'client-key.pem'), 'utf8');
const OTHER_CERT = readFileSync(path.join(FIXTURES, 'server-certificate.pem'), 'utf8');

const GENERATED = { cert: CLIENT_CERT, key: CLIENT_KEY };
const DEVICE_ID = '3f0c7c38-8c7e-4c55-9b55-6d1f1f0a2b11';
const MAC = 'AA:BB:CC:DD:EE:01';

function files(key: string): { cert: string; key: string; pin: string } {
  const safe = key.replaceAll(':', '_');
  return {
    cert: `${STATE_DIR}/${safe}.cert.pem`,
    key: `${STATE_DIR}/${safe}.key.pem`,
    pin: `${STATE_DIR}/${safe}.server-pin.json`,
  };
}

function seedPair(key: string, cert = CLIENT_CERT, privateKey = CLIENT_KEY) {
  return { [files(key).cert]: cert, [files(key).key]: privateKey };
}

describe('AndroidTvCertStore — Google TV non-regression gate', () => {
  let fs: ReturnType<typeof makeFakeFs>;
  let logger: {
    info: Mock<ILogger['info']>;
    warn: Mock<ILogger['warn']>;
    error: Mock<ILogger['error']>;
  };
  let generator: Mock<typeof generateCertificate>;
  let store: AndroidTvCertStore;

  function useFs(seed: Record<string, string>): void {
    fs = makeFakeFs(seed);
    store = new AndroidTvCertStore(fs, paths, logger, generator);
  }

  beforeEach(() => {
    logger = {
      info: vi.fn<ILogger['info']>(),
      warn: vi.fn<ILogger['warn']>(),
      error: vi.fn<ILogger['error']>(),
    };
    generator = vi.fn<typeof generateCertificate>().mockReturnValue(GENERATED);
    useFs({});
  });

  describe('getFilesForCertKey', () => {
    it('returns canonical paths under getCertStateDir()', () => {
      const { certPath, keyPath } = store.getFilesForCertKey('AA:BB:CC:DD:EE:FF');
      expect(certPath).toBe(`${STATE_DIR}/AA_BB_CC_DD_EE_FF.cert.pem`);
      expect(keyPath).toBe(`${STATE_DIR}/AA_BB_CC_DD_EE_FF.key.pem`);
    });

    it('sanitises both colons and slashes — same key gives same path', () => {
      const a = store.getFilesForCertKey('AA:BB:CC');
      const b = store.getFilesForCertKey('AA_BB_CC');
      expect(a.certPath).toBe(b.certPath);
    });

    it('sanitises slashes in hostnames (e.g. CIDR-like keys)', () => {
      const { certPath } = store.getFilesForCertKey('host/with/slashes');
      expect(certPath).toBe(`${STATE_DIR}/host_with_slashes.cert.pem`);
    });

    it('handles plain hostnames and device ids unchanged', () => {
      expect(store.getFilesForCertKey('192.168.1.5').certPath).toBe(
        `${STATE_DIR}/192.168.1.5.cert.pem`
      );
      expect(store.getFilesForCertKey(DEVICE_ID).keyPath).toBe(`${STATE_DIR}/${DEVICE_ID}.key.pem`);
    });

    it('keeps the server pin next to the pair, not as a .pem file', () => {
      expect(store.getPinPathForCertKey(DEVICE_ID)).toBe(files(DEVICE_ID).pin);
    });
  });

  describe('isValidPemPair', () => {
    it('accepts a matching certificate and key', () => {
      expect(isValidPemPair({ cert: CLIENT_CERT, key: CLIENT_KEY })).toBe(true);
    });

    it('rejects a certificate that belongs to a different key', () => {
      expect(isValidPemPair({ cert: OTHER_CERT, key: CLIENT_KEY })).toBe(false);
    });

    it('rejects unparsable PEM data', () => {
      expect(isValidPemPair({ cert: 'garbage', key: CLIENT_KEY })).toBe(false);
      expect(isValidPemPair({ cert: CLIENT_CERT, key: 'garbage' })).toBe(false);
    });
  });

  describe('loadOrCreate', () => {
    it('generates and persists a new cert pair when none exists', async () => {
      const result = await store.loadOrCreate(DEVICE_ID);
      expect(result).toEqual(GENERATED);
      expect(generator).toHaveBeenCalledTimes(1);
      const dump = fs.dump();
      expect(dump[files(DEVICE_ID).cert]).toBe(CLIENT_CERT);
      expect(dump[files(DEVICE_ID).key]).toBe(CLIENT_KEY);
      expect(logger.info.mock.calls).toContainEqual([
        'androidTvCertStore',
        'Generated new client certificate',
        { certKey: DEVICE_ID },
      ]);
    });

    it('writes the private key 0600 through a temporary file and rename', async () => {
      await store.loadOrCreate(DEVICE_ID);
      const keyWrite = fs.operations.find(
        (op) => op.startsWith('write ') && op.includes(`.${DEVICE_ID}.key.pem.`)
      );
      expect(keyWrite).toMatch(/\.tmp$/);
      const temporary = keyWrite?.slice('write '.length) ?? '';
      expect(fs.operations).toContain(`rename ${temporary} -> ${files(DEVICE_ID).key}`);
      expect(fs.modes.get(files(DEVICE_ID).key)).toBe(0o600);
      // Nothing is ever written directly to the final paths.
      expect(fs.operations).not.toContain(`write ${files(DEVICE_ID).key}`);
      expect(fs.operations).not.toContain(`write ${files(DEVICE_ID).cert}`);
      expect(Object.keys(fs.dump()).filter((p) => p.endsWith('.tmp'))).toEqual([]);
    });

    it('removes the temporary file and surfaces the error when the rename fails', async () => {
      vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk full'));
      await expect(store.loadOrCreate(DEVICE_ID)).rejects.toThrow('disk full');
      expect(Object.keys(fs.dump())).toEqual([]);
    });

    it('loads an existing valid cert pair without regenerating', async () => {
      useFs(seedPair(DEVICE_ID));
      const result = await store.loadOrCreate(DEVICE_ID);
      expect(result).toEqual({ cert: CLIENT_CERT, key: CLIENT_KEY });
      expect(generator).not.toHaveBeenCalled();
      expect(logger.info.mock.calls).toHaveLength(0);
    });

    it('restricts an existing world-readable private key to the owner when loading it', async () => {
      useFs(seedPair(DEVICE_ID));
      expect(fs.modes.get(files(DEVICE_ID).key)).toBeUndefined();
      await store.loadOrCreate(DEVICE_ID);
      expect(fs.modes.get(files(DEVICE_ID).key)).toBe(0o600);
    });

    it('restricts a key adopted from a legacy name', async () => {
      useFs(seedPair(MAC));
      await store.loadOrCreate(DEVICE_ID, [MAC]);
      expect(fs.modes.get(files(DEVICE_ID).key)).toBe(0o600);
    });

    it('still loads the pair when permissions cannot be changed', async () => {
      useFs(seedPair(DEVICE_ID));
      vi.spyOn(fs, 'chmod').mockRejectedValueOnce(new Error('EPERM'));
      await expect(store.loadOrCreate(DEVICE_ID)).resolves.toEqual(GENERATED);
      expect(logger.warn).toHaveBeenCalled();
      expect(generator).not.toHaveBeenCalled();
    });

    it('regenerates if cert exists but key is missing (partial state)', async () => {
      useFs({ [files(DEVICE_ID).cert]: CLIENT_CERT });
      const result = await store.loadOrCreate(DEVICE_ID);
      expect(result).toEqual(GENERATED);
      expect(generator).toHaveBeenCalledTimes(1);
    });

    it('logs and regenerates a corrupt PEM pair', async () => {
      useFs(seedPair(DEVICE_ID, 'not a certificate', CLIENT_KEY));
      const result = await store.loadOrCreate(DEVICE_ID);
      expect(result).toEqual(GENERATED);
      expect(generator).toHaveBeenCalledTimes(1);
      expect(fs.dump()[files(DEVICE_ID).cert]).toBe(CLIENT_CERT);
      expect(logger.error).toHaveBeenCalledWith(
        'androidTvCertStore',
        expect.stringContaining('generating a new one'),
        { certKey: DEVICE_ID }
      );
    });

    it('regenerates a certificate that does not match its key', async () => {
      useFs(seedPair(DEVICE_ID, OTHER_CERT, CLIENT_KEY));
      await store.loadOrCreate(DEVICE_ID);
      expect(generator).toHaveBeenCalledTimes(1);
      expect(fs.dump()[files(DEVICE_ID).cert]).toBe(CLIENT_CERT);
    });
  });

  describe('legacy adoption (MAC/host-keyed pairs from older releases)', () => {
    it('adopts the MAC-keyed pair by rename when the device has no id-keyed pair', async () => {
      useFs(seedPair(MAC));
      const result = await store.loadOrCreate(DEVICE_ID, [MAC, '192.168.1.5']);
      expect(result).toEqual({ cert: CLIENT_CERT, key: CLIENT_KEY });
      expect(generator).not.toHaveBeenCalled();
      expect(fs.dump()).toEqual(seedPair(DEVICE_ID));
      expect(logger.info.mock.calls).toContainEqual([
        'androidTvCertStore',
        'Adopted legacy client certificate',
        { certKey: DEVICE_ID, legacyCertKey: MAC },
      ]);
    });

    it('prefers the MAC-keyed pair and leaves the host-keyed pair alone', async () => {
      useFs({ ...seedPair(MAC), ...seedPair('192.168.1.5') });
      await store.loadOrCreate(DEVICE_ID, [MAC, '192.168.1.5']);
      expect(fs.dump()).toEqual({ ...seedPair(DEVICE_ID), ...seedPair('192.168.1.5') });
    });

    it('falls back to the host-keyed pair when there is no MAC-keyed pair', async () => {
      useFs(seedPair('192.168.1.5'));
      await store.loadOrCreate(DEVICE_ID, [MAC, '192.168.1.5']);
      expect(fs.dump()).toEqual(seedPair(DEVICE_ID));
      expect(generator).not.toHaveBeenCalled();
    });

    it('never deletes or overwrites an existing id-keyed pair, and leaves the legacy source', async () => {
      useFs({ ...seedPair(DEVICE_ID), ...seedPair(MAC) });
      await store.loadOrCreate(DEVICE_ID, [MAC]);
      expect(fs.dump()).toEqual({ ...seedPair(DEVICE_ID), ...seedPair(MAC) });
      expect(generator).not.toHaveBeenCalled();
      expect(
        fs.operations.filter((op) => op.startsWith('rm ') || op.startsWith('rename '))
      ).toEqual([]);
    });

    it('does not adopt when only part of the id-keyed pair exists', async () => {
      useFs({ [files(DEVICE_ID).key]: CLIENT_KEY, ...seedPair(MAC) });
      expect(await store.adoptLegacy(DEVICE_ID, [MAC])).toBeUndefined();
      expect(fs.dump()[files(MAC).cert]).toBe(CLIENT_CERT);
    });

    it('skips incomplete or invalid legacy pairs without deleting them', async () => {
      useFs({
        [files(MAC).cert]: CLIENT_CERT,
        ...seedPair('192.168.1.5', 'corrupt', CLIENT_KEY),
      });
      expect(await store.adoptLegacy(DEVICE_ID, [MAC, '192.168.1.5'])).toBeUndefined();
      expect(fs.dump()).toEqual({
        [files(MAC).cert]: CLIENT_CERT,
        ...seedPair('192.168.1.5', 'corrupt', CLIENT_KEY),
      });
    });

    it('puts the certificate back if the key rename fails', async () => {
      useFs(seedPair(MAC));
      const rename = fs.rename.bind(fs);
      vi.spyOn(fs, 'rename').mockImplementation((from, to) =>
        from === files(MAC).key ? Promise.reject(new Error('EXDEV')) : rename(from, to)
      );
      expect(await store.adoptLegacy(DEVICE_ID, [MAC])).toBeUndefined();
      expect(fs.dump()).toEqual(seedPair(MAC));
    });

    it('ignores a legacy key that maps to the same files', async () => {
      useFs(seedPair('AA_BB'));
      expect(await store.adoptLegacy('AA:BB', ['AA_BB'])).toBeUndefined();
      expect(fs.dump()).toEqual(seedPair('AA_BB'));
    });
  });

  describe('server pin', () => {
    it('round-trips a pinned fingerprint written atomically with mode 0600', async () => {
      await store.writePin(DEVICE_ID, 'AB:CD:EF');
      expect(await store.readPin(DEVICE_ID)).toBe('AB:CD:EF');
      expect(fs.modes.get(files(DEVICE_ID).pin)).toBe(0o600);
      expect(fs.operations.some((op) => op.startsWith(`write ${files(DEVICE_ID).pin}`))).toBe(
        false
      );
    });

    it('returns undefined when no pin exists, and treats an unreadable pin as absent', async () => {
      expect(await store.readPin(DEVICE_ID)).toBeUndefined();
      useFs({ [files(DEVICE_ID).pin]: '{not json' });
      expect(await store.readPin(DEVICE_ID)).toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        'androidTvCertStore',
        'Ignoring unreadable server pin',
        { certKey: DEVICE_ID }
      );
    });

    it('clearPin removes only the pin', async () => {
      useFs({ ...seedPair(DEVICE_ID), [files(DEVICE_ID).pin]: '{"fingerprint256":"AA"}' });
      await store.clearPin(DEVICE_ID);
      expect(fs.dump()).toEqual(seedPair(DEVICE_ID));
    });
  });

  describe('clear', () => {
    it('removes the pair and pin for the key', async () => {
      useFs({ ...seedPair(DEVICE_ID), [files(DEVICE_ID).pin]: '{"fingerprint256":"AA"}' });
      await store.clear(DEVICE_ID);
      expect(fs.dump()).toEqual({});
    });

    it('is a no-op if files are already gone', async () => {
      await expect(store.clear(DEVICE_ID)).resolves.toBeUndefined();
    });

    it('forgets one identity without touching another device or user files', async () => {
      useFs({
        ...seedPair(DEVICE_ID),
        ...seedPair('other-device'),
        [`${STATE_DIR}/notes.txt`]: 'user-data',
      });
      await store.clear(DEVICE_ID);
      expect(fs.dump()).toEqual({
        ...seedPair('other-device'),
        [`${STATE_DIR}/notes.txt`]: 'user-data',
      });
      expect(await store.loadOrCreate(DEVICE_ID)).toEqual(GENERATED);
      expect(generator).toHaveBeenCalledOnce();
    });

    it('does not hide filesystem failures during authorization deletion', async () => {
      vi.spyOn(fs, 'rm').mockRejectedValueOnce(new Error('permission denied'));
      await expect(store.clear(DEVICE_ID)).rejects.toThrow('permission denied');
    });
  });
});
