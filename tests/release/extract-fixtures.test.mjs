import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildIpcPairs, createRedactor } from '../../scripts/lib/capture-redaction.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

const event = { sender: {}, frameId: 1, processId: 4 };
// An old-format capture: raw Electron events and unredacted arguments.
const records = [
  {
    layer: 'ipc',
    direction: 'call',
    event: 'capture-session-start',
    data: { captureFile: '/Users/alice/repo/captures/capture-x.ndjson', pid: 1 },
  },
  {
    layer: 'ipc',
    direction: 'call',
    meta: { channel: 'device:text' },
    data: [event, 'my bank password 42'],
  },
  { layer: 'ipc', direction: 'return', meta: { channel: 'device:text' }, durationMs: 3 },
  {
    layer: 'ipc',
    direction: 'call',
    meta: { channel: 'device:pair' },
    data: [event, { deviceId: 'aa:bb:cc:dd:ee:ff', code: '4F2A9C' }],
  },
  {
    layer: 'ipc',
    direction: 'return',
    meta: { channel: 'device:pair' },
    error:
      'Pairing with 192.168.1.23 failed (cert at /Users/alice/Library/Application Support/GTV Remote/cert.pem)',
  },
  { layer: 'ipc', direction: 'call', meta: { channel: 'device:scan' }, data: [event] },
  {
    layer: 'ipc',
    direction: 'return',
    meta: { channel: 'device:scan' },
    data: [
      {
        id: 'aa:bb:cc:dd:ee:ff',
        name: "Alice's Living Room TV",
        host: '192.168.1.23',
        mac: 'AA:BB:CC:DD:EE:FF',
      },
      { id: 'tv-2', name: 'Bedroom', host: 'fe80::1c2b:3d4e:5f60:7182' },
    ],
  },
  {
    layer: 'ipc',
    direction: 'call',
    meta: { channel: 'device:assistantVoiceChunk' },
    data: [event, 7, 'UklGRiQAAABXQVZF'],
  },
  { layer: 'ipc', direction: 'return', meta: { channel: 'device:assistantVoiceChunk' } },
  {
    layer: 'discovery',
    direction: 'rx',
    event: 'service',
    data: { name: "Alice's Living Room TV", addresses: ['192.168.1.23'] },
  },
];

const SECRETS = [
  'my bank password',
  '4F2A9C',
  '192.168.1.23',
  'aa:bb:cc:dd:ee:ff',
  '/Users/alice',
  "Alice's Living Room TV",
  'frameId',
  'processId',
  'UklGRiQAAABXQVZF',
  'fe80::1c2b',
];

function assertNoSecrets(value) {
  const serialized = JSON.stringify(value).toLowerCase();
  for (const secret of SECRETS) {
    assert.equal(serialized.includes(secret.toLowerCase()), false, `leaked ${secret}`);
  }
}

test('IPC pairs drop Electron events and redact typed text, codes, audio, names and addresses', () => {
  const redactor = createRedactor({ homeDir: '/Users/alice', username: 'alice' });
  const pairs = buildIpcPairs(records, redactor);
  assertNoSecrets(pairs);

  const byChannel = Object.fromEntries(pairs.map((pair) => [pair.channel, pair]));
  assert.deepEqual(byChannel['device:text'].args, ['[redacted text, 19 chars]']);
  assert.equal(byChannel['device:pair'].args[0].code, '[redacted]');
  assert.deepEqual(byChannel['device:assistantVoiceChunk'].args, [
    7,
    '[redacted audio, 16 base64 chars]',
  ]);
  assert.deepEqual(byChannel['device:scan'].args, []);

  // Replacements are stable, so relationships between records survive.
  const [tv, bedroom] = byChannel['device:scan'].result;
  assert.equal(tv.name, 'Device 1');
  assert.equal(tv.host, '192.0.2.1');
  assert.equal(tv.id, byChannel['device:pair'].args[0].deviceId);
  assert.equal(tv.mac, tv.id);
  assert.equal(bedroom.name, 'Device 2');
  assert.match(bedroom.host, /^2001:db8::/);
  assert.match(byChannel['device:pair'].error, /192\.0\.2\.1 failed \(cert at ~\/Library/);
});

test('already-redacted captures are left as they are', () => {
  const redactor = createRedactor({ homeDir: '/Users/alice', username: 'alice' });
  const pairs = buildIpcPairs(
    [
      {
        layer: 'ipc',
        direction: 'call',
        meta: { channel: 'device:text' },
        data: ['[redacted text, 5 chars]'],
      },
      { layer: 'ipc', direction: 'return', meta: { channel: 'device:text' } },
    ],
    redactor
  );
  assert.deepEqual(pairs[0].args, ['[redacted text, 5 chars]']);
});

test('the extractor CLI writes only redacted JSON and the capture file name', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'gtv-extract-fixtures-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const capture = join(directory, 'capture-2026-11-12T00-00-00.ndjson');
  writeFileSync(capture, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const out = join(directory, 'out');

  const stdout = execFileSync(
    process.execPath,
    [join(root, 'scripts', 'extract-fixtures.mjs'), capture, '--out-dir', out],
    { encoding: 'utf8' }
  );

  const ipc = JSON.parse(readFileSync(join(out, '__fixtures__', 'ipc-session.json'), 'utf8'));
  const discovery = JSON.parse(
    readFileSync(join(out, 'discovery', '__fixtures__', 'discovery-session.json'), 'utf8')
  );
  assert.equal(ipc.captureFile, 'capture-2026-11-12T00-00-00.ndjson');
  assert.equal(ipc.redacted, true);
  assertNoSecrets(ipc);
  assertNoSecrets(discovery);
  assert.doesNotMatch(stdout, /Commit the fixture files/);
  assert.match(stdout, /gitignored/);
});

test('generated fixture paths are gitignored', () => {
  const gitignore = readFileSync(join(root, '.gitignore'), 'utf8');
  for (const generated of [
    '/src/backend/__fixtures__/ipc-session.json',
    '/src/backend/discovery/__fixtures__/discovery-session.json',
    '/src/backend/voice/__fixtures__/voice-session.json',
    '/src/backend/voice/__fixtures__/voice-chunks-concatenated.bin',
    '/src/backend/transport/framing/__fixtures__/inbound-frames-meta.json',
    '/src/backend/transport/framing/__fixtures__/frames/',
  ]) {
    assert.ok(gitignore.split('\n').includes(generated), `${generated} is not gitignored`);
  }
});
