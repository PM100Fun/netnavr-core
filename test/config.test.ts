import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import {
  databasePathFromEnvironment,
  portFromEnvironment,
} from "../src/config.ts";

test("Core uses the default port only when the environment is omitted", () => {
  assert.equal(portFromEnvironment(undefined), 8786);
  assert.equal(portFromEnvironment("0"), 0);
  assert.equal(portFromEnvironment("65535"), 65535);
});

test("Core rejects invalid port environment values", () => {
  for (const value of ["", " ", "\t", "8786.0", "1e3", "65536", "-1"]) {
    assert.throws(
      () => portFromEnvironment(value),
      /NETNAVR_CORE_PORT must be an integer between 0 and 65535/,
    );
  }
});

test("Core rejects empty or whitespace-only data directories", () => {
  for (const value of ["", " ", "\t\r\n", "\u00a0", "\0"]) {
    assert.throws(
      () => databasePathFromEnvironment(value),
      /NETNAVR_CORE_DATA_DIR must be a non-empty directory path/,
    );
  }
});

test("Core preserves explicit nonblank data directories", () => {
  const value = "  data with spaces  ";
  assert.equal(
    databasePathFromEnvironment(value),
    resolve(value, "core.sqlite"),
  );
  assert.equal(databasePathFromEnvironment(undefined), undefined);
});
