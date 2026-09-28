import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
  CORE_SCHEMA_VERSION,
  CoreNodeStore,
  type CoreNodeIdentity,
} from "./node-store.ts";
import { acquireCoreRuntimeLock, type CoreRuntimeLock } from "./runtime-lock.ts";
import { prepareCoreStoragePath } from "./storage-permissions.ts";

// Modified for the repository split: the wire contract is owned by contracts/.
import {
  CORE_SERVICE,
  CORE_API_VERSION,
  type CoreHealth,
  type CoreErrorCode,
  type CoreErrorEnvelope,
} from "../contracts/core-v1.js";
export { CORE_SERVICE, CORE_API_VERSION };
export type { CoreHealth, CoreErrorCode, CoreErrorEnvelope };
export const CORE_HOST = "127.0.0.1";
export const DEFAULT_CORE_PORT = 8786;
export const CORE_DATABASE_FILENAME = "core.sqlite";
export const CORE_REQUEST_ID_HEADER = "x-request-id";
export const CORE_MAX_HEADER_BYTES = 8 * 1024;
export const CORE_MAX_REQUEST_BODY_BYTES = 0;
export const CORE_HEADERS_TIMEOUT_MS = 5_000;
export const CORE_REQUEST_TIMEOUT_MS = 10_000;
export const CORE_KEEP_ALIVE_TIMEOUT_MS = 5_000;
export const CORE_MAX_REQUESTS_PER_SOCKET = 100;

const packageMetadata = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version?: unknown };

if (typeof packageMetadata.version !== "string") {
  throw new TypeError("core/package.json must contain a string version");
}

export const CORE_VERSION = packageMetadata.version;

export interface StartCoreOptions {
  port?: number;
  databasePath?: string;
}

export interface RunningCore {
  readonly host: typeof CORE_HOST;
  readonly port: number;
  readonly origin: string;
  readonly node: CoreNodeIdentity;
  close(): Promise<void>;
}

export function defaultCoreDatabasePath(): string {
  return join(homedir(), ".netnavr", "core", CORE_DATABASE_FILENAME);
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
  requestId: string,
  additionalHeaders: OutgoingHttpHeaders = {},
): void {
  const body = `${JSON.stringify(payload)}\n`;

  response.writeHead(statusCode, {
    "cache-control": "no-store",
    ...additionalHeaders,
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    [CORE_REQUEST_ID_HEADER]: requestId,
  });
  response.end(body);
}

function writeError(
  response: ServerResponse,
  statusCode: number,
  requestId: string,
  code: CoreErrorCode,
  message: string,
  additionalHeaders: OutgoingHttpHeaders = {},
): void {
  const payload: CoreErrorEnvelope = {
    error: { code, message },
    requestId,
  };
  writeJson(response, statusCode, payload, requestId, additionalHeaders);
}

function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  startedAt: bigint,
  node: CoreNodeIdentity,
): void {
  const requestId = `req_${randomUUID()}`;

  if (requestHasBody(request)) {
    request.resume();
    writeError(
      response,
      413,
      requestId,
      "request_body_not_allowed",
      "Core read-only API does not accept request bodies",
      { connection: "close" },
    );
    return;
  }

  let pathname: string;
  try {
    pathname = new URL(request.url ?? "/", `http://${CORE_HOST}`).pathname;
  } catch {
    request.resume();
    writeError(
      response,
      400,
      requestId,
      "invalid_request_target",
      "Request target is invalid",
      { connection: "close" },
    );
    return;
  }

  const isKnownRoute = pathname === "/v1/health" || pathname === "/v1/node";
  if (isKnownRoute && request.method !== "GET") {
    writeError(
      response,
      405,
      requestId,
      "method_not_allowed",
      "Method not allowed",
      { allow: "GET" },
    );
    return;
  }

  if (request.method === "GET" && pathname === "/v1/health") {
    const elapsedNanoseconds = process.hrtime.bigint() - startedAt;
    const health: CoreHealth = {
      service: CORE_SERVICE,
      status: "ok",
      apiVersion: CORE_API_VERSION,
      version: CORE_VERSION,
      uptimeSeconds: Number(elapsedNanoseconds / 1_000_000_000n),
    };

    writeJson(response, 200, health, requestId);
    return;
  }

  if (request.method === "GET" && pathname === "/v1/node") {
    writeJson(response, 200, node, requestId);
    return;
  }

  writeError(response, 404, requestId, "not_found", "Route not found");
}

function requestHasBody(request: IncomingMessage): boolean {
  if (request.headers["transfer-encoding"] !== undefined) {
    return true;
  }

  const contentLength = request.headers["content-length"];
  if (contentLength === undefined) {
    return false;
  }

  const values = Array.isArray(contentLength) ? contentLength : [contentLength];
  return values.some((value) => {
    const normalized = value.trim();
    if (!/^\d+$/.test(normalized)) {
      return true;
    }

    const length = Number(normalized);
    return !Number.isSafeInteger(length) || length > CORE_MAX_REQUEST_BODY_BYTES;
  });
}

function validatePort(port: number): void {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError("port must be an integer between 0 and 65535");
  }
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error): void => {
      server.off("listening", handleListening);
      reject(error);
    };
    const handleListening = (): void => {
      server.off("error", handleError);
      resolve();
    };

    server.once("error", handleError);
    server.once("listening", handleListening);
    server.listen({ host: CORE_HOST, port });
  });
}

export async function startCore(options: StartCoreOptions = {}): Promise<RunningCore> {
  const port = options.port ?? DEFAULT_CORE_PORT;
  validatePort(port);

  const requestedDatabasePath = options.databasePath ?? defaultCoreDatabasePath();
  let runtimeLock: CoreRuntimeLock | undefined;
  let databasePath = requestedDatabasePath;

  if (requestedDatabasePath !== ":memory:") {
    const storagePath = prepareCoreStoragePath(requestedDatabasePath);
    databasePath = storagePath.databasePath;
    runtimeLock = acquireCoreRuntimeLock(storagePath.dataDirectory);
  }

  let store: CoreNodeStore;
  try {
    store = new CoreNodeStore(databasePath);
  } catch (error) {
    runtimeLock?.release();
    throw error;
  }
  const node = store.getNodeIdentity();

  const startedAt = process.hrtime.bigint();
  const server = createServer(
    {
      headersTimeout: CORE_HEADERS_TIMEOUT_MS,
      insecureHTTPParser: false,
      keepAliveTimeout: CORE_KEEP_ALIVE_TIMEOUT_MS,
      maxHeaderSize: CORE_MAX_HEADER_BYTES,
      requestTimeout: CORE_REQUEST_TIMEOUT_MS,
      requireHostHeader: true,
    },
    (request, response) => {
      routeRequest(request, response, startedAt, node);
    },
  );
  server.maxRequestsPerSocket = CORE_MAX_REQUESTS_PER_SOCKET;

  try {
    await listen(server, port);
  } catch (error) {
    closeRuntimeResources(store, runtimeLock);
    throw error;
  }

  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeRuntimeResources(store, runtimeLock);
    throw new Error("core server did not bind to a TCP address");
  }

  const boundPort = (address as AddressInfo).port;
  let closePromise: Promise<void> | undefined;

  return {
    host: CORE_HOST,
    port: boundPort,
    origin: `http://${CORE_HOST}:${boundPort}`,
    node,
    close(): Promise<void> {
      if (closePromise !== undefined) {
        return closePromise;
      }

      closePromise = new Promise<void>((resolve, reject) => {
        const finish = (serverError?: Error): void => {
          try {
            closeRuntimeResources(store, runtimeLock);
          } catch (runtimeError) {
            reject(runtimeError);
            return;
          }

          if (serverError) {
            reject(serverError);
            return;
          }
          resolve();
        };

        if (!server.listening) {
          finish();
          return;
        }

        server.close((error) => {
          finish(error ?? undefined);
        });
      });

      return closePromise;
    },
  };
}

function closeRuntimeResources(
  store: CoreNodeStore,
  runtimeLock: CoreRuntimeLock | undefined,
): void {
  let storageError: unknown;
  try {
    store.close();
  } catch (error) {
    storageError = error;
  }

  try {
    runtimeLock?.release();
  } catch (lockError) {
    if (storageError === undefined) {
      throw lockError;
    }
  }

  if (storageError !== undefined) {
    throw storageError;
  }
}

export {
  CORE_RUNTIME_ALREADY_RUNNING,
  CORE_RUNTIME_LOCK_FILENAME,
  CORE_RUNTIME_LOCK_INVALID,
  CoreRuntimeLockError,
} from "./runtime-lock.ts";
export {
  CORE_PRIVATE_DIRECTORY_MODE,
  CORE_PRIVATE_FILE_MODE,
} from "./storage-permissions.ts";
export { CORE_SCHEMA_VERSION };
