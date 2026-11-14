import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { test, expect, repository, type AppHarness } from './app-harness';
import { ReleaseServer } from './platform-fixtures/release-server';

async function dialogState(h: AppHarness) {
  return JSON.parse(await readFile(path.join(h.profile, 'dialogs.json'), 'utf8')) as {
    responses: number[];
    requests: { buttons: string[]; detail?: string }[];
  };
}

async function expectDialogsConsumed(h: AppHarness, buttons: string[][]) {
  await expect.poll(async () => (await dialogState(h)).responses).toEqual([]);
  expect(
    (await dialogState(h)).requests.slice(-buttons.length).map((request) => request.buttons)
  ).toEqual(buttons);
}

async function installedFiles(bundle: string) {
  return Promise.all([
    readFile(path.join(bundle, 'Contents', 'Info.plist'), 'utf8'),
    readFile(path.join(bundle, 'Contents', 'MacOS', 'GTV Remote'), 'utf8'),
  ]);
}

/** Hidden staged/aside bundles beside the installed app, plus leftover update work directories. */
async function leftovers(h: AppHarness) {
  const hidden = (await readdir(path.join(h.profile, 'installed'))).filter((name) =>
    name.startsWith('.')
  );
  const work = await readdir(path.join(h.profile, 'update-tmp')).catch(() => []);
  return [...hidden, ...work];
}

async function nativeOperations(h: AppHarness) {
  return (
    JSON.parse(await readFile(path.join(h.profile, 'native-operations.json'), 'utf8')) as {
      operations: { command: string; args: string[] }[];
    }
  ).operations;
}

async function rollbackFiles(h: AppHarness) {
  const state = JSON.parse(await readFile(path.join(h.profile, 'updater-state.json'), 'utf8'));
  expect(state.rollbackVersion).toBe('1.6.4');
  expect(state.rollbackBundleName).toBe('GTV Remote.app');
  return installedFiles(path.join(h.profile, 'rollback', state.rollbackBundleName));
}

async function updates(
  h: AppHarness,
  run: (server: ReleaseServer, bundle: string) => Promise<void>
) {
  const server = new ReleaseServer(h.profile);
  try {
    await server.start();
    const bundle = path.join(h.profile, 'installed', 'GTV Remote.app');
    await ReleaseServer.bundle(bundle, '1.6.4');
    const config = JSON.parse(await readFile(h.configPath, 'utf8'));
    config.updater = {
      releaseApiUrl: `${server.url}/latest`,
      installedBundlePath: bundle,
      commandExecutable: path.join(repository, 'tests/integration/platform-fixtures/os-tools.cjs'),
      relaunchStatePath: path.join(h.profile, 'relaunch.json'),
    };
    await writeFile(h.configPath, JSON.stringify(config));
    await h.restart();
    // Await the real startup check before mutating the server's next response.
    await h.api('checkForUpdatesInBackground');
    await run(server, bundle);
  } finally {
    await server.stop();
  }
}

for (const mode of ['none', 'check-failure', 'no-asset'] as const) {
  test(`UPDATE-CHECK-${mode}: background and manual checks expose real release result`, async ({
    harness: h,
  }) => {
    await updates(h, async (server) => {
      server.mode = mode;
      const status = await h.api('checkForUpdates');
      expect(server.requests).toContain('/latest');
      expect(status.inProgress).toBe(false);
      if (mode === 'check-failure') expect(status.stage).toBe('failed');
      else if (mode === 'none') expect(status.updateAvailable).toBe(false);
      else expect(status.updateInstallable).toBe(false);
      const count = server.requests.length;
      await h.api('checkForUpdatesInBackground');
      expect(server.requests.length).toBe(count);
    });
  });
}

test('UPDATE-AVAILABLE-DISMISS: offer dismissal does not alter available release', async ({
  harness: h,
}) => {
  await updates(h, async () => {
    await h.api('checkForUpdates');
    await expect(h.page.getByRole('button', { name: 'Close update panel' })).toBeVisible();
    await h.page.getByRole('button', { name: 'Close update panel' }).click();
    await expect(h.page.getByRole('button', { name: 'Close update panel' })).toHaveCount(0);
    expect((await h.api('getUpdaterStatus')).updateAvailable).toBe(true);
    await h.restart();
    await expect(h.page.getByRole('button', { name: 'Close update panel' })).toBeVisible();
  });
});

const installFailureDetail = {
  'download-failure': /503/,
  'invalid-archive': /unzip|zip|archive/i,
  'digest-mismatch': /SHA-256 verification/,
  'missing-digest': /no SHA-256 digest/,
  'wrong-identifier': /bundle identifier "com\.example\.not-gtv-remote"/,
} as const;

for (const mode of [
  'download-failure',
  'invalid-archive',
  'digest-mismatch',
  'missing-digest',
  'wrong-identifier',
] as const) {
  test(`UPDATE-INSTALL-FAILURE-${mode}: failure retains installed files and clears busy`, async ({
    harness: h,
  }) => {
    await updates(h, async (server, bundle) => {
      await h.dialogs([0]);
      server.mode = mode;
      await h.api('checkForUpdates');
      const before = await installedFiles(bundle);
      const result = await h.api('installAvailableUpdate');
      expect(result.stage).toBe('failed');
      expect(result.inProgress).toBe(false);
      expect(result.rollbackAvailable).toBe(false);
      expect(result.relaunchRequired).toBeUndefined();
      expect(await installedFiles(bundle)).toEqual(before);
      expect(await leftovers(h)).toEqual([]);
      await expectDialogsConsumed(h, [['OK']]);
      expect((await dialogState(h)).requests.at(-1)?.detail).toMatch(installFailureDetail[mode]);
      if (mode === 'missing-digest') expect(server.requests).not.toContain('/asset');
      server.mode = 'available';
      await h.dialogs([1]);
      await h.api('checkForUpdates');
      expect((await h.api('installAvailableUpdate')).stage).toBe('completed');
      await expectDialogsConsumed(h, [['Relaunch now', 'Later']]);
      expect(await rollbackFiles(h)).toEqual(before);
      expect((await installedFiles(bundle)).every((file) => file.includes('1.6.5'))).toBe(true);
    });
  });
}

test('UPDATE-INSTALL-ROLLBACK: downloaded ZIP replaces sandbox bundle, saves backup and restores real files', async ({
  harness: h,
}) => {
  await updates(h, async (_server, bundle) => {
    await h.dialogs([1]);
    await h.api('checkForUpdates');
    const old = await readFile(path.join(bundle, 'Contents', 'Info.plist'), 'utf8');
    const oldFiles = await installedFiles(bundle);
    // A file the new release no longer ships must not survive the install.
    const stale = path.join('Contents', 'Resources', 'stale.txt');
    await mkdir(path.join(bundle, 'Contents', 'Resources'), { recursive: true });
    await writeFile(path.join(bundle, stale), 'only in 1.6.4');
    const result = await h.api('installAvailableUpdate');
    expect(result.stage).toBe('completed');
    expect(result.rollbackAvailable).toBe(true);
    expect(result.inProgress).toBe(false);
    expect(result.relaunchRequired).toBe(true);
    expect(result.installedVersion).toBe('1.6.5');
    await expectDialogsConsumed(h, [['Relaunch now', 'Later']]);
    expect(await rollbackFiles(h)).toEqual(oldFiles);
    await expect(access(path.join(bundle, stale))).rejects.toThrow();
    expect(await readFile(path.join(h.profile, 'rollback', 'GTV Remote.app', stale), 'utf8')).toBe(
      'only in 1.6.4'
    );
    expect(await leftovers(h)).toEqual([]);
    expect(await readFile(path.join(bundle, 'Contents', 'Info.plist'), 'utf8')).toContain('1.6.5');
    const state = JSON.parse(await readFile(path.join(h.profile, 'updater-state.json'), 'utf8'));
    const backup = path.join(
      h.profile,
      'rollback',
      state.rollbackBundleName,
      'Contents',
      'Info.plist'
    );
    expect(await readFile(backup, 'utf8')).toBe(old);
    const commands = JSON.parse(
      await readFile(path.join(h.profile, 'native-operations.json'), 'utf8')
    );
    expect(
      commands.operations.some((operation: { command: string }) => operation.command === 'ditto')
    ).toBe(true);
    await h.dialogs([1]);
    await h.api('rollbackToPreviousVersion');
    await expectDialogsConsumed(h, [['Rollback now', 'Cancel']]);
    expect((await h.api('getUpdaterStatus')).rollbackAvailable).toBe(true);
    expect(await readFile(path.join(bundle, 'Contents', 'Info.plist'), 'utf8')).toContain('1.6.5');
    await h.dialogs([0, 1]);
    const restored = await h.api('rollbackToPreviousVersion');
    expect(restored.stage).toBe('completed');
    expect(restored.rollbackAvailable).toBe(false);
    expect(await readFile(path.join(bundle, 'Contents', 'Info.plist'), 'utf8')).toBe(old);
    expect(restored.inProgress).toBe(false);
    expect(restored.relaunchRequired).toBe(true);
    expect(restored.installedVersion).toBe('1.6.4');
    expect(await installedFiles(bundle)).toEqual(oldFiles);
    expect(await readFile(path.join(bundle, stale), 'utf8')).toBe('only in 1.6.4');
    expect(await leftovers(h)).toEqual([]);
    await expectDialogsConsumed(h, [
      ['Rollback now', 'Cancel'],
      ['Relaunch now', 'Later'],
    ]);
    await expect(access(backup)).rejects.toThrow();
  });
});

test('UPDATE-ROLLBACK-FAILURE: native copy failure preserves rollback metadata and offers recovery', async ({
  harness: h,
}) => {
  await updates(h, async (_server, bundle) => {
    await h.dialogs([1]);
    await h.api('checkForUpdates');
    await h.api('installAvailableUpdate');
    const backupFiles = await rollbackFiles(h);
    const installed = await installedFiles(bundle);
    await writeFile(path.join(h.profile, 'fail-native-command'), 'ditto');
    await h.dialogs([0]);
    const result = await h.api('rollbackToPreviousVersion');
    expect(result.stage).toBe('failed');
    expect(result.rollbackAvailable).toBe(true);
    expect(result.inProgress).toBe(false);
    expect(result.message).toMatch(/rollback failed/i);
    await expectDialogsConsumed(h, [['Rollback now', 'Cancel']]);
    expect(await rollbackFiles(h)).toEqual(backupFiles);
    expect(await installedFiles(bundle)).toEqual(installed);
    expect(await readFile(path.join(bundle, 'Contents', 'Info.plist'), 'utf8')).toContain('1.6.5');
    await rm(path.join(h.profile, 'fail-native-command'));
    await h.dialogs([0, 1]);
    expect((await h.api('rollbackToPreviousVersion')).stage).toBe('completed');
    expect(await installedFiles(bundle)).toEqual(backupFiles);
    expect((await h.api('getUpdaterStatus')).rollbackAvailable).toBe(false);
    await expectDialogsConsumed(h, [
      ['Rollback now', 'Cancel'],
      ['Relaunch now', 'Later'],
    ]);
  });
});

test('UPDATE-ROLLBACK-DISMISS-SUPPRESS: renderer offer closes and durable suppression survives restart', async ({
  harness: h,
}) => {
  await updates(h, async () => {
    await h.dialogs([1]);
    await h.api('checkForUpdates');
    await h.api('installAvailableUpdate');
    await expect(h.page.getByRole('button', { name: 'Close rollback panel' })).toBeVisible();
    await h.page.getByRole('button', { name: 'Close rollback panel' }).click();
    await expect(h.page.getByRole('button', { name: 'Close rollback panel' })).toHaveCount(0);
    await h.restart();
    await h.page.getByRole('button', { name: /Don.t show again/i }).click();
    await h.restart();
    await expect(h.page.getByRole('button', { name: 'Close rollback panel' })).toHaveCount(0);
    expect((await h.api('getUpdaterStatus')).rollbackAvailable).toBe(true);
  });
});

test('UPDATE-RELAUNCH: recorded native relaunch and next real app reads installed version', async ({
  harness: h,
}) => {
  await updates(h, async () => {
    await h.dialogs([0]);
    await h.api('checkForUpdates');
    const closed = h.app.waitForEvent('close');
    await Promise.all([
      closed,
      h.api('installAvailableUpdate').catch((error: Error) => {
        expect(error.message).toMatch(/closed|destroyed/i);
      }),
    ]);
    await expect
      .poll(
        async () =>
          JSON.parse(await readFile(path.join(h.profile, 'relaunch.json'), 'utf8')).requested
      )
      .toBe(true);
    await h.launch();
    expect((await h.api('getUpdaterStatus')).currentVersion).toBe('1.6.5');
    expect(h.app.process().exitCode).toBeNull();
  });
});

test('UPDATE-LEGACY-SKIP: explicit historical skippedVersion input suppresses same release only', async ({
  harness: h,
}) => {
  await updates(h, async (server) => {
    await writeFile(
      path.join(h.profile, 'updater-state.json'),
      JSON.stringify({ skippedVersion: server.version })
    );
    await h.restart();
    expect((await h.api('checkForUpdates')).updateAvailable).toBe(false);
    server.version = '1.6.6';
    expect((await h.api('checkForUpdates')).updateAvailable).toBe(true);
  });
});

test('UPDATE-DMG: production asset selection records loopback external-open and native modal', async ({
  harness: h,
}) => {
  await updates(h, async (server) => {
    server.mode = 'dmg';
    await h.api('checkForUpdates');
    await h.dialogs([0]);
    await h.api('installAvailableUpdate');
    const opened = JSON.parse(await readFile(path.join(h.profile, 'external-open.json'), 'utf8'));
    expect(opened.url).toBe(`${server.url}/asset`);
    const dialogs = JSON.parse(await readFile(path.join(h.profile, 'dialogs.json'), 'utf8'));
    expect(dialogs.requests.at(-1).buttons).toEqual(['OK']);
    await expectDialogsConsumed(h, [['OK']]);
    expect((await h.api('getUpdaterStatus')).inProgress).toBe(false);
    expect((await h.api('getUpdaterStatus')).rollbackAvailable).toBe(false);
  });
});

test('UPDATE-PROGRESS: actual event stream reports download bytes, installing and completion', async ({
  harness: h,
}) => {
  await updates(h, async () => {
    await h.api('checkForUpdates');
    await h.dialogs([1]);
    const observed = await h.page.evaluate(async () => {
      let completed!: () => void;
      const completion = new Promise<void>((resolve) => {
        completed = resolve;
      });
      const events: { stage: string; progress?: number; busy: boolean }[] = [];
      const unsubscribe = window.gtvRemote.onUpdaterStatus((status) => {
        events.push({
          stage: status.stage,
          progress: status.progressPercent,
          busy: status.inProgress,
        });
        if (status.stage === 'completed' && !status.inProgress) completed();
      });
      try {
        await Promise.all([window.gtvRemote.installAvailableUpdate(), completion]);
        return events;
      } finally {
        unsubscribe();
      }
    });
    expect(observed.some((event) => event.stage === 'downloading' && event.progress === 100)).toBe(
      true
    );
    expect(observed.some((event) => event.stage === 'installing' && event.busy)).toBe(true);
    expect(observed.at(-1)?.stage).toBe('completed');
    expect(observed.at(-1)?.busy).toBe(false);
    await expectDialogsConsumed(h, [['Relaunch now', 'Later']]);
  });
});

test('UPDATE-NATIVE-FAILURE: failed quarantine removal on the staged copy leaves the installed app untouched', async ({
  harness: h,
}) => {
  await updates(h, async (_server, bundle) => {
    await h.api('checkForUpdates');
    const oldFiles = await installedFiles(bundle);
    await writeFile(path.join(h.profile, 'fail-native-command'), 'xattr');
    await h.dialogs([0]);
    const failed = await h.api('installAvailableUpdate');
    expect(failed.stage).toBe('failed');
    expect(failed.rollbackAvailable).toBe(false);
    expect(failed.inProgress).toBe(false);
    expect(failed.relaunchRequired).toBeUndefined();
    // Quarantine is cleared on the verified, staged sibling before the swap, so
    // a failure there never reaches the installed bundle.
    expect(await installedFiles(bundle)).toEqual(oldFiles);
    expect(await leftovers(h)).toEqual([]);
    const xattr = (await nativeOperations(h)).filter((operation) => operation.command === 'xattr');
    expect(xattr.at(-1)?.args.at(-1)).toMatch(/[/\\]\.GTV Remote\.app\.update-[^/\\]+$/);
    await expectDialogsConsumed(h, [['OK']]);
    expect((await dialogState(h)).requests.at(-1)?.detail).toContain('Synthetic native failure');
    await rm(path.join(h.profile, 'fail-native-command'));
    await h.dialogs([1]);
    await h.api('checkForUpdates');
    expect((await h.api('installAvailableUpdate')).stage).toBe('completed');
    expect(await rollbackFiles(h)).toEqual(oldFiles);
    expect((await installedFiles(bundle)).every((file) => file.includes('1.6.5'))).toBe(true);
    await expectDialogsConsumed(h, [['Relaunch now', 'Later']]);
  });
});

test('UPDATE-LATER-PENDING-RELAUNCH: after Later, checks report the relaunch and never reinstall over the backup', async ({
  harness: h,
}) => {
  await updates(h, async (server, bundle) => {
    await h.dialogs([1]);
    await h.api('checkForUpdates');
    const oldFiles = await installedFiles(bundle);
    expect((await h.api('installAvailableUpdate')).relaunchRequired).toBe(true);
    await expectDialogsConsumed(h, [['Relaunch now', 'Later']]);
    const requests = server.requests.length;
    const manual = await h.api('checkForUpdates');
    expect(manual.relaunchRequired).toBe(true);
    expect(manual.installedVersion).toBe('1.6.5');
    expect(manual.updateInstallable).toBe(false);
    expect(manual.message).toBe('Update 1.6.5 installed. Relaunch GTV Remote to finish.');
    expect((await h.api('checkForUpdatesInBackground')).relaunchRequired).toBe(true);
    expect((await h.api('installAvailableUpdate')).relaunchRequired).toBe(true);
    expect(server.requests.length).toBe(requests);
    // The backup still holds the version that was running, not a copy of 1.6.5.
    expect(await rollbackFiles(h)).toEqual(oldFiles);
    expect((await dialogState(h)).responses).toEqual([]);
  });
});

test('UPDATE-ROLLBACK-RELAUNCH: restored bundle metadata is read by next actual process', async ({
  harness: h,
}) => {
  await updates(h, async () => {
    await h.api('checkForUpdates');
    await h.dialogs([1]);
    await h.api('installAvailableUpdate');
    await h.dialogs([0, 0]);
    const closed = h.app.waitForEvent('close');
    await Promise.all([
      closed,
      h.api('rollbackToPreviousVersion').catch((error: Error) => {
        expect(error.message).toMatch(/closed|destroyed/i);
      }),
    ]);
    const relaunch = JSON.parse(await readFile(path.join(h.profile, 'relaunch.json'), 'utf8'));
    expect(relaunch.requested).toBe(true);
    expect(relaunch.version).toBe('1.6.4');
    await h.launch();
    expect((await h.api('getUpdaterStatus')).currentVersion).toBe('1.6.4');
    expect((await h.api('getUpdaterStatus')).rollbackAvailable).toBe(false);
  });
});

for (const mode of ['none', 'check-failure', 'available'] as const) {
  test(`UPDATE-TRAY-MANUAL-${mode}: actual native menu check runs production modal choices`, async ({
    harness: h,
  }) => {
    await updates(h, async (server) => {
      server.mode = mode;
      await h.dialogs([mode === 'available' ? 1 : 0]);
      const before = JSON.parse(await readFile(path.join(h.profile, 'dialogs.json'), 'utf8'))
        .requests.length;
      await h.trayAction('check-updates');
      await expect
        .poll(
          async () =>
            JSON.parse(await readFile(path.join(h.profile, 'dialogs.json'), 'utf8')).requests.length
        )
        .toBe(before + 1);
      await expectDialogsConsumed(h, [mode === 'available' ? ['Update now', 'Later'] : ['OK']]);
      const dialogs = JSON.parse(await readFile(path.join(h.profile, 'dialogs.json'), 'utf8'));
      expect(dialogs.requests.at(-1).buttons).toEqual(
        mode === 'available' ? ['Update now', 'Later'] : ['OK']
      );
      expect((await h.api('getUpdaterStatus')).inProgress).toBe(false);
      expect((await h.api('getUpdaterStatus')).updateAvailable).toBe(mode === 'available');
    });
  });
}

test('UPDATE-TRAY-INSTALL: native Update now choice downloads and installs actual sandbox files', async ({
  harness: h,
}) => {
  await updates(h, async (_server, bundle) => {
    await h.dialogs([0, 1]);
    await h.trayAction('check-updates');
    await expect.poll(async () => (await h.api('getUpdaterStatus')).stage).toBe('completed');
    await expectDialogsConsumed(h, [
      ['Update now', 'Later'],
      ['Relaunch now', 'Later'],
    ]);
    expect((await h.api('getUpdaterStatus')).inProgress).toBe(false);
    expect((await h.api('getUpdaterStatus')).rollbackAvailable).toBe(true);
    expect(await readFile(path.join(bundle, 'Contents', 'Info.plist'), 'utf8')).toContain('1.6.5');
    const requests = JSON.parse(
      await readFile(path.join(h.profile, 'dialogs.json'), 'utf8')
    ).requests;
    expect(requests.at(-2).buttons).toEqual(['Update now', 'Later']);
    expect(requests.at(-1).buttons).toEqual(['Relaunch now', 'Later']);
  });
});
