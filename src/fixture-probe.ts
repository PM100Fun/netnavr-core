import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  FIXTURE_BODY_TIMEOUT_MS,
  FIXTURE_COMMAND_CAPACITY,
  FIXTURE_COMMANDS_PATH,
  FIXTURE_CONTRACT_VERSION,
  FIXTURE_SCHEMA_VERSION,
  FIXTURE_MAX_BODY_BYTES,
  FIXTURE_MAX_DELAY_MS,
  FIXTURE_MAX_TIMEOUT_MS,
  FIXTURE_STATE_PATH,
  FIXTURE_VERSION_HEADER,
  type FixtureCommandInput,
  type FixtureCommandResult,
  type FixtureCommandStatus,
  type FixtureErrorCode,
  type FixtureState,
} from "../contracts/fixture-v1.js";
import { FixtureStore } from "./fixture-store.ts";
import type { FixtureProbeOptions } from "../contracts/runtime.js";
export type { FixtureProbeOptions } from "../contracts/runtime.js";

type WriteJson = (response: ServerResponse, status: number, payload: unknown, requestId: string) => void;
interface CommandRecord {
  input: Required<FixtureCommandInput>;
  result: FixtureCommandResult;
  commitTimer?: ReturnType<typeof setTimeout>;
  timeoutTimer?: ReturnType<typeof setTimeout>;
}

const COMMAND_ID = /^cmd_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class ProbeInputError extends Error {
  readonly code: FixtureErrorCode;
  readonly status: number;
  constructor(code: FixtureErrorCode, status: number, message: string) { super(message); this.code = code; this.status = status; }
}

function readCommand(request: IncomingMessage, response: ServerResponse): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error?: ProbeInputError, input?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAborted);
      request.off("error", onAborted);
      response.off("close", onAborted);
      if (error) {
        request.resume();
        reject(error);
      } else resolve(input);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > FIXTURE_MAX_BODY_BYTES) {
        finish(new ProbeInputError("probe_body_too_large", 413, "Probe input exceeds the byte limit"));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      try { finish(undefined, JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { finish(new ProbeInputError("probe_invalid_input", 400, "Probe input must be valid JSON")); }
    };
    const onAborted = (): void => finish(new ProbeInputError("probe_invalid_input", 400, "Probe request was interrupted"));
    const timer = setTimeout(() => finish(new ProbeInputError("probe_body_timeout", 408, "Probe input timed out")), FIXTURE_BODY_TIMEOUT_MS);
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAborted);
    request.once("error", onAborted);
    response.once("close", onAborted);
  });
}

function normalizeInput(input: unknown): Required<FixtureCommandInput> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) invalid();
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["commandId", "operation", "marker", "delayMs", "timeoutMs"].includes(key))) invalid();
  const delayMs = value.delayMs === undefined ? 0 : value.delayMs;
  const timeoutMs = value.timeoutMs === undefined ? FIXTURE_MAX_TIMEOUT_MS : value.timeoutMs;
  if (typeof value.commandId !== "string" || !COMMAND_ID.test(value.commandId) ||
      value.operation !== "set-marker" || !["alpha", "beta"].includes(value.marker as string) ||
      typeof delayMs !== "number" || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > FIXTURE_MAX_DELAY_MS ||
      typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > FIXTURE_MAX_TIMEOUT_MS) invalid();
  return { commandId: value.commandId as string, operation: "set-marker", marker: value.marker as "alpha" | "beta", delayMs: delayMs as number, timeoutMs: timeoutMs as number };
}

function invalid(): never { throw new ProbeInputError("probe_invalid_input", 400, "Probe command is invalid"); }
function hasBody(request: IncomingMessage): boolean {
  return request.headers["transfer-encoding"] !== undefined || (request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0");
}

/** All state is synthetic. Restart discards command IDs; optional fixture storage retains only values. */
export class FixtureProbe {
  private readonly token: Buffer;
  private readonly writeJson: WriteJson;
  private state: FixtureState = { contractVersion: FIXTURE_CONTRACT_VERSION, fixtureSessionId: `fixture_${randomUUID()}`, persistence: "memory-only", fixtureSchemaVersion: FIXTURE_SCHEMA_VERSION, commandPersistence: "session-only", marker: "empty", revision: 0 };
  private readonly store?: FixtureStore;
  private readonly commands = new Map<string, CommandRecord>();
  private active: CommandRecord | undefined;
  private closed = false;

  constructor(options: FixtureProbeOptions, writeJson: WriteJson) {
    if (typeof options.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(options.token) || Buffer.from(options.token, "base64url").toString("base64url") !== options.token) {
      throw new TypeError("Fixture probe requires a 32-byte base64url capability token");
    }
    this.token = Buffer.from(options.token);
    this.writeJson = writeJson;
    if (options.dataDirectory !== undefined) {
      this.store = new FixtureStore(options.dataDirectory);
      this.state = { ...this.state, ...this.store.read(), persistence: "isolated-fixture" };
    }
  }

  async route(request: IncomingMessage, response: ServerResponse, requestId: string): Promise<void> {
    const fail = (status: number, code: FixtureErrorCode | "method_not_allowed" | "request_body_not_allowed", message: string): void => {
      request.resume();
      if (response.destroyed || response.writableEnded) return;
      // Refused or partial bodies must not retain a keep-alive socket for more input.
      response.setHeader("connection", "close");
      this.writeJson(response, status, { error: { code, message }, requestId }, requestId);
    };
    const credential = request.headers.authorization;
    const supplied = typeof credential === "string" && credential.startsWith("Bearer ") ? Buffer.from(credential.slice(7)) : Buffer.alloc(0);
    if (supplied.length !== this.token.length || !timingSafeEqual(supplied, this.token)) {
      fail(401, "probe_unauthorized", "Probe capability is required"); return;
    }
    if (request.headers.origin !== undefined) { fail(403, "probe_origin_rejected", "Browser-origin requests are not allowed"); return; }
    if (request.headers[FIXTURE_VERSION_HEADER] !== FIXTURE_CONTRACT_VERSION) { fail(409, "probe_incompatible", "Probe contract is incompatible"); return; }
    if (this.closed) { fail(503, "probe_closed", "Probe is closed"); return; }
    // Only an origin-form exact target is accepted: no query, traversal, encoded IDs or absolute target.
    const target = request.url ?? "";
    const isState = target === FIXTURE_STATE_PATH;
    const isCommands = target === FIXTURE_COMMANDS_PATH;
    const commandMatch = /^\/v1\/fixture\/commands\/(cmd_[a-f0-9-]+)(\/cancel)?$/.exec(target);
    if (!isState && !isCommands && !commandMatch) { fail(400, "probe_invalid_input", "Probe target is invalid"); return; }
    const expectedMethod = isCommands || commandMatch?.[2] ? "POST" : "GET";
    if (request.method !== expectedMethod) { response.setHeader("allow", expectedMethod); fail(405, "method_not_allowed", "Method not allowed"); return; }
    if (!isCommands && hasBody(request)) { fail(413, "request_body_not_allowed", "This probe route does not accept a body"); return; }
    if (isState) { this.writeJson(response, 200, { ...this.state }, requestId); return; }
    if (commandMatch) {
      if (!COMMAND_ID.test(commandMatch[1])) { fail(400, "probe_invalid_input", "Command ID is invalid"); return; }
      const record = this.commands.get(commandMatch[1]);
      if (!record) { fail(404, "probe_command_not_found", "Probe command was not found"); return; }
      if (commandMatch[2]) this.finish(record, "cancelled");
      this.writeJson(response, 200, record.result, requestId); return;
    }
    if (request.headers["content-type"] !== "application/json" || request.headers["content-encoding"] !== undefined) { fail(400, "probe_invalid_input", "Probe input must be uncompressed application/json"); return; }
    const declared = request.headers["content-length"];
    if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > FIXTURE_MAX_BODY_BYTES)) { fail(413, "probe_body_too_large", "Probe input exceeds the byte limit"); return; }
    try {
      const input = normalizeInput(await readCommand(request, response));
      // Reading the body can yield. Recheck shutdown and connection before admitting work.
      if (response.destroyed || response.writableEnded) return;
      if (this.closed) { fail(503, "probe_closed", "Probe is closed"); return; }
      const existing = this.commands.get(input.commandId);
      if (existing) {
        if (JSON.stringify(existing.input) !== JSON.stringify(input)) { fail(409, "probe_id_conflict", "Command ID already belongs to a different input"); return; }
        this.writeJson(response, 200, existing.result, requestId); return;
      }
      if (this.active) { fail(409, "probe_busy", "A probe command is already pending"); return; }
      if (this.commands.size >= FIXTURE_COMMAND_CAPACITY) { fail(429, "probe_capacity", "Probe command capacity is exhausted; restart the isolated probe"); return; }
      const record: CommandRecord = { input, result: { contractVersion: FIXTURE_CONTRACT_VERSION, fixtureSessionId: this.state.fixtureSessionId, commandId: input.commandId, operation: input.operation, status: "pending", state: { ...this.state } } };
      this.commands.set(input.commandId, record);
      this.active = record;
      // Timeout takes precedence at equal deadlines. Neither timeout nor cancellation writes state.
      record.timeoutTimer = setTimeout(() => this.finish(record, "timed_out"), input.timeoutMs);
      record.commitTimer = setTimeout(() => this.finish(record, "completed"), input.delayMs);
      this.writeJson(response, 202, record.result, requestId);
    } catch (error) {
      if (error instanceof ProbeInputError) { fail(error.status, error.code, error.message); return; }
      // Internal exception details (including request data) never leave the probe.
      fail(400, "probe_invalid_input", "Probe command could not be accepted");
    }
  }

  private finish(record: CommandRecord, status: Exclude<FixtureCommandStatus, "pending">): void {
    if (record.result.status !== "pending") return;
    clearTimeout(record.commitTimer);
    clearTimeout(record.timeoutTimer);
    if (status === "completed") {
      try {
        const revision = this.state.revision + 1;
        if (!Number.isSafeInteger(revision)) throw new Error("Fixture revision capacity is exhausted");
        this.store?.commit(record.input.marker, revision);
        this.state = { ...this.state, marker: record.input.marker, revision };
      } catch { status = "storage_error"; }
    }
    record.result = { ...record.result, status, state: { ...this.state } };
    if (this.active === record) this.active = undefined;
  }

  close(): void {
    this.closed = true;
    if (this.active) this.finish(this.active, "cancelled");
    this.token.fill(0);
    this.store?.close();
  }
}
