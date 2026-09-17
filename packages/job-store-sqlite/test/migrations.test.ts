import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { JobStore, MIGRATIONS, applyMigrations, latestMigrationVersion } from "../src/index.js";

type Row = Record<string, unknown>;

/** Everything SQLite itself knows about the schema, in a stable order. */
function schemaSnapshot(database: DatabaseSync): readonly Row[] {
  return database.prepare(`
    SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type ASC, name ASC
  `).all() as readonly Row[];
}

/**
 * node:sqlite returns null-prototype rows, which never deep-equal an object literal. Reading the
 * columns out by name is also the more honest assertion: it names what the row is expected to hold.
 */
function recordedMigrations(database: DatabaseSync): readonly Row[] {
  const rows = database.prepare("SELECT * FROM schema_migrations ORDER BY version ASC")
    .all() as readonly Row[];
  return rows.map((row) => ({ version: row.version, applied_at: row.applied_at }));
}

test("migrations apply once and a second apply changes nothing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hypit-job-migrations-"));
  // Opened directly rather than through JobStore: these assertions are about the migration runner
  // on a bare database, and DatabaseSync creates the file but not a missing parent directory.
  const path = join(directory, "jobs.sqlite3");
  try {
    const database = new DatabaseSync(path);
    try {
      const applied = applyMigrations(database, { now: () => "2026-09-17T11:00:00.000Z" });
      assert.deepEqual(applied, MIGRATIONS.map((migration) => migration.version));
      const schema = schemaSnapshot(database);
      const recorded = recordedMigrations(database);
      // Derived from the list rather than written out: appending a migration is an ordinary change
      // and must not require editing an assertion that is really about the runner, not the schema.
      assert.deepEqual(recorded, MIGRATIONS.map((migration) => ({
        version: migration.version,
        applied_at: "2026-09-17T11:00:00.000Z",
      })));

      // A different clock on the second pass: if anything were re-applied or the row rewritten, the
      // recorded applied_at would move.
      assert.deepEqual(applyMigrations(database, { now: () => "2099-01-01T00:00:00.000Z" }), []);
      assert.deepEqual(schemaSnapshot(database), schema);
      assert.deepEqual(recordedMigrations(database), recorded);
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("opening a store applies the schema, and reopening the same file applies nothing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hypit-job-migrations-open-"));
  // A nested path on purpose: the injected database path points at a state directory that need not
  // exist yet, so the store creates it.
  const path = join(directory, "state", "jobs.sqlite3");
  const first = new JobStore(path);
  try {
    assert.deepEqual(first.migrationVersions(), MIGRATIONS.map((migration) => migration.version));
    assert.equal(first.migrationVersions().at(-1), latestMigrationVersion());
    const second = new JobStore(path);
    try {
      assert.deepEqual(second.migrationVersions(), first.migrationVersions());
    } finally {
      second.close();
    }
  } finally {
    first.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the schema carries every control-plane table and the partial idempotency index", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hypit-job-schema-"));
  const path = join(directory, "jobs.sqlite3");
  const store = new JobStore(path);
  const database = new DatabaseSync(path);
  try {
    const names = (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as readonly Row[])
      .map((row) => row.name);
    for (const table of [
      "schema_migrations", "jobs", "job_events", "attempts", "revisions", "artifacts", "workers",
    ]) {
      assert.ok(names.includes(table), `expected a ${table} table`);
    }
    const index = database.prepare("SELECT sql FROM sqlite_master WHERE name = 'jobs_idempotency'")
      .get() as Row | undefined;
    assert.ok(typeof index?.sql === "string" && index.sql.includes("WHERE idempotency_key IS NOT NULL"),
      "the idempotency index must stay partial so unkeyed jobs never collide");
  } finally {
    database.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
