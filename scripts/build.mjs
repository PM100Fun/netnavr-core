import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

const source = new URL("../src/", import.meta.url);
const output = new URL("../dist/", import.meta.url);
await mkdir(output, { recursive: true });
for (const name of await readdir(source)) {
  if (!name.endsWith(".ts")) continue;
  const input = await readFile(new URL(name, source), "utf8");
  const javascript = stripTypeScriptTypes(input, { mode: "strip" })
    .replace(/(from\s+["']\.\.?\/[^"']+)\.ts(["'])/g, "$1.js$2");
  await writeFile(new URL(name.replace(/\.ts$/, ".js"), output), javascript);
}
