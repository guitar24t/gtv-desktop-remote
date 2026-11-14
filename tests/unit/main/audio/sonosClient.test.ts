import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSonosClient, SonosRequestError } from '../../../../src/main/audio/sonosClient';

interface Recorded {
  method: string;
  url: string;
  soapAction?: string;
  body: string;
}

let server: Server;
let port = 0;
let requests: Recorded[] = [];
let handler: (request: Recorded, response: ServerResponse) => void;

const envelope = (inner: string) => `<s:Envelope><s:Body>${inner}</s:Body></s:Envelope>`;

beforeEach(async () => {
  requests = [];
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on('end', () => {
      const recorded = {
        method: request.method ?? '',
        url: request.url ?? '',
        soapAction: request.headers.soapaction as string | undefined,
        body,
      };
      requests.push(recorded);
      handler(recorded, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

describe('Sonos client', () => {
  it('sends a relative volume change to the room player and returns the new volume', async () => {
    handler = (_request, response) => {
      response.end(
        envelope(
          '<u:SetRelativeVolumeResponse><NewVolume>18</NewVolume></u:SetRelativeVolumeResponse>'
        )
      );
    };
    const client = createSonosClient();
    await expect(client.setRelativeVolume({ host: '127.0.0.1', port }, 2)).resolves.toBe(18);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: 'POST',
      url: '/MediaRenderer/RenderingControl/Control',
      soapAction: '"urn:schemas-upnp-org:service:RenderingControl:1#SetRelativeVolume"',
    });
    expect(requests[0]?.body).toContain(
      '<InstanceID>0</InstanceID><Channel>Master</Channel><Adjustment>2</Adjustment>'
    );
  });

  it('reads and sets mute, and reads volume', async () => {
    handler = (request, response) => {
      if (request.soapAction?.endsWith('#GetMute"')) {
        response.end(
          envelope('<u:GetMuteResponse><CurrentMute>1</CurrentMute></u:GetMuteResponse>')
        );
      } else if (request.soapAction?.endsWith('#GetVolume"')) {
        response.end(
          envelope('<u:GetVolumeResponse><CurrentVolume>30</CurrentVolume></u:GetVolumeResponse>')
        );
      } else {
        response.end(envelope('<u:SetMuteResponse></u:SetMuteResponse>'));
      }
    };
    const client = createSonosClient();
    const address = { host: '127.0.0.1', port };
    await expect(client.getMute(address)).resolves.toBe(true);
    await client.setMute(address, false);
    await expect(client.getVolume(address)).resolves.toBe(30);
    expect(requests[1]?.body).toContain('<DesiredMute>0</DesiredMute>');
  });

  it('reads rooms from the zone group topology', async () => {
    const state =
      '&lt;ZoneGroupState&gt;&lt;ZoneGroups&gt;&lt;ZoneGroup Coordinator="RINCON_000000000A0101400"&gt;&lt;ZoneGroupMember UUID="RINCON_000000000A0101400" Location="http://10.0.0.10:1400/xml/device_description.xml" ZoneName="Den"/&gt;&lt;/ZoneGroup&gt;&lt;/ZoneGroups&gt;&lt;/ZoneGroupState&gt;';
    handler = (_request, response) => {
      response.end(
        envelope(
          `<u:GetZoneGroupStateResponse><ZoneGroupState>${state}</ZoneGroupState></u:GetZoneGroupStateResponse>`
        )
      );
    };
    const rooms = await createSonosClient().getRooms({ host: '127.0.0.1', port });
    expect(rooms.map((room) => [room.name, room.host])).toEqual([['Den', '10.0.0.10']]);
    expect(requests[0]).toMatchObject({
      url: '/ZoneGroupTopology/Control',
      soapAction: '"urn:schemas-upnp-org:service:ZoneGroupTopology:1#GetZoneGroupState"',
    });
  });

  it('reads the player UUID from the device description', async () => {
    handler = (_request, response) => {
      response.end('<root><device><UDN>uuid:RINCON_000000000A0101400</UDN></device></root>');
    };
    await expect(createSonosClient().readPlayerUuid({ host: '127.0.0.1', port })).resolves.toBe(
      'RINCON_000000000A0101400'
    );
    expect(requests[0]).toMatchObject({ method: 'GET', url: '/xml/device_description.xml' });
  });

  it('reports a SOAP fault as a refusal, not as unreachable', async () => {
    handler = (_request, response) => {
      response.statusCode = 500;
      response.end(
        envelope(
          '<s:Fault><faultstring>UPnPError</faultstring><detail><UPnPError><errorCode>402</errorCode></UPnPError></detail></s:Fault>'
        )
      );
    };
    const error: unknown = await createSonosClient()
      .getVolume({ host: '127.0.0.1', port })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SonosRequestError);
    expect(error).toMatchObject({
      unreachable: false,
      message: expect.stringContaining('402') as string,
    });
  });

  it('reports a closed port or a hang as unreachable', async () => {
    const refused: unknown = await createSonosClient()
      .getVolume({ host: '127.0.0.1', port: 1 })
      .catch((caught: unknown) => caught);
    expect(refused).toMatchObject({ unreachable: true });

    handler = () => undefined; // never answers
    const hung: unknown = await createSonosClient({ timeoutMs: 100 })
      .getVolume({ host: '127.0.0.1', port })
      .catch((caught: unknown) => caught);
    expect(hung).toMatchObject({ unreachable: true });
  });

  it('lets the integration environment refuse a host before any request', async () => {
    handler = (_request, response) => response.end('');
    const client = createSonosClient({
      assertHost: () => {
        throw new Error('not loopback');
      },
    });
    await expect(client.getVolume({ host: '10.0.0.1', port })).rejects.toThrow('not loopback');
    expect(requests).toHaveLength(0);
  });
});
