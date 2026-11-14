import { describe, expect, it } from 'vitest';

import type { BootstrapState, DeviceState, SavedDevice } from '../../../shared/types';
import { isRemoteSessionStatus, resolveRemoteError } from '../remoteState';

const devices: SavedDevice[] = [
  { id: 'tv-1', name: 'Living Room', host: '10.0.0.5', isPaired: true },
];

function mainState(deviceState: DeviceState): BootstrapState {
  return { devices, deviceState };
}

describe('isRemoteSessionStatus', () => {
  it.each([
    ['connected', true],
    ['connecting', true],
    ['idle', false],
    ['error', false],
  ] as const)('%s -> %s', (status, expected) => {
    expect(isRemoteSessionStatus(status)).toBe(expected);
  });
});

describe('resolveRemoteError', () => {
  it.each(['connected', 'connecting'] as const)(
    'stays in the remote view and adopts main state while main is %s',
    (status) => {
      const state = mainState({ status, activeDeviceId: 'tv-1', message: 'Connected to TV.' });
      expect(resolveRemoteError(state, 'Could not send up.')).toEqual({
        stayInRemote: true,
        bootstrap: state,
      });
    }
  );

  it('leaves with the remote error when main is idle', () => {
    const resolution = resolveRemoteError(
      mainState({ status: 'idle', message: 'Disconnected.' }),
      'No active device connected.'
    );
    expect(resolution.stayInRemote).toBe(false);
    expect(resolution.bootstrap).toEqual({
      devices,
      deviceState: { status: 'error', message: 'No active device connected.' },
    });
  });

  it("leaves with main's own error when main reports one", () => {
    const deviceState: DeviceState = {
      status: 'error',
      message: 'The TV rejected the saved pairing certificate. Start pairing again.',
    };
    const resolution = resolveRemoteError(mainState(deviceState), 'Could not send up.');
    expect(resolution).toEqual({ stayInRemote: false, bootstrap: { devices, deviceState } });
  });
});
