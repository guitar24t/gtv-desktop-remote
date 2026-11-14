import type { ComponentType } from 'react';

import type { DeviceState, RemoteCommand } from '../../shared/types';
import type { WindowLayout } from '../../shared/windowLayout';

export type RemoteSkinId = 'classic' | 'shield';

/**
 * Everything a remote skin can show or do. Skins only render; App owns the
 * connection, command queue, voice session and text input state.
 */
export interface RemoteSkinProps {
  /** Friendly name of the TV being controlled, when known. */
  deviceName: string | undefined;
  status: DeviceState['status'];
  /** Remote keys are unavailable (busy, bridge not ready, or not connected). */
  remoteDisabled: boolean;
  /** App actions such as Disconnect are unavailable (busy or bridge not ready). */
  appDisabled: boolean;
  busy: boolean;
  /** Non-fatal error from the last remote action, if any. */
  errorMessage: string | null;
  onCommand: (command: RemoteCommand) => void;
  assistantListening: boolean;
  /** Start or stop a voice (Google Assistant) session. */
  onAssistant: () => void;
  text: {
    supported: boolean;
    open: boolean;
    value: string;
    onToggle: () => void;
    onClose: () => void;
    onChange: (value: string) => void;
    onSend: () => void;
  };
  onDevices: () => void;
  onDisconnect: () => void;
  /** Forget the current TV; undefined when there is none to forget. */
  onForget: (() => void) | undefined;
  onSettings: () => void;
  /** Name of the linked speaker that takes the volume keys, when the link is on. */
  volumeTarget: string | undefined;
}

export interface RemoteSkin {
  id: RemoteSkinId;
  name: string;
  description: string;
  /** Window size used while this skin's remote screen is showing. */
  layout: WindowLayout;
  /** The skin draws the whole window, including its own app controls. */
  fullWindow: boolean;
  Component: ComponentType<RemoteSkinProps>;
}
