import type { DatabaseSync } from "node:sqlite";

import { assertArgument } from "./errors.js";

/**
 * Schema evolution for the control plane.
 *
 * The rule that makes this safe is procedural, not technical: an entry in `MIGRATIONS` is never
 * edited once it has been applied anywhere. A new column or index is a new entry with the next
 * version. Editing an applied migration would leave two databases with the same recorded version
 * and different shapes, which is the one failure this table exists to prevent.
 *
 * Each version is applied inside its own `BEGIN IMMEDIATE` transaction together with the
 * `schema_migrations` row that records it, so a crash halfway through a version leaves the database
 * on the previous version rather than in a shape no version describes. Applying twice is a no-op:
 * the recorded versions are read first and already-applied ones are skipped.
 *
 * Tables use `STRICT`, as every table in `@hypit/store-sqlite` does. It costs nothing and it turns
 * "a string reached the progress column" into an error at the write rather than a puzzle at the read.
 */
export type Migration = {
  readonly version: number;
  readonly name: string;
  /** Applied in order, inside one transaction with the `schema_migrations` row. */
  readonly statements: readonly string[];
};

export type MigrationOptions = {
  /**
   * Clock for `applied_at`. It defaults to the wall clock because this column is an operator's
   * audit trail rather than domain state — no control-plane decision reads it — but it stays
   * injectable so a test can assert an exact row.
   */
  readonly now?: () => string;
};

const SCHEMA_MIGRATIONS = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  ) STRICT
`;

/**
 * Foreign keys are declared on every child table even though the contract's DDL only spells them
 * out for `jobs.parent_job_id`: the store opens with `PRAGMA foreign_keys = ON`, and an event,
 * attempt, revision or artifact that outlives its job is a record of something that never happened.
 */
const CONTROL_PLANE_SCHEMA: readonly string[] = [
  `
    CREATE TABLE jobs (
      job_id              TEXT PRIMARY KEY,
      root_job_id         TEXT NOT NULL,
      parent_job_id       TEXT REFERENCES jobs(job_id),
      revision_no         INTEGER NOT NULL DEFAULT 1,
      mode                TEXT NOT NULL,
      state               TEXT NOT NULL,
      request_json        TEXT NOT NULL,
      caller_id           TEXT NOT NULL,
      idempotency_key     TEXT,
      workspace_path      TEXT,
      hypit_build_id      TEXT,
      progress            REAL NOT NULL DEFAULT 0,
      attempt_no          INTEGER NOT NULL DEFAULT 0,
      error_code          TEXT,
      error_message       TEXT,
      retryable           INTEGER,
      claimed_by          TEXT,
      claimed_at          TEXT,
      heartbeat_at        TEXT,
      cancel_requested_at TEXT,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL,
      terminal_at         TEXT
    ) STRICT
  `,
  // Partial, so the many jobs created without an Idempotency-Key do not collide with each other:
  // SQLite treats NULLs as distinct in a unique index, and the WHERE clause keeps them out of it
  // entirely. This index is the whole idempotency mechanism — the insert races and this arbitrates.
  `
    CREATE UNIQUE INDEX jobs_idempotency
      ON jobs(caller_id, idempotency_key) WHERE idempotency_key IS NOT NULL
  `,
  "CREATE INDEX jobs_claimable ON jobs(state, created_at)",
  "CREATE INDEX jobs_root ON jobs(root_job_id, revision_no)",
  `
    CREATE TABLE job_events (
      event_id       INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id         TEXT NOT NULL REFERENCES jobs(job_id),
      seq            INTEGER NOT NULL,
      at             TEXT NOT NULL,
      from_state     TEXT,
      to_state       TEXT NOT NULL,
      attempt_no     INTEGER NOT NULL,
      reason         TEXT,
      detail_json    TEXT,
      hypit_build_id TEXT,
      error_code     TEXT,
      retryable      INTEGER,
      UNIQUE (job_id, seq)
    ) STRICT
  `,
  `
    CREATE TABLE attempts (
      attempt_id    TEXT PRIMARY KEY,
      job_id        TEXT NOT NULL REFERENCES jobs(job_id),
      attempt_no    INTEGER NOT NULL,
      state         TEXT NOT NULL,
      worker_id     TEXT NOT NULL,
      started_at    TEXT NOT NULL,
      ended_at      TEXT,
      outcome       TEXT,
      error_code    TEXT,
      error_message TEXT,
      retryable     INTEGER,
      UNIQUE (job_id, attempt_no, state)
    ) STRICT
  `,
  `
    CREATE TABLE revisions (
      revision_id   TEXT PRIMARY KEY,
      root_job_id   TEXT NOT NULL,
      parent_job_id TEXT NOT NULL REFERENCES jobs(job_id),
      job_id        TEXT NOT NULL REFERENCES jobs(job_id),
      revision_no   INTEGER NOT NULL,
      instruction   TEXT NOT NULL,
      reuse_json    TEXT,
      created_at    TEXT NOT NULL
    ) STRICT
  `,
  "CREATE INDEX revisions_root ON revisions(root_job_id, revision_no)",
  `
    CREATE TABLE artifacts (
      artifact_id      TEXT PRIMARY KEY,
      job_id           TEXT NOT NULL REFERENCES jobs(job_id),
      kind             TEXT NOT NULL,
      name             TEXT NOT NULL,
      uri              TEXT NOT NULL,
      media_type       TEXT NOT NULL,
      bytes            INTEGER NOT NULL,
      checksum_sha256  TEXT NOT NULL,
      width            INTEGER,
      height           INTEGER,
      duration_seconds REAL,
      fps              REAL,
      created_at       TEXT NOT NULL
    ) STRICT
  `,
  "CREATE INDEX artifacts_job ON artifacts(job_id, created_at)",
];

/**
 * Worker liveness, which version 1 could not express.
 *
 * Version 1 stamped a heartbeat on the claimed job, so liveness existed only while a job was being
 * worked on: an idle worker was indistinguishable from a dead one, and a freshly deployed control
 * plane with nothing queued would report itself not ready forever. A worker is a thing in its own
 * right, so it gets a row of its own and stamps it whether or not it currently holds work.
 */
const WORKER_LIVENESS: readonly string[] = [
  `
    CREATE TABLE workers (
      worker_id    TEXT PRIMARY KEY,
      started_at   TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL
    ) STRICT
  `,
  "CREATE INDEX workers_heartbeat ON workers(heartbeat_at DESC)",
];

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "control-plane-schema", statements: CONTROL_PLANE_SCHEMA },
  { version: 2, name: "worker-liveness", statements: WORKER_LIVENESS },
];

export function latestMigrationVersion(): number {
  // The list is asserted ascending below, so the last entry is the newest.
  return MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
}

/**
 * Guards the one mistake an appended migration can make that SQLite would not catch: a duplicated
 * or out-of-order version, which would silently skip a migration on a database that already
 * recorded the higher number.
 */
function assertMigrationOrder(): void {
  let previous = 0;
  for (const migration of MIGRATIONS) {
    assertArgument(Number.isSafeInteger(migration.version) && migration.version > previous,
      `migration versions must ascend; ${migration.name} is version ${migration.version} after ${previous}`);
    previous = migration.version;
  }
}

/** Versions recorded as applied, ascending. `/ready` compares this against `latestMigrationVersion`. */
export function appliedMigrationVersions(database: DatabaseSync): readonly number[] {
  database.exec(SCHEMA_MIGRATIONS);
  const rows = database.prepare("SELECT version FROM schema_migrations ORDER BY version ASC")
    .all() as readonly Record<string, unknown>[];
  return rows.map((row) => {
    assertArgument(typeof row.version === "number", "schema_migrations.version must be an integer");
    return row.version;
  });
}

/** Applies every unapplied migration and returns the versions this call applied, in order. */
export function applyMigrations(database: DatabaseSync, options: MigrationOptions = {}): readonly number[] {
  assertMigrationOrder();
  const now = options.now ?? (() => new Date().toISOString());
  const applied = new Set(appliedMigrationVersions(database));
  const freshlyApplied: number[] = [];
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of migration.statements) database.exec(statement);
      database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(migration.version, now());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    freshlyApplied.push(migration.version);
  }
  return freshlyApplied;
}
