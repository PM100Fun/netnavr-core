import { resolve } from "node:path";
import {
  CORE_DATABASE_FILENAME,
  DEFAULT_CORE_PORT,
} from "./server.ts";

export function portFromEnvironment(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_CORE_PORT;
  }

  if (!/^\d+$/.test(value)) {
    throw new RangeError("NETNAVR_CORE_PORT must be an integer between 0 and 65535");
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError("NETNAVR_CORE_PORT must be an integer between 0 and 65535");
  }

  return port;
}

export function databasePathFromEnvironment(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.trim().length === 0 || value.includes("\0")) {
    throw new TypeError("NETNAVR_CORE_DATA_DIR must be a non-empty directory path");
  }
  return resolve(value, CORE_DATABASE_FILENAME);
}
