/**
 * Minimal filesystem port that lets backend services be tested without
 * touching the real disk. Production code injects `nodeFileSystem` (which
 * proxies to `node:fs/promises`); tests inject an in-memory implementation.
 *
 * Methods are deliberately narrow — only what the cert store and (future)
 * device repository need. New methods get added on demand as later services
 * land.
 */
import { promises as fsPromises } from 'node:fs';

export interface IFileSystem {
  readFile(filePath: string, encoding: 'utf8'): Promise<string>;
  /**
   * Write `contents` to `filePath`. When `mode` is given (e.g. `0o600` for
   * private keys) the file is created with — and, if it already existed,
   * changed to — that permission mode.
   */
  writeFile(filePath: string, contents: string, encoding: 'utf8', mode?: number): Promise<void>;
  mkdir(dirPath: string, options: { recursive: true }): Promise<void>;
  /** Best-effort delete; never throws on ENOENT. */
  rm(filePath: string, options: { force: true }): Promise<void>;
  /** Recursive best-effort delete; used by `bridge.reset()`. */
  rmRecursive(target: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Returns true iff the path exists. Never throws. */
  exists(filePath: string): Promise<boolean>;
}

/**
 * Production implementation backed by `node:fs/promises`. Kept here so the
 * backend layer does not need a direct import of `electron`'s app data path
 * (that comes in via `IPathProvider`).
 */
export function createNodeFileSystem(): IFileSystem {
  return {
    readFile: (filePath, encoding) => fsPromises.readFile(filePath, encoding),
    writeFile: async (filePath, contents, encoding, mode) => {
      if (mode === undefined) {
        await fsPromises.writeFile(filePath, contents, encoding);
        return;
      }
      await fsPromises.writeFile(filePath, contents, { encoding, mode });
      // `mode` only applies on creation and is filtered by the umask.
      await fsPromises.chmod(filePath, mode);
    },
    mkdir: async (dirPath, options) => {
      await fsPromises.mkdir(dirPath, options);
    },
    rm: (filePath, options) => fsPromises.rm(filePath, options),
    rmRecursive: (target) => fsPromises.rm(target, { force: true, recursive: true }),
    rename: (from, to) => fsPromises.rename(from, to),
    exists: async (filePath) => {
      try {
        await fsPromises.access(filePath);
        return true;
      } catch {
        return false;
      }
    },
  };
}
