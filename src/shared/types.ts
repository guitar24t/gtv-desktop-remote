export type RemoteCommand =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'select'
  | 'home'
  | 'back'
  | 'play_pause'
  | 'volume_up'
  | 'volume_down'
  | 'power'
  | 'rewind'
  | 'fast_forward'
  | 'mute'
  | 'menu'
  | 'assistant_press'
  | 'assistant_release';

export type RemoteCommandSource = 'keyboard' | 'button';

export type CommandDropReason =
  | 'renderer_burst_limit'
  | 'no_active_device'
  | 'connect_failed'
  | 'socket_destroyed'
  | 'socket_backpressure'
  | 'send_failed'
  | 'unknown';

export interface CommandDispatchRequest {
  id: string;
  command: RemoteCommand;
  issuedAt: number;
  source: RemoteCommandSource;
}

export interface CommandDropReport extends CommandDispatchRequest {
  droppedAt: number;
  dropReason: CommandDropReason;
  pendingCommandCount?: number;
}

export interface CommandMetricsRecord extends CommandDispatchRequest {
  updatedAt: number;
  status: 'pending' | 'sent' | 'dropped' | 'failed';
  lastStage:
    | 'renderer_dropped'
    | 'ipc_received'
    | 'adapter_dispatch_started'
    | 'adapter_dispatch_completed'
    | 'bridge_send_started'
    | 'connect_started'
    | 'connect_completed'
    | 'socket_write_completed'
    | 'socket_drained'
    | 'completed'
    | 'failed';
  deviceId?: string;
  host?: string;
  errorMessage?: string;
  dropReason?: CommandDropReason;
  pendingCommandCount?: number;
  ipcReceivedAt?: number;
  adapterDispatchStartedAt?: number;
  adapterDispatchCompletedAt?: number;
  bridgeSendStartedAt?: number;
  connectStartedAt?: number;
  connectCompletedAt?: number;
  socketWriteAt?: number;
  socketDrainedAt?: number;
  completedAt?: number;
  rendererDroppedAt?: number;
  socketWriteBuffered?: boolean;
}

export interface MetricsWarning {
  code: 'connect_stalled' | 'send_stalled' | 'backpressure' | 'no_inbound_activity';
  message: string;
  createdAt: number;
  host?: string;
  commandId?: string;
}

export interface CommandMetricsCounters {
  totalSubmitted: number;
  totalSucceeded: number;
  totalDropped: number;
  totalFailed: number;
  rendererDrops: number;
  backpressureEvents: number;
  connectAttempts: number;
  connectFailures: number;
  stallWarnings: number;
}

export interface CommandMetricsTransportSnapshot {
  socketState: 'disconnected' | 'connecting' | 'connected';
  currentHost?: string;
  pendingConnectHost?: string;
  pendingCommandId?: string;
  lastCommandIssuedAt?: number;
  lastConnectStartedAt?: number;
  lastConnectCompletedAt?: number;
  lastSuccessfulSendAt?: number;
  lastInboundMessageAt?: number;
  lastSocketDrainAt?: number;
  consecutiveSendFailures: number;
  backpressureEvents: number;
}

export interface CommandMetricsSnapshot {
  generatedAt: number;
  counters: CommandMetricsCounters;
  transport: CommandMetricsTransportSnapshot;
  warnings: MetricsWarning[];
  recentCommands: CommandMetricsRecord[];
}

export type AudioOutputKind = 'sonos';

/**
 * A speaker that takes over this TV's volume and mute keys, for setups where
 * the TV's own volume does not reach the speaker (e.g. a soundbar controlled
 * by infrared). Stored per TV, and can be switched off without unlinking.
 */
export interface AudioOutputLink {
  enabled: boolean;
  kind: AudioOutputKind;
  /** Sonos room's player UUID (`RINCON_…`). */
  id: string;
  /** Room name when it was linked, for display. */
  name: string;
  /** Last known address; refreshed automatically when the speaker moves. */
  host?: string;
  /** Volume change per key press, 1–10. */
  volumeStep: number;
}

/** A speaker found on the network that a TV's volume keys can be linked to. */
export interface DiscoveredAudioOutput {
  kind: AudioOutputKind;
  id: string;
  name: string;
  host: string;
  model?: string;
}

/** Pushed after a linked speaker's volume or mute changes. */
export interface AudioVolumeEvent {
  deviceId: string;
  outputName: string;
  volume?: number;
  muted?: boolean;
}

export interface SavedDevice {
  id: string;
  name: string;
  host: string;
  isPaired?: boolean;
  adbPort?: number;
  pairingPort?: number;
  macAddress?: string;
  castDeviceId?: string;
  networkHostName?: string;
  deviceFingerprint?: string;
  lastConnectedAt?: string;
  audioOutput?: AudioOutputLink;
}

export interface DiscoveredDevice {
  id: string;
  name: string;
  host: string;
  adbPort?: number;
  pairingPort?: number;
  remotePort?: number;
  macAddress?: string;
  castDeviceId?: string;
  networkHostName?: string;
  deviceFingerprint?: string;
  model?: string;
  source: 'googlecast' | 'adb' | 'androidtvremote';
}

export interface PairingRequest {
  deviceId?: string;
  host: string;
  code: string;
  macAddress?: string;
  castDeviceId?: string;
}

export interface DeviceDraft {
  name: string;
  host: string;
  adbPort: number;
  pairingPort?: number;
  macAddress?: string;
  castDeviceId?: string;
  networkHostName?: string;
  deviceFingerprint?: string;
}

export interface DeviceState {
  status: 'idle' | 'connecting' | 'connected' | 'error';
  message: string;
  activeDeviceId?: string;
}

export interface BootstrapState {
  devices: SavedDevice[];
  deviceState: DeviceState;
}

export interface DeviceCapabilities {
  textInput: boolean;
  powerToggle: boolean;
}

export interface UpdaterStatus {
  inProgress: boolean;
  stage: 'idle' | 'checking' | 'downloading' | 'installing' | 'completed' | 'failed';
  progressPercent?: number;
  etaSeconds?: number;
  lastCheckedAt?: string;
  currentVersion: string;
  latestVersion?: string;
  updateAvailable?: boolean;
  updateInstallable?: boolean;
  rollbackAvailable?: boolean;
  rollbackVersion?: string;
  rollbackCreatedAt?: string;
  /**
   * True once an update or rollback has replaced the app bundle on disk. The
   * running process is still the previous version, so no further check or
   * install runs until GTV Remote relaunches.
   */
  relaunchRequired?: boolean;
  /** Version now installed on disk and waiting for a relaunch. */
  installedVersion?: string;
  message: string;
}

export interface DeviceAdapter {
  listDevices(): Promise<SavedDevice[]>;
  scanForDevices(): Promise<DiscoveredDevice[]>;
  saveDevice(draft: DeviceDraft): Promise<SavedDevice[]>;
  removeDevice(deviceId: string): Promise<SavedDevice[]>;
  resetState(): Promise<DeviceState>;
  startPairing(deviceId: string): Promise<DeviceState>;
  pair(request: PairingRequest): Promise<void>;
  connect(deviceId: string): Promise<DeviceState>;
  disconnect(): Promise<DeviceState>;
  sendCommand(request: CommandDispatchRequest): Promise<void>;
  sendText(text: string): Promise<void>;
  startAssistantVoice(): Promise<number>;
  sendAssistantVoiceChunk(sessionId: number, chunkBase64: string): Promise<void>;
  stopAssistantVoice(sessionId: number): Promise<void>;
  hasPendingAssistantVoiceSession(): Promise<boolean>;
  discoverAudioOutputs(): Promise<DiscoveredAudioOutput[]>;
  setAudioOutput(deviceId: string, link: AudioOutputLink | null): Promise<SavedDevice[]>;
  getCapabilities(): Promise<DeviceCapabilities>;
  getBootstrapState(): Promise<BootstrapState>;
}
