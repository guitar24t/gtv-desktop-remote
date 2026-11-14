import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DiscoveredDevice } from '../../../shared/types';
import { useDeviceScanner } from '../useDeviceScanner';

const tv: DiscoveredDevice = {
  id: 'tv',
  name: 'Living Room',
  host: '10.0.0.5',
  source: 'googlecast',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useDeviceScanner', () => {
  it('joins an in-flight scan instead of starting another', async () => {
    let finish!: (devices: DiscoveredDevice[]) => void;
    const scanDevices = vi.fn(
      () =>
        new Promise<DiscoveredDevice[]>((resolve) => {
          finish = resolve;
        })
    );
    vi.stubGlobal('gtvRemote', { scanDevices });
    const { result } = renderHook(() => useDeviceScanner());

    let first!: Promise<DiscoveredDevice[]>;
    let second!: Promise<DiscoveredDevice[]>;
    await act(async () => {
      first = result.current.handleScanDevices();
      second = result.current.handleScanDevices();
      await Promise.resolve();
    });
    expect(second).toBe(first);
    expect(result.current.scanning).toBe(true);
    expect(scanDevices).toHaveBeenCalledTimes(1);

    await act(async () => {
      finish([tv]);
      await first;
    });
    await expect(second).resolves.toEqual([tv]);
    expect(result.current.scanning).toBe(false);
    expect(result.current.discoveredDevices).toEqual([tv]);

    // A later scan starts fresh.
    scanDevices.mockResolvedValueOnce([]);
    await act(async () => {
      await result.current.handleScanDevices();
    });
    expect(scanDevices).toHaveBeenCalledTimes(2);
    expect(result.current.discoveredDevices).toEqual([]);
  });

  it('clears scanning and allows a new scan after a failure', async () => {
    const scanDevices = vi
      .fn<() => Promise<DiscoveredDevice[]>>()
      .mockRejectedValueOnce(new Error('Discovery failed'))
      .mockResolvedValueOnce([tv]);
    vi.stubGlobal('gtvRemote', { scanDevices });
    const { result } = renderHook(() => useDeviceScanner());

    await act(async () => {
      await expect(result.current.handleScanDevices()).rejects.toThrow('Discovery failed');
    });
    expect(result.current.scanning).toBe(false);

    await act(async () => {
      await expect(result.current.handleScanDevices()).resolves.toEqual([tv]);
    });
    expect(scanDevices).toHaveBeenCalledTimes(2);
  });
});
