import type { DiscoveredAudioOutput } from '../../../shared/types';

import { SONOS_PORT, readSoapField, unescapeXml } from './soap';

export interface SonosRoom extends DiscoveredAudioOutput {
  port: number;
  /** UUID of the room's current group coordinator (itself when ungrouped). */
  coordinatorId: string;
}

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:]+)="([^"]*)"/g)) {
    const [, name = '', value = ''] = match;
    result[name] = unescapeXml(value);
  }
  return result;
}

/** Empty attribute values count as missing. */
function present(value: string | undefined): string | undefined {
  return value === '' ? undefined : value;
}

function hostAndPort(location: string | undefined): { host: string; port: number } | undefined {
  if (!location) return undefined;
  try {
    const url = new URL(location);
    return { host: url.hostname, port: Number(url.port) || SONOS_PORT };
  } catch {
    return undefined;
  }
}

/**
 * Turns a ZoneGroupTopology `GetZoneGroupState` response into controllable
 * rooms. A room is a visible `ZoneGroupMember`: home-theater satellites and
 * subs (`<Satellite>`) and the hidden half of a stereo pair (`Invisible="1"`)
 * are not rooms of their own, and their volume follows the room's main player.
 */
export function parseZoneGroupState(responseXml: string): SonosRoom[] {
  const state = readSoapField(responseXml, 'ZoneGroupState') ?? responseXml;
  const rooms = new Map<string, SonosRoom>();
  for (const group of state.matchAll(/<ZoneGroup\s([^>]*)>([\s\S]*?)<\/ZoneGroup>/g)) {
    const [, groupAttributes = '', groupBody = ''] = group;
    const coordinatorId = attributes(groupAttributes).Coordinator;
    for (const member of groupBody.matchAll(/<ZoneGroupMember\s([^>]*?)\/?>/g)) {
      const attrs = attributes(member[1] ?? '');
      const id = attrs.UUID;
      const address = hostAndPort(attrs.Location);
      if (!id || !address || attrs.Invisible === '1' || rooms.has(id)) continue;
      rooms.set(id, {
        kind: 'sonos',
        id,
        name: present(attrs.ZoneName) ?? id,
        host: address.host,
        port: address.port,
        coordinatorId: present(coordinatorId) ?? id,
      });
    }
  }
  return [...rooms.values()].sort((left, right) => left.name.localeCompare(right.name));
}
