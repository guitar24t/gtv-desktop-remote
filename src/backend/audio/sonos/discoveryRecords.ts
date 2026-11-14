import { SONOS_PORT } from './soap';

/** A Sonos player address learned from SSDP or mDNS, before reading the topology. */
export interface SonosCandidate {
  host: string;
  port: number;
  id?: string;
  household?: string;
  source: 'ssdp' | 'mdns';
}

export const SSDP_ADDRESS = '239.255.255.250';
export const SSDP_PORT = 1900;
export const SONOS_SEARCH_TARGET = 'urn:schemas-upnp-org:device:ZonePlayer:1';

export function buildSsdpSearch(searchTarget = SONOS_SEARCH_TARGET, maxWaitSeconds = 1): string {
  return [
    'M-SEARCH * HTTP/1.1',
    `HOST: ${SSDP_ADDRESS}:${String(SSDP_PORT)}`,
    'MAN: "ssdp:discover"',
    `MX: ${String(maxWaitSeconds)}`,
    `ST: ${searchTarget}`,
    '',
    '',
  ].join('\r\n');
}

function locationAddress(location: string | undefined): { host: string; port: number } | undefined {
  if (!location) return undefined;
  try {
    const url = new URL(location.trim());
    if (url.protocol !== 'http:') return undefined;
    return { host: url.hostname, port: Number(url.port) || SONOS_PORT };
  } catch {
    return undefined;
  }
}

/** Parses an SSDP search reply; returns undefined for anything that is not a Sonos player. */
export function parseSsdpResponse(message: string): SonosCandidate | undefined {
  const [statusLine, ...lines] = message.split(/\r?\n/);
  if (!/^HTTP\/1\.[01]\s+200\b/i.test(statusLine ?? '')) return undefined;
  const headers = new Map<string, string>();
  for (const line of lines) {
    const separator = line.indexOf(':');
    if (separator > 0) {
      headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
    }
  }
  const usn = headers.get('usn') ?? '';
  const isSonos =
    /RINCON_/i.test(usn) ||
    headers.get('st') === SONOS_SEARCH_TARGET ||
    headers.has('x-rincon-household');
  const address = locationAddress(headers.get('location'));
  if (!isSonos || !address) return undefined;
  return {
    ...address,
    id: /uuid:(RINCON_[0-9A-Z]+)/i.exec(usn)?.[1],
    household: headers.get('x-rincon-household'),
    source: 'ssdp',
  };
}

/**
 * Parses a `_sonos._tcp` mDNS record: the instance name is `RINCON_…@Room`
 * and the TXT `location` points at the player's port-1400 description.
 */
export function parseSonosMdns(
  instanceName: string,
  txt: Record<string, string>,
  resolvedHost?: string
): SonosCandidate | undefined {
  const address =
    locationAddress(txt.location) ??
    (resolvedHost ? { host: resolvedHost, port: SONOS_PORT } : undefined);
  if (!address) return undefined;
  return {
    ...address,
    id: /^(RINCON_[0-9A-Z]+)@/i.exec(instanceName)?.[1],
    household: txt.hhid,
    source: 'mdns',
  };
}
