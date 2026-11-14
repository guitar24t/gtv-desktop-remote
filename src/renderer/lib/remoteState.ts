import type { BootstrapState, DeviceState } from '../../shared/types';

/** True while main reports a TV session the remote view can drive (or is about to). */
export function isRemoteSessionStatus(status: DeviceState['status']): boolean {
  return status === 'connected' || status === 'connecting';
}

export interface RemoteErrorResolution {
  /** Whether the remote view should stay open. */
  stayInRemote: boolean;
  /** The renderer state to apply. */
  bootstrap: BootstrapState;
}

/**
 * Decides what the renderer shows after a non-fatal remote error (a failed
 * key command, text send, voice session, or microphone request), given the
 * authoritative state re-read from main.
 *
 *   - Main still connected/connecting: stay in the remote view and adopt
 *     main's state as is; the error is shown separately as a banner.
 *   - Otherwise: leave the remote view. Main's own error wins; when main is
 *     merely idle (for example, it disconnected), surface the remote error
 *     on the device list so the user can see why the remote closed.
 */
export function resolveRemoteError(
  mainState: BootstrapState,
  errorMessage: string
): RemoteErrorResolution {
  if (isRemoteSessionStatus(mainState.deviceState.status)) {
    return { stayInRemote: true, bootstrap: mainState };
  }

  return {
    stayInRemote: false,
    bootstrap: {
      devices: mainState.devices,
      deviceState:
        mainState.deviceState.status === 'error'
          ? mainState.deviceState
          : { ...mainState.deviceState, status: 'error', message: errorMessage },
    },
  };
}
