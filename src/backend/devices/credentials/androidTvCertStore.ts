import { createPrivateKey, randomUUID, X509Certificate } from 'node:crypto';
import path from 'node:path';

import type { IFileSystem } from '../../core/fileSystem';
import { silentLogger, type ILogger } from '../../core/logger';
import type { IPathProvider } from '../../core/pathProvider';
import { generateCertificate, type PemPair } from '../../protocol/androidtv/certificate';

const SERVICE_NAME = 'gtv-desktop-remote';
const PRIVATE_FILE_MODE = 0o600;

/**
 * True iff `pair.key` parses as a private key and `pair.cert` parses as an
 * X.509 certificate whose public key belongs to that private key.
 */
export function isValidPemPair(pair: PemPair): boolean {
  try {
    const privateKey = createPrivateKey(pair.key);
    return new X509Certificate(pair.cert).checkPrivateKey(privateKey);
  } catch {
    return false;
  }
}

/**
 * Persists the per-device client certificate pair that the Android TV pairing
 * protocol exchanges, plus the TV's pinned server-certificate fingerprint.
 *
 * Current installs key everything by the saved device's `id` (a random UUID
 * that survives IP changes and re-saves). Older installs keyed the pair by MAC
 * address or by host; `loadOrCreate` adopts such a legacy pair by rename the
 * first time the device is used, and never deletes or overwrites a pair that
 * already exists under the new key.
 *
 * **This class is a Google TV non-regression gate.** Any change to the
 * cert-on-disk layout, the legacy adoption rules, or the safe-key scheme
 * breaks pairing for every user who upgrades. The tests under
 * `__tests__/androidTvCertStore.test.ts` lock down the contract.
 */
export class AndroidTvCertStore {
  constructor(
    private readonly fs: IFileSystem,
    private readonly paths: IPathProvider,
    private readonly logger: ILogger = silentLogger,
    private readonly generateCert: (commonName: string) => PemPair = generateCertificate,
    private readonly validatePair: (pair: PemPair) => boolean = isValidPemPair
  ) {}

  /**
   * Returns the on-disk paths for a given cert key (device id, or a legacy
   * MAC/host key). Colons and slashes in the key are replaced with `_` so the
   * result is safe on every platform.
   */
  getFilesForCertKey(certKey: string): { certPath: string; keyPath: string } {
    const stateDir = this.paths.getCertStateDir();
    const safeKey = this.safeKey(certKey);

    return {
      certPath: path.join(stateDir, `${safeKey}.cert.pem`),
      keyPath: path.join(stateDir, `${safeKey}.key.pem`),
    };
  }

  /** Path of the pinned TV server-certificate fingerprint for `certKey`. */
  getPinPathForCertKey(certKey: string): string {
    return path.join(this.paths.getCertStateDir(), `${this.safeKey(certKey)}.server-pin.json`);
  }

  /**
   * Loads the cert pair for `certKey`. When no pair exists under that key,
   * the first complete, valid pair found under `legacyCertKeys` (in order) is
   * adopted by rename. If there is still no valid pair, a fresh one is
   * generated and persisted (an unreadable or mismatched pair is replaced).
   */
  async loadOrCreate(certKey: string, legacyCertKeys: readonly string[] = []): Promise<PemPair> {
    if (legacyCertKeys.length) {
      await this.adoptLegacy(certKey, legacyCertKeys);
    }

    const existing = await this.load(certKey);
    if (existing) {
      return existing;
    }

    const certs = this.generateCert(SERVICE_NAME);
    const { certPath, keyPath } = this.getFilesForCertKey(certKey);
    await this.fs.mkdir(this.paths.getCertStateDir(), { recursive: true });
    await this.writeAtomic(keyPath, certs.key, PRIVATE_FILE_MODE);
    await this.writeAtomic(certPath, certs.cert);
    this.logger.info('androidTvCertStore', 'Generated new client certificate', { certKey });
    return certs;
  }

  /**
   * Renames the first complete, valid legacy pair onto `certKey`. Does
   * nothing (and deletes nothing) when any file already exists under
   * `certKey`. Returns the adopted legacy key, if any.
   */
  async adoptLegacy(
    certKey: string,
    legacyCertKeys: readonly string[]
  ): Promise<string | undefined> {
    const target = this.getFilesForCertKey(certKey);
    if ((await this.fs.exists(target.certPath)) || (await this.fs.exists(target.keyPath))) {
      return undefined;
    }

    for (const legacyCertKey of legacyCertKeys) {
      const source = this.getFilesForCertKey(legacyCertKey);
      if (source.certPath === target.certPath) {
        continue;
      }
      const legacyPair = await this.readPair(source.certPath, source.keyPath);
      if (!legacyPair) {
        continue;
      }
      if (!this.validatePair(legacyPair)) {
        this.logger.warn('androidTvCertStore', 'Skipping invalid legacy client certificate', {
          certKey,
          legacyCertKey,
        });
        continue;
      }

      await this.fs.mkdir(this.paths.getCertStateDir(), { recursive: true });
      try {
        await this.fs.rename(source.certPath, target.certPath);
      } catch (error) {
        this.logger.warn('androidTvCertStore', 'Could not adopt legacy client certificate', {
          certKey,
          legacyCertKey,
          error: String(error),
        });
        return undefined;
      }
      try {
        await this.fs.rename(source.keyPath, target.keyPath);
      } catch (error) {
        // Put the certificate back so the legacy pair stays whole.
        await this.fs.rename(target.certPath, source.certPath).catch(() => undefined);
        this.logger.warn('androidTvCertStore', 'Could not adopt legacy client certificate', {
          certKey,
          legacyCertKey,
          error: String(error),
        });
        return undefined;
      }
      this.logger.info('androidTvCertStore', 'Adopted legacy client certificate', {
        certKey,
        legacyCertKey,
      });
      return legacyCertKey;
    }

    return undefined;
  }

  /**
   * Removes the cert pair and server pin for the given key. Best-effort: no
   * error if the files were already gone, but other filesystem failures
   * surface so callers never report a forgotten authorization that remains.
   */
  async clear(certKey: string): Promise<void> {
    const { certPath, keyPath } = this.getFilesForCertKey(certKey);
    await Promise.all([
      this.fs.rm(certPath, { force: true }),
      this.fs.rm(keyPath, { force: true }),
      this.fs.rm(this.getPinPathForCertKey(certKey), { force: true }),
    ]);
  }

  /** Returns the pinned SHA-256 server fingerprint for `certKey`, if any. */
  async readPin(certKey: string): Promise<string | undefined> {
    const pinPath = this.getPinPathForCertKey(certKey);
    if (!(await this.fs.exists(pinPath))) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(await this.fs.readFile(pinPath, 'utf8')) as {
        fingerprint256?: unknown;
      };
      if (typeof parsed.fingerprint256 === 'string' && parsed.fingerprint256) {
        return parsed.fingerprint256;
      }
    } catch {
      // Fall through: an unreadable pin is treated as absent.
    }
    this.logger.warn('androidTvCertStore', 'Ignoring unreadable server pin', { certKey });
    return undefined;
  }

  /** Atomically records `fingerprint256` as the trusted TV certificate. */
  async writePin(certKey: string, fingerprint256: string): Promise<void> {
    await this.fs.mkdir(this.paths.getCertStateDir(), { recursive: true });
    await this.writeAtomic(
      this.getPinPathForCertKey(certKey),
      `${JSON.stringify({ fingerprint256, pinnedAt: new Date().toISOString() }, null, 2)}\n`,
      PRIVATE_FILE_MODE
    );
  }

  /** Removes the pinned TV certificate so the next connection re-pins. */
  async clearPin(certKey: string): Promise<void> {
    await this.fs.rm(this.getPinPathForCertKey(certKey), { force: true });
  }

  private safeKey(certKey: string): string {
    return certKey.replaceAll(':', '_').replaceAll('/', '_');
  }

  private async load(certKey: string): Promise<PemPair | undefined> {
    const { certPath, keyPath } = this.getFilesForCertKey(certKey);
    const pair = await this.readPair(certPath, keyPath);
    if (!pair) {
      return undefined;
    }
    if (!this.validatePair(pair)) {
      this.logger.error(
        'androidTvCertStore',
        'Stored client certificate is unreadable or does not match its key; generating a new one',
        { certKey }
      );
      return undefined;
    }
    // Keys written by older releases (or adopted from legacy names by rename)
    // kept the default world-readable mode; restrict them to the owner.
    try {
      await this.fs.chmod?.(keyPath, PRIVATE_FILE_MODE);
    } catch (error) {
      this.logger.warn('androidTvCertStore', 'Could not restrict private key permissions', {
        certKey,
        error: String(error),
      });
    }
    return pair;
  }

  private async readPair(certPath: string, keyPath: string): Promise<PemPair | undefined> {
    if (!(await this.fs.exists(certPath)) || !(await this.fs.exists(keyPath))) {
      return undefined;
    }
    const [cert, key] = await Promise.all([
      this.fs.readFile(certPath, 'utf8'),
      this.fs.readFile(keyPath, 'utf8'),
    ]);
    return { cert, key };
  }

  private async writeAtomic(filePath: string, contents: string, mode?: number): Promise<void> {
    const temporary = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.${randomUUID()}.tmp`
    );
    try {
      await this.fs.writeFile(temporary, contents, 'utf8', mode);
      await this.fs.rename(temporary, filePath);
    } catch (error) {
      try {
        await this.fs.rm(temporary, { force: true });
      } catch {
        // Best-effort cleanup; keep the original failure.
      }
      throw error;
    }
  }
}
