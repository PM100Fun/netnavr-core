import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as runtime from "../src/server.ts";

test("public runtime declaration covers every JavaScript export without invented values", () => {
  const declarations = ["runtime.d.ts", "core-v1.d.ts"]
    .map((name) => readFileSync(new URL(`../contracts/${name}`, import.meta.url), "utf8"));
  const names = declarations.flatMap((text) => [...text.matchAll(/export declare (?:const|function|class) (\w+)/g)].map((match) => match[1]));
  assert.deepEqual([...new Set(names)].sort(), Object.keys(runtime).sort());
});
