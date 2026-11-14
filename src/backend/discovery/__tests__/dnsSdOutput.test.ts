import { describe, expect, it } from 'vitest';

import {
  parseDnsSdAddressOutput,
  parseDnsSdBrowseOutput,
  parseDnsSdResolveOutput,
} from '../dnsSdOutput';

// Column layout copied from real macOS `dns-sd -B` output captured on a LAN:
// service types are padded to 20 characters plus ONE space, so 20+ character
// types are followed by a single space before the instance name.
const HEADER = [
  'DATE: ---Wed 11 Nov 2026---',
  ' 0:05:10.470  ...STARTING...',
  'Timestamp     A/R    Flags  if Domain               Service Type         Instance Name',
];

function output(...lines: string[]): string {
  return [...HEADER, ...lines].join('\n') + '\n';
}

describe('parseDnsSdBrowseOutput — real macOS column format', () => {
  it('_androidtvremote2._tcp: names with spaces, & and apostrophes', () => {
    const browse = output(
      ' 0:05:10.480  Add        3  19 local.               _androidtvremote2._tcp. Living Room SHIELD',
      " 0:05:10.480  Add        2  19 local.               _androidtvremote2._tcp. Cheryl & Fred's bedroom tv",
      " 0:05:10.481  Add        2  19 local.               _androidtvremote2._tcp. Kids' Room TV"
    );
    expect(parseDnsSdBrowseOutput(browse, '_androidtvremote2._tcp')).toEqual([
      'Living Room SHIELD',
      "Cheryl & Fred's bedroom tv",
      "Kids' Room TV",
    ]);
  });

  it('_googlecast._tcp: padded short service type', () => {
    const browse = output(
      ' 0:05:14.493  Add        3  19 local.               _googlecast._tcp.    SHIELD-Android-TV-a16f44e7cbcab5d96bad0e409e9b5d50',
      ' 0:05:14.494  Add        2  19 local.               _googlecast._tcp.    Chromecast-HD-0f1e2d3c4b5a69788796a5b4c3d2e1f0'
    );
    expect(parseDnsSdBrowseOutput(browse, '_googlecast._tcp')).toEqual([
      'SHIELD-Android-TV-a16f44e7cbcab5d96bad0e409e9b5d50',
      'Chromecast-HD-0f1e2d3c4b5a69788796a5b4c3d2e1f0',
    ]);
  });

  it('_adb-tls-connect._tcp: 22-character type followed by one space', () => {
    const browse = output(
      ' 0:05:20.101  Add        3  19 local.               _adb-tls-connect._tcp. adb-1A2B3C4D5E6F-aBcDeF'
    );
    expect(parseDnsSdBrowseOutput(browse, '_adb-tls-connect._tcp')).toEqual([
      'adb-1A2B3C4D5E6F-aBcDeF',
    ]);
  });

  it('_adb-tls-pairing._tcp: 22-character type followed by one space', () => {
    const browse = output(
      ' 0:05:20.102  Add        2  19 local.               _adb-tls-pairing._tcp. adb-1A2B3C4D5E6F-GhIjKl'
    );
    expect(parseDnsSdBrowseOutput(browse, '_adb-tls-pairing._tcp.')).toEqual([
      'adb-1A2B3C4D5E6F-GhIjKl',
    ]);
  });

  it('deduplicates multi-interface results and keeps internal spacing', () => {
    const browse = output(
      ' 0:05:10.480  Add        3  19 local.               _androidtvremote2._tcp. Den  TV',
      ' 0:05:10.480  Add        2   4 local.               _androidtvremote2._tcp. Den  TV'
    );
    expect(parseDnsSdBrowseOutput(browse, '_androidtvremote2._tcp')).toEqual(['Den  TV']);
  });

  it('trims CRLF line endings and edge whitespace only', () => {
    const browse =
      ' 0:05:10.480  Add        3  19 local.               _androidtvremote2._tcp. Office SHIELD  \r\n';
    expect(parseDnsSdBrowseOutput(browse, '_androidtvremote2._tcp')).toEqual(['Office SHIELD']);
  });

  it('ignores Rmv records, other service types, headers and non-record lines', () => {
    const browse = output(
      ' 0:05:10.480  Rmv        0  19 local.               _androidtvremote2._tcp. Gone TV',
      ' 0:05:14.493  Add        3  19 local.               _googlecast._tcp.    Some Cast',
      'not a DNS browse record'
    );
    expect(parseDnsSdBrowseOutput(browse, '_androidtvremote2._tcp')).toEqual([]);
  });

  it('accepts hexadecimal flags', () => {
    const browse =
      ' 0:05:10.480  Add 4000000B  19 local.               _androidtvremote2._tcp. Hex Flags TV\n';
    expect(parseDnsSdBrowseOutput(browse, '_androidtvremote2._tcp')).toEqual(['Hex Flags TV']);
  });
});

describe('parseDnsSdResolveOutput', () => {
  it('parses real `dns-sd -L` output: host, port and TXT bt', () => {
    const lookup = [
      'Lookup Office SHIELD._androidtvremote2._tcp.local',
      'DATE: ---Wed 11 Nov 2026---',
      ' 0:14:27.390  ...STARTING...',
      ' 0:14:27.399  Office\\032SHIELD._androidtvremote2._tcp.local. can be reached at Android-2.local.:6466 (interface 19)',
      ' bt=02:00:5E:10:20:30',
      '',
    ].join('\n');
    expect(parseDnsSdResolveOutput(lookup)).toEqual({
      hostName: 'Android-2.local.',
      port: 6466,
      txt: { bt: '02:00:5E:10:20:30' },
    });
  });

  it('ignores "=" in the lookup banner before the endpoint line', () => {
    const lookup = [
      'Lookup a=b._googlecast._tcp.local',
      ' 0:14:27.399  a=b._googlecast._tcp.local. can be reached at cast.local.:8009 (interface 19)',
      ' id=abc fn=Living\\ Room md=Chromecast',
    ].join('\n');
    expect(parseDnsSdResolveOutput(lookup)?.txt).toEqual({
      id: 'abc',
      fn: 'Living Room',
      md: 'Chromecast',
    });
  });

  it('returns null when the service never resolves', () => {
    expect(parseDnsSdResolveOutput('Lookup x._androidtvremote2._tcp.local\n')).toBeNull();
  });
});

describe('parseDnsSdAddressOutput', () => {
  it('returns the IPv4 address from `dns-sd -G v4` output', () => {
    const address = [
      'DATE: ---Wed 11 Nov 2026---',
      ' 0:15:01.120  ...STARTING...',
      'Timestamp     A/R  Flags         IF  Hostname                               Address                                      TTL',
      ' 0:15:01.150  Add  40000002      19  Android-2.local.                       192.168.1.20                                 120',
    ].join('\n');
    expect(parseDnsSdAddressOutput(address)).toBe('192.168.1.20');
  });

  it('returns undefined without an address record', () => {
    expect(parseDnsSdAddressOutput('No address\n')).toBeUndefined();
  });
});
