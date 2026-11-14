import type { NodeTlsTransport } from '@librecontrol/google-tv' with {
  'resolution-mode': 'import',
};

import { createNodeFileSystem, type IFileSystem } from '../../backend/core/fileSystem';
import type { ILogger } from '../../backend/core/logger';
import { AndroidTvCertStore } from '../../backend/devices/credentials/androidTvCertStore';
import { createPairingClient } from '../../backend/pairing/createPairingClient';
import type { CommandDispatchRequest } from '../../shared/types';
import { isCaptureEnabled, record, recordBuffer } from '../capture';
import { assertLoopbackHost, integrationEnvironment } from '../integrationEnvironment';
import { createNodeLogger, getAppDataPath, logError } from '../logger';
import { commandMetricsStore } from '../metrics';

import {
  CertificateRejectedError,
  DEFAULT_PAIRING_PORT,
  SERVICE_NAME,
  STALE_CONNECTION_MS,
  ServerIdentityMismatchError,
  normalizeRemoteError,
  toError,
  type DeviceSession,
  type DeviceTarget,
  type RemoteClientPort,
  type RemoteState,
} from './androidTvRemote.types';
import type { PemPair } from './protocol/certificate';

interface LibretvRemoteClientInstance {
  close(): Promise<void>;
  commandDownUp(key: string): Promise<void>;
  connect(): Promise<void>;
  keyDown(key: string): Promise<void>;
  keyUp(key: string): Promise<void>;
  on(event: 'message', listener: (message: LibretvRemoteMessage) => void): this;
  on(event: 'close', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  text(value: string): Promise<void>;
  voiceBegin(): Promise<{ sessionId: number }>;
  voiceEnd(): Promise<void>;
  voicePayload(samples: Uint8Array): Promise<void>;
}

type LibretvRemoteMessage =
  | {
      type: 'configure';
      appVersion?: string;
      deviceModel?: string;
      vendor?: string;
    }
  | {
      type: 'text';
      fieldCounter: number;
      imeCounter: number;
    }
  | {
      type: 'ready';
      started: boolean;
    }
  | {
      type: 'voice';
      phase: 'begin' | 'payload' | 'end';
      sessionId: number;
    }
  | {
      // The library answers pings itself and still emits them.
      type: 'ping';
      sequence: number;
    }
  | {
      type: 'set-active' | 'key' | 'unknown';
    };

interface LibretvGoogleModule {
  NodeTlsTransport: new (options: {
    cert: string;
    host: string;
    key: string;
    port: number;
    rejectUnauthorized: boolean;
  }) => NodeTlsTransport;
  RemoteClient: new (options: { transport: NodeTlsTransport }) => LibretvRemoteClientInstance;
}

/**
 * Checks the TV's server-certificate fingerprint after the TLS handshake.
 * Throws to abort the connection.
 */
type ServerVerifier = (fingerprint256: string | undefined) => Promise<void>;

const COMMAND_TO_LIBRETV_KEY: Record<CommandDispatchRequest['command'], string> = {
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  select: 'select',
  home: 'home',
  back: 'back',
  play_pause: 'playPause',
  volume_up: 'volumeUp',
  volume_down: 'volumeDown',
  power: 'power',
  assistant_press: 'assistant',
  assistant_release: 'assistant',
};

let librecontrolGoogleTvModule: Promise<LibretvGoogleModule> | undefined;

function loadLibretvGoogle(): Promise<LibretvGoogleModule> {
  librecontrolGoogleTvModule ??= import('@librecontrol/google-tv');
  return librecontrolGoogleTvModule;
}

class LibretvGoogleRemoteClient implements RemoteClientPort {
  private client: LibretvRemoteClientInstance | undefined;
  private connectPromise: Promise<void> | undefined;
  private protocolReady = false;
  private connectionGeneration = 0;
  // Voice ownership expires with this exact transport, not with the device's host.
  private activeVoiceSessionId: number | undefined;
  private state: RemoteState = {
    imeCounter: 0,
    imeFieldCounter: 0,
    lastActivityAt: 0,
  };

  constructor(
    private readonly host: string,
    private readonly certs: PemPair,
    private readonly verifyServer: ServerVerifier
  ) {}

  get snapshot(): RemoteState {
    return this.state;
  }

  get isConnected(): boolean {
    return Boolean(this.client && this.protocolReady);
  }

  isStale(now = Date.now()): boolean {
    const lastPingAt = this.state.lastPingAt;
    return this.isConnected && lastPingAt !== undefined && now - lastPingAt > STALE_CONNECTION_MS;
  }

  async connect(commandId?: string): Promise<void> {
    if (this.isConnected) {
      return;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    if (commandId) {
      commandMetricsStore.recordConnectStarted(this.host, commandId);
    }

    const connectPromise = this.open(commandId).finally(() => {
      if (this.connectPromise === connectPromise) {
        this.connectPromise = undefined;
      }
    });
    this.connectPromise = connectPromise;

    return this.connectPromise;
  }

  disconnect(): void {
    const client = this.client;
    this.connectionGeneration += 1;
    this.client = undefined;
    this.connectPromise = undefined;
    this.protocolReady = false;
    this.clearVoiceSession();
    if (client) {
      closeQuietly(client);
    }
    commandMetricsStore.recordSocketClosed(this.host);
  }

  async sendCommand(request: CommandDispatchRequest): Promise<void> {
    const client = this.requireClient();
    const key = COMMAND_TO_LIBRETV_KEY[request.command];
    if (request.command === 'assistant_press') {
      await client.keyDown(key);
    } else if (request.command === 'assistant_release') {
      await client.keyUp(key);
    } else {
      await client.commandDownUp(key);
    }
    commandMetricsStore.recordSocketWrite(request, { host: this.host, buffered: false });
  }

  async sendText(text: string): Promise<void> {
    await this.requireClient().text(text.trim());
  }

  async startVoiceSession(): Promise<number> {
    const client = this.requireClient();
    const session = await client.voiceBegin();
    if (this.client !== client || !this.protocolReady) {
      throw new Error('Connection has been lost.');
    }
    if (this.state.voiceSessionId !== session.sessionId) {
      throw new Error('The voice session has ended. Start a new voice session.');
    }
    this.activeVoiceSessionId = session.sessionId;
    return session.sessionId;
  }

  async sendVoiceChunk(sessionId: number, samples: Buffer): Promise<void> {
    if (!samples.length) {
      return;
    }
    const client = this.requireClient();
    if (this.activeVoiceSessionId !== sessionId || this.state.voiceSessionId !== sessionId) {
      throw new Error('The voice session is not active. Start a new voice session.');
    }
    await client.voicePayload(samples);
  }

  async stopVoiceSession(sessionId: number): Promise<void> {
    if (!this.isConnected || this.state.voiceSessionId === undefined) {
      this.clearVoiceSession();
      return;
    }
    if (this.state.voiceSessionId !== sessionId) {
      throw new Error('The voice session ID does not match the active voice session.');
    }
    const client = this.requireClient();
    try {
      await client.voiceEnd();
    } finally {
      if (this.client === client && this.state.voiceSessionId === sessionId) {
        this.clearVoiceSession();
      }
    }
  }

  private clearVoiceSession(): void {
    this.activeVoiceSessionId = undefined;
    this.state.voiceSessionId = undefined;
  }

  private async open(commandId?: string): Promise<void> {
    if (integrationEnvironment) assertLoopbackHost(this.host);
    const generation = this.connectionGeneration;
    const { NodeTlsTransport, RemoteClient } = await loadLibretvGoogle();
    if (generation !== this.connectionGeneration) {
      throw new Error('Connection has been lost.');
    }
    // TV certificates are self-signed, so chain validation is off; the server
    // identity is instead pinned (trust on first use) after the handshake.
    const transport = new NodeTlsTransport({
      cert: this.certs.cert,
      host: this.host,
      key: this.certs.key,
      port: integrationEnvironment?.remotePort ?? 6466,
      rejectUnauthorized: false,
    });
    const client = new RemoteClient({ transport });
    this.client = client;
    // Ping freshness is per connection.
    this.state.lastPingAt = undefined;
    client.on('message', (message) => {
      if (this.client !== client) {
        return;
      }
      commandMetricsStore.recordInboundMessage(this.host);
      const now = Date.now();
      this.state.lastActivityAt = now;
      switch (message.type) {
        case 'configure':
          this.state.deviceInfo = {
            appVersion: message.appVersion,
            model: message.deviceModel,
            vendor: message.vendor,
          };
          break;
        case 'text':
          this.state.imeCounter = message.imeCounter;
          this.state.imeFieldCounter = message.fieldCounter;
          break;
        case 'ready':
          this.state.isOn = message.started;
          break;
        case 'ping':
          this.state.lastPingAt = now;
          break;
        case 'voice':
          if (message.phase === 'begin') {
            this.state.voiceSessionId = message.sessionId;
          } else if (message.phase === 'end' && this.state.voiceSessionId === message.sessionId) {
            this.clearVoiceSession();
          }
          break;
        default:
          break;
      }
    });
    client.on('close', () => {
      if (this.client !== client) {
        return;
      }
      commandMetricsStore.recordSocketClosed(this.host);
      this.protocolReady = false;
      this.client = undefined;
      this.connectPromise = undefined;
      this.connectionGeneration += 1;
      this.clearVoiceSession();
    });
    client.on('error', (error) => {
      void logError('androidtvremote', 'LibreControl Google TV remote client error', error);
    });

    try {
      await client.connect();
      if (this.client !== client || generation !== this.connectionGeneration) {
        throw new Error('Connection has been lost.');
      }
      await this.verifyServer(transport.getCertificates().peer?.fingerprint256);
      if (this.client !== client || generation !== this.connectionGeneration) {
        throw new Error('Connection has been lost.');
      }
      this.protocolReady = true;
      this.state.lastActivityAt = Date.now();
      if (commandId) {
        commandMetricsStore.recordConnectCompleted(this.host, commandId);
      }
    } catch (error) {
      if (this.client === client) {
        this.client = undefined;
        this.protocolReady = false;
        this.clearVoiceSession();
      }
      // A failed handshake, readiness timeout or pin mismatch must not leave
      // the TLS socket open.
      closeQuietly(client);
      if (commandId) {
        commandMetricsStore.recordConnectFailed(
          this.host,
          commandId,
          toError(error, `Could not connect to ${this.host}.`).message
        );
      }
      throw error;
    }
  }

  private requireClient(): LibretvRemoteClientInstance {
    if (!this.client || !this.protocolReady) {
      throw new Error('Connection has been lost.');
    }
    return this.client;
  }
}

function closeQuietly(client: { close(): Promise<void> }): void {
  try {
    client.close().catch((error: unknown) => {
      void logError('androidtvremote', 'Closing the remote client failed', error);
    });
  } catch (error) {
    void logError('androidtvremote', 'Closing the remote client failed', error);
  }
}

interface BridgeSession extends DeviceSession {
  readonly deviceId: string;
  /** Where the TV currently is; the remote client is bound to this host. */
  host: string;
}

/**
 * Owns the per-device Android TV Remote v2 state: client certificates,
 * pairing sessions (port 6467) and remote connections (port 6466).
 *
 * Everything is keyed by the saved device's `id`, never by IP address, so a
 * TV that changes address keeps its credentials and two TVs that have shared
 * an address never share or destroy each other's credentials.
 */
export class AndroidTvRemoteBridge {
  private readonly sessions = new Map<string, BridgeSession>();
  private readonly pendingSessions = new Map<string, Promise<BridgeSession>>();
  private readonly fs: IFileSystem = createNodeFileSystem();
  private readonly logger: ILogger = createNodeLogger();

  private readonly certStore = new AndroidTvCertStore(
    this.fs,
    {
      getCertStateDir: () => getAppDataPath('androidtvremote'),
      getAppDataPath: (...segments) => getAppDataPath(...segments),
    },
    this.logger
  );

  private async getSession(target: DeviceTarget): Promise<BridgeSession> {
    const deviceId = target.deviceId.trim();
    const host = target.host.trim();
    if (integrationEnvironment) assertLoopbackHost(host);
    if (!deviceId) {
      throw new Error('Missing device id');
    }
    if (!host) {
      throw new Error('Missing host');
    }

    let session = this.sessions.get(deviceId);
    if (!session) {
      let pending = this.pendingSessions.get(deviceId);
      if (!pending) {
        pending = this.certStore
          .loadOrCreate(deviceId, target.legacyCertKeys ?? [])
          .then((certs) => {
            const created: BridgeSession = { deviceId, host, certs };
            this.sessions.set(deviceId, created);
            return created;
          })
          .finally(() => {
            this.pendingSessions.delete(deviceId);
          });
        this.pendingSessions.set(deviceId, pending);
      }
      session = await pending;
    }

    this.applyHost(session, host);
    return session;
  }

  /** Re-targets a session; a remote client bound to the old host is dropped. */
  private applyHost(session: BridgeSession, host: string): void {
    if (session.host === host) {
      return;
    }
    record({
      layer: 'transport',
      direction: 'call',
      event: 'hostChanged',
      meta: { deviceId: session.deviceId, oldHost: session.host, newHost: host },
    });
    this.logger.info('androidtvremote', 'Device host changed; dropping stale remote client', {
      deviceId: session.deviceId,
      oldHost: session.host,
      newHost: host,
    });
    session.remoteClient?.disconnect();
    session.remoteClient = undefined;
    session.host = host;
  }

  private createRemoteClient(session: BridgeSession): RemoteClientPort {
    const { deviceId, host } = session;
    return new LibretvGoogleRemoteClient(host, session.certs, (fingerprint256) =>
      this.verifyServerIdentity(deviceId, host, fingerprint256)
    );
  }

  /** Trust-on-first-use pinning of the TV's remote-service certificate. */
  private async verifyServerIdentity(
    deviceId: string,
    host: string,
    fingerprint256: string | undefined
  ): Promise<void> {
    if (!fingerprint256) {
      this.logger.warn('androidtvremote', 'TV presented no certificate; skipping server pin', {
        deviceId,
        host,
      });
      return;
    }

    const pinned = await this.certStore.readPin(deviceId);
    if (!pinned) {
      try {
        await this.certStore.writePin(deviceId, fingerprint256);
        this.logger.info('androidtvremote', 'Pinned TV certificate', { deviceId, host });
      } catch (error) {
        // Failing to persist only defers pinning to the next connection.
        this.logger.error('androidtvremote', 'Could not persist TV certificate pin', {
          deviceId,
          host,
          error: String(error),
        });
      }
      return;
    }

    if (pinned !== fingerprint256) {
      this.logger.warn('androidtvremote', 'TV certificate does not match the pinned TV', {
        deviceId,
        host,
      });
      throw new ServerIdentityMismatchError(host);
    }
  }

  private ensureRemoteClient(session: BridgeSession): RemoteClientPort {
    session.remoteClient ??= this.createRemoteClient(session);
    return session.remoteClient;
  }

  /**
   * Returns a connected client, replacing a connection that has stopped
   * receiving TV pings (half-open after sleep/wake or a network change).
   */
  private async ensureConnected(
    session: BridgeSession,
    commandId?: string
  ): Promise<RemoteClientPort> {
    let client = this.ensureRemoteClient(session);
    if (client.isStale()) {
      this.logger.info('androidtvremote', 'No TV ping recently; reconnecting', {
        deviceId: session.deviceId,
        host: session.host,
        lastPingAt: client.snapshot.lastPingAt,
      });
      client.disconnect();
      session.remoteClient = undefined;
      client = this.ensureRemoteClient(session);
    }
    await client.connect(commandId);
    return client;
  }

  /**
   * Normalizes a remote failure. A certificate rejection or server-identity
   * mismatch drops the client so nothing reuses it; credentials are kept.
   */
  private remoteFailure(
    session: BridgeSession,
    client: RemoteClientPort | undefined,
    error: unknown,
    fallback: string
  ): Error {
    const normalized = normalizeRemoteError(error, fallback);
    if (
      normalized instanceof CertificateRejectedError ||
      normalized instanceof ServerIdentityMismatchError
    ) {
      if (client) {
        client.disconnect();
        if (session.remoteClient === client) {
          session.remoteClient = undefined;
        }
      }
    }
    return normalized;
  }

  /** Closes a session's connections and forgets it (credentials stay on disk). */
  private async closeSession(deviceId: string, options: { ignoreCloseErrors: boolean }) {
    const session = this.sessions.get(deviceId);
    if (!session) {
      return;
    }
    session.remoteClient?.disconnect();
    session.remoteClient = undefined;
    const pairingManager = session.pairingManager;
    session.pairingManager = undefined;
    session.pairingReady = undefined;
    this.sessions.delete(deviceId);
    if (pairingManager) {
      if (options.ignoreCloseErrors) {
        await pairingManager.close().catch(() => undefined);
      } else {
        await pairingManager.close();
      }
    }
  }

  /**
   * Forget this device's authorization without affecting other paired
   * devices: closes its session and deletes its id-keyed certificate, key and
   * server pin, plus the given legacy (MAC/host-keyed) files. The caller must
   * only pass legacy keys no other saved device shares.
   */
  async forgetDevice(deviceId: string, legacyCertKeys: readonly string[] = []): Promise<void> {
    const id = deviceId.trim();
    await this.pendingSessions.get(id)?.catch(() => undefined);
    // Closing each client invalidates queued voice work before credentials are removed.
    await this.closeSession(id, { ignoreCloseErrors: false });
    await this.certStore.clear(id);
    for (const legacyCertKey of legacyCertKeys) {
      if (legacyCertKey.trim() && legacyCertKey.trim() !== id) {
        await this.certStore.clear(legacyCertKey.trim());
      }
    }
  }

  async startPairing(target: DeviceTarget): Promise<Record<string, unknown> | undefined> {
    record({
      layer: 'pairing',
      direction: 'call',
      event: 'startPairing',
      meta: { deviceId: target.deviceId, host: target.host },
    });
    const session = await this.getSession(target);

    if (session.pairingReady) {
      await session.pairingReady;
      return {};
    }

    const host = session.host;
    const pairingReady = (async () => {
      // A previous, unfinished pairing still holds a TLS connection to 6467.
      const previous = session.pairingManager;
      session.pairingManager = undefined;
      if (previous) {
        await previous.close().catch(() => undefined);
      }

      const pairingManager = await createPairingClient(
        {
          cert: session.certs.cert,
          clientName: SERVICE_NAME,
          host,
          key: session.certs.key,
          port: integrationEnvironment?.pairingPort ?? DEFAULT_PAIRING_PORT,
          rejectUnauthorized: false,
        },
        (error) => {
          void logError('androidtvremote', 'LibreControl Google TV pairing transport error', error);
        }
      );
      session.pairingManager = pairingManager;

      try {
        await pairingManager.start();
      } catch (error) {
        await pairingManager.close().catch(() => undefined);
        if (session.pairingManager === pairingManager) {
          session.pairingManager = undefined;
        }
        throw toError(error, 'Pairing failed.');
      }
    })().finally(() => {
      if (session.pairingReady === pairingReady) {
        session.pairingReady = undefined;
      }
    });
    session.pairingReady = pairingReady;

    await pairingReady;
    return {};
  }

  async finishPairing(target: DeviceTarget, code: string): Promise<void> {
    record({
      layer: 'pairing',
      direction: 'call',
      event: 'finishPairing',
      meta: { deviceId: target.deviceId, host: target.host, codeLength: code.length },
    });
    const session = await this.getSession(target);
    const pairingManager = session.pairingManager;
    if (!pairingManager) {
      throw new Error('No pairing session is active for this device.');
    }

    try {
      const result = await pairingManager.submitCode(code.trim());
      if (result.type !== 'secret-ack' || result.status !== 'ok') {
        throw new Error('Invalid pairing code. Request a new code and try again.');
      }
    } catch (error) {
      // closeSession closes the pairing manager and drops the cached session.
      await this.closeSession(session.deviceId, { ignoreCloseErrors: true });
      throw normalizeRemoteError(error, 'Pairing failed.');
    }

    if (session.pairingManager === pairingManager) {
      session.pairingManager = undefined;
    }
    await pairingManager.close().catch(() => undefined);

    // The TV may have been reset; re-pin its certificate on the next connect.
    await this.certStore.clearPin(session.deviceId);
  }

  async connect(target: DeviceTarget): Promise<Record<string, unknown> | undefined> {
    record({
      layer: 'transport',
      direction: 'call',
      event: 'connect',
      meta: { deviceId: target.deviceId, host: target.host },
    });
    const session = await this.getSession(target);
    const host = session.host;
    const client = this.ensureRemoteClient(session);

    try {
      await client.connect();
    } catch (error) {
      throw this.remoteFailure(session, client, error, `Could not connect to ${host}.`);
    }

    const snapshot = client.snapshot;

    return {
      current_app: snapshot.currentApp,
      is_on: snapshot.isOn,
      mac: undefined,
      name: snapshot.deviceInfo?.model ?? host,
    };
  }

  disconnect(deviceId: string): void {
    const session = this.sessions.get(deviceId.trim());
    session?.remoteClient?.disconnect();
    if (session) {
      session.remoteClient = undefined;
    }
  }

  /**
   * Called after a rescan moved a device: a client still bound to the old
   * address is dropped so the next command connects to `host`.
   */
  updateHost(deviceId: string, host: string): void {
    const session = this.sessions.get(deviceId.trim());
    const nextHost = host.trim();
    if (session && nextHost) {
      if (integrationEnvironment) assertLoopbackHost(nextHost);
      this.applyHost(session, nextHost);
    }
  }

  /**
   * Drops every remote connection (credentials and pairing sessions stay).
   * Used after system resume, when sockets are likely half-open.
   */
  dropRemoteClients(): void {
    for (const session of this.sessions.values()) {
      session.remoteClient?.disconnect();
      session.remoteClient = undefined;
    }
  }

  async reset(): Promise<void> {
    await Promise.allSettled(this.pendingSessions.values());
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(
      sessions.map(async (session) => {
        session.remoteClient?.disconnect();
        session.remoteClient = undefined;
        const pairingManager = session.pairingManager;
        session.pairingManager = undefined;
        session.pairingReady = undefined;
        await pairingManager?.close().catch(() => undefined);
      })
    );
    await this.fs.rmRecursive(getAppDataPath('androidtvremote'));
  }

  async sendCommand(target: DeviceTarget, request: CommandDispatchRequest): Promise<void> {
    const session = await this.getSession(target);
    const host = session.host;

    commandMetricsStore.recordBridgeSendStart(request, host);

    let client: RemoteClientPort | undefined;
    try {
      client = await this.ensureConnected(session, request.id);
      await client.sendCommand(request);
      commandMetricsStore.recordCommandSucceeded(request.id);
    } catch (error) {
      const normalizedError = this.remoteFailure(
        session,
        client ?? session.remoteClient,
        error,
        `Could not send ${request.command} to ${host}.`
      );
      const reason = normalizedError.message.includes('Connection has been lost.')
        ? 'socket_destroyed'
        : normalizedError.message.includes('timed out')
          ? 'connect_failed'
          : 'send_failed';
      commandMetricsStore.recordCommandFailed(request, {
        reason,
        errorMessage: normalizedError.message,
        host,
      });
      throw normalizedError;
    }
  }

  async sendText(target: DeviceTarget, text: string): Promise<void> {
    const session = await this.getSession(target);
    let client: RemoteClientPort | undefined;
    try {
      client = await this.ensureConnected(session);
      await client.sendText(text);
    } catch (error) {
      throw this.remoteFailure(
        session,
        client ?? session.remoteClient,
        error,
        `Could not send text to ${session.host}.`
      );
    }
  }

  async startAssistantVoice(target: DeviceTarget): Promise<number> {
    record({
      layer: 'voice',
      direction: 'call',
      event: 'startAssistantVoice',
      meta: { deviceId: target.deviceId, host: target.host },
    });
    const session = await this.getSession(target);
    let client: RemoteClientPort | undefined;
    try {
      client = await this.ensureConnected(session);
      return await client.startVoiceSession();
    } catch (error) {
      throw this.remoteFailure(
        session,
        client ?? session.remoteClient,
        error,
        `Could not start voice on ${session.host}.`
      );
    }
  }

  async sendAssistantVoiceChunk(deviceId: string, sessionId: number, chunk: Buffer): Promise<void> {
    if (isCaptureEnabled()) {
      recordBuffer('voice', 'tx', 'voiceChunk', chunk, {
        deviceId,
        sessionId,
        byteLength: chunk.byteLength,
      });
    }
    if (!chunk.length) {
      return;
    }
    const remoteClient = this.sessions.get(deviceId.trim())?.remoteClient;
    if (!remoteClient) {
      throw new Error('Connection has been lost.');
    }
    await remoteClient.sendVoiceChunk(sessionId, chunk);
  }

  async stopAssistantVoice(deviceId: string, sessionId: number): Promise<void> {
    record({
      layer: 'voice',
      direction: 'call',
      event: 'stopAssistantVoice',
      meta: { deviceId, sessionId },
    });
    await this.sessions.get(deviceId.trim())?.remoteClient?.stopVoiceSession(sessionId);
  }

  hasPendingAssistantVoiceSession(deviceId: string): Promise<boolean> {
    const remoteClient = this.sessions.get(deviceId.trim())?.remoteClient;
    return Promise.resolve(
      Boolean(remoteClient?.isConnected && remoteClient.snapshot.voiceSessionId !== undefined)
    );
  }
}

/**
 * Factory: construct a fresh bridge. New code ( onward) should prefer this
 * over the singleton so each test gets an isolated session map. Production code
 * continues to use the `androidTvRemoteBridge` singleton below for backward
 * compatibility.
 */
export function createAndroidTvRemoteBridge(): AndroidTvRemoteBridge {
  return new AndroidTvRemoteBridge();
}

// Existing process-wide singleton — preserved for backward compatibility.
export const androidTvRemoteBridge = createAndroidTvRemoteBridge();
