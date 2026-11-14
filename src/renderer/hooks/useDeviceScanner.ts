import { useCallback, useRef, useState } from 'react';

import type { DiscoveredDevice } from '../../shared/types';
import { getDesktopApi } from '../api';

/**
 * Manages device discovery/scanning state and the scan operation.
 *
 * Returns:
 *   - discoveredDevices: list of devices found on the local network
 *   - setDiscoveredDevices: setter for discovered devices
 *   - scanning: whether a scan is currently in progress
 *   - handleScanDevices: async function to scan for devices and update discovered devices.
 *     A call made while a scan is already running joins that scan and gets its result,
 *     so overlapping callers can neither clear `scanning` early nor overwrite the list
 *     with an older result.
 */
export function useDeviceScanner() {
  const [discoveredDevices, setDiscoveredDevices] = useState<DiscoveredDevice[]>([]);
  const [scanning, setScanning] = useState(false);
  const inFlightScanRef = useRef<Promise<DiscoveredDevice[]> | null>(null);

  const handleScanDevices = useCallback((): Promise<DiscoveredDevice[]> => {
    if (inFlightScanRef.current) {
      return inFlightScanRef.current;
    }

    setScanning(true);
    // Start asynchronously so the ref is assigned before the scan can settle.
    const scan: Promise<DiscoveredDevice[]> = Promise.resolve()
      .then(() => getDesktopApi().scanDevices())
      .then((devices) => {
        setDiscoveredDevices(devices);
        return devices;
      })
      .finally(() => {
        if (inFlightScanRef.current === scan) {
          inFlightScanRef.current = null;
        }
        setScanning(false);
      });
    inFlightScanRef.current = scan;
    return scan;
  }, []);

  return { discoveredDevices, setDiscoveredDevices, scanning, handleScanDevices };
}
