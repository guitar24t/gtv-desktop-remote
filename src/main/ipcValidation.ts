import { isIP } from 'node:net';

import type {
  AudioOutputLink,
  CommandDispatchRequest,
  CommandDropReason,
  CommandDropReport,
  DeviceDraft,
  PairingRequest,
  RemoteCommand,
  RemoteCommandSource,
} from '../shared/types';
import { isWindowLayout, type WindowLayout } from '../shared/windowLayout';

/**
 * Runtime validation for renderer → main IPC payloads. TypeScript types end at
 * the process boundary; anything arriving over IPC is untrusted input.
 */

const REMOTE_COMMANDS = [
  'up',
  'down',
  'left',
  'right',
  'select',
  'home',
  'back',
  'play_pause',
  'volume_up',
  'volume_down',
  'power',
  'rewind',
  'fast_forward',
  'mute',
  'menu',
  'assistant_press',
  'assistant_release',
] as const satisfies readonly RemoteCommand[];
const _everyRemoteCommandListed: Exclude<
  RemoteCommand,
  (typeof REMOTE_COMMANDS)[number]
> extends never
  ? true
  : never = true;

const COMMAND_SOURCES = ['keyboard', 'button'] as const satisfies readonly RemoteCommandSource[];
const _everySourceListed: Exclude<
  RemoteCommandSource,
  (typeof COMMAND_SOURCES)[number]
> extends never
  ? true
  : never = true;

const DROP_REASONS = [
  'renderer_burst_limit',
  'no_active_device',
  'connect_failed',
  'socket_destroyed',
  'socket_backpressure',
  'send_failed',
  'unknown',
] as const satisfies readonly CommandDropReason[];
const _everyDropReasonListed: Exclude<
  CommandDropReason,
  (typeof DROP_REASONS)[number]
> extends never
  ? true
  : never = true;

export const MAX_TEXT_INPUT_LENGTH = 4096;
const MAX_VOICE_CHUNK_BASE64_LENGTH = 1_000_000;
const HOSTNAME =
  /^(?=.{1,253}\.?$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.length > max) {
    throw new Error(`Invalid ${field}.`);
  }
  return value;
}

function optionalString(value: unknown, field: string, max = 256): string | undefined {
  return value === undefined ? undefined : boundedString(value, field, max);
}

function port(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new Error(`Invalid ${field}.`);
  }
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`Invalid ${field}.`);
  }
  return value as T;
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid ${field}.`);
  }
  return value;
}

export function requireHost(value: unknown): string {
  const host = boundedString(value, 'device address', 253).trim();
  if (!host || (isIP(host) === 0 && !HOSTNAME.test(host))) {
    throw new Error('Invalid device address.');
  }
  return host;
}

export function requireDeviceId(value: unknown): string {
  const id = boundedString(value, 'device ID', 128).trim();
  if (!id) throw new Error('Invalid device ID.');
  return id;
}

export function requireDeviceDraft(value: unknown): DeviceDraft {
  if (!isRecord(value)) throw new Error('Invalid device.');
  return {
    name: boundedString(value.name, 'device name', 200),
    host: requireHost(value.host),
    adbPort: port(value.adbPort, 'ADB port'),
    pairingPort:
      value.pairingPort === undefined ? undefined : port(value.pairingPort, 'pairing port'),
    macAddress: optionalString(value.macAddress, 'MAC address'),
    castDeviceId: optionalString(value.castDeviceId, 'Cast device ID'),
    networkHostName: optionalString(value.networkHostName, 'network host name'),
    deviceFingerprint: optionalString(value.deviceFingerprint, 'device fingerprint'),
  };
}

export function requirePairingRequest(value: unknown): PairingRequest {
  if (!isRecord(value)) throw new Error('Invalid pairing request.');
  const code = boundedString(value.code, 'pairing code', 32).trim();
  if (!/^[0-9a-f]{6}$/i.test(code)) {
    throw new Error('Invalid pairing code. Enter the six characters (0–9, A–F) shown on the TV.');
  }
  return {
    deviceId: value.deviceId === undefined ? undefined : requireDeviceId(value.deviceId),
    host: requireHost(value.host),
    code,
    macAddress: optionalString(value.macAddress, 'MAC address'),
    castDeviceId: optionalString(value.castDeviceId, 'Cast device ID'),
  };
}

export function requireCommandRequest(value: unknown): CommandDispatchRequest {
  if (!isRecord(value)) throw new Error('Invalid command.');
  const id = boundedString(value.id, 'command ID', 128);
  if (!id) throw new Error('Invalid command ID.');
  return {
    id,
    command: oneOf(value.command, REMOTE_COMMANDS, 'command'),
    issuedAt: finiteNumber(value.issuedAt, 'command time'),
    source: oneOf(value.source, COMMAND_SOURCES, 'command source'),
  };
}

export function requireCommandDropReport(value: unknown): CommandDropReport {
  const request = requireCommandRequest(value);
  if (!isRecord(value)) throw new Error('Invalid command drop report.');
  const pending = value.pendingCommandCount;
  if (
    pending !== undefined &&
    (typeof pending !== 'number' || !Number.isInteger(pending) || pending < 0)
  ) {
    throw new Error('Invalid pending command count.');
  }
  return {
    ...request,
    droppedAt: finiteNumber(value.droppedAt, 'drop time'),
    dropReason: oneOf(value.dropReason, DROP_REASONS, 'drop reason'),
    pendingCommandCount: pending,
  };
}

export function requireTextInput(value: unknown): string {
  return boundedString(value, 'text', MAX_TEXT_INPUT_LENGTH);
}

export function requireVoiceSessionId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Invalid voice session.');
  }
  return value;
}

export function requireVoiceChunk(value: unknown): string {
  const chunk = boundedString(value, 'voice chunk', MAX_VOICE_CHUNK_BASE64_LENGTH);
  if (!BASE64.test(chunk)) throw new Error('Invalid voice chunk.');
  return chunk;
}

export function requireWindowLayout(value: unknown): WindowLayout {
  if (!isWindowLayout(value)) throw new Error('Invalid window layout.');
  return value;
}

const SONOS_PLAYER_ID = /^RINCON_[0-9A-F]{12,40}$/i;

/** A speaker link from Settings, or `null` to unlink. */
export function requireAudioOutputLink(value: unknown): AudioOutputLink | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new Error('Invalid speaker link.');
  if (typeof value.enabled !== 'boolean') throw new Error('Invalid speaker link.');
  if (value.kind !== 'sonos') throw new Error('Unsupported speaker type.');
  const id = boundedString(value.id, 'speaker ID', 64);
  if (!SONOS_PLAYER_ID.test(id)) throw new Error('Invalid speaker ID.');
  const step = value.volumeStep;
  if (typeof step !== 'number' || !Number.isInteger(step) || step < 1 || step > 10) {
    throw new Error('Invalid volume step.');
  }
  return {
    enabled: value.enabled,
    kind: 'sonos',
    id,
    name: boundedString(value.name, 'speaker name', 200),
    host: value.host === undefined ? undefined : requireHost(value.host),
    volumeStep: step,
  };
}
