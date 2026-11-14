import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppPreferences, PreferenceResult } from '../../shared/preferences';
import { ShortcutRecorder } from '../ShortcutRecorder';

const preferences: AppPreferences = {
  shortcut: 'CommandOrControl+Shift+G',
  activeShortcut: 'CommandOrControl+Shift+G',
  shortcutError: null,
  launchAtLogin: false,
  launchAtLoginError: null,
  launchAtLoginSupported: false,
};

function setup() {
  const capture = vi
    .fn<(recording: boolean) => Promise<PreferenceResult>>()
    .mockResolvedValue({ preferences, error: null });
  vi.stubGlobal('gtvRemote', { setShortcutCapture: capture });
  const onChange = vi.fn();
  const onError = vi.fn();
  const outerKeyDown = vi.fn();
  const view = render(
    <div onKeyDown={outerKeyDown}>
      <ShortcutRecorder
        shortcut={preferences.shortcut}
        disabled={false}
        onChange={onChange}
        onPreferences={vi.fn()}
        onError={onError}
        onRecording={vi.fn()}
      />
    </div>
  );
  const button = screen.getByRole('button', { name: /record shortcut/i });
  return { ...view, button, capture, onChange, onError, outerKeyDown };
}

afterEach(() => vi.unstubAllGlobals());

describe('accessible shortcut recording', () => {
  it('pauses before capture, previews modifiers, rejects unsupported keys, and restores before returning canonical keys', async () => {
    const view = setup();
    fireEvent.focus(view.button);
    await screen.findByText('Press a shortcut. Escape cancels.');
    expect(view.capture).toHaveBeenCalledWith(true);
    fireEvent.keyDown(view.button, { key: 'Control', ctrlKey: true });
    expect(view.button).toHaveTextContent('Ctrl');
    fireEvent.keyDown(view.button, { key: ' ', code: 'Space', ctrlKey: true });
    expect(screen.getByRole('status')).toHaveTextContent('not supported');
    fireEvent.keyDown(view.button, {
      key: 'g',
      code: 'KeyG',
      ctrlKey: true,
      altKey: true,
      repeat: true,
    });
    expect(view.onChange).not.toHaveBeenCalled();
    const event = new KeyboardEvent('keydown', {
      key: 'g',
      code: 'KeyG',
      ctrlKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(view.button, event);
    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByRole('status')).toHaveTextContent('Release keys');
    expect(view.capture.mock.calls.map(([value]) => value)).toEqual([true]);
    expect(view.onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(view.button, {
      key: 'g',
      code: 'KeyG',
      ctrlKey: true,
      altKey: true,
      repeat: true,
    });
    fireEvent.keyDown(view.button, { key: 'r', code: 'KeyR', ctrlKey: true });
    fireEvent.keyUp(view.button, { key: 'r', code: 'KeyR', ctrlKey: true });
    expect(view.capture.mock.calls.map(([value]) => value)).toEqual([true]);
    expect(view.onChange).not.toHaveBeenCalled();
    fireEvent.keyUp(view.button, { key: 'g', code: 'KeyG', ctrlKey: true, altKey: true });
    await waitFor(() => {
      expect(view.onChange).toHaveBeenCalledWith('Control+Alt+G');
    });
    expect(view.capture.mock.calls.map(([value]) => value)).toEqual([true, false]);
    expect(view.outerKeyDown).not.toHaveBeenCalled();
  });

  it.each(['Escape', 'Tab', 'blur', 'window blur', 'unmount'])(
    'cancels on %s without changing the shortcut',
    async (action) => {
      const view = setup();
      fireEvent.focus(view.button);
      await screen.findByText('Press a shortcut. Escape cancels.');
      fireEvent.keyDown(view.button, { key: 'g', code: 'KeyG', ctrlKey: true, altKey: true });
      if (action === 'blur') fireEvent.blur(view.button);
      else if (action === 'window blur') fireEvent.blur(window);
      else if (action === 'unmount') view.unmount();
      else fireEvent.keyDown(view.button, { key: action });
      await waitFor(() => {
        expect(view.capture).toHaveBeenLastCalledWith(false);
      });
      expect(view.onChange).not.toHaveBeenCalled();
      if (action === 'Escape') expect(view.outerKeyDown).not.toHaveBeenCalled();
    }
  );

  it.each([
    { shiftKey: false, destination: 'Save shortcut' },
    { shiftKey: true, destination: 'Done' },
  ])(
    'restores before moving Tab focus to $destination without restarting capture',
    async ({ shiftKey, destination }) => {
      let restore!: (result: PreferenceResult) => void;
      const restoration = new Promise<PreferenceResult>((resolve) => {
        restore = resolve;
      });
      const capture = vi
        .fn<(recording: boolean) => Promise<PreferenceResult>>()
        .mockResolvedValue({ preferences, error: null })
        .mockResolvedValueOnce({ preferences, error: null })
        .mockReturnValueOnce(restoration);
      vi.stubGlobal('gtvRemote', { setShortcutCapture: capture });
      const onChange = vi.fn();
      function Settings() {
        const [recording, setRecording] = useState(false);
        return (
          <section>
            <button disabled={recording}>Done</button>
            <ShortcutRecorder
              shortcut={preferences.shortcut}
              disabled={false}
              onChange={onChange}
              onPreferences={vi.fn()}
              onError={vi.fn()}
              onRecording={setRecording}
            />
            <button disabled={recording}>Save shortcut</button>
          </section>
        );
      }
      render(<Settings />);
      const recorder = screen.getByRole('button', { name: /record shortcut/i });
      act(() => {
        recorder.focus();
      });
      await waitFor(() => expect(recorder).toHaveAttribute('aria-pressed', 'true'));
      const target = screen.getByRole('button', { name: destination });
      expect(target).toBeDisabled();
      const tab = new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey,
        bubbles: true,
        cancelable: true,
      });
      fireEvent(recorder, tab);
      expect(tab.defaultPrevented).toBe(true);
      expect(capture.mock.calls.map(([value]) => value)).toEqual([true, false]);
      expect(recorder).toHaveFocus();
      expect(target).toBeDisabled();

      await act(async () => {
        restore({ preferences, error: null });
        await restoration;
      });
      expect(recorder).toHaveAttribute('aria-pressed', 'false');
      expect(target).toBeEnabled();
      expect(target).toHaveFocus();
      expect(capture.mock.calls.map(([value]) => value)).toEqual([true, false]);
      expect(onChange).not.toHaveBeenCalled();

      act(() => {
        recorder.focus();
      });
      await waitFor(() => expect(recorder).toHaveAttribute('aria-pressed', 'true'));
      expect(capture.mock.calls.map(([value]) => value)).toEqual([true, false, true]);
      fireEvent.keyDown(recorder, { key: 'Escape' });
      await waitFor(() => expect(recorder).toHaveAttribute('aria-pressed', 'false'));
      expect(capture.mock.calls.map(([value]) => value)).toEqual([true, false, true, false]);
      expect(onChange).not.toHaveBeenCalled();
    }
  );

  it('restores even when cancellation arrives before pause completes', async () => {
    const view = setup();
    fireEvent.focus(view.button);
    fireEvent.keyDown(view.button, { key: 'Escape' });
    await waitFor(() => {
      expect(view.capture).toHaveBeenLastCalledWith(false);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(view.onChange).not.toHaveBeenCalled();
    expect(view.button).toHaveAttribute('aria-pressed', 'false');
  });

  it('surfaces a restoration conflict instead of claiming a recorded shortcut is ready to save', async () => {
    const view = setup();
    view.capture.mockResolvedValueOnce({ preferences, error: null }).mockResolvedValueOnce({
      preferences: {
        ...preferences,
        activeShortcut: null,
        shortcutError: 'Could not restore shortcut',
      },
      error: 'Could not restore shortcut',
    });
    fireEvent.focus(view.button);
    await screen.findByText('Press a shortcut. Escape cancels.');
    fireEvent.keyDown(view.button, { key: 'g', code: 'KeyG', ctrlKey: true, altKey: true });
    fireEvent.keyUp(view.button, { key: 'g', code: 'KeyG', ctrlKey: true, altKey: true });
    await waitFor(() => {
      expect(view.onError).toHaveBeenLastCalledWith('Could not restore shortcut');
    });
    expect(view.onChange).not.toHaveBeenCalled();
  });

  it('matches physical key release even when the released glyph differs from the pressed one', async () => {
    const view = setup();
    fireEvent.focus(view.button);
    await screen.findByText('Press a shortcut. Escape cancels.');
    fireEvent.keyDown(view.button, { key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true });
    fireEvent.keyUp(view.button, { key: 'r', code: 'KeyR', ctrlKey: true, shiftKey: true });
    expect(view.capture.mock.calls.map(([value]) => value)).toEqual([true]);
    fireEvent.keyUp(view.button, { key: '1', code: 'Digit1', ctrlKey: true, shiftKey: true });
    await waitFor(() => {
      expect(view.onChange).toHaveBeenCalledWith('Control+Shift+1');
    });
  });

  it('finishes with the captured chord when one of its modifiers is released first', async () => {
    const view = setup();
    fireEvent.focus(view.button);
    await screen.findByText('Press a shortcut. Escape cancels.');
    fireEvent.keyDown(view.button, { key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true });
    fireEvent.keyUp(view.button, { key: 'Shift', code: 'ShiftLeft', ctrlKey: true });
    await waitFor(() => {
      expect(view.onChange).toHaveBeenCalledWith('Control+Shift+1');
    });
    expect(view.capture.mock.calls.map(([value]) => value)).toEqual([true, false]);
  });

  it('records a Cmd chord when macOS withholds the letter keyup and Cmd is released', async () => {
    const view = setup();
    fireEvent.focus(view.button);
    await screen.findByText('Press a shortcut. Escape cancels.');
    fireEvent.keyDown(view.button, { key: 'Meta', code: 'MetaLeft', metaKey: true });
    fireEvent.keyDown(view.button, {
      key: 'Shift',
      code: 'ShiftLeft',
      metaKey: true,
      shiftKey: true,
    });
    fireEvent.keyDown(view.button, { key: 'g', code: 'KeyG', metaKey: true, shiftKey: true });
    expect(screen.getByRole('status')).toHaveTextContent('Release keys');
    // No keyup for G arrives while Cmd is held; the Cmd release itself must finish.
    fireEvent.keyUp(view.button, { key: 'Meta', code: 'MetaLeft', shiftKey: true });
    await waitFor(() => {
      expect(view.onChange).toHaveBeenCalledWith('Shift+Super+G');
    });
    expect(view.capture.mock.calls.map(([value]) => value)).toEqual([true, false]);
    expect(view.button).toHaveAttribute('aria-pressed', 'false');
  });

  it('keeps waiting when a modifier outside the captured chord is released', async () => {
    const view = setup();
    fireEvent.focus(view.button);
    await screen.findByText('Press a shortcut. Escape cancels.');
    fireEvent.keyDown(view.button, { key: 'g', code: 'KeyG', ctrlKey: true });
    fireEvent.keyUp(view.button, { key: 'Alt', code: 'AltLeft', ctrlKey: true });
    fireEvent.keyUp(view.button, { key: 'Meta', code: 'MetaLeft', ctrlKey: true });
    expect(view.capture.mock.calls.map(([value]) => value)).toEqual([true]);
    expect(screen.getByRole('status')).toHaveTextContent('Release keys');
    fireEvent.keyUp(view.button, { key: 'Control', code: 'ControlLeft' });
    await waitFor(() => {
      expect(view.onChange).toHaveBeenCalledWith('Control+G');
    });
  });

  it('uses the matching key release when a keyboard event has no physical code', async () => {
    const view = setup();
    fireEvent.focus(view.button);
    await screen.findByText('Press a shortcut. Escape cancels.');
    fireEvent.keyDown(view.button, { key: 'g', ctrlKey: true });
    fireEvent.keyUp(view.button, { key: 'r', ctrlKey: true });
    expect(view.onChange).not.toHaveBeenCalled();
    expect(view.capture.mock.calls.map(([value]) => value)).toEqual([true]);
    fireEvent.keyUp(view.button, { key: 'g', ctrlKey: true });
    await waitFor(() => {
      expect(view.onChange).toHaveBeenCalledWith('Control+G');
    });
  });
});
