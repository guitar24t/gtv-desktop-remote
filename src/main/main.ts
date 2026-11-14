import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  powerMonitor,
  session,
  Tray,
} from 'electron';

import { showOnboardingOnce } from '../backend/app/onboarding';
import { createNodeFileSystem } from '../backend/core/fileSystem';
import { PreferencesController } from '../backend/preferences';
import { INVOKE_CHANNELS } from '../shared/ipcContract';
import type { UpdaterStatus } from '../shared/types';
import { WINDOW_LAYOUTS, type WindowLayout } from '../shared/windowLayout';

import { captureIpc, closeCapture, initCapture } from './capture';
import { stopDiscovery } from './device/discovery';
import { GoogleTvAdapter } from './device/googleTvAdapter';
import {
  getLogin,
  integrationEnvironment,
  loginSupported,
  microphoneGranted,
  recordIntegrationTrayMenu,
  setLogin,
  showMessageBox,
} from './integrationEnvironment';
import {
  requireCommandDropReport,
  requireCommandRequest,
  requireDeviceDraft,
  requireDeviceId,
  requirePairingRequest,
  requireTextInput,
  requireVoiceChunk,
  requireVoiceSessionId,
  requireWindowLayout,
} from './ipcValidation';
import { getLoggerPath, logError, logInfo } from './logger';
import { commandMetricsStore } from './metrics';
import {
  checkForUpdatesInBackground,
  checkForUpdatesManually,
  getUpdaterStatus,
  installAvailableUpdate,
  relaunchToFinishUpdate,
  rollbackToPreviousVersion,
  subscribeUpdaterStatus,
} from './updater';

declare const _MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;

const DEV_SERVER_ORIGIN = 'http://localhost:5173';
/** A click on the menu-bar icon arrives just after the blur it caused hid the window. */
const TRAY_CLICK_AFTER_BLUR_MS = 400;

let tray: Tray | undefined;
let windowRef: BrowserWindow | undefined;
let windowCreation: Promise<BrowserWindow> | undefined;
let lastBlurHideAt = 0;
let isQuitting = false;
let markBootstrapped: () => void = () => undefined;
const bootstrapped = new Promise<void>((resolve) => {
  markBootstrapped = resolve;
});

const adapter = new GoogleTvAdapter();
const appName = 'GTV Remote';
const preferences = new PreferencesController(
  createNodeFileSystem(),
  path.join(app.getPath('userData'), 'preferences.json'),
  {
    isMac: process.platform === 'darwin',
    register: (shortcut) =>
      globalShortcut.register(shortcut, () => {
        void toggleWindow();
      }),
    unregister: (shortcut) => {
      globalShortcut.unregister(shortcut);
    },
    loginSupported: loginSupported(),
    getLogin,
    setLogin,
  }
);
const hasSingleInstanceLock = app.requestSingleInstanceLock();

function getAssetPath(...parts: string[]) {
  return path.join(app.getAppPath(), 'assets', 'icons', ...parts);
}

function getRendererEntryPath() {
  return path.join(app.getAppPath(), 'dist', 'index.html');
}

function loadsBuiltRenderer(): boolean {
  return app.isPackaged || Boolean(integrationEnvironment);
}

/** True only for the app's own renderer document (built file or dev server). */
function isAppUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (loadsBuiltRenderer()) {
      parsed.hash = '';
      parsed.search = '';
      return parsed.href === pathToFileURL(getRendererEntryPath()).href;
    }
    return parsed.origin === DEV_SERVER_ORIGIN;
  } catch {
    return false;
  }
}

function isMainWindowContents(contents: Electron.WebContents | null | undefined): boolean {
  return Boolean(
    contents && windowRef && !windowRef.isDestroyed() && contents === windowRef.webContents
  );
}

/** Only the remote window's top frame, showing the app's own document, may call the backend. */
function isTrustedSender(event: Electron.IpcMainInvokeEvent): boolean {
  if (!isMainWindowContents(event.sender)) return false;
  const frame = event.senderFrame;
  return frame !== null && frame === event.sender.mainFrame && isAppUrl(frame.url);
}

function hardenWebContents(contents: Electron.WebContents) {
  // The remote never opens windows or leaves its own page. Dropping a file or
  // link on the window would otherwise load it with the full preload bridge.
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const blockForeignNavigation = (event: Electron.Event<{ url: string }>) => {
    if (isAppUrl(event.url)) return;
    event.preventDefault();
    void logInfo('main', 'Blocked navigation away from the app', { url: event.url });
  };
  contents.on('will-navigate', blockForeignNavigation);
  contents.on('will-frame-navigate', blockForeignNavigation);
  contents.on('will-redirect', blockForeignNavigation);
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}

function installPermissionHandlers() {
  // Electron grants every permission by default; the remote only needs the microphone.
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const mediaTypes = 'mediaTypes' in details ? (details.mediaTypes ?? []) : [];
    callback(
      permission === 'media' &&
        isMainWindowContents(contents) &&
        isAppUrl(details.requestingUrl) &&
        mediaTypes.length > 0 &&
        mediaTypes.every((type) => type === 'audio')
    );
  });
  session.defaultSession.setPermissionCheckHandler(
    (contents, permission, _origin, details) =>
      permission === 'media' && isMainWindowContents(contents) && details.mediaType !== 'video'
  );
}

function _loadSvgIcon(size: number) {
  const svg = fs.readFileSync(getAssetPath('gtv-remote-icon.svg'), 'utf8');
  const image = nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
  );

  return image.resize({ width: size, height: size });
}

function loadPngIcon(size: number) {
  const iconPath = getAssetPath('taskbar-icon.png');
  const image = nativeImage.createFromPath(iconPath);

  return image.resize({ width: size, height: size, quality: 'best' });
}

function loadMenubarIcon(size: number) {
  const image = nativeImage.createFromPath(getAssetPath('menubar-icon-white.png'));

  return image.resize({ height: size, quality: 'best' });
}

function createTrayImage() {
  const trayImage = loadMenubarIcon(18);

  if (process.platform === 'darwin') {
    trayImage.setTemplateImage(true);
  }

  return trayImage;
}

function applyApplicationIcon() {
  const iconImage = loadPngIcon(256);

  if (process.platform === 'darwin') {
    app.dock?.setIcon(iconImage);
  }

  return iconImage;
}

function attachWindowDiagnostics(window: BrowserWindow) {
  window.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isMainFrame) void preferences.setShortcutCapture(false);
      void logError('renderer', 'Window failed to load', {
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame,
      });
    }
  );
  window.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) void preferences.setShortcutCapture(false);
  });
  window.webContents.on('destroyed', () => {
    void preferences.setShortcutCapture(false);
  });

  window.webContents.on('render-process-gone', (_event, details) => {
    void preferences.setShortcutCapture(false);
    void logError('renderer', 'Render process exited unexpectedly', details);
    if (isQuitting || window.isDestroyed()) return;
    // A crashed renderer never comes back; keeping the window would make every
    // later show display a blank frame. Replace it, reopening if it was visible.
    const wasVisible = window.isVisible();
    window.destroy();
    if (wasVisible) void showWindow();
  });

  window.webContents.on('unresponsive', () => {
    void preferences.setShortcutCapture(false);
    void logError('renderer', 'Window became unresponsive');
  });

  window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const logger = level >= 2 ? logError : logInfo;
    void logger('renderer-console', message, { level, line, sourceId });
  });
}

async function createWindow(): Promise<BrowserWindow> {
  const iconImage = applyApplicationIcon();
  const window = new BrowserWindow({
    ...WINDOW_LAYOUTS.standard,
    useContentSize: true,
    show: false,
    resizable: false,
    title: appName,
    icon: iconImage,
    // Frameless and transparent so a skin can give the window its own outline
    // (rounded corners, or a remote-shaped body); the renderer paints everything.
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });
  // Renderer bootstrap IPC can arrive while loadFile is still pending.
  windowRef = window;

  window.setSkipTaskbar(true);

  attachWindowDiagnostics(window);
  hardenWebContents(window.webContents);

  const unsubscribeUpdater = subscribeUpdaterStatus((status) => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) {
      return;
    }
    window.webContents.send('updater:statusChanged', status);
  });

  // Lifecycle handlers are attached before loading so a failed or slow load
  // still cleans up and still auto-hides.
  window.on('blur', () => {
    void preferences.setShortcutCapture(false);
    if (!window.webContents.isDevToolsOpened() && window.isVisible()) {
      lastBlurHideAt = Date.now();
      window.hide();
    }
  });

  window.on('closed', () => {
    void preferences.setShortcutCapture(false);
    unsubscribeUpdater();
    if (windowRef === window) {
      windowRef = undefined;
    }
  });

  try {
    if (loadsBuiltRenderer()) {
      await window.loadFile(getRendererEntryPath());
    } else {
      await window.loadURL(DEV_SERVER_ORIGIN);
    }
  } catch (error) {
    if (!window.isDestroyed()) window.destroy();
    throw error;
  }

  return window;
}

/** Concurrent callers (tray, shortcut, relaunch, bootstrap) share one window. */
function ensureWindow(): Promise<BrowserWindow> {
  if (windowRef && !windowRef.isDestroyed()) {
    return Promise.resolve(windowRef);
  }

  windowCreation ??= createWindow().finally(() => {
    windowCreation = undefined;
  });
  return windowCreation;
}

/**
 * Resize the remote window for the current view/skin, keeping its top edge and
 * horizontal center where they are so it does not jump around the screen.
 */
function applyWindowLayout(layout: WindowLayout) {
  const window = windowRef;
  if (!window || window.isDestroyed()) return;
  const { width, height } = WINDOW_LAYOUTS[layout];
  const current = window.getContentBounds();
  if (current.width === width && current.height === height) return;
  window.setContentBounds(
    {
      x: Math.round(current.x + (current.width - width) / 2),
      y: current.y,
      width,
      height,
    },
    false
  );
  if (process.platform === 'darwin') {
    // A transparent window's shadow follows its painted outline; recompute it
    // once the renderer has drawn the new shape.
    setTimeout(() => {
      if (!window.isDestroyed()) window.invalidateShadow();
    }, 150);
  }
}

async function showWindow() {
  try {
    const window = await ensureWindow();
    if (window.isDestroyed()) return;
    window.show();
    if (process.platform === 'darwin') {
      app.focus({ steal: true });
    }
    window.focus();
  } catch (error) {
    await logError('main', 'Could not show the remote window', error);
  }
}

function hideWindow() {
  if (!windowRef || windowRef.isDestroyed()) {
    return;
  }

  windowRef.hide();
}

async function toggleWindow(fromTrayClick = false) {
  let window: BrowserWindow;
  try {
    window = await ensureWindow();
  } catch (error) {
    await logError('main', 'Could not create the remote window', error);
    return;
  }

  if (window.isVisible()) {
    window.hide();
    return;
  }

  // Clicking the menu-bar icon while the remote is open first blurs (and so
  // hides) the window; that click means "hide", not "show again".
  if (fromTrayClick && Date.now() - lastBlurHideAt < TRAY_CLICK_AFTER_BLUR_MS) {
    return;
  }

  await showWindow();
}

function buildContextMenu() {
  return Menu.buildFromTemplate([
    {
      id: 'show-remote',
      label: 'Show Remote',
      click: () => {
        void showWindow();
      },
    },
    {
      id: 'hide-remote',
      label: 'Hide Remote',
      click: () => {
        hideWindow();
      },
    },
    { type: 'separator' },
    {
      id: 'check-updates',
      label: 'Check for Updates…',
      click: () => {
        void handleManualUpdateCheckFromMenu();
      },
    },
    { type: 'separator' },
    {
      id: 'quit',
      label: 'Quit',
      click: () => {
        app.quit();
      },
    },
  ]);
}

function buildApplicationMenu() {
  if (process.platform !== 'darwin') {
    return;
  }

  const appMenu = Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        {
          label: 'About GTV Remote',
          role: 'about',
        },
        { type: 'separator' },
        {
          label: 'Check for Updates…',
          click: () => {
            void handleManualUpdateCheckFromMenu();
          },
        },
        { type: 'separator' },
        {
          label: 'Hide GTV Remote',
          role: 'hide',
        },
        {
          label: 'Hide Others',
          role: 'hideOthers',
        },
        { type: 'separator' },
        {
          label: 'Quit GTV Remote',
          role: 'quit',
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
  ]);

  Menu.setApplicationMenu(appMenu);
}

async function showUpdaterResultDialog(status: UpdaterStatus) {
  if (status.relaunchRequired) {
    const choice = await showMessageBox({
      type: 'info',
      buttons: ['Relaunch now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      icon: loadPngIcon(128),
      title: 'Relaunch to Finish Updating',
      message: status.message,
    });
    if (choice.response === 0) {
      relaunchToFinishUpdate();
    }
    return;
  }

  if (status.stage === 'failed') {
    await showMessageBox({
      type: 'warning',
      buttons: ['OK'],
      defaultId: 0,
      title: 'Update Check',
      message: status.message,
    });
    return;
  }

  if (status.updateInstallable) {
    const choice = await showMessageBox({
      type: 'info',
      buttons: ['Update now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      icon: loadPngIcon(128),
      title: 'Update Available',
      message: `Version ${status.latestVersion ?? 'unknown'} is available.`,
      detail: 'Install now or update later.',
    });

    if (choice.response === 0) {
      await installAvailableUpdate();
    }

    return;
  }

  await showMessageBox({
    type: 'info',
    buttons: ['OK'],
    defaultId: 0,
    title: 'Update Check',
    message: status.message,
  });
}

async function handleManualUpdateCheckFromMenu() {
  const status = await checkForUpdatesManually();
  await showUpdaterResultDialog(status);
}

async function showFirstLaunchHint(activeShortcut: string | null) {
  try {
    await showOnboardingOnce(
      createNodeFileSystem(),
      path.join(app.getPath('userData'), 'onboarding.json'),
      async () => {
        // An app-modal dialog has no remote-window parent: blur auto-hide cannot hide the hint.
        if (process.platform === 'darwin') {
          app.focus({ steal: true });
        }
        const result = await showMessageBox({
          type: 'info',
          title: 'Welcome to GTV Remote',
          message: 'Your remote lives in the menu bar',
          detail: [
            'Look for the GTV Remote icon in the menu bar at the top of your screen. The app does not stay in the Dock.',
            'Click the menu-bar icon to show or hide the remote. Right-click it for Show Remote, Hide Remote, and Quit.',
            'The remote automatically hides when you click away or switch to another app. Hiding it does not quit the app.',
            activeShortcut
              ? `Global shortcut: ${activeShortcut} shows or hides the remote from any app.`
              : 'The global shortcut is unavailable; use the menu-bar icon to show or hide the remote.',
            'To exit completely, right-click the menu-bar icon and choose Quit.',
          ].join('\n\n'),
          buttons: ['Got it'],
          defaultId: 0,
          cancelId: 0,
          icon: loadPngIcon(128),
        });
        return result.response === 0;
      }
    );
  } catch (error) {
    await logError('main', 'Could not show or save first-launch hint', error);
  }
}

function createTray() {
  tray = new Tray(createTrayImage());
  tray.setToolTip(appName);
  const trayMenu = buildContextMenu();
  if (integrationEnvironment) recordIntegrationTrayMenu(trayMenu);
  if (process.platform === 'darwin') {
    // On macOS a menu installed with setContextMenu opens on every click, so the
    // documented left-click toggle never happened. Show it on right-click only.
    tray.on('right-click', () => {
      tray?.popUpContextMenu(trayMenu);
    });
  } else {
    tray.setContextMenu(trayMenu);
  }
  tray.on('click', () => {
    void toggleWindow(true);
  });
}

async function checkMicrophoneAccess() {
  try {
    if (!(await microphoneGranted())) {
      await logInfo('main', 'Microphone access not granted — voice assistant will be unavailable');
    }
  } catch (error) {
    await logError('main', 'Could not check microphone access', error);
  }
}

async function bootstrapApp() {
  buildApplicationMenu();
  if (process.platform === 'darwin') {
    app.dock?.hide();
  }
  installPermissionHandlers();
  // Sockets that were open across sleep or a network change can be half-open and
  // silently swallow key presses; reconnect instead of trusting them.
  powerMonitor.on('resume', () => {
    adapter.handleSystemResume();
  });
  powerMonitor.on('unlock-screen', () => {
    adapter.handleSystemResume();
  });
  // The menu-bar icon comes first so the app is reachable even if later steps stall.
  createTray();
  await preferences.initialize();
  await ensureWindow();
  markBootstrapped();
  await logInfo('main', 'Application bootstrap complete', {
    shortcut: preferences.getState().activeShortcut,
    logPath: getLoggerPath(),
  });
  await showFirstLaunchHint(preferences.getState().activeShortcut);
  await showWindow();
  // Asking macOS for microphone access can show a system prompt; it must not
  // hold up startup (a relaunch during the prompt used to open a second window).
  void checkMicrophoneAccess();

  setTimeout(() => {
    void checkForUpdatesInBackground();
  }, 5_000);
}

app.setName(appName);
process.title = appName;

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    void bootstrapped.then(showWindow);
  });

  app.on('activate', () => {
    void bootstrapped.then(() => {
      void checkForUpdatesInBackground();
      void showWindow();
    });
  });
}

function registerIpc() {
  const ch = INVOKE_CHANNELS;
  const handle = (
    channel: string,
    listener: (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown
  ) => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!isTrustedSender(event)) throw new Error('Untrusted renderer request');
      return listener(event, ...args);
    });
  };
  handle(ch.preferencesGet, () => preferences.refresh());
  handle(ch.preferencesChange, (_event, change) => preferences.change(change));
  handle(ch.preferencesShortcutCapture, (_event, recording) =>
    preferences.setShortcutCapture(recording)
  );
  handle(
    ch.deviceBootstrap,
    captureIpc(ch.deviceBootstrap, async () => adapter.getBootstrapState())
  );
  handle(
    ch.deviceScan,
    captureIpc(ch.deviceScan, async () => adapter.scanForDevices())
  );
  handle(
    ch.deviceSave,
    captureIpc(ch.deviceSave, async (_event: unknown, draft: unknown) =>
      adapter.saveDevice(requireDeviceDraft(draft))
    )
  );
  handle(
    ch.deviceRemove,
    captureIpc(ch.deviceRemove, async (_event: unknown, deviceId: unknown) =>
      adapter.removeDevice(requireDeviceId(deviceId))
    )
  );
  handle(
    ch.deviceReset,
    captureIpc(ch.deviceReset, async () => adapter.resetState())
  );
  handle(
    ch.deviceStartPairing,
    captureIpc(ch.deviceStartPairing, async (_event: unknown, deviceId: unknown) =>
      adapter.startPairing(requireDeviceId(deviceId))
    )
  );
  handle(
    ch.devicePair,
    captureIpc(ch.devicePair, async (_event: unknown, request: unknown) => {
      await adapter.pair(requirePairingRequest(request));
      return undefined;
    })
  );
  handle(
    ch.deviceConnect,
    captureIpc(ch.deviceConnect, async (_event: unknown, deviceId: unknown) =>
      adapter.connect(requireDeviceId(deviceId))
    )
  );
  handle(
    ch.deviceDisconnect,
    captureIpc(ch.deviceDisconnect, async () => adapter.disconnect())
  );
  handle(
    ch.deviceCommand,
    captureIpc(ch.deviceCommand, async (_event: unknown, rawRequest: unknown) => {
      const request = requireCommandRequest(rawRequest);
      commandMetricsStore.recordIpcReceived(request);
      return adapter.sendCommand(request);
    })
  );
  handle(
    ch.metricsRendererDrop,
    captureIpc(ch.metricsRendererDrop, (_event: unknown, report: unknown) => {
      commandMetricsStore.recordRendererDrop(requireCommandDropReport(report));
      return Promise.resolve();
    })
  );
  handle(
    ch.metricsSnapshot,
    captureIpc(ch.metricsSnapshot, () => Promise.resolve(commandMetricsStore.getSnapshot()))
  );
  handle(
    ch.deviceText,
    captureIpc(ch.deviceText, async (_event: unknown, text: unknown) =>
      adapter.sendText(requireTextInput(text))
    )
  );
  handle(
    ch.deviceAssistantVoiceStart,
    captureIpc(ch.deviceAssistantVoiceStart, async () => {
      if (integrationEnvironment && !(await microphoneGranted()))
        throw new Error('Microphone access denied');
      return adapter.startAssistantVoice();
    })
  );
  handle(
    ch.deviceAssistantVoiceChunk,
    captureIpc(
      ch.deviceAssistantVoiceChunk,
      async (_event: unknown, sessionId: unknown, chunkBase64: unknown) =>
        adapter.sendAssistantVoiceChunk(
          requireVoiceSessionId(sessionId),
          requireVoiceChunk(chunkBase64)
        )
    )
  );
  handle(
    ch.deviceAssistantVoiceStop,
    captureIpc(ch.deviceAssistantVoiceStop, async (_event: unknown, sessionId: unknown) =>
      adapter.stopAssistantVoice(requireVoiceSessionId(sessionId))
    )
  );
  handle(
    ch.deviceAssistantVoicePending,
    captureIpc(ch.deviceAssistantVoicePending, async () =>
      adapter.hasPendingAssistantVoiceSession()
    )
  );
  handle(
    ch.deviceCapabilities,
    captureIpc(ch.deviceCapabilities, async () => adapter.getCapabilities())
  );
  handle(
    ch.updaterCheck,
    captureIpc(ch.updaterCheck, async () => checkForUpdatesManually())
  );
  handle(
    ch.updaterCheckBackground,
    captureIpc(ch.updaterCheckBackground, async () => checkForUpdatesInBackground())
  );
  handle(
    ch.updaterStatus,
    captureIpc(ch.updaterStatus, async () => getUpdaterStatus())
  );
  handle(
    ch.updaterInstall,
    captureIpc(ch.updaterInstall, async () => installAvailableUpdate())
  );
  handle(
    ch.updaterRollback,
    captureIpc(ch.updaterRollback, async () => rollbackToPreviousVersion())
  );
  handle(ch.windowSetLayout, (_event, layout) => {
    applyWindowLayout(requireWindowLayout(layout));
    return undefined;
  });
}

if (hasSingleInstanceLock) {
  void app.whenReady().then(async () => {
    try {
      // Packaged apps cannot write inside app.asar; capture to the profile instead.
      initCapture(app.isPackaged ? app.getPath('userData') : path.resolve(__dirname, '..', '..'));
      registerIpc();
      await bootstrapApp();
    } catch (error) {
      await logError('main', 'Application bootstrap failed', error);
      // Without this the process would linger with no window or menu-bar icon while
      // still holding the single-instance lock, so relaunching could not recover.
      if (!integrationEnvironment) {
        dialog.showErrorBox(
          'GTV Remote could not start',
          `${error instanceof Error ? error.message : String(error)}\n\nDetails were written to ${getLoggerPath()}.`
        );
      }
      app.exit(1);
    }
  });
}

process.on('uncaughtException', (error) => {
  void logError('main', 'Uncaught exception', error);
});

process.on('unhandledRejection', (reason) => {
  void logError('main', 'Unhandled rejection', reason);
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopDiscovery();
  closeCapture();
});

app.on('window-all-closed', () => {
  // Keep the app alive in the menu bar.
});
