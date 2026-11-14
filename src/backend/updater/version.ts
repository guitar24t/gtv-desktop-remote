/**
 * Pure helpers extracted from `src/main/updater.ts`
 *
 * Nothing here touches Electron, the filesystem, or the network. The full
 * updater (download / install / rollback orchestration) remains in
 * `src/main/updater.ts` for now; that big slice is the subject of a future
 * `` wave once the FSM lives on top of these pure foundations.
 *
 * **Why this matters:** the updater historically mixed pure version comparison
 * with side-effecting dialog calls and disk IO, which made it impossible to
 * unit-test the "should we offer the new version?" decision. With these helpers
 * lifted out and tested at 100%, regressions in semver comparison or rate-limit
 * formatting cannot ship without a failing CI job.
 */

/** Minimal shape used by `findBestMacAsset`. Matches the GitHub releases API. */
export interface ReleaseAssetInfo {
  readonly name: string;
}

/** Strip a leading `v`/`V` and surrounding whitespace. */
export function normalizeVersion(value: string): string {
  return value.trim().replace(/^v/i, '');
}

interface ParsedVersion {
  readonly core: number[];
  readonly prerelease: string[];
}

function parseVersion(value: string): ParsedVersion {
  // Build metadata (`+...`) never affects precedence.
  const withoutBuild = normalizeVersion(value).split('+', 1)[0] ?? '';
  const dash = withoutBuild.indexOf('-');
  const coreText = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
  const prereleaseText = dash === -1 ? '' : withoutBuild.slice(dash + 1);
  return {
    core: coreText.split('.').map((part) => Number.parseInt(part, 10) || 0),
    prerelease: prereleaseText ? prereleaseText.split('.') : [],
  };
}

const NUMERIC_IDENTIFIER = /^\d+$/;

function compareIdentifiers(left: string, right: string): -1 | 0 | 1 {
  const leftNumeric = NUMERIC_IDENTIFIER.test(left);
  const rightNumeric = NUMERIC_IDENTIFIER.test(right);
  if (leftNumeric && rightNumeric) {
    const a = Number(left);
    const b = Number(right);
    return a === b ? 0 : a > b ? 1 : -1;
  }
  // Numeric identifiers always have lower precedence than alphanumeric ones.
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  if (left === right) return 0;
  return left > right ? 1 : -1;
}

/**
 * Semver precedence comparator.
 *
 * The release core (`MAJOR.MINOR.PATCH`, or any number of dot-separated
 * segments) is compared numerically pair-wise; non-numeric segments become 0
 * and missing trailing segments are treated as 0, so `1.2` === `1.2.0`.
 *
 * When the cores are equal, prerelease identifiers follow semver §11:
 * a version without a prerelease (`2.3.0`) is newer than any prerelease of
 * it (`2.3.0-beta.1`); prerelease identifiers are compared left to right,
 * numerically when both are numeric, lexically (ASCII) otherwise, with numeric
 * identifiers ranking below alphanumeric ones and a longer identifier list
 * winning when all preceding identifiers are equal. Build metadata is ignored.
 *
 * Returns:
 *   1  if `a` > `b`
 *  -1  if `a` < `b`
 *   0  otherwise
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const left = parseVersion(a);
  const right = parseVersion(b);

  const max = Math.max(left.core.length, right.core.length);
  for (let i = 0; i < max; i += 1) {
    const l = left.core[i] ?? 0;
    const r = right.core[i] ?? 0;
    if (l > r) return 1;
    if (l < r) return -1;
  }

  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }

  const identifiers = Math.min(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < identifiers; i += 1) {
    const result = compareIdentifiers(left.prerelease[i] ?? '', right.prerelease[i] ?? '');
    if (result !== 0) return result;
  }

  if (left.prerelease.length === right.prerelease.length) return 0;
  return left.prerelease.length > right.prerelease.length ? 1 : -1;
}

/**
 * Returns a human-friendly "in about X" string for the gap between `nowEpoch`
 * and `epochSeconds`. Boundary handling:
 *
 *   - epoch is past, NaN, or 0           → "shortly"
 *   - <= 60s away                        → "in about a minute"
 *   - < 60min away                       → "in about N minutes"
 *   - otherwise                          → "in about N hour(s)"
 *
 * `nowEpoch` is injected so tests don't need to freeze the system clock.
 */
export function formatMinutesUntil(
  epochSeconds: number,
  nowEpoch: number = Math.floor(Date.now() / 1000)
): string {
  const deltaSeconds = epochSeconds - nowEpoch;
  if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) {
    return 'shortly';
  }

  const minutes = Math.ceil(deltaSeconds / 60);
  if (minutes <= 1) {
    return 'in about a minute';
  }
  if (minutes < 60) {
    return `in about ${String(minutes)} minutes`;
  }

  const hours = Math.ceil(minutes / 60);
  return `in about ${String(hours)} hour${hours > 1 ? 's' : ''}`;
}

/** True iff the asset ends in `.dmg` (case-sensitive — matches release naming). */
export function isDmgAsset(asset: ReleaseAssetInfo): boolean {
  return asset.name.endsWith('.dmg');
}

/**
 * Pick the best macOS asset from a release. Strict architecture matching:
 *
 *   1. Architecture-matched `.zip`     (e.g. `app-mac-arm64.zip` when arch=arm64)
 *   2. Architecture-matched `.dmg`
 *
 * `arch` is injected (defaulting to `process.arch`) so tests can exercise both
 * x64 and arm64 selection without spawning a different process.
 *
 * Cross-arch fallback is intentionally NOT performed: installing an arm64
 * bundle on Intel x64 (or vice versa) bricks the app on next relaunch.
 * Returns `undefined` if no arch-matched mac asset is present, letting the
 * caller surface "no compatible macOS asset" instead.
 */
export function findBestMacAsset<T extends ReleaseAssetInfo>(
  assets: readonly T[],
  arch: string = process.arch
): T | undefined {
  const preferredZip = assets.find((asset) => asset.name.endsWith(`-mac-${arch}.zip`));
  if (preferredZip) return preferredZip;

  const preferredDmg = assets.find((asset) => asset.name.endsWith(`-mac-${arch}.dmg`));
  if (preferredDmg) return preferredDmg;

  return undefined;
}
