import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AndroidTvCertStore } from '../../../src/backend/devices/credentials/androidTvCertStore';
import { AndroidTvRemoteBridge } from '../../../src/main/device/androidTvRemote';

const mocks = vi.hoisted(() => ({
  loadOrCreate: vi.fn<AndroidTvCertStore['loadOrCreate']>(),
  clear: vi.fn<AndroidTvCertStore['clear']>(),
  clearPin: vi.fn<AndroidTvCertStore['clearPin']>(),
  readPin: vi.fn<AndroidTvCertStore['readPin']>(),
  writePin: vi.fn<AndroidTvCertStore['writePin']>(),
  createPairingClient: vi.fn(),
}));

vi.mock('../../../src/backend/devices/credentials/androidTvCertStore', () => ({
  AndroidTvCertStore: class {
    loadOrCreate = mocks.loadOrCreate;
    clear = mocks.clear;
    clearPin = mocks.clearPin;
    readPin = mocks.readPin;
    writePin = mocks.writePin;
  },
}));
vi.mock('../../../src/backend/pairing/createPairingClient', () => ({
  createPairingClient: mocks.createPairingClient,
}));
vi.mock('../../../src/main/logger', () => ({
  createNodeLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  getAppDataPath: (...segments: string[]) => ['/profile', ...segments].join('/'),
  logError: vi.fn(),
}));
vi.mock('../../../src/main/capture', () => ({
  record: vi.fn(),
  recordBuffer: vi.fn(),
  isCaptureEnabled: () => false,
}));
vi.mock('../../../src/main/metrics', () => ({ commandMetricsStore: {} }));
vi.mock('../../../src/main/integrationEnvironment', () => ({ integrationEnvironment: undefined }));

function pairingClient() {
  return { start: vi.fn().mockResolvedValue({}), close: vi.fn().mockResolvedValue(undefined) };
}

const DEVICE_A = { deviceId: 'device-a', host: '192.0.2.1' };
const DEVICE_B = { deviceId: 'device-b', host: '192.0.2.1' };

describe('forgotten device authorization', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.loadOrCreate.mockImplementation((key: string) => Promise.resolve({ cert: key, key }));
    mocks.clear.mockResolvedValue(undefined);
    mocks.clearPin.mockResolvedValue(undefined);
    mocks.readPin.mockResolvedValue(undefined);
    mocks.writePin.mockResolvedValue(undefined);
  });

  it('closes only the forgotten device session, clears its id-keyed and legacy credentials, and preserves another device on the same host', async () => {
    const bridge = new AndroidTvRemoteBridge();
    const clientA = pairingClient();
    const clientB = pairingClient();
    mocks.createPairingClient
      .mockResolvedValueOnce(clientA)
      .mockResolvedValueOnce(clientB)
      .mockResolvedValue(pairingClient());
    await bridge.startPairing(DEVICE_A);
    await bridge.startPairing(DEVICE_B);
    // Credentials are loaded per device id even though both share a host.
    expect(mocks.loadOrCreate.mock.calls.map(([key]) => key)).toEqual(['device-a', 'device-b']);

    await bridge.forgetDevice('device-a', ['02:00:00:00:00:0A']);

    expect(clientA.close).toHaveBeenCalledOnce();
    expect(clientB.close).not.toHaveBeenCalled();
    expect(mocks.clear.mock.calls.map(([key]) => key)).toEqual(['device-a', '02:00:00:00:00:0A']);

    // Device B's cached session survives; device A starts from fresh credentials.
    const loadsBefore = mocks.loadOrCreate.mock.calls.length;
    await bridge.startPairing(DEVICE_B);
    expect(mocks.loadOrCreate).toHaveBeenCalledTimes(loadsBefore);
    expect(clientB.close).toHaveBeenCalledOnce(); // replaced by a new pairing session
    await bridge.startPairing(DEVICE_A);
    expect(mocks.loadOrCreate).toHaveBeenCalledTimes(loadsBefore + 1);
  });

  it('never passes the device id twice or blank legacy keys to the store', async () => {
    const bridge = new AndroidTvRemoteBridge();
    await bridge.forgetDevice('device-a', ['device-a', ' ', '192.0.2.1']);
    expect(mocks.clear.mock.calls.map(([key]) => key)).toEqual(['device-a', '192.0.2.1']);
  });

  it('awaits pairing closure before deleting authorization and surfaces close failure', async () => {
    const bridge = new AndroidTvRemoteBridge();
    const client = pairingClient();
    client.close.mockRejectedValueOnce(new Error('close failed'));
    mocks.createPairingClient.mockResolvedValue(client);
    await bridge.startPairing(DEVICE_A);
    await expect(bridge.forgetDevice('device-a')).rejects.toThrow('close failed');
    expect(mocks.clear).not.toHaveBeenCalled();
  });

  it('surfaces credential deletion failure instead of reporting forgotten authorization', async () => {
    const bridge = new AndroidTvRemoteBridge();
    mocks.clear.mockRejectedValueOnce(new Error('permission denied'));
    await expect(bridge.forgetDevice('device-a')).rejects.toThrow('permission denied');
  });
});
