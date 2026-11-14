import {
  parseSonosMdns,
  parseSsdpResponse,
  type SonosCandidate,
} from '../../backend/audio/sonos/discoveryRecords';
import type { SonosRoom } from '../../backend/audio/sonos/topology';

import type { SonosAddress } from './sonosClient';

export interface SonosDiscoveryDeps {
  /** `_sonos._tcp` via the system mDNS responder (all interfaces, relayed across VLANs). */
  browseMdns: () => Promise<SonosCandidate[]>;
  /** SSDP M-SEARCH on every interface; usually blocked between subnets. */
  searchSsdp: () => Promise<SonosCandidate[]>;
  getRooms: (address: SonosAddress) => Promise<SonosRoom[]>;
}

/** Topology is household-wide, so a few players are enough to list every room. */
const MAX_TOPOLOGY_ATTEMPTS = 4;

function settle<T>(promise: Promise<T[]>): Promise<T[]> {
  return promise.catch(() => []);
}

/**
 * Finds Sonos rooms. mDNS and SSDP run together; as soon as mDNS yields a
 * player the search moves on rather than waiting out SSDP, which routed
 * networks rarely forward. Each household's topology is read once from any of
 * its players, and the union of rooms is returned.
 */
export async function discoverSonosRooms(deps: SonosDiscoveryDeps): Promise<SonosRoom[]> {
  const mdns = settle(deps.browseMdns());
  const ssdp = settle(deps.searchSsdp());
  let candidates = await mdns;
  if (candidates.length === 0) candidates = await ssdp;
  else void ssdp;

  const unique = new Map<string, SonosCandidate>();
  for (const candidate of candidates) {
    if (!unique.has(candidate.host)) unique.set(candidate.host, candidate);
  }
  if (unique.size === 0) return [];

  const rooms = new Map<string, SonosRoom>();
  const householdsRead = new Set<string>();
  let attempts = 0;
  let lastError: unknown;
  for (const candidate of unique.values()) {
    if (attempts >= MAX_TOPOLOGY_ATTEMPTS) break;
    if (candidate.household && householdsRead.has(candidate.household)) continue;
    // Without a household id, one successful read is assumed to cover everything.
    if (!candidate.household && rooms.size > 0) continue;
    attempts += 1;
    try {
      for (const room of await deps.getRooms(candidate)) rooms.set(room.id, room);
      if (candidate.household) householdsRead.add(candidate.household);
    } catch (error) {
      lastError = error;
    }
  }

  if (rooms.size === 0 && lastError !== undefined) {
    throw new Error(
      'Found Sonos speakers but could not read their room layout. Check that this Mac can reach them on port 1400.'
    );
  }
  return [...rooms.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function candidatesFromSsdp(replies: string[]): SonosCandidate[] {
  return replies.map(parseSsdpResponse).filter((reply) => reply !== undefined);
}

export async function candidatesFromMdns(
  instances: string[],
  resolve: (instance: string) => Promise<{ txt: Record<string, string> } | null>
): Promise<SonosCandidate[]> {
  const records = await Promise.all(
    // Every speaker (including satellites) advertises; a handful of records is plenty.
    instances.slice(0, 16).map(async (instance) => {
      const record = await resolve(instance).catch(() => null);
      return record ? parseSonosMdns(instance, record.txt) : undefined;
    })
  );
  return records.filter((record) => record !== undefined);
}
