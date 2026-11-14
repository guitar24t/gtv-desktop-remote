import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SonosRoom } from '../../../../src/backend/audio/sonos/topology';
import { AudioOutputRouter, isAudioCommand } from '../../../../src/main/audio/audioOutputRouter';
import { SonosRequestError, type SonosClient } from '../../../../src/main/audio/sonosClient';
import type { AudioOutputLink, AudioVolumeEvent } from '../../../../src/shared/types';

const LINK: AudioOutputLink = {
  enabled: true,
  kind: 'sonos',
  id: 'RINCON_000000000A0101400',
  name: 'Living Room',
  host: '10.0.0.10',
  volumeStep: 2,
};

const room = (host: string): SonosRoom => ({
  kind: 'sonos',
  id: LINK.id,
  name: 'Living Room',
  host,
  port: 1400,
  coordinatorId: LINK.id,
});

function fakeClient() {
  return {
    getRooms: vi.fn<SonosClient['getRooms']>(),
    readPlayerUuid: vi.fn<SonosClient['readPlayerUuid']>(() => Promise.resolve(LINK.id)),
    setRelativeVolume: vi.fn<SonosClient['setRelativeVolume']>((_address, delta) =>
      Promise.resolve(20 + delta)
    ),
    getVolume: vi.fn<SonosClient['getVolume']>(() => Promise.resolve(20)),
    getMute: vi.fn<SonosClient['getMute']>(() => Promise.resolve(false)),
    setMute: vi.fn<SonosClient['setMute']>(() => Promise.resolve()),
  };
}

describe('AudioOutputRouter', () => {
  let client: ReturnType<typeof fakeClient>;
  let discoverRooms: ReturnType<typeof vi.fn<() => Promise<SonosRoom[]>>>;
  let onHostChanged: ReturnType<typeof vi.fn<(deviceId: string, host: string) => void>>;
  let events: AudioVolumeEvent[];
  let router: AudioOutputRouter;

  function build() {
    router = new AudioOutputRouter({
      client,
      discoverRooms,
      onHostChanged,
      emitVolume: (event) => events.push(event),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
  }

  beforeEach(() => {
    client = fakeClient();
    discoverRooms = vi.fn(() => Promise.resolve([room('10.0.0.10')]));
    onHostChanged = vi.fn();
    events = [];
    build();
  });

  it('only treats volume and mute as speaker commands', () => {
    expect(['volume_up', 'volume_down', 'mute'].every((c) => isAudioCommand(c as never))).toBe(
      true
    );
    expect(isAudioCommand('power')).toBe(false);
    expect(isAudioCommand('select')).toBe(false);
  });

  it('verifies the saved address once, then steps the room volume by the link step', async () => {
    await router.handle('tv-1', LINK, 'volume_up');
    await router.handle('tv-1', LINK, 'volume_down');
    expect(client.readPlayerUuid).toHaveBeenCalledOnce();
    expect(discoverRooms).not.toHaveBeenCalled();
    expect(
      client.setRelativeVolume.mock.calls.map(([address, delta]) => [address.host, delta])
    ).toEqual([
      ['10.0.0.10', 2],
      ['10.0.0.10', -2],
    ]);
    expect(events).toEqual([
      { deviceId: 'tv-1', outputName: 'Living Room', volume: 22 },
      { deviceId: 'tv-1', outputName: 'Living Room', volume: 18 },
    ]);
  });

  it('clamps the step to 1–10', async () => {
    await router.handle('tv-1', { ...LINK, volumeStep: 50 }, 'volume_up');
    expect(client.setRelativeVolume).toHaveBeenLastCalledWith(expect.anything(), 10);
  });

  it('toggles mute and reports the new state', async () => {
    client.getMute.mockResolvedValueOnce(false);
    await router.handle('tv-1', LINK, 'mute');
    expect(client.setMute).toHaveBeenCalledWith(
      expect.objectContaining({ host: '10.0.0.10' }),
      true
    );
    expect(events.at(-1)).toEqual({
      deviceId: 'tv-1',
      outputName: 'Living Room',
      muted: true,
      volume: 20,
    });
  });

  it('finds the room again when a different player now holds the saved address', async () => {
    client.readPlayerUuid.mockResolvedValueOnce('RINCON_SOMEONE_ELSE');
    discoverRooms.mockResolvedValueOnce([room('10.0.0.42')]);
    await router.handle('tv-1', LINK, 'volume_up');
    expect(onHostChanged).toHaveBeenCalledWith('tv-1', '10.0.0.42');
    expect(client.setRelativeVolume).toHaveBeenCalledWith({ host: '10.0.0.42', port: 1400 }, 2);
  });

  it('re-discovers and retries once when the speaker stops answering', async () => {
    await router.handle('tv-1', LINK, 'volume_up');
    client.setRelativeVolume
      .mockRejectedValueOnce(new SonosRequestError('did not respond', true))
      .mockResolvedValueOnce(24);
    discoverRooms.mockResolvedValueOnce([room('10.0.0.42')]);

    await router.handle('tv-1', LINK, 'volume_up');

    expect(discoverRooms).toHaveBeenCalledOnce();
    expect(client.setRelativeVolume).toHaveBeenLastCalledWith({ host: '10.0.0.42', port: 1400 }, 2);
    expect(onHostChanged).toHaveBeenCalledWith('tv-1', '10.0.0.42');
    expect(events.at(-1)).toMatchObject({ volume: 24 });
  });

  it('names the speaker when it cannot be found or refuses', async () => {
    client.readPlayerUuid.mockResolvedValue(undefined);
    discoverRooms.mockResolvedValue([]);
    await expect(router.handle('tv-1', LINK, 'volume_up')).rejects.toThrow(
      'Could not find the Sonos room “Living Room”'
    );

    build();
    client.readPlayerUuid.mockResolvedValue(LINK.id);
    client.setRelativeVolume.mockRejectedValue(
      new SonosRequestError('refused (UPnP error 402)', false)
    );
    await expect(router.handle('tv-1', LINK, 'volume_up')).rejects.toThrow(
      'Sonos “Living Room”: refused (UPnP error 402)'
    );
    expect(discoverRooms).toHaveBeenCalledOnce(); // only for the first case
  });
});
