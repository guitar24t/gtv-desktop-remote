import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const workflowsDir = join(root, '.github', 'workflows');
const workflows = readdirSync(workflowsDir)
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  .map((name) => ({ name, text: readFileSync(join(workflowsDir, name), 'utf8') }));
const releaseWorkflow = readFileSync(join(workflowsDir, 'release.yml'), 'utf8');

/** Split a workflow into `- name:`/`- uses:` step blocks (good enough for these checks). */
function steps(text) {
  return text.split(/\n(?=\s+- (?:name|uses):)/);
}

test('release tooling does not target the upstream repository', () => {
  const files = [
    'package.json',
    '.releaserc.json',
    'bin/release',
    ...readdirSync(join(root, 'scripts'))
      .filter((name) => name.endsWith('.mjs'))
      .map((name) => `scripts/${name}`),
    ...workflows.map(({ name }) => `.github/workflows/${name}`),
  ];
  for (const file of files) {
    assert.doesNotMatch(readFileSync(join(root, file), 'utf8'), /usrivastava92/, file);
  }
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.repository.url, 'https://github.com/guitar24t/gtv-desktop-remote.git');
});

test('the Homebrew cask defaults to the package.json repository', () => {
  const sha = 'a'.repeat(64);
  const cask = execFileSync(
    process.execPath,
    [
      join(root, 'scripts', 'render-homebrew-cask.mjs'),
      '--version',
      '2.3.0',
      '--sha256-arm64',
      sha,
      '--artifact-name-arm64',
      'GTV.Remote-2.3.0-mac-arm64.dmg',
      '--sha256-x64',
      sha,
      '--artifact-name-x64',
      'GTV.Remote-2.3.0-mac-x64.dmg',
    ],
    { encoding: 'utf8' }
  );
  assert.match(
    cask,
    /url "https:\/\/github\.com\/guitar24t\/gtv-desktop-remote\/releases\/download\/v2\.3\.0\/GTV\.Remote-2\.3\.0-mac-arm64\.dmg"/
  );
  assert.match(cask, /homepage "https:\/\/github\.com\/guitar24t\/gtv-desktop-remote"/);
});

test('the cask renderer rejects values that would break out of Ruby strings', () => {
  assert.throws(() =>
    execFileSync(
      process.execPath,
      [
        join(root, 'scripts', 'render-homebrew-cask.mjs'),
        '--version',
        '2.3.0"; system("id"); "',
        '--sha256',
        'a'.repeat(64),
        '--artifact-name',
        'a.dmg',
      ],
      { stdio: 'pipe' }
    )
  );
});

test('workflow inputs are never interpolated into run scripts', () => {
  for (const { name, text } of workflows) {
    for (const line of text.split('\n')) {
      if (!/\$\{\{\s*(?:inputs|github\.event\.inputs)\./.test(line)) continue;
      assert.match(line, /^\s*(?:-\s*)?(?:if|[A-Z][A-Z0-9_]*):\s/, `${name}: ${line.trim()}`);
    }
  }
});

test('every workflow declares least-privilege default permissions', () => {
  for (const { name, text } of workflows) {
    assert.match(text, /^permissions:\n\s+contents: read\n/m, name);
  }
});

test('checkouts do not persist credentials unless the job pushes', () => {
  for (const { name, text } of workflows) {
    for (const step of steps(text).filter((block) => /uses: actions\/checkout@/.test(block))) {
      const pushesTap = /path: homebrew-tap/.test(step);
      assert.match(
        step,
        pushesTap ? /persist-credentials: true/ : /persist-credentials: false/,
        `${name}: ${step.trim().split('\n')[0]}`
      );
    }
  }
});

test('release workflow uses the fork allow-list, repository-owner token and optional tap', () => {
  assert.match(releaseWorkflow, /RELEASE_ALLOWED_ACTORS: 'guitar24t'/);
  assert.match(releaseWorkflow, /owner: \$\{\{ github\.repository_owner \}\}/);
  const tapSteps = steps(releaseWorkflow).filter((block) =>
    /^\s+- name: (?!Skip ).*Homebrew tap/.test(block)
  );
  assert.ok(tapSteps.length >= 3);
  for (const step of tapSteps) {
    assert.match(step, /if: \$\{\{ vars\.HOMEBREW_TAP_REPOSITORY != '' \}\}/, step);
  }
  // The tap comes from the HOMEBREW_TAP_REPOSITORY variable, not a hardcoded repository.
  assert.doesNotMatch(releaseWorkflow, /repositor(?:y|ies): [\w./-]*homebrew-tap/);
});
