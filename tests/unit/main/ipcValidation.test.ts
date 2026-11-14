import { describe, expect, it } from 'vitest';

import {
  MAX_TEXT_INPUT_LENGTH,
  requireCommandDropReport,
  requireCommandRequest,
  requireDeviceDraft,
  requireDeviceId,
  requireHost,
  requirePairingRequest,
  requireTextInput,
  requireVoiceChunk,
  requireVoiceSessionId,
} from '../../../src/main/ipcValidation';

describe('IPC payload validation', () => {
  it('accepts IPv4, IPv6 and DNS host names and rejects junk', () => {
    expect(requireHost(' 192.168.1.20 ')).toBe('192.168.1.20');
    expect(requireHost('fe80::1')).toBe('fe80::1');
    expect(requireHost('Android-2.local.')).toBe('Android-2.local.');
    for (const bad of ['', 'not a host', '-bad.local', 'a'.repeat(254), 42, null]) {
      expect(() => requireHost(bad)).toThrow('Invalid device address.');
    }
  });

  it('validates device ids', () => {
    expect(requireDeviceId(' abc ')).toBe('abc');
    expect(() => requireDeviceId('')).toThrow();
    expect(() => requireDeviceId({})).toThrow();
    expect(() => requireDeviceId('x'.repeat(129))).toThrow();
  });

  it('returns only known draft fields and validates ports', () => {
    expect(
      requireDeviceDraft({
        name: 'Office SHIELD',
        host: '10.0.0.5',
        adbPort: 5555,
        pairingPort: 6467,
        macAddress: 'AA:BB:CC:DD:EE:FF',
        extra: 'dropped',
      })
    ).toEqual({
      name: 'Office SHIELD',
      host: '10.0.0.5',
      adbPort: 5555,
      pairingPort: 6467,
      macAddress: 'AA:BB:CC:DD:EE:FF',
      castDeviceId: undefined,
      networkHostName: undefined,
      deviceFingerprint: undefined,
    });
    expect(() => requireDeviceDraft({ name: '', host: 'not a host', adbPort: -1 })).toThrow();
    expect(() => requireDeviceDraft({ name: 'x', host: '10.0.0.5', adbPort: 70_000 })).toThrow();
    expect(() => requireDeviceDraft({ name: 'x', host: '10.0.0.5', adbPort: 1.5 })).toThrow();
    expect(() => requireDeviceDraft(null)).toThrow();
  });

  it('requires a six-hex pairing code', () => {
    expect(requirePairingRequest({ host: '10.0.0.5', code: ' ab12cd ', deviceId: 'id' })).toEqual({
      deviceId: 'id',
      host: '10.0.0.5',
      code: 'ab12cd',
      macAddress: undefined,
      castDeviceId: undefined,
    });
    expect(() => requirePairingRequest({ host: '10.0.0.5', code: 'OO00FF' })).toThrow(
      'Invalid pairing code'
    );
    expect(() => requirePairingRequest({ host: '10.0.0.5' })).toThrow();
  });

  it('allows only known remote commands and sources', () => {
    const request = { id: 'c1', command: 'up', issuedAt: 1, source: 'keyboard' };
    expect(requireCommandRequest(request)).toEqual(request);
    expect(() => requireCommandRequest({ ...request, command: 'launch-shell' })).toThrow();
    expect(() => requireCommandRequest({ ...request, source: 'script' })).toThrow();
    expect(() => requireCommandRequest({ ...request, issuedAt: Number.NaN })).toThrow();
    expect(() => requireCommandRequest({ ...request, id: '' })).toThrow();
  });

  it('validates renderer drop reports', () => {
    const report = {
      id: 'c1',
      command: 'down',
      issuedAt: 1,
      source: 'button',
      droppedAt: 2,
      dropReason: 'renderer_burst_limit',
      pendingCommandCount: 100,
    };
    expect(requireCommandDropReport(report)).toEqual(report);
    expect(() => requireCommandDropReport({ ...report, dropReason: 'other' })).toThrow();
    expect(() => requireCommandDropReport({ ...report, pendingCommandCount: -1 })).toThrow();
  });

  it('bounds text input', () => {
    expect(requireTextInput('hello')).toBe('hello');
    expect(() => requireTextInput(42)).toThrow();
    expect(() => requireTextInput('x'.repeat(MAX_TEXT_INPUT_LENGTH + 1))).toThrow();
  });

  it('validates voice session ids and base64 chunks', () => {
    expect(requireVoiceSessionId(0)).toBe(0);
    expect(() => requireVoiceSessionId(-1)).toThrow();
    expect(() => requireVoiceSessionId(1.5)).toThrow();
    expect(requireVoiceChunk('AAAA')).toBe('AAAA');
    expect(requireVoiceChunk('AA==')).toBe('AA==');
    expect(() => requireVoiceChunk('!!!')).toThrow();
    expect(() => requireVoiceChunk('AAA')).toThrow();
  });
});
