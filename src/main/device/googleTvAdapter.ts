import { promises as fs } from 'node:fs';
import path from 'node:path';

import { app } from 'electron';

import { createSystemClock } from '../../backend/core/clock';
import { AsyncMutex } from '../../backend/devices/asyncMutex';
import {
  findExistingForDraft,
  forgettableLegacyCertKeys,
  identityChanged,
  legacyCertKeysFor,
  matchSavedToDiscovered,
  mergeIdentity,
  normalizeDraft,
} from '../../backend/devices/deviceRegistry';
import {
  VoiceSessionService,
  type VoiceSessionTarget,
} from '../../backend/voice/VoiceSessionService';
import type {
  AudioOutputLink,
  AudioVolumeEvent,
  BootstrapState,
  CommandDispatchRequest,
  DeviceAdapter,
  DeviceCapabilities,
  DeviceDraft,
  DeviceState,
  DiscoveredAudioOutput,
  DiscoveredDevice,
  PairingRequest,
  SavedDevice,
} from '../../shared/types';
import { AudioOutputRouter, isAudioCommand } from '../audio/audioOutputRouter';
import { createSonosClient, type SonosClient } from '../audio/sonosClient';
import {
  candidatesFromMdns,
  candidatesFromSsdp,
  discoverSonosRooms,
} from '../audio/sonosDiscovery';
import { ssdpSearch } from '../audio/ssdpSearch';
import { assertLoopbackHost, integrationEnvironment } from '../integrationEnvironment';
import { createNodeLogger, getAppDataPath, logError, logInfo } from '../logger';
import { commandMetricsStore } from '../metrics';

import { androidTvRemoteBridge } from './androidTvRemote';
import {
  CertificateRejectedError,
  ServerIdentityMismatchError,
  type DeviceTarget,
} from './androidTvRemote.types';
import { browseServiceInstances, discoverGoogleTvDevices, resolveServiceRecord } from './discovery';
import { clearDeviceStore, readDevices, writeDevices } from './store';

const DEFAULT_STATE: DeviceState = {
  status: 'idle',
  message: 'Add a Google TV or Android TV device to get started.',
};

function getLegacyUserDataPaths(): string[] {
  if (integrationEnvironment)
    return [getAppDataPath(), getAppDataPath('legacy', 'GTV Desktop Remote')];
  const appDataRoot = app.getPath('appData');
  return [getAppDataPath(), path.join(appDataRoot, 'GTV Desktop Remote')];
}

const SONOS_SEARCH_TARGET_SERVICE = '_sonos._tcp';

/** Real-network Sonos discovery; disabled in the integration environment. */
function discoverSonosOnNetwork(client: SonosClient) {
  if (integrationEnvironment) return Promise.resolve([]);
  return discoverSonosRooms({
    browseMdns: async () =>
      candidatesFromMdns(
        await browseServiceInstances(SONOS_SEARCH_TARGET_SERVICE, 2500),
        (instance) => resolveServiceRecord(instance, SONOS_SEARCH_TARGET_SERVICE)
      ),
    searchSsdp: async () => candidatesFromSsdp(await ssdpSearch()),
    getRooms: (address) => client.getRooms(address),
  });
}

function targetFor(device: SavedDevice, savedDevices: readonly SavedDevice[]): DeviceTarget {
  return {
    deviceId: device.id,
    host: device.host,
    legacyCertKeys: legacyCertKeysFor(device, savedDevices),
  };
}

export class GoogleTvAdapter implements DeviceAdapter {
  private activeDevice: SavedDevice | undefined;

  /** Legacy credential keys computed for `activeDevice` when it connected. */
  private activeLegacyCertKeys: readonly string[] = [];

  private deviceState: DeviceState = DEFAULT_STATE;

  private scanPromise: Promise<DiscoveredDevice[]> | undefined;

  /**
   * Serializes every read-modify-write of devices.json. Network work stays
   * outside: callers re-read the latest list after it and apply a targeted
   * update, so a scan's host update and a connect's timestamp both survive.
   */
  private readonly storeLock = new AsyncMutex();

  private readonly voiceSessions: VoiceSessionService;

  private readonly audioRouter: AudioOutputRouter;

  private readonly sonosClient: SonosClient;

  private readonly audioVolumeListeners = new Set<(event: AudioVolumeEvent) => void>();

  constructor(voiceSessions?: VoiceSessionService, audioRouter?: AudioOutputRouter) {
    this.sonosClient = createSonosClient({
      assertHost: integrationEnvironment ? assertLoopbackHost : undefined,
    });
    this.audioRouter =
      audioRouter ??
      new AudioOutputRouter({
        client: this.sonosClient,
        discoverRooms: () => discoverSonosOnNetwork(this.sonosClient),
        onHostChanged: async (deviceId, host) => {
          await this.updateAudioOutput(deviceId, (link) => ({ ...link, host }));
        },
        emitVolume: (event) => {
          for (const listener of this.audioVolumeListeners) listener(event);
        },
        logger: createNodeLogger(),
      });
    this.voiceSessions =
      voiceSessions ??
      new VoiceSessionService(
        {
          start: (host, deviceId) =>
            androidTvRemoteBridge.startAssistantVoice({
              deviceId,
              host,
              legacyCertKeys:
                this.activeDevice?.id === deviceId ? this.activeLegacyCertKeys : undefined,
            }),
          sendChunk: (_host, sessionId, chunk, deviceId) =>
            androidTvRemoteBridge.sendAssistantVoiceChunk(deviceId, sessionId, chunk),
          stop: (_host, sessionId, deviceId) =>
            androidTvRemoteBridge.stopAssistantVoice(deviceId, sessionId),
          hasPending: (_host, deviceId) =>
            androidTvRemoteBridge.hasPendingAssistantVoiceSession(deviceId),
        },
        createSystemClock(),
        createNodeLogger()
      );
  }

  /** Runs `task` with the latest saved devices while holding the store lock. */
  private withDeviceStore<T>(task: (devices: SavedDevice[]) => Promise<T>): Promise<T> {
    return this.storeLock.runExclusive(async () => task(await readDevices()));
  }

  /**
   * Applies `update` to the latest copy of one saved device and persists it.
   * Returns the updated device, or undefined if it no longer exists.
   */
  private updateSavedDevice(
    deviceId: string,
    update: (device: SavedDevice) => SavedDevice
  ): Promise<SavedDevice | undefined> {
    return this.withDeviceStore(async (devices) => {
      let updated: SavedDevice | undefined;
      const nextDevices = devices.map((device) => {
        if (device.id !== deviceId) return device;
        updated = update(device);
        return updated;
      });
      if (updated) {
        await writeDevices(nextDevices);
      }
      return updated;
    });
  }

  private activeTarget(device: SavedDevice): DeviceTarget {
    return {
      deviceId: device.id,
      host: device.host,
      legacyCertKeys: this.activeLegacyCertKeys,
    };
  }

  private voiceTarget(device: SavedDevice): VoiceSessionTarget {
    return { deviceId: device.id, host: device.host };
  }

  /**
   * A saved device moved to a new address (rescan or re-save): drop any
   * connection bound to the old address and point the active device at the
   * new one so the next command reconnects there.
   */
  private applyHostChange(device: SavedDevice, oldHost: string): void {
    androidTvRemoteBridge.updateHost(device.id, device.host);
    if (this.activeDevice?.id === device.id) {
      this.activeDevice = device;
      void logInfo('adapter', 'Active device moved; the next command reconnects', {
        deviceId: device.id,
        oldHost,
        newHost: device.host,
      });
    }
  }

  /**
   * State changes for failures that mean the saved pairing can't be used.
   * A rejected client certificate marks the device unpaired (credentials are
   * kept: a stale IP answered by another TV must not destroy them). A server
   * identity mismatch only stops using the connection.
   */
  private async handleRemoteFailure(deviceId: string, error: unknown): Promise<void> {
    if (
      !(error instanceof CertificateRejectedError) &&
      !(error instanceof ServerIdentityMismatchError)
    ) {
      return;
    }

    if (this.activeDevice?.id === deviceId) {
      this.activeDevice = undefined;
    }
    this.deviceState = {
      status: 'error',
      message: error.message,
    };

    if (error instanceof CertificateRejectedError) {
      try {
        await this.updateSavedDevice(deviceId, (device) => ({ ...device, isPaired: false }));
      } catch (storeError) {
        await logError('adapter', 'Could not mark device as unpaired', storeError);
      }
    }
  }

  async listDevices(): Promise<SavedDevice[]> {
    return readDevices();
  }

  async scanForDevices(): Promise<DiscoveredDevice[]> {
    if (this.scanPromise) {
      await logInfo('adapter', 'Joining in-flight Google TV device scan');
      return this.scanPromise;
    }

    this.scanPromise = this.runDeviceScan().finally(() => {
      this.scanPromise = undefined;
    });

    return this.scanPromise;
  }

  private async runDeviceScan(): Promise<DiscoveredDevice[]> {
    await logInfo('adapter', 'Scanning local network for Google TV devices');
    const discovered = await discoverGoogleTvDevices();
    await logInfo('adapter', 'Scan complete', { count: discovered.length, devices: discovered });

    const hostChanges = await this.withDeviceStore(async (savedDevices) => {
      const results = savedDevices.map((saved) => {
        const match = matchSavedToDiscovered(saved, discovered);
        return { saved, updated: match ? mergeIdentity(saved, match) : saved };
      });
      const changes = results
        .filter(({ saved, updated }) => updated.host !== saved.host)
        .map(({ saved, updated }) => {
          void logInfo('adapter', 'Device IP changed — updating host', {
            deviceId: saved.id,
            name: saved.name,
            oldHost: saved.host,
            newHost: updated.host,
            macAddress: saved.macAddress,
            castDeviceId: saved.castDeviceId,
            networkHostName: saved.networkHostName,
            deviceFingerprint: saved.deviceFingerprint,
          });
          return { device: updated, oldHost: saved.host };
        });

      if (results.some(({ saved, updated }) => identityChanged(saved, updated))) {
        // Credentials are keyed by device id, so an address change needs no
        // certificate migration.
        await writeDevices(results.map(({ updated }) => updated));
      }
      return changes;
    });

    for (const { device, oldHost } of hostChanges) {
      this.applyHostChange(device, oldHost);
    }

    return discovered;
  }

  async saveDevice(draft: DeviceDraft): Promise<SavedDevice[]> {
    if (integrationEnvironment) assertLoopbackHost(draft.host);
    await logInfo('adapter', 'Saving device', { draft });

    const { nextDevices, nextDevice, previousHost } = await this.withDeviceStore(
      async (devices) => {
        const existingDevice = findExistingForDraft(draft, devices);
        const saved = normalizeDraft(draft, existingDevice);
        const next = [...devices.filter((device) => device.id !== existingDevice?.id), saved];
        await writeDevices(next);
        return { nextDevices: next, nextDevice: saved, previousHost: existingDevice?.host };
      }
    );

    if (previousHost !== undefined && previousHost !== nextDevice.host) {
      this.applyHostChange(nextDevice, previousHost);
    } else if (this.activeDevice?.id === nextDevice.id) {
      this.activeDevice = nextDevice;
    }

    this.deviceState = {
      ...this.deviceState,
      message: `Saved ${nextDevice.name}. Pair once, then connect.`,
    };
    return nextDevices;
  }

  async removeDevice(deviceId: string): Promise<SavedDevice[]> {
    await logInfo('adapter', 'Removing device', { deviceId });
    const nextDevices = await this.withDeviceStore(async (devices) => {
      const device = devices.find((item) => item.id === deviceId);
      if (!device) {
        return devices;
      }
      // Forget authorization before reporting a successful removal or clearing
      // active state. Legacy MAC/host-keyed files are only removed when no
      // other saved device could still be using them.
      await androidTvRemoteBridge.forgetDevice(
        device.id,
        forgettableLegacyCertKeys(device, devices)
      );
      const remaining = devices.filter((item) => item.id !== deviceId);
      await writeDevices(remaining);
      return remaining;
    });

    if (this.activeDevice?.id === deviceId) {
      this.activeDevice = undefined;
      this.deviceState = DEFAULT_STATE;
    }

    return nextDevices;
  }

  async resetState(): Promise<DeviceState> {
    await logInfo('adapter', 'Resetting app state');

    await this.storeLock.runExclusive(async () => {
      this.activeDevice = undefined;
      await androidTvRemoteBridge.reset();
      await clearDeviceStore();

      for (const userDataPath of getLegacyUserDataPaths()) {
        await fs.rm(path.join(userDataPath, 'devices.json'), { force: true });
        await fs.rm(path.join(userDataPath, 'androidtvremote'), { force: true, recursive: true });
      }
    });

    this.deviceState = {
      ...DEFAULT_STATE,
      message: 'App state reset. Pair your devices again.',
    };

    return this.deviceState;
  }

  async pair(request: PairingRequest): Promise<void> {
    const host = request.host.trim();
    if (integrationEnvironment) assertLoopbackHost(host);
    await logInfo('adapter', 'Starting pairing', { request: { ...request, code: '[redacted]' } });
    this.deviceState = {
      status: 'connecting',
      message: `Finishing pairing with ${request.host}...`,
    };

    try {
      const devices = await readDevices();
      const device = request.deviceId
        ? devices.find((item) => item.id === request.deviceId)
        : devices.find((item) => item.host.trim() === host);
      if (!device) {
        throw new Error('Saved device not found.');
      }

      await androidTvRemoteBridge.finishPairing(
        { ...targetFor(device, devices), host },
        request.code.trim()
      );
      await this.updateSavedDevice(device.id, (item) => ({ ...item, isPaired: true }));
      await logInfo('adapter', 'Pairing succeeded', { deviceId: device.id, host });
      this.deviceState = {
        status: 'idle',
        message: 'Pairing succeeded. You can connect now.',
      };
    } catch (error) {
      await logError('adapter', 'Pairing failed', error);
      this.deviceState = {
        status: 'error',
        message: (error as Error).message,
      };
      throw error;
    }
  }

  async startPairing(deviceId: string): Promise<DeviceState> {
    await logInfo('adapter', 'Starting seamless pairing session', { deviceId });
    const devices = await readDevices();
    const device = devices.find((item) => item.id === deviceId);

    if (!device) {
      throw new Error('Saved device not found.');
    }

    this.activeDevice = undefined;
    try {
      androidTvRemoteBridge.disconnect(device.id);
    } catch {
      // Ignore disconnect failures before pairing; a stale remote session should not block pairing.
    }

    this.deviceState = {
      status: 'connecting',
      message: `Requesting pairing code from ${device.name}...`,
    };

    try {
      const result = await androidTvRemoteBridge.startPairing(targetFor(device, devices));
      const mac = typeof result?.mac === 'string' ? result.mac : undefined;
      if (mac) {
        await this.updateSavedDevice(device.id, (item) => ({ ...item, macAddress: mac }));
      }
      this.deviceState = {
        status: 'idle',
        message: `Enter the 6-digit code shown on ${device.name}.`,
      };
      return this.deviceState;
    } catch (error) {
      await logError('adapter', 'Seamless pairing start failed', error);
      this.deviceState = {
        status: 'error',
        message: (error as Error).message,
      };
      throw error;
    }
  }

  async connect(deviceId: string): Promise<DeviceState> {
    await logInfo('adapter', 'Connecting device', { deviceId });
    const devices = await readDevices();
    const device = devices.find((item) => item.id === deviceId);

    if (!device) {
      throw new Error('Saved device not found.');
    }

    this.deviceState = {
      status: 'connecting',
      activeDeviceId: device.id,
      message: `Connecting to ${device.name}...`,
    };

    const target = targetFor(device, devices);
    try {
      const result = await androidTvRemoteBridge.connect(target);
      const mac = typeof result?.mac === 'string' ? result.mac : undefined;
      const connected = await this.updateSavedDevice(device.id, (item) => ({
        ...item,
        lastConnectedAt: new Date().toISOString(),
        macAddress: mac ?? item.macAddress,
      }));
      if (!connected) {
        androidTvRemoteBridge.disconnect(device.id);
        throw new Error('Saved device not found.');
      }
      this.activeDevice = connected;
      this.activeLegacyCertKeys = target.legacyCertKeys ?? [];
      this.deviceState = {
        status: 'connected',
        activeDeviceId: device.id,
        message: `Connected to ${device.name}.`,
      };
      await logInfo('adapter', 'Connection succeeded', { deviceId: device.id, host: device.host });
      return this.deviceState;
    } catch (error) {
      this.activeDevice = undefined;
      await this.handleRemoteFailure(device.id, error);
      await logError('adapter', 'Connection failed', error);
      this.deviceState = {
        status: 'error',
        message: (error as Error).message,
      };
      throw error;
    }
  }

  async disconnect(): Promise<DeviceState> {
    await logInfo('adapter', 'Disconnect requested', { activeDeviceId: this.activeDevice?.id });
    if (!this.activeDevice) {
      this.deviceState = DEFAULT_STATE;
      return this.deviceState;
    }

    try {
      androidTvRemoteBridge.disconnect(this.activeDevice.id);
    } catch {
      // Ignore disconnect failures so the UI can recover to idle.
    }

    this.activeDevice = undefined;
    this.deviceState = {
      status: 'idle',
      message: 'Disconnected.',
    };
    return this.deviceState;
  }

  /**
   * Call after the system wakes or the screen unlocks: sockets opened before
   * sleep are usually half-open, so every remote connection is dropped and
   * the active device reconnects in the background. Commands sent meanwhile
   * join that reconnect.
   */
  handleSystemResume(): void {
    // Speakers may have new addresses after sleep or a network change.
    this.audioRouter.forget();
    const device = this.activeDevice;
    void logInfo('adapter', 'System resumed; dropping remote connections', {
      activeDeviceId: device?.id,
    });
    androidTvRemoteBridge.dropRemoteClients();
    if (!device) {
      return;
    }
    androidTvRemoteBridge.connect(this.activeTarget(device)).catch((error: unknown) => {
      void logError('adapter', 'Background reconnect after resume failed', error);
    });
  }

  async sendCommand(request: CommandDispatchRequest): Promise<void> {
    commandMetricsStore.recordAdapterDispatchStart(request, {
      deviceId: this.activeDevice?.id,
      host: this.activeDevice?.host,
    });

    const device = this.activeDevice;
    if (!device) {
      const errorMessage = 'No active device connected.';
      commandMetricsStore.recordCommandFailed(request, {
        reason: 'no_active_device',
        errorMessage,
      });
      throw new Error(errorMessage);
    }

    const link = device.audioOutput;
    if (link?.enabled && isAudioCommand(request.command)) {
      // This TV's volume keys belong to a linked speaker, not the TV.
      try {
        await this.audioRouter.handle(device.id, link, request.command);
      } catch (error) {
        commandMetricsStore.recordCommandFailed(request, {
          reason: 'send_failed',
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      commandMetricsStore.recordAdapterDispatchCompleted(request.id);
      return;
    }

    try {
      await androidTvRemoteBridge.sendCommand(this.activeTarget(device), request);
    } catch (error) {
      await this.handleRemoteFailure(device.id, error);
      throw error;
    }
    commandMetricsStore.recordAdapterDispatchCompleted(request.id);
  }

  /** Subscribe to linked-speaker volume changes. Returns an unsubscribe function. */
  onAudioVolume(listener: (event: AudioVolumeEvent) => void): () => void {
    this.audioVolumeListeners.add(listener);
    return () => {
      this.audioVolumeListeners.delete(listener);
    };
  }

  async discoverAudioOutputs(): Promise<DiscoveredAudioOutput[]> {
    const rooms = await discoverSonosOnNetwork(this.sonosClient);
    return rooms.map(({ kind, id, name, host, model }) => ({ kind, id, name, host, model }));
  }

  /** Link (or unlink with `null`) a speaker to one TV's volume keys. */
  async setAudioOutput(deviceId: string, link: AudioOutputLink | null): Promise<SavedDevice[]> {
    const updated = await this.updateSavedDevice(deviceId, (device) => {
      if (link) return { ...device, audioOutput: link };
      const { audioOutput: _removed, ...rest } = device;
      return rest;
    });
    if (!updated) {
      throw new Error('Saved device not found.');
    }
    if (this.activeDevice?.id === deviceId) this.activeDevice = updated;
    this.audioRouter.forget(link?.id);
    await logInfo('adapter', 'Audio output link changed', {
      deviceId,
      linked: link ? { id: link.id, name: link.name, enabled: link.enabled } : null,
    });
    return readDevices();
  }

  private async updateAudioOutput(
    deviceId: string,
    update: (link: AudioOutputLink) => AudioOutputLink
  ): Promise<void> {
    const updated = await this.updateSavedDevice(deviceId, (device) =>
      device.audioOutput ? { ...device, audioOutput: update(device.audioOutput) } : device
    );
    if (updated && this.activeDevice?.id === deviceId) this.activeDevice = updated;
  }

  async sendText(text: string): Promise<void> {
    const device = this.requireActiveDevice();
    try {
      await androidTvRemoteBridge.sendText(this.activeTarget(device), text);
    } catch (error) {
      await this.handleRemoteFailure(device.id, error);
      throw error;
    }
  }

  async startAssistantVoice(): Promise<number> {
    const device = this.requireActiveDevice();
    try {
      return await this.voiceSessions.start(this.voiceTarget(device));
    } catch (error) {
      await this.handleRemoteFailure(device.id, error);
      throw error;
    }
  }

  async sendAssistantVoiceChunk(sessionId: number, chunkBase64: string): Promise<void> {
    const device = this.requireActiveDevice();
    try {
      await this.voiceSessions.sendChunk(this.voiceTarget(device), sessionId, chunkBase64);
    } catch (error) {
      await this.handleRemoteFailure(device.id, error);
      throw error;
    }
  }

  async stopAssistantVoice(sessionId: number): Promise<void> {
    const device = this.requireActiveDevice();
    try {
      await this.voiceSessions.stop(this.voiceTarget(device), sessionId);
    } catch (error) {
      await this.handleRemoteFailure(device.id, error);
      throw error;
    }
  }

  async hasPendingAssistantVoiceSession(): Promise<boolean> {
    if (!this.activeDevice) {
      return false;
    }
    return this.voiceSessions.hasPending(this.voiceTarget(this.activeDevice));
  }

  getCapabilities(): Promise<DeviceCapabilities> {
    return Promise.resolve({
      textInput: true,
      powerToggle: true,
    });
  }

  async getBootstrapState(): Promise<BootstrapState> {
    return {
      devices: await readDevices(),
      deviceState: this.deviceState,
    };
  }

  private requireActiveDevice(): SavedDevice {
    if (!this.activeDevice) {
      throw new Error('No active device connected.');
    }
    return this.activeDevice;
  }
}
