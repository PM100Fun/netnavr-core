import {
  databasePathFromEnvironment,
  portFromEnvironment,
} from "./config.ts";
import {
  CORE_API_VERSION,
  CORE_HOST,
  CORE_SERVICE,
  CORE_VERSION,
  startCore,
} from "./server.ts";

async function main(): Promise<void> {
  const core = await startCore({
    port: portFromEnvironment(process.env.NETNAVR_CORE_PORT),
    databasePath: databasePathFromEnvironment(process.env.NETNAVR_CORE_DATA_DIR),
  });

  let stopping = false;

  const stop = (signal: "SIGINT" | "SIGTERM"): void => {
    if (stopping) {
      return;
    }
    stopping = true;

    void core
      .close()
      .then(() => {
        process.stdout.write(
          `${JSON.stringify({ event: "stopped", service: CORE_SERVICE, signal })}\n`,
        );
      })
      .catch((error: unknown) => {
        process.exitCode = 1;
        process.stderr.write(
          `${JSON.stringify({
            event: "shutdown_failed",
            service: CORE_SERVICE,
            signal,
            error: error instanceof Error ? error.message : String(error),
          })}\n`,
        );
      });
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  process.stdout.write(
    `${JSON.stringify({
      event: "started",
      service: CORE_SERVICE,
      apiVersion: CORE_API_VERSION,
      version: CORE_VERSION,
      nodeId: core.node.nodeId,
      schemaVersion: core.node.schemaVersion,
      host: CORE_HOST,
      port: core.port,
    })}\n`,
  );
}

await main().catch((error: unknown) => {
  process.exitCode = 1;
  process.stderr.write(
    `${JSON.stringify({
      event: "startup_failed",
      service: CORE_SERVICE,
      code: errorCode(error),
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
});

function errorCode(error: unknown): string {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.length > 0
  ) {
    return error.code;
  }
  return "core_startup_failed";
}
