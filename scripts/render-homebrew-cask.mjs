#!/usr/bin/env node

import { readFileSync } from 'node:fs';

const CASK_TOKEN = 'gtv-desktop-remote';
const APP_NAME = 'GTV Remote.app';
const REPOSITORY_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/**
 * Default `owner/repo` for download URLs: the repository package.json points
 * at (the same one semantic-release publishes to), so a fork never renders a
 * cask that downloads someone else's build.
 */
function defaultRepository(
  packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
) {
  const repository = packageJson.repository;
  const url = typeof repository === 'string' ? repository : repository?.url;
  const match = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url ?? '');
  if (!match) {
    throw new Error('package.json repository.url is not a GitHub repository; pass --repository.');
  }
  return `${match[1]}/${match[2]}`;
}

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    const key = arg.slice(2);
    const value = argv[index + 1];

    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }

    args[key] = value;
    index += 1;
  }

  return args;
}

function requireArg(args, key) {
  if (!args[key]) {
    throw new Error(`Missing required argument --${key}`);
  }

  return args[key];
}

function releaseAssetUrl(repository, version, artifactName) {
  const encodedArtifactName = encodeURIComponent(artifactName);
  return `https://github.com/${repository}/releases/download/v${version}/${encodedArtifactName}`;
}

function renderSharedBody(repository) {
  return `  name "GTV Remote"
  desc "Desktop remote for Google TV and Android TV"
  homepage "https://github.com/${repository}"

  app "${APP_NAME}"

  postflight_steps do
    run "/usr/bin/xattr",
        args: ["-dr", "com.apple.quarantine", "{{appdir}}/${APP_NAME}"]
  end

  caveats do
    <<~EOS
      GTV Remote is open source and intentionally not notarized - we don't pay
      Apple's $99/year gatekeeping tax to ship free software.

      This cask automatically removes the quarantine flag during install, so the
      app should launch normally. If macOS still blocks launch, run:

        sudo xattr -dr com.apple.quarantine "/Applications/${APP_NAME}"

      If launch is still blocked after that, use:
        System Settings -> Privacy & Security -> Open Anyway
    EOS
  end

  zap trash: [
    "~/Library/Application Support/GTV Remote",
    "~/Library/Preferences/com.utkarsh.gtvdesktopremote.plist",
    "~/Library/Saved Application State/com.utkarsh.gtvdesktopremote.savedState",
  ]
`;
}

function renderSingleArchCask({ version, sha256, artifactName, repository }) {
  return `cask "${CASK_TOKEN}" do
  version "${version}"
  sha256 "${sha256}"

  url "${releaseAssetUrl(repository, version, artifactName)}"
${renderSharedBody(repository)}end
`;
}

function renderDualArchCask({
  version,
  sha256Arm64,
  artifactNameArm64,
  sha256X64,
  artifactNameX64,
  repository,
}) {
  return `cask "${CASK_TOKEN}" do
  version "${version}"
  on_arm do
    sha256 "${sha256Arm64}"

    url "${releaseAssetUrl(repository, version, artifactNameArm64)}"
  end
  on_intel do
    sha256 "${sha256X64}"

    url "${releaseAssetUrl(repository, version, artifactNameX64)}"
  end
${renderSharedBody(repository)}end
`;
}

function validate({ version, repository, sha256s, artifactNames }) {
  // Values are interpolated into Ruby string literals; reject anything unexpected.
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid --version: ${version}`);
  }
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error(`Invalid --repository (expected owner/repo): ${repository}`);
  }
  for (const sha256 of sha256s) {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`Invalid sha256: ${sha256}`);
  }
  for (const name of artifactNames) {
    if (/["\\#{}\n]/.test(name) || name.includes('/')) {
      throw new Error(`Invalid artifact name: ${name}`);
    }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const version = requireArg(args, 'version');
  const repository = args.repository || defaultRepository();

  const dualArch =
    args['sha256-arm64'] &&
    args['artifact-name-arm64'] &&
    args['sha256-x64'] &&
    args['artifact-name-x64'];

  if (dualArch) {
    validate({
      version,
      repository,
      sha256s: [args['sha256-arm64'], args['sha256-x64']],
      artifactNames: [args['artifact-name-arm64'], args['artifact-name-x64']],
    });
    process.stdout.write(
      renderDualArchCask({
        version,
        sha256Arm64: args['sha256-arm64'],
        artifactNameArm64: args['artifact-name-arm64'],
        sha256X64: args['sha256-x64'],
        artifactNameX64: args['artifact-name-x64'],
        repository,
      })
    );
  } else {
    // Legacy single-arch path: exactly one DMG asset.
    const sha256 = requireArg(args, 'sha256');
    const artifactName = requireArg(args, 'artifact-name');
    validate({ version, repository, sha256s: [sha256], artifactNames: [artifactName] });
    process.stdout.write(renderSingleArchCask({ version, sha256, artifactName, repository }));
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  console.error(
    'Single-arch usage: node scripts/render-homebrew-cask.mjs --version 1.2.3 --sha256 <sha256> --artifact-name <asset.dmg> [--repository owner/repo]'
  );
  console.error(
    'Dual-arch usage:   node scripts/render-homebrew-cask.mjs --version 1.2.3 --sha256-arm64 <sha256> --artifact-name-arm64 <asset.dmg> --sha256-x64 <sha256> --artifact-name-x64 <asset.dmg> [--repository owner/repo]'
  );
  process.exit(1);
}
