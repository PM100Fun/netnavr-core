import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { acquireCoreRuntimeLock, type CoreRuntimeLock } from "./runtime-lock.ts";
import { FIXTURE_MAX_STORAGE_FILE_BYTES, FIXTURE_SCHEMA_VERSION } from "../contracts/fixture-v1.js";

export const FIXTURE_DATABASE_FILENAME = "engineering-fixture.sqlite";
export { FIXTURE_SCHEMA_VERSION };
export interface StoredFixture { marker: "empty" | "alpha" | "beta"; revision: number }

const ALLOWED_FILES = new Set([FIXTURE_DATABASE_FILENAME, `${FIXTURE_DATABASE_FILENAME}-journal`, `${FIXTURE_DATABASE_FILENAME}-wal`, `${FIXTURE_DATABASE_FILENAME}-shm`, "core-runtime.lock", "core-runtime.lock-journal"]);

function safeDirectory(requested: string): string {
  if (typeof requested !== "string" || !isAbsolute(requested) || requested.includes("\0") || basename(requested) !== "fixture-v1") {
    throw new TypeError("Fixture persistence requires an absolute dedicated fixture-v1 directory");
  }
  const directory = resolve(requested);
  // Never resolve through a link into another user's data directory.
  let current = directory;
  while (current !== parse(current).root) {
    if (existsSync(current)) {
      const info = lstatSync(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new TypeError("Fixture directory must not contain symbolic links or non-directory ancestors");
    }
    current = dirname(current);
  }
  if (existsSync(directory)) {
    for (const name of readdirSync(directory)) {
      if (!ALLOWED_FILES.has(name)) throw new TypeError("Fixture directory contains non-fixture material");
      const info = lstatSync(join(directory, name));
      if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) throw new TypeError("Fixture files must be regular files with a single link");
      if (info.size > FIXTURE_MAX_STORAGE_FILE_BYTES) throw new TypeError("Fixture file exceeds the engineering storage limit; original data is preserved");
    }
  } else mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function readValidated(database: DatabaseSync): StoredFixture {
  const version = database.prepare("PRAGMA user_version").get() as { user_version: number };
  if (version.user_version !== FIXTURE_SCHEMA_VERSION) throw new TypeError("Fixture schema is incompatible; original data is preserved");
  const check = database.prepare("PRAGMA quick_check").all() as Array<{ quick_check: string }>;
  if (check.length !== 1 || check[0].quick_check !== "ok") throw new TypeError("Fixture database is corrupt; original data is preserved");
  const objects = database.prepare("SELECT type, name FROM sqlite_schema ORDER BY type, name").all() as Array<{ type: string; name: string }>;
  if (JSON.stringify(objects) !== JSON.stringify([{ type: "table", name: "engineering_fixture_marker" }, { type: "table", name: "engineering_fixture_metadata" }])) throw new TypeError("Fixture database structure is invalid; original data is preserved");
  const expectedColumns = {
    engineering_fixture_marker: [
      { name: "singleton", type: "INTEGER", notnull: 0, dflt_value: null, pk: 1, hidden: 0 },
      { name: "marker", type: "TEXT", notnull: 1, dflt_value: null, pk: 0, hidden: 0 },
      { name: "revision", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0, hidden: 0 },
    ],
    engineering_fixture_metadata: [{ name: "format", type: "TEXT", notnull: 1, dflt_value: null, pk: 0, hidden: 0 }],
  };
  for (const [table, expected] of Object.entries(expectedColumns)) {
    const columns = database.prepare(`PRAGMA table_xinfo(${table})`).all().map(({ cid: _cid, ...column }) => column);
    if (JSON.stringify(columns) !== JSON.stringify(expected) || database.prepare(`PRAGMA foreign_key_list(${table})`).all().length !== 0) throw new TypeError("Fixture column structure is invalid; original data is preserved");
  }
  const metadata = database.prepare("SELECT format FROM engineering_fixture_metadata").all() as Array<{ format: string }>;
  const rows = database.prepare("SELECT singleton, marker, revision FROM engineering_fixture_marker").all() as Array<{ singleton: number; marker: StoredFixture["marker"]; revision: number }>;
  if (metadata.length !== 1 || metadata[0].format !== "netnavr-engineering-fixture-v1" || rows.length !== 1 || rows[0].singleton !== 1 || !["empty", "alpha", "beta"].includes(rows[0].marker) || !Number.isSafeInteger(rows[0].revision) || rows[0].revision < 0) {
    throw new TypeError("Fixture values are invalid; original data is preserved");
  }
  return { marker: rows[0].marker, revision: rows[0].revision };
}

/** Independent engineering data. It never opens or migrates Core product SQLite. */
export class FixtureStore {
  private readonly database: DatabaseSync;
  private readonly lock: CoreRuntimeLock;
  private closed = false;
  constructor(requestedDirectory: string) {
    const directory = safeDirectory(requestedDirectory);
    const path = join(directory, FIXTURE_DATABASE_FILENAME);
    const exists = existsSync(path);
    // Validate existing originals without creating a replacement or migration.
    if (exists) {
      const readOnly = new DatabaseSync(path, { readOnly: true });
      try { readValidated(readOnly); } finally { readOnly.close(); }
    }
    this.lock = acquireCoreRuntimeLock(directory);
    let database: DatabaseSync | undefined;
    try {
      if (!exists) {
        // O_EXCL prevents a concurrently inserted file from being replaced.
        const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        closeSync(descriptor);
      }
      database = new DatabaseSync(path);
      if (!exists) {
        database.exec("PRAGMA page_size=4096");
        database.exec("BEGIN IMMEDIATE; CREATE TABLE engineering_fixture_metadata (format TEXT NOT NULL); CREATE TABLE engineering_fixture_marker (singleton INTEGER PRIMARY KEY CHECK(singleton=1), marker TEXT NOT NULL CHECK(marker IN ('empty','alpha','beta')), revision INTEGER NOT NULL CHECK(revision>=0)); INSERT INTO engineering_fixture_metadata VALUES ('netnavr-engineering-fixture-v1'); INSERT INTO engineering_fixture_marker VALUES (1,'empty',0); PRAGMA user_version=1; COMMIT;");
      }
      readValidated(database);
      database.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;");
      if (process.platform !== "win32") { chmodSync(directory, 0o700); chmodSync(path, 0o600); }
      this.database = database;
    } catch (error) {
      database?.close();
      this.lock.release();
      throw error;
    }
  }
  read(): StoredFixture { return readValidated(this.database); }
  commit(marker: "alpha" | "beta", revision: number): void {
    if (this.closed || !Number.isSafeInteger(revision)) throw new Error("Fixture storage cannot commit");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare("UPDATE engineering_fixture_marker SET marker=?, revision=? WHERE singleton=1 AND revision=?").run(marker, revision, revision - 1);
      if (result.changes !== 1) throw new Error("Fixture revision is inconsistent");
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.database.close(); } finally { this.lock.release(); }
  }
}
