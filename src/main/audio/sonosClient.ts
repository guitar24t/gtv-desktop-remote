import {
  buildSoapEnvelope,
  parseSoapFault,
  readDeviceUuid,
  readSoapField,
  RENDERING_CONTROL,
  soapActionHeader,
  SONOS_PORT,
  ZONE_GROUP_TOPOLOGY,
  type SonosService,
} from '../../backend/audio/sonos/soap';
import { parseZoneGroupState, type SonosRoom } from '../../backend/audio/sonos/topology';

export interface SonosAddress {
  host: string;
  port: number;
}

/** `unreachable` means the player did not answer (worth re-discovering), not that it refused. */
export class SonosRequestError extends Error {
  constructor(
    message: string,
    readonly unreachable: boolean
  ) {
    super(message);
    this.name = 'SonosRequestError';
  }
}

export interface SonosClient {
  getRooms(address: SonosAddress): Promise<SonosRoom[]>;
  readPlayerUuid(address: SonosAddress): Promise<string | undefined>;
  setRelativeVolume(address: SonosAddress, delta: number): Promise<number>;
  getVolume(address: SonosAddress): Promise<number>;
  getMute(address: SonosAddress): Promise<boolean>;
  setMute(address: SonosAddress, muted: boolean): Promise<void>;
}

export const SONOS_REQUEST_TIMEOUT_MS = 3000;

function baseUrl({ host, port }: SonosAddress): string {
  return `http://${host.includes(':') ? `[${host}]` : host}:${String(port || SONOS_PORT)}`;
}

export function createSonosClient({
  fetchImpl = fetch,
  timeoutMs = SONOS_REQUEST_TIMEOUT_MS,
  assertHost = () => undefined,
}: {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Lets the integration environment refuse non-loopback hosts. */
  assertHost?: (host: string) => void;
} = {}): SonosClient {
  async function request(
    address: SonosAddress,
    path: string,
    init: RequestInit
  ): Promise<{ ok: boolean; status: number; text: string }> {
    assertHost(address.host);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl(address)}${path}`, {
        ...init,
        signal: controller.signal,
      });
      return { ok: response.ok, status: response.status, text: await response.text() };
    } catch {
      throw new SonosRequestError(`The Sonos speaker at ${address.host} did not respond.`, true);
    } finally {
      clearTimeout(timer);
    }
  }

  async function soap(
    address: SonosAddress,
    service: SonosService,
    action: string,
    args: Record<string, string | number>
  ): Promise<string> {
    const response = await request(address, service.path, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        SOAPACTION: soapActionHeader(service, action),
      },
      body: buildSoapEnvelope(service, action, args),
    });
    if (!response.ok) {
      const fault = parseSoapFault(response.text);
      const detail = fault?.code ? `UPnP error ${fault.code}` : `HTTP ${String(response.status)}`;
      throw new SonosRequestError(`The Sonos speaker refused ${action} (${detail}).`, false);
    }
    return response.text;
  }

  const master = { InstanceID: 0, Channel: 'Master' };

  function numberField(xml: string, field: string, action: string): number {
    const value = Number(readSoapField(xml, field));
    if (!Number.isFinite(value)) {
      throw new SonosRequestError(`The Sonos speaker sent an unexpected ${action} reply.`, false);
    }
    return value;
  }

  return {
    async getRooms(address) {
      return parseZoneGroupState(await soap(address, ZONE_GROUP_TOPOLOGY, 'GetZoneGroupState', {}));
    },
    async readPlayerUuid(address) {
      const response = await request(address, '/xml/device_description.xml', { method: 'GET' });
      return response.ok ? readDeviceUuid(response.text) : undefined;
    },
    async setRelativeVolume(address, delta) {
      const xml = await soap(address, RENDERING_CONTROL, 'SetRelativeVolume', {
        ...master,
        Adjustment: Math.round(delta),
      });
      return numberField(xml, 'NewVolume', 'SetRelativeVolume');
    },
    async getVolume(address) {
      return numberField(
        await soap(address, RENDERING_CONTROL, 'GetVolume', master),
        'CurrentVolume',
        'GetVolume'
      );
    },
    async getMute(address) {
      return (
        numberField(
          await soap(address, RENDERING_CONTROL, 'GetMute', master),
          'CurrentMute',
          'GetMute'
        ) === 1
      );
    },
    async setMute(address, muted) {
      await soap(address, RENDERING_CONTROL, 'SetMute', { ...master, DesiredMute: muted ? 1 : 0 });
    },
  };
}
