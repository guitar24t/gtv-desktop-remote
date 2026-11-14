/**
 * Redaction for GTV_CAPTURE session logs before they become test fixtures.
 *
 * Captures can contain what was typed to the TV, pairing codes, voice audio,
 * device names, LAN IP/MAC addresses and absolute paths that include the
 * developer's username. Older captures also include the raw Electron IPC event
 * object as the first handler argument. Everything that leaves this module is
 * scrubbed; replacements are stable within one run so relationships between
 * records (same device, same address) survive.
 */
import os from 'node:os';

const TEXT_KEYS = new Set(['text', 'typedtext', 'devicetext', 'imetext']);
const SECRET_KEYS = new Set([
  'code',
  'paircode',
  'pairingcode',
  'pin',
  'secret',
  'token',
  'password',
  'cert',
  'certificate',
  'privatekey',
  'clientcert',
  'clientkey',
]);
const NAME_KEYS = new Set([
  'name',
  'devicename',
  'friendlyname',
  'displayname',
  'hostname',
  'servicename',
  'instancename',
  'fqdn',
]);
const ELECTRON_EVENT_KEYS = ['sender', 'senderFrame', 'frameId', 'processId'];

const MAC = /\b[0-9a-f]{2}(?:[:-][0-9a-f]{2}){5}\b/gi;
const IPV6 =
  /(?<![\w:])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,6}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,5})?|::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?)(?![\w:])/gi;
const IPV4 = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g;
const POSIX_HOME = /\/(Users|home)\/[^/\s"'`]+/g;
const WINDOWS_HOME = /([A-Za-z]:\\Users\\)[^\\\s"'`]+/g;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function currentUsername() {
  try {
    return os.userInfo().username;
  } catch {
    return '';
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** True for a serialized Electron IpcMainInvokeEvent (first argument in old captures). */
export function isElectronEvent(value) {
  return isPlainObject(value) && ELECTRON_EVENT_KEYS.some((key) => key in value);
}

function isPlaceholder(value) {
  return typeof value === 'string' && value.startsWith('[redacted');
}

export function createRedactor({ homeDir = os.homedir(), username = currentUsername() } = {}) {
  const pseudonyms = new Map();
  function pseudonym(kind, value, make) {
    let table = pseudonyms.get(kind);
    if (!table) {
      table = new Map();
      pseudonyms.set(kind, table);
    }
    if (!table.has(value)) table.set(value, make(table.size + 1));
    return table.get(value);
  }

  const usernamePattern =
    username && username.length >= 3 ? new RegExp(escapeRegExp(username), 'gi') : undefined;

  /** Scrub free text: home paths, username, MAC/IPv6/IPv4 addresses. */
  function scrubString(value) {
    if (isPlaceholder(value)) return value;
    let result = value;
    if (homeDir && homeDir.length > 1) result = result.split(homeDir).join('~');
    result = result.replace(POSIX_HOME, '/$1/<user>').replace(WINDOWS_HOME, '$1<user>');
    if (usernamePattern) result = result.replace(usernamePattern, '<user>');
    result = result.replace(MAC, (match) =>
      pseudonym(
        'mac',
        match.toLowerCase(),
        (n) => `02:00:00:00:00:${n.toString(16).padStart(2, '0')}`
      )
    );
    result = result.replace(IPV6, (match) =>
      pseudonym('ipv6', match.toLowerCase(), (n) => `2001:db8::${n.toString(16)}`)
    );
    result = result.replace(IPV4, (match) => pseudonym('ipv4', match, (n) => `192.0.2.${n}`));
    return result;
  }

  function redactField(key, value) {
    const normalized = key.toLowerCase();
    if (TEXT_KEYS.has(normalized) && typeof value === 'string') {
      return isPlaceholder(value) ? value : `[redacted text, ${value.length} chars]`;
    }
    if (SECRET_KEYS.has(normalized) && value !== null && value !== undefined) {
      return '[redacted]';
    }
    if (NAME_KEYS.has(normalized) && typeof value === 'string' && value) {
      return pseudonym('name', value, (n) => `Device ${n}`);
    }
    return redact(value);
  }

  /** Deep-copy a JSON value with every sensitive field replaced. */
  function redact(value) {
    if (Array.isArray(value)) return value.map((item) => redact(item));
    if (isPlainObject(value)) {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, item]) => !isElectronEvent(item))
          .map(([key, item]) => [key, redactField(key, item)])
      );
    }
    if (typeof value === 'string') return scrubString(value);
    return value;
  }

  /** Redact IPC handler arguments, dropping raw Electron event objects. */
  function redactIpcArgs(channel, data) {
    const args = (Array.isArray(data) ? data : data === undefined ? [] : [data]).filter(
      (arg) => !isElectronEvent(arg)
    );
    if (channel === 'device:text') {
      return args.map((arg) =>
        isPlaceholder(arg)
          ? arg
          : typeof arg === 'string'
            ? `[redacted text, ${arg.length} chars]`
            : '[redacted]'
      );
    }
    if (channel === 'device:assistantVoiceChunk') {
      return args.map((arg) =>
        typeof arg === 'string' && !isPlaceholder(arg)
          ? `[redacted audio, ${arg.length} base64 chars]`
          : redact(arg)
      );
    }
    return args.map((arg) => redact(arg));
  }

  return { redact, redactIpcArgs, scrubString };
}

/** Pair IPC call/return records by channel, redacting arguments, results and errors. */
export function buildIpcPairs(records, redactor) {
  const ipcRecords = records.filter(
    (record) =>
      record.layer === 'ipc' &&
      record.event !== 'capture-session-start' &&
      record.event !== 'capture-session-end'
  );
  const pairs = [];
  const calls = new Map();
  for (const record of ipcRecords) {
    const channel = record.meta?.channel;
    if (record.direction === 'call') {
      calls.set(channel, record);
    } else if (record.direction === 'return') {
      const call = calls.get(channel);
      pairs.push({
        channel,
        args: redactor.redactIpcArgs(channel, call?.data),
        result: redactor.redact(record.data),
        durationMs: record.durationMs,
        ...(record.error ? { error: redactor.scrubString(String(record.error)) } : {}),
      });
      calls.delete(channel);
    }
  }
  return pairs;
}
