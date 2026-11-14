import { describe, expect, it } from 'vitest';

import type { RemoteCommand } from '../../../shared/types';
import { allowsKeyRepeat, KEYBOARD_COMMAND_MAP } from '../remoteCommands';

describe('allowsKeyRepeat', () => {
  it.each<RemoteCommand>([
    'up',
    'down',
    'left',
    'right',
    'volume_up',
    'volume_down',
    'rewind',
    'fast_forward',
  ])('lets a held key repeat %s', (command) => {
    expect(allowsKeyRepeat(command)).toBe(true);
  });

  it.each<RemoteCommand>(['power', 'play_pause', 'select', 'back', 'home', 'mute', 'menu'])(
    'acts once for a held %s key',
    (command) => {
      expect(allowsKeyRepeat(command)).toBe(false);
    }
  );

  it('repeats exactly the arrow, volume and seek keys of the keyboard map', () => {
    const repeatingKeys = Object.entries(KEYBOARD_COMMAND_MAP)
      .filter(([, command]) => command !== undefined && allowsKeyRepeat(command))
      .map(([key]) => key)
      .sort();
    expect(repeatingKeys).toEqual(
      ['+', '-', '=', '[', ']', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp', '_'].sort()
    );
  });
});

describe('media keys on the keyboard', () => {
  it.each([
    ['[', 'rewind'],
    [']', 'fast_forward'],
    ['m', 'mute'],
    ['M', 'mute'],
  ] as const)('maps %s to %s', (key, command) => {
    expect(KEYBOARD_COMMAND_MAP[key]).toBe(command);
  });
});
