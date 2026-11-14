# `updater/`

Pure or dependency-injected pieces of the in-app updater. Orchestration
(network, dialogs, native commands, Electron) lives in `src/main/updater.ts`.

- `releaseSource.ts` — release owner/repo (`guitar24t/gtv-desktop-remote`).
  A test keeps it equal to `package.json` `repository.url`.
- `version.ts` — semver-precedence comparison and macOS asset selection.
- `integrity.ts` — GitHub `sha256:` digest parsing, streaming size/SHA-256
  verification, and Info.plist identifier/version checks.
- `installLocation.ts` — pre-download App Translocation and writability checks.
- `bundleSwap.ts` — staged-sibling rename swap with restore on failure, plus
  move-or-copy (`EXDEV`) for the rollback backup.
- `checkSchedule.ts` — background-check interval and failure back-off.
- `updaterStatus.ts` — the `UpdaterStatus` event reducer.
