import { describe, expect, it } from 'vitest';

import {
  buildSsdpSearch,
  parseSonosMdns,
  parseSsdpResponse,
  SONOS_SEARCH_TARGET,
} from '../discoveryRecords';
import {
  buildSoapEnvelope,
  escapeXml,
  parseSoapFault,
  readDeviceUuid,
  readSoapField,
  RENDERING_CONTROL,
  soapActionHeader,
  unescapeXml,
} from '../soap';
import { parseZoneGroupState } from '../topology';

const escaped = (xml: string) => escapeXml(xml);

/** Shape of a real household: a home-theater room, a stereo pair, and a two-room group. */
const ZONE_GROUP_STATE = `<ZoneGroupState><ZoneGroups>
<ZoneGroup Coordinator="RINCON_000000000A0101400" ID="RINCON_000000000A0101400:1">
  <ZoneGroupMember UUID="RINCON_000000000A0101400" Location="http://10.0.0.10:1400/xml/device_description.xml" ZoneName="Living Room" HTSatChanMapSet="x">
    <Satellite UUID="RINCON_000000000A0201400" Location="http://10.0.0.11:1400/xml/device_description.xml" ZoneName="Living Room" Invisible="1"/>
    <Satellite UUID="RINCON_000000000A0301400" Location="http://10.0.0.12:1400/xml/device_description.xml" ZoneName="Living Room" Invisible="1"/>
  </ZoneGroupMember>
</ZoneGroup>
<ZoneGroup Coordinator="RINCON_000000000B0101400" ID="RINCON_000000000B0101400:2">
  <ZoneGroupMember UUID="RINCON_000000000B0101400" Location="http://10.0.0.20:1400/xml/device_description.xml" ZoneName="Rob &amp; Stacey’s Room"/>
  <ZoneGroupMember UUID="RINCON_000000000B0201400" Location="http://10.0.0.21:1400/xml/device_description.xml" ZoneName="Rob &amp; Stacey’s Room" Invisible="1"/>
  <ZoneGroupMember UUID="RINCON_000000000C0101400" Location="http://10.0.0.30:1400/xml/device_description.xml" ZoneName="Kitchen"/>
</ZoneGroup>
</ZoneGroups><VanishedDevices/></ZoneGroupState>`;

describe('Sonos SOAP', () => {
  it('builds an escaped envelope and SOAPACTION header', () => {
    const envelope = buildSoapEnvelope(RENDERING_CONTROL, 'SetRelativeVolume', {
      InstanceID: 0,
      Channel: 'Master',
      Adjustment: -2,
    });
    expect(envelope).toContain(
      '<u:SetRelativeVolume xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1">'
    );
    expect(envelope).toContain('<InstanceID>0</InstanceID><Channel>Master</Channel>');
    expect(envelope).toContain('<Adjustment>-2</Adjustment>');
    expect(soapActionHeader(RENDERING_CONTROL, 'GetMute')).toBe(
      '"urn:schemas-upnp-org:service:RenderingControl:1#GetMute"'
    );
    expect(buildSoapEnvelope(RENDERING_CONTROL, 'X', { Name: '<a&b>' })).toContain(
      '<Name>&lt;a&amp;b&gt;</Name>'
    );
  });

  it('reads response fields regardless of namespace prefix', () => {
    const response =
      '<s:Envelope><s:Body><u:SetRelativeVolumeResponse><NewVolume>24</NewVolume></u:SetRelativeVolumeResponse></s:Body></s:Envelope>';
    expect(readSoapField(response, 'NewVolume')).toBe('24');
    expect(readSoapField(response, 'Missing')).toBeUndefined();
    expect(parseSoapFault(response)).toBeUndefined();
  });

  it('extracts UPnP faults', () => {
    const fault =
      '<s:Envelope><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>402</errorCode></UPnPError></detail></s:Fault></s:Body></s:Envelope>';
    expect(parseSoapFault(fault)).toEqual({ code: '402', description: 'UPnPError' });
  });

  it('round-trips XML escapes, including numeric entities', () => {
    expect(unescapeXml('&lt;a&gt; &amp; &quot;b&quot; &#8217; &#x2019;')).toBe('<a> & "b" ’ ’');
    expect(unescapeXml(escapeXml(`<"Rob’s" & 'x'>`))).toBe(`<"Rob’s" & 'x'>`);
  });

  it('reads the player UUID from a device description', () => {
    const description =
      '<root><device><UDN>uuid:RINCON_000000000A0101400</UDN><deviceList><device><UDN>uuid:RINCON_000000000A0101400_MR</UDN></device></deviceList></device></root>';
    expect(readDeviceUuid(description)).toBe('RINCON_000000000A0101400');
  });
});

describe('Sonos zone topology', () => {
  it('lists one controllable room per visible player, skipping satellites and hidden pair members', () => {
    const response = `<s:Envelope><s:Body><u:GetZoneGroupStateResponse><ZoneGroupState>${escaped(
      ZONE_GROUP_STATE
    )}</ZoneGroupState></u:GetZoneGroupStateResponse></s:Body></s:Envelope>`;
    expect(parseZoneGroupState(response)).toEqual([
      {
        kind: 'sonos',
        id: 'RINCON_000000000C0101400',
        name: 'Kitchen',
        host: '10.0.0.30',
        port: 1400,
        coordinatorId: 'RINCON_000000000B0101400',
      },
      {
        kind: 'sonos',
        id: 'RINCON_000000000A0101400',
        name: 'Living Room',
        host: '10.0.0.10',
        port: 1400,
        coordinatorId: 'RINCON_000000000A0101400',
      },
      {
        kind: 'sonos',
        id: 'RINCON_000000000B0101400',
        name: 'Rob & Stacey’s Room',
        host: '10.0.0.20',
        port: 1400,
        coordinatorId: 'RINCON_000000000B0101400',
      },
    ]);
  });

  it('accepts an already-unescaped ZoneGroupState document', () => {
    expect(parseZoneGroupState(ZONE_GROUP_STATE).map((room) => room.name)).toEqual([
      'Kitchen',
      'Living Room',
      'Rob & Stacey’s Room',
    ]);
  });

  it('returns no rooms for junk', () => {
    expect(parseZoneGroupState('<html>nope</html>')).toEqual([]);
  });
});

describe('Sonos discovery records', () => {
  it('builds an SSDP search for Sonos players', () => {
    const search = buildSsdpSearch();
    expect(search.startsWith('M-SEARCH * HTTP/1.1\r\n')).toBe(true);
    expect(search).toContain('HOST: 239.255.255.250:1900\r\n');
    expect(search).toContain('MAN: "ssdp:discover"\r\n');
    expect(search).toContain(`ST: ${SONOS_SEARCH_TARGET}\r\n`);
    expect(search.endsWith('\r\n\r\n')).toBe(true);
  });

  it('parses a Sonos SSDP reply and ignores other devices', () => {
    const reply = [
      'HTTP/1.1 200 OK',
      'CACHE-CONTROL: max-age = 1800',
      'LOCATION: http://10.0.0.10:1400/xml/device_description.xml',
      'ST: urn:schemas-upnp-org:device:ZonePlayer:1',
      'USN: uuid:RINCON_000000000A0101400::urn:schemas-upnp-org:device:ZonePlayer:1',
      'X-RINCON-HOUSEHOLD: Sonos_household',
      '',
      '',
    ].join('\r\n');
    expect(parseSsdpResponse(reply)).toEqual({
      host: '10.0.0.10',
      port: 1400,
      id: 'RINCON_000000000A0101400',
      household: 'Sonos_household',
      source: 'ssdp',
    });
    const router = [
      'HTTP/1.1 200 OK',
      'LOCATION: http://10.0.0.1:5000/rootDesc.xml',
      'ST: upnp:rootdevice',
      'USN: uuid:router::upnp:rootdevice',
      '',
    ].join('\r\n');
    expect(parseSsdpResponse(router)).toBeUndefined();
    expect(parseSsdpResponse('NOTIFY * HTTP/1.1\r\n\r\n')).toBeUndefined();
  });

  it('parses a _sonos._tcp record from its instance name and TXT location', () => {
    expect(
      parseSonosMdns('RINCON_000000000A0101400@Living Room', {
        location: 'http://10.0.0.10:1400/xml/device_description.xml',
        hhid: 'Sonos_household',
      })
    ).toEqual({
      host: '10.0.0.10',
      port: 1400,
      id: 'RINCON_000000000A0101400',
      household: 'Sonos_household',
      source: 'mdns',
    });
    expect(parseSonosMdns('RINCON_X@Den', {}, '10.0.0.40')).toMatchObject({
      host: '10.0.0.40',
      port: 1400,
    });
    expect(parseSonosMdns('Den', {})).toBeUndefined();
  });
});
