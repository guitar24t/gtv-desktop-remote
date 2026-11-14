import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  latestReleaseApiUrl,
  parseGitHubRepository,
  RELEASE_OWNER,
  RELEASE_REPO,
} from '../releaseSource';

interface PackageJson {
  repository?: { url?: string } | string;
}

function packageRepositoryUrl(): string {
  const packageJson = JSON.parse(
    readFileSync(path.resolve(__dirname, '../../../../package.json'), 'utf8')
  ) as PackageJson;
  const repository = packageJson.repository;
  const url = typeof repository === 'string' ? repository : repository?.url;
  if (!url) throw new Error('package.json has no repository url');
  return url;
}

describe('updater release source', () => {
  it('points at the same GitHub repository as package.json repository.url', () => {
    expect(parseGitHubRepository(packageRepositoryUrl())).toEqual({
      owner: RELEASE_OWNER,
      repo: RELEASE_REPO,
    });
  });

  it('targets the guitar24t fork, not upstream', () => {
    expect(RELEASE_OWNER).toBe('guitar24t');
    expect(latestReleaseApiUrl()).toBe(
      'https://api.github.com/repos/guitar24t/gtv-desktop-remote/releases/latest'
    );
  });

  it.each([
    'https://github.com/guitar24t/gtv-desktop-remote.git',
    'https://github.com/guitar24t/gtv-desktop-remote',
    'git+https://github.com/guitar24t/gtv-desktop-remote.git',
    'git@github.com:guitar24t/gtv-desktop-remote.git',
    'ssh://git@github.com/guitar24t/gtv-desktop-remote.git',
    'github:guitar24t/gtv-desktop-remote',
  ])('parses %s', (url) => {
    expect(parseGitHubRepository(url)).toEqual({
      owner: 'guitar24t',
      repo: 'gtv-desktop-remote',
    });
  });

  it.each(['https://gitlab.com/o/r.git', 'not a url', 'https://github.com/only-owner'])(
    'rejects %s',
    (url) => {
      expect(parseGitHubRepository(url)).toBeUndefined();
    }
  );
});
