import { SONOS_PORT } from '../../backend/audio/sonos/soap';
import type { SonosRoom } from '../../backend/audio/sonos/topology';
import {
  createRelativeVolumeCoalescer,
  VolumeTimeoutError,
  type RelativeVolumeCoalescer,
} from '../../backend/audio/volumeCoalescer';
import type { ILogger } from '../../backend/core/logger';
import type { AudioOutputLink, AudioVolumeEvent, RemoteCommand } from '../../shared/types';

import { SonosRequestError, type SonosAddress, type SonosClient } from './sonosClient';

export type AudioCommand = Extract<RemoteCommand, 'volume_up' | 'volume_down' | 'mute'>;

export function isAudioCommand(command: RemoteCommand): command is AudioCommand {
  return command === 'volume_up' || command === 'volume_down' || command === 'mute';
}

export interface AudioOutputRouterDeps {
  client: SonosClient;
  discoverRooms: () => Promise<SonosRoom[]>;
  /** Persist a linked speaker's new address (it moved to a new DHCP lease). */
  onHostChanged: (deviceId: string, host: string) => Promise<void> | void;
  emitVolume: (event: AudioVolumeEvent) => void;
  logger: ILogger;
}

function unreachable(error: unknown): boolean {
  return (
    (error instanceof SonosRequestError && error.unreachable) || error instanceof VolumeTimeoutError
  );
}

/**
 * Sends a TV's volume and mute keys to its linked Sonos room instead of the
 * TV. The room is addressed through its own player (RenderingControl), so a
 * home-theater set's satellites follow it and grouped music rooms are left
 * alone. A cached address is used only after the player there proves to be
 * the linked room; if it stops answering, the room is found again once.
 */
export class AudioOutputRouter {
  /** Linked room id → address verified this session. */
  private readonly verified = new Map<string, SonosAddress>();

  private readonly coalescers = new Map<
    string,
    { address: SonosAddress; coalescer: RelativeVolumeCoalescer }
  >();

  constructor(private readonly deps: AudioOutputRouterDeps) {}

  async handle(deviceId: string, link: AudioOutputLink, command: AudioCommand): Promise<void> {
    try {
      await this.run(deviceId, link, command, false);
    } catch (error) {
      if (!unreachable(error)) throw this.describe(link, error);
      this.deps.logger.info('audioOutput', 'Linked speaker did not answer; finding it again', {
        id: link.id,
        host: link.host,
      });
      this.forget(link.id);
      try {
        await this.run(deviceId, link, command, true);
      } catch (retryError) {
        throw this.describe(link, retryError);
      }
    }
  }

  /** Drop cached addresses (e.g. after the link changes or the network changes). */
  forget(id?: string): void {
    if (id === undefined) {
      this.verified.clear();
      this.coalescers.clear();
      return;
    }
    this.verified.delete(id);
    this.coalescers.delete(id);
  }

  private async run(
    deviceId: string,
    link: AudioOutputLink,
    command: AudioCommand,
    rediscover: boolean
  ): Promise<void> {
    const address = await this.resolve(deviceId, link, rediscover);
    if (command === 'mute') {
      const muted = !(await this.deps.client.getMute(address));
      await this.deps.client.setMute(address, muted);
      const volume = await this.deps.client.getVolume(address).catch(() => undefined);
      this.deps.emitVolume({ deviceId, outputName: link.name, muted, volume });
      return;
    }
    const step = Math.min(10, Math.max(1, Math.round(link.volumeStep)));
    const volume = await this.coalescerFor(link.id, address).adjust(
      command === 'volume_up' ? step : -step
    );
    this.deps.emitVolume({ deviceId, outputName: link.name, volume });
  }

  private coalescerFor(id: string, address: SonosAddress): RelativeVolumeCoalescer {
    const existing = this.coalescers.get(id);
    if (existing?.address.host === address.host) return existing.coalescer;
    const coalescer = createRelativeVolumeCoalescer((delta) =>
      this.deps.client.setRelativeVolume(address, delta)
    );
    this.coalescers.set(id, { address, coalescer });
    return coalescer;
  }

  private async resolve(
    deviceId: string,
    link: AudioOutputLink,
    rediscover: boolean
  ): Promise<SonosAddress> {
    const cached = this.verified.get(link.id);
    if (cached && !rediscover) return cached;

    if (!rediscover && link.host) {
      const candidate = { host: link.host, port: SONOS_PORT };
      const uuid = await this.deps.client.readPlayerUuid(candidate).catch(() => undefined);
      if (uuid === link.id) {
        this.verified.set(link.id, candidate);
        return candidate;
      }
    }

    const room = (await this.deps.discoverRooms()).find((item) => item.id === link.id);
    if (!room) {
      throw new Error(
        `Could not find the Sonos room “${link.name}”. Check that it is on and reachable from this Mac.`
      );
    }
    const address = { host: room.host, port: room.port };
    this.verified.set(link.id, address);
    if (room.host !== link.host) {
      try {
        await this.deps.onHostChanged(deviceId, room.host);
      } catch (error) {
        this.deps.logger.warn('audioOutput', 'Could not save the speaker’s new address', {
          error: String(error),
        });
      }
    }
    return address;
  }

  private describe(link: AudioOutputLink, error: unknown): Error {
    if (error instanceof SonosRequestError || error instanceof VolumeTimeoutError) {
      return new Error(`Sonos “${link.name}”: ${error.message}`, { cause: error });
    }
    return error instanceof Error ? error : new Error(String(error));
  }
}
