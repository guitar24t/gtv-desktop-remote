# `devices/` — persistence + identity matching

- `DeviceRepository` — CRUD over `SavedDevice[]`, behind `IFileSystem`.
- `DeviceRegistry` — the identity-matching matrix (MAC vs cast vs host vs
  fingerprint vs IP-change migration). ≥95% line coverage required.
- `credentials/` — per-kind credential stores (Android TV cert store now,
  Apple TV keystore in a future milestone). Android TV client certificates
  and the pinned TV server fingerprint are keyed by the saved device's `id`;
  pre-id MAC/host-keyed pairs are adopted once by rename
  (`legacyCertKeysFor`) and never deleted because a newer pair exists.
- `AsyncMutex` — serializes devices.json read-modify-write sections.

PR-3 introduces `credentials/androidTvCertStore.ts`. PR-4 introduces
`DeviceRepository` and `DeviceRegistry`.
