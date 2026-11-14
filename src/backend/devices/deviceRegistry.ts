import type { DeviceDraft, DiscoveredDevice, SavedDevice } from '../../shared/types';

/**
 * Pure identity-matching utilities for devices. Extracted from the inline
 * branches in `GoogleTvAdapter.runDeviceScan` and `GoogleTvAdapter.saveDevice`
 *
 * **Google TV non-regression gate #2** (after the cert store). These functions
 * decide whether a freshly-discovered device on the network is "the same" as
 * one the user already paired with — getting this wrong loses the pairing
 * credential when an IP changes. The priority order is preserved exactly from
 * the original code:
 *
 *     macAddress  >  castDeviceId  >  networkHostName  >  deviceFingerprint  >  host
 *
 * - `macAddress` is the most stable physical identifier; if both sides have one,
 *   that's the only thing that matters.
 * - `castDeviceId` is stable per-device across reboots but missing on some old TVs.
 * - `networkHostName` is the mDNS-published name; stable per-device but only
 *   if the user hasn't renamed the TV.
 * - `deviceFingerprint` is a derived hash; we only use it if exactly one
 *   discovered device has the same fingerprint (no ambiguity).
 * - `host` is a pure IP-address fallback; used when nothing better is available.
 */

/**
 * Match a saved device against the current scan results. Returns the matching
 * discovered device, or `undefined` if no current device corresponds. The order
 * of the checks below is the **contract**; do not reorder without updating the
 * `deviceRegistry.test.ts` priority-matrix tests.
 */
export function matchSavedToDiscovered(
  saved: SavedDevice,
  discovered: readonly DiscoveredDevice[]
): DiscoveredDevice | undefined {
  const fingerprintMatches = saved.deviceFingerprint
    ? discovered.filter((d) => d.deviceFingerprint === saved.deviceFingerprint)
    : undefined;

  return discovered.find((d) => {
    if (saved.macAddress && d.macAddress) {
      return d.macAddress === saved.macAddress;
    }
    if (saved.castDeviceId && d.castDeviceId) {
      return d.castDeviceId === saved.castDeviceId;
    }
    if (saved.networkHostName && d.networkHostName) {
      return d.networkHostName === saved.networkHostName;
    }
    if (fingerprintMatches?.length === 1) {
      return d.id === fingerprintMatches[0]?.id;
    }
    return d.host === saved.host;
  });
}

/**
 * Merge identity fields from a scan match back into a saved device. Two cases:
 *
 *   - same host → backfill any newly-discovered metadata that we did not have
 *     before (e.g. we now know the MAC), but preserve the host.
 *   - different host → the TV moved to a new IP. Update host, backfill identity
 *     metadata, and (caller is expected to migrate certs separately).
 *
 * `isPaired`, `lastConnectedAt`, custom name, and ports are preserved across
 * both branches.
 */
export function mergeIdentity(saved: SavedDevice, match: DiscoveredDevice): SavedDevice {
  if (match.host === saved.host) {
    return {
      ...saved,
      macAddress: saved.macAddress ?? match.macAddress,
      castDeviceId: saved.castDeviceId ?? match.castDeviceId,
      networkHostName: saved.networkHostName ?? match.networkHostName,
      deviceFingerprint: saved.deviceFingerprint ?? match.deviceFingerprint,
    };
  }

  return {
    ...saved,
    host: match.host,
    macAddress: saved.macAddress ?? match.macAddress,
    castDeviceId: saved.castDeviceId ?? match.castDeviceId,
    networkHostName: saved.networkHostName ?? match.networkHostName,
    deviceFingerprint: saved.deviceFingerprint ?? match.deviceFingerprint,
  };
}

/**
 * True iff any identity-relevant field changed between the two devices. Used
 * by callers to decide whether to persist + log + migrate certs after a scan.
 */
export function identityChanged(previous: SavedDevice, updated: SavedDevice): boolean {
  return (
    updated.host !== previous.host ||
    updated.macAddress !== previous.macAddress ||
    updated.castDeviceId !== previous.castDeviceId ||
    updated.networkHostName !== previous.networkHostName ||
    updated.deviceFingerprint !== previous.deviceFingerprint
  );
}

/**
 * Find an existing saved device that matches the given draft. Uses the same
 * priority order as `matchSavedToDiscovered`, but on a single draft against
 * the saved list (so the asymmetry is reversed). Used by "save device" flows
 * to deduplicate.
 *
 * Returns `undefined` if no existing device matches — the caller should
 * create a fresh one.
 */
export function findExistingForDraft(
  draft: DeviceDraft,
  savedList: readonly SavedDevice[]
): SavedDevice | undefined {
  const normalizedHost = draft.host.trim();
  const normalizedMac = draft.macAddress?.trim();
  const normalizedCastDeviceId = draft.castDeviceId?.trim();
  const normalizedNetworkHostName = draft.networkHostName?.trim();
  const normalizedDeviceFingerprint = draft.deviceFingerprint?.trim();

  return savedList.find((device) => {
    if (normalizedMac && device.macAddress) {
      return device.macAddress === normalizedMac;
    }
    if (normalizedCastDeviceId && device.castDeviceId) {
      return device.castDeviceId === normalizedCastDeviceId;
    }
    if (normalizedNetworkHostName && device.networkHostName) {
      return device.networkHostName === normalizedNetworkHostName;
    }
    if (normalizedDeviceFingerprint && device.deviceFingerprint) {
      return device.deviceFingerprint === normalizedDeviceFingerprint;
    }
    return device.host === normalizedHost;
  });
}

/**
 * Build a fully-normalised `SavedDevice` from a draft, preserving identity and
 * state from `existing` where the draft is silent.
 *
 * - `id`            : preserved from existing, or freshly generated by the
 *                     caller via `idGenerator()` (default: crypto.randomUUID).
 * - `isPaired`      : preserved (defaults to `false` for new devices).
 * - `name`          : draft wins if non-empty; otherwise we fall back to host.
 * - identity fields : draft wins if set, existing as fallback.
 * - `lastConnectedAt`: never modified here.
 */
export function normalizeDraft(
  draft: DeviceDraft,
  existing: SavedDevice | undefined,
  idGenerator: () => string = () => globalThis.crypto.randomUUID()
): SavedDevice {
  const normalizedHost = draft.host.trim();
  const normalizedMac = draft.macAddress?.trim();
  const normalizedCastDeviceId = draft.castDeviceId?.trim();
  const normalizedNetworkHostName = draft.networkHostName?.trim();
  const normalizedDeviceFingerprint = draft.deviceFingerprint?.trim();

  return {
    id: existing?.id ?? idGenerator(),
    isPaired: existing?.isPaired ?? false,
    name: draft.name.trim() || normalizedHost,
    host: normalizedHost,
    adbPort: draft.adbPort,
    pairingPort: draft.pairingPort,
    macAddress: normalizedMac ?? existing?.macAddress,
    castDeviceId: normalizedCastDeviceId ?? existing?.castDeviceId,
    networkHostName: normalizedNetworkHostName ?? existing?.networkHostName,
    deviceFingerprint: normalizedDeviceFingerprint ?? existing?.deviceFingerprint,
    lastConnectedAt: existing?.lastConnectedAt,
    audioOutput: existing?.audioOutput,
  };
}

function sameMac(left: string | undefined, right: string | undefined): boolean {
  const a = left?.trim().toLowerCase();
  const b = right?.trim().toLowerCase();
  return Boolean(a && b && a === b);
}

function otherDeviceSharesHost(device: SavedDevice, savedList: readonly SavedDevice[]): boolean {
  const host = device.host.trim();
  return savedList.some((other) => other.id !== device.id && other.host.trim() === host);
}

function otherDeviceSharesMac(device: SavedDevice, savedList: readonly SavedDevice[]): boolean {
  return savedList.some(
    (other) => other.id !== device.id && sameMac(other.macAddress, device.macAddress)
  );
}

/**
 * Legacy credential keys a device may adopt when it has no pair under its
 * `id` yet, in priority order. Older releases stored the client certificate
 * under the MAC address when known and under the host otherwise. A host-keyed
 * pair is only offered when no other saved device has that host, because an
 * IP address alone cannot tell two TVs apart.
 */
export function legacyCertKeysFor(
  device: SavedDevice,
  savedList: readonly SavedDevice[]
): string[] {
  const keys: string[] = [];
  const mac = device.macAddress?.trim();
  if (mac) {
    keys.push(mac);
  }
  const host = device.host.trim();
  if (host && !otherDeviceSharesHost(device, savedList)) {
    keys.push(host);
  }
  return keys;
}

/**
 * Legacy credential keys that may be deleted when `device` is forgotten:
 * its MAC and host keys, each only when no other saved device shares it.
 */
export function forgettableLegacyCertKeys(
  device: SavedDevice,
  savedList: readonly SavedDevice[]
): string[] {
  const keys: string[] = [];
  const mac = device.macAddress?.trim();
  if (mac && !otherDeviceSharesMac(device, savedList)) {
    keys.push(mac);
  }
  const host = device.host.trim();
  if (host && !otherDeviceSharesHost(device, savedList)) {
    keys.push(host);
  }
  return keys;
}
