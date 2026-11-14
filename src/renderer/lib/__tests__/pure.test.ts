/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';

import {
  classes,
  isConnectionUnavailableError,
  isEditableTarget,
  sanitizePairCode,
  shouldRestartPairingFlow,
} from '../pure';

describe('isEditableTarget (jsdom)', () => {
  it('returns false for null', () => {
    expect(isEditableTarget(null)).toBe(false);
  });

  it('returns false for non-HTMLElement targets (e.g. window)', () => {
    expect(isEditableTarget(window)).toBe(false);
  });

  it.each(['INPUT', 'TEXTAREA', 'SELECT'])(
    'returns true for <%s> (typing surface, suppresses remote shortcuts)',
    (tag) => {
      const el = document.createElement(tag.toLowerCase());
      expect(isEditableTarget(el)).toBe(true);
    }
  );

  it('returns true for a contenteditable host', () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'isContentEditable', { value: true, configurable: true });
    expect(isEditableTarget(el)).toBe(true);
  });

  it('returns false for a plain <div>', () => {
    expect(isEditableTarget(document.createElement('div'))).toBe(false);
  });

  it('returns false for a <button>', () => {
    expect(isEditableTarget(document.createElement('button'))).toBe(false);
  });
});

describe('sanitizePairCode', () => {
  it('uppercases lowercase letters', () => {
    expect(sanitizePairCode('abc123')).toBe('ABC123');
  });

  it('strips punctuation, whitespace, symbols', () => {
    expect(sanitizePairCode('a-b c.d?e!f')).toBe('ABCDEF');
  });

  it('truncates to 6 characters (protocol limit)', () => {
    expect(sanitizePairCode('abcdefghij')).toBe('ABCDEF');
  });

  it('preserves digits and mixed alphanumerics', () => {
    expect(sanitizePairCode('1a2b3c4d')).toBe('1A2B3C');
  });

  it('returns empty string for empty input', () => {
    expect(sanitizePairCode('')).toBe('');
  });

  it('keeps every hex character of a pasted code with separators', () => {
    expect(sanitizePairCode('AB12 CD')).toBe('AB12CD');
    expect(sanitizePairCode('ab-12-cd-ef')).toBe('AB12CD');
  });

  it('returns empty string when all chars are stripped', () => {
    expect(sanitizePairCode('---!!!')).toBe('');
  });

  it('strips non-hex letters (the code alphabet is 0-9 and A-F)', () => {
    expect(sanitizePairCode('AD0BDB')).toBe('AD0BDB');
    expect(sanitizePairCode('ADOBDB')).toBe('ADBDB'); // 'O' is not hex
    expect(sanitizePairCode('GHIJKL')).toBe('');
  });
});

describe('classes', () => {
  it('joins truthy strings with a single space', () => {
    expect(classes('a', 'b', 'c')).toBe('a b c');
  });

  it('drops false / null / undefined / empty string entries', () => {
    expect(classes('a', false, 'b', null, undefined, '', 'c')).toBe('a b c');
  });

  it('returns empty string when everything is falsy', () => {
    expect(classes(false, null, undefined, '')).toBe('');
  });

  it('handles the common conditional toggle pattern', () => {
    const active = Date.now() > 0; // always true at runtime
    const disabled = Date.now() < 0; // always false at runtime
    expect(classes('btn', active && 'btn-active', disabled && 'btn-disabled')).toBe(
      'btn btn-active'
    );
  });
});

describe('shouldRestartPairingFlow', () => {
  it.each([
    'Invalid pairing code',
    'invalid pairing code',
    'Please request a new code',
    'No pairing session is active',
    'Pairing failed',
    'PAIRING FAILED', // case-insensitive
    'DecodeError: pairing code failed local certificate hash validation',
    'Server says: invalid pairing code, retry.',
    'The TV rejected the saved pairing certificate. Start pairing again. If this keeps happening, remove this remote from the TV and pair again.',
  ])('matches: %s', (msg) => {
    expect(shouldRestartPairingFlow(msg)).toBe(true);
  });

  it.each([
    '',
    'Connection timed out',
    'Network unreachable',
    'TLS handshake error',
    'The device at 192.168.1.20 does not match the paired TV. Rescan for devices, then try again. The saved pairing was kept.',
  ])('does not match: %s', (msg) => {
    expect(shouldRestartPairingFlow(msg)).toBe(false);
  });
});

describe('isConnectionUnavailableError', () => {
  it.each([
    'No active device connected.',
    'The TV rejected the saved pairing certificate. Start pairing again.',
    'The device at 10.0.0.5 does not match the paired TV. Rescan for devices, then try again.',
    'Desktop bridge unavailable. Restart the app after the Electron preload finishes compiling.',
  ])('drops the rest of the queue after: %s', (msg) => {
    expect(isConnectionUnavailableError(msg)).toBe(true);
  });

  it.each(['', 'Could not send up to 10.0.0.5.', 'Connection has been lost.', 'timed out'])(
    'keeps the queue after a transient error: %s',
    (msg) => {
      expect(isConnectionUnavailableError(msg)).toBe(false);
    }
  );
});
