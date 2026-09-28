import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  mkdirSync,
  openSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const CORE_PRIVATE_DIRECTORY_MODE = 0o700;
export const CORE_PRIVATE_FILE_MODE = 0o600;

export interface CoreStoragePath {
  readonly dataDirectory: string;
  readonly databasePath: string;
}

export function prepareCoreStoragePath(databasePath: string): CoreStoragePath {
  if (databasePath.length === 0) {
    throw new TypeError("databasePath must not be empty");
  }
  if (databasePath === ":memory:") {
    throw new TypeError("an in-memory database does not have a storage path");
  }

  const absoluteDatabasePath = resolve(databasePath);
  const requestedDirectory = dirname(absoluteDatabasePath);

  mkdirSync(requestedDirectory, {
    mode: CORE_PRIVATE_DIRECTORY_MODE,
    recursive: true,
  });
  if (process.platform !== "win32") {
    chmodSync(requestedDirectory, CORE_PRIVATE_DIRECTORY_MODE);
  }

  const dataDirectory = realpathSync.native(requestedDirectory);
  return {
    dataDirectory,
    databasePath: join(dataDirectory, basename(absoluteDatabasePath)),
  };
}

export function ensurePrivateFile(filePath: string): void {
  const descriptor = openSync(
    filePath,
    constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY,
    CORE_PRIVATE_FILE_MODE,
  );

  try {
    if (process.platform !== "win32") {
      fchmodSync(descriptor, CORE_PRIVATE_FILE_MODE);
    }
  } finally {
    closeSync(descriptor);
  }
}

export function hardenExistingPrivateFile(filePath: string): void {
  if (process.platform === "win32") {
    return;
  }

  try {
    chmodSync(filePath, CORE_PRIVATE_FILE_MODE);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return;
    }
    throw error;
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
