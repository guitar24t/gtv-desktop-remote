/**
 * Type definitions and constants for Android TV Remote functionality.
 * Extracted from androidTvRemote.ts to reduce complexity and enable reuse.
 */

import type { CommandDispatchRequest } from '../../shared/types';

import type { PemPair } from './protocol/certificate';

export interface RemoteClientPort {
  disconnect(): void;
  /**
   * True when this connection has observed TV pings but none recently, which
   * indicates a half-open socket (e.g. after sleep/wake or a Wi-Fi change).
   */
  isStale(now?: number): boolean;
  connect(commandId?: string): Promise<void>;
  sendCommand(request: CommandDispatchRequest): Promise<void> | void;
  sendText(text: string): Promise<void> | void;
  startVoiceSession(): Promise<number>;
  sendVoiceChunk(sessionId: number, samples: Buffer): Promise<void> | void;
  stopVoiceSession(sessionId: number): Promise<void> | void;
  readonly snapshot: RemoteState;
  readonly isConnected: boolean;
}

export interface PairingClientPort {
  close(): Promise<void>;
  start(): Promise<unknown>;
  submitCode(code: string): Promise<{ type: string; status?: string }>;
}

/**
 * Device information retrieved from the TV during connection.
 * Partial/optional fields because the TV may not report all of these.
 */
export interface RemoteDeviceInfo {
  model?: string;
  vendor?: string;
  appVersion?: string;
}

/**
 * Snapshot of the TV remote's current state.
 * Updated incrementally as protocol messages are received.
 */
export interface RemoteState {
  currentApp?: string;
  isOn?: boolean;
  deviceInfo?: RemoteDeviceInfo;
  imeCounter: number;
  imeFieldCounter: number;
  lastActivityAt: number;
  /** When the TV last pinged this connection; undefined until the first ping. */
  lastPingAt?: number;
  voiceSessionId?: number;
}

/**
 * Identifies the saved device a bridge call is for. Credentials, sessions and
 * the server pin are keyed by `deviceId`; `host` is where the TV is now.
 */
export interface DeviceTarget {
  deviceId: string;
  host: string;
  /**
   * Keys of pre-id credential files (MAC, then host) this device may adopt
   * when it has no id-keyed pair yet. See `legacyCertKeysFor`.
   */
  legacyCertKeys?: readonly string[];
}

/**
 * Session data for a connected device.
 * Holds certificates, pairing state, and the active remote client.
 */
export interface DeviceSession {
  certs: PemPair;
  pairingManager?: PairingClientPort;
  pairingReady?: Promise<void>;
  remoteClient?: RemoteClientPort;
}

/**
 * A connection that has seen TV pings but none for this long is treated as
 * half-open and is replaced before the next command. TVs ping every ~5s.
 */
export const STALE_CONNECTION_MS = 15_000;

/**
 * Android TV pairing port (default).
 */
export const DEFAULT_PAIRING_PORT = 6467;

/**
 * Service name advertised to the TV during pairing.
 */
export const SERVICE_NAME = 'GTV Desktop Remote';

/**
 * Convert any value to an Error, with a fallback message.
 */
export function toError(error: unknown, fallback: string): Error {
  if (error instanceof Error) {
    return error;
  }

  if (typeof error === 'string' && error.trim()) {
    return new Error(error);
  }

  if (typeof error === 'boolean') {
    return new Error(error ? fallback : 'Operation failed.');
  }

  return new Error(fallback);
}

export const CERTIFICATE_REJECTED_MESSAGE =
  'The TV rejected the saved pairing certificate. Start pairing again. If this keeps happening, remove this remote from the TV and pair again.';

/** The TV refused our client certificate (TLS alert 46): pairing is needed. */
export class CertificateRejectedError extends Error {
  readonly code = 'CERTIFICATE_REJECTED';

  constructor() {
    super(CERTIFICATE_REJECTED_MESSAGE);
    this.name = 'CertificateRejectedError';
  }
}

/** The TV at `host` presented a different certificate than the pinned one. */
export class ServerIdentityMismatchError extends Error {
  readonly code = 'SERVER_IDENTITY_MISMATCH';

  constructor(host: string) {
    super(
      `The device at ${host} does not match the paired TV. Rescan for devices, then try again. If the TV was reset, forget it and pair again.`
    );
    this.name = 'ServerIdentityMismatchError';
  }
}

/**
 * Check if an error is a certificate rejection from the TV.
 */
export function isCertificateRejectedError(error: unknown): boolean {
  if (error instanceof CertificateRejectedError) {
    return true;
  }
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (code === 'ERR_SSL_SSLV3_ALERT_CERTIFICATE_UNKNOWN') {
    return true;
  }
  const message = toError(error, '').message;
  return message.includes('SSLV3_ALERT_CERTIFICATE_UNKNOWN') || message.includes('alert number 46');
}

/**
 * Normalize errors from the TLS layer or protocol to user-facing messages.
 * Handles certificate rejection, timeouts, and other common failures.
 */
export function normalizeRemoteError(error: unknown, fallback: string): Error {
  if (error instanceof CertificateRejectedError || error instanceof ServerIdentityMismatchError) {
    return error;
  }

  if (isCertificateRejectedError(error)) {
    return new CertificateRejectedError();
  }

  const normalized = toError(error, fallback);

  if (normalized.message.includes('Remote connection timed out.')) {
    return new Error(
      'The TV did not respond on the Android TV Remote port. Make sure the TV is awake and Android TV Remote Service is available, then try pairing again.'
    );
  }

  return normalized;
}
