/**
 * Minimal UPnP SOAP for the few Sonos actions the volume link needs. Sonos
 * players answer on HTTP port 1400; every request is a POST of a SOAP envelope
 * with a `SOAPACTION` header naming the service and action.
 */

export interface SonosService {
  path: string;
  type: string;
}

export const SONOS_PORT = 1400;

export const RENDERING_CONTROL: SonosService = {
  path: '/MediaRenderer/RenderingControl/Control',
  type: 'urn:schemas-upnp-org:service:RenderingControl:1',
};

export const ZONE_GROUP_TOPOLOGY: SonosService = {
  path: '/ZoneGroupTopology/Control',
  type: 'urn:schemas-upnp-org:service:ZoneGroupTopology:1',
};

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => XML_ESCAPES[character] ?? character);
}

export function unescapeXml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity: string) => {
    const name = entity.toLowerCase();
    if (name.startsWith('#x')) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith('#')) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[name] ?? match;
  });
}

export function soapActionHeader(service: SonosService, action: string): string {
  return `"${service.type}#${action}"`;
}

export function buildSoapEnvelope(
  service: SonosService,
  action: string,
  args: Record<string, string | number>
): string {
  const body = Object.entries(args)
    .map(([name, value]) => `<${name}>${escapeXml(String(value))}</${name}>`)
    .join('');
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>' +
    `<u:${action} xmlns:u="${service.type}">${body}</u:${action}>` +
    '</s:Body></s:Envelope>'
  );
}

/** Reads `<field>value</field>` from a SOAP response (namespace prefixes ignored). */
export function readSoapField(xml: string, field: string): string | undefined {
  const match = new RegExp(`<(?:\\w+:)?${field}>([\\s\\S]*?)</(?:\\w+:)?${field}>`).exec(xml);
  return match ? unescapeXml(match[1] ?? '') : undefined;
}

export interface SoapFault {
  code?: string;
  description?: string;
}

/** Extracts the UPnP error from a SOAP fault, if the response is one. */
export function parseSoapFault(xml: string): SoapFault | undefined {
  if (!/<(?:\w+:)?Fault>/.test(xml)) return undefined;
  return {
    code: readSoapField(xml, 'errorCode'),
    description: readSoapField(xml, 'errorDescription') ?? readSoapField(xml, 'faultstring'),
  };
}

/** The player UUID (`RINCON_…`) from a device description document. */
export function readDeviceUuid(deviceDescriptionXml: string): string | undefined {
  // The first UDN is the player itself; embedded devices append suffixes like `_MR`.
  const udn = readSoapField(deviceDescriptionXml, 'UDN');
  return udn?.replace(/^uuid:/, '');
}
