/**
 * Integrity checks for downloaded update archives and extracted bundles.
 *
 * GitHub publishes a `size` and a `digest` (`"sha256:<hex>"`) for every
 * release asset. The updater refuses to install unless the streamed download
 * matches both, and unless the extracted bundle claims to be this app at the
 * release's version. Nothing here touches Electron or the network.
 */
import { createHash, type Hash } from 'node:crypto';

import { compareVersions, normalizeVersion } from './version';

/** Values the downloaded bytes must match, taken from the release asset. */
export interface ExpectedDownload {
  /** Exact byte count published by GitHub for the asset. */
  readonly size: number;
  /** Lower-case hex SHA-256 published by GitHub for the asset. */
  readonly sha256: string;
}

export interface DownloadDigest {
  readonly bytes: number;
  readonly sha256: string;
}

/**
 * Parse GitHub's release-asset `digest` field (`"sha256:<64 hex>"`). Returns
 * the lower-case hex digest, or `undefined` when the field is missing, uses a
 * different algorithm, or is malformed.
 */
export function parseSha256Digest(digest: unknown): string | undefined {
  if (typeof digest !== 'string') return undefined;
  const match = /^sha256:([0-9a-f]{64})$/i.exec(digest.trim());
  return match?.[1]?.toLowerCase();
}

/**
 * Hash and count bytes while a download streams, then compare against the
 * published size and digest. `update()` throws as soon as more bytes arrive
 * than were published, so an oversized response is abandoned early.
 */
export class DownloadVerifier {
  private readonly hash: Hash = createHash('sha256');

  private bytes = 0;

  constructor(private readonly expected?: ExpectedDownload) {}

  get receivedBytes(): number {
    return this.bytes;
  }

  update(chunk: Uint8Array): void {
    this.bytes += chunk.byteLength;
    if (this.expected && this.bytes > this.expected.size) {
      throw new Error(
        `Downloaded update is larger than the ${String(this.expected.size)} bytes published for this release.`
      );
    }
    this.hash.update(chunk);
  }

  /** Finalise the hash and verify it. Call once, after the last chunk. */
  finish(): DownloadDigest {
    const sha256 = this.hash.digest('hex');
    if (this.expected) {
      if (this.bytes !== this.expected.size) {
        throw new Error(
          `Downloaded update size mismatch: expected ${String(this.expected.size)} bytes, received ${String(this.bytes)}.`
        );
      }
      if (sha256 !== this.expected.sha256.toLowerCase()) {
        throw new Error(
          'Downloaded update failed SHA-256 verification: it does not match the digest published for this release.'
        );
      }
    }
    return { bytes: this.bytes, sha256 };
  }
}

const XML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Read a top-level `<key>…</key><string>…</string>` pair from an XML property list. */
export function readPlistString(plistXml: string, key: string): string | undefined {
  const match = new RegExp(
    `<key>\\s*${escapeRegExp(key)}\\s*</key>\\s*<string>([^<]*)</string>`
  ).exec(plistXml);
  const raw = match?.[1];
  if (raw === undefined) return undefined;
  return raw
    .replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => XML_ENTITIES[entity] ?? entity)
    .trim();
}

export interface BundleMetadata {
  readonly identifier?: string;
  readonly version?: string;
}

/** Extract `CFBundleIdentifier` and `CFBundleShortVersionString` from Info.plist XML. */
export function readBundleMetadata(plistXml: string): BundleMetadata {
  const identifier = readPlistString(plistXml, 'CFBundleIdentifier');
  const version = readPlistString(plistXml, 'CFBundleShortVersionString');
  return {
    ...(identifier ? { identifier } : {}),
    ...(version ? { version: normalizeVersion(version) } : {}),
  };
}

/**
 * Refuse a bundle that is not this app (bundle identifier) or not the release
 * that was offered (short version string).
 */
export function assertBundleMatches(
  actual: BundleMetadata,
  expected: { identifier: string; version?: string },
  subject = 'Downloaded app'
): void {
  if (actual.identifier !== expected.identifier) {
    throw new Error(
      `${subject} has bundle identifier "${actual.identifier ?? 'missing'}", expected "${expected.identifier}". Refusing to install it.`
    );
  }
  if (expected.version !== undefined) {
    if (actual.version === undefined || compareVersions(actual.version, expected.version) !== 0) {
      throw new Error(
        `${subject} reports version ${actual.version ?? 'missing'}, expected ${normalizeVersion(expected.version)}. Refusing to install it.`
      );
    }
  }
}
