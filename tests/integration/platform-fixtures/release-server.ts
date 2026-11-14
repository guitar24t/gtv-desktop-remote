import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import path from 'node:path';

/** electron-builder `appId`; the updater refuses bundles with any other identifier. */
export const BUNDLE_IDENTIFIER = 'com.utkarsh.gtvdesktopremote';

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export class ReleaseServer {
  server: Server;
  url = '';
  version = '1.6.5';
  mode:
    | 'available'
    | 'none'
    | 'check-failure'
    | 'download-failure'
    | 'invalid-archive'
    | 'digest-mismatch'
    | 'missing-digest'
    | 'wrong-identifier'
    | 'no-asset'
    | 'dmg' = 'available';
  asset: Buffer = Buffer.alloc(0);
  /** A well-formed archive whose bundle claims a different app identity. */
  foreignAsset: Buffer = Buffer.alloc(0);
  requests: string[] = [];
  constructor(readonly profile: string) {
    this.server = createServer((request, response) => {
      this.requests.push(request.url ?? '');
      if (request.url === '/latest') {
        if (this.mode === 'check-failure') {
          response.writeHead(503);
          response.end();
          return;
        }
        const served = this.servedAsset();
        // Like GitHub: `size` and `digest` describe the published file. In
        // digest-mismatch mode the bytes served differ from what was published.
        const published = this.mode === 'digest-mismatch' ? this.asset : served;
        const integrity = {
          size: published.length,
          ...(this.mode === 'missing-digest' ? {} : { digest: `sha256:${sha256(published)}` }),
        };
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            tag_name: this.mode === 'none' ? 'v1.6.4' : `v${this.version}`,
            html_url: `${this.url}/release`,
            assets:
              this.mode === 'no-asset'
                ? []
                : [
                    {
                      name: `GTV-Remote-${this.version}-mac-arm64.${this.mode === 'dmg' ? 'dmg' : 'zip'}`,
                      browser_download_url: `${this.url}/asset`,
                      ...integrity,
                    },
                    {
                      name: `GTV-Remote-${this.version}-mac-x64.${this.mode === 'dmg' ? 'dmg' : 'zip'}`,
                      browser_download_url: `${this.url}/asset`,
                      ...integrity,
                    },
                  ],
          })
        );
      } else if (request.url === '/asset') {
        if (this.mode === 'download-failure') {
          response.writeHead(503);
          response.end();
          return;
        }
        const bytes = this.servedAsset();
        response.setHeader('content-length', bytes.length);
        response.end(bytes);
      } else {
        response.writeHead(404);
        response.end();
      }
    });
  }
  /** The bytes `/asset` returns in the current mode. */
  servedAsset(): Buffer {
    switch (this.mode) {
      case 'invalid-archive':
        return Buffer.from('not a ZIP');
      case 'digest-mismatch': {
        // Same length as the published file, different content.
        const tampered = Buffer.from(this.asset);
        const last = tampered.length - 1;
        tampered[last] = (tampered[last] ?? 0) ^ 0xff;
        return tampered;
      }
      case 'wrong-identifier':
        return this.foreignAsset;
      default:
        return this.asset;
    }
  }
  async start() {
    this.asset = await ReleaseServer.archive(this.profile, 'release', this.version);
    this.foreignAsset = await ReleaseServer.archive(
      this.profile,
      'foreign-release',
      this.version,
      'com.example.not-gtv-remote'
    );
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback server address');
    this.url = `http://127.0.0.1:${address.port}`;
  }
  static async archive(
    profile: string,
    name: string,
    version: string,
    identifier = BUNDLE_IDENTIFIER
  ): Promise<Buffer> {
    const source = path.join(profile, `${name}-source`);
    await ReleaseServer.bundle(path.join(source, 'GTV Remote.app'), version, identifier);
    const archive = path.join(profile, `${name}.zip`);
    execFileSync('zip', ['-qr', archive, 'GTV Remote.app'], { cwd: source });
    return readFile(archive);
  }
  static async bundle(bundle: string, version: string, identifier = BUNDLE_IDENTIFIER) {
    await mkdir(path.join(bundle, 'Contents', 'MacOS'), { recursive: true });
    await writeFile(
      path.join(bundle, 'Contents', 'Info.plist'),
      `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`
    );
    await writeFile(
      path.join(bundle, 'Contents', 'MacOS', 'GTV Remote'),
      `synthetic executable metadata ${version}`
    );
  }
  async stop() {
    if (!this.server.listening) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}
