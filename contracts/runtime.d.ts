// Public JavaScript runtime declarations; Core source and consumers share these types.
import type { CoreNodeIdentity } from "./core-v1.js";
export {
  CORE_SERVICE, CORE_API_VERSION, CORE_SCHEMA_VERSION,
  type CoreNodeIdentity, type CoreHealth, type CoreErrorCode, type CoreErrorEnvelope,
} from "./core-v1.js";

export declare const CORE_HOST: "127.0.0.1";
export declare const DEFAULT_CORE_PORT: 8786;
export declare const CORE_DATABASE_FILENAME: "core.sqlite";
export declare const CORE_REQUEST_ID_HEADER: "x-request-id";
export declare const CORE_MAX_HEADER_BYTES: 8192;
export declare const CORE_MAX_REQUEST_BODY_BYTES: 0;
export declare const CORE_HEADERS_TIMEOUT_MS: 5000;
export declare const CORE_REQUEST_TIMEOUT_MS: 10000;
export declare const CORE_KEEP_ALIVE_TIMEOUT_MS: 5000;
export declare const CORE_MAX_REQUESTS_PER_SOCKET: 100;
export declare const CORE_VERSION: string;

export interface FixtureProbeOptions {
  /** A private random 32-byte base64url capability; never expose to a renderer. */
  token: string;
  /** Optional absolute isolated directory named fixture-v1; never the product data path. */
  dataDirectory?: string;
}
export interface StartCoreOptions {
  port?: number;
  databasePath?: string;
  /** Disabled by default; requires an explicit :memory: product database. */
  fixtureProbe?: FixtureProbeOptions;
}
export interface RunningCore {
  readonly host: typeof CORE_HOST;
  readonly port: number;
  readonly origin: string;
  readonly node: CoreNodeIdentity;
  close(): Promise<void>;
}
export declare function defaultCoreDatabasePath(): string;
export declare function startCore(options?: StartCoreOptions): Promise<RunningCore>;

export declare const CORE_RUNTIME_ALREADY_RUNNING: "core_runtime_already_running";
export declare const CORE_RUNTIME_LOCK_FILENAME: "core-runtime.lock";
export declare const CORE_RUNTIME_LOCK_INVALID: "core_runtime_lock_invalid";
export type CoreRuntimeLockErrorCode = typeof CORE_RUNTIME_ALREADY_RUNNING | typeof CORE_RUNTIME_LOCK_INVALID;
export declare class CoreRuntimeLockError extends Error {
  readonly code: CoreRuntimeLockErrorCode;
  constructor(code: CoreRuntimeLockErrorCode, message: string, cause?: unknown);
}
export declare const CORE_PRIVATE_DIRECTORY_MODE: 448;
export declare const CORE_PRIVATE_FILE_MODE: 384;
