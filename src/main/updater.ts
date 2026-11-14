import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { app, BrowserWindow, shell } from 'electron';

import { getRuntimeConfig } from '../backend/core/runtimeConfig';
import {
  hiddenSiblingPath,
  moveDirectory,
  swapBundleIntoPlace,
  type BundleFileOps,
} from '../backend/updater/bundleSwap';
import { shouldRunBackgroundCheck, type CheckAttempt } from '../backend/updater/checkSchedule';
import {
  assertInstallLocationWritable,
  UpdaterUserError,
} from '../backend/updater/installLocation';
import {
  assertBundleMatches,
  DownloadVerifier,
  parseSha256Digest,
  readBundleMetadata,
  type BundleMetadata,
  type DownloadDigest,
  type ExpectedDownload,
} from '../backend/updater/integrity';
import { latestReleaseApiUrl } from '../backend/updater/releaseSource';
import {
  applyUpdaterEvent,
  createInitialUpdaterStatus,
  type UpdaterEvent,
} from '../backend/updater/updaterStatus';
import {
  compareVersions,
  findBestMacAsset,
  formatMinutesUntil,
  isDmgAsset,
  normalizeVersion,
} from '../backend/updater/version';
import type { UpdaterStatus } from '../shared/types';

import {
  assertIntegrationPath,
  assertLoopbackUrl,
  integrationEnvironment,
  relaunchUpdatedApp,
  runNativeCommand,
  showMessageBox,
  updaterTemporaryDirectory,
  updaterVersion,
} from './integrationEnvironment';
import { getAppDataPath, logError, logInfo } from './logger';

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
  /** GitHub's `"sha256:<hex>"` digest of the asset. */
  digest?: string | null;
}

interface ReleasePayload {
  tag_name: string;
  html_url: string;
  assets: ReleaseAsset[];
}

interface UpdateState {
  skippedVersion?: string;
  rollbackVersion?: string;
  rollbackCreatedAt?: string;
  rollbackBundleName?: string;
}

/** An install or rollback; at most one runs at a time. */
interface UpdaterOperation {
  kind: 'install' | 'rollback';
  promise: Promise<UpdaterStatus>;
}

/** The bundle on disk was replaced; the running process is the previous version until relaunch. */
interface PendingRelaunch {
  version: string;
  reason: 'update' | 'rollback';
}

const CHECK_TIMEOUT_MS = 15_000;
const ROLLBACK_DIR_NAME = 'rollback';
const CODESIGN_PATH = '/usr/bin/codesign';
const PLUTIL_PATH = '/usr/bin/plutil';

let cachedRelease: ReleasePayload | undefined;
let cachedAsset: ReleaseAsset | undefined;
let activeCheck: Promise<void> | undefined;
let activeOperation: UpdaterOperation | undefined;
let pendingRelaunch: PendingRelaunch | undefined;
let lastCheckAttempt: CheckAttempt | undefined;

const updaterStatus: UpdaterStatus = createInitialUpdaterStatus(updaterVersion());

/**
 * Subscribers receive a fresh snapshot of `UpdaterStatus` every time the
 * status changes. Registered by `subscribeUpdaterStatus` and called
 * synchronously from `dispatchUpdaterEvent`, which pushes the status to the
 * renderer over IPC.
 */
type UpdaterStatusListener = (status: UpdaterStatus) => void;
const updaterStatusListeners = new Set<UpdaterStatusListener>();

/** Snapshot the current status. Defensive copy so callers cannot mutate. */
function snapshotUpdaterStatus(): UpdaterStatus {
  return { ...updaterStatus, currentVersion: updaterVersion() };
}

/**
 * Subscribe to updater status changes. Returns an unsubscribe function.
 * Listeners receive a defensive copy of the status on every change.
 */
export function subscribeUpdaterStatus(listener: UpdaterStatusListener): () => void {
  updaterStatusListeners.add(listener);
  return () => {
    updaterStatusListeners.delete(listener);
  };
}

/**
 * All status transitions go through the pure `applyUpdaterEvent` reducer in
 * src/backend/updater/updaterStatus.ts; this applies the result and fans it
 * out to listeners.
 */
function dispatchUpdaterEvent(event: UpdaterEvent) {
  const next = applyUpdaterEvent(updaterStatus, event, updaterVersion());
  Object.assign(updaterStatus, next);
  publishUpdaterStatus();
}

function publishUpdaterStatus() {
  const snapshot = snapshotUpdaterStatus();
  for (const listener of updaterStatusListeners) {
    try {
      listener(snapshot);
    } catch (error) {
      // Listener errors must never affect the update flow. We log and move on.
      void logError('updater', 'Updater status listener threw', { error });
    }
  }
}

function getDialogParentWindow(): BrowserWindow | undefined {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) {
    return focused;
  }

  const visible = BrowserWindow.getAllWindows().find(
    (window) => !window.isDestroyed() && window.isVisible()
  );
  if (visible) {
    return visible;
  }

  const anyWindow = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed());
  return anyWindow;
}

async function showUpdaterDialog(
  options: Electron.MessageBoxOptions
): Promise<Electron.MessageBoxReturnValue> {
  const parent = getDialogParentWindow();
  if (parent) {
    // Bring window forward so the user actually sees the modal even when the dock is hidden.
    if (!parent.isVisible()) {
      parent.show();
    }
    parent.focus();
    return await showMessageBox(options, parent);
  }

  return await showMessageBox(options);
}

function isDevModeOverride(): boolean {
  return !integrationEnvironment && getRuntimeConfig().devUpdaterEnabled && !app.isPackaged;
}

/** Real macOS only: the integration sandbox has no signed bundles and no codesign. */
function nativeSignatureVerificationEnabled(): boolean {
  return process.platform === 'darwin' && !integrationEnvironment;
}

function uniqueStamp(): string {
  return `${String(Date.now())}-${randomBytes(4).toString('hex')}`;
}

// ── persisted updater state ─────────────────────────────────────────────────

async function readUpdateState(): Promise<UpdateState> {
  const statePath = getAppDataPath('updater-state.json');
  try {
    const raw = await fs.readFile(statePath, 'utf8');
    return JSON.parse(raw) as UpdateState;
  } catch {
    return {};
  }
}

async function writeUpdateState(state: UpdateState) {
  const statePath = getAppDataPath('updater-state.json');
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
}

function getRollbackDirPath() {
  return getAppDataPath(ROLLBACK_DIR_NAME);
}

function getRollbackBundlePath(state: UpdateState) {
  if (!state.rollbackBundleName) {
    return undefined;
  }

  const bundlePath = path.join(getRollbackDirPath(), state.rollbackBundleName);
  assertIntegrationPath(bundlePath);
  return bundlePath;
}

async function rollbackBundleExists(state: UpdateState) {
  const rollbackBundlePath = getRollbackBundlePath(state);
  if (!rollbackBundlePath) {
    return false;
  }

  try {
    const stats = await fs.stat(rollbackBundlePath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

function withoutRollbackState(state: UpdateState): UpdateState {
  const nextState = { ...state };
  delete nextState.rollbackVersion;
  delete nextState.rollbackCreatedAt;
  delete nextState.rollbackBundleName;
  return nextState;
}

async function clearRollbackBackup(state?: UpdateState) {
  const stateToPersist = state ?? (await readUpdateState());
  await removePathRecursive(getRollbackDirPath()).catch(() => {
    // best-effort
  });
  await writeUpdateState(withoutRollbackState(stateToPersist));
  dispatchUpdaterEvent({ type: 'rollback-availability-changed', available: false });
}

// ── bundle metadata ─────────────────────────────────────────────────────────

async function readInfoPlist(bundlePath: string): Promise<string> {
  const plistPath = path.join(bundlePath, 'Contents', 'Info.plist');
  assertIntegrationPath(plistPath);
  const raw = await fs.readFile(plistPath);
  if (
    raw.subarray(0, 6).toString('latin1') === 'bplist' &&
    process.platform === 'darwin' &&
    !integrationEnvironment
  ) {
    // Binary property lists are converted by the system tool rather than parsed here.
    const { stdout } = await promisify(execFile)(
      PLUTIL_PATH,
      ['-convert', 'xml1', '-o', '-', plistPath],
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }
    );
    return stdout;
  }
  return raw.toString('utf8');
}

async function readBundleInfo(bundlePath: string): Promise<BundleMetadata> {
  return readBundleMetadata(await readInfoPlist(bundlePath));
}

async function readBundleInfoOrEmpty(bundlePath: string): Promise<BundleMetadata> {
  try {
    return await readBundleInfo(bundlePath);
  } catch {
    return {};
  }
}

/** The identifier every replacement bundle must carry: the installed (running) app's. */
async function readInstalledBundleIdentifier(targetBundle: string): Promise<string> {
  const { identifier } = await readBundleInfoOrEmpty(targetBundle);
  if (!identifier) {
    throw new Error(
      `Could not read the bundle identifier of the installed app at "${targetBundle}"; refusing to replace it.`
    );
  }
  return identifier;
}

/**
 * Look for a stray rollback bundle on disk that isn't referenced by update-state.json
 * and recover its metadata. This heals state when a previous install partially
 * cleared metadata (older buggy code paths) while leaving a perfectly good backup
 * on disk, so the user doesn't lose access to the rollback action.
 */
async function recoverOrphanedRollbackState(state: UpdateState): Promise<UpdateState> {
  const rollbackDir = getRollbackDirPath();
  let entries: string[];
  try {
    entries = await fs.readdir(rollbackDir);
  } catch {
    return state;
  }

  const bundle = entries.find((name) => name.toLowerCase().endsWith('.app'));
  if (!bundle) {
    return state;
  }

  const bundlePath = path.join(rollbackDir, bundle);
  try {
    const stats = await fs.stat(bundlePath);
    if (!stats.isDirectory()) {
      return state;
    }

    const recoveredVersion = (await readBundleInfoOrEmpty(bundlePath)).version;
    const recoveredState: UpdateState = {
      ...state,
      rollbackBundleName: bundle,
      rollbackVersion: recoveredVersion ?? state.rollbackVersion ?? 'unknown',
      rollbackCreatedAt: state.rollbackCreatedAt ?? stats.mtime.toISOString(),
    };

    await writeUpdateState(recoveredState).catch(() => {
      // ignore — we'll still surface the rollback in-memory
    });
    await logInfo('updater', 'Recovered orphaned rollback backup', {
      bundlePath,
      version: recoveredState.rollbackVersion,
    });
    return recoveredState;
  } catch {
    return state;
  }
}

async function syncRollbackStatus() {
  let state = await readUpdateState();

  if (!state.rollbackVersion || !state.rollbackBundleName) {
    state = await recoverOrphanedRollbackState(state);
  }

  const available =
    Boolean(state.rollbackVersion && state.rollbackCreatedAt) &&
    (await rollbackBundleExists(state));

  if (!available) {
    // no rollback bundle found -> clear metadata
    dispatchUpdaterEvent({ type: 'rollback-availability-changed', available: false });
    return state;
  }

  // rollback bundle confirmed -> announce availability
  dispatchUpdaterEvent({
    type: 'rollback-availability-changed',
    available: true,
    version: state.rollbackVersion,
    createdAt: state.rollbackCreatedAt,
  });
  return state;
}

// ── GitHub release lookup ───────────────────────────────────────────────────

class GitHubRateLimitError extends Error {
  constructor(
    message: string,
    readonly retryNotBefore?: number
  ) {
    super(message);
    this.name = 'GitHubRateLimitError';
  }
}

/** GitHub answered 404, e.g. for /releases/latest before any release is published. */
class GitHubNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubNotFoundError';
  }
}

async function requestJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  if (integrationEnvironment) assertLoopbackUrl(url);
  const timeout = setTimeout(() => {
    controller.abort();
  }, CHECK_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'gtv-desktop-remote-updater',
      },
      ...(integrationEnvironment ? { redirect: 'error' as const } : {}),
      signal: controller.signal,
    });

    if (!response.ok) {
      const remaining = response.headers.get('x-ratelimit-remaining');
      const resetHeader = response.headers.get('x-ratelimit-reset');
      const retryAfter = response.headers.get('retry-after');

      if ((response.status === 403 && remaining === '0') || response.status === 429) {
        const resetSeconds = Number.parseInt(resetHeader ?? '', 10);
        const retryAfterSeconds = Number.parseInt(retryAfter ?? '', 10);
        const when = Number.isFinite(resetSeconds)
          ? formatMinutesUntil(resetSeconds)
          : Number.isFinite(retryAfterSeconds)
            ? `in about ${String(retryAfterSeconds)} seconds`
            : 'shortly';
        const retryNotBefore = Number.isFinite(resetSeconds)
          ? resetSeconds * 1_000
          : Number.isFinite(retryAfterSeconds)
            ? Date.now() + retryAfterSeconds * 1_000
            : undefined;
        throw new GitHubRateLimitError(
          `GitHub API rate limit reached for this network. Please try again ${when}.`,
          retryNotBefore
        );
      }

      if (response.status === 404) {
        throw new GitHubNotFoundError(`GitHub API returned 404 for ${url}`);
      }
      throw new Error(`GitHub API failed: ${String(response.status)} ${response.statusText}`);
    }

    return (await response.json()) as T;
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      throw new Error('Update check timed out. Check your internet connection and try again.', {
        cause: error,
      });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function assertReleasePayload(release: unknown): asserts release is ReleasePayload {
  if (
    !isRecord(release) ||
    typeof release.tag_name !== 'string' ||
    !Array.isArray(release.assets) ||
    !release.assets.every(
      (asset: unknown) =>
        isRecord(asset) &&
        typeof asset.name === 'string' &&
        typeof asset.browser_download_url === 'string'
    )
  ) {
    throw new Error('GitHub returned an unexpected release response.');
  }
}

function getBundlePathFromExecPath() {
  return (
    integrationEnvironment?.updater?.installedBundlePath ??
    path.resolve(process.execPath, '..', '..', '..')
  );
}

// ── file operations ─────────────────────────────────────────────────────────

/**
 * Best-effort recursive delete that works reliably for macOS .app bundles
 * (Node's fs.rm({ recursive: true }) intermittently throws ENOTEMPTY on Resources
 * directories that contain symlinks, framework hard links, etc.). We try the
 * native API first and fall back to shelling out to `rm -rf`.
 */
async function removePathRecursive(target: string): Promise<void> {
  assertIntegrationPath(target);
  try {
    await fs.rm(target, { force: true, recursive: true });
    return;
  } catch (primaryError) {
    try {
      await runNativeCommand('rm', ['-rf', target]);
    } catch {
      // Re-throw the original Node error so callers see the real reason.
      throw primaryError;
    }
  }
}

/**
 * Renames happen in Node (same-volume, atomic); copies go through `ditto`,
 * which preserves symlinks, extended attributes and code signatures. In the
 * integration sandbox every path is checked against the isolated profile.
 */
const bundleFileOps: BundleFileOps = {
  async rename(from, to) {
    assertIntegrationPath(from);
    assertIntegrationPath(to);
    await fs.rename(from, to);
  },
  async copyDirectory(from, to) {
    await runNativeCommand('ditto', [from, to]);
  },
  async remove(target) {
    await removePathRecursive(target);
  },
};

async function canWrite(target: string): Promise<boolean> {
  try {
    await fs.access(target, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Turn the bundle that was moved aside by an install into the rollback backup.
 * It is moved (or copied, across volumes) into a staging folder, which then
 * replaces the previous rollback folder. Never throws: the update itself has
 * already been installed, so a failure here only keeps the older backup.
 */
async function preserveRollbackBackup(asideBundle: string, bundleName: string): Promise<void> {
  const rollbackDir = getRollbackDirPath();
  const stamp = uniqueStamp();
  const stagingDir = `${rollbackDir}.new-${stamp}`;
  const stagingBundlePath = path.join(stagingDir, bundleName);
  const previousRollbackDir = `${rollbackDir}.prev-${stamp}`;

  try {
    const state = await readUpdateState();
    // Label the backup with the version it actually contains.
    const rollbackVersion =
      (await readBundleInfoOrEmpty(asideBundle)).version ?? normalizeVersion(updaterVersion());
    const rollbackCreatedAt = new Date().toISOString();

    await logInfo('updater', 'Preserving previous version for rollback', {
      sourceBundle: asideBundle,
      rollbackBundlePath: path.join(rollbackDir, bundleName),
      rollbackVersion,
    });

    try {
      await removePathRecursive(stagingDir);
      await fs.mkdir(stagingDir, { recursive: true });
      await moveDirectory(bundleFileOps, asideBundle, stagingBundlePath);
    } catch (error) {
      await logError(
        'updater',
        'Failed to stage rollback backup; preserving previous rollback (if any)',
        error
      );
      await removePathRecursive(stagingDir).catch(() => {
        // ignore staging cleanup failure
      });
      await syncRollbackStatus();
      return;
    }

    // Swap the staged backup in place of the existing one.
    let movedExisting = false;
    try {
      await bundleFileOps.rename(rollbackDir, previousRollbackDir);
      movedExisting = true;
    } catch (error) {
      // ENOENT just means there was no previous rollback dir — fine to proceed.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    try {
      await bundleFileOps.rename(stagingDir, rollbackDir);
    } catch (swapError) {
      if (movedExisting) {
        await bundleFileOps.rename(previousRollbackDir, rollbackDir).catch(() => {
          // best-effort restore
        });
      }
      throw swapError;
    }

    if (movedExisting) {
      await removePathRecursive(previousRollbackDir).catch(() => {
        // ignore deletion of the now-superseded prior backup
      });
    }

    await writeUpdateState({
      ...state,
      rollbackVersion,
      rollbackCreatedAt,
      rollbackBundleName: bundleName,
    });
    dispatchUpdaterEvent({
      type: 'rollback-availability-changed',
      available: true,
      version: rollbackVersion,
      createdAt: rollbackCreatedAt,
    });
  } catch (error) {
    await logError(
      'updater',
      'Failed to swap in new rollback backup; existing rollback (if any) preserved',
      error
    ).catch(() => undefined);
    await removePathRecursive(stagingDir).catch(() => {
      // ignore
    });
    await syncRollbackStatus().catch(() => undefined);
  } finally {
    // Never leave the replaced bundle hidden next to the installed app.
    await removePathRecursive(asideBundle).catch(() => {
      // ignore
    });
  }
}

// ── install ─────────────────────────────────────────────────────────────────

interface InstallFromZipOptions {
  zipPath: string;
  unpackDir: string;
  targetBundle: string;
  version: string;
  devModeOverride: boolean;
}

/**
 * Extract and verify the downloaded bundle, stage it beside the installed app,
 * then swap it into place (restoring the original on failure). The replaced
 * bundle becomes the rollback backup.
 */
async function installMacUpdateFromZip(options: InstallFromZipOptions) {
  const { zipPath, unpackDir, targetBundle, version, devModeOverride } = options;
  assertIntegrationPath(unpackDir);
  await fs.mkdir(unpackDir, { recursive: true });

  await runNativeCommand('ditto', ['-x', '-k', zipPath, unpackDir]);

  const entries = await fs.readdir(unpackDir, { withFileTypes: true });
  const appDirs = entries.filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'));
  const appDir = appDirs.at(0);
  if (!appDir) {
    throw new Error('Downloaded archive did not contain an .app bundle');
  }
  if (appDirs.length > 1) {
    throw new Error('Downloaded archive contained more than one .app bundle');
  }

  const sourceBundle = path.join(unpackDir, appDir.name);
  await logInfo('updater', 'Installing update bundle', { sourceBundle, targetBundle });

  if (devModeOverride) {
    await logInfo('updater', 'Dev mode update install skipped', { sourceBundle, targetBundle });
    return;
  }

  const expected = { identifier: await readInstalledBundleIdentifier(targetBundle), version };
  assertBundleMatches(await readBundleInfo(sourceBundle), expected);

  const stamp = uniqueStamp();
  const staged = hiddenSiblingPath(targetBundle, 'update', stamp);
  const aside = hiddenSiblingPath(targetBundle, 'previous', stamp);

  try {
    await bundleFileOps.remove(staged);
    await bundleFileOps.copyDirectory(sourceBundle, staged);
    assertBundleMatches(await readBundleInfo(staged), expected);

    if (nativeSignatureVerificationEnabled()) {
      try {
        // Ad-hoc signatures still seal every file, so this detects tampering or corruption.
        await runNativeCommand(CODESIGN_PATH, ['--verify', '--deep', '--strict', staged]);
      } catch (error) {
        throw new Error(
          `The downloaded app failed code signature verification: ${(error as Error).message}`,
          { cause: error }
        );
      }
    }

    // Only a verified bundle loses its quarantine flag.
    await runNativeCommand('xattr', ['-dr', 'com.apple.quarantine', staged]);
    await swapBundleIntoPlace(bundleFileOps, { target: targetBundle, staged, aside });
    pendingRelaunch = { version, reason: 'update' };
  } finally {
    // No-op after a successful swap; removes a partial or rejected stage otherwise.
    await bundleFileOps.remove(staged).catch(() => {
      // ignore cleanup failure
    });
  }

  await preserveRollbackBackup(aside, path.basename(targetBundle));
}

async function writeFully(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
    offset += bytesWritten;
  }
}

/**
 * Stream `url` to `destinationPath`, hashing and counting bytes as they arrive.
 * With `expected`, the file only appears at `destinationPath` when its size and
 * SHA-256 match; otherwise this throws and the partial file is removed.
 */
export async function downloadFile(
  url: string,
  destinationPath: string,
  onProgress: (downloadedBytes: number, totalBytes: number) => void,
  expected?: ExpectedDownload
): Promise<DownloadDigest> {
  if (integrationEnvironment) assertLoopbackUrl(url);
  assertIntegrationPath(destinationPath);
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'gtv-desktop-remote-updater',
      Accept: 'application/octet-stream',
    },
    ...(integrationEnvironment ? { redirect: 'error' as const } : {}),
  });

  if (!response.ok || !response.body) {
    throw new Error(`Failed to download update: ${String(response.status)} ${response.statusText}`);
  }

  const totalBytes =
    expected?.size ?? (Number.parseInt(response.headers.get('content-length') ?? '0', 10) || 0);
  const partialPath = `${destinationPath}.partial-${randomBytes(4).toString('hex')}`;
  assertIntegrationPath(partialPath);
  const verifier = new DownloadVerifier(expected);
  const reader = response.body.getReader();
  let handle: FileHandle | undefined;
  let completed = false;

  try {
    handle = await fs.open(partialPath, 'wx', 0o600);
    for (;;) {
      const nextChunk = await reader.read();
      if (nextChunk.done) break;

      verifier.update(nextChunk.value);
      await writeFully(handle, nextChunk.value);
      onProgress(verifier.receivedBytes, totalBytes);
    }
    await handle.close();
    handle = undefined;

    const digest = verifier.finish();
    assertIntegrationPath(destinationPath);
    await fs.rename(partialPath, destinationPath);
    completed = true;
    return digest;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
    if (!completed) {
      await fs.rm(partialPath, { force: true }).catch(() => undefined);
    }
  }
}

/** Size and digest the download must match; refuses assets GitHub has not hashed. */
function expectedDownloadFor(asset: ReleaseAsset): ExpectedDownload {
  const sha256 = parseSha256Digest(asset.digest);
  if (!sha256) {
    throw new UpdaterUserError(
      `The release file ${asset.name} has no SHA-256 digest, so the download can't be verified. Download the update from the releases page instead.`
    );
  }
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0) {
    throw new UpdaterUserError(
      `The release file ${asset.name} does not report a valid size, so the download can't be verified. Download the update from the releases page instead.`
    );
  }
  return { size: asset.size, sha256 };
}

function safeArchiveName(name: string): string {
  const base = path.basename(name).replace(/[^\w.\- ]/g, '_');
  return base && !/^\.+$/.test(base) ? base : 'update.zip';
}

async function createUpdateWorkDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(updaterTemporaryDirectory(), 'gtv-update-'));
  assertIntegrationPath(directory);
  return directory;
}

async function downloadAndInstall(
  asset: ReleaseAsset,
  version: string,
  targetBundle: string,
  devModeOverride: boolean
) {
  const expected = expectedDownloadFor(asset);
  const workDir = await createUpdateWorkDirectory();
  try {
    const zipPath = path.join(workDir, safeArchiveName(asset.name));

    dispatchUpdaterEvent({
      type: 'download-started',
      latestVersion: version,
      message: `Downloading update ${version}...`,
    });

    const downloadStartTime = Date.now();
    await downloadFile(
      asset.browser_download_url,
      zipPath,
      (downloadedBytes, totalBytes) => {
        const elapsedSeconds = Math.max(1, (Date.now() - downloadStartTime) / 1000);
        const bytesPerSecond = downloadedBytes / elapsedSeconds;
        const remainingBytes = Math.max(0, totalBytes - downloadedBytes);
        const etaSeconds =
          bytesPerSecond > 0 && totalBytes > 0
            ? Math.ceil(remainingBytes / bytesPerSecond)
            : undefined;
        const progressPercent =
          totalBytes > 0
            ? Math.min(100, Math.floor((downloadedBytes / totalBytes) * 100))
            : undefined;

        dispatchUpdaterEvent({
          type: 'download-progress',
          latestVersion: version,
          progressPercent,
          etaSeconds,
        });
      },
      expected
    );

    dispatchUpdaterEvent({
      type: 'install-started',
      message: 'Installing update...',
    });

    await installMacUpdateFromZip({
      zipPath,
      unpackDir: path.join(workDir, 'unpack'),
      targetBundle,
      version,
      devModeOverride,
    });
  } finally {
    // Removes the downloaded ZIP and the extracted bundle on every path.
    await removePathRecursive(workDir).catch(async (error: unknown) => {
      await logError('updater', 'Failed to remove update work directory', { workDir, error });
    });
  }
}

// ── checks ──────────────────────────────────────────────────────────────────

async function checkForMacUpdate() {
  dispatchUpdaterEvent({ type: 'check-started' });

  const updatesAllowed = integrationEnvironment
    ? Boolean(integrationEnvironment.updater)
    : app.isPackaged || getRuntimeConfig().devUpdaterEnabled;

  if (!updatesAllowed) {
    await logInfo('updater', 'Skipping updater in development mode');
    dispatchUpdaterEvent({
      type: 'message',
      message: 'Update checks are disabled in development mode. Set GTV_UPDATER_DEV=1 to test.',
    });
    return;
  }

  if (process.platform !== 'darwin' && !integrationEnvironment?.updater) {
    dispatchUpdaterEvent({
      type: 'message',
      message: `Updates are not configured for ${process.platform}.`,
    });
    return;
  }

  const releaseUrl = integrationEnvironment?.updater?.releaseApiUrl ?? latestReleaseApiUrl();
  let release: unknown;
  try {
    release = await requestJson<unknown>(releaseUrl);
  } catch (error) {
    if (!(error instanceof GitHubNotFoundError)) throw error;
    // GitHub answers 404 for /releases/latest until the first release is
    // published (it would also do so for a wrong repository, hence the log).
    await logInfo('updater', 'No published release found; treating as up to date', {
      url: releaseUrl,
    });
    const currentVersion = normalizeVersion(updaterVersion());
    cachedRelease = undefined;
    cachedAsset = undefined;
    dispatchUpdaterEvent({
      type: 'check-completed-no-update',
      latestVersion: currentVersion,
      lastCheckedAt: new Date().toISOString(),
      message: `No releases have been published yet. You're on ${currentVersion}.`,
    });
    return;
  }
  assertReleasePayload(release);

  const latestVersion = normalizeVersion(release.tag_name);
  const currentVersion = normalizeVersion(updaterVersion());
  // Every completed path records the check time (used for display and debounce).
  const lastCheckedAt = new Date().toISOString();

  if (compareVersions(latestVersion, currentVersion) <= 0) {
    cachedRelease = undefined;
    cachedAsset = undefined;
    dispatchUpdaterEvent({
      type: 'check-completed-no-update',
      latestVersion,
      lastCheckedAt,
      message: `You're up to date (${currentVersion}).`,
    });
    return;
  }

  const state = await readUpdateState();
  if (state.skippedVersion && normalizeVersion(state.skippedVersion) === latestVersion) {
    cachedRelease = undefined;
    cachedAsset = undefined;
    dispatchUpdaterEvent({
      type: 'check-completed-no-update',
      latestVersion,
      lastCheckedAt,
      message: `Update ${latestVersion} was skipped.`,
    });
    return;
  }

  const selectedAsset = findBestMacAsset(release.assets);
  if (!selectedAsset) {
    cachedRelease = undefined;
    cachedAsset = undefined;
    dispatchUpdaterEvent({
      type: 'check-completed-no-asset',
      latestVersion,
      lastCheckedAt,
      message: `Release ${latestVersion} has no compatible macOS asset.`,
    });
    return;
  }

  cachedRelease = release;
  cachedAsset = selectedAsset;
  dispatchUpdaterEvent({
    type: 'check-completed-update-available',
    latestVersion,
    lastCheckedAt,
    installable: true,
    message: `Update ${latestVersion} is available.`,
  });
}

/** Runs one check, shared by every caller that arrives while it is in flight. Never rejects. */
function runCheck(): Promise<void> {
  activeCheck ??= (async () => {
    try {
      await checkForMacUpdate();
      lastCheckAttempt = { at: Date.now(), ok: true };
    } catch (error) {
      lastCheckAttempt = {
        at: Date.now(),
        ok: false,
        ...(error instanceof GitHubRateLimitError && error.retryNotBefore !== undefined
          ? { retryNotBefore: error.retryNotBefore }
          : {}),
      };
      dispatchUpdaterEvent({
        type: 'check-failed',
        message: (error as Error).message || 'Update check failed. See logs for details.',
      });
      await logError('updater', 'Update check failed', error).catch(() => undefined);
    } finally {
      activeCheck = undefined;
    }
  })();
  return activeCheck;
}

/**
 * Checks must not run while a download/install/rollback is in flight (their
 * events would clear `inProgress` and re-enable install mid-operation), nor
 * after the bundle was replaced but the app has not relaunched (the running
 * version would make the just-installed release look new again).
 */
function checksSuspended(): boolean {
  return activeOperation !== undefined || pendingRelaunch !== undefined;
}

export async function checkForUpdatesInBackground() {
  if (checksSuspended()) {
    return await getUpdaterStatus();
  }

  if (!activeCheck && !shouldRunBackgroundCheck(lastCheckAttempt, Date.now())) {
    return await getUpdaterStatus();
  }

  await runCheck();
  return await getUpdaterStatus();
}

export async function checkForUpdatesManually() {
  if (checksSuspended()) {
    return await getUpdaterStatus();
  }

  await runCheck();
  return await getUpdaterStatus();
}

// ── operations ──────────────────────────────────────────────────────────────

function startOperation(
  kind: UpdaterOperation['kind'],
  run: () => Promise<UpdaterStatus>
): Promise<UpdaterStatus> {
  const promise = (async () => {
    try {
      return await run();
    } finally {
      activeOperation = undefined;
    }
  })();
  activeOperation = { kind, promise };
  return promise;
}

/** Status for the end of an operation; the rollback folder is quiescent here. */
async function settledStatus(): Promise<UpdaterStatus> {
  await syncRollbackStatus();
  return snapshotUpdaterStatus();
}

async function performInstall(): Promise<UpdaterStatus> {
  // A check that was already running must finish before its result is used.
  if (activeCheck) await activeCheck;
  if (pendingRelaunch) return snapshotUpdaterStatus();

  const asset = cachedAsset;
  const version = updaterStatus.latestVersion;
  if (!cachedRelease || !asset || !version) {
    dispatchUpdaterEvent({
      type: 'check-failed',
      message: 'No installable update is currently available.',
    });
    return await settledStatus();
  }

  if (isDmgAsset(asset)) {
    if (integrationEnvironment) {
      assertLoopbackUrl(asset.browser_download_url);
      await runNativeCommand('open', [asset.browser_download_url]);
    } else {
      await shell.openExternal(asset.browser_download_url);
    }
    await showUpdaterDialog({
      type: 'info',
      buttons: ['OK'],
      defaultId: 0,
      title: 'Manual install',
      message: 'DMG opened in your browser.',
      detail:
        'Open the DMG, drag the app to Applications, then if macOS blocks launch use Privacy & Security > Open Anyway.',
    });
    return await settledStatus();
  }

  const devModeOverride = isDevModeOverride();
  const targetBundle = getBundlePathFromExecPath();

  try {
    if (!devModeOverride) {
      // Fail before downloading anything, and before touching the rollback backup.
      await assertInstallLocationWritable(targetBundle, canWrite);
    }

    await downloadAndInstall(asset, version, targetBundle, devModeOverride);

    cachedRelease = undefined;
    cachedAsset = undefined;
    dispatchUpdaterEvent({
      type: 'install-completed',
      latestVersion: version,
      ...(devModeOverride
        ? { message: 'Dev mode: install step skipped.' }
        : { relaunchRequired: true }),
    });

    if (devModeOverride) {
      await showUpdaterDialog({
        type: 'info',
        buttons: ['OK'],
        defaultId: 0,
        title: 'Dev updater test',
        message: 'Download/install flow completed in dev mode.',
        detail: 'Relaunch is skipped in development override mode.',
      });
      return await settledStatus();
    }

    const relaunchChoice = await showUpdaterDialog({
      type: 'info',
      buttons: ['Relaunch now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update installed',
      message: `Version ${version} was installed.`,
      detail: 'Relaunch to start the updated app.',
    });

    if (relaunchChoice.response === 0) {
      relaunchUpdatedApp();
    }
  } catch (error) {
    await logError('updater', 'Automatic update installation failed', error).catch(() => undefined);
    cachedRelease = undefined;
    cachedAsset = undefined;
    dispatchUpdaterEvent({
      type: 'install-failed',
      message:
        error instanceof UpdaterUserError
          ? error.message
          : `Update ${version} failed during download or install. Please try again.`,
    });
    await showUpdaterDialog({
      type: 'warning',
      buttons: ['OK'],
      defaultId: 0,
      title: 'Update failed',
      message: `Update ${version} could not be installed.`,
      detail: (error as Error).message || 'See logs for details.',
    });
  }

  return await settledStatus();
}

export async function installAvailableUpdate(): Promise<UpdaterStatus> {
  if (activeOperation) {
    // A second click joins the running install instead of racing it.
    return activeOperation.kind === 'install'
      ? await activeOperation.promise
      : await getUpdaterStatus();
  }
  if (pendingRelaunch) {
    return await getUpdaterStatus();
  }
  return await startOperation('install', performInstall);
}

/** Swap the rollback backup into place using the same staged rename as an install. */
async function restoreRollbackBundle(rollbackBundlePath: string, targetBundle: string) {
  await assertInstallLocationWritable(targetBundle, canWrite);
  const identifier = await readInstalledBundleIdentifier(targetBundle);
  assertBundleMatches(await readBundleInfoOrEmpty(rollbackBundlePath), { identifier }, 'Backup');

  const stamp = uniqueStamp();
  const staged = hiddenSiblingPath(targetBundle, 'rollback', stamp);
  const aside = hiddenSiblingPath(targetBundle, 'previous', stamp);

  try {
    await bundleFileOps.remove(staged);
    // Copy, so the backup survives if anything below fails.
    await bundleFileOps.copyDirectory(rollbackBundlePath, staged);
    await runNativeCommand('xattr', ['-dr', 'com.apple.quarantine', staged]);
    await swapBundleIntoPlace(bundleFileOps, { target: targetBundle, staged, aside });
  } finally {
    await bundleFileOps.remove(staged).catch(() => {
      // ignore cleanup failure
    });
  }

  await bundleFileOps.remove(aside).catch(async (error: unknown) => {
    await logError('updater', 'Failed to remove replaced bundle after rollback', {
      aside,
      error,
    });
  });
}

async function performRollback(): Promise<UpdaterStatus> {
  if (activeCheck) await activeCheck;

  const state = await syncRollbackStatus();
  const rollbackBundlePath = getRollbackBundlePath(state);
  const rollbackVersion = state.rollbackVersion;

  if (!rollbackVersion || !rollbackBundlePath || !(await rollbackBundleExists(state))) {
    dispatchUpdaterEvent({
      type: 'rollback-unavailable',
      message: 'No previous version backup is available.',
    });
    return snapshotUpdaterStatus();
  }

  const choice = await showUpdaterDialog({
    type: 'warning',
    buttons: ['Rollback now', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    title: 'Rollback available',
    message: `Roll back to version ${rollbackVersion}?`,
    detail:
      'The current app bundle will be replaced with the previous version saved before the last in-app update.',
  });

  if (choice.response === 1) {
    return await settledStatus();
  }

  const targetBundle = getBundlePathFromExecPath();
  const devModeOverride = isDevModeOverride();

  try {
    dispatchUpdaterEvent({
      type: 'rollback-started',
      targetVersion: rollbackVersion,
      message: `Rolling back to ${rollbackVersion}...`,
      progressPercent: 20,
    });

    await logInfo('updater', 'Restoring rollback backup', {
      rollbackBundlePath,
      targetBundle,
      rollbackVersion,
    });

    if (devModeOverride) {
      await logInfo('updater', 'Dev mode rollback restore skipped', {
        rollbackBundlePath,
        targetBundle,
      });
    } else {
      await restoreRollbackBundle(rollbackBundlePath, targetBundle);
      pendingRelaunch = { version: rollbackVersion, reason: 'rollback' };
    }
  } catch (error) {
    await logError('updater', 'Rollback failed', error).catch(() => undefined);
    dispatchUpdaterEvent({
      type: 'rollback-failed',
      message:
        error instanceof UpdaterUserError
          ? `Rollback failed. ${error.message}`
          : 'Rollback failed while restoring the previous version.',
    });
    return await settledStatus();
  }

  // The previous version is back in place; a stale backup must not block that.
  await clearRollbackBackup(state).catch(async (error: unknown) => {
    await logError('updater', 'Failed to clear rollback backup after restore', error);
  });
  dispatchUpdaterEvent({
    type: 'rollback-completed',
    restoredVersion: rollbackVersion,
    ...(devModeOverride
      ? { message: 'Dev mode: rollback restore skipped.' }
      : { relaunchRequired: true }),
  });

  if (devModeOverride) {
    await showUpdaterDialog({
      type: 'info',
      buttons: ['OK'],
      defaultId: 0,
      title: 'Dev rollback test',
      message: 'Rollback flow completed in dev mode.',
      detail: 'Restore and relaunch are skipped in development override mode.',
    });
    return await settledStatus();
  }

  const relaunchChoice = await showUpdaterDialog({
    type: 'info',
    buttons: ['Relaunch now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    title: 'Rollback complete',
    message: `Version ${rollbackVersion} was restored.`,
    detail: 'Relaunch to start the restored app.',
  });

  if (relaunchChoice.response === 0) {
    relaunchUpdatedApp();
  }

  return await settledStatus();
}

export async function rollbackToPreviousVersion(): Promise<UpdaterStatus> {
  if (activeOperation) {
    return activeOperation.kind === 'rollback'
      ? await activeOperation.promise
      : await getUpdaterStatus();
  }
  // After a rollback the backup is gone; rolling back an update that is
  // waiting for relaunch is still allowed (it restores the running version).
  if (pendingRelaunch?.reason === 'rollback') {
    return await getUpdaterStatus();
  }
  return await startOperation('rollback', performRollback);
}

/**
 * Relaunch into the bundle that an update or rollback installed. Returns
 * `false` (and does nothing) when no relaunch is pending. Intended for the
 * tray "Check for Updates…" flow when `status.relaunchRequired` is set.
 */
export function relaunchToFinishUpdate(): boolean {
  if (!pendingRelaunch) return false;
  relaunchUpdatedApp();
  return true;
}

export async function getUpdaterStatus(): Promise<UpdaterStatus> {
  // The rollback folder is being rewritten during an operation; report the
  // in-memory status rather than racing it.
  if (!activeOperation) {
    await syncRollbackStatus();
  }
  return snapshotUpdaterStatus();
}
