import type * as NodeFs from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CertificateRejectedError,
  ServerIdentityMismatchError,
} from '../../../../src/main/device/androidTvRemote.types';
import { GoogleTvAdapter } from '../../../../src/main/device/googleTvAdapter';
import type { DiscoveredDevice, SavedDevice } from '../../../../src/shared/types';

const state = vi.hoisted(() => ({
  devices: [] as SavedDevice[],
  writes: 0,
  discover: vi.fn(),
  logError: vi.fn(),
  bridge: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    dropRemoteClients: vi.fn(),
    finishPairing: vi.fn(),
    forgetDevice: vi.fn(),
    hasPendingAssistantVoiceSession: vi.fn(),
    reset: vi.fn(),
    sendAssistantVoiceChunk: vi.fn(),
    sendCommand: vi.fn(),
    sendText: vi.fn(),
    startAssistantVoice: vi.fn(),
    startPairing: vi.fn(),
    stopAssistantVoice: vi.fn(),
    updateHost: vi.fn(),
  },
}));

// Asynchronous like the real JSON file store, so interleavings are exercised.
vi.mock('../../../../src/main/device/store', () => ({
  readDevices: async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    return structuredClone(state.devices);
  },
  writeDevices: async (devices: SavedDevice[]) => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    state.devices = structuredClone(devices);
    state.writes += 1;
  },
  clearDeviceStore: () => {
    state.devices = [];
    return Promise.resolve();
  },
}));
vi.mock('../../../../src/main/device/androidTvRemote', () => ({
  androidTvRemoteBridge: state.bridge,
}));
vi.mock('../../../../src/main/device/discovery', () => ({
  discoverGoogleTvDevices: state.discover,
}));
vi.mock('electron', () => ({ app: { getPath: () => '/app-data' } }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return { ...actual, promises: { ...actual.promises, rm: vi.fn().mockResolvedValue(undefined) } };
});
vi.mock('../../../../src/main/logger', () => ({
  createNodeLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  getAppDataPath: (...segments: string[]) => ['/profile', ...segments].join('/'),
  logError: state.logError,
  logInfo: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../../src/main/metrics', () => ({
  commandMetricsStore: new Proxy({}, { get: () => () => undefined }),
}));
vi.mock('../../../../src/main/integrationEnvironment', () => ({
  integrationEnvironment: undefined,
  assertLoopbackHost: vi.fn(),
}));

const MAC = '02:00:00:00:00:0A';

function device(overrides: Partial<SavedDevice> = {}): SavedDevice {
  return {
    id: 'device-a',
    name: 'Living Room SHIELD',
    host: '192.0.2.10',
    isPaired: true,
    macAddress: MAC,
    ...overrides,
  };
}

function discovered(overrides: Partial<DiscoveredDevice> = {}): DiscoveredDevice {
  return {
    id: 'disc',
    name: 'Living Room SHIELD',
    host: '192.0.2.10',
    macAddress: MAC,
    source: 'androidtvremote',
    ...overrides,
  };
}

function command(id = 'cmd') {
  return { id, command: 'right' as const, issuedAt: 0, source: 'button' as const };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function connected(adapter: GoogleTvAdapter, deviceId = 'device-a') {
  state.bridge.connect.mockResolvedValueOnce({});
  await adapter.connect(deviceId);
}

describe('GoogleTvAdapter', () => {
  let adapter: GoogleTvAdapter;

  beforeEach(() => {
    vi.resetAllMocks();
    state.devices = [device()];
    state.writes = 0;
    for (const fn of Object.values(state.bridge)) fn.mockResolvedValue(undefined);
    state.bridge.disconnect.mockReturnValue(undefined);
    state.bridge.updateHost.mockReturnValue(undefined);
    state.bridge.dropRemoteClients.mockReturnValue(undefined);
    state.bridge.connect.mockResolvedValue({});
    state.bridge.startPairing.mockResolvedValue({});
    state.discover.mockResolvedValue([]);
    adapter = new GoogleTvAdapter();
  });

  describe('credentials keyed by device id', () => {
    it('connects with the device id, current host and legacy keys (MAC, then unique host)', async () => {
      await adapter.connect('device-a');
      expect(state.bridge.connect).toHaveBeenCalledWith({
        deviceId: 'device-a',
        host: '192.0.2.10',
        legacyCertKeys: [MAC, '192.0.2.10'],
      });
    });

    it('withholds a host-keyed legacy pair when two saved devices share the host', async () => {
      state.devices = [
        device({ macAddress: undefined }),
        device({ id: 'device-b', name: 'Bedroom', macAddress: undefined }),
      ];
      await adapter.connect('device-b');
      expect(state.bridge.connect).toHaveBeenCalledWith({
        deviceId: 'device-b',
        host: '192.0.2.10',
        legacyCertKeys: [],
      });
    });

    it('pair() marks only the requested device as paired, even when another shares its host', async () => {
      state.devices = [
        device({ isPaired: false }),
        device({ id: 'device-b', name: 'Bedroom', isPaired: false, macAddress: undefined }),
      ];
      await adapter.pair({ deviceId: 'device-b', host: '192.0.2.10', code: '1a2b3c' });
      expect(state.bridge.finishPairing).toHaveBeenCalledWith(
        { deviceId: 'device-b', host: '192.0.2.10', legacyCertKeys: [] },
        '1a2b3c'
      );
      expect(state.devices.map((d) => [d.id, d.isPaired])).toEqual([
        ['device-a', false],
        ['device-b', true],
      ]);
    });

    it('pair() falls back to the host only when no device id is given', async () => {
      state.devices = [device({ isPaired: false })];
      await adapter.pair({ host: ' 192.0.2.10 ', code: '1a2b3c' });
      expect(state.devices[0]?.isPaired).toBe(true);
      expect(state.bridge.finishPairing.mock.calls[0]?.[0]).toMatchObject({
        deviceId: 'device-a',
      });
    });

    it('removeDevice forgets only legacy keys no other saved device shares', async () => {
      state.devices = [
        device(),
        device({ id: 'device-b', name: 'Bedroom', macAddress: '02:00:00:00:00:0B' }),
      ];
      await adapter.removeDevice('device-a');
      expect(state.bridge.forgetDevice).toHaveBeenCalledWith('device-a', [MAC]);
      expect(state.devices.map((d) => d.id)).toEqual(['device-b']);
    });

    it('removeDevice keeps the device when forgetting authorization fails', async () => {
      state.bridge.forgetDevice.mockRejectedValueOnce(new Error('permission denied'));
      await expect(adapter.removeDevice('device-a')).rejects.toThrow('permission denied');
      expect(state.devices.map((d) => d.id)).toEqual(['device-a']);
    });
  });

  describe('certificate rejection keeps credentials and marks the device unpaired', () => {
    it('on connect', async () => {
      state.bridge.connect.mockRejectedValueOnce(new CertificateRejectedError());
      await expect(adapter.connect('device-a')).rejects.toThrow('Start pairing again');
      expect(state.devices[0]?.isPaired).toBe(false);
      expect(state.bridge.forgetDevice).not.toHaveBeenCalled();
      const { deviceState } = await adapter.getBootstrapState();
      expect(deviceState.status).toBe('error');
      expect(deviceState.message).toMatch(
        /^The TV rejected the saved pairing certificate\. Start pairing again\./
      );
    });

    it.each([
      ['sendCommand', 'sendCommand', (a: GoogleTvAdapter) => a.sendCommand(command())],
      ['sendText', 'sendText', (a: GoogleTvAdapter) => a.sendText('hi')],
      [
        'startAssistantVoice',
        'startAssistantVoice',
        (a: GoogleTvAdapter) => a.startAssistantVoice(),
      ],
    ] as const)('on %s', async (_name, bridgeMethod, run) => {
      await connected(adapter);
      state.bridge[bridgeMethod].mockRejectedValueOnce(new CertificateRejectedError());

      await expect(run(adapter)).rejects.toThrow('Start pairing again');

      expect(state.devices[0]?.isPaired).toBe(false);
      expect((await adapter.getBootstrapState()).deviceState.status).toBe('error');
      // The active device was cleared.
      await expect(adapter.sendCommand(command('next'))).rejects.toThrow(
        'No active device connected.'
      );
    });
  });

  describe('server identity mismatch', () => {
    it('stops using the connection but keeps the pairing state', async () => {
      await connected(adapter);
      state.bridge.sendCommand.mockRejectedValueOnce(new ServerIdentityMismatchError('192.0.2.10'));
      await expect(adapter.sendCommand(command())).rejects.toThrow(
        'The device at 192.0.2.10 does not match the paired TV.'
      );
      expect(state.devices[0]?.isPaired).toBe(true);
      expect((await adapter.getBootstrapState()).deviceState.status).toBe('error');
      await expect(adapter.sendText('x')).rejects.toThrow('No active device connected.');
    });

    it('ordinary send failures leave the connection state alone', async () => {
      await connected(adapter);
      state.bridge.sendCommand.mockRejectedValueOnce(new Error('Connection has been lost.'));
      await expect(adapter.sendCommand(command())).rejects.toThrow('Connection has been lost.');
      await adapter.sendCommand(command('retry'));
      expect(state.bridge.sendCommand).toHaveBeenCalledTimes(2);
    });
  });

  describe('IP changes found by a scan', () => {
    it('moves the live connection to the new IP without migrating credentials', async () => {
      await connected(adapter);
      state.discover.mockResolvedValueOnce([discovered({ host: '192.0.2.20' })]);

      await adapter.scanForDevices();

      expect(state.devices[0]?.host).toBe('192.0.2.20');
      expect(state.bridge.updateHost).toHaveBeenCalledWith('device-a', '192.0.2.20');
      await adapter.sendCommand(command());
      expect(state.bridge.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({ deviceId: 'device-a', host: '192.0.2.20' }),
        expect.objectContaining({ id: 'cmd' })
      );
      expect((await adapter.getBootstrapState()).deviceState.status).toBe('connected');
    });

    it('does not write when nothing changed', async () => {
      state.discover.mockResolvedValueOnce([discovered()]);
      await adapter.scanForDevices();
      expect(state.writes).toBe(0);
      expect(state.bridge.updateHost).not.toHaveBeenCalled();
    });

    it('re-saving the active device at a new address also moves the connection', async () => {
      await connected(adapter);
      await adapter.saveDevice({
        name: 'Living Room SHIELD',
        host: '192.0.2.30',
        adbPort: 5555,
        macAddress: MAC,
      });
      expect(state.bridge.updateHost).toHaveBeenCalledWith('device-a', '192.0.2.30');
      await adapter.sendText('hello');
      expect(state.bridge.sendText).toHaveBeenCalledWith(
        expect.objectContaining({ host: '192.0.2.30' }),
        'hello'
      );
    });
  });

  describe('devices.json read-modify-write is serialized', () => {
    it("a scan's host update and a connect's lastConnectedAt both survive", async () => {
      const connecting = deferred<Record<string, unknown>>();
      state.bridge.connect.mockReturnValueOnce(connecting.promise);
      const connect = adapter.connect('device-a');
      await vi.waitFor(() => {
        expect(state.bridge.connect).toHaveBeenCalled();
      });

      state.discover.mockResolvedValueOnce([discovered({ host: '192.0.2.20' })]);
      await adapter.scanForDevices();
      connecting.resolve({});
      await connect;

      expect(state.devices[0]?.host).toBe('192.0.2.20');
      expect(state.devices[0]?.lastConnectedAt).toEqual(expect.any(String));
    });

    it('concurrent scan and pair do not clobber each other', async () => {
      state.devices = [device({ isPaired: false })];
      state.discover.mockResolvedValueOnce([discovered({ host: '192.0.2.20' })]);
      await Promise.all([
        adapter.scanForDevices(),
        adapter.pair({ deviceId: 'device-a', host: '192.0.2.10', code: '1a2b3c' }),
      ]);
      expect(state.devices[0]).toMatchObject({ host: '192.0.2.20', isPaired: true });
    });
  });

  describe('system resume', () => {
    it('drops remote clients and reconnects the active device in the background', async () => {
      await connected(adapter);
      state.bridge.connect.mockRejectedValueOnce(new Error('EHOSTUNREACH'));

      adapter.handleSystemResume();

      expect(state.bridge.dropRemoteClients).toHaveBeenCalledOnce();
      expect(state.bridge.connect).toHaveBeenLastCalledWith({
        deviceId: 'device-a',
        host: '192.0.2.10',
        legacyCertKeys: [MAC, '192.0.2.10'],
      });
      await vi.waitFor(() => {
        expect(state.logError).toHaveBeenCalledWith(
          'adapter',
          'Background reconnect after resume failed',
          expect.any(Error)
        );
      });
      // Still the active device; the next command reconnects.
      await adapter.sendCommand(command());
      expect(state.bridge.sendCommand).toHaveBeenCalled();
    });

    it('only drops clients when nothing is active', () => {
      adapter.handleSystemResume();
      expect(state.bridge.dropRemoteClients).toHaveBeenCalledOnce();
      expect(state.bridge.connect).not.toHaveBeenCalled();
    });
  });

  describe('voice uses the device-keyed session', () => {
    it('routes start, chunks, stop and pending checks by device id', async () => {
      await connected(adapter);
      state.bridge.startAssistantVoice.mockResolvedValueOnce(9);
      state.bridge.hasPendingAssistantVoiceSession.mockResolvedValueOnce(true);

      expect(await adapter.startAssistantVoice()).toBe(9);
      await adapter.sendAssistantVoiceChunk(9, Buffer.from([1, 2]).toString('base64'));
      expect(await adapter.hasPendingAssistantVoiceSession()).toBe(true);
      await adapter.stopAssistantVoice(9);

      expect(state.bridge.startAssistantVoice).toHaveBeenCalledWith({
        deviceId: 'device-a',
        host: '192.0.2.10',
        legacyCertKeys: [MAC, '192.0.2.10'],
      });
      expect(state.bridge.sendAssistantVoiceChunk).toHaveBeenCalledWith(
        'device-a',
        9,
        Buffer.from([1, 2])
      );
      expect(state.bridge.hasPendingAssistantVoiceSession).toHaveBeenCalledWith('device-a');
      expect(state.bridge.stopAssistantVoice).toHaveBeenCalledWith('device-a', 9);
    });
  });

  it('resetState resets the bridge and clears the active device', async () => {
    await connected(adapter);
    await adapter.resetState();
    expect(state.bridge.reset).toHaveBeenCalledOnce();
    expect(state.devices).toEqual([]);
    await expect(adapter.sendCommand(command())).rejects.toThrow('No active device connected.');
  });
});
