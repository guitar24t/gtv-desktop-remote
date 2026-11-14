import { promises as fs } from 'node:fs';
import path from 'node:path';

import { app } from 'electron';

import type { ILogger } from '../backend/core/logger';

type LogLevel = 'INFO' | 'WARN' | 'ERROR';

/** Rotate once the active log reaches this size; one previous file is kept. */
export const MAX_LOG_BYTES = 5 * 1024 * 1024;

function getLogPath(): string {
  return path.join(app.getPath('userData'), 'gtv-remote.log');
}

export function getAppDataPath(...segments: string[]): string {
  return path.join(app.getPath('userData'), ...segments);
}

/**
 * Serialize arbitrary log details without ever throwing: circular references,
 * BigInts and throwing getters/toJSON must not turn a log call into a failure.
 */
export function serializeErrorDetails(details: unknown): string {
  if (details instanceof Error) {
    return `${details.message}\n${details.stack ?? ''}`.trim();
  }

  if (typeof details === 'string') {
    return details;
  }

  try {
    const seen = new WeakSet();
    const serialized = JSON.stringify(details, (_key, value: unknown) => {
      if (typeof value === 'bigint') return value.toString();
      if (value instanceof Error) return { message: value.message, stack: value.stack };
      if (value !== null && typeof value === 'object') {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      return value;
    }) as string | undefined;
    return serialized ?? String(details);
  } catch {
    try {
      return String(details);
    } catch {
      return '[unserializable details]';
    }
  }
}

function writeConsole(level: LogLevel, line: string): void {
  try {
    if (level === 'ERROR') {
      console.error(line);
    } else {
      console.log(line);
    }
  } catch {
    // stdout/stderr can be closed (EPIPE) when launched without a terminal.
  }
}

let writeChain: Promise<void> = Promise.resolve();
let lastFailureReportAt = 0;

function reportLoggerFailure(error: unknown): void {
  // Never route logger failures back through the logger: that is how a full disk
  // used to become an unbounded unhandledRejection → logError → rejection loop.
  const now = Date.now();
  if (now - lastFailureReportAt < 60_000) return;
  lastFailureReportAt = now;
  try {
    console.error(
      `[logger] Could not write log file: ${error instanceof Error ? error.message : String(error)}`
    );
  } catch {
    // Nothing else can be done.
  }
}

async function appendWithRotation(logPath: string, line: string): Promise<void> {
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  try {
    const { size } = await fs.stat(logPath);
    if (size + Buffer.byteLength(line) > MAX_LOG_BYTES) {
      await fs.rename(logPath, `${logPath}.1`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await fs.appendFile(logPath, line, 'utf8');
}

/**
 * Writes are serialized (ordering, rotation) and the returned promise never
 * rejects: callers routinely `await logError(...)` inside catch blocks, and a
 * logging failure must never replace the error they are handling.
 */
function write(level: LogLevel, scope: string, message: string, details?: unknown): Promise<void> {
  let line: string;
  try {
    const timestamp = new Date().toISOString();
    const body = details === undefined ? '' : ` ${serializeErrorDetails(details)}`;
    line = `[${timestamp}] [${level}] [${scope}] ${message}${body}\n`;
  } catch {
    line = `[${level}] [${scope}] ${message}\n`;
  }

  writeConsole(level, line.trim());

  const operation = writeChain
    .then(() => appendWithRotation(getLogPath(), line))
    .catch(reportLoggerFailure);
  writeChain = operation;
  return operation;
}

export async function logInfo(scope: string, message: string, details?: unknown): Promise<void> {
  await write('INFO', scope, message, details);
}

export async function logWarn(scope: string, message: string, details?: unknown): Promise<void> {
  await write('WARN', scope, message, details);
}

export async function logError(scope: string, message: string, details?: unknown): Promise<void> {
  await write('ERROR', scope, message, details);
}

export function getLoggerPath(): string {
  return getLogPath();
}

/**
 * production binding of the `ILogger` port (declared in
 * `src/backend/core/logger.ts`). Composition roots call this once and pass
 * the resulting `ILogger` into backend services so the services never have
 * to import this file directly.
 *
 * The wrappers fire-and-forget the underlying `Promise<void>` so the
 * synchronous `ILogger` contract is satisfied without forcing every backend
 * caller to write `void logger.info(...)`. The underlying promise never
 * rejects, so dropping it cannot produce an unhandled rejection.
 *
 * The factory is deliberately stateless — it returns a fresh object each
 * call so multiple composition roots can each hold their own reference
 * without sharing instance state.
 */
export function createNodeLogger(): ILogger {
  return {
    info: (scope, message, details) => {
      void logInfo(scope, message, details);
    },
    warn: (scope, message, details) => {
      void logWarn(scope, message, details);
    },
    error: (scope, message, details) => {
      void logError(scope, message, details);
    },
  };
}
