/**
 * Pure parser for varint-length-prefixed frames over the Android TV remote
 * protocol. Extracted from the inline `readNextFrame` + `flushBuffer`
 * loop in `src/main/device/androidTvRemote.ts` so it is:
 *
 *   - unit-testable byte-by-byte without standing up a TLS socket;
 *   - reusable by any future transport (recorded captures, fake socket
 *     in tests, eventual replacement of androidtv-remote with a homegrown
 *     transport).
 *
 * Wire format (matches the on-the-wire format used by Google's Android TV
 * v2 remote service on port 6466):
 *
 *   ┌─────────────┬──────────────────────────────┐
 *   │ varint len  │ protobuf body (`len` bytes)  │
 *   └─────────────┴──────────────────────────────┘
 *
 * The varint is little-endian, 7 bits per byte, high bit set to indicate
 * "more bytes follow". The protocol only uses 32-bit varints, so a header
 * longer than 5 bytes is malformed. Bodies larger than `MAX_FRAME_BODY_BYTES`
 * are rejected so a hostile or corrupt length cannot make the caller buffer
 * without bound.
 *
 * Behavior parity with the previous inline parser is asserted by tests in
 * `__tests__/frameParser.test.ts`.
 */
export interface FrameParseResult {
  /** Frames fully assembled from `buffer`. Each is the WHOLE frame including
   * its varint header (this matches what the previous inline parser
   * returned to callers). */
  readonly frames: readonly Buffer[];
  /** The trailing bytes that did not form a complete frame yet. Must be
   * prepended to the next chunk received from the socket. */
  readonly remaining: Buffer;
  /** Set iff the parser detected a malformed varint header (more than 5
   * bytes) or a frame body larger than `MAX_FRAME_BODY_BYTES`. Caller MUST
   * drop the connection — the stream is unrecoverable. The parser also clears
   * `remaining` to empty in this case. */
  readonly error?: Error;
}

/** Shift of the last (5th) byte a 32-bit varint header may have. A 5th byte
 * that still has its continuation bit set makes the header malformed. */
const MAX_VARINT_SHIFT_BITS = 28;

/** Longest accepted varint header, in bytes. */
const MAX_VARINT_BYTES = 5;

/** Largest accepted frame body. Real remote messages are a few KiB at most
 * (voice payloads are ~20 KiB). */
const MAX_FRAME_BODY_BYTES = 1024 * 1024;

/** Sentinel for a malformed varint header. Matches the message the previous
 * inline parser used so error logs and pollinator tests are unchanged. */
const MALFORMED_FRAME_ERROR_MESSAGE = 'Received an invalid remote protocol frame.';

const FRAME_TOO_LARGE_ERROR_MESSAGE = 'Received an oversized remote protocol frame.';

/**
 * Decode all complete frames sitting in `buffer`. Returns the assembled
 * frames + whatever bytes are left over (must be prepended to the next
 * read).
 *
 * Pure: never mutates `buffer`, never throws (errors are returned in
 * `result.error`), never allocates beyond what the returned `Buffer.subarray`
 * slices reference.
 */
export function parseFramedBuffer(buffer: Buffer): FrameParseResult {
  if (buffer.length === 0) {
    return { frames: [], remaining: buffer };
  }

  const frames: Buffer[] = [];
  let cursor = 0;

  while (cursor < buffer.length) {
    const headerEnd = decodeVarintHeader(buffer, cursor);
    if (headerEnd.kind === 'error') {
      return { frames, remaining: Buffer.alloc(0), error: headerEnd.error };
    }
    if (headerEnd.kind === 'need-more') {
      // Either incomplete varint OR complete varint but not enough body.
      break;
    }

    const frameLength = headerEnd.headerLength + headerEnd.bodyLength;
    if (buffer.length - cursor < frameLength) {
      // Header complete but body not fully received yet.
      break;
    }

    const frame = buffer.subarray(cursor, cursor + frameLength);
    frames.push(frame);
    cursor += frameLength;
  }

  const remaining = cursor === 0 ? buffer : buffer.subarray(cursor);
  return { frames, remaining };
}

type HeaderDecode =
  | { kind: 'ok'; headerLength: number; bodyLength: number }
  | { kind: 'need-more' }
  | { kind: 'error'; error: Error };

/**
 * Decode the varint header starting at `start`. Returns the header byte
 * length AND the protobuf body length (so the caller can immediately compute
 * the total frame length). Returns `need-more` if the varint is incomplete.
 */
function decodeVarintHeader(buffer: Buffer, start: number): HeaderDecode {
  let length = 0;

  for (let index = 0; index < MAX_VARINT_BYTES; index += 1) {
    const byte = buffer[start + index];
    if (byte === undefined) {
      return { kind: 'need-more' };
    }
    // Multiply instead of `<<`: bitwise shifts are 32-bit signed, so the 5th
    // byte (shift 28) would overflow into a negative length.
    length += (byte & 0x7f) * 2 ** (index * 7);
    if (length > MAX_FRAME_BODY_BYTES) {
      return { kind: 'error', error: new Error(FRAME_TOO_LARGE_ERROR_MESSAGE) };
    }

    if ((byte & 0x80) === 0) {
      return { kind: 'ok', headerLength: index + 1, bodyLength: length };
    }
  }

  return { kind: 'error', error: new Error(MALFORMED_FRAME_ERROR_MESSAGE) };
}

export const __TEST__ = {
  FRAME_TOO_LARGE_ERROR_MESSAGE,
  MALFORMED_FRAME_ERROR_MESSAGE,
  MAX_FRAME_BODY_BYTES,
  MAX_VARINT_BYTES,
  MAX_VARINT_SHIFT_BITS,
};
