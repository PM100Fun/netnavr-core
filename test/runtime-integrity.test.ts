import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CORE_PRIVATE_DIRECTORY_MODE,
  CORE_PRIVATE_FILE_MODE,
  CORE_RUNTIME_ALREADY_RUNNING,
  CORE_RUNTIME_LOCK_FILENAME,
  CORE_RUNTIME_LOCK_INVALID,
  CoreRuntimeLockError,
  startCore,
} from "../src/server.ts";

const ENTRYPOINT = fileURLToPath(new URL("../src/main.ts", import.meta.url));

test("one normalized data directory has one runtime owner", async () => {
  const directory = mkdtempSync(join(tmpdir(), "netnavr-core-runtime-owner-"));
  const databasePath = join(directory, "nested", "..", "core.sqlite");
  const alternateDatabasePath = join(directory, "alternate.sqlite");

  try {
    const first = await startCore({ port: 0, databasePath });
    const firstIdentity = first.node;

    try {
      await assert.rejects(
        startCore({ port: 0, databasePath: alternateDatabasePath }),
        (error: unknown) => {
          assert.ok(error instanceof CoreRuntimeLockError);
          assert.equal(error.code, CORE_RUNTIME_ALREADY_RUNNING);
          return true;
        },
      );

      const health = await fetch(`${first.origin}/v1/health`);
      assert.equal(health.status, 200);
      assert.equal(existsSync(alternateDatabasePath), false);
    } finally {
      await first.close();
    }

    const restarted = await startCore({ port: 0, databasePath });
    try {
      assert.deepEqual(restarted.node, firstIdentity);
    } finally {
      await restarted.close();
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a failed port bind releases ownership of its data directory", async () => {
  const firstDirectory = mkdtempSync(join(tmpdir(), "netnavr-core-port-owner-"));
  const secondDirectory = mkdtempSync(join(tmpdir(), "netnavr-core-port-contender-"));
  const firstDatabasePath = join(firstDirectory, "core.sqlite");
  const secondDatabasePath = join(secondDirectory, "core.sqlite");

  try {
    const first = await startCore({ port: 0, databasePath: firstDatabasePath });
    try {
      await assert.rejects(
        startCore({ port: first.port, databasePath: secondDatabasePath }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal("code" in error ? error.code : undefined, "EADDRINUSE");
          return true;
        },
      );

      const recovered = await startCore({ port: 0, databasePath: secondDatabasePath });
      await recovered.close();
    } finally {
      await first.close();
    }
  } finally {
    rmSync(firstDirectory, { force: true, recursive: true });
    rmSync(secondDirectory, { force: true, recursive: true });
  }
});

test("a competing process gets a stable error and crash ownership is recoverable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "netnavr-core-process-owner-"));
  let first: ChildProcessWithoutNullStreams | undefined;
  let recovered: ChildProcessWithoutNullStreams | undefined;

  try {
    first = spawnCore(directory);
    const firstStarted = await waitForEvent(first, "started");
    assert.equal(typeof firstStarted.nodeId, "string");
    assert.equal(typeof firstStarted.port, "number");

    const contender = spawnCore(directory);
    const contenderResult = await waitForExit(contender);
    assert.equal(contenderResult.exitCode, 1);
    assert.equal(contenderResult.exitSignal, null);
    assert.equal(contenderResult.stderrEvents.length, 1);
    assert.equal(contenderResult.stderrEvents[0]?.event, "startup_failed");
    assert.equal(contenderResult.stderrEvents[0]?.code, CORE_RUNTIME_ALREADY_RUNNING);

    const health = await fetch(`http://127.0.0.1:${String(firstStarted.port)}/v1/health`);
    assert.equal(health.status, 200);

    assert.equal(first.kill("SIGKILL"), true);
    await once(first, "exit");
    first = undefined;

    recovered = spawnCore(directory);
    const recoveredStarted = await waitForEvent(recovered, "started");
    assert.equal(recoveredStarted.nodeId, firstStarted.nodeId);
  } finally {
    await terminate(first);
    await terminate(recovered);
    rmSync(directory, { force: true, recursive: true });
  }
});

test("an invalid runtime lock fails closed before the Core database is created", async () => {
  const directory = mkdtempSync(join(tmpdir(), "netnavr-core-invalid-lock-"));
  const databasePath = join(directory, "core.sqlite");
  const lockPath = join(directory, CORE_RUNTIME_LOCK_FILENAME);

  try {
    writeFileSync(lockPath, "not a sqlite database");

    await assert.rejects(startCore({ port: 0, databasePath }), (error: unknown) => {
      assert.ok(error instanceof CoreRuntimeLockError);
      assert.equal(error.code, CORE_RUNTIME_LOCK_INVALID);
      return true;
    });
    assert.equal(existsSync(databasePath), false);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test(
  "Core storage uses owner-only POSIX permissions",
  { skip: process.platform === "win32" ? "Windows uses inherited ACLs, not POSIX mode bits" : false },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "netnavr-core-private-storage-"));
    const databasePath = join(directory, "core.sqlite");
    const lockPath = join(directory, CORE_RUNTIME_LOCK_FILENAME);

    try {
      chmodSync(directory, 0o777);
      writeFileSync(databasePath, "");
      chmodSync(databasePath, 0o666);

      const core = await startCore({ port: 0, databasePath });
      try {
        assert.equal(posixMode(directory), CORE_PRIVATE_DIRECTORY_MODE);
        assert.equal(posixMode(databasePath), CORE_PRIVATE_FILE_MODE);
        assert.equal(posixMode(lockPath), CORE_PRIVATE_FILE_MODE);

        for (const sqliteSidecar of [`${databasePath}-wal`, `${databasePath}-shm`]) {
          if (existsSync(sqliteSidecar)) {
            assert.equal(posixMode(sqliteSidecar), CORE_PRIVATE_FILE_MODE);
          }
        }
      } finally {
        await core.close();
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  },
);

function spawnCore(dataDirectory: string): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [ENTRYPOINT], {
    env: {
      ...process.env,
      NETNAVR_CORE_DATA_DIR: dataDirectory,
      NETNAVR_CORE_PORT: "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end();
  return child;
}

async function waitForEvent(
  child: ChildProcessWithoutNullStreams,
  eventName: string,
): Promise<Record<string, unknown>> {
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
    while (true) {
      for (const line of stdout.split(/\r?\n/)) {
        if (line.length === 0) {
          continue;
        }
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.event === eventName) {
          return event;
        }
      }

      await Promise.race([
        once(child.stdout, "data"),
        once(child, "exit").then(() => {
          throw new Error(`Core exited before ${eventName}: ${stderr}`);
        }),
      ]);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<{
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  stderrEvents: Array<Record<string, unknown>>;
}> {
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try {
    const [exitCode, exitSignal] = (await once(child, "exit")) as [
      number | null,
      NodeJS.Signals | null,
    ];
    const stderrEvents = stderr
      .split(/\r?\n/)
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    return { exitCode, exitSignal, stderrEvents };
  } finally {
    clearTimeout(timeout);
  }
}

async function terminate(child: ChildProcessWithoutNullStreams | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGKILL");
  await once(child, "exit");
}

function posixMode(path: string): number {
  return statSync(path).mode & 0o777;
}
