/**
 * Where the in-app updater looks for releases.
 *
 * This checkout ships from the `guitar24t/gtv-desktop-remote` fork. The owner
 * and repository MUST match `repository.url` in package.json (semantic-release
 * publishes to that repository); `releaseSource.test.ts` fails if they drift.
 */
export const RELEASE_OWNER = 'guitar24t';
export const RELEASE_REPO = 'gtv-desktop-remote';

export interface GitHubRepository {
  readonly owner: string;
  readonly repo: string;
}

/** GitHub REST endpoint for the latest published (non-draft, non-prerelease) release. */
export function latestReleaseApiUrl(
  owner: string = RELEASE_OWNER,
  repo: string = RELEASE_REPO
): string {
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/latest`;
}

/**
 * Parse the common package.json `repository` spellings into owner/repo:
 * `https://github.com/o/r(.git)`, `git+https://…`, `git@github.com:o/r.git`,
 * `ssh://git@github.com/o/r.git` and the `github:o/r` shorthand.
 */
export function parseGitHubRepository(url: string): GitHubRepository | undefined {
  const trimmed = url.trim();
  const match =
    /^github:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(trimmed) ??
    /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(trimmed) ??
    /^(?:git\+)?(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(
      trimmed
    );
  const owner = match?.[1];
  const repo = match?.[2];
  return owner && repo ? { owner, repo } : undefined;
}
