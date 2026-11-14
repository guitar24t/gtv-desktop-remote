import dgram from 'node:dgram';
import os from 'node:os';

import {
  buildSsdpSearch,
  SSDP_ADDRESS,
  SSDP_PORT,
} from '../../backend/audio/sonos/discoveryRecords';

/** External IPv4 addresses, one per interface (Wi-Fi, Ethernet, VPN, virtual adapters…). */
export function externalIPv4Addresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flatMap((addresses) => addresses ?? [])
    .filter((address) => address.family === 'IPv4' && !address.internal)
    .map((address) => address.address);
}

function guard(step: () => void): void {
  try {
    step();
  } catch {
    // Some adapters (VPNs, virtual NICs) reject multicast options; skip them.
  }
}

/**
 * Sends an SSDP M-SEARCH out of every interface and collects the raw replies.
 * The default route alone often picks a VPN or virtual adapter, so each
 * external IPv4 address gets its own socket; one failing socket never stops
 * the others. Replies are unicast back to the sending socket.
 */
export function ssdpSearch({
  searchTarget,
  timeoutMs = 2500,
  interfaces = externalIPv4Addresses(),
  destination = { address: SSDP_ADDRESS, port: SSDP_PORT },
  repeatAfterMs = 400,
}: {
  searchTarget?: string;
  timeoutMs?: number;
  interfaces?: string[];
  /** Overridable for tests; real searches go to the SSDP multicast group. */
  destination?: { address: string; port: number };
  repeatAfterMs?: number;
} = {}): Promise<string[]> {
  const payload = Buffer.from(buildSsdpSearch(searchTarget, 1));
  const replies: string[] = [];
  const sockets: dgram.Socket[] = [];
  const timers: NodeJS.Timeout[] = [];

  const send = (socket: dgram.Socket) => {
    socket.send(payload, destination.port, destination.address, () => undefined);
  };

  const open = (bindAddress: string | undefined) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sockets.push(socket);
    socket.on('error', () => {
      guard(() => {
        socket.close();
      });
    });
    socket.on('message', (message) => {
      replies.push(message.toString('utf8'));
    });
    guard(() => {
      socket.bind(0, bindAddress, () => {
        guard(() => {
          socket.setMulticastTTL(4);
        });
        if (bindAddress) {
          guard(() => {
            socket.setMulticastInterface(bindAddress);
          });
        }
        guard(() => {
          send(socket);
        });
        // UDP is lossy; a second search catches players that missed the first.
        timers.push(
          setTimeout(() => {
            guard(() => {
              send(socket);
            });
          }, repeatAfterMs)
        );
      });
    });
  };

  open(undefined);
  for (const address of new Set(interfaces)) open(address);

  return new Promise((resolve) => {
    timers.push(
      setTimeout(() => {
        for (const timer of timers) clearTimeout(timer);
        for (const socket of sockets) {
          guard(() => {
            socket.close();
          });
        }
        resolve(replies);
      }, timeoutMs)
    );
  });
}
