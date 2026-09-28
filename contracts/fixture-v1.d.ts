export declare const FIXTURE_CONTRACT_VERSION: "fixture-v1";
export declare const FIXTURE_SCHEMA_VERSION: 1;
export declare const FIXTURE_MAX_STORAGE_FILE_BYTES: 131072;
export declare const FIXTURE_VERSION_HEADER: "x-netnavr-probe-version";
export declare const FIXTURE_STATE_PATH: "/v1/fixture/state";
export declare const FIXTURE_COMMANDS_PATH: "/v1/fixture/commands";
export declare const FIXTURE_MAX_BODY_BYTES: 1024;
export declare const FIXTURE_BODY_TIMEOUT_MS: 1000;
export declare const FIXTURE_MAX_DELAY_MS: 500;
export declare const FIXTURE_MAX_TIMEOUT_MS: 1000;
export declare const FIXTURE_COMMAND_CAPACITY: 128;

export type FixtureMarker = "empty" | "alpha" | "beta";
export interface FixtureState {
  contractVersion: typeof FIXTURE_CONTRACT_VERSION;
  fixtureSessionId: string;
  persistence: "memory-only" | "isolated-fixture";
  fixtureSchemaVersion: typeof FIXTURE_SCHEMA_VERSION;
  commandPersistence: "session-only";
  marker: FixtureMarker;
  revision: number;
}
export interface FixtureCommandInput {
  commandId: string;
  operation: "set-marker";
  marker: Exclude<FixtureMarker, "empty">;
  delayMs?: number;
  timeoutMs?: number;
}
export type FixtureCommandStatus = "pending" | "completed" | "cancelled" | "timed_out" | "storage_error";
export interface FixtureCommandResult {
  contractVersion: typeof FIXTURE_CONTRACT_VERSION;
  fixtureSessionId: string;
  commandId: string;
  operation: "set-marker";
  status: FixtureCommandStatus;
  state: FixtureState;
}
export type FixtureErrorCode =
  | "probe_unauthorized"
  | "probe_origin_rejected"
  | "probe_incompatible"
  | "probe_invalid_input"
  | "probe_body_too_large"
  | "probe_body_timeout"
  | "probe_busy"
  | "probe_id_conflict"
  | "probe_capacity"
  | "probe_command_not_found"
  | "probe_closed";
export interface FixtureErrorEnvelope {
  error: { code: FixtureErrorCode | "method_not_allowed" | "request_body_not_allowed"; message: string };
  requestId: string;
}
