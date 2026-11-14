import type { RemoteCommand } from '../../shared/types';

/**
 * Keyboard event key to RemoteCommand mapping.
 * Pure data structure for keyboard shortcut handling.
 */
export const KEYBOARD_COMMAND_MAP: Partial<Record<string, RemoteCommand>> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Enter: 'select',
  Escape: 'back',
  Backspace: 'back',
  h: 'home',
  H: 'home',
  ' ': 'play_pause',
  k: 'play_pause',
  K: 'play_pause',
  '+': 'volume_up',
  '=': 'volume_up',
  '-': 'volume_down',
  _: 'volume_down',
  p: 'power',
  P: 'power',
};

/**
 * Commands that may auto-repeat while their key is held: directional
 * navigation and volume. Every other command toggles or changes screens
 * (power, play/pause, select, back, home), so a held key must act once.
 */
const KEY_REPEAT_COMMANDS = new Set<RemoteCommand>([
  'up',
  'down',
  'left',
  'right',
  'volume_up',
  'volume_down',
]);

/** True when a held key (a `keydown` with `repeat`) may dispatch `command` again. */
export function allowsKeyRepeat(command: RemoteCommand): boolean {
  return KEY_REPEAT_COMMANDS.has(command);
}

/**
 * Commands that are sensitive to burst/rapid input.
 * These commands will be batched together if repeated rapidly.
 */
export const BURST_SENSITIVE_COMMANDS = new Set<RemoteCommand>([
  'up',
  'down',
  'left',
  'right',
  'select',
]);

/**
 * Maximum number of commands that can be queued.
 * Commands beyond this are dropped with a warning.
 */
export const MAX_QUEUED_COMMANDS = 100;

/**
 * Minimum chunk size for assistant voice input.
 */
export const ASSISTANT_VOICE_MIN_CHUNK_BYTES = 8 * 1024;

/**
 * Initial chunk size for assistant voice stream.
 */
export const ASSISTANT_VOICE_INITIAL_CHUNK_BYTES = 8 * 1024;

/**
 * Streaming chunk size for assistant voice input.
 */
export const ASSISTANT_VOICE_STREAM_CHUNK_BYTES = 20 * 1024;
