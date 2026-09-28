import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { connect } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  FIXTURE_BODY_TIMEOUT_MS, FIXTURE_COMMAND_CAPACITY, FIXTURE_COMMANDS_PATH,
  FIXTURE_CONTRACT_VERSION, FIXTURE_MAX_BODY_BYTES, FIXTURE_STATE_PATH,
  FIXTURE_VERSION_HEADER, FIXTURE_MAX_STORAGE_FILE_BYTES,
  type FixtureCommandInput, type FixtureCommandResult, type FixtureState,
} from "../contracts/fixture-v1.js";
import { startCore, type RunningCore } from "../src/server.ts";
import { FIXTURE_DATABASE_FILENAME } from "../src/fixture-store.ts";

type Probe = { core: RunningCore; headers: Record<string, string> };
const input = (overrides: Partial<FixtureCommandInput> = {}): FixtureCommandInput => ({ commandId: `cmd_${randomUUID()}`, operation: "set-marker", marker: "alpha", ...overrides });
async function withProbe(run: (probe: Probe) => Promise<void>): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const core = await startCore({ port: 0, databasePath: ":memory:", fixtureProbe: { token } });
  try { await run({ core, headers: { authorization: `Bearer ${token}`, [FIXTURE_VERSION_HEADER]: FIXTURE_CONTRACT_VERSION } }); }
  finally { await core.close(); }
}
const call = (p: Probe, path: string, init: RequestInit = {}): Promise<Response> => fetch(`${p.core.origin}${path}`, { ...init, headers: { ...p.headers, ...init.headers } });
const submit = (p: Probe, value: unknown): Promise<Response> => call(p, FIXTURE_COMMANDS_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
const state = async (p: Probe): Promise<FixtureState> => (await call(p, FIXTURE_STATE_PATH)).json() as Promise<FixtureState>;
async function terminal(p: Probe, commandId: string): Promise<FixtureCommandResult> {
  for (let attempt = 0; attempt < 150; attempt++) {
    const response = await call(p, `${FIXTURE_COMMANDS_PATH}/${commandId}`);
    assert.equal(response.status, 200);
    const value = await response.json() as FixtureCommandResult;
    if (value.status !== "pending") return value;
    await sleep(5);
  }
  throw new Error("Command did not reach a bounded terminal state");
}
async function error(response: Response, status: number, code: string): Promise<void> {
  assert.equal(response.status, status);
  const payload = await response.json() as { error: { code: string }; requestId: string };
  assert.equal(payload.error.code, code);
  assert.match(payload.requestId, /^req_[0-9a-f-]{36}$/);
  assert.equal(response.headers.get("cache-control"), "no-store");
}

test("probe is disabled by default and rejects real data paths before touching them", async () => {
  const core = await startCore({ port: 0, databasePath: ":memory:" });
  try { assert.equal((await fetch(`${core.origin}${FIXTURE_STATE_PATH}`)).status, 404); }
  finally { await core.close(); }
  const directory = mkdtempSync(join(tmpdir(), "netnavr-probe-protected-"));
  const databasePath = join(directory, "untouched.sqlite");
  const original = Buffer.from("synthetic corrupt/future database sentinel");
  writeFileSync(databasePath, original);
  try {
    await assert.rejects(startCore({ port: 0, databasePath, fixtureProbe: { token: randomBytes(32).toString("base64url") } }), /explicit isolated in-memory database/);
    assert.deepEqual(readFileSync(databasePath), original);
    await assert.rejects(startCore({ port: 0, fixtureProbe: { token: randomBytes(32).toString("base64url") } }), /explicit isolated in-memory database/);
  } finally { rmSync(directory, { recursive: true }); }
});

test("invalid probe capability is rejected without echoing it", async () => {
  const supplied = "invalid-capability";
  await assert.rejects(startCore({ port: 0, databasePath: ":memory:", fixtureProbe: { token: supplied } }), (value: unknown) => value instanceof Error && /capability token/.test(value.message) && !value.message.includes(supplied));
});

test("authentication precedes compatibility and rejects missing, wrong and malformed credentials", async () => {
  await withProbe(async (p) => {
    for (const authorization of [undefined, "Bearer wrong", "Basic wrong", `Bearer ${randomBytes(32).toString("base64url")}`]) {
      const response = await fetch(`${p.core.origin}${FIXTURE_STATE_PATH}`, { headers: authorization ? { authorization, [FIXTURE_VERSION_HEADER]: "future" } : { [FIXTURE_VERSION_HEADER]: "future" } });
      await error(response, 401, "probe_unauthorized");
    }
    await error(await call(p, FIXTURE_STATE_PATH, { headers: { [FIXTURE_VERSION_HEADER]: "future" } }), 409, "probe_incompatible");
    const response = await fetch(`${p.core.origin}${FIXTURE_STATE_PATH}`, { headers: { authorization: p.headers.authorization } });
    await error(response, 409, "probe_incompatible");
    assert.equal((await state(p)).revision, 0);
  });
});

test("all browser origins are rejected even with valid capability", async () => {
  await withProbe(async (p) => {
    for (const origin of ["https://example.invalid", p.core.origin, "null"]) {
      await error(await call(p, FIXTURE_COMMANDS_PATH, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(input()) }), 403, "probe_origin_rejected");
    }
    assert.equal((await state(p)).revision, 0);
  });
});

test("fixture roundtrip is correlated, bounded and separate from product identity", async () => {
  await withProbe(async (p) => {
    const initial = await state(p);
    assert.deepEqual({ marker: initial.marker, revision: initial.revision, persistence: initial.persistence }, { marker: "empty", revision: 0, persistence: "memory-only" });
    assert.match(initial.fixtureSessionId, /^fixture_[0-9a-f-]{36}$/);
    const command = input();
    const response = await submit(p, command);
    assert.equal(response.status, 202);
    const pending = await response.json() as FixtureCommandResult;
    assert.equal(pending.status, "pending");
    assert.equal(pending.commandId, command.commandId);
    assert.equal(pending.fixtureSessionId, initial.fixtureSessionId);
    const completed = await terminal(p, command.commandId);
    assert.equal(completed.status, "completed");
    assert.deepEqual(completed.state, { ...initial, marker: "alpha", revision: 1 });
    assert.deepEqual(await state(p), completed.state);
    assert.ok(Buffer.byteLength(JSON.stringify(completed)) < 1024);
    assert.equal((await fetch(`${p.core.origin}/v1/node`)).status, 200);
  });
});

test("duplicate command is idempotent, input conflict fails and committed cancel does not undo", async () => {
  await withProbe(async (p) => {
    const command = input();
    assert.equal((await submit(p, command)).status, 202);
    const result = await terminal(p, command.commandId);
    const duplicate = await submit(p, { ...command, delayMs: 0, timeoutMs: 1000 });
    assert.equal(duplicate.status, 200);
    assert.deepEqual(await duplicate.json(), result);
    await error(await submit(p, { ...command, marker: "beta" }), 409, "probe_id_conflict");
    const cancelled = await call(p, `${FIXTURE_COMMANDS_PATH}/${command.commandId}/cancel`, { method: "POST" });
    assert.equal(cancelled.status, 200);
    assert.deepEqual(await cancelled.json(), result);
    assert.equal((await state(p)).revision, 1);
  });
});

test("pending cancellation is idempotent, keeps state and frees admission", async () => {
  await withProbe(async (p) => {
    const first = input({ delayMs: 500 });
    assert.equal((await submit(p, first)).status, 202);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await call(p, `${FIXTURE_COMMANDS_PATH}/${first.commandId}/cancel`, { method: "POST" });
      assert.equal(response.status, 200);
      assert.equal((await response.json() as FixtureCommandResult).status, "cancelled");
    }
    const next = input({ marker: "beta" });
    assert.equal((await submit(p, next)).status, 202);
    assert.equal((await terminal(p, next.commandId)).state.marker, "beta");
    await sleep(510);
    assert.equal((await state(p)).revision, 1);
    assert.equal((await terminal(p, first.commandId)).status, "cancelled");
  });
});

test("timeout and equal deadlines fail before mutation and allow a later command", async () => {
  await withProbe(async (p) => {
    for (const [delayMs, timeoutMs] of [[100, 5], [50, 50]]) {
      const command = input({ delayMs, timeoutMs });
      assert.equal((await submit(p, command)).status, 202);
      assert.equal((await terminal(p, command.commandId)).status, "timed_out");
      assert.equal((await state(p)).revision, 0);
    }
    const next = input();
    assert.equal((await submit(p, next)).status, 202);
    assert.equal((await terminal(p, next.commandId)).status, "completed");
  });
});

test("concurrent submissions admit exactly one active command", async () => {
  await withProbe(async (p) => {
    const commands = Array.from({ length: 8 }, () => input({ delayMs: 500 }));
    const responses = await Promise.all(commands.map((command) => submit(p, command)));
    assert.equal(responses.filter((response) => response.status === 202).length, 1);
    assert.equal(responses.filter((response) => response.status === 409).length, 7);
    const admitted = await responses.find((response) => response.status === 202)!.json() as FixtureCommandResult;
    for (const response of responses.filter((response) => response.status === 409)) await error(response, 409, "probe_busy");
    await call(p, `${FIXTURE_COMMANDS_PATH}/${admitted.commandId}/cancel`, { method: "POST" });
    assert.equal((await state(p)).revision, 0);
  });
});

test("fixed input rejects arbitrary paths, operations, fields and out-of-range values", async () => {
  await withProbe(async (p) => {
    for (const value of [null, [], {}, input({ marker: "empty" as never }), input({ commandId: "cmd_not-a-uuid" }),
      { ...input(), operation: "exec", command: "synthetic command" }, { ...input(), path: "/synthetic/path" },
      { ...input(), sql: "synthetic SQL" }, { ...input(), delayMs: null }, input({ delayMs: -1 }), input({ delayMs: 501 }),
      input({ delayMs: 0.5 }), input({ timeoutMs: 0 }), input({ timeoutMs: 1001 }), { ...input(), marker: "alpha".repeat(100) }]) {
      await error(await submit(p, value), 400, "probe_invalid_input");
    }
    assert.equal((await state(p)).revision, 0);
  });
});

test("invalid methods, targets, missing IDs and body on a read/cancel fail closed", async () => {
  await withProbe(async (p) => {
    await error(await call(p, FIXTURE_STATE_PATH, { method: "POST" }), 405, "method_not_allowed");
    await error(await call(p, FIXTURE_COMMANDS_PATH), 405, "method_not_allowed");
    for (const target of [`${FIXTURE_STATE_PATH}?version=future`, `${FIXTURE_COMMANDS_PATH}/cmd_bad`, `${FIXTURE_COMMANDS_PATH}/cmd_%61`]) await error(await call(p, target), 400, "probe_invalid_input");
    const unknown = input().commandId;
    await error(await call(p, `${FIXTURE_COMMANDS_PATH}/${unknown}`), 404, "probe_command_not_found");
    const command = input({ delayMs: 500 });
    await submit(p, command);
    await error(await call(p, `${FIXTURE_COMMANDS_PATH}/${command.commandId}/cancel`, { method: "POST", body: "unexpected" }), 413, "request_body_not_allowed");
    const pending = await call(p, `${FIXTURE_COMMANDS_PATH}/${command.commandId}`);
    assert.equal((await pending.json() as FixtureCommandResult).status, "pending");
    await call(p, `${FIXTURE_COMMANDS_PATH}/${command.commandId}/cancel`, { method: "POST" });
  });
});

test("JSON encoding and body byte bounds reject before admission", async () => {
  await withProbe(async (p) => {
    await error(await call(p, FIXTURE_COMMANDS_PATH, { method: "POST", body: JSON.stringify(input()) }), 400, "probe_invalid_input");
    await error(await call(p, FIXTURE_COMMANDS_PATH, { method: "POST", headers: { "content-type": "application/json", "content-encoding": "gzip" }, body: "synthetic" }), 400, "probe_invalid_input");
    await error(await call(p, FIXTURE_COMMANDS_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: "{" }), 400, "probe_invalid_input");
    await error(await call(p, FIXTURE_COMMANDS_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: "a".repeat(FIXTURE_MAX_BODY_BYTES + 1) }), 413, "probe_body_too_large");
    const raw = await rawRequest(p, `Transfer-Encoding: chunked\r\n`, `${(FIXTURE_MAX_BODY_BYTES + 1).toString(16)}\r\n${"a".repeat(FIXTURE_MAX_BODY_BYTES + 1)}\r\n0\r\n\r\n`);
    assert.match(raw, /HTTP\/1\.1 413 /);
    assert.match(raw, /probe_body_too_large/);
    assert.equal((await state(p)).revision, 0);
  });
});

test("slow and interrupted bodies have no side effects", async () => {
  await withProbe(async (p) => {
    const raw = await rawRequest(p, "Content-Length: 500\r\n", "{", FIXTURE_BODY_TIMEOUT_MS + 500);
    assert.match(raw, /HTTP\/1\.1 408 /);
    assert.match(raw, /probe_body_timeout/);
    await rawRequest(p, "Content-Length: 500\r\n", "{", 20, true);
    await sleep(30);
    assert.equal((await state(p)).revision, 0);
    const command = input();
    assert.equal((await submit(p, command)).status, 202);
    assert.equal((await terminal(p, command.commandId)).status, "completed");
  });
});

test("session capacity does not evict command IDs or replay old work", async () => {
  await withProbe(async (p) => {
    let first: FixtureCommandInput | undefined;
    for (let index = 0; index < FIXTURE_COMMAND_CAPACITY; index++) {
      const command = input({ delayMs: 500 });
      first ??= command;
      assert.equal((await submit(p, command)).status, 202);
      assert.equal((await call(p, `${FIXTURE_COMMANDS_PATH}/${command.commandId}/cancel`, { method: "POST" })).status, 200);
    }
    await error(await submit(p, input()), 429, "probe_capacity");
    const replay = await submit(p, first);
    assert.equal(replay.status, 200);
    assert.equal((await replay.json() as FixtureCommandResult).status, "cancelled");
    assert.equal((await state(p)).revision, 0);
  });
});

test("shutdown cancels pending work and restart has a fresh empty session", async () => {
  let oldSession = "";
  await withProbe(async (p) => {
    oldSession = (await state(p)).fixtureSessionId;
    const command = input({ delayMs: 500 });
    assert.equal((await submit(p, command)).status, 202);
    await p.core.close();
    await assert.rejects(call(p, FIXTURE_STATE_PATH));
  });
  await withProbe(async (p) => {
    const fresh = await state(p);
    assert.notEqual(fresh.fixtureSessionId, oldSession);
    assert.equal(fresh.marker, "empty");
    assert.equal(fresh.revision, 0);
  });
});

test("isolated fixture values survive restart while command IDs and session reset", async () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "netnavr-fixture-persist-")));
  const dataDirectory = join(parent, "fixture-v1");
  const token = randomBytes(32).toString("base64url");
  const headers = { authorization: `Bearer ${token}`, [FIXTURE_VERSION_HEADER]: FIXTURE_CONTRACT_VERSION };
  const command = input({ marker: "beta" });
  let oldSession = "";
  try {
    const first = await startCore({ port: 0, databasePath: ":memory:", fixtureProbe: { token, dataDirectory } });
    try {
      const p = { core: first, headers };
      oldSession = (await state(p)).fixtureSessionId;
      assert.equal((await submit(p, command)).status, 202);
      const result = await terminal(p, command.commandId);
      assert.equal(result.state.persistence, "isolated-fixture");
      assert.equal(result.state.fixtureSchemaVersion, 1);
      assert.equal(result.state.commandPersistence, "session-only");
    } finally { await first.close(); }
    const persistedBytes = readFileSync(join(dataDirectory, FIXTURE_DATABASE_FILENAME));
    const second = await startCore({ port: 0, databasePath: ":memory:", fixtureProbe: { token, dataDirectory } });
    try {
      const p = { core: second, headers };
      const restored = await state(p);
      assert.notEqual(restored.fixtureSessionId, oldSession);
      assert.equal(restored.marker, "beta");
      assert.equal(restored.revision, 1);
      await error(await call(p, `${FIXTURE_COMMANDS_PATH}/${command.commandId}`), 404, "probe_command_not_found");
      assert.deepEqual(readFileSync(join(dataDirectory, FIXTURE_DATABASE_FILENAME)), persistedBytes);
    } finally { await second.close(); }
  } finally { rmSync(parent, { recursive: true }); }
});

test("dedicated fixture storage rejects foreign files, invalid paths and links", async () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "netnavr-fixture-paths-")));
  const dataDirectory = join(parent, "fixture-v1");
  const token = randomBytes(32).toString("base64url");
  const start = (directory: string) => startCore({ port: 0, databasePath: ":memory:", fixtureProbe: { token, dataDirectory: directory } });
  try {
    await assert.rejects(start("relative/fixture-v1"), /absolute dedicated/);
    await assert.rejects(start(join(parent, "product-data")), /absolute dedicated/);
    mkdirSync(dataDirectory);
    const sentinel = join(dataDirectory, "core.sqlite");
    writeFileSync(sentinel, "synthetic product data must be preserved");
    await assert.rejects(start(dataDirectory), /non-fixture material/);
    assert.equal(readFileSync(sentinel, "utf8"), "synthetic product data must be preserved");
    const target = join(parent, "target");
    mkdirSync(target);
    const linkedParent = join(parent, "linked");
    symlinkSync(target, linkedParent, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(start(join(linkedParent, "fixture-v1")), /symbolic links/);
  } finally { rmSync(parent, { recursive: true }); }
});

test("damaged, future and product-schema fixtures fail closed without rewriting original bytes", async () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "netnavr-fixture-invalid-")));
  const dataDirectory = join(parent, "fixture-v1");
  mkdirSync(dataDirectory);
  const path = join(dataDirectory, FIXTURE_DATABASE_FILENAME);
  const token = randomBytes(32).toString("base64url");
  const start = () => startCore({ port: 0, databasePath: ":memory:", fixtureProbe: { token, dataDirectory } });
  try {
    for (const scenario of ["corrupt", "empty", "future", "product"]) {
      if (scenario === "corrupt") writeFileSync(path, "synthetic corrupt fixture");
      else if (scenario === "empty") writeFileSync(path, "");
      else {
        rmSync(path, { force: true });
        const database = new DatabaseSync(path);
        database.exec(scenario === "future" ? "PRAGMA user_version=2" : "PRAGMA user_version=1; CREATE TABLE node_identity (node_id TEXT); INSERT INTO node_identity VALUES ('synthetic product identity');");
        database.close();
      }
      const original = readFileSync(path);
      await assert.rejects(start());
      assert.deepEqual(readFileSync(path), original, scenario);
    }
  } finally { rmSync(parent, { recursive: true }); }
});

test("fixture storage has single-instance ownership and pending close preserves committed values", async () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "netnavr-fixture-lock-")));
  const dataDirectory = join(parent, "fixture-v1");
  const token = randomBytes(32).toString("base64url");
  const start = () => startCore({ port: 0, databasePath: ":memory:", fixtureProbe: { token, dataDirectory } });
  try {
    const first = await start();
    const p = { core: first, headers: { authorization: `Bearer ${token}`, [FIXTURE_VERSION_HEADER]: FIXTURE_CONTRACT_VERSION } };
    try {
      await assert.rejects(start(), /already owns data directory/);
      const committed = input();
      await submit(p, committed);
      await terminal(p, committed.commandId);
      const pending = input({ marker: "beta", delayMs: 500 });
      assert.equal((await submit(p, pending)).status, 202);
    } finally { await first.close(); }
    const second = await start();
    try {
      const value = await state({ ...p, core: second });
      assert.equal(value.marker, "alpha");
      assert.equal(value.revision, 1);
    } finally { await second.close(); }
  } finally { rmSync(parent, { recursive: true }); }
});

test("unexpected columns, triggers, views and excessive storage fail without changing the original", async () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "netnavr-fixture-structure-")));
  const token = randomBytes(32).toString("base64url");
  try {
    for (const scenario of ["column", "trigger", "view", "large_database", "large_sidecar"]) {
      const dataDirectory = join(parent, scenario, "fixture-v1");
      const path = join(dataDirectory, FIXTURE_DATABASE_FILENAME);
      const start = () => startCore({ port: 0, databasePath: ":memory:", fixtureProbe: { token, dataDirectory } });
      const created = await start();
      await created.close();
      if (["column", "trigger", "view"].includes(scenario)) {
        const database = new DatabaseSync(path);
        database.exec(scenario === "column" ? "ALTER TABLE engineering_fixture_marker ADD COLUMN unexpected TEXT" : scenario === "trigger" ? "CREATE TRIGGER unexpected AFTER UPDATE ON engineering_fixture_marker BEGIN UPDATE engineering_fixture_metadata SET format='unexpected'; END" : "CREATE VIEW unexpected AS SELECT marker FROM engineering_fixture_marker");
        database.close();
      } else if (scenario === "large_database") writeFileSync(path, Buffer.alloc(FIXTURE_MAX_STORAGE_FILE_BYTES + 1));
      else writeFileSync(`${path}-wal`, Buffer.alloc(FIXTURE_MAX_STORAGE_FILE_BYTES + 1));
      const original = readFileSync(path);
      const originalSidecar = scenario === "large_sidecar" ? readFileSync(`${path}-wal`) : undefined;
      await assert.rejects(start());
      assert.deepEqual(readFileSync(path), original, scenario);
      if (originalSidecar) assert.deepEqual(readFileSync(`${path}-wal`), originalSidecar);
    }
  } finally { rmSync(parent, { recursive: true }); }
});

test("persist failure has a safe terminal result, preserves prior values and releases admission", async () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "netnavr-fixture-failure-")));
  const dataDirectory = join(parent, "fixture-v1");
  const token = randomBytes(32).toString("base64url");
  const core = await startCore({ port: 0, databasePath: ":memory:", fixtureProbe: { token, dataDirectory } });
  const p = { core, headers: { authorization: `Bearer ${token}`, [FIXTURE_VERSION_HEADER]: FIXTURE_CONTRACT_VERSION } };
  const blocker = new DatabaseSync(join(dataDirectory, FIXTURE_DATABASE_FILENAME));
  try {
    blocker.exec("BEGIN EXCLUSIVE");
    const command = input();
    assert.equal((await submit(p, command)).status, 202);
    const failed = await terminal(p, command.commandId);
    assert.equal(failed.status, "storage_error");
    assert.equal(failed.state.marker, "empty");
    assert.equal(failed.state.revision, 0);
    assert.ok(!JSON.stringify(failed).includes(dataDirectory));
    blocker.exec("ROLLBACK");
    const next = input({ marker: "beta" });
    assert.equal((await submit(p, next)).status, 202);
    assert.equal((await terminal(p, next.commandId)).status, "completed");
  } finally { blocker.close(); await core.close(); rmSync(parent, { recursive: true }); }
});

test("owned process abnormal termination preserves committed fixture and releases its lock", async () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "netnavr-fixture-crash-")));
  const dataDirectory = join(parent, "fixture-v1");
  const token = randomBytes(32).toString("base64url");
  // Capability travels over a private parent IPC channel, never arguments, stdout or files.
  const source = `import { startCore } from './src/server.ts'; process.once('message', async (options) => { try { const core = await startCore(options); process.send({ origin:core.origin,port:core.port }); } catch { process.send({ failed:true }); process.exit(1); } });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { cwd: new URL("../", import.meta.url), stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const startup = once(child, "message");
  child.send({ port: 0, databasePath: ":memory:", fixtureProbe: { token, dataDirectory } });
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const [identity] = await Promise.race([startup, once(child, "exit").then(() => { throw new Error("Fixture worker exited before readiness"); })]) as [{ origin: string; port: number; failed?: boolean }];
    assert.equal(identity.failed, undefined);
    const p = { core: { ...identity, host: "127.0.0.1" } as RunningCore, headers: { authorization: `Bearer ${token}`, [FIXTURE_VERSION_HEADER]: FIXTURE_CONTRACT_VERSION } };
    const committed = input();
    assert.equal((await submit(p, committed)).status, 202);
    await terminal(p, committed.commandId);
    const committedBytes = readFileSync(join(dataDirectory, FIXTURE_DATABASE_FILENAME));
    assert.equal((await submit(p, input({ marker: "beta", delayMs: 500 }))).status, 202);
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    assert.deepEqual(readFileSync(join(dataDirectory, FIXTURE_DATABASE_FILENAME)), committedBytes);
    const restored = await startCore({ port: 0, databasePath: ":memory:", fixtureProbe: { token, dataDirectory } });
    try {
      const value = await state({ ...p, core: restored });
      assert.equal(value.marker, "alpha");
      assert.equal(value.revision, 1);
    } finally { await restored.close(); }
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
    rmSync(parent, { recursive: true });
  }
});

async function rawRequest(p: Probe, extraHeaders: string, body: string, duration = 1500, interrupt = false): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const socket = connect({ host: p.core.host, port: p.core.port }, () => {
      socket.write(`POST ${FIXTURE_COMMANDS_PATH} HTTP/1.1\r\nHost: ${p.core.host}:${p.core.port}\r\nAuthorization: ${p.headers.authorization}\r\n${FIXTURE_VERSION_HEADER}: ${FIXTURE_CONTRACT_VERSION}\r\nContent-Type: application/json\r\nConnection: close\r\n${extraHeaders}\r\n${body}`);
    });
    const timer = setTimeout(() => { socket.destroy(); interrupt ? resolve(output) : reject(new Error("Raw request exceeded its bounded deadline")); }, duration);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => { output += chunk; });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    socket.once("close", () => { clearTimeout(timer); resolve(output); });
  });
}
