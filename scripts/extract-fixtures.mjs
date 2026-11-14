#!/usr/bin/env node
/**
 * Fixture extractor — converts a captures/capture-*.ndjson session log into
 * redacted, local-only fixture files for writing tests without a real TV.
 *
 * Usage:
 *   node scripts/extract-fixtures.mjs captures/capture-2026-05-20T...ndjson
 *   node scripts/extract-fixtures.mjs              # auto-picks the latest capture
 *   node scripts/extract-fixtures.mjs <capture> --out-dir <dir>   # write elsewhere
 *
 * Output (relative to --out-dir, default src/backend; all paths are gitignored):
 *   __fixtures__/ipc-session.json
 *   discovery/__fixtures__/discovery-session.json
 *   voice/__fixtures__/voice-session.json, voice-chunks-concatenated.bin
 *   transport/framing/__fixtures__/inbound-frames-meta.json, frames/*.bin
 *
 * JSON outputs are redacted (typed text, pairing codes, voice audio, device
 * names, IP/MAC addresses, home-directory paths, raw Electron event objects).
 * Binary frames and voice audio cannot be redacted: never commit them. To add
 * a committed fixture, review these files and copy only the minimal,
 * anonymised data a test needs into a new, reviewed fixture file.
 *
 * Run this after GTV_CAPTURE=1 yarn dev.
 */

import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildIpcPairs, createRedactor } from './lib/capture-redaction.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CAPTURES_DIR = path.join(ROOT, 'captures');

// ── arguments ─────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const options = { input: undefined, outDir: path.join(ROOT, 'src', 'backend') };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out-dir') {
      const value = argv[index + 1];
      if (!value) throw new Error('--out-dir requires a directory');
      options.outDir = path.resolve(value);
      index += 1;
    } else if (!options.input) {
      options.input = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  return options;
}

function findLatestCapture() {
  if (!fs.existsSync(CAPTURES_DIR)) {
    console.error('No captures/ directory found. Run GTV_CAPTURE=1 yarn dev first.');
    process.exit(1);
  }
  const files = fs
    .readdirSync(CAPTURES_DIR)
    .filter((f) => f.endsWith('.ndjson'))
    .sort()
    .reverse();
  if (!files.length) {
    console.error('No capture files found in captures/. Run GTV_CAPTURE=1 yarn dev first.');
    process.exit(1);
  }
  return path.join(CAPTURES_DIR, files[0]);
}

const options = parseArgs(process.argv.slice(2));
const inputFile = options.input ?? findLatestCapture();
const FIXTURES_ROOT = options.outDir;
// Record only the capture's file name, never an absolute path with a username.
const captureFile = path.basename(inputFile);
const redactor = createRedactor();
console.log(`\n📂 Reading capture: ${captureFile}\n`);

// ── parse ndjson ──────────────────────────────────────────────────────────────

const records = fs
  .readFileSync(inputFile, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line, i) => {
    try {
      return JSON.parse(line);
    } catch {
      console.warn(`  warn: skipping malformed line ${i + 1}`);
      return null;
    }
  })
  .filter(Boolean);

console.log(`  ${records.length} records loaded`);

// ── helpers ───────────────────────────────────────────────────────────────────

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log(
    `  ✅ wrote ${path.relative(ROOT, filePath)}  (${JSON.stringify(data).length} bytes)`
  );
}

function writeBin(filePath, hexString) {
  ensureDir(path.dirname(filePath));
  const buf = Buffer.from(hexString, 'hex');
  fs.writeFileSync(filePath, buf);
  console.log(`  ✅ wrote ${path.relative(ROOT, filePath)}  (${buf.length} bytes)`);
}

// ── extract by layer ──────────────────────────────────────────────────────────

// IPC session — all call/return pairs, redacted
const ipcPairs = buildIpcPairs(records, redactor);
if (ipcPairs.length) {
  writeJson(path.join(FIXTURES_ROOT, '__fixtures__', 'ipc-session.json'), {
    captureFile,
    redacted: true,
    pairs: ipcPairs,
  });
}

// Transport — inbound raw frames (hex) concatenated into a single binary fixture
const inboundFrames = records.filter(
  (r) => r.layer === 'transport' && r.direction === 'rx' && r.hex
);
if (inboundFrames.length) {
  const frameMeta = inboundFrames.map((r) => ({
    seq: r.seq,
    ts: r.ts,
    hexLength: r.hex.length / 2,
  }));
  writeJson(
    path.join(FIXTURES_ROOT, 'transport', 'framing', '__fixtures__', 'inbound-frames-meta.json'),
    { captureFile, frameCount: inboundFrames.length, frames: frameMeta }
  );
  // write each frame as a separate .bin file (for byte-exact parseFramedBuffer tests)
  const framesDir = path.join(FIXTURES_ROOT, 'transport', 'framing', '__fixtures__', 'frames');
  ensureDir(framesDir);
  inboundFrames.forEach((r, i) => {
    writeBin(path.join(framesDir, `frame-${String(i).padStart(4, '0')}.bin`), r.hex);
  });
}

// Voice — full voice session
const voiceRecords = records.filter((r) => r.layer === 'voice');
if (voiceRecords.length) {
  const voiceChunks = voiceRecords.filter((r) => r.event === 'voiceChunk');
  const voiceEvents = voiceRecords.filter((r) => r.event !== 'voiceChunk');
  writeJson(path.join(FIXTURES_ROOT, 'voice', '__fixtures__', 'voice-session.json'), {
    captureFile,
    redacted: true,
    events: voiceEvents.map((r) => ({
      seq: r.seq,
      ts: r.ts,
      event: r.event,
      meta: redactor.redact(r.meta),
    })),
    chunkCount: voiceChunks.length,
    totalBytes: voiceChunks.reduce((sum, r) => sum + (r.meta?.byteLength ?? 0), 0),
  });
  // write PCM chunks as a single concatenated binary for voice codec tests
  if (voiceChunks.length) {
    const chunksDir = path.join(FIXTURES_ROOT, 'voice', '__fixtures__');
    ensureDir(chunksDir);
    const allHex = voiceChunks.map((r) => r.hex ?? '').join('');
    writeBin(path.join(chunksDir, 'voice-chunks-concatenated.bin'), allHex);
  }
}

// Discovery
const discoveryRecords = records.filter((r) => r.layer === 'discovery');
if (discoveryRecords.length) {
  writeJson(path.join(FIXTURES_ROOT, 'discovery', '__fixtures__', 'discovery-session.json'), {
    captureFile,
    redacted: true,
    events: discoveryRecords.map((r) => ({
      seq: r.seq,
      ts: r.ts,
      event: r.event,
      data: redactor.redact(r.data),
      meta: redactor.redact(r.meta),
    })),
  });
}

// ── summary ───────────────────────────────────────────────────────────────────

console.log(`
✅ Extraction complete.

The JSON files above are redacted: typed text, pairing codes, voice audio,
device names, IP/MAC addresses and home-directory paths were replaced with
placeholders. Raw protocol frames (*.bin) and voice audio are NOT redacted.

These outputs are gitignored and are for local test development only:
  1. Review the generated files by hand.
  2. Copy only the minimal, anonymised data a test needs into a new fixture
     file, and review that diff before committing it.
  3. Never commit raw captures, frames or voice audio.
  4. Run: yarn test
`);
