import { useCallback, useEffect, useRef, useState } from 'react';

import type { AudioOutputLink, DiscoveredAudioOutput, SavedDevice } from '../shared/types';

import { getDesktopApi } from './api';

const VOLUME_STEPS = [1, 2, 3, 5] as const;
export const DEFAULT_VOLUME_STEP = 2;
const TV_OPTION = 'tv';

type Search =
  | { state: 'idle' | 'searching' }
  | { state: 'done'; speakers: DiscoveredAudioOutput[] }
  | { state: 'error'; message: string };

/**
 * Per-TV speaker links: which speaker (if any) takes a TV's volume and mute
 * keys, whether the link is currently on, and how far each press moves it.
 */
export function TvAudioSettings({
  devices,
  disabled,
  onSetAudioOutput,
}: {
  /** Paired TVs. */
  devices: SavedDevice[];
  disabled: boolean;
  onSetAudioOutput: (deviceId: string, link: AudioOutputLink | null) => Promise<void>;
}) {
  // With TVs to configure, Settings opens already searching.
  const [search, setSearch] = useState<Search>(() =>
    devices.length > 0 ? { state: 'searching' } : { state: 'idle' }
  );
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  // Results always arrive asynchronously, even if the bridge call throws.
  const runSearch = useCallback(
    () =>
      Promise.resolve()
        .then(() => getDesktopApi().discoverAudioOutputs())
        .then(
          (speakers) => {
            if (mounted.current) setSearch({ state: 'done', speakers });
          },
          (reason: unknown) => {
            if (mounted.current) {
              setSearch({
                state: 'error',
                message: reason instanceof Error ? reason.message : 'Speakers could not be found.',
              });
            }
          }
        ),
    []
  );

  function findSpeakers() {
    setSearch({ state: 'searching' });
    void runSearch();
  }

  useEffect(() => {
    mounted.current = true;
    if (devices.length > 0) void runSearch();
    return () => {
      mounted.current = false;
    };
    // Search once when Settings opens; "Search again" repeats it on request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save(deviceId: string, link: AudioOutputLink | null) {
    setSavingId(deviceId);
    setError(null);
    try {
      await onSetAudioOutput(deviceId, link);
    } catch (reason) {
      if (mounted.current) {
        setError(reason instanceof Error ? reason.message : 'The speaker link could not be saved.');
      }
    } finally {
      if (mounted.current) setSavingId(null);
    }
  }

  const speakers = search.state === 'done' ? search.speakers : [];

  return (
    <section className="ui-settings-group" aria-labelledby="tv-audio-heading">
      <h3 id="tv-audio-heading" className="ui-settings-label">
        TV audio
      </h3>
      <p className="ui-settings-copy">
        If a TV&apos;s sound goes to a speaker its remote controls by infrared, link that speaker
        here so the volume and mute keys adjust it instead of the TV. Each TV has its own setting.
      </p>

      {devices.length === 0 ? (
        <p className="ui-settings-copy">Pair a TV to set up its audio.</p>
      ) : (
        <>
          <div className="ui-audio-search" role="status">
            <span className="ui-settings-copy">
              {search.state === 'searching'
                ? 'Searching for Sonos speakers…'
                : search.state === 'error'
                  ? search.message
                  : search.state === 'done'
                    ? speakers.length === 0
                      ? 'No Sonos speakers found on this network.'
                      : `${String(speakers.length)} Sonos ${speakers.length === 1 ? 'room' : 'rooms'} found.`
                    : ''}
            </span>
            <button
              type="button"
              className="ui-settings-button"
              disabled={disabled || search.state === 'searching'}
              onClick={findSpeakers}
            >
              Search again
            </button>
          </div>

          <ul className="ui-audio-list">
            {devices.map((tv) => {
              const link = tv.audioOutput;
              const linkedSpeakerMissing =
                link !== undefined &&
                search.state === 'done' &&
                !speakers.some((speaker) => speaker.id === link.id);
              const busy = disabled || savingId === tv.id;
              const selectId = `tv-audio-${tv.id}`;
              return (
                <li key={tv.id} className="ui-audio-row">
                  <label htmlFor={selectId} className="ui-audio-tv">
                    {tv.name}
                  </label>
                  <select
                    id={selectId}
                    className="ui-settings-input ui-audio-select"
                    aria-label={`Volume keys for ${tv.name}`}
                    value={link?.id ?? TV_OPTION}
                    disabled={busy}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (value === TV_OPTION) {
                        void save(tv.id, null);
                        return;
                      }
                      const speaker = speakers.find((item) => item.id === value);
                      if (!speaker) return;
                      void save(tv.id, {
                        enabled: true,
                        kind: speaker.kind,
                        id: speaker.id,
                        name: speaker.name,
                        host: speaker.host,
                        volumeStep: link?.volumeStep ?? DEFAULT_VOLUME_STEP,
                      });
                    }}
                  >
                    <option value={TV_OPTION}>TV (default)</option>
                    {link && (linkedSpeakerMissing || search.state !== 'done') ? (
                      <option value={link.id}>
                        {link.name}
                        {linkedSpeakerMissing ? ' (not found right now)' : ' (Sonos)'}
                      </option>
                    ) : null}
                    {speakers.map((speaker) => (
                      <option key={speaker.id} value={speaker.id}>
                        {speaker.name} (Sonos)
                      </option>
                    ))}
                  </select>
                  {link ? (
                    <div className="ui-audio-options">
                      <label className="ui-settings-toggle">
                        <input
                          type="checkbox"
                          checked={link.enabled}
                          disabled={busy}
                          onChange={(event) => {
                            void save(tv.id, { ...link, enabled: event.target.checked });
                          }}
                        />
                        Use {link.name} for volume
                      </label>
                      <label className="ui-audio-step">
                        Step
                        <select
                          className="ui-settings-input"
                          aria-label={`Volume step for ${tv.name}`}
                          value={link.volumeStep}
                          disabled={busy}
                          onChange={(event) => {
                            void save(tv.id, { ...link, volumeStep: Number(event.target.value) });
                          }}
                        >
                          {VOLUME_STEPS.map((step) => (
                            <option key={step} value={step}>
                              {step}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      )}
      {error ? (
        <p role="alert" className="ui-settings-message ui-settings-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}
