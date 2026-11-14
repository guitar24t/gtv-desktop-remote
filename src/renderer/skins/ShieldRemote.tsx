import { useEffect, useRef, useState, type ReactNode } from 'react';

import type { RemoteCommand } from '../../shared/types';
import { Icon, type IconName } from '../components/Icon';
import { classes } from '../lib/pure';

import type { RemoteSkinProps } from './types';

/**
 * A slim black remote laid out like the 2019 NVIDIA SHIELD TV remote:
 *
 *   microphone · status
 *   Power            Settings
 *        navigation ring
 *   Back                 Home
 *   Fast-forward        Voice
 *   Play/Pause         Volume +
 *   Rewind             Volume −
 *          ( oval key )
 *
 * The ≡ key sends Android's Menu key, as the real remote does. The real oval
 * key opens Netflix; here it mutes, since the hardware has no dedicated mute key. App controls (devices, keyboard, disconnect, settings)
 * sit in a small dock below the keys. No NVIDIA artwork or logos are used.
 */
export function ShieldRemote({
  deviceName,
  status,
  remoteDisabled,
  appDisabled,
  busy,
  errorMessage,
  onCommand,
  assistantListening,
  onAssistant,
  text,
  onDevices,
  onDisconnect,
  onForget,
  onSettings,
}: RemoteSkinProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (text.open) textAreaRef.current?.focus();
  }, [text.open]);

  function key(command: RemoteCommand, label: string, icon: IconName, className?: string) {
    return (
      <ShieldKey
        label={label}
        className={className}
        disabled={remoteDisabled}
        onPress={() => {
          onCommand(command);
        }}
      >
        <Icon name={icon} className="shield-glyph" />
      </ShieldKey>
    );
  }

  const ledState =
    status === 'connected' ? 'connected' : status === 'error' ? 'error' : 'connecting';

  return (
    <div className="shield-remote">
      <div className="shield-body">
        <div className="shield-top">
          <span className="shield-mic-hole" aria-hidden />
          <div
            className="shield-status"
            role="status"
            aria-label={`${deviceName ?? 'TV'}: ${status === 'connected' ? 'Connected' : status}`}
          >
            <span className={`shield-led shield-led-${ledState}`} aria-hidden />
            <span className="shield-device">{deviceName ?? 'Choose Device'}</span>
          </div>
        </div>

        {errorMessage ? (
          <div className="shield-toast" role="alert">
            {errorMessage}
          </div>
        ) : null}

        <div className="shield-row">
          {key('power', 'Power', 'power', 'shield-key-small')}
          {/* Menu key: SHIELD opens Settings, or the action set under Remotes & Accessories. */}
          {key('menu', 'TV settings', 'menu', 'shield-key-small')}
        </div>

        <div className="shield-ring" role="group" aria-label="Navigation">
          {key('up', 'Up', 'up', 'shield-ring-key shield-ring-up')}
          {key('left', 'Left', 'left', 'shield-ring-key shield-ring-left')}
          {key('right', 'Right', 'right', 'shield-ring-key shield-ring-right')}
          {key('down', 'Down', 'down', 'shield-ring-key shield-ring-down')}
          <ShieldKey
            label="Select"
            className="shield-select"
            disabled={remoteDisabled}
            onPress={() => {
              onCommand('select');
            }}
          />
        </div>

        <div className="shield-row">
          {key('back', 'Back', 'back')}
          {key('home', 'Home', 'home')}
        </div>

        <div className="shield-columns">
          <div className="shield-column">
            {key('fast_forward', 'Fast-forward', 'fastForward')}
            {key('play_pause', 'Play/Pause', 'playPause')}
            {key('rewind', 'Rewind', 'rewind')}
          </div>
          <div className="shield-column">
            <ShieldKey
              label={assistantListening ? 'Stop voice' : 'Voice'}
              className={classes(assistantListening && 'shield-key-listening')}
              disabled={remoteDisabled}
              pressed={assistantListening}
              onPress={onAssistant}
            >
              <Icon name="mic" className="shield-glyph" />
            </ShieldKey>
            {key('volume_up', 'Volume up', 'plus')}
            {key('volume_down', 'Volume down', 'minus')}
          </div>
        </div>

        <ShieldKey
          label="Mute"
          className="shield-oval"
          disabled={remoteDisabled}
          onPress={() => {
            onCommand('mute');
          }}
        >
          <Icon name="mute" className="shield-glyph" />
        </ShieldKey>

        <nav className="shield-dock" aria-label="Remote app">
          <button
            type="button"
            className="shield-dock-button"
            aria-label="Devices"
            title="Devices"
            disabled={busy}
            onClick={onDevices}
          >
            <Icon name="devices" className="shield-dock-glyph" />
          </button>
          {text.supported ? (
            <button
              type="button"
              className="shield-dock-button"
              aria-label="Text"
              title="Send text"
              aria-pressed={text.open}
              disabled={remoteDisabled}
              onClick={() => {
                setMoreOpen(false);
                text.onToggle();
              }}
            >
              <Icon name="keyboard" className="shield-dock-glyph" />
            </button>
          ) : null}
          <button
            type="button"
            className="shield-dock-button"
            aria-label="More"
            title="More"
            aria-expanded={moreOpen}
            onClick={() => {
              if (text.open) text.onClose();
              setMoreOpen((current) => !current);
            }}
          >
            <Icon name="more" className="shield-dock-glyph" />
          </button>
        </nav>

        {text.open && text.supported ? (
          <section className="shield-sheet" aria-label="Text input">
            <textarea
              ref={textAreaRef}
              className="shield-textarea"
              value={text.value}
              onChange={(event) => {
                text.onChange(event.target.value);
              }}
              placeholder="Type text to send to the TV"
              rows={3}
            />
            <div className="shield-sheet-actions">
              <button
                type="button"
                className="shield-sheet-button"
                disabled={busy}
                onClick={text.onClose}
              >
                Close
              </button>
              <button
                type="button"
                className="shield-sheet-button shield-sheet-primary"
                disabled={remoteDisabled || !text.value.trim()}
                onClick={text.onSend}
              >
                Send Text
              </button>
            </div>
          </section>
        ) : null}

        {moreOpen ? (
          <section className="shield-sheet" aria-label="More">
            <button
              type="button"
              className="shield-sheet-item"
              disabled={busy}
              onClick={() => {
                setMoreOpen(false);
                onSettings();
              }}
            >
              <Icon name="settings" className="h-4 w-4" />
              Settings
            </button>
            <button
              type="button"
              className="shield-sheet-item"
              disabled={appDisabled}
              onClick={() => {
                setMoreOpen(false);
                onDisconnect();
              }}
            >
              <Icon name="disconnect" className="h-4 w-4" />
              Disconnect
            </button>
            <button
              type="button"
              className="shield-sheet-item shield-sheet-danger"
              disabled={appDisabled || !onForget}
              onClick={() => {
                setMoreOpen(false);
                onForget?.();
              }}
            >
              <Icon name="trash" className="h-4 w-4" />
              Forget
            </button>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function ShieldKey({
  label,
  className,
  disabled,
  pressed,
  onPress,
  children,
}: {
  label: string;
  className?: string;
  disabled: boolean;
  pressed?: boolean;
  onPress: () => void;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      className={classes('shield-key', className)}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onPress}
    >
      {children}
    </button>
  );
}
