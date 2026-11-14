import { useEffect, useRef, useState } from 'react';

import { downsampleTo8kMono, toBase64 } from '../shared/audio';
import type {
  BootstrapState,
  DeviceCapabilities,
  DeviceDraft,
  DiscoveredDevice,
  RemoteCommand,
  RemoteCommandSource,
  SavedDevice,
} from '../shared/types';
import type { WindowLayout } from '../shared/windowLayout';

import { Icon } from './components/Icon';
import { useDeviceScanner } from './hooks/useDeviceScanner';
import { usePairingFlow } from './hooks/usePairingFlow';
import { useRemoteSession } from './hooks/useRemoteSession';
import { useUpdaterStatus } from './hooks/useUpdaterStatus';
import { withTimeout } from './lib/async';
import {
  derivePairedNetworkDevices,
  deriveUnpairedNetworkDevices,
  findDiscoveredForSaved as findDiscoveredForSavedPure,
  resolveSelectedDevice,
  type DevicePickerSelection as DevicePickerSelectionFromLib,
} from './lib/deviceSelection';
import { classes, isEditableTarget, sanitizePairCode, shouldRestartPairingFlow } from './lib/pure';
import { allowsKeyRepeat, KEYBOARD_COMMAND_MAP } from './lib/remoteCommands';
import { isRemoteSessionStatus, resolveRemoteError } from './lib/remoteState';
import { Preferences } from './Preferences';
import {
  getRemoteSkin,
  loadSkinId,
  saveSkinId,
  type RemoteSkinId,
  type RemoteSkinProps,
} from './skins';

const initialDraft: DeviceDraft = {
  name: '',
  host: '',
  adbPort: 5555,
  pairingPort: 0,
};

const ASSISTANT_VOICE_MIN_CHUNK_BYTES = 8 * 1024;
const ASSISTANT_VOICE_INITIAL_CHUNK_BYTES = 8 * 1024;
const ASSISTANT_VOICE_STREAM_CHUNK_BYTES = 20 * 1024;
// Upper bounds for voice teardown IPC so a hung call cannot leave voice unable to restart.
const ASSISTANT_VOICE_DRAIN_TIMEOUT_MS = 3000;
const ASSISTANT_VOICE_STOP_TIMEOUT_MS = 3000;
const ASSISTANT_AUDIO_CLOSE_TIMEOUT_MS = 1000;

type DevicePickerSelection = DevicePickerSelectionFromLib;

function getDesktopApi() {
  const api = window.gtvRemote;

  if (!api) {
    throw new Error(
      'Desktop bridge unavailable. Restart the app after the Electron preload finishes compiling.'
    );
  }

  return api;
}

function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    if (typeof window === 'undefined') return 'dark';
    try {
      return window.localStorage.getItem('gtv-remote.theme') === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem('gtv-remote.theme', theme);
    } catch {
      // Ignore storage failures; theme switching still works for this session.
    }
  }, [theme]);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [skinId, setSkinId] = useState<RemoteSkinId>(loadSkinId);
  const skin = getRemoteSkin(skinId);

  useEffect(() => {
    saveSkinId(skinId);
  }, [skinId]);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const [bootstrap, setBootstrap] = useState<BootstrapState>({
    devices: [],
    deviceState: {
      status: 'idle',
      message: 'Loading...',
    },
  });
  const [selectedDeviceKey, setSelectedDeviceKey] = useState('');
  const {
    pairCode,
    setPairCode,
    pairingDeviceId,
    setPairingDeviceId,
    pairingReady,
    setPairingReady,
    pairCodeInputRef,
  } = usePairingFlow();
  const [textInput, setTextInput] = useState('');
  const [textInputOpen, setTextInputOpen] = useState(false);
  const [capabilities, setCapabilities] = useState<DeviceCapabilities>({
    textInput: false,
    powerToggle: true,
  });
  const [devicePickerOpen, setDevicePickerOpen] = useState(true);
  // Non-fatal remote errors (failed key, text, voice, or microphone) are shown here
  // without touching the connection status, which only main can decide.
  const [remoteError, setRemoteError] = useState<string | null>(null);
  // Bumped by every explicit device action. Async results that started under an
  // older value belong to a session the user has since left, so they are ignored.
  const deviceActionEpochRef = useRef(0);
  const remoteSyncRef = useRef<{ running: boolean; pendingMessage: string | null }>({
    running: false,
    pendingMessage: null,
  });
  const { busy, setBusy, handleCommand, clearCommandQueue } = useRemoteSession((error: Error) => {
    reportRemoteError(error);
  });
  const { discoveredDevices, setDiscoveredDevices, scanning, handleScanDevices } =
    useDeviceScanner();
  const [bridgeReady, setBridgeReady] = useState(false);
  const [assistantStatus, setAssistantStatus] = useState<'idle' | 'active' | 'error'>('idle');
  const [dismissedUpdateVersion, setDismissedUpdateVersion] = useState<string | null>(null);
  const [dismissedRollbackVersion, setDismissedRollbackVersion] = useState<string | null>(null);
  const [suppressedRollbackVersion, setSuppressedRollbackVersion] = useState<string | null>(() => {
    if (typeof window === 'undefined') {
      return null;
    }
    try {
      return window.localStorage.getItem('gtv-remote.suppressedRollbackVersion');
    } catch {
      return null;
    }
  });
  const [updaterToast, setUpdaterToast] = useState<string | null>(null);
  const { updaterStatus, setUpdaterStatus, refreshUpdaterStatusInBackground } = useUpdaterStatus(
    bridgeReady,
    suppressedRollbackVersion,
    setSuppressedRollbackVersion,
    dismissedRollbackVersion,
    setDismissedRollbackVersion
  );
  const assistantLongPressTimerRef = useRef<number | null>(null);
  const assistantStartingRef = useRef(false);
  const assistantStoppingRef = useRef(false);
  const assistantActiveRef = useRef(false);
  const assistantSessionTokenRef = useRef(0);
  const assistantVoiceSessionIdRef = useRef<number | null>(null);
  const assistantAudioContextRef = useRef<AudioContext | null>(null);
  const assistantMediaStreamRef = useRef<MediaStream | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const assistantProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const assistantAudioBufferRef = useRef<Uint8Array>(new Uint8Array(0));
  const assistantChunkQueueRef = useRef<Promise<void>>(Promise.resolve());
  const assistantChunkCountRef = useRef(0);
  const assistantFirstChunkSentRef = useRef(false);
  const assistantEpochRef = useRef(0);

  const findDiscoveredForSaved = (savedDevice: { host: string; macAddress?: string }) =>
    findDiscoveredForSavedPure(savedDevice, discoveredDevices);
  const pairedNetworkDevices = derivePairedNetworkDevices(bootstrap.devices, discoveredDevices);
  const unpairedNetworkDevices = deriveUnpairedNetworkDevices(bootstrap.devices, discoveredDevices);
  const selectedDevice: DevicePickerSelection | undefined = resolveSelectedDevice(
    selectedDeviceKey,
    pairedNetworkDevices,
    unpairedNetworkDevices
  );

  const activeSavedDevice = bootstrap.deviceState.activeDeviceId
    ? bootstrap.devices.find((device) => device.id === bootstrap.deviceState.activeDeviceId)
    : undefined;
  const selectedSavedDevice =
    selectedDevice?.kind === 'saved' ? selectedDevice.savedDevice : undefined;
  const currentRemoteDevice = selectedSavedDevice ?? activeSavedDevice;
  const selectedPairedDeviceId = currentRemoteDevice?.id ?? pairingDeviceId;
  const currentRemoteDiscoveredDevice = currentRemoteDevice
    ? findDiscoveredForSaved(currentRemoteDevice)
    : undefined;
  const currentRemoteDeviceName = currentRemoteDiscoveredDevice?.name ?? currentRemoteDevice?.name;
  const _selectedDeviceName =
    currentRemoteDeviceName ??
    (selectedDevice?.kind === 'discovered' ? selectedDevice.discoveredDevice.name : undefined);
  const isConnected = bootstrap.deviceState.status === 'connected';
  const currentView = pairingReady
    ? 'pairing'
    : !devicePickerOpen &&
        currentRemoteDevice &&
        isRemoteSessionStatus(bootstrap.deviceState.status)
      ? 'remote'
      : 'devices';
  // Settings, pairing and the device list always use the standard window; a
  // shaped skin resizes the window only while its remote screen is showing.
  const windowLayout: WindowLayout =
    currentView === 'remote' && !settingsOpen ? skin.layout : 'standard';
  const bridgeDisabled = busy || !bridgeReady;
  const remoteDisabled = bridgeDisabled || !isConnected;
  const frameHeaderClassName = classes(
    'ui-header',
    currentView === 'devices'
      ? 'ui-header-device'
      : currentView === 'pairing'
        ? 'ui-header-pairing'
        : 'ui-header-remote'
  );

  async function refreshState(): Promise<BootstrapState> {
    const nextBootstrap = await getDesktopApi().bootstrap();
    setBootstrap(nextBootstrap);
    return nextBootstrap;
  }

  /**
   * Starts an explicit device action (select, pair, connect, disconnect, forget,
   * reset, or leaving the remote): drops leftover key commands so they cannot
   * reach whichever TV main has active next, clears the remote error banner, and
   * invalidates async results from the previous session.
   */
  function beginDeviceAction(): number {
    deviceActionEpochRef.current += 1;
    clearCommandQueue();
    setRemoteError(null);
    return deviceActionEpochRef.current;
  }

  /** Re-reads saved devices (pairing flags included) from main, keeping the current device state. */
  async function refreshDevicesFromMain() {
    try {
      const { devices } = await getDesktopApi().bootstrap();
      setBootstrap((current) => ({ ...current, devices }));
    } catch {
      // Keep the current list; the next scan or action refreshes it again.
    }
  }

  /**
   * Shows a non-fatal remote error in the remote view, then asks main whether the
   * TV is still connected. Only main's answer can close the remote view.
   * Uses only refs and state setters, so stale closures (hook callbacks, effects)
   * can call it safely.
   */
  function reportRemoteError(error: unknown, epoch = deviceActionEpochRef.current) {
    if (epoch !== deviceActionEpochRef.current) {
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    setRemoteError(message);
    void syncRemoteStateAfterError(message);
  }

  async function syncRemoteStateAfterError(message: string) {
    const sync = remoteSyncRef.current;
    if (sync.running) {
      // Re-check once the in-flight read finishes; main may have changed since it started.
      sync.pendingMessage = message;
      return;
    }

    sync.running = true;
    let nextMessage: string | null = message;
    try {
      while (nextMessage !== null) {
        const errorMessage: string = nextMessage;
        sync.pendingMessage = null;
        const epoch = deviceActionEpochRef.current;
        let mainState: BootstrapState;
        try {
          mainState = await getDesktopApi().bootstrap();
        } catch {
          // Main is unreachable; keep the remote error visible.
          break;
        }

        if (epoch === deviceActionEpochRef.current) {
          const resolution = resolveRemoteError(mainState, errorMessage);
          if (!resolution.stayInRemote) {
            beginDeviceAction();
            setTextInputOpen(false);
          }
          setBootstrap(resolution.bootstrap);
        }
        nextMessage = sync.pendingMessage;
      }
    } finally {
      sync.running = false;
      sync.pendingMessage = null;
    }
  }

  // Wrapped handleScanDevices from the hook to add App-level state updates
  const appHandleScanDevices = async (
    silent = false,
    activeDeviceId = bootstrap.deviceState.activeDeviceId
  ) => {
    try {
      const devices = await handleScanDevices();
      const nextBootstrap = await refreshState();
      const nextSavedDevices = nextBootstrap.devices;
      setSelectedDeviceKey((current) => {
        const validSavedKeys = nextSavedDevices.map((savedDevice) => `saved:${savedDevice.id}`);
        const validDiscoveredKeys = devices.map(
          (device: DiscoveredDevice) => `discovered:${device.id}`
        );

        if (validSavedKeys.includes(current) || validDiscoveredKeys.includes(current)) {
          return current;
        }

        if (activeDeviceId) {
          const resolvedActiveDeviceId = nextBootstrap.deviceState.activeDeviceId ?? activeDeviceId;
          const activeKey = `saved:${resolvedActiveDeviceId}`;
          if (validSavedKeys.includes(activeKey)) {
            return activeKey;
          }
        }

        return '';
      });

      if (!silent) {
        setBootstrap(() => ({
          ...nextBootstrap,
          deviceState: {
            ...nextBootstrap.deviceState,
            status:
              nextBootstrap.deviceState.status === 'error'
                ? 'error'
                : nextBootstrap.deviceState.status,
            message:
              devices.length > 0
                ? `Found ${String(devices.length)} device${devices.length > 1 ? 's' : ''}.`
                : 'No Google TV devices found on the local network.',
          },
        }));
      }
    } catch (error) {
      setBootstrap((current) => ({
        ...current,
        deviceState: {
          status: 'error',
          message: (error as Error).message,
        },
      }));
    }
  };

  useEffect(() => {
    async function initialize() {
      try {
        const [nextBootstrap, nextCapabilities, nextUpdaterStatus] = await Promise.all([
          refreshState(),
          getDesktopApi().capabilities(),
          getDesktopApi().getUpdaterStatus(),
        ]);
        setCapabilities(nextCapabilities);
        setUpdaterStatus(nextUpdaterStatus);
        setBridgeReady(true);
        setDevicePickerOpen(!nextBootstrap.deviceState.activeDeviceId);
        await appHandleScanDevices(true, nextBootstrap.deviceState.activeDeviceId);
      } catch (error) {
        setBridgeReady(false);
        setBootstrap((current) => ({
          ...current,
          deviceState: {
            status: 'error',
            message: (error as Error).message,
          },
        }));
      }
    }

    void initialize();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      void getDesktopApi()
        .setWindowLayout(windowLayout)
        .catch(() => undefined);
    } catch {
      // Bridge unavailable (startup error state); the window keeps its size.
    }
  }, [windowLayout]);

  useEffect(() => {
    if (!selectedDeviceKey && activeSavedDevice) {
      setSelectedDeviceKey(`saved:${activeSavedDevice.id}`);
    }
  }, [activeSavedDevice, selectedDeviceKey]);

  const previousViewRef = useRef(currentView);
  useEffect(() => {
    const previousView = previousViewRef.current;
    previousViewRef.current = currentView;
    if (previousView === 'remote' && currentView !== 'remote') {
      // Nothing queued or still running for the remote session may act after it closes.
      deviceActionEpochRef.current += 1;
      clearCommandQueue();
      setRemoteError(null);
    }
  }, [currentView, clearCommandQueue]);

  useEffect(() => {
    if (!bridgeReady || currentView !== 'devices') {
      return;
    }

    void refreshUpdaterStatusInBackground();
  }, [bridgeReady, currentView, refreshUpdaterStatusInBackground]);

  useEffect(() => {
    if (!bridgeReady) {
      return;
    }

    function syncUpdaterOnForeground() {
      if (document.visibilityState !== 'visible' || currentView !== 'devices') {
        return;
      }

      void refreshUpdaterStatusInBackground();
    }

    window.addEventListener('focus', syncUpdaterOnForeground);
    document.addEventListener('visibilitychange', syncUpdaterOnForeground);

    return () => {
      window.removeEventListener('focus', syncUpdaterOnForeground);
      document.removeEventListener('visibilitychange', syncUpdaterOnForeground);
    };
  }, [bridgeReady, currentView, refreshUpdaterStatusInBackground]);

  useEffect(() => {
    if (pairingReady) {
      pairCodeInputRef.current?.focus();
    }
  }, [pairingReady, pairCodeInputRef]);

  /** Sends a remote key; a new attempt replaces any previous remote error. */
  function sendRemoteCommand(command: RemoteCommand, source?: RemoteCommandSource) {
    setRemoteError(null);
    handleCommand(command, source);
  }

  function clearAssistantLongPressTimer() {
    if (assistantLongPressTimerRef.current !== null) {
      window.clearTimeout(assistantLongPressTimerRef.current);
      assistantLongPressTimerRef.current = null;
    }
  }

  async function stopAssistantSession(captureError?: unknown) {
    clearAssistantLongPressTimer();
    if (assistantStoppingRef.current) {
      return;
    }
    assistantSessionTokenRef.current += 1;
    if (!assistantActiveRef.current) {
      return;
    }

    assistantStoppingRef.current = true;
    assistantActiveRef.current = false;
    const sessionEpoch = assistantEpochRef.current;
    const sessionId = assistantVoiceSessionIdRef.current;
    const sentChunks = assistantChunkCountRef.current;
    let failure = captureError;
    try {
      assistantVoiceSessionIdRef.current = null;
      const remaining = assistantAudioBufferRef.current;
      let chunkQueue = assistantChunkQueueRef.current;
      assistantAudioBufferRef.current = new Uint8Array(0);
      assistantChunkCountRef.current = 0;
      assistantFirstChunkSentRef.current = false;

      const processor = assistantProcessorRef.current;
      const stream = assistantMediaStreamRef.current;
      const context = assistantAudioContextRef.current;
      assistantProcessorRef.current = null;
      assistantMediaStreamRef.current = null;
      assistantAudioContextRef.current = null;

      // 1. Release the microphone before waiting on any IPC, so capture ends now
      //    rather than after queued chunks finish sending.
      try {
        if (processor) {
          // eslint-disable-next-line @typescript-eslint/no-deprecated
          processor.onaudioprocess = null;
          processor.disconnect();
        }
      } catch (error) {
        failure ??= error;
      }
      if (stream) {
        for (const track of stream.getTracks()) {
          track.stop();
        }
      }
      const contextClosed =
        context && context.state !== 'closed'
          ? withTimeout(
              context.close(),
              ASSISTANT_AUDIO_CLOSE_TIMEOUT_MS,
              'Microphone audio did not close.'
            ).catch(() => undefined)
          : Promise.resolve();

      // 2. Drain already-captured PCM, bounded so a hung send cannot block voice forever.
      if (sessionId !== null && remaining.length > 0 && failure === undefined) {
        const finalSize = Math.max(ASSISTANT_VOICE_MIN_CHUNK_BYTES, remaining.length);
        const padded = new Uint8Array(finalSize);
        padded.set(remaining.subarray(0, finalSize));
        chunkQueue = chunkQueue.then(async () => {
          await getDesktopApi().sendAssistantVoiceChunk(sessionId, toBase64(padded));
        });
      }
      try {
        await withTimeout(
          chunkQueue,
          ASSISTANT_VOICE_DRAIN_TIMEOUT_MS,
          'Voice audio took too long to send to the TV.'
        );
      } catch (error) {
        failure ??= error;
      }

      // 3. Backend cleanup must run even when the PCM queue rejected or timed out.
      if (sessionId !== null) {
        try {
          await withTimeout(
            getDesktopApi().stopAssistantVoice(sessionId),
            ASSISTANT_VOICE_STOP_TIMEOUT_MS,
            'The TV took too long to end the voice session.'
          );
        } catch (error) {
          failure ??= error;
        }
      }

      await contextClosed;
    } finally {
      assistantStoppingRef.current = false;
    }

    if (failure !== undefined) {
      setAssistantStatus('error');
      reportRemoteError(failure, sessionEpoch);
    } else {
      setAssistantStatus('idle');
      if (sessionId !== null) {
        setBootstrap((current) => ({
          ...current,
          deviceState: {
            ...current.deviceState,
            message: `Assistant voice sent (${String(sentChunks)} chunk${sentChunks === 1 ? '' : 's'}).`,
          },
        }));
      }
    }
  }

  async function startAssistantSession() {
    if (
      assistantActiveRef.current ||
      assistantStartingRef.current ||
      assistantStoppingRef.current ||
      remoteDisabled ||
      currentView !== 'remote'
    ) {
      return;
    }

    assistantStartingRef.current = true;
    assistantActiveRef.current = true;
    const sessionEpoch = deviceActionEpochRef.current;
    assistantEpochRef.current = sessionEpoch;
    setRemoteError(null);
    const sessionToken = assistantSessionTokenRef.current + 1;
    assistantSessionTokenRef.current = sessionToken;
    assistantChunkQueueRef.current = Promise.resolve();
    assistantAudioBufferRef.current = new Uint8Array(0);
    assistantChunkCountRef.current = 0;
    assistantFirstChunkSentRef.current = false;
    setAssistantStatus('active');

    let sessionId: number | null = null;
    let mediaStream: MediaStream | null = null;
    let audioContext: AudioContext | null = null;
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    let processor: ScriptProcessorNode | null = null;
    let started = false;
    try {
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
      } catch (micError) {
        const isPermissionDenied =
          micError instanceof DOMException &&
          (micError.name === 'NotAllowedError' || micError.name === 'PermissionDeniedError');
        throw new Error(
          isPermissionDenied
            ? 'Microphone access denied. Enable it in System Settings → Privacy & Security → Microphone.'
            : `Microphone unavailable: ${(micError as Error).message}`,
          { cause: micError }
        );
      }
      if (assistantSessionTokenRef.current !== sessionToken) {
        return;
      }

      audioContext = new AudioContext();
      await audioContext.resume();
      if (assistantSessionTokenRef.current !== sessionToken) {
        return;
      }
      if (audioContext.state !== 'running') {
        throw new Error('Microphone audio context could not start.');
      }
      const inputSampleRate = audioContext.sampleRate;
      const source = audioContext.createMediaStreamSource(mediaStream);
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      processor = audioContext.createScriptProcessor(4096, 1, 1);

      // eslint-disable-next-line @typescript-eslint/no-deprecated
      processor.onaudioprocess = (event) => {
        if (
          assistantSessionTokenRef.current !== sessionToken ||
          !assistantActiveRef.current ||
          assistantVoiceSessionIdRef.current === null
        ) {
          return;
        }

        // eslint-disable-next-line @typescript-eslint/no-deprecated
        const input = event.inputBuffer.getChannelData(0);
        const downsampled = downsampleTo8kMono(input, inputSampleRate);
        if (downsampled.length === 0) {
          return;
        }

        const previous = assistantAudioBufferRef.current;
        const merged = new Uint8Array(previous.length + downsampled.length);
        merged.set(previous);
        merged.set(downsampled, previous.length);
        assistantAudioBufferRef.current = merged;

        while (
          assistantAudioBufferRef.current.length >=
          (assistantFirstChunkSentRef.current
            ? ASSISTANT_VOICE_STREAM_CHUNK_BYTES
            : ASSISTANT_VOICE_INITIAL_CHUNK_BYTES)
        ) {
          const nextChunkSize = assistantFirstChunkSentRef.current
            ? ASSISTANT_VOICE_STREAM_CHUNK_BYTES
            : ASSISTANT_VOICE_INITIAL_CHUNK_BYTES;
          const chunk = assistantAudioBufferRef.current.subarray(0, nextChunkSize);
          assistantAudioBufferRef.current = assistantAudioBufferRef.current.subarray(nextChunkSize);
          const activeSessionId = assistantVoiceSessionIdRef.current;
          const payload = new Uint8Array(chunk);

          assistantChunkQueueRef.current = assistantChunkQueueRef.current.then(async () => {
            await getDesktopApi().sendAssistantVoiceChunk(activeSessionId, toBase64(payload));
            if (assistantSessionTokenRef.current === sessionToken) {
              assistantChunkCountRef.current += 1;
              assistantFirstChunkSentRef.current = true;
            }
          });
          void assistantChunkQueueRef.current.catch((error: unknown) => {
            if (assistantSessionTokenRef.current === sessionToken && assistantActiveRef.current) {
              void stopAssistantSession(error);
            }
          });
        }
      };

      source.connect(processor);
      processor.connect(audioContext.destination);
      sessionId = await getDesktopApi().startAssistantVoice();
      if (assistantSessionTokenRef.current !== sessionToken) {
        return;
      }

      assistantVoiceSessionIdRef.current = sessionId;
      assistantMediaStreamRef.current = mediaStream;
      assistantAudioContextRef.current = audioContext;
      assistantProcessorRef.current = processor;
      started = true;
    } catch (error) {
      if (assistantSessionTokenRef.current === sessionToken) {
        assistantActiveRef.current = false;
        setAssistantStatus('error');
        reportRemoteError(error, sessionEpoch);
      }
    } finally {
      try {
        if (!started) {
          try {
            if (processor) {
              // eslint-disable-next-line @typescript-eslint/no-deprecated
              processor.onaudioprocess = null;
              processor.disconnect();
            }
          } finally {
            if (mediaStream) {
              for (const track of mediaStream.getTracks()) {
                track.stop();
              }
            }
            try {
              if (sessionId !== null) {
                await withTimeout(
                  getDesktopApi().stopAssistantVoice(sessionId),
                  ASSISTANT_VOICE_STOP_TIMEOUT_MS,
                  'The TV took too long to end the voice session.'
                ).catch(() => undefined);
              }
            } finally {
              if (audioContext && audioContext.state !== 'closed') {
                await withTimeout(
                  audioContext.close(),
                  ASSISTANT_AUDIO_CLOSE_TIMEOUT_MS,
                  'Microphone audio did not close.'
                ).catch(() => undefined);
              }
            }
          }
        }
      } finally {
        // A cancelled start still owns its resources until this cleanup finishes.
        assistantStartingRef.current = false;
      }
    }
  }

  useEffect(() => {
    if (!bridgeReady || !isConnected || currentView !== 'remote' || assistantActiveRef.current) {
      return;
    }

    const intervalId = window.setInterval(() => {
      if (assistantActiveRef.current) {
        return;
      }

      const sessionToken = assistantSessionTokenRef.current;
      void getDesktopApi()
        .hasPendingAssistantVoiceSession()
        .then((pending) => {
          if (
            pending &&
            assistantSessionTokenRef.current === sessionToken &&
            !assistantActiveRef.current
          ) {
            void startAssistantSession();
          }
        })
        .catch(() => {
          // Ignore polling failures and retry on next interval.
        });
    }, 300);

    return () => {
      window.clearInterval(intervalId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridgeReady, isConnected, currentView]);

  useEffect(() => {
    if (!bridgeReady || !isConnected || currentView !== 'remote') {
      return;
    }

    const intervalId = window.setInterval(() => {
      if (!assistantActiveRef.current || assistantStartingRef.current) {
        return;
      }

      const sessionToken = assistantSessionTokenRef.current;
      void getDesktopApi()
        .hasPendingAssistantVoiceSession()
        .then((pending) => {
          if (
            !pending &&
            assistantSessionTokenRef.current === sessionToken &&
            assistantActiveRef.current &&
            !assistantStartingRef.current
          ) {
            void stopAssistantSession();
          }
        })
        .catch(() => {
          // Ignore polling failures and retry on next interval.
        });
    }, 300);

    return () => {
      window.clearInterval(intervalId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridgeReady, isConnected, currentView]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (settingsOpen || !bridgeReady || !isConnected || currentView !== 'remote') {
        return;
      }

      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      if (isEditableTarget(event.target)) {
        return;
      }

      if (event.key === 'Enter' && assistantActiveRef.current) {
        event.preventDefault();
        void stopAssistantSession();
        return;
      }

      if ((event.key === 'Escape' || event.key === 'Esc') && assistantActiveRef.current) {
        event.preventDefault();
        void stopAssistantSession();
        return;
      }

      if (event.key === 'g' || event.key === 'G') {
        event.preventDefault();

        if (
          event.repeat ||
          assistantLongPressTimerRef.current !== null ||
          assistantActiveRef.current
        ) {
          return;
        }

        void startAssistantSession();
        return;
      }

      if (event.key === 'v' || event.key === 'V') {
        event.preventDefault();
        if (event.repeat) {
          return;
        }

        if (assistantActiveRef.current || assistantStartingRef.current) {
          void stopAssistantSession();
        } else {
          void startAssistantSession();
        }
        return;
      }

      const command = KEYBOARD_COMMAND_MAP[event.key];
      if (!command) {
        return;
      }

      event.preventDefault();
      // A held key auto-repeats; only navigation and volume may act more than once.
      if (event.repeat && !allowsKeyRepeat(command)) {
        return;
      }
      sendRemoteCommand(command, 'keyboard');
    }

    function onKeyUp(event: KeyboardEvent) {
      if (event.key !== 'g' && event.key !== 'G') {
        return;
      }

      if (isEditableTarget(event.target)) {
        return;
      }

      event.preventDefault();
      void stopAssistantSession();
    }

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      clearAssistantLongPressTimer();
      void stopAssistantSession();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsOpen, bridgeReady, isConnected, currentView, remoteDisabled]);

  async function saveDiscoveredDevice(device: DiscoveredDevice): Promise<SavedDevice> {
    const devices = await getDesktopApi().saveDevice({
      name: device.name,
      host: device.host,
      adbPort: device.adbPort ?? initialDraft.adbPort,
      pairingPort: device.pairingPort,
      macAddress: device.macAddress,
      castDeviceId: device.castDeviceId,
      networkHostName: device.networkHostName,
      deviceFingerprint: device.deviceFingerprint,
    });
    const savedDevice = devices.find((item: SavedDevice) => item.host === device.host);

    if (!savedDevice) {
      throw new Error('Saved device could not be resolved after saving.');
    }

    setBootstrap((current) => ({
      ...current,
      devices,
      deviceState: {
        ...current.deviceState,
        status: 'idle',
        message: `Saved ${device.name}.`,
      },
    }));
    setPairingDeviceId(savedDevice.id);
    setSelectedDeviceKey(`saved:${savedDevice.id}`);
    return savedDevice;
  }

  async function startPairingFlow(deviceId: string) {
    const deviceState = await getDesktopApi().startPairing(deviceId);
    setBootstrap((current) => ({ ...current, deviceState }));
    setPairingDeviceId(deviceId);
    setPairingReady(true);
    setDevicePickerOpen(false);
  }

  async function handleSelectSavedDevice(deviceId: string) {
    beginDeviceAction();
    setTextInputOpen(false);
    setPairCode('');
    setPairingReady(false);
    setDevicePickerOpen(false);
    setSelectedDeviceKey(`saved:${deviceId}`);
    setPairingDeviceId(deviceId);

    if (bootstrap.deviceState.activeDeviceId === deviceId && isConnected) {
      // Reuse the live session only if main, the authority, agrees it is still connected.
      setBusy(true);
      try {
        const mainState = await refreshState();
        if (
          mainState.deviceState.status === 'connected' &&
          mainState.deviceState.activeDeviceId === deviceId
        ) {
          return;
        }
      } catch {
        // Fall through and reconnect.
      } finally {
        setBusy(false);
      }
    }

    await handleConnect(deviceId);
  }

  async function handleSelectDiscoveredDevice(device: DiscoveredDevice) {
    beginDeviceAction();
    setTextInputOpen(false);
    setPairCode('');
    setPairingReady(false);
    setDevicePickerOpen(true);
    setBusy(true);
    try {
      const savedDevice = await saveDiscoveredDevice(device);
      setBootstrap((current) => ({
        ...current,
        deviceState: {
          ...current.deviceState,
          status: 'connecting',
          message: `Requesting pairing code from ${savedDevice.name}...`,
        },
      }));
      await startPairingFlow(savedDevice.id);
    } catch (error) {
      setPairingReady(false);
      setDevicePickerOpen(true);
      setBootstrap((current) => ({
        ...current,
        deviceState: {
          status: 'error',
          message: (error as Error).message,
        },
      }));
    } finally {
      setBusy(false);
    }
  }

  async function handlePair() {
    if (!selectedPairedDeviceId || !pairCode.trim()) {
      return;
    }

    const device = bootstrap.devices.find((item) => item.id === selectedPairedDeviceId);
    if (!device) {
      return;
    }

    beginDeviceAction();
    setBusy(true);
    try {
      await getDesktopApi().pair({
        deviceId: device.id,
        host: device.host,
        code: pairCode,
        macAddress: device.macAddress,
      });
      setPairCode('');
      setPairingReady(false);
      setDevicePickerOpen(false);
      setSelectedDeviceKey(`saved:${device.id}`);

      const connectingDeviceState = await getDesktopApi().connect(device.id);
      setBootstrap((current) => ({ ...current, deviceState: connectingDeviceState }));
      // Pick up isPaired from main so the TV is listed under Known Devices, not as new.
      await refreshDevicesFromMain();
    } catch (error) {
      const message = (error as Error).message;
      if (shouldRestartPairingFlow(message)) {
        setPairCode('');
        setPairingReady(false);
        setDevicePickerOpen(true);
      }

      setBootstrap((current) => ({
        ...current,
        deviceState: {
          status: 'error',
          message,
        },
      }));
      // Pairing may have succeeded before the connect failed, or main may have reset isPaired.
      await refreshDevicesFromMain();
    } finally {
      setBusy(false);
    }
  }

  async function handleConnect(deviceId: string) {
    setBusy(true);
    try {
      const deviceState = await getDesktopApi().connect(deviceId);
      setBootstrap((current) => ({ ...current, deviceState }));
      await refreshDevicesFromMain();
    } catch (error) {
      setBootstrap((current) => ({
        ...current,
        deviceState: {
          status: 'error',
          activeDeviceId: deviceId,
          message: (error as Error).message,
        },
      }));
      // Main clears isPaired when the TV rejects the saved certificate, which
      // moves the TV back to New Devices Found so it can be paired again.
      await refreshDevicesFromMain();
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnect() {
    beginDeviceAction();
    setBusy(true);
    try {
      const deviceState = await getDesktopApi().disconnect();
      setBootstrap((current) => ({ ...current, deviceState }));
      setTextInputOpen(false);
    } catch (error) {
      reportRemoteError(error);
    } finally {
      setBusy(false);
    }
  }

  async function handleSendText() {
    if (!textInput.trim()) {
      return;
    }

    const epoch = deviceActionEpochRef.current;
    setRemoteError(null);
    setBusy(true);
    try {
      await getDesktopApi().sendText(textInput);
      setTextInput('');
      setTextInputOpen(false);
      setBootstrap((current) => ({
        ...current,
        deviceState: {
          ...current.deviceState,
          message: 'Text sent.',
        },
      }));
    } catch (error) {
      reportRemoteError(error, epoch);
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(deviceId: string) {
    const epoch = beginDeviceAction();
    setBusy(true);
    try {
      const devices = await getDesktopApi().removeDevice(deviceId);
      let nextBootstrap: BootstrapState;
      try {
        // Main resets its device state when the removed TV was active.
        nextBootstrap = await getDesktopApi().bootstrap();
      } catch {
        nextBootstrap = {
          devices,
          deviceState:
            bootstrap.deviceState.activeDeviceId === deviceId
              ? { status: 'idle', message: 'Device removed.' }
              : bootstrap.deviceState,
        };
      }
      setBootstrap({
        devices: nextBootstrap.devices,
        deviceState: { ...nextBootstrap.deviceState, message: 'Device removed.' },
      });
      setPairingDeviceId((current) => (current === deviceId ? '' : current));
      setPairingReady(false);
      setTextInputOpen(false);
      setDevicePickerOpen(true);
      setSelectedDeviceKey((current) => (current === `saved:${deviceId}` ? '' : current));
    } catch (error) {
      reportRemoteError(error, epoch);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Asks for confirmation, then removes every saved device and pairing certificate.
   * Resolves `true` once reset, `false` if cancelled; failures reject so Settings,
   * where the action lives, can show them.
   */
  async function handleResetState(): Promise<boolean> {
    const confirmed = window.confirm(
      'Reset the app and remove all saved devices and pairing certificates?'
    );
    if (!confirmed) {
      return false;
    }

    beginDeviceAction();
    setBusy(true);
    try {
      const deviceState = await getDesktopApi().resetState();
      setBootstrap({
        devices: [],
        deviceState,
      });
      setDiscoveredDevices([]);
      setSelectedDeviceKey('');
      setPairCode('');
      setPairingDeviceId('');
      setPairingReady(false);
      setTextInput('');
      setTextInputOpen(false);
      setDevicePickerOpen(true);
      return true;
    } finally {
      setBusy(false);
    }
  }

  async function handleInstallUpdate() {
    try {
      const nextStatus = await getDesktopApi().installAvailableUpdate();
      setUpdaterStatus(nextStatus);
    } catch (error) {
      setUpdaterStatus((current) => ({
        ...current,
        inProgress: false,
        stage: 'failed',
        message: (error as Error).message,
      }));
    }
  }

  async function handleRollbackUpdate() {
    try {
      const nextStatus = await getDesktopApi().rollbackToPreviousVersion();
      setUpdaterStatus(nextStatus);
    } catch (error) {
      setUpdaterStatus((current) => ({
        ...current,
        inProgress: false,
        stage: 'failed',
        message: (error as Error).message,
      }));
    }
  }

  function closeSettings() {
    setSettingsOpen(false);
    window.requestAnimationFrame(() => {
      settingsButtonRef.current?.focus();
    });
  }

  function openDevicePicker() {
    beginDeviceAction();
    setTextInputOpen(false);
    setPairingReady(false);
    setPairCode('');
    setDevicePickerOpen(true);
  }

  function renderStatusLabel(savedDevice: SavedDevice, discoveredDevice?: DiscoveredDevice) {
    if (bootstrap.deviceState.activeDeviceId === savedDevice.id && isConnected) {
      return 'Connected';
    }

    if (discoveredDevice) {
      return 'Available';
    }

    return 'Offline';
  }

  function renderUpdaterPanel() {
    const isDismissed =
      updaterStatus.updateInstallable &&
      updaterStatus.latestVersion &&
      dismissedUpdateVersion === updaterStatus.latestVersion;

    if (updaterStatus.updateInstallable && !isDismissed) {
      return (
        <section className="ui-update-panel mt-4">
          <div className="ui-update-head">
            <span className="ui-card-title ui-update-title-centered">Update Available</span>
            <button
              className="ui-update-close"
              onClick={() => {
                setDismissedUpdateVersion(updaterStatus.latestVersion ?? null);
              }}
              aria-label="Close update panel"
            >
              ✕
            </button>
          </div>
          <p className="ui-copy ui-update-copy">
            {updaterStatus.currentVersion} → {updaterStatus.latestVersion}
          </p>
          {updaterStatus.inProgress ? (
            <div className="mt-2 w-full">
              <div className="ui-update-progress-track">
                <div
                  className="ui-update-progress-fill"
                  style={{ width: `${String(updaterStatus.progressPercent ?? 12)}%` }}
                />
              </div>
              <p className="ui-update-meta">
                {updaterStatus.progressPercent !== undefined
                  ? `${String(updaterStatus.progressPercent)}%`
                  : 'Updating'}
                {updaterStatus.etaSeconds !== undefined
                  ? ` • ETA ~${String(updaterStatus.etaSeconds)}s`
                  : ''}
              </p>
            </div>
          ) : null}
          <button
            className="ui-update-action"
            disabled={bridgeDisabled || updaterStatus.inProgress}
            onClick={() => {
              void handleInstallUpdate();
            }}
          >
            {updaterStatus.inProgress ? 'Updating…' : 'Update'}
          </button>
        </section>
      );
    }

    if (updaterStatus.inProgress || updaterStatus.stage === 'checking') {
      return <div className="ui-update-check mt-4">{updaterStatus.message}</div>;
    }

    const rollbackVersion = updaterStatus.rollbackVersion ?? null;
    const isRollbackDismissed =
      !!rollbackVersion &&
      (dismissedRollbackVersion === rollbackVersion ||
        suppressedRollbackVersion === rollbackVersion);

    if (updaterStatus.rollbackAvailable && rollbackVersion && !isRollbackDismissed) {
      return (
        <section className="ui-update-panel mt-4">
          <div className="ui-update-head">
            <span className="ui-card-title ui-update-title-centered">Rollback Available</span>
            <button
              className="ui-update-close"
              onClick={() => {
                setDismissedRollbackVersion(rollbackVersion);
              }}
              aria-label="Close rollback panel"
            >
              ✕
            </button>
          </div>
          <p className="ui-copy ui-update-copy">Restore previous version {rollbackVersion}</p>
          <button
            className="ui-update-action"
            disabled={bridgeDisabled}
            onClick={() => {
              void handleRollbackUpdate();
            }}
          >
            Rollback to v{rollbackVersion}
          </button>
          <button
            type="button"
            className="ui-update-secondary"
            onClick={() => {
              setSuppressedRollbackVersion(rollbackVersion);
              setDismissedRollbackVersion(rollbackVersion);
              try {
                window.localStorage.setItem(
                  'gtv-remote.suppressedRollbackVersion',
                  rollbackVersion
                );
              } catch {
                // Ignore storage failures (e.g. private mode); session dismissal still applies.
              }
            }}
          >
            Don’t show again
          </button>
        </section>
      );
    }

    return (
      <>
        <button
          className="ui-update-check mt-4"
          disabled={bridgeDisabled}
          onClick={() => {
            void getDesktopApi()
              .checkForUpdates()
              .then((nextStatus) => {
                setUpdaterStatus(nextStatus);
                if (!nextStatus.updateInstallable) {
                  setUpdaterToast(nextStatus.message || 'No updates available.');
                  window.setTimeout(() => {
                    setUpdaterToast((current) =>
                      current === (nextStatus.message || 'No updates available.') ? null : current
                    );
                  }, 2600);
                }
              })
              .catch((error: unknown) => {
                const message = (error as Error).message || 'Update check failed.';
                setUpdaterStatus((current) => ({
                  ...current,
                  inProgress: false,
                  stage: 'failed',
                  message,
                }));
                setUpdaterToast(message);
                window.setTimeout(() => {
                  setUpdaterToast((current) => (current === message ? null : current));
                }, 2600);
              });
          }}
        >
          Check for Updates
        </button>
        {updaterToast ? <div className="ui-update-toast">{updaterToast}</div> : null}
      </>
    );
  }

  const updaterPanel = renderUpdaterPanel();

  const remoteSkinProps: RemoteSkinProps = {
    deviceName: currentRemoteDeviceName,
    status: bootstrap.deviceState.status,
    remoteDisabled,
    appDisabled: bridgeDisabled,
    busy,
    errorMessage: remoteError,
    onCommand: (command) => {
      sendRemoteCommand(command);
    },
    assistantListening: assistantStatus === 'active',
    onAssistant: () => {
      if (assistantActiveRef.current || assistantStartingRef.current) {
        void stopAssistantSession();
      } else {
        void startAssistantSession();
      }
    },
    text: {
      supported: capabilities.textInput,
      open: textInputOpen,
      value: textInput,
      onToggle: () => {
        setTextInputOpen((current) => !current);
      },
      onClose: () => {
        setTextInputOpen(false);
      },
      onChange: setTextInput,
      onSend: () => {
        void handleSendText();
      },
    },
    onDevices: openDevicePicker,
    onDisconnect: () => {
      void handleDisconnect();
    },
    onForget: currentRemoteDevice
      ? () => {
          void handleRemove(currentRemoteDevice.id);
        }
      : undefined,
    onSettings: () => {
      setSettingsOpen(true);
    },
  };
  // A full-window skin replaces the app header and frame while its remote shows.
  const fullWindowRemote = currentView === 'remote' && !settingsOpen && skin.fullWindow;

  return (
    <main className={classes('ui-shell', fullWindowRemote && 'ui-shell-bare')}>
      <section className={classes('ui-frame', fullWindowRemote && 'ui-frame-bare')}>
        {settingsOpen ? (
          <Preferences
            skinId={skinId}
            onSkinChange={setSkinId}
            onClose={closeSettings}
            onResetAppState={async () => {
              if (await handleResetState()) {
                // Return to the (now empty) device list so the result is visible.
                closeSettings();
              }
            }}
          />
        ) : fullWindowRemote ? (
          <skin.Component {...remoteSkinProps} />
        ) : (
          <>
            <header className={frameHeaderClassName}>
              {currentView === 'pairing' ? (
                <>
                  <div className="text-xs font-extrabold uppercase tracking-widest text-on-surface">
                    Android TV
                  </div>
                  <div className="flex items-center ui-dragless">
                    <Icon name="devices" className="h-[1.15rem] w-[1.15rem] text-primary-strong" />
                  </div>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="ui-icon-button ui-dragless"
                    aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
                    title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
                    onClick={() => {
                      setTheme((current) => (current === 'dark' ? 'light' : 'dark'));
                    }}
                  >
                    <Icon name={theme === 'dark' ? 'sun' : 'moon'} className="h-5 w-5" />
                  </button>
                  <div className="ui-header-status ui-dragless">
                    {currentView === 'remote' ? (
                      <div
                        className={classes(
                          'ui-status-pill',
                          isConnected && 'ui-status-pill-connected',
                          bootstrap.deviceState.status === 'error' && 'ui-status-pill-error'
                        )}
                      >
                        <span className="ui-pill-text">
                          {isConnected ? 'Connected' : bootstrap.deviceState.status}
                        </span>
                      </div>
                    ) : null}
                  </div>
                </>
              )}
              <button
                ref={settingsButtonRef}
                type="button"
                aria-label="Settings"
                title="Settings"
                className="ui-icon-button ui-header-settings-action ui-dragless"
                onClick={() => {
                  setSettingsOpen(true);
                }}
              >
                <Icon name="settings" className="h-5 w-5" />
              </button>
            </header>

            {currentView === 'devices' ? (
              <div className="ui-screen-scroll">
                <div className="ui-devices-content">
                  <section className="ui-section">
                    <div className="ui-section-row">
                      <h2 className="ui-section-heading">Known Devices</h2>
                      <span className="ui-live-dot" />
                    </div>
                    <div className="ui-list">
                      {pairedNetworkDevices.length === 0 ? (
                        <div className="ui-empty">No paired devices yet.</div>
                      ) : (
                        pairedNetworkDevices.map((option) => {
                          const status = renderStatusLabel(
                            option.savedDevice,
                            option.discoveredDevice
                          );
                          const displayName =
                            option.discoveredDevice?.name ?? option.savedDevice.name;
                          const subtitle =
                            option.discoveredDevice?.model ?? option.savedDevice.host;
                          const isActive =
                            bootstrap.deviceState.activeDeviceId === option.savedDevice.id;

                          return (
                            <button
                              key={option.key}
                              className={classes('ui-card', isActive && 'ui-card-active')}
                              disabled={bridgeDisabled}
                              onClick={() => {
                                void handleSelectSavedDevice(option.savedDevice.id);
                              }}
                            >
                              <div className="ui-card-row">
                                <div
                                  className={classes('ui-avatar', isActive && 'ui-avatar-active')}
                                >
                                  <Icon name="tv" className="h-[1.2rem] w-[1.2rem]" />
                                </div>
                                <div className="ui-card-copy">
                                  <span className="ui-card-title">{displayName}</span>
                                  <span className="ui-card-meta">{subtitle}</span>
                                </div>
                                <span
                                  className={classes(
                                    'ui-badge',
                                    isActive &&
                                      (isConnected ? 'ui-badge-connected' : 'ui-badge-active')
                                  )}
                                >
                                  <span className="ui-pill-text">{status}</span>
                                </span>
                              </div>
                            </button>
                          );
                        })
                      )}
                    </div>
                  </section>

                  <section className="ui-section">
                    <div className="ui-section-row">
                      <h2 className="ui-section-heading">New Devices Found</h2>
                      <button
                        className="ui-icon-button"
                        disabled={bridgeDisabled || scanning}
                        onClick={() => {
                          void appHandleScanDevices(false);
                        }}
                      >
                        <Icon
                          name="refresh"
                          className={`h-5 w-5 ${scanning ? 'animate-spin' : ''}`}
                        />{' '}
                      </button>
                    </div>
                    <div className="ui-list">
                      {unpairedNetworkDevices.length === 0 ? (
                        <div className="ui-empty ui-empty-recessed">
                          No new devices detected right now.
                        </div>
                      ) : (
                        unpairedNetworkDevices.map((device) => (
                          <button
                            key={device.id}
                            className="ui-found-row"
                            disabled={bridgeDisabled}
                            onClick={() => {
                              void handleSelectDiscoveredDevice(device);
                            }}
                          >
                            <div className="ui-found-content">
                              <div className="ui-found-main">
                                <div className="ui-found-icon">
                                  <Icon
                                    name={device.source === 'googlecast' ? 'cast' : 'devices'}
                                    className="h-[1.2rem] w-[1.2rem]"
                                  />
                                </div>
                                <div className="ui-found-copy">
                                  <span className="block text-sm font-bold text-on-surface">
                                    {device.name}
                                  </span>
                                  <span className="block text-[10px] font-medium text-on-surface-variant">
                                    {device.model ?? 'Ready to pair'}
                                  </span>
                                </div>
                              </div>
                              <div className="ui-found-add">
                                <Icon name="plus" className="h-4 w-4" />
                              </div>
                            </div>
                          </button>
                        ))
                      )}
                    </div>
                  </section>

                  <div className="ui-help">
                    <button
                      className="ui-help-chip"
                      disabled={bridgeDisabled || scanning}
                      onClick={() => {
                        void appHandleScanDevices(false);
                      }}
                    >
                      Rescan devices
                    </button>
                  </div>
                </div>

                <div className="ui-devices-footer">{updaterPanel}</div>

                {bootstrap.deviceState.status === 'error' ||
                bootstrap.deviceState.status === 'connecting' ||
                !bridgeReady ? (
                  <div
                    className={classes(
                      'ui-alert',
                      bootstrap.deviceState.status === 'connecting' && 'ui-alert-connecting'
                    )}
                  >
                    {!bridgeReady
                      ? 'Electron bridge not ready yet.'
                      : bootstrap.deviceState.message}
                  </div>
                ) : null}
              </div>
            ) : null}

            {currentView === 'pairing' ? (
              <div className="ui-pair-screen">
                <div className="ui-pair-icon">
                  <Icon name="assistant" className="h-8 w-8 text-primary" />
                </div>
                <h1 className="mb-2 text-3xl font-bold tracking-tight text-on-surface">
                  Enter Code
                </h1>
                <p className="mb-12 text-sm text-on-surface-variant">
                  Type the 6-character pairing code displayed on your Android TV screen.
                </p>

                <button
                  className="ui-code-row"
                  disabled={busy}
                  onClick={() => pairCodeInputRef.current?.focus()}
                >
                  {Array.from({ length: 6 }, (_, index) => {
                    const char = pairCode[index];
                    const filled = Boolean(char);

                    return (
                      <span
                        key={index}
                        className={classes('ui-code-slot', filled && 'ui-code-slot-filled')}
                      >
                        {char ?? '_'}
                      </span>
                    );
                  })}
                </button>
                <input
                  ref={pairCodeInputRef}
                  className="sr-only-input"
                  value={pairCode}
                  onChange={(event) => {
                    // No maxLength: it would cut pasted text such as "AB12 CD" before
                    // separators are stripped. sanitizePairCode caps the result at 6.
                    setPairCode(sanitizePairCode(event.target.value));
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && pairCode.length === 6 && !busy) {
                      void handlePair();
                    }
                  }}
                  autoComplete="one-time-code"
                />

                <div className="ui-action-stack">
                  <button
                    className="ui-primary-button"
                    disabled={
                      busy || !bridgeReady || pairCode.length < 6 || !selectedPairedDeviceId
                    }
                    onClick={() => {
                      void handlePair();
                    }}
                  >
                    <span>Connect</span>
                    <Icon name="cast" className="h-5 w-5" />
                  </button>
                  <button
                    className="ui-secondary-button"
                    disabled={busy}
                    onClick={openDevicePicker}
                  >
                    Cancel
                  </button>
                </div>
                {bootstrap.deviceState.status === 'error' ? (
                  <div className="ui-alert mt-4 w-full">{bootstrap.deviceState.message}</div>
                ) : null}
              </div>
            ) : null}

            {currentView === 'remote' && !skin.fullWindow ? (
              <skin.Component {...remoteSkinProps} />
            ) : null}
          </>
        )}
      </section>
    </main>
  );
}

export default App;
