import { Icon } from '../components/Icon';
import { classes } from '../lib/pure';

import type { RemoteSkinProps } from './types';

/** The original GTV Remote layout, drawn below the app header. */
export function ClassicRemote({
  deviceName,
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
}: RemoteSkinProps) {
  return (
    <div className="ui-remote-screen">
      <section className="ui-remote-summary">
        <div className="ui-status-pill">
          <span>{deviceName ?? 'Choose Device'}</span>
        </div>
      </section>

      {errorMessage ? <div className="ui-alert mx-6 mb-3 mt-0">{errorMessage}</div> : null}

      <section className="ui-dpad-wrap">
        <div className="ui-dpad">
          <button
            className="ui-dpad-edge ui-dpad-up"
            disabled={remoteDisabled}
            onClick={() => {
              onCommand('up');
            }}
          >
            <Icon name="up" className="h-7 w-7" />
          </button>
          <button
            className="ui-dpad-edge ui-dpad-down"
            disabled={remoteDisabled}
            onClick={() => {
              onCommand('down');
            }}
          >
            <Icon name="down" className="h-7 w-7" />
          </button>
          <button
            className="ui-dpad-edge ui-dpad-left"
            disabled={remoteDisabled}
            onClick={() => {
              onCommand('left');
            }}
          >
            <Icon name="left" className="h-7 w-7" />
          </button>
          <button
            className="ui-dpad-edge ui-dpad-right"
            disabled={remoteDisabled}
            onClick={() => {
              onCommand('right');
            }}
          >
            <Icon name="right" className="h-7 w-7" />
          </button>
          <button
            className="ui-dpad-center"
            disabled={remoteDisabled}
            onClick={() => {
              onCommand('select');
            }}
          >
            Select
          </button>
        </div>
      </section>

      {assistantListening ? (
        <div className="ui-assistant-wave" aria-label="Assistant listening">
          <span className="ui-assistant-dot ui-assistant-dot-blue" />
          <span className="ui-assistant-dot ui-assistant-dot-red" />
          <span className="ui-assistant-dot ui-assistant-dot-yellow" />
          <span className="ui-assistant-dot ui-assistant-dot-green" />
        </div>
      ) : null}

      <section className="ui-nav-well">
        <div className="ui-nav-grid">
          <button
            className="ui-nav-item"
            disabled={remoteDisabled}
            onClick={() => {
              onCommand('back');
            }}
          >
            <span className="ui-nav-button">
              <Icon name="back" className="h-6 w-6" />
            </span>
            <span className="ui-nav-label">Back</span>
          </button>
          <button
            className="ui-nav-item"
            disabled={remoteDisabled}
            onClick={() => {
              onCommand('home');
            }}
          >
            <span className="ui-nav-button ui-nav-button-active">
              <Icon name="home" className="h-7 w-7" />
            </span>
            <span className="ui-nav-label ui-nav-label-active">Home</span>
          </button>
          {text.supported ? (
            <button className="ui-nav-item" disabled={remoteDisabled} onClick={text.onToggle}>
              <span className="ui-nav-button">
                <Icon name="keyboard" className="h-6 w-6" />
              </span>
              <span className="ui-nav-label">Text</span>
            </button>
          ) : null}
        </div>
      </section>

      {text.open && text.supported ? (
        <section className="ui-glass-sheet">
          <div className="ui-section-row">
            <h2 className="ui-section-heading">Text Input</h2>
            <button
              className="rounded-full px-4 py-2 text-sm text-on-surface-variant"
              disabled={busy}
              onClick={text.onClose}
            >
              Close
            </button>
          </div>
          <p className="ui-copy">Open this when your TV is focused on a text field.</p>
          <textarea
            className="ui-textarea"
            value={text.value}
            onChange={(event) => {
              text.onChange(event.target.value);
            }}
            placeholder="Type text to send to the TV"
            rows={3}
          />
          <button
            className="ui-primary-button"
            disabled={remoteDisabled || !text.value.trim()}
            onClick={text.onSend}
          >
            Send Text
          </button>
        </section>
      ) : null}

      <section className="ui-media-section">
        <div className="ui-media-grid">
          <div className="ui-media-column">
            <button
              className="ui-media-button ui-media-button-block"
              disabled={remoteDisabled}
              onClick={() => {
                onCommand('volume_up');
              }}
            >
              <Icon name="plus" className="h-5 w-5" />
            </button>
            <div className="ui-media-caption">
              <Icon name="volumeUp" className="h-4 w-4 text-on-surface-variant" />
              <span className="ui-media-caption-label">Vol</span>
            </div>
            <button
              className="ui-media-button ui-media-button-block"
              disabled={remoteDisabled}
              onClick={() => {
                onCommand('volume_down');
              }}
            >
              <Icon name="minus" className="h-5 w-5" />
            </button>
          </div>

          <div className="ui-media-stack">
            <button
              className="ui-media-button ui-media-primary"
              disabled={remoteDisabled}
              onClick={() => {
                onCommand('play_pause');
              }}
            >
              <Icon name="play" className="h-8 w-8" />
            </button>
            <div className="ui-media-subgrid">
              <button
                className={classes(
                  'ui-media-button',
                  assistantListening && 'ui-media-button-assistant-active'
                )}
                disabled={remoteDisabled}
                onClick={onAssistant}
              >
                <Icon name="assistant" className="h-10 w-10" />
              </button>
              <button
                className="ui-media-button ui-media-danger"
                disabled={remoteDisabled}
                onClick={() => {
                  onCommand('power');
                }}
              >
                <Icon name="power" className="h-5 w-5" />
              </button>
            </div>
          </div>
        </div>
      </section>

      <footer className="ui-footer-bar">
        <button className="ui-footer-item" disabled={busy} onClick={onDevices}>
          <Icon name="back" className="h-5 w-5" />
          <span className="ui-footer-label">Devices</span>
        </button>
        <button className="ui-footer-item" disabled={appDisabled} onClick={onDisconnect}>
          <Icon name="disconnect" className="h-5 w-5" />
          <span className="ui-footer-label">Disconnect</span>
        </button>
        <button className="ui-footer-item" disabled={appDisabled || !onForget} onClick={onForget}>
          <Icon name="trash" className="h-5 w-5" />
          <span className="ui-footer-label">Forget</span>
        </button>
      </footer>
    </div>
  );
}
