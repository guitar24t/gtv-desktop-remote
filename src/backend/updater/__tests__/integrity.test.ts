import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  assertBundleMatches,
  DownloadVerifier,
  parseSha256Digest,
  readBundleMetadata,
  readPlistString,
} from '../integrity';

const payload = Buffer.from('a release archive');
const sha256 = createHash('sha256').update(payload).digest('hex');

function plist(entries: Record<string, string>): string {
  const body = Object.entries(entries)
    .map(([key, value]) => `<key>${key}</key>\n\t<string>${value}</string>`)
    .join('\n\t');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n\t${body}\n</dict>\n</plist>\n`;
}

describe('parseSha256Digest', () => {
  it('accepts GitHub sha256 digests and normalises to lower case', () => {
    expect(parseSha256Digest(`sha256:${sha256}`)).toBe(sha256);
    expect(parseSha256Digest(`sha256:${sha256.toUpperCase()}`)).toBe(sha256);
  });

  it.each([undefined, null, '', sha256, `sha512:${sha256}`, 'sha256:abc', 42])(
    'rejects %s',
    (value) => {
      expect(parseSha256Digest(value)).toBeUndefined();
    }
  );
});

describe('DownloadVerifier', () => {
  it('hashes streamed chunks and accepts a matching size and digest', () => {
    const verifier = new DownloadVerifier({ size: payload.length, sha256 });
    verifier.update(payload.subarray(0, 5));
    verifier.update(payload.subarray(5));
    expect(verifier.receivedBytes).toBe(payload.length);
    expect(verifier.finish()).toEqual({ bytes: payload.length, sha256 });
  });

  it('rejects a digest mismatch of the same size', () => {
    const tampered = Buffer.from(payload);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    const verifier = new DownloadVerifier({ size: payload.length, sha256 });
    verifier.update(tampered);
    expect(() => verifier.finish()).toThrow(/SHA-256/);
  });

  it('rejects a truncated download', () => {
    const verifier = new DownloadVerifier({ size: payload.length, sha256 });
    verifier.update(payload.subarray(0, 3));
    expect(() => verifier.finish()).toThrow(/size mismatch/);
  });

  it('aborts as soon as more bytes arrive than were published', () => {
    const verifier = new DownloadVerifier({ size: 4, sha256 });
    expect(() => {
      verifier.update(payload);
    }).toThrow(/larger than/);
  });

  it('only reports the digest when nothing is expected', () => {
    const verifier = new DownloadVerifier();
    verifier.update(payload);
    expect(verifier.finish()).toEqual({ bytes: payload.length, sha256 });
  });
});

describe('Info.plist metadata', () => {
  const xml = plist({
    CFBundleIdentifier: 'com.utkarsh.gtvdesktopremote',
    CFBundleName: 'GTV &amp; Remote',
    CFBundleShortVersionString: '2.3.0',
  });

  it('reads string values and decodes XML entities', () => {
    expect(readPlistString(xml, 'CFBundleName')).toBe('GTV & Remote');
    expect(readPlistString(xml, 'Missing')).toBeUndefined();
  });

  it('extracts identifier and normalised version', () => {
    expect(readBundleMetadata(xml)).toEqual({
      identifier: 'com.utkarsh.gtvdesktopremote',
      version: '2.3.0',
    });
    expect(readBundleMetadata(plist({ CFBundleShortVersionString: 'v1.0.0' }))).toEqual({
      version: '1.0.0',
    });
  });

  it('accepts a bundle for this app at the release version', () => {
    expect(() => {
      assertBundleMatches(
        { identifier: 'com.utkarsh.gtvdesktopremote', version: '2.3.0' },
        { identifier: 'com.utkarsh.gtvdesktopremote', version: 'v2.3.0' }
      );
    }).not.toThrow();
  });

  it('rejects another app or a missing identifier', () => {
    expect(() => {
      assertBundleMatches(
        { identifier: 'com.example.other', version: '2.3.0' },
        { identifier: 'com.utkarsh.gtvdesktopremote', version: '2.3.0' }
      );
    }).toThrow(/bundle identifier "com.example.other"/);
    expect(() => {
      assertBundleMatches({ version: '2.3.0' }, { identifier: 'com.utkarsh.gtvdesktopremote' });
    }).toThrow(/missing/);
  });

  it('rejects a bundle whose version is not the offered release', () => {
    expect(() => {
      assertBundleMatches(
        { identifier: 'id', version: '2.2.0' },
        { identifier: 'id', version: '2.3.0' }
      );
    }).toThrow(/reports version 2.2.0, expected 2.3.0/);
    expect(() => {
      assertBundleMatches({ identifier: 'id' }, { identifier: 'id', version: '2.3.0' });
    }).toThrow(/version missing/);
  });

  it('skips the version check when none is expected (rollback backups)', () => {
    expect(() => {
      assertBundleMatches({ identifier: 'id', version: '1.0.0' }, { identifier: 'id' }, 'Backup');
    }).not.toThrow();
    expect(() => {
      assertBundleMatches({ identifier: 'other' }, { identifier: 'id' }, 'Backup');
    }).toThrow(/^Backup has bundle identifier/);
  });
});
