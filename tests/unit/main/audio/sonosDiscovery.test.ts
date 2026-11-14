import dgram from 'node:dgram';

import { describe, expect, it, vi } from 'vitest';

import type { SonosCandidate } from '../../../../src/backend/audio/sonos/discoveryRecords';
import type { SonosRoom } from '../../../../src/backend/audio/sonos/topology';
import {
  candidatesFromMdns,
  candidatesFromSsdp,
  discoverSonosRooms,
} from '../../../../src/main/audio/sonosDiscovery';
import { ssdpSearch } from '../../../../src/main/audio/ssdpSearch';

const room = (id: string, name: string, host: string): SonosRoom => ({
  kind: 'sonos',
  id,
  name,
  host,
  port: 1400,
  coordinatorId: id,
});

const candidate = (
  host: string,
  household?: string,
  source: 'mdns' | 'ssdp' = 'mdns'
): SonosCandidate => ({
  host,
  port: 1400,
  household,
  source,
});

describe('discoverSonosRooms', () => {
  it('uses mDNS players without waiting for SSDP (routed networks rarely forward SSDP)', async () => {
    const searchSsdp = vi.fn(() => new Promise<SonosCandidate[]>(() => undefined));
    const getRooms = vi.fn(() => Promise.resolve([room('RINCON_A', 'Living Room', '10.0.0.10')]));
    const rooms = await discoverSonosRooms({
      browseMdns: () => Promise.resolve([candidate('10.0.0.10', 'house')]),
      searchSsdp,
      getRooms,
    });
    expect(rooms.map((item) => item.name)).toEqual(['Living Room']);
    expect(searchSsdp).toHaveBeenCalled();
  });

  it('falls back to SSDP when mDNS finds nothing', async () => {
    const getRooms = vi.fn(() => Promise.resolve([room('RINCON_A', 'Den', '10.0.0.10')]));
    const rooms = await discoverSonosRooms({
      browseMdns: () => Promise.reject(new Error('dns-sd missing')),
      searchSsdp: () => Promise.resolve([candidate('10.0.0.10', 'house', 'ssdp')]),
      getRooms,
    });
    expect(rooms.map((item) => item.name)).toEqual(['Den']);
  });

  it('reads each household once and skips a player that does not answer', async () => {
    const getRooms = vi.fn((address: { host: string }) => {
      if (address.host === '10.0.0.1') return Promise.reject(new Error('timeout'));
      if (address.host === '10.0.0.10')
        return Promise.resolve([
          room('RINCON_A', 'Living Room', '10.0.0.10'),
          room('RINCON_B', 'Office', '10.0.0.11'),
        ]);
      return Promise.resolve([room('RINCON_C', 'Cabin', '10.0.1.10')]);
    });
    const rooms = await discoverSonosRooms({
      browseMdns: () =>
        Promise.resolve([
          candidate('10.0.0.1', 'house'),
          candidate('10.0.0.10', 'house'),
          candidate('10.0.0.11', 'house'),
          candidate('10.0.1.10', 'cabin'),
        ]),
      searchSsdp: () => Promise.resolve([]),
      getRooms,
    });
    expect(rooms.map((item) => item.name)).toEqual(['Cabin', 'Living Room', 'Office']);
    // 10.0.0.11 is in a household already read.
    expect(getRooms.mock.calls.map(([address]) => address.host)).toEqual([
      '10.0.0.1',
      '10.0.0.10',
      '10.0.1.10',
    ]);
  });

  it('returns nothing when no player is found, and explains when none can be read', async () => {
    await expect(
      discoverSonosRooms({
        browseMdns: () => Promise.resolve([]),
        searchSsdp: () => Promise.resolve([]),
        getRooms: vi.fn(),
      })
    ).resolves.toEqual([]);
    await expect(
      discoverSonosRooms({
        browseMdns: () => Promise.resolve([candidate('10.0.0.10', 'house')]),
        searchSsdp: () => Promise.resolve([]),
        getRooms: () => Promise.reject(new Error('refused')),
      })
    ).rejects.toThrow(/could not read their room layout/);
  });
});

describe('discovery record helpers', () => {
  it('resolves mDNS instances into candidates, skipping ones that fail to resolve', async () => {
    const candidates = await candidatesFromMdns(
      ['RINCON_A@Living Room', 'RINCON_B@Office'],
      (instance) =>
        instance.startsWith('RINCON_A')
          ? Promise.resolve({
              txt: { location: 'http://10.0.0.10:1400/xml/device_description.xml' },
            })
          : Promise.reject(new Error('gone'))
    );
    expect(candidates).toEqual([
      { host: '10.0.0.10', port: 1400, id: 'RINCON_A', household: undefined, source: 'mdns' },
    ]);
  });

  it('keeps only Sonos SSDP replies', () => {
    expect(
      candidatesFromSsdp([
        'HTTP/1.1 200 OK\r\nLOCATION: http://10.0.0.10:1400/xml/device_description.xml\r\nUSN: uuid:RINCON_A::urn:schemas-upnp-org:device:ZonePlayer:1\r\n\r\n',
        'HTTP/1.1 200 OK\r\nLOCATION: http://10.0.0.1/x.xml\r\nUSN: uuid:router\r\n\r\n',
      ]).map((item) => item.host)
    ).toEqual(['10.0.0.10']);
  });
});

describe('ssdpSearch', () => {
  it('sends an M-SEARCH and collects unicast replies', async () => {
    const responder = dgram.createSocket('udp4');
    const searches: string[] = [];
    responder.on('message', (message, remote) => {
      searches.push(message.toString());
      responder.send(
        'HTTP/1.1 200 OK\r\nLOCATION: http://10.0.0.10:1400/xml/device_description.xml\r\nUSN: uuid:RINCON_A::urn:schemas-upnp-org:device:ZonePlayer:1\r\n\r\n',
        remote.port,
        remote.address
      );
    });
    await new Promise<void>((resolve) => responder.bind(0, '127.0.0.1', resolve));
    const { port } = responder.address();
    try {
      const replies = await ssdpSearch({
        timeoutMs: 400,
        repeatAfterMs: 1000,
        interfaces: [],
        destination: { address: '127.0.0.1', port },
      });
      expect(searches[0]).toMatch(/^M-SEARCH \* HTTP\/1\.1\r\n/);
      expect(candidatesFromSsdp(replies).map((item) => item.id)).toEqual(['RINCON_A']);
    } finally {
      responder.close();
    }
  });

  it('survives an interface that cannot be bound', async () => {
    await expect(
      ssdpSearch({
        timeoutMs: 200,
        interfaces: ['203.0.113.250'],
        destination: { address: '127.0.0.1', port: 9 },
      })
    ).resolves.toEqual([]);
  });
});
