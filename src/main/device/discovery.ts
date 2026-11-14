import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';

import {
  parseDnsSdAddressOutput,
  parseDnsSdBrowseOutput,
  parseDnsSdResolveOutput,
} from '../../backend/discovery/dnsSdOutput';
import type { DiscoveredDevice } from '../../shared/types';
import { record } from '../capture';
import { assertLoopbackHost, integrationEnvironment } from '../integrationEnvironment';

interface ResolvedService {
  instanceName: string;
  hostName?: string;
  host?: string;
  port?: number;
  txt: Record<string, string>;
}

function buildDiscoveredId(host: string, name: string): string {
  return createHash('sha1').update(`${host}:${name}`).digest('hex').slice(0, 12);
}

function buildDeviceFingerprint(name: string, model?: string): string | undefined {
  const normalizedName = name.trim().toLowerCase();
  const normalizedModel = model?.trim().toLowerCase();
  if (!normalizedName || !normalizedModel) {
    return undefined;
  }
  return `${normalizedName}::${normalizedModel}`;
}

// `dns-sd -B/-L/-G` never exit on their own; every child is tracked so app
// shutdown can kill the ones still inside their browse window.
const activeChildren = new Set<ChildProcess>();

/**
 * Kills every running `dns-sd` child. Call on app quit so no browse/resolve
 * process outlives the app. In-flight scans resolve with what they had.
 */
export function stopDiscovery(): void {
  for (const child of activeChildren) {
    try {
      child.kill('SIGTERM');
    } catch {
      // Already exited.
    }
  }
  activeChildren.clear();
}

function runDnsSd(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(integrationEnvironment?.discoveryCommand ?? 'dns-sd', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: integrationEnvironment
        ? { ...process.env, GTV_DNS_SD_STATE: integrationEnvironment.discoveryStatePath }
        : process.env,
    });
    activeChildren.add(child);

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      child.kill('SIGTERM');
      resolve(stdout);
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      activeChildren.delete(child);
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      activeChildren.delete(child);
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);

      if (code === 0 || code === null) {
        resolve(stdout);
        return;
      }

      reject(new Error(stderr.trim() || `dns-sd exited with code ${String(code)}`));
    });
  });
}

async function browseServiceInstances(serviceType: string, timeoutMs = 2500): Promise<string[]> {
  const output = await runDnsSd(['-B', serviceType, 'local.'], timeoutMs);
  return parseDnsSdBrowseOutput(output, serviceType);
}

async function resolveService(
  instanceName: string,
  serviceType: string
): Promise<ResolvedService | null> {
  // `-L` takes the raw instance name exactly as browse printed it.
  const output = await runDnsSd(['-L', instanceName, serviceType, 'local.'], 2000);
  const resolved = parseDnsSdResolveOutput(output);
  if (!resolved) {
    return null;
  }

  const host = await resolveHostToIp(resolved.hostName);
  if (!host) {
    return null;
  }

  return {
    instanceName,
    hostName: resolved.hostName,
    host,
    port: resolved.port,
    txt: resolved.txt,
  };
}

async function resolveHostToIp(hostName: string): Promise<string | undefined> {
  const output = await runDnsSd(['-G', 'v4', hostName], 2000);
  const address = parseDnsSdAddressOutput(output);
  if (address && integrationEnvironment) assertLoopbackHost(address);
  return address;
}

export async function discoverGoogleTvDevices(): Promise<DiscoveredDevice[]> {
  const [remoteInstances, castInstances, adbConnectInstances, adbPairInstances] = await Promise.all(
    [
      browseServiceInstances('_androidtvremote2._tcp', 3000).catch(() => []),
      browseServiceInstances('_googlecast._tcp', 3000).catch(() => []),
      browseServiceInstances('_adb-tls-connect._tcp', 3000).catch(() => []),
      browseServiceInstances('_adb-tls-pairing._tcp', 3000).catch(() => []),
    ]
  );

  const [remoteServices, castServices, adbConnectServices, adbPairServices] = await Promise.all([
    Promise.all(
      remoteInstances.map((instance) => resolveService(instance, '_androidtvremote2._tcp'))
    ),
    Promise.all(castInstances.map((instance) => resolveService(instance, '_googlecast._tcp'))),
    Promise.all(
      adbConnectInstances.map((instance) => resolveService(instance, '_adb-tls-connect._tcp'))
    ),
    Promise.all(
      adbPairInstances.map((instance) => resolveService(instance, '_adb-tls-pairing._tcp'))
    ),
  ]);

  const remoteByHost = new Map<string, ResolvedService>();
  const connectByHost = new Map<string, ResolvedService>();
  const pairingByHost = new Map<string, ResolvedService>();

  for (const service of remoteServices) {
    if (service?.host) {
      remoteByHost.set(service.host, service);
    }
  }

  for (const service of adbConnectServices) {
    if (service?.host) {
      connectByHost.set(service.host, service);
    }
  }

  for (const service of adbPairServices) {
    if (service?.host) {
      pairingByHost.set(service.host, service);
    }
  }

  const devices = new Map<string, DiscoveredDevice>();

  for (const service of remoteServices) {
    if (!service?.host) {
      continue;
    }

    const name = service.instanceName;
    devices.set(service.host, {
      id: buildDiscoveredId(service.host, name),
      name,
      host: service.host,
      networkHostName: service.hostName,
      remotePort: service.port,
      pairingPort: integrationEnvironment?.pairingPort ?? 6467,
      macAddress: service.txt.bt,
      deviceFingerprint: buildDeviceFingerprint(name),
      source: 'androidtvremote',
    });
  }

  for (const service of castServices) {
    if (!service?.host) {
      continue;
    }

    const existing = devices.get(service.host);
    const remoteService = remoteByHost.get(service.host);
    const connectService = connectByHost.get(service.host);
    const pairService = pairingByHost.get(service.host);
    const name = service.txt.fn || service.instanceName;

    devices.set(service.host, {
      id: existing?.id ?? buildDiscoveredId(service.host, name),
      name: existing?.name ?? name,
      host: service.host,
      networkHostName: existing?.networkHostName ?? service.hostName ?? remoteService?.hostName,
      remotePort: existing?.remotePort ?? remoteService?.port,
      adbPort: connectService?.port,
      pairingPort: existing?.pairingPort ?? pairService?.port,
      macAddress: existing?.macAddress ?? remoteService?.txt.bt,
      castDeviceId: service.txt.id || existing?.castDeviceId,
      model: service.txt.md || existing?.model,
      deviceFingerprint:
        existing?.deviceFingerprint ??
        buildDeviceFingerprint(existing?.name ?? name, service.txt.md),
      source: existing?.source ?? (connectService || pairService ? 'adb' : 'googlecast'),
    });
  }

  const result = [...devices.values()].sort((left, right) => left.name.localeCompare(right.name));
  record({
    layer: 'discovery',
    direction: 'rx',
    event: 'discoverGoogleTvDevices',
    data: result.map((d) => ({
      id: d.id,
      name: d.name,
      host: d.host,
      source: d.source,
      macAddress: d.macAddress,
    })),
    meta: { count: result.length },
  });
  return result;
}
