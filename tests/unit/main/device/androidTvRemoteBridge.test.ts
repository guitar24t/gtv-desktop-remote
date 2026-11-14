import type { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AndroidTvRemoteBridge } from '../../../../src/main/device/androidTvRemote';
import {
  CertificateRejectedError,
  ServerIdentityMismatchError,
  STALE_CONNECTION_MS,
} from '../../../../src/main/device/androidTvRemote.types';
import type { CommandDispatchRequest } from '../../../../src/shared/types';

interface FakeRemoteClient extends EventEmitter {
  host: string;
  connect: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  commandDownUp: ReturnType<typeof vi.fn>;
  keyDown: ReturnType<typeof vi.fn>;
  keyUp: ReturnType<typeof vi.fn>;
  text: ReturnType<typeof vi.fn>;
  voiceBegin: ReturnType<typeof vi.fn>;
  voicePayload: ReturnType<typeof vi.fn>;
  voiceEnd: ReturnType<typeof vi.fn>;
}

const state = vi.hoisted(() => ({
  /** Server-certificate fingerprint presented at each host (undefined: none). */
  fingerprints: new Map<string, string | undefined>(),
  /** Queued `connect()` outcomes; empty means success. */
  connectOutcomes: [] as (Error | undefined)[],
  clients: [] as unknown[],
  pins: new Map<string, string>(),
  loadOrCreate:
    vi.fn<(key: string, legacy?: readonly string[]) => Promise<{ cert: string; key: string }>>(),
  clear: vi.fn(),
  clearPin: vi.fn(),
  createPairingClient: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@librecontrol/google-tv', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  class NodeTlsTransport {
    constructor(readonly options: { host: string }) {}
    getCertificates() {
      const fingerprint256 = state.fingerprints.get(this.options.host);
      return { peer: fingerprint256 ? { fingerprint256 } : undefined };
    }
  }
  class RemoteClient extends Emitter {
    host: string;
    connect = vi.fn(() => {
      const outcome = state.connectOutcomes.shift();
      return outcome ? Promise.reject(outcome) : Promise.resolve();
    });
    close = vi.fn(() => Promise.resolve());
    commandDownUp = vi.fn(() => Promise.resolve());
    keyDown = vi.fn(() => Promise.resolve());
    keyUp = vi.fn(() => Promise.resolve());
    text = vi.fn(() => Promise.resolve());
    voiceBegin = vi.fn(() => {
      this.emit('message', { type: 'voice', phase: 'begin', sessionId: 7 });
      return Promise.resolve({ sessionId: 7 });
    });
    voicePayload = vi.fn(() => Promise.resolve());
    voiceEnd = vi.fn(() => Promise.resolve());
    constructor(options: { transport: NodeTlsTransport }) {
      super();
      this.host = options.transport.options.host;
      state.clients.push(this);
    }
  }
  return { NodeTlsTransport, RemoteClient };
});
vi.mock('../../../../src/backend/devices/credentials/androidTvCertStore', () => ({
  AndroidTvCertStore: class {
    loadOrCreate = state.loadOrCreate;
    clear = state.clear;
    clearPin = state.clearPin;
    readPin = (key: string) => Promise.resolve(state.pins.get(key));
    writePin = (key: string, fingerprint: string) => {
      state.pins.set(key, fingerprint);
      return Promise.resolve();
    };
  },
}));
vi.mock('../../../../src/backend/pairing/createPairingClient', () => ({
  createPairingClient: state.createPairingClient,
}));
vi.mock('../../../../src/main/logger', () => ({
  createNodeLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  getAppDataPath: (...segments: string[]) => ['/profile', ...segments].join('/'),
  logError: state.logError,
}));
vi.mock('../../../../src/main/capture', () => ({
  record: vi.fn(),
  recordBuffer: vi.fn(),
  isCaptureEnabled: () => false,
}));
vi.mock('../../../../src/main/metrics', () => ({
  commandMetricsStore: new Proxy({}, { get: () => () => undefined }),
}));
vi.mock('../../../../src/main/integrationEnvironment', () => ({
  integrationEnvironment: undefined,
}));

const A = { deviceId: 'device-a', host: '192.0.2.10' };
const TV_FINGERPRINT = 'AA:11:22:33';
const OTHER_FINGERPRINT = 'BB:44:55:66';

function clients(): FakeRemoteClient[] {
  return state.clients as FakeRemoteClient[];
}

function lastClient(): FakeRemoteClient {
  const client = clients().at(-1);
  if (!client) throw new Error('no remote client created');
  return client;
}

function command(id = 'cmd-1'): CommandDispatchRequest {
  return { id, command: 'right', issuedAt: 0, source: 'button' };
}

function certificateUnknown(): Error {
  return Object.assign(
    new Error(
      'C0D7:error:0A000416:SSL routines:ssl3_read_bytes:sslv3 alert certificate unknown:SSL alert number 46'
    ),
    { code: 'ERR_SSL_SSLV3_ALERT_CERTIFICATE_UNKNOWN' }
  );
}

function pairingClient() {
  return {
    start: vi.fn().mockResolvedValue({}),
    close: vi.fn().mockResolvedValue(undefined),
    submitCode: vi.fn().mockResolvedValue({ type: 'secret-ack', status: 'ok' }),
  };
}

describe('AndroidTvRemoteBridge', () => {
  let bridge: AndroidTvRemoteBridge;

  beforeEach(() => {
    state.fingerprints.clear();
    state.fingerprints.set(A.host, TV_FINGERPRINT);
    state.connectOutcomes.length = 0;
    state.clients.length = 0;
    state.pins.clear();
    state.loadOrCreate.mockReset();
    state.loadOrCreate.mockImplementation((key: string) =>
      Promise.resolve({ cert: `cert:${key}`, key: `key:${key}` })
    );
    state.clear.mockReset().mockResolvedValue(undefined);
    state.clearPin.mockReset().mockImplementation((key: string) => {
      state.pins.delete(key);
      return Promise.resolve();
    });
    state.createPairingClient.mockReset();
    state.logError.mockReset();
    bridge = new AndroidTvRemoteBridge();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('device-id keyed sessions and credentials', () => {
    it('loads credentials by device id, passing legacy keys for one-time adoption', async () => {
      await bridge.connect({ ...A, legacyCertKeys: ['02:00:00:00:00:0A', A.host] });
      expect(state.loadOrCreate).toHaveBeenCalledWith('device-a', ['02:00:00:00:00:0A', A.host]);
      expect(lastClient().host).toBe(A.host);
    });

    it('keeps separate sessions and credentials for two devices that share an IP', async () => {
      state.fingerprints.set(A.host, TV_FINGERPRINT);
      await bridge.connect(A);
      await bridge.connect({ deviceId: 'device-b', host: A.host });
      expect(state.loadOrCreate.mock.calls.map(([key]) => key)).toEqual(['device-a', 'device-b']);
      expect(clients()).toHaveLength(2);
    });

    it('loads credentials once for concurrent calls on a new device', async () => {
      await Promise.all([bridge.connect(A), bridge.sendCommand(A, command())]);
      expect(state.loadOrCreate).toHaveBeenCalledOnce();
    });

    it('disconnects the stale client and connects to the new host when the host changes', async () => {
      await bridge.connect(A);
      const oldClient = lastClient();
      state.fingerprints.set('192.0.2.20', TV_FINGERPRINT);

      await bridge.sendCommand({ ...A, host: '192.0.2.20' }, command());

      expect(oldClient.close).toHaveBeenCalled();
      expect(lastClient()).not.toBe(oldClient);
      expect(lastClient().host).toBe('192.0.2.20');
      expect(lastClient().commandDownUp).toHaveBeenCalledWith('right');
      expect(state.loadOrCreate).toHaveBeenCalledOnce();
    });

    it('updateHost drops a client bound to the old address', async () => {
      await bridge.connect(A);
      const oldClient = lastClient();
      bridge.updateHost(A.deviceId, '192.0.2.20');
      expect(oldClient.close).toHaveBeenCalled();
      state.fingerprints.set('192.0.2.20', TV_FINGERPRINT);
      await bridge.sendCommand({ ...A, host: '192.0.2.20' }, command());
      expect(lastClient().host).toBe('192.0.2.20');
    });
  });

  describe('server certificate pinning (trust on first use)', () => {
    it('pins the first certificate and accepts it on later connections', async () => {
      await bridge.connect(A);
      expect(state.pins.get('device-a')).toBe(TV_FINGERPRINT);
      bridge.disconnect(A.deviceId);
      await expect(bridge.connect(A)).resolves.toBeDefined();
    });

    it('rejects a different TV at the paired address without touching credentials', async () => {
      state.pins.set('device-a', TV_FINGERPRINT);
      state.fingerprints.set(A.host, OTHER_FINGERPRINT);

      const failure = bridge.connect(A);
      await expect(failure).rejects.toBeInstanceOf(ServerIdentityMismatchError);
      await expect(failure).rejects.toThrow(
        'The device at 192.0.2.10 does not match the paired TV. Rescan for devices, then try again. If the TV was reset, forget it and pair again.'
      );
      expect(lastClient().close).toHaveBeenCalled();
      expect(state.pins.get('device-a')).toBe(TV_FINGERPRINT);
      expect(state.clear).not.toHaveBeenCalled();
    });

    it('applies the pin check to commands that reconnect', async () => {
      state.pins.set('device-a', TV_FINGERPRINT);
      state.fingerprints.set(A.host, OTHER_FINGERPRINT);
      await expect(bridge.sendCommand(A, command())).rejects.toBeInstanceOf(
        ServerIdentityMismatchError
      );
      expect(lastClient().commandDownUp).not.toHaveBeenCalled();
    });

    it('skips pinning when the TV presents no certificate', async () => {
      state.fingerprints.set(A.host, undefined);
      await expect(bridge.connect(A)).resolves.toBeDefined();
      expect(state.pins.has('device-a')).toBe(false);
    });

    it('a successful finishPairing clears the pin so the next connect re-pins', async () => {
      state.pins.set('device-a', OTHER_FINGERPRINT);
      const manager = pairingClient();
      state.createPairingClient.mockResolvedValue(manager);
      await bridge.startPairing(A);
      await bridge.finishPairing(A, '1A2B3C');
      expect(state.pins.has('device-a')).toBe(false);
      await bridge.connect(A);
      expect(state.pins.get('device-a')).toBe(TV_FINGERPRINT);
    });

    it('a failed finishPairing keeps the pin', async () => {
      state.pins.set('device-a', TV_FINGERPRINT);
      const manager = pairingClient();
      manager.submitCode.mockResolvedValue({ type: 'secret-ack', status: 'bad' });
      state.createPairingClient.mockResolvedValue(manager);
      await bridge.startPairing(A);
      await expect(bridge.finishPairing(A, '1A2B3C')).rejects.toThrow('Invalid pairing code');
      expect(state.pins.get('device-a')).toBe(TV_FINGERPRINT);
      expect(manager.close).toHaveBeenCalled();
    });
  });

  describe('certificate rejection (TLS alert 46)', () => {
    const START_PAIRING_AGAIN =
      'The TV rejected the saved pairing certificate. Start pairing again. If this keeps happening, remove this remote from the TV and pair again.';

    it('connect rethrows the normalized error and never deletes credentials', async () => {
      state.connectOutcomes.push(certificateUnknown());
      const failure = bridge.connect(A);
      await expect(failure).rejects.toBeInstanceOf(CertificateRejectedError);
      await expect(failure).rejects.toThrow(START_PAIRING_AGAIN);
      expect(state.clear).not.toHaveBeenCalled();
      expect(lastClient().close).toHaveBeenCalled();
      // The rejected client is dropped; the cached credentials are reused.
      await bridge.connect(A);
      expect(clients()).toHaveLength(2);
      expect(state.loadOrCreate).toHaveBeenCalledOnce();
    });

    it.each([
      ['sendCommand', (b: AndroidTvRemoteBridge) => b.sendCommand(A, command())],
      ['sendText', (b: AndroidTvRemoteBridge) => b.sendText(A, 'hello')],
      ['startAssistantVoice', (b: AndroidTvRemoteBridge) => b.startAssistantVoice(A)],
    ])('%s surfaces the same normalized rejection', async (_name, run) => {
      state.connectOutcomes.push(certificateUnknown());
      await expect(run(bridge)).rejects.toThrow(START_PAIRING_AGAIN);
      expect(state.clear).not.toHaveBeenCalled();
    });
  });

  describe('stale (half-open) connections', () => {
    it('reconnects before a command when pings were seen but none for more than 15s', async () => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
      await bridge.connect(A);
      const first = lastClient();
      first.emit('message', { type: 'ping', sequence: 1 });

      now.mockReturnValue(1_000_000 + STALE_CONNECTION_MS + 1);
      await bridge.sendCommand(A, command());

      expect(first.close).toHaveBeenCalled();
      expect(first.commandDownUp).not.toHaveBeenCalled();
      expect(lastClient()).not.toBe(first);
      expect(lastClient().commandDownUp).toHaveBeenCalledWith('right');
    });

    it('keeps a connection whose pings are recent', async () => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
      await bridge.connect(A);
      lastClient().emit('message', { type: 'ping', sequence: 1 });
      now.mockReturnValue(1_000_000 + STALE_CONNECTION_MS - 1);
      await bridge.sendText(A, 'hi');
      expect(clients()).toHaveLength(1);
      expect(lastClient().text).toHaveBeenCalledWith('hi');
    });

    it('does not penalize a TV that never pings', async () => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
      await bridge.connect(A);
      now.mockReturnValue(1_000_000 + 10 * STALE_CONNECTION_MS);
      await bridge.startAssistantVoice(A);
      expect(clients()).toHaveLength(1);
    });

    it('applies to voice start and text', async () => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
      await bridge.connect(A);
      lastClient().emit('message', { type: 'ping', sequence: 1 });
      now.mockReturnValue(1_000_000 + STALE_CONNECTION_MS + 1);
      await expect(bridge.startAssistantVoice(A)).resolves.toBe(7);
      expect(clients()).toHaveLength(2);
    });

    it('dropRemoteClients closes every connection so the next command reconnects', async () => {
      await bridge.connect(A);
      const first = lastClient();
      bridge.dropRemoteClients();
      expect(first.close).toHaveBeenCalled();
      await bridge.sendCommand(A, command());
      expect(clients()).toHaveLength(2);
    });
  });

  describe('resource cleanup', () => {
    it('closes an unfinished pairing session before starting a new one', async () => {
      const first = pairingClient();
      const second = pairingClient();
      state.createPairingClient.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
      await bridge.startPairing(A);
      await bridge.startPairing(A);
      expect(first.close).toHaveBeenCalledOnce();
      expect(second.close).not.toHaveBeenCalled();
    });

    it('ignores a failing close of the previous pairing session', async () => {
      const first = pairingClient();
      first.close.mockRejectedValue(new Error('already closed'));
      state.createPairingClient.mockResolvedValueOnce(first).mockResolvedValueOnce(pairingClient());
      await bridge.startPairing(A);
      await expect(bridge.startPairing(A)).resolves.toEqual({});
    });

    it('reset closes pairing sessions and remote clients, ignoring close errors', async () => {
      const manager = pairingClient();
      manager.close.mockRejectedValue(new Error('close failed'));
      state.createPairingClient.mockResolvedValue(manager);
      await bridge.startPairing(A);
      await bridge.connect(A);
      const remote = lastClient();

      await expect(bridge.reset()).resolves.toBeUndefined();

      expect(manager.close).toHaveBeenCalled();
      expect(remote.close).toHaveBeenCalled();
    });

    it('a rejected client close does not become an unhandled rejection', async () => {
      await bridge.connect(A);
      lastClient().close.mockRejectedValue(new Error('socket already destroyed'));
      bridge.disconnect(A.deviceId);
      await vi.waitFor(() => {
        expect(state.logError).toHaveBeenCalledWith(
          'androidtvremote',
          'Closing the remote client failed',
          expect.any(Error)
        );
      });
    });

    it('closes the TLS client when the connection attempt fails', async () => {
      state.connectOutcomes.push(
        new Error('timed out waiting for Android TV remote service start')
      );
      await expect(bridge.connect(A)).rejects.toThrow('timed out');
      expect(lastClient().close).toHaveBeenCalled();
    });
  });

  describe('voice is keyed by device id', () => {
    it('routes chunks, stop and pending checks to the device session, not the host', async () => {
      const sessionId = await bridge.startAssistantVoice(A);
      expect(await bridge.hasPendingAssistantVoiceSession('device-a')).toBe(true);
      expect(await bridge.hasPendingAssistantVoiceSession('device-b')).toBe(false);

      await bridge.sendAssistantVoiceChunk('device-a', sessionId, Buffer.from([1, 2]));
      expect(lastClient().voicePayload).toHaveBeenCalledOnce();
      await expect(
        bridge.sendAssistantVoiceChunk('device-b', sessionId, Buffer.from([1, 2]))
      ).rejects.toThrow('Connection has been lost.');

      await bridge.stopAssistantVoice('device-a', sessionId);
      expect(lastClient().voiceEnd).toHaveBeenCalledOnce();
      expect(await bridge.hasPendingAssistantVoiceSession('device-a')).toBe(false);
    });
  });
});
