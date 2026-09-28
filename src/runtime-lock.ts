import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensurePrivateFile } from "./storage-permissions.ts";

export const CORE_RUNTIME_LOCK_FILENAME = "core-runtime.lock";
export const CORE_RUNTIME_ALREADY_RUNNING = "core_runtime_already_running";
export const CORE_RUNTIME_LOCK_INVALID = "core_runtime_lock_invalid";

export type CoreRuntimeLockErrorCode =
  | typeof CORE_RUNTIME_ALREADY_RUNNING
  | typeof CORE_RUNTIME_LOCK_INVALID;

export class CoreRuntimeLockError extends Error {
  readonly code: CoreRuntimeLockErrorCode;

  constructor(code: CoreRuntimeLockErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "CoreRuntimeLockError";
    this.code = code;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export interface CoreRuntimeLock {
  readonly lockPath: string;
  release(): void;
}

export function acquireCoreRuntimeLock(dataDirectory: string): CoreRuntimeLock {
  const lockPath = join(dataDirectory, CORE_RUNTIME_LOCK_FILENAME);
  ensurePrivateFile(lockPath);

  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(lockPath);
    database.exec("PRAGMA busy_timeout = 0");
    database.exec("PRAGMA journal_mode = DELETE");
    database.exec("BEGIN EXCLUSIVE");
    database.prepare("PRAGMA schema_version").get();
  } catch (error) {
    closeAfterFailedAcquisition(database);

    if (isSqliteBusy(error)) {
      throw new CoreRuntimeLockError(
        CORE_RUNTIME_ALREADY_RUNNING,
        `another NetNavr Core already owns data directory ${dataDirectory}`,
        error,
      );
    }

    throw new CoreRuntimeLockError(
      CORE_RUNTIME_LOCK_INVALID,
      `Core runtime lock at ${lockPath} cannot be opened safely`,
      error,
    );
  }

  let released = false;
  return {
    lockPath,
    release(): void {
      if (released) {
        return;
      }
      released = true;

      try {
        database.exec("ROLLBACK");
      } finally {
        database.close();
      }
    },
  };
}

function closeAfterFailedAcquisition(database: DatabaseSync | undefined): void {
  if (database === undefined) {
    return;
  }

  try {
    database.close();
  } catch {
    // Preserve the acquisition error because it carries the actionable cause.
  }
}

function isSqliteBusy(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const sqliteCode = "errcode" in error ? error.errcode : undefined;
  return sqliteCode === 5 || /database is locked|SQLITE_BUSY/i.test(error.message);
}
