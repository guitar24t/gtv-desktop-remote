import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AudioOutputLink,
  AudioVolumeEvent,
  BootstrapState,
  CommandDispatchRequest,
  DeviceState,
  DiscoveredDevice,
  PairingRequest,
  SavedDevice,
  UpdaterStatus,
} from '../../shared/types';
import App from '../App';

const savedTv: SavedDevice = {
  id: 'tv-1',
  name: 'Living Room',
  host: '10.0.0.5',
  macAddress: '02:00:00:00:00:01',
  isPaired: true,
};
const discoveredTv: DiscoveredDevice = {
  id: 'disc-1',
  name: 'Living Room',
  host: '10.0.0.5',
  macAddress: '02:00:00:00:00:01',
  source: 'googlecast',
};
const connected: DeviceState = {
  status: 'connected',
  activeDeviceId: 'tv-1',
  message: 'Connected to Living Room.',
};
const updaterStatus: UpdaterStatus = {
  inProgress: false,
  stage: 'idle',
  currentVersion: '1.0.0',
  message: 'Up to date.',
};

/** In-memory stand-in for main: it owns the device list and connection state. */
function createMain(initial: BootstrapState, discovered: DiscoveredDevice[] = [discoveredTv]) {
  const main = { ...structuredClone(initial) };
  const snapshot = (): BootstrapState => structuredClone(main);
  const api = {
    bootstrap: vi.fn(() => Promise.resolve(snapshot())),
    capabilities: vi.fn(() => Promise.resolve({ textInput: true, powerToggle: true })),
    getUpdaterStatus: vi.fn(() => Promise.resolve(updaterStatus)),
    checkForUpdatesInBackground: vi.fn(() => Promise.resolve(updaterStatus)),
    onUpdaterStatus: vi.fn(() => () => undefined),
    scanDevices: vi.fn(() => Promise.resolve(discovered)),
    saveDevice: vi.fn((draft: { name: string; host: string; macAddress?: string }) => {
      main.devices = [
        ...main.devices.filter((device) => device.host !== draft.host),
        { id: 'tv-1', name: draft.name, host: draft.host, macAddress: draft.macAddress },
      ];
      return Promise.resolve(snapshot().devices);
    }),
    startPairing: vi.fn(() => {
      main.deviceState = { status: 'idle', message: 'Enter the code.' };
      return Promise.resolve(snapshot().deviceState);
    }),
    pair: vi.fn((request: PairingRequest) => {
      main.devices = main.devices.map((device) =>
        device.id === request.deviceId ? { ...device, isPaired: true } : device
      );
      main.deviceState = { status: 'idle', message: 'Pairing succeeded.' };
      return Promise.resolve();
    }),
    connect: vi.fn((deviceId: string) => {
      main.deviceState = { status: 'connected', activeDeviceId: deviceId, message: 'Connected.' };
      return Promise.resolve(snapshot().deviceState);
    }),
    disconnect: vi.fn(() => {
      main.deviceState = { status: 'idle', message: 'Disconnected.' };
      return Promise.resolve(snapshot().deviceState);
    }),
    removeDevice: vi.fn((deviceId: string) => {
      main.devices = main.devices.filter((device) => device.id !== deviceId);
      if (main.deviceState.activeDeviceId === deviceId) {
        main.deviceState = { status: 'idle', message: 'Ready.' };
      }
      return Promise.resolve(snapshot().devices);
    }),
    resetState: vi.fn(() => {
      main.devices = [];
      main.deviceState = { status: 'idle', message: 'App state reset. Pair your devices again.' };
      return Promise.resolve(snapshot().deviceState);
    }),
    getPreferences: vi.fn(() =>
      Promise.resolve({
        shortcut: 'CommandOrControl+Shift+G',
        activeShortcut: 'CommandOrControl+Shift+G',
        shortcutError: null,
        launchAtLogin: false,
        launchAtLoginError: null,
        launchAtLoginSupported: true,
      })
    ),
    sendCommand: vi.fn((_request: CommandDispatchRequest) => Promise.resolve()),
    recordCommandDrop: vi.fn(() => Promise.resolve()),
    sendText: vi.fn((_text: string) => Promise.resolve()),
    startAssistantVoice: vi.fn(() => Promise.resolve(7)),
    sendAssistantVoiceChunk: vi.fn((_sessionId: number, _chunk: string) => Promise.resolve()),
    stopAssistantVoice: vi.fn((_sessionId: number) => Promise.resolve()),
    hasPendingAssistantVoiceSession: vi.fn(() => Promise.resolve(false)),
    setWindowLayout: vi.fn((_layout: string) => Promise.resolve()),
    discoverAudioOutputs: vi.fn(() =>
      Promise.resolve([
        {
          kind: 'sonos' as const,
          id: 'RINCON_000000000A0101400',
          name: 'Living Room',
          host: '10.0.0.10',
        },
        {
          kind: 'sonos' as const,
          id: 'RINCON_000000000B0101400',
          name: 'Office',
          host: '10.0.0.20',
        },
      ])
    ),
    setAudioOutput: vi.fn((deviceId: string, link: AudioOutputLink | null) => {
      main.devices = main.devices.map((device) => {
        if (device.id !== deviceId) return device;
        if (link) return { ...device, audioOutput: link };
        const { audioOutput: _removed, ...rest } = device;
        return rest;
      });
      return Promise.resolve(snapshot().devices);
    }),
    audioVolumeListeners: [] as ((event: AudioVolumeEvent) => void)[],
    onAudioVolume: vi.fn((listener: (event: AudioVolumeEvent) => void) => {
      api.audioVolumeListeners.push(listener);
      return () => undefined;
    }),
  };
  vi.stubGlobal('gtvRemote', api);
  return { api, main };
}

async function renderConnectedRemote() {
  const harness = createMain({ devices: [savedTv], deviceState: connected });
  const view = render(<App />);
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Select' })).toBeEnabled();
  });
  // Let the startup scan finish so it cannot race the test.
  await waitFor(() => {
    expect(harness.api.scanDevices).toHaveBeenCalled();
  });
  await act(async () => {
    await Promise.resolve();
  });
  return { ...harness, view };
}

function control(container: HTMLElement, selector: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
}

function stubMicrophone(getUserMedia: () => Promise<MediaStream>) {
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: vi.fn(getUserMedia) },
    configurable: true,
  });
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: AudioContextState = 'suspended';
  sampleRate = 8000;
  destination = {};
  processor = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    onaudioprocess: null as ((event: unknown) => void) | null,
  };
  resume = vi.fn(() => {
    this.state = 'running';
    return Promise.resolve();
  });
  close = vi.fn(() => {
    this.state = 'closed';
    return Promise.resolve();
  });
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn() }));
  createScriptProcessor = vi.fn(() => this.processor);
  constructor() {
    FakeAudioContext.instances.push(this);
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  Reflect.deleteProperty(navigator, 'mediaDevices');
  FakeAudioContext.instances = [];
});

describe('non-fatal remote errors', () => {
  it('keeps the remote open with a banner when a key fails while main is still connected', async () => {
    const { api, view } = await renderConnectedRemote();
    const bootstrapsBefore = api.bootstrap.mock.calls.length;
    api.sendCommand.mockRejectedValueOnce(new Error('Could not send up to 10.0.0.5.'));

    fireEvent.click(control(view.container, '.ui-dpad-up'));

    expect(await screen.findByText('Could not send up to 10.0.0.5.')).toHaveClass('ui-alert');
    await waitFor(() => {
      expect(api.bootstrap.mock.calls.length).toBeGreaterThan(bootstrapsBefore);
    });
    expect(screen.getByRole('button', { name: 'Select' })).toBeEnabled();
    expect(screen.queryByRole('heading', { name: 'Known Devices' })).not.toBeInTheDocument();
  });

  it('leaves the remote only when main reports the TV is no longer connected', async () => {
    const { api, main, view } = await renderConnectedRemote();
    api.sendCommand.mockImplementationOnce(() => {
      main.deviceState = { status: 'idle', message: 'Disconnected.' };
      return Promise.reject(new Error('No active device connected.'));
    });

    fireEvent.click(control(view.container, '.ui-dpad-up'));

    expect(await screen.findByRole('heading', { name: 'Known Devices' })).toBeInTheDocument();
    expect(screen.getByText('No active device connected.')).toHaveClass('ui-alert');
  });

  it('keeps the remote and the typed text when sending text fails', async () => {
    const { api } = await renderConnectedRemote();
    api.sendText.mockRejectedValueOnce(new Error('Text input is not available.'));

    fireEvent.click(screen.getByRole('button', { name: 'Text' }));
    fireEvent.change(screen.getByPlaceholderText('Type text to send to the TV'), {
      target: { value: 'hello' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send Text' }));

    expect(await screen.findByText('Text input is not available.')).toHaveClass('ui-alert');
    expect(screen.getByPlaceholderText('Type text to send to the TV')).toHaveValue('hello');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Select' })).toBeEnabled();
    });
  });

  it('keeps the remote when microphone access is denied', async () => {
    const { view } = await renderConnectedRemote();
    stubMicrophone(() => Promise.reject(new DOMException('denied', 'NotAllowedError')));

    fireEvent.click(control(view.container, '.ui-media-subgrid button'));

    expect(await screen.findByText(/Microphone access denied/)).toHaveClass('ui-alert');
    expect(screen.queryByLabelText('Assistant listening')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select' })).toBeEnabled();
  });
});

describe('voice teardown', () => {
  it('stops the microphone before draining, times out a hung chunk, and can start again', async () => {
    const { api, view } = await renderConnectedRemote();
    const track = { stop: vi.fn() };
    stubMicrophone(() => Promise.resolve({ getTracks: () => [track] } as unknown as MediaStream));
    vi.stubGlobal('AudioContext', FakeAudioContext);
    let voiceOpen = false;
    api.startAssistantVoice.mockImplementation(() => {
      voiceOpen = true;
      return Promise.resolve(7);
    });
    api.stopAssistantVoice.mockImplementation(() => {
      voiceOpen = false;
      return Promise.resolve();
    });
    api.hasPendingAssistantVoiceSession.mockImplementation(() => Promise.resolve(voiceOpen));
    api.sendAssistantVoiceChunk.mockImplementation(() => new Promise<void>(() => undefined));
    const assistant = control(view.container, '.ui-media-subgrid button');

    fireEvent.click(assistant);
    await waitFor(() => {
      expect(api.startAssistantVoice).toHaveBeenCalledTimes(1);
    });
    const context = FakeAudioContext.instances[0];
    if (!context) throw new Error('No audio context');
    // Let startAssistantSession record the session id that capture streams to.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    act(() => {
      context.processor.onaudioprocess?.({
        inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.25) },
      });
    });
    await waitFor(() => {
      expect(api.sendAssistantVoiceChunk).toHaveBeenCalledTimes(1);
    });

    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.click(assistant);

    // The microphone is released while the chunk is still in flight.
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(context.processor.disconnect).toHaveBeenCalled();
    expect(api.stopAssistantVoice).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await waitFor(() => {
      expect(api.stopAssistantVoice).toHaveBeenCalledWith(7);
    });
    expect(await screen.findByText('Voice audio took too long to send to the TV.')).toHaveClass(
      'ui-alert'
    );
    expect(context.close).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Select' })).toBeEnabled();
    vi.useRealTimers();

    fireEvent.click(assistant);
    await waitFor(() => {
      expect(api.startAssistantVoice).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByLabelText('Assistant listening')).toBeInTheDocument();
  });
});

describe('keyboard repeat', () => {
  it('ignores auto-repeat for toggles but repeats navigation and volume', async () => {
    const { api } = await renderConnectedRemote();
    const sent = () => api.sendCommand.mock.calls.map(([request]) => request.command);

    for (const key of ['p', 'P', ' ', 'Enter', 'Escape', 'h', 'k', 'Backspace']) {
      fireEvent.keyDown(window, { key, repeat: true });
    }
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.sendCommand).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: 'p' });
    fireEvent.keyDown(window, { key: 'ArrowUp', repeat: true });
    fireEvent.keyDown(window, { key: '+', repeat: true });
    fireEvent.keyDown(window, { key: '-', repeat: true });
    await waitFor(() => {
      expect(sent()).toEqual(['power', 'up', 'volume_up', 'volume_down']);
    });
  });
});

describe('command queue lifetime', () => {
  it('drops queued keys on disconnect and keeps the Disconnected state', async () => {
    const { api, view } = await renderConnectedRemote();
    let failInFlight!: (error: Error) => void;
    api.sendCommand.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          failInFlight = reject;
        })
    );

    fireEvent.click(control(view.container, '.ui-dpad-up'));
    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByRole('heading', { name: 'Known Devices' })).toBeInTheDocument();

    await act(async () => {
      failInFlight(new Error('No active device connected.'));
      await Promise.resolve();
    });
    expect(api.sendCommand).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector('.ui-alert')).toBeNull();
  });
});

describe('pairing and connecting refresh devices from main', () => {
  it('lists a just-paired TV under Known Devices instead of New Devices Found', async () => {
    const { api } = createMain({ devices: [], deviceState: { status: 'idle', message: 'Ready.' } });
    const view = render(<App />);
    const found = await waitFor(() => control(view.container, '.ui-found-row'));
    fireEvent.click(found);

    const input = await waitFor(() =>
      control(view.container, 'input[autocomplete="one-time-code"]')
    );
    fireEvent.change(input, { target: { value: 'AB12CD' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Select' })).toBeEnabled();
    });
    expect(api.pair).toHaveBeenCalledWith(expect.objectContaining({ code: 'AB12CD' }));

    fireEvent.click(screen.getByRole('button', { name: 'Devices' }));
    const known = await screen.findByRole('heading', { name: 'Known Devices' });
    const knownSection = known.closest('section');
    if (!knownSection) throw new Error('Known Devices section missing');
    expect(within(knownSection).getByText('Living Room')).toBeInTheDocument();
    expect(view.container.querySelector('.ui-found-row')).toBeNull();
  });

  it('moves a TV back to New Devices Found when connecting reveals it must be paired again', async () => {
    const { api, main } = createMain({
      devices: [savedTv],
      deviceState: { status: 'idle', message: 'Ready.' },
    });
    const message =
      'The TV rejected the saved pairing certificate. Start pairing again. If this keeps happening, remove this remote from the TV and pair again.';
    api.connect.mockImplementationOnce(() => {
      main.devices = main.devices.map((device) => ({ ...device, isPaired: false }));
      main.deviceState = { status: 'error', message };
      return Promise.reject(new Error(message));
    });
    const view = render(<App />);
    const card = await waitFor(() => control(view.container, '.ui-card'));
    await waitFor(() => {
      expect(card).toBeEnabled();
    });

    fireEvent.click(card);

    expect(await screen.findByText(message)).toHaveClass('ui-alert');
    await waitFor(() => {
      expect(view.container.querySelector('.ui-found-row')).not.toBeNull();
    });
    expect(screen.getByText('No paired devices yet.')).toBeInTheDocument();
  });
});

describe('forget', () => {
  it('shows a removal failure in the remote and releases busy', async () => {
    const { api } = await renderConnectedRemote();
    api.removeDevice.mockRejectedValueOnce(new Error('Could not remove the pairing.'));

    fireEvent.click(screen.getByRole('button', { name: 'Forget' }));

    expect(await screen.findByText('Could not remove the pairing.')).toHaveClass('ui-alert');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Forget' })).toBeEnabled();
    });
    expect(screen.getByRole('button', { name: 'Select' })).toBeEnabled();
  });

  it('adopts main state after removing the connected TV', async () => {
    const { api } = await renderConnectedRemote();
    const bootstrapsBefore = api.bootstrap.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: 'Forget' }));

    expect(await screen.findByText('No paired devices yet.')).toBeInTheDocument();
    expect(api.bootstrap.mock.calls.length).toBeGreaterThan(bootstrapsBefore);
    expect(screen.queryByText('Connected')).not.toBeInTheDocument();
  });
});

describe('scanning', () => {
  it('disables rescan while a scan is running', async () => {
    let finishScan!: (devices: DiscoveredDevice[]) => void;
    const { api } = createMain({ devices: [], deviceState: { status: 'idle', message: 'Ready.' } });
    api.scanDevices.mockImplementation(
      () =>
        new Promise<DiscoveredDevice[]>((resolve) => {
          finishScan = resolve;
        })
    );
    render(<App />);
    const rescan = await screen.findByRole('button', { name: 'Rescan devices' });
    await waitFor(() => {
      expect(api.scanDevices).toHaveBeenCalledTimes(1);
    });
    expect(rescan).toBeDisabled();

    await act(async () => {
      finishScan([discoveredTv]);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(rescan).toBeEnabled();
    });
    fireEvent.click(rescan);
    expect(rescan).toBeDisabled();
    await waitFor(() => {
      expect(api.scanDevices).toHaveBeenCalledTimes(2);
    });
  });
});

describe('pairing code entry', () => {
  it('keeps all six hex characters of a pasted code with separators', async () => {
    createMain({ devices: [], deviceState: { status: 'idle', message: 'Ready.' } });
    const view = render(<App />);
    fireEvent.click(await waitFor(() => control(view.container, '.ui-found-row')));
    const input = await waitFor(() =>
      control(view.container, 'input[autocomplete="one-time-code"]')
    );
    expect(input).not.toHaveAttribute('maxLength');

    fireEvent.change(input, { target: { value: 'AB12 CD' } });

    expect(input).toHaveValue('AB12CD');
    expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled();
  });
});

describe('reset lives in Settings', () => {
  const idle: DeviceState = { status: 'idle', message: 'Ready.' };

  async function openSettings() {
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    return screen.findByRole('button', { name: 'Reset App State' });
  }

  it('offers Rescan devices on the device list and no reset button there', async () => {
    const { api } = createMain({ devices: [savedTv], deviceState: idle });
    render(<App />);
    // Let startup (bootstrap, updater subscription, first scan) settle before asserting.
    expect(await screen.findByText('Living Room')).toBeInTheDocument();
    await waitFor(() => {
      expect(api.scanDevices).toHaveBeenCalled();
    });
    expect(await screen.findByRole('button', { name: 'Rescan devices' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Reset App State' })).toBeNull();
    expect(screen.queryByRole('button', { name: "Don't see your device?" })).toBeNull();
  });

  it('keeps everything when the confirmation is cancelled', async () => {
    const { api } = createMain({ devices: [savedTv], deviceState: idle });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<App />);
    fireEvent.click(await openSettings());
    await waitFor(() => {
      expect(confirm).toHaveBeenCalledTimes(1);
    });
    expect(api.resetState).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
  });

  it('resets after confirmation and returns to the empty device list', async () => {
    const { api } = createMain({ devices: [savedTv], deviceState: idle });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<App />);
    expect(await screen.findByText('Living Room')).toBeInTheDocument();
    fireEvent.click(await openSettings());
    await waitFor(() => {
      expect(api.resetState).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByRole('button', { name: 'Rescan devices' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Settings' })).toBeNull();
    expect(screen.getByText('No paired devices yet.')).toBeInTheDocument();
  });

  it('shows a reset failure inside Settings', async () => {
    const { api } = createMain({ devices: [savedTv], deviceState: idle });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    api.resetState.mockRejectedValueOnce(new Error('Could not remove certificates.'));
    render(<App />);
    const reset = await openSettings();
    fireEvent.click(reset);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not remove certificates.');
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(reset).toBeEnabled();
  });
});

describe('remote skins', () => {
  async function settle(api: ReturnType<typeof createMain>['api']) {
    await waitFor(() => {
      expect(api.scanDevices).toHaveBeenCalled();
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('uses the Classic skin and the standard window by default', async () => {
    const { api } = await renderConnectedRemote();
    expect(screen.getByRole('button', { name: 'Select' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Rewind' })).toBeNull();
    expect(api.setWindowLayout).toHaveBeenLastCalledWith('standard');
  });

  it('switches to SHIELD from Settings, remembers it, and shapes the window for the remote', async () => {
    const { api } = await renderConnectedRemote();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    await screen.findByRole('heading', { name: 'Settings' });
    expect(api.setWindowLayout).toHaveBeenLastCalledWith('standard');

    fireEvent.click(screen.getByRole('radio', { name: /SHIELD/ }));
    expect(window.localStorage.getItem('gtv-remote.skin')).toBe('shield');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(await screen.findByRole('button', { name: 'Rewind' })).toBeEnabled();
    await waitFor(() => {
      expect(api.setWindowLayout).toHaveBeenLastCalledWith('shield');
    });
    // The full-window skin replaces the app header.
    expect(screen.queryByRole('button', { name: /Switch to (light|dark) theme/ })).toBeNull();
  });

  it('sends every SHIELD key, including the new media keys', async () => {
    window.localStorage.setItem('gtv-remote.skin', 'shield');
    const { api } = createMain({ devices: [savedTv], deviceState: connected });
    render(<App />);
    await settle(api);
    const keys = [
      ['Power', 'power'],
      ['TV settings', 'menu'],
      ['Up', 'up'],
      ['Left', 'left'],
      ['Right', 'right'],
      ['Down', 'down'],
      ['Select', 'select'],
      ['Back', 'back'],
      ['Home', 'home'],
      ['Fast-forward', 'fast_forward'],
      ['Play/Pause', 'play_pause'],
      ['Rewind', 'rewind'],
      ['Volume up', 'volume_up'],
      ['Volume down', 'volume_down'],
      ['Mute', 'mute'],
    ] as const;
    for (const [label] of keys) {
      fireEvent.click(await screen.findByRole('button', { name: label }));
    }
    await waitFor(() => {
      expect(api.sendCommand).toHaveBeenCalledTimes(keys.length);
    });
    expect(api.sendCommand.mock.calls.map(([request]) => request.command)).toEqual(
      keys.map(([, command]) => command)
    );
  });

  it('keeps app actions reachable from the SHIELD dock', async () => {
    window.localStorage.setItem('gtv-remote.skin', 'shield');
    const { api } = createMain({ devices: [savedTv], deviceState: connected });
    render(<App />);
    await settle(api);

    fireEvent.click(await screen.findByRole('button', { name: 'Text' }));
    fireEvent.change(screen.getByPlaceholderText('Type text to send to the TV'), {
      target: { value: 'hello' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send Text' }));
    await waitFor(() => {
      expect(api.sendText).toHaveBeenCalledWith('hello');
    });

    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => {
      expect(api.disconnect).toHaveBeenCalledTimes(1);
    });
    // Back on the device list, the window returns to the standard size.
    await waitFor(() => {
      expect(api.setWindowLayout).toHaveBeenLastCalledWith('standard');
    });
  });

  it('sends media keys from the keyboard', async () => {
    const { api } = await renderConnectedRemote();
    fireEvent.keyDown(window, { key: '[' });
    fireEvent.keyDown(window, { key: ']' });
    fireEvent.keyDown(window, { key: 'm' });
    await waitFor(() => {
      expect(api.sendCommand).toHaveBeenCalledTimes(3);
    });
    expect(api.sendCommand.mock.calls.map(([request]) => request.command)).toEqual([
      'rewind',
      'fast_forward',
      'mute',
    ]);
  });
});

describe('TV audio (speaker links)', () => {
  const idle: DeviceState = { status: 'idle', message: 'Ready.' };
  const living: AudioOutputLink = {
    enabled: true,
    kind: 'sonos',
    id: 'RINCON_000000000A0101400',
    name: 'Living Room',
    host: '10.0.0.10',
    volumeStep: 2,
  };

  async function openSettings() {
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    await screen.findByRole('heading', { name: 'TV audio' });
  }

  it('links a paired TV’s volume keys to a Sonos room found on the network', async () => {
    const { api } = createMain({ devices: [savedTv], deviceState: idle });
    render(<App />);
    await openSettings();
    expect(await screen.findByText('2 Sonos rooms found.')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox', { name: 'Volume keys for Living Room' }), {
      target: { value: 'RINCON_000000000A0101400' },
    });
    await waitFor(() => {
      expect(api.setAudioOutput).toHaveBeenCalledWith('tv-1', living);
    });
    expect(
      await screen.findByRole('checkbox', { name: 'Use Living Room for volume' })
    ).toBeChecked();
  });

  it('switches a link off without unlinking, changes its step, and unlinks back to the TV', async () => {
    const { api } = createMain({
      devices: [{ ...savedTv, audioOutput: living }],
      deviceState: idle,
    });
    render(<App />);
    await openSettings();
    await screen.findByText('2 Sonos rooms found.');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Use Living Room for volume' }));
    await waitFor(() => {
      expect(api.setAudioOutput).toHaveBeenLastCalledWith('tv-1', { ...living, enabled: false });
    });
    fireEvent.change(await screen.findByRole('combobox', { name: 'Volume step for Living Room' }), {
      target: { value: '5' },
    });
    await waitFor(() => {
      expect(api.setAudioOutput).toHaveBeenLastCalledWith('tv-1', {
        ...living,
        enabled: false,
        volumeStep: 5,
      });
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Volume keys for Living Room' }), {
      target: { value: 'tv' },
    });
    await waitFor(() => {
      expect(api.setAudioOutput).toHaveBeenLastCalledWith('tv-1', null);
    });
    await waitFor(() => {
      expect(screen.queryByRole('checkbox', { name: /for volume/ })).toBeNull();
    });
  });

  it('keeps a linked speaker that is not found right now selectable', async () => {
    const { api } = createMain({
      devices: [
        { ...savedTv, audioOutput: { ...living, id: 'RINCON_000000000C0101400', name: 'Den' } },
      ],
      deviceState: idle,
    });
    render(<App />);
    await openSettings();
    await waitFor(() => {
      expect(api.discoverAudioOutputs).toHaveBeenCalled();
    });
    expect(
      await screen.findByRole('option', { name: 'Den (not found right now)' })
    ).toBeInTheDocument();
  });

  it('asks you to pair a TV first when none is paired', async () => {
    const { api } = createMain({ devices: [], deviceState: idle });
    render(<App />);
    await openSettings();
    expect(screen.getByText('Pair a TV to set up its audio.')).toBeInTheDocument();
    expect(api.discoverAudioOutputs).not.toHaveBeenCalled();
  });

  it('shows the speaker’s volume on the remote and labels Classic’s volume keys', async () => {
    const harness = createMain({
      devices: [{ ...savedTv, audioOutput: living }],
      deviceState: connected,
    });
    render(<App />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Select' })).toBeEnabled();
    });
    expect(screen.getByText('Sonos')).toBeInTheDocument();

    act(() => {
      for (const listener of harness.api.audioVolumeListeners)
        listener({ deviceId: 'tv-1', outputName: 'Living Room', volume: 24 });
    });
    expect(await screen.findByText('Living Room · 24')).toBeInTheDocument();
    act(() => {
      for (const listener of harness.api.audioVolumeListeners)
        listener({ deviceId: 'tv-1', outputName: 'Living Room', muted: true, volume: 24 });
    });
    expect(await screen.findByText('Living Room muted')).toBeInTheDocument();
  });
});
