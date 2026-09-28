import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CORE_API_VERSION,
  CORE_MAX_HEADER_BYTES,
  CORE_SCHEMA_VERSION,
  CORE_HOST,
  CORE_SERVICE,
  CORE_VERSION,
  startCore,
  type RunningCore,
} from "../src/server.ts";

const CORE_REQUEST_ID_PATTERN = /^req_[0-9a-f-]{36}$/;

async function withCore(run: (core: RunningCore) => Promise<void>): Promise<void> {
  const core = await startCore({ port: 0, databasePath: ":memory:" });
  try {
    await run(core);
  } finally {
    await core.close();
  }
}

test("GET /v1/health returns the stable health contract", async () => {
  await withCore(async (core) => {
    const response = await fetch(`${core.origin}/v1/health`);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.match(response.headers.get("x-request-id") ?? "", CORE_REQUEST_ID_PATTERN);

    const payload = (await response.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(payload), [
      "service",
      "status",
      "apiVersion",
      "version",
      "uptimeSeconds",
    ]);
    assert.equal(payload.service, CORE_SERVICE);
    assert.equal(payload.status, "ok");
    assert.equal(payload.apiVersion, CORE_API_VERSION);
    assert.equal(payload.version, CORE_VERSION);
    assert.equal(typeof payload.uptimeSeconds, "number");
    assert.ok(Number.isInteger(payload.uptimeSeconds));
    assert.ok((payload.uptimeSeconds as number) >= 0);
  });
});

test("GET /v1/node returns the persistent Node identity contract", async () => {
  await withCore(async (core) => {
    const response = await fetch(`${core.origin}/v1/node`);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");

    const payload = (await response.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(payload), ["nodeId", "createdAt", "schemaVersion"]);
    assert.match(payload.nodeId as string, /^node_[0-9a-f-]{36}$/);
    assert.equal(new Date(payload.createdAt as string).toISOString(), payload.createdAt);
    assert.equal(payload.schemaVersion, CORE_SCHEMA_VERSION);
    assert.deepEqual(payload, core.node);
  });
});

test("Node identity and migration state survive a Core restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "netnavr-core-persistence-"));
  const databasePath = join(directory, "core.sqlite");

  try {
    const first = await startCore({ port: 0, databasePath });
    const firstIdentity = first.node;
    await first.close();

    const second = await startCore({ port: 0, databasePath });
    try {
      assert.deepEqual(second.node, firstIdentity);
    } finally {
      await second.close();
    }

    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const userVersion = database.prepare("PRAGMA user_version").get() as {
        user_version: number;
      };
      const migrations = database
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all() as Array<{ version: number }>;

      assert.equal(userVersion.user_version, CORE_SCHEMA_VERSION);
      assert.deepEqual(
        migrations.map((migration) => migration.version),
        [CORE_SCHEMA_VERSION],
      );
    } finally {
      database.close();
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("Core rejects a newer storage schema without downgrading it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "netnavr-core-future-schema-"));
  const databasePath = join(directory, "core.sqlite");
  const futureVersion = CORE_SCHEMA_VERSION + 1;

  try {
    const database = new DatabaseSync(databasePath);
    database.exec(`PRAGMA user_version = ${futureVersion}`);
    database.close();

    await assert.rejects(
      startCore({ port: 0, databasePath }),
      new RegExp(`schema version ${futureVersion} is newer than supported`),
    );

    const reopened = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const userVersion = reopened.prepare("PRAGMA user_version").get() as {
        user_version: number;
      };
      assert.equal(userVersion.user_version, futureVersion);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("Core rejects migration history that disagrees with the schema version", async () => {
  const directory = mkdtempSync(join(tmpdir(), "netnavr-core-migration-history-"));
  const databasePath = join(directory, "core.sqlite");

  try {
    const core = await startCore({ port: 0, databasePath });
    await core.close();

    const database = new DatabaseSync(databasePath);
    database.exec("DELETE FROM schema_migrations");
    database.close();

    await assert.rejects(
      startCore({ port: 0, databasePath }),
      /migration history does not match its schema version/,
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("Core does not repair a nonzero schema that has no migration history", async () => {
  const directory = mkdtempSync(join(tmpdir(), "netnavr-core-missing-history-"));
  const databasePath = join(directory, "core.sqlite");

  try {
    const database = new DatabaseSync(databasePath);
    database.exec(`PRAGMA user_version = ${CORE_SCHEMA_VERSION}`);
    database.close();

    await assert.rejects(
      startCore({ port: 0, databasePath }),
      /migration history does not match its schema version/,
    );

    const reopened = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const migrationTable = reopened
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'",
        )
        .get();
      assert.equal(migrationTable, undefined);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("Core rejects an invalid stored Node identity without replacing it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "netnavr-core-invalid-identity-"));
  const databasePath = join(directory, "core.sqlite");
  const invalidNodeId = "not-a-node-id";

  try {
    const core = await startCore({ port: 0, databasePath });
    await core.close();

    const database = new DatabaseSync(databasePath);
    database.prepare("UPDATE node_identity SET node_id = ? WHERE singleton = 1").run(invalidNodeId);
    database.close();

    await assert.rejects(startCore({ port: 0, databasePath }), /invalid Node identity/);

    const reopened = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = reopened.prepare("SELECT node_id FROM node_identity").get() as {
        node_id: string;
      };
      assert.equal(row.node_id, invalidNodeId);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("Core rejects a missing stored Node identity without generating a replacement", async () => {
  const directory = mkdtempSync(join(tmpdir(), "netnavr-core-missing-identity-"));
  const databasePath = join(directory, "core.sqlite");

  try {
    const core = await startCore({ port: 0, databasePath });
    await core.close();

    const database = new DatabaseSync(databasePath);
    database.exec("DELETE FROM node_identity");
    database.close();

    await assert.rejects(
      startCore({ port: 0, databasePath }),
      /must contain exactly one Node identity/,
    );

    const reopened = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = reopened.prepare("SELECT COUNT(*) AS count FROM node_identity").get() as {
        count: number;
      };
      assert.equal(row.count, 0);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("Core rejects a corrupt database without replacing it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "netnavr-core-corrupt-"));
  const databasePath = join(directory, "core.sqlite");
  const corruptContents = "this is not a sqlite database";

  try {
    writeFileSync(databasePath, corruptContents);

    await assert.rejects(startCore({ port: 0, databasePath }));
    assert.equal(readFileSync(databasePath, "utf8"), corruptContents);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("unknown routes return a structured 404", async () => {
  await withCore(async (core) => {
    const response = await fetch(`${core.origin}/not-a-route`);
    const requestId = response.headers.get("x-request-id");

    assert.equal(response.status, 404);
    assert.match(requestId ?? "", CORE_REQUEST_ID_PATTERN);
    assert.deepEqual(await response.json(), {
      error: {
        code: "not_found",
        message: "Route not found",
      },
      requestId,
    });
  });
});

test("invalid request targets return 400 and close the connection", async () => {
  await withCore(async (core) => {
    for (const target of [
      "http://[/v1/health",
      "http://localhost:99999/v1/health",
      "//[/v1/health",
    ]) {
      const response = await sendRawHttpRequest(
        core.port,
        [
          `GET ${target} HTTP/1.1`,
          `Host: ${CORE_HOST}:${core.port}`,
          "Connection: keep-alive",
          "",
          "",
        ].join("\r\n"),
      );

      assert.match(response, /^HTTP\/1\.1 400 /, target);
      assert.match(response, /connection: close/i, target);
      assert.match(response, /"code":"invalid_request_target"/, target);
      assert.match(response, /"message":"Request target is invalid"/, target);
    }

    for (const target of [
      "/v1/health?probe=1",
      `${core.origin}/v1/health?probe=1`,
    ]) {
      const response = await sendRawHttpRequest(
        core.port,
        [
          `GET ${target} HTTP/1.1`,
          `Host: ${CORE_HOST}:${core.port}`,
          "Connection: close",
          "",
          "",
        ].join("\r\n"),
      );

      assert.match(response, /^HTTP\/1\.1 200 /, target);
    }
  });
});

test("known read-only routes reject unsupported methods", async () => {
  await withCore(async (core) => {
    const response = await fetch(`${core.origin}/v1/health`, { method: "POST" });
    const requestId = response.headers.get("x-request-id");

    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET");
    assert.match(requestId ?? "", CORE_REQUEST_ID_PATTERN);
    assert.deepEqual(await response.json(), {
      error: {
        code: "method_not_allowed",
        message: "Method not allowed",
      },
      requestId,
    });
  });
});

test("the read-only API rejects request bodies and closes the connection", async () => {
  await withCore(async (core) => {
    const response = await fetch(`${core.origin}/v1/health`, {
      method: "POST",
      body: "unexpected",
    });
    const requestId = response.headers.get("x-request-id");

    assert.equal(response.status, 413);
    assert.equal(response.headers.get("connection"), "close");
    assert.match(requestId ?? "", CORE_REQUEST_ID_PATTERN);
    assert.deepEqual(await response.json(), {
      error: {
        code: "request_body_not_allowed",
        message: "Core read-only API does not accept request bodies",
      },
      requestId,
    });
  });
});

test("the HTTP parser rejects headers above the Core limit", async () => {
  await withCore(async (core) => {
    const response = await sendRawHttpRequest(
      core.port,
      [
        "GET /v1/health HTTP/1.1",
        `Host: ${CORE_HOST}:${core.port}`,
        `X-Oversized: ${"a".repeat(CORE_MAX_HEADER_BYTES)}`,
        "Connection: close",
        "",
        "",
      ].join("\r\n"),
    );

    assert.match(response, /^HTTP\/1\.1 431 /);
  });
});

test("the server binds only to loopback and close is idempotent", async () => {
  const core = await startCore({ port: 0, databasePath: ":memory:" });

  assert.equal(core.host, CORE_HOST);
  assert.match(core.origin, /^http:\/\/127\.0\.0\.1:\d+$/);

  await Promise.all([core.close(), core.close()]);
  await core.close();

  await assert.rejects(fetch(`${core.origin}/v1/health`));
});

async function sendRawHttpRequest(port: number, request: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = connect({ host: CORE_HOST, port }, () => {
      socket.end(request);
    });
    let response = "";

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      response += chunk;
    });
    socket.once("error", reject);
    socket.once("end", () => resolve(response));
  });
}

const signalTestOptions = {
  skip:
    process.platform === "win32"
      ? "Windows child.kill terminates the process instead of delivering POSIX signals"
      : false,
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`the command exits cleanly after ${signal}`, signalTestOptions, async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "netnavr-core-command-"));
    const entrypoint = fileURLToPath(new URL("../src/main.ts", import.meta.url));
    const child = spawn(process.execPath, [entrypoint], {
      env: {
        ...process.env,
        NETNAVR_CORE_PORT: "0",
        NETNAVR_CORE_DATA_DIR: dataDirectory,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try {
      while (!stdout.includes('"event":"started"')) {
        await Promise.race([
          once(child.stdout, "data"),
          once(child, "exit").then(() => {
            throw new Error(`core exited before startup: ${stderr}`);
          }),
        ]);
      }

      assert.equal(child.kill(signal), true);
      const [exitCode, exitSignal] = (await once(child, "exit")) as [
        number | null,
        NodeJS.Signals | null,
      ];

      assert.equal(exitCode, 0, stderr);
      assert.equal(exitSignal, null);
      assert.match(stdout, new RegExp(`"event":"stopped".*"signal":"${signal}"`));
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
      rmSync(dataDirectory, { force: true, recursive: true });
    }
  });
}
