import type { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { discoverGoogleTvDevices, stopDiscovery } from '../../../../src/main/device/discovery';

interface FakeChild extends EventEmitter {
  args: string[];
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

const state = vi.hoisted(() => ({
  children: [] as unknown[],
  /** Output for each `dns-sd` invocation, keyed by its joined arguments. */
  outputs: new Map<string, string>(),
  /** When false, children stay alive like the real long-running dns-sd. */
  exitAfterOutput: true,
}));

vi.mock('node:child_process', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  return {
    spawn: vi.fn((_command: string, args: string[]) => {
      const child = Object.assign(new Emitter(), {
        args,
        stdout: new Emitter(),
        stderr: new Emitter(),
        kill: vi.fn(() => {
          queueMicrotask(() => child.emit('close', null));
          return true;
        }),
      });
      state.children.push(child);
      queueMicrotask(() => {
        const output = state.outputs.get(args.join(' '));
        if (output) child.stdout.emit('data', Buffer.from(output));
        if (state.exitAfterOutput) child.emit('close', null);
      });
      return child;
    }),
  };
});
vi.mock('../../../../src/main/capture', () => ({ record: vi.fn() }));
vi.mock('../../../../src/main/integrationEnvironment', () => ({
  integrationEnvironment: undefined,
  assertLoopbackHost: vi.fn(),
}));

const HEADER =
  'DATE: ---Wed 11 Nov 2026---\n 0:05:10.470  ...STARTING...\nTimestamp     A/R    Flags  if Domain               Service Type         Instance Name\n';

function children(): FakeChild[] {
  return state.children as FakeChild[];
}

describe('discoverGoogleTvDevices — real dns-sd column format', () => {
  beforeEach(() => {
    state.children.length = 0;
    state.outputs.clear();
    state.exitAfterOutput = true;
  });

  it('finds _androidtvremote2._tcp instances whose type column has a single trailing space', async () => {
    state.outputs.set(
      '-B _androidtvremote2._tcp local.',
      HEADER +
        ' 0:05:10.480  Add        3  19 local.               _androidtvremote2._tcp. Living Room SHIELD\n' +
        " 0:05:10.480  Add        2  19 local.               _androidtvremote2._tcp. Cheryl & Fred's bedroom tv\n"
    );
    state.outputs.set(
      '-L Living Room SHIELD _androidtvremote2._tcp local.',
      ' 0:14:27.399  Living\\032Room\\032SHIELD._androidtvremote2._tcp.local. can be reached at Android-2.local.:6466 (interface 19)\n bt=02:00:5E:00:00:01\n'
    );
    state.outputs.set(
      "-L Cheryl & Fred's bedroom tv _androidtvremote2._tcp local.",
      " 0:14:27.401  Cheryl\\032&\\032Fred's\\032bedroom\\032tv._androidtvremote2._tcp.local. can be reached at Android-3.local.:6466 (interface 19)\n bt=02:00:5E:00:00:02\n"
    );
    state.outputs.set(
      '-G v4 Android-2.local.',
      ' 0:15:01.150  Add  40000002      19  Android-2.local.                       192.168.1.20                                 120\n'
    );
    state.outputs.set(
      '-G v4 Android-3.local.',
      ' 0:15:01.151  Add  40000002      19  Android-3.local.                       192.168.1.21                                 120\n'
    );

    const devices = await discoverGoogleTvDevices();

    expect(
      devices.map(({ name, host, macAddress, remotePort, source }) => ({
        name,
        host,
        macAddress,
        remotePort,
        source,
      }))
    ).toEqual([
      {
        name: "Cheryl & Fred's bedroom tv",
        host: '192.168.1.21',
        macAddress: '02:00:5E:00:00:02',
        remotePort: 6466,
        source: 'androidtvremote',
      },
      {
        name: 'Living Room SHIELD',
        host: '192.168.1.20',
        macAddress: '02:00:5E:00:00:01',
        remotePort: 6466,
        source: 'androidtvremote',
      },
    ]);
    // `-L` receives the raw instance name, not an escaped one.
    expect(children().map((child) => child.args.join(' '))).toContain(
      "-L Cheryl & Fred's bedroom tv _androidtvremote2._tcp local."
    );
  });

  it('lists only TVs with the remote service; Cast and ADB records just enrich them', async () => {
    state.outputs.set(
      '-B _androidtvremote2._tcp local.',
      HEADER +
        ' 0:05:10.480  Add        3  19 local.               _androidtvremote2._tcp. Living Room SHIELD\n'
    );
    state.outputs.set(
      '-L Living Room SHIELD _androidtvremote2._tcp local.',
      ' 0:14:27.399  Living\\032Room\\032SHIELD._androidtvremote2._tcp.local. can be reached at Android-2.local.:6466 (interface 19)\n bt=02:00:5E:00:00:01\n'
    );
    state.outputs.set(
      '-B _googlecast._tcp local.',
      HEADER +
        ' 0:05:14.493  Add        3  19 local.               _googlecast._tcp.    SHIELD-Android-TV-0001\n' +
        ' 0:05:14.493  Add        3  19 local.               _googlecast._tcp.    Google-Nest-Hub-0002\n' +
        ' 0:05:14.493  Add        2  19 local.               _googlecast._tcp.    Google-Cast-Group-0003\n'
    );
    state.outputs.set(
      '-L SHIELD-Android-TV-0001 _googlecast._tcp local.',
      ' 0:14:30.001  SHIELD-Android-TV-0001._googlecast._tcp.local. can be reached at shield-0001.local.:8009 (interface 19)\n id=0001 md=SHIELD\\ Android\\ TV fn=Living\\ Room\\ SHIELD\n'
    );
    state.outputs.set(
      '-L Google-Nest-Hub-0002 _googlecast._tcp local.',
      ' 0:14:30.002  Google-Nest-Hub-0002._googlecast._tcp.local. can be reached at hub-0002.local.:8009 (interface 19)\n id=0002 md=Google\\ Nest\\ Hub fn=Kitchen\\ Display\n'
    );
    state.outputs.set(
      '-L Google-Cast-Group-0003 _googlecast._tcp local.',
      ' 0:14:30.003  Google-Cast-Group-0003._googlecast._tcp.local. can be reached at group-0003.local.:32190 (interface 19)\n id=0003 md=Google\\ Cast\\ Group fn=Todd\\ world\\ speakers\n'
    );
    state.outputs.set(
      '-B _adb-tls-connect._tcp local.',
      HEADER +
        ' 0:05:15.000  Add        2  19 local.               _adb-tls-connect._tcp. adb-phone-0004\n'
    );
    state.outputs.set(
      '-L adb-phone-0004 _adb-tls-connect._tcp local.',
      ' 0:14:31.000  adb-phone-0004._adb-tls-connect._tcp.local. can be reached at phone-0004.local.:37000 (interface 19)\n'
    );
    const addresses: Record<string, string> = {
      'Android-2.local.': '192.168.1.20',
      'shield-0001.local.': '192.168.1.20',
      'hub-0002.local.': '192.168.1.30',
      'group-0003.local.': '192.168.1.31',
      'phone-0004.local.': '192.168.1.40',
    };
    for (const [hostName, address] of Object.entries(addresses)) {
      state.outputs.set(
        `-G v4 ${hostName}`,
        ` 0:15:01.150  Add  40000002      19  ${hostName}                       ${address}                                 120\n`
      );
    }

    const devices = await discoverGoogleTvDevices();

    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      name: 'Living Room SHIELD',
      host: '192.168.1.20',
      macAddress: '02:00:5E:00:00:01',
      model: 'SHIELD Android TV',
      castDeviceId: '0001',
      source: 'androidtvremote',
    });
  });

  it('stopDiscovery kills dns-sd children that are still running', async () => {
    state.exitAfterOutput = false;
    const scan = discoverGoogleTvDevices();
    await vi.waitFor(() => {
      expect(children()).toHaveLength(4);
    });

    stopDiscovery();

    for (const child of children()) {
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    }
    // In-flight scans resolve with what they had instead of hanging.
    await expect(scan).resolves.toEqual([]);
  });

  it('forgets children that already exited', async () => {
    await discoverGoogleTvDevices();
    stopDiscovery();
    for (const child of children()) {
      expect(child.kill).not.toHaveBeenCalled();
    }
  });
});
