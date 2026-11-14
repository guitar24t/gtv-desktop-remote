import { useEffect, useRef, useState } from 'react';

import type { AppPreferences, PreferenceChange } from '../shared/preferences';

import { getDesktopApi } from './api';
import { shortcutLabel } from './lib/shortcut';
import { ShortcutRecorder } from './ShortcutRecorder';
import { REMOTE_SKINS, type RemoteSkinId } from './skins';

export function Preferences({
  skinId,
  onSkinChange,
  onClose,
  onResetAppState,
}: {
  skinId: RemoteSkinId;
  /** Applies immediately; the choice is remembered across launches. */
  onSkinChange: (skin: RemoteSkinId) => void;
  onClose: () => void;
  /** Confirms with the user, then resets; rejects with a displayable error. */
  onResetAppState: () => Promise<void>;
}) {
  const [preferences, setPreferences] = useState<AppPreferences | null>(null);
  const [shortcut, setShortcut] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [recording, setRecording] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
    let mounted = true;
    void getDesktopApi()
      .getPreferences()
      .then((value) => {
        if (!mounted) return;
        setPreferences(value);
        setShortcut(value.shortcut);
      })
      .catch((reason: unknown) => {
        if (mounted)
          setError(reason instanceof Error ? reason.message : 'Settings could not be loaded.');
      });
    return () => {
      mounted = false;
    };
  }, []);

  async function resetAppState() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await onResetAppState();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The app could not be reset.');
    } finally {
      setBusy(false);
    }
  }

  async function change(value: PreferenceChange) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const result = await getDesktopApi().changePreference(value);
      setPreferences(result.preferences);
      setError(result.error);
      if (!result.error) {
        setShortcut(result.preferences.shortcut);
        setSaved(true);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Settings could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-labelledby="settings-heading"
      className="ui-settings ui-dragless"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy && !recording) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <header className="ui-header ui-settings-header">
        <h2 ref={headingRef} tabIndex={-1} id="settings-heading" className="ui-settings-heading">
          Settings
        </h2>
        <button
          type="button"
          className="ui-settings-button ui-dragless"
          onClick={onClose}
          disabled={busy || recording}
        >
          Done
        </button>
      </header>
      <div className="ui-settings-content">
        <section className="ui-settings-group" aria-labelledby="skin-heading">
          <h3 id="skin-heading" className="ui-settings-label">
            Remote style
          </h3>
          <div className="ui-skin-options" role="radiogroup" aria-labelledby="skin-heading">
            {REMOTE_SKINS.map((skin) => (
              <label
                key={skin.id}
                className={`ui-skin-option${skin.id === skinId ? ' ui-skin-option-selected' : ''}`}
              >
                <input
                  type="radio"
                  name="remote-skin"
                  value={skin.id}
                  checked={skin.id === skinId}
                  disabled={recording}
                  aria-describedby={`skin-${skin.id}-description`}
                  onChange={() => {
                    onSkinChange(skin.id);
                  }}
                />
                <span className={`ui-skin-swatch ui-skin-swatch-${skin.id}`} aria-hidden />
                <span className="ui-skin-copy">
                  <span className="ui-skin-name">{skin.name}</span>
                  <span id={`skin-${skin.id}-description`} className="ui-skin-description">
                    {skin.description}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </section>
        {preferences ? (
          <>
            <section className="ui-settings-group" aria-labelledby="login-heading">
              <label id="login-heading" className="ui-settings-toggle">
                <input
                  type="checkbox"
                  checked={preferences.launchAtLogin === true}
                  ref={(node) => {
                    if (node) node.indeterminate = preferences.launchAtLogin === null;
                  }}
                  aria-describedby={
                    preferences.launchAtLoginError
                      ? 'login-description login-state-error'
                      : 'login-description'
                  }
                  disabled={
                    busy ||
                    recording ||
                    !preferences.launchAtLoginSupported ||
                    preferences.launchAtLogin === null
                  }
                  onChange={(event) => {
                    void change({ launchAtLogin: event.target.checked });
                  }}
                />
                Launch at login
              </label>
              <p id="login-description" className="ui-settings-copy">
                {!preferences.launchAtLoginSupported
                  ? 'Available in the installed macOS app. Development Electron is never added to Login Items.'
                  : 'Off by default. macOS Login Items settings take precedence.'}
              </p>
              {preferences.launchAtLoginError ? (
                <p
                  id="login-state-error"
                  role="alert"
                  className="ui-settings-message ui-settings-error"
                >
                  {preferences.launchAtLoginError}
                </p>
              ) : null}
            </section>
            <form
              className="ui-settings-group"
              onSubmit={(event) => {
                event.preventDefault();
                void change({ shortcut });
              }}
            >
              <label htmlFor="global-shortcut" className="ui-settings-label">
                Show / hide shortcut
              </label>
              <ShortcutRecorder
                shortcut={shortcut}
                disabled={busy}
                onChange={(value) => {
                  setShortcut(value);
                  setSaved(false);
                }}
                onPreferences={setPreferences}
                onError={setError}
                onRecording={setRecording}
              />
              <p id="shortcut-description" className="ui-settings-copy">
                Press modifiers plus a letter, digit, or F1–F24. Escape cancels recording; Tab or
                leaving the control also cancels. The app shortcut is paused only while recording.
              </p>
              <p id="shortcut-active" className="ui-settings-copy">
                Active:{' '}
                <span className="ui-settings-value">
                  {recording
                    ? 'Paused while recording'
                    : preferences.activeShortcut
                      ? shortcutLabel(preferences.activeShortcut)
                      : 'Unavailable — use the menu bar'}
                </span>
              </p>
              <button
                type="submit"
                className="ui-settings-button ui-settings-save"
                disabled={busy || recording}
              >
                Save shortcut
              </button>
              {preferences.shortcutError ? (
                <p role="alert" className="ui-settings-message ui-settings-error">
                  {preferences.shortcutError}
                </p>
              ) : null}
            </form>
            <section className="ui-settings-group" aria-labelledby="reset-heading">
              <h3 id="reset-heading" className="ui-settings-label">
                Reset app state
              </h3>
              <p id="reset-description" className="ui-settings-copy">
                Removes every saved device and pairing certificate from this Mac. You will need to
                pair your TVs again.
              </p>
              <button
                type="button"
                className="ui-settings-button ui-settings-danger"
                aria-describedby="reset-description"
                disabled={busy || recording}
                onClick={() => {
                  void resetAppState();
                }}
              >
                Reset App State
              </button>
            </section>
          </>
        ) : (
          <p className="ui-settings-copy">
            {error ? 'Settings are unavailable.' : 'Loading settings…'}
          </p>
        )}
        {error ? (
          <p role="alert" className="ui-settings-message ui-settings-error">
            {error}
          </p>
        ) : null}
        {saved ? (
          <p role="status" className="ui-settings-message ui-settings-success">
            Settings saved.
          </p>
        ) : null}
      </div>
    </section>
  );
}
