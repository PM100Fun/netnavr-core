import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  ensurePrivateFile,
  hardenExistingPrivateFile,
  prepareCoreStoragePath,
} from "./storage-permissions.ts";

// Modified for the repository split: share the authoritative Core contract.
import { CORE_SCHEMA_VERSION, type CoreNodeIdentity } from "../contracts/core-v1.js";
export { CORE_SCHEMA_VERSION };
export type { CoreNodeIdentity };

type Migration = {
  readonly version: number;
  readonly sql: string;
};

type MigrationRow = {
  version: number;
};

type NodeIdentityRow = {
  node_id: string;
  created_at: string;
};

type SqliteObjectRow = {
  name: string;
};

const NODE_ID_PATTERN =
  /^node_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE node_identity (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        node_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
    `,
  },
];

export class CoreNodeStore {
  readonly #database: DatabaseSync;
  readonly databasePath: string;
  #closed = false;

  constructor(databasePath: string) {
    if (databasePath.length === 0) {
      throw new TypeError("databasePath must not be empty");
    }

    const storagePath =
      databasePath === ":memory:" ? undefined : prepareCoreStoragePath(databasePath);
    this.databasePath = storagePath?.databasePath ?? databasePath;
    if (storagePath !== undefined) {
      ensurePrivateFile(this.databasePath);
    }

    this.#database = new DatabaseSync(this.databasePath);

    try {
      this.#database.exec("PRAGMA foreign_keys = ON");
      this.#database.exec("PRAGMA busy_timeout = 5000");
      this.#migrate();
      if (storagePath !== undefined) {
        this.#database.exec("PRAGMA journal_mode = WAL");
        this.#hardenStorageFiles();
      }
      this.getNodeIdentity();
    } catch (error) {
      this.#database.close();
      this.#closed = true;
      throw error;
    }
  }

  getNodeIdentity(): CoreNodeIdentity {
    this.#assertOpen();

    const rows = this.#database
      .prepare("SELECT node_id, created_at FROM node_identity ORDER BY singleton")
      .all() as NodeIdentityRow[];

    if (rows.length !== 1) {
      throw new Error("core storage must contain exactly one Node identity");
    }

    const row = rows[0];
    if (!NODE_ID_PATTERN.test(row.node_id) || !isCanonicalIsoDate(row.created_at)) {
      throw new Error("core storage contains an invalid Node identity");
    }

    return {
      nodeId: row.node_id,
      createdAt: row.created_at,
      schemaVersion: CORE_SCHEMA_VERSION,
    };
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#database.close();
  }

  #migrate(): void {
    const userVersionRow = this.#database.prepare("PRAGMA user_version").get() as
      | { user_version: number }
      | undefined;
    const userVersion = userVersionRow?.user_version;

    if (!Number.isInteger(userVersion) || userVersion === undefined || userVersion < 0) {
      throw new Error("core storage returned an invalid schema version");
    }
    if (userVersion > CORE_SCHEMA_VERSION) {
      throw new Error(
        `core storage schema version ${userVersion} is newer than supported version ${CORE_SCHEMA_VERSION}`,
      );
    }

    const migrationTable = this.#database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'",
      )
      .get() as SqliteObjectRow | undefined;

    if (migrationTable === undefined) {
      if (userVersion !== 0) {
        throw new Error("core storage migration history does not match its schema version");
      }

      this.#database.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        );
      `);
    }

    const appliedRows = this.#database
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as MigrationRow[];
    const appliedVersions = appliedRows.map((row) => row.version);

    if (
      appliedVersions.some((version, index) => version !== index + 1) ||
      appliedVersions.length !== userVersion
    ) {
      throw new Error("core storage migration history does not match its schema version");
    }

    for (const migration of MIGRATIONS) {
      if (migration.version <= userVersion) {
        continue;
      }

      this.#database.exec("BEGIN IMMEDIATE");
      try {
        this.#database.exec(migration.sql);
        if (migration.version === 1) {
          this.#insertNodeIdentity();
        }
        this.#database
          .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(migration.version, new Date().toISOString());
        this.#database.exec(`PRAGMA user_version = ${migration.version}`);
        this.#database.exec("COMMIT");
      } catch (error) {
        this.#database.exec("ROLLBACK");
        throw error;
      }
    }
  }

  #insertNodeIdentity(): void {
    this.#database
      .prepare("INSERT INTO node_identity (singleton, node_id, created_at) VALUES (1, ?, ?)")
      .run(`node_${randomUUID()}`, new Date().toISOString());
  }

  #hardenStorageFiles(): void {
    hardenExistingPrivateFile(this.databasePath);
    hardenExistingPrivateFile(`${this.databasePath}-wal`);
    hardenExistingPrivateFile(`${this.databasePath}-shm`);
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("core storage is closed");
    }
  }
}

function isCanonicalIsoDate(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}
