import { parseDnsSdTxtLine } from './dnsSdEncoding';

/**
 * Parsers for the macOS `dns-sd` CLI's human-readable output.
 *
 * `dns-sd -B` (Apple mDNSResponder Clients/dns-sd.c, browse_reply) prints each
 * result as `<timestamp>  <Add|Rmv> %8X %3d %-20s %-20s %s`: flags (hex),
 * interface index, domain, service type, then the raw UTF-8 instance name.
 * Columns are padded to 20 characters plus ONE space, so a service type of
 * 20+ characters (e.g. `_androidtvremote2._tcp.`) is followed by a single
 * space. Splitting on runs of whitespace therefore cannot find the name; the
 * whole remainder of the line after the service-type token is the name.
 */
const BROWSE_ADD_LINE =
  /^\s*\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\s+Add\s+[0-9A-Fa-f]+\s+\d+\s+(\S+)\s+(\S+)\s(.*)$/;

function normalizeServiceType(serviceType: string): string {
  return serviceType.trim().replace(/\.$/, '').toLowerCase();
}

/**
 * Returns the distinct instance names from `dns-sd -B <serviceType> local.`
 * output, in first-seen order. Only `Add` records for `serviceType` count.
 */
export function parseDnsSdBrowseOutput(output: string, serviceType: string): string[] {
  const expectedType = normalizeServiceType(serviceType);
  const instances = new Set<string>();

  for (const line of output.split(/\r?\n/)) {
    const match = BROWSE_ADD_LINE.exec(line);
    if (!match) {
      continue;
    }
    const [, , type, rest] = match;
    if (type === undefined || rest === undefined) {
      continue;
    }
    if (normalizeServiceType(type) !== expectedType) {
      continue;
    }
    const instanceName = rest.trim();
    if (instanceName && instanceName !== '...STARTING...') {
      instances.add(instanceName);
    }
  }

  return [...instances];
}

export interface DnsSdResolveResult {
  hostName: string;
  port: number;
  txt: Record<string, string>;
}

const RESOLVE_LINE = /can be reached at\s+(\S+?):(\d+)\b/;

/**
 * Parses `dns-sd -L <name> <type> local.` output: the target host name and
 * port from the `can be reached at` line, plus the TXT record printed on the
 * following line(s). Returns null when the service did not resolve.
 */
export function parseDnsSdResolveOutput(output: string): DnsSdResolveResult | null {
  let endpoint: { hostName: string; port: number } | undefined;
  let txt: Record<string, string> = {};

  for (const line of output.split(/\r?\n/)) {
    const match = RESOLVE_LINE.exec(line);
    if (match) {
      const [, hostName, port] = match;
      if (hostName && port) {
        endpoint = { hostName, port: Number(port) };
      }
      continue;
    }

    // TXT entries follow the endpoint line; earlier lines (e.g. the
    // `Lookup <name>...` banner) may contain '=' from the instance name.
    if (endpoint && line.includes('=')) {
      txt = { ...txt, ...parseDnsSdTxtLine(line) };
    }
  }

  return endpoint ? { ...endpoint, txt } : null;
}

const ADDRESS_LINE = /\s((?:\d{1,3}\.){3}\d{1,3})\s+\d+\s*$/;

/** Returns the first IPv4 address from `dns-sd -G v4 <host>` output. */
export function parseDnsSdAddressOutput(output: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const address = ADDRESS_LINE.exec(line)?.[1];
    if (address) {
      return address;
    }
  }
  return undefined;
}
