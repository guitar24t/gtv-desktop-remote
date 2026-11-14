import { createHash } from 'node:crypto';
import { constants as fsConstants, existsSync, promises as fsPromises, readdirSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as UpdaterModule from '../../../src/main/updater.js';
import type { UpdaterStatus } from '../../../src/shared/types';

/**
 * Drives the real src/main/updater.ts against a loopback release server and
 * real temporary directories. Electron, logging and the native-command
 * boundary are replaced; `ditto -x` reads a JSON "archive" so the test runs
 * the same on Linux CI as on macOS.
 */
const env = vi.hoisted(() => ({
  root: '',
  installed: '',
  integration: true,
  packaged: true,
  version: '2.2.0',
  releaseApiUrl: '',
  native: [] as { command: string; args: string[] }[],
  failCommand: undefined as string | undefined,
  dialogResponses: [] as number[],
  dialogs: [] as { buttons?: string[]; message?: string; detail?: string }[],
  relaunches: 0,
}));

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return env.packaged;
    },
    getVersion: () => env.version,
  },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  shell: { openExternal: vi.fn() },
}));

vi.mock('../../../src/main/logger', async () => {
  const nodePath = await import('node:path');
  return {
    getAppDataPath: (...segments: string[]) => nodePath.join(env.root, 'userData', ...segments),
    logError: vi.fn(() => Promise.resolve()),
    logInfo: vi.fn(() => Promise.resolve()),
  };
});

vi.mock('../../../src/main/integrationEnvironment', async () => {
  const nodeFs = await import('node:fs');
  const nodePath = await import('node:path');
  return {
    get integrationEnvironment() {
      return env.integration
        ? { updater: { releaseApiUrl: env.releaseApiUrl, installedBundlePath: env.installed } }
        : undefined;
    },
    assertIntegrationPath: () => undefined,
    assertLoopbackUrl: () => undefined,
    relaunchUpdatedApp: () => {
      env.relaunches += 1;
    },
    runNativeCommand: (command: string, args: string[]) => {
      env.native.push({ command, args });
      if (env.failCommand === command) {
        return Promise.reject(new Error(`Synthetic ${command} failure`));
      }
      if (command === 'ditto' && args[0] === '-x') {
        const archive = args[2] ?? '';
        const destination = args[3] ?? '';
        let files: Record<string, string>;
        try {
          files = (
            JSON.parse(nodeFs.readFileSync(archive, 'utf8')) as { files: Record<string, string> }
          ).files;
        } catch {
          return Promise.reject(new Error(`ditto: ${archive}: not a valid zip archive`));
        }
        for (const [relative, contents] of Object.entries(files)) {
          const file = nodePath.join(destination, relative);
          nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true });
          nodeFs.writeFileSync(file, contents);
        }
      } else if (command === 'ditto') {
        // Like real ditto: copies the source tree into the destination, merging.
        nodeFs.cpSync(args[0] ?? '', args[1] ?? '', { recursive: true });
      } else if (command === 'rm') {
        nodeFs.rmSync(args.at(-1) ?? '', { recursive: true, force: true });
      }
      return Promise.resolve();
    },
    showMessageBox: (options: { buttons?: string[]; message?: string; detail?: string }) => {
      env.dialogs.push({
        buttons: options.buttons,
        message: options.message,
        detail: options.detail,
      });
      const response = env.dialogResponses.shift();
      if (response === undefined) {
        return Promise.reject(new Error(`Unexpected dialog: ${options.message ?? ''}`));
      }
      return Promise.resolve({ response, checkboxChecked: false });
    },
    updaterTemporaryDirectory: () => nodePath.join(env.root, 'tmp'),
    updaterVersion: () => env.version,
  };
});

type Updater = typeof UpdaterModule;

const BUNDLE_ID = 'com.utkarsh.gtvdesktopremote';
const GITHUB_LATEST = 'https://api.github.com/repos/guitar24t/gtv-desktop-remote/releases/latest';
const T0 = Date.parse('2026-11-12T10:00:00.000Z');
const MINUTE = 60_000;

function infoPlist(identifier: string, version: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>${identifier}</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
</dict></plist>`;
}

function bundleFiles(version: string, identifier = BUNDLE_ID): Record<string, string> {
  return {
    'Contents/Info.plist': infoPlist(identifier, version),
    'Contents/MacOS/GTV Remote': `binary ${version}`,
  };
}

const OLD_FILES = { ...bundleFiles('2.2.0'), 'Contents/Resources/stale.txt': 'only in 2.2.0' };

function archive(version: string, identifier = BUNDLE_ID): Buffer {
  const files = Object.fromEntries(
    Object.entries(bundleFiles(version, identifier)).map(([relative, contents]) => [
      `GTV Remote.app/${relative}`,
      contents,
    ])
  );
  return Buffer.from(JSON.stringify({ files }));
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function writeTree(directory: string, files: Record<string, string>) {
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(directory, relative);
    await fsPromises.mkdir(path.dirname(file), { recursive: true });
    await fsPromises.writeFile(file, contents);
  }
}

async function readTree(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await fsPromises.readdir(directory, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    result[path.relative(directory, file)] = await fsPromises.readFile(file, 'utf8');
  }
  return result;
}

interface ReleaseFixture {
  tag: string;
  /** Bytes served for the asset download. */
  served: Buffer;
  /** Digest advertised by the release API; defaults to the served bytes' digest. */
  digest?: string | null;
  /** Size advertised by the release API; defaults to the served length. */
  size?: number;
  assets?: 'zip' | 'none';
  latestStatus?: number;
  latestHeaders?: Record<string, string>;
  holdAsset?: Promise<void>;
}

let server: Server;
let serverUrl = '';
let release: ReleaseFixture;
let requests: string[] = [];
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const originalExecPath = process.execPath;

function count(url: string): number {
  return requests.filter((request) => request === url).length;
}

async function handle(request: IncomingMessage, response: ServerResponse) {
  requests.push(request.url ?? '');
  if (request.url === '/latest') {
    if (release.latestStatus) {
      response.writeHead(release.latestStatus, release.latestHeaders);
      response.end();
      return;
    }
    const assets =
      release.assets === 'none'
        ? []
        : [
            {
              name: `GTV.Remote-${release.tag.slice(1)}-mac-${process.arch}.zip`,
              browser_download_url: `${serverUrl}/asset`,
              size: release.size ?? release.served.length,
              ...(release.digest === null
                ? {}
                : { digest: release.digest ?? `sha256:${sha256(release.served)}` }),
            },
          ];
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ tag_name: release.tag, html_url: serverUrl, assets }));
  } else if (request.url === '/asset') {
    response.setHeader('content-length', release.served.length);
    if (release.holdAsset) {
      response.write(release.served.subarray(0, 8));
      await release.holdAsset;
      response.end(release.served.subarray(8));
    } else {
      response.end(release.served);
    }
  } else {
    response.writeHead(404);
    response.end();
  }
}

async function loadUpdater(): Promise<Updater> {
  vi.resetModules();
  return await import('../../../src/main/updater.js');
}

function rollbackBundle(): string {
  return path.join(env.root, 'userData', 'rollback', 'GTV Remote.app');
}

function tmpEntries(): string[] {
  return readdirSync(path.join(env.root, 'tmp'));
}

function siblingsOfInstalled(): string[] {
  return readdirSync(path.dirname(env.installed));
}

async function installedVersionOf(updater: Updater, version: string, choice = 1) {
  release = { tag: `v${version}`, served: archive(version) };
  expect((await updater.checkForUpdatesManually()).updateInstallable).toBe(true);
  env.dialogResponses.push(choice);
  return await updater.installAvailableUpdate();
}

beforeEach(async () => {
  env.root = await fsPromises.realpath(
    await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gtv-updater-unit-'))
  );
  env.installed = path.join(env.root, 'Applications', 'GTV Remote.app');
  env.integration = true;
  env.packaged = true;
  env.version = '2.2.0';
  env.native = [];
  env.failCommand = undefined;
  env.dialogResponses = [];
  env.dialogs = [];
  env.relaunches = 0;
  await fsPromises.mkdir(path.join(env.root, 'tmp'));
  await writeTree(env.installed, OLD_FILES);

  requests = [];
  release = { tag: 'v2.3.0', served: archive('2.3.0') };
  server = createServer((request, response) => {
    void handle(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback address');
  serverUrl = `http://127.0.0.1:${String(address.port)}`;
  env.releaseApiUrl = `${serverUrl}/latest`;
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  process.execPath = originalExecPath;
  server.closeAllConnections();
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    })
  );
  await fsPromises.rm(env.root, { recursive: true, force: true });
});

describe('install swap', () => {
  it('swaps the verified bundle into place, drops stale files and keeps the old bundle as the backup', async () => {
    const updater = await loadUpdater();
    const status = await installedVersionOf(updater, '2.3.0');

    expect(status).toMatchObject({
      stage: 'completed',
      inProgress: false,
      relaunchRequired: true,
      installedVersion: '2.3.0',
      rollbackAvailable: true,
      rollbackVersion: '2.2.0',
      message: 'Update 2.3.0 installed. Relaunch GTV Remote to finish.',
    });
    // Not a merge: the file that only existed in 2.2.0 is gone from the live bundle.
    expect(await readTree(env.installed)).toEqual(bundleFiles('2.3.0'));
    expect(await readTree(rollbackBundle())).toEqual(OLD_FILES);
    expect(siblingsOfInstalled()).toEqual(['GTV Remote.app']);
    expect(tmpEntries()).toEqual([]);

    // Quarantine is removed from the staged copy only after verification, before the swap.
    const xattr = env.native.find((operation) => operation.command === 'xattr');
    expect(xattr?.args.at(-1)).toMatch(/[/\\]\.GTV Remote\.app\.update-[^/\\]+$/);
    expect(env.native.some((operation) => operation.command.endsWith('codesign'))).toBe(false);
    expect(env.dialogs.map((dialog) => dialog.buttons)).toEqual([['Relaunch now', 'Later']]);
  });

  it('restores the original bundle when the staged bundle cannot be moved into place', async () => {
    const updater = await loadUpdater();
    const realRename = fsPromises.rename.bind(fsPromises);
    vi.spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
      if (String(from).includes('.update-') && String(to) === env.installed) {
        throw Object.assign(new Error('EIO: synthetic rename failure'), { code: 'EIO' });
      }
      await realRename(from, to);
    });
    release = { tag: 'v2.3.0', served: archive('2.3.0') };
    await updater.checkForUpdatesManually();
    env.dialogResponses.push(0);

    const status = await updater.installAvailableUpdate();

    expect(status).toMatchObject({ stage: 'failed', inProgress: false, rollbackAvailable: false });
    expect(status.relaunchRequired).toBeUndefined();
    expect(await readTree(env.installed)).toEqual(OLD_FILES);
    expect(siblingsOfInstalled()).toEqual(['GTV Remote.app']);
    expect(existsSync(rollbackBundle())).toBe(false);
    expect(tmpEntries()).toEqual([]);
    expect(env.dialogs.at(-1)?.detail).toMatch(/synthetic rename failure/);
  });

  it('cleans up the work directory when extraction fails', async () => {
    const updater = await loadUpdater();
    release = { tag: 'v2.3.0', served: Buffer.from('not a zip') };
    await updater.checkForUpdatesManually();
    env.dialogResponses.push(0);

    expect((await updater.installAvailableUpdate()).stage).toBe('failed');
    expect(env.dialogs.at(-1)?.detail).toMatch(/not a valid zip archive/);
    expect(tmpEntries()).toEqual([]);
    expect(await readTree(env.installed)).toEqual(OLD_FILES);
  });
});

describe('download and bundle verification', () => {
  const genuine = archive('2.3.0');
  const tampered = Buffer.from(genuine);
  tampered[tampered.length - 3] = 0x21;

  it.each<[string, Partial<ReleaseFixture>, RegExp]>([
    ['a digest that does not match', { digest: `sha256:${'0'.repeat(64)}` }, /SHA-256/],
    [
      'tampered bytes of the published size',
      { served: tampered, digest: `sha256:${sha256(genuine)}` },
      /SHA-256/,
    ],
    ['a size that does not match', { size: genuine.length + 1 }, /size mismatch/],
    ['a missing digest', { digest: null }, /no SHA-256 digest/],
  ])('refuses %s and leaves the installed app untouched', async (_label, overrides, detail) => {
    const updater = await loadUpdater();
    release = { tag: 'v2.3.0', served: genuine, ...overrides };
    await updater.checkForUpdatesManually();
    env.dialogResponses.push(0);

    const status = await updater.installAvailableUpdate();

    expect(status).toMatchObject({ stage: 'failed', inProgress: false, rollbackAvailable: false });
    expect(env.dialogs.at(-1)?.detail).toMatch(detail);
    expect(await readTree(env.installed)).toEqual(OLD_FILES);
    expect(siblingsOfInstalled()).toEqual(['GTV Remote.app']);
    expect(tmpEntries()).toEqual([]);
    expect(env.native.some((operation) => operation.command === 'xattr')).toBe(false);
    if (overrides.digest === null) expect(count('/asset')).toBe(0);
  });

  it.each<[string, Buffer, RegExp]>([
    [
      'another app',
      archive('2.3.0', 'com.example.other'),
      /bundle identifier "com\.example\.other"/,
    ],
    [
      'a different version than the release',
      archive('2.2.9'),
      /reports version 2\.2\.9, expected 2\.3\.0/,
    ],
  ])('refuses a bundle for %s', async (_label, served, detail) => {
    const updater = await loadUpdater();
    release = { tag: 'v2.3.0', served };
    await updater.checkForUpdatesManually();
    env.dialogResponses.push(0);

    expect((await updater.installAvailableUpdate()).stage).toBe('failed');
    expect(env.dialogs.at(-1)?.detail).toMatch(detail);
    expect(await readTree(env.installed)).toEqual(OLD_FILES);
    expect(siblingsOfInstalled()).toEqual(['GTV Remote.app']);
    expect(tmpEntries()).toEqual([]);
  });

  it('runs codesign on the staged bundle on real macOS before removing quarantine', async () => {
    env.integration = false;
    if (originalPlatform)
      Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'darwin' });
    process.execPath = path.join(env.installed, 'Contents', 'MacOS', 'GTV Remote');
    const realFetch = globalThis.fetch;
    const fetched: string[] = [];
    vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
      fetched.push(input);
      return realFetch(input === GITHUB_LATEST ? `${serverUrl}/latest` : input, init);
    });
    const updater = await loadUpdater();

    const status = await installedVersionOf(updater, '2.3.0');

    expect(fetched[0]).toBe(GITHUB_LATEST);
    expect(status).toMatchObject({ stage: 'completed', relaunchRequired: true });
    const commands = env.native.map((operation) => operation.command);
    const codesign = env.native.find((operation) => operation.command === '/usr/bin/codesign');
    expect(codesign?.args.slice(0, 3)).toEqual(['--verify', '--deep', '--strict']);
    expect(codesign?.args[3]).toMatch(/\.GTV Remote\.app\.update-/);
    expect(commands.indexOf('/usr/bin/codesign')).toBeLessThan(commands.indexOf('xattr'));
    expect(await readTree(env.installed)).toEqual(bundleFiles('2.3.0'));
  });

  it('refuses a bundle that fails code signature verification on real macOS', async () => {
    env.integration = false;
    if (originalPlatform)
      Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'darwin' });
    process.execPath = path.join(env.installed, 'Contents', 'MacOS', 'GTV Remote');
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (input: string, init?: RequestInit) =>
      realFetch(input === GITHUB_LATEST ? `${serverUrl}/latest` : input, init)
    );
    env.failCommand = '/usr/bin/codesign';
    const updater = await loadUpdater();
    await updater.checkForUpdatesManually();
    env.dialogResponses.push(0);

    expect((await updater.installAvailableUpdate()).stage).toBe('failed');
    expect(env.dialogs.at(-1)?.detail).toMatch(/code signature verification/);
    expect(env.native.some((operation) => operation.command === 'xattr')).toBe(false);
    expect(await readTree(env.installed)).toEqual(OLD_FILES);
    expect(siblingsOfInstalled()).toEqual(['GTV Remote.app']);
  });
});

describe('install location preflight', () => {
  async function seedRollbackBackup() {
    await writeTree(rollbackBundle(), bundleFiles('2.1.0'));
    await fsPromises.writeFile(
      path.join(env.root, 'userData', 'updater-state.json'),
      JSON.stringify({
        rollbackVersion: '2.1.0',
        rollbackCreatedAt: '2026-10-01T00:00:00.000Z',
        rollbackBundleName: 'GTV Remote.app',
      })
    );
  }

  it('fails before downloading when the app folder is not writable and keeps the backup', async () => {
    await seedRollbackBackup();
    const realAccess = fsPromises.access.bind(fsPromises);
    vi.spyOn(fsPromises, 'access').mockImplementation(async (target, mode) => {
      if (String(target) === path.dirname(env.installed) && mode === fsConstants.W_OK) {
        throw Object.assign(new Error('EROFS'), { code: 'EROFS' });
      }
      await realAccess(target, mode);
    });
    const updater = await loadUpdater();
    await updater.checkForUpdatesManually();
    env.dialogResponses.push(0);

    const status = await updater.installAvailableUpdate();

    expect(status.stage).toBe('failed');
    expect(status.message).toContain(
      'Move GTV Remote to your Applications folder, then try again.'
    );
    expect(status).toMatchObject({ rollbackAvailable: true, rollbackVersion: '2.1.0' });
    expect(count('/asset')).toBe(0);
    expect(await readTree(rollbackBundle())).toEqual(bundleFiles('2.1.0'));
    expect(await readTree(env.installed)).toEqual(OLD_FILES);
  });

  it('fails before downloading when macOS translocated the app', async () => {
    env.installed = path.join(env.root, 'T', 'AppTranslocation', 'ABC123', 'd', 'GTV Remote.app');
    await writeTree(env.installed, OLD_FILES);
    const updater = await loadUpdater();
    await updater.checkForUpdatesManually();
    env.dialogResponses.push(0);

    const status = await updater.installAvailableUpdate();

    expect(status.stage).toBe('failed');
    expect(status.message).toMatch(/App Translocation.*Applications folder/);
    expect(count('/asset')).toBe(0);
  });
});

describe('pending relaunch', () => {
  it('after "Later", checks report the relaunch and nothing is re-offered or re-installed', async () => {
    const updater = await loadUpdater();
    await installedVersionOf(updater, '2.3.0');
    const events: UpdaterStatus[] = [];
    updater.subscribeUpdaterStatus((status) => events.push(status));
    const latestRequests = count('/latest');

    const manual = await updater.checkForUpdatesManually();
    const background = await updater.checkForUpdatesInBackground();
    const reinstall = await updater.installAvailableUpdate();

    expect(count('/latest')).toBe(latestRequests);
    expect(count('/asset')).toBe(1);
    for (const status of [manual, background, reinstall]) {
      expect(status).toMatchObject({
        relaunchRequired: true,
        installedVersion: '2.3.0',
        updateInstallable: false,
        message: 'Update 2.3.0 installed. Relaunch GTV Remote to finish.',
      });
    }
    expect(events.some((status) => status.stage === 'checking')).toBe(false);
    // The 2.2.0 backup is not replaced by a copy of the already-installed 2.3.0.
    expect(await readTree(rollbackBundle())).toEqual(OLD_FILES);
    expect(env.dialogs).toHaveLength(1);

    expect(updater.relaunchToFinishUpdate()).toBe(true);
    expect(env.relaunches).toBe(1);
  });

  it('relaunchToFinishUpdate does nothing when no relaunch is pending', async () => {
    const updater = await loadUpdater();
    expect(updater.relaunchToFinishUpdate()).toBe(false);
    expect(env.relaunches).toBe(0);
  });
});

describe('concurrency', () => {
  it('shares one in-flight install and answers checks during the download without check events', async () => {
    let releaseAsset!: () => void;
    const updater = await loadUpdater();
    release = { tag: 'v2.3.0', served: archive('2.3.0') };
    await updater.checkForUpdatesManually();
    release.holdAsset = new Promise<void>((resolve) => {
      releaseAsset = resolve;
    });
    const events: UpdaterStatus[] = [];
    updater.subscribeUpdaterStatus((status) => events.push(status));
    env.dialogResponses.push(1);

    const first = updater.installAvailableUpdate();
    const second = updater.installAvailableUpdate();
    await vi.waitFor(() => {
      expect(events.some((status) => (status.progressPercent ?? 0) > 0)).toBe(true);
    });
    const latestRequests = count('/latest');
    const eventsBefore = events.length;

    const during = [
      await updater.checkForUpdatesManually(),
      await updater.checkForUpdatesInBackground(),
      await updater.rollbackToPreviousVersion(),
      await updater.getUpdaterStatus(),
    ];

    expect(count('/latest')).toBe(latestRequests);
    expect(events.slice(eventsBefore)).toEqual([]);
    for (const status of during) {
      expect(status).toMatchObject({
        stage: 'downloading',
        inProgress: true,
        updateInstallable: true,
      });
    }

    releaseAsset();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ stage: 'completed', relaunchRequired: true });
    expect(count('/asset')).toBe(1);
    expect(env.dialogs.map((dialog) => dialog.buttons)).toEqual([['Relaunch now', 'Later']]);
  });
});

describe('background check debounce', () => {
  async function setup(fixture: Partial<ReleaseFixture>, state?: object) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    if (state) {
      await writeTree(path.join(env.root, 'userData'), {
        'updater-state.json': JSON.stringify(state),
      });
    }
    release = { tag: 'v2.3.0', served: archive('2.3.0'), ...fixture };
    return await loadUpdater();
  }

  it.each<[string, Partial<ReleaseFixture>, object | undefined]>([
    ['an up-to-date check', { tag: 'v2.2.0' }, undefined],
    ['a skipped-release check', {}, { skippedVersion: '2.3.0' }],
    ['a no-compatible-asset check', { assets: 'none' }, undefined],
    ['an update-available check', {}, undefined],
  ])('records the check time and waits 15 minutes after %s', async (_label, fixture, state) => {
    const updater = await setup(fixture, state);

    expect((await updater.checkForUpdatesInBackground()).lastCheckedAt).toBe(
      new Date(T0).toISOString()
    );
    vi.setSystemTime(T0 + 14 * MINUTE);
    await updater.checkForUpdatesInBackground();
    expect(count('/latest')).toBe(1);

    vi.setSystemTime(T0 + 16 * MINUTE);
    expect((await updater.checkForUpdatesInBackground()).lastCheckedAt).toBe(
      new Date(T0 + 16 * MINUTE).toISOString()
    );
    vi.setSystemTime(T0 + 17 * MINUTE);
    await updater.checkForUpdatesInBackground();
    expect(count('/latest')).toBe(2);

    // A manual check is always allowed.
    await updater.checkForUpdatesManually();
    expect(count('/latest')).toBe(3);
  });

  it('backs off for 5 minutes after a failed check', async () => {
    const updater = await setup({ latestStatus: 503 });

    expect((await updater.checkForUpdatesInBackground()).stage).toBe('failed');
    vi.setSystemTime(T0 + 4 * MINUTE);
    await updater.checkForUpdatesInBackground();
    expect(count('/latest')).toBe(1);
    vi.setSystemTime(T0 + 5 * MINUTE);
    await updater.checkForUpdatesInBackground();
    expect(count('/latest')).toBe(2);
  });

  it('treats "no release published yet" (404) as up to date, not a failure', async () => {
    const updater = await setup({ latestStatus: 404 });

    const status = await updater.checkForUpdatesInBackground();
    expect(status.stage).toBe('completed');
    expect(status.updateAvailable).not.toBe(true);
    expect(status.message).toMatch(/No releases have been published yet/);
    // A completed check waits the normal 15 minutes, not the 5-minute failure back-off.
    vi.setSystemTime(T0 + 6 * MINUTE);
    await updater.checkForUpdatesInBackground();
    expect(count('/latest')).toBe(1);
  });

  it('waits for the GitHub rate-limit reset after a rate-limited check', async () => {
    const updater = await setup({
      latestStatus: 403,
      latestHeaders: {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(Math.floor((T0 + 40 * MINUTE) / 1000)),
      },
    });

    expect((await updater.checkForUpdatesInBackground()).message).toMatch(/rate limit/);
    vi.setSystemTime(T0 + 10 * MINUTE);
    await updater.checkForUpdatesInBackground();
    expect(count('/latest')).toBe(1);
    vi.setSystemTime(T0 + 40 * MINUTE);
    await updater.checkForUpdatesInBackground();
    expect(count('/latest')).toBe(2);
  });
});

describe('rollback', () => {
  it('a failed copy keeps everything; a retry swaps the backup back into place', async () => {
    const updater = await loadUpdater();
    await installedVersionOf(updater, '2.3.0');

    env.failCommand = 'ditto';
    env.dialogResponses.push(0);
    const failed = await updater.rollbackToPreviousVersion();
    expect(failed).toMatchObject({ stage: 'failed', inProgress: false, rollbackAvailable: true });
    expect(failed.message).toMatch(/rollback failed/i);
    expect(await readTree(env.installed)).toEqual(bundleFiles('2.3.0'));
    expect(await readTree(rollbackBundle())).toEqual(OLD_FILES);
    expect(siblingsOfInstalled()).toEqual(['GTV Remote.app']);

    env.failCommand = undefined;
    env.dialogResponses.push(0, 1);
    const restored = await updater.rollbackToPreviousVersion();
    expect(restored).toMatchObject({
      stage: 'completed',
      inProgress: false,
      rollbackAvailable: false,
      relaunchRequired: true,
      installedVersion: '2.2.0',
      message: 'Rolled back to 2.2.0. Relaunch GTV Remote to finish.',
    });
    expect(await readTree(env.installed)).toEqual(OLD_FILES);
    expect(siblingsOfInstalled()).toEqual(['GTV Remote.app']);
    expect(existsSync(rollbackBundle())).toBe(false);

    const latestRequests = count('/latest');
    await updater.checkForUpdatesManually();
    expect(count('/latest')).toBe(latestRequests);
  });
});
