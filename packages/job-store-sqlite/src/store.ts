import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  DEFAULT_MAX_ATTEMPTS,
  JOB_EVENT_REASONS,
  TERMINAL_JOB_STATES,
  assertTransition,
  isTerminalJobState,
  jobError,
} from "@hypit/job-core";
import type {
  Artifact,
  Attempt,
  Job,
  JobError,
  JobEvent,
  JobMode,
  JobState,
  Revision,
} from "@hypit/job-core";

import { JobStoreError, assertArgument, assertRow } from "./errors.js";
import { appliedMigrationVersions, applyMigrations } from "./migrations.js";
import {
  completeAttempt as completeAttemptRecord,
  insertArtifact as insertArtifactRecord,
  insertAttempt as insertAttemptRecord,
  insertJobEvent,
  insertRevision as insertRevisionRecord,
  listArtifacts as listArtifactsRecord,
  listAttempts as listAttemptsRecord,
  listJobEvents,
  listRevisions as listRevisionsRecord,
} from "./records.js";
import type { AttemptEnd, AttemptStart } from "./records.js";
import { encodeBoolean, parseJob } from "./rows.js";
import type { Row } from "./rows.js";

/**
 * The durable control plane. One SQLite file holds every job, its history, its attempts, its
 * revisions and its artifacts, and this class is the only thing that writes them.
 *
 * Three invariants shape every method here:
 *
 * 1. A state change that is not durably recorded did not happen. The `jobs` update and its
 *    `job_events` row are always written in one transaction; there is no path that writes one
 *    without the other.
 * 2. The state machine in `@hypit/job-core` decides what is legal, and it is consulted before the
 *    write, inside the transaction, so a refused transition rolls back and leaves no trace.
 * 3. Nothing is defaulted from the environment. The database path, every timestamp, the worker id
 *    and the recovery thresholds are injected, which is what keeps the API, the worker and the
 *    tests from each inventing their own clock or their own home directory.
 */
export type JobStoreOptions = {
  readonly busyTimeoutMs?: number;
};

export type CreateJobInput = {
  readonly jobId: string;
  readonly mode: JobMode;
  /** The validated request, serialised. Stored verbatim so a revision can replay what was asked. */
  readonly requestJson: string;
  readonly callerId: string;
  /** ISO-8601 UTC. The store owns no clock. */
  readonly now: string;
  readonly idempotencyKey?: string | null;
  /** Defaults to the job's own id: a job with no parent is its own root. */
  readonly rootJobId?: string;
  readonly parentJobId?: string | null;
  readonly revisionNo?: number;
};

export type CreateJobResult = {
  readonly job: Job;
  /** True when the unique index rejected this insert and the job that already existed is returned. */
  readonly replayed: boolean;
};

/**
 * What a transition records besides the new state. Every field but `now` is optional and, when
 * omitted, leaves the column as it was — a forward step does not erase the Build id or the
 * workspace the previous step established.
 */
export type JobTransition = {
  readonly now: string;
  /** Machine form, from `JOB_EVENT_REASONS` where one fits. */
  readonly reason?: string;
  readonly detail?: unknown;
  readonly progress?: number;
  readonly workspacePath?: string;
  readonly hypitBuildId?: string;
  readonly error?: JobError;
};

export type StaleRecoveryOptions = {
  readonly now: string;
  readonly staleAfterMs?: number;
  readonly maxAttempts?: number;
};

export type StaleRecovery = {
  readonly jobId: string;
  readonly fromState: JobState;
  readonly attemptNo: number;
  readonly outcome: "requeued" | "failed";
};

export type CancelOutcome = {
  readonly job: Job;
  /** True only when the job was still QUEUED and unclaimed, so cancellation could finish here. */
  readonly cancelled: boolean;
};

export const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
export const DEFAULT_STALE_AFTER_MS = 120_000;

/** Bound, never interpolated: the terminal set lives in `@hypit/job-core` and is read from there. */
const TERMINAL_PLACEHOLDERS = TERMINAL_JOB_STATES.map(() => "?").join(", ");

function isSqliteError(error: unknown): boolean {
  return error instanceof Error && "code" in error
    && (error as { readonly code?: unknown }).code === "ERR_SQLITE_ERROR";
}

/**
 * The event's detail column. The failure class travels here rather than in a `jobs` column because
 * `error_code` holds the originating machine code (a CLI envelope code, say) and the classification
 * that decided `retryable` would otherwise be unrecoverable from the history.
 */
function transitionDetailJson(transition: JobTransition): string | null {
  const detail: Record<string, unknown> = {};
  if (transition.detail !== undefined) detail.detail = transition.detail;
  if (transition.error !== undefined) detail.error = transition.error;
  return Object.keys(detail).length === 0 ? null : JSON.stringify(detail);
}

export class JobStore {
  readonly path: string;
  readonly #database: DatabaseSync;

  constructor(path: string, options: JobStoreOptions = {}) {
    assertArgument(path.trim().length > 0, "job store path must not be empty");
    const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
    // A PRAGMA takes no bound parameter, so this value is interpolated. It is the only string this
    // package builds into SQL, and it is proven an integer first.
    assertArgument(Number.isSafeInteger(busyTimeoutMs) && busyTimeoutMs > 0,
      "busyTimeoutMs must be a positive safe integer");
    const absolute = resolve(path);
    mkdirSync(dirname(absolute), { recursive: true });
    this.path = absolute;
    this.#database = new DatabaseSync(absolute);
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    this.#database.exec("PRAGMA synchronous = NORMAL");
    applyMigrations(this.#database);
  }

  close(): void {
    this.#database.close();
  }

  /** Recorded schema versions, for the API's readiness check. */
  migrationVersions(): readonly number[] {
    return appliedMigrationVersions(this.#database);
  }

  #transaction<T>(body: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = body();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  readJob(jobId: string): Job | undefined {
    const row = this.#database.prepare("SELECT * FROM jobs WHERE job_id = ?").get(jobId) as Row | undefined;
    return row === undefined ? undefined : parseJob(row);
  }

  /** The replay lookup. Only ever reached after the unique index has already refused an insert. */
  readJobByIdempotency(callerId: string, idempotencyKey: string): Job | undefined {
    const row = this.#database.prepare(`
      SELECT * FROM jobs WHERE caller_id = ? AND idempotency_key = ?
    `).get(callerId, idempotencyKey) as Row | undefined;
    return row === undefined ? undefined : parseJob(row);
  }

  #requireJob(jobId: string): Job {
    const job = this.readJob(jobId);
    if (job === undefined) throw new JobStoreError("JOB_NOT_FOUND", `job ${jobId} does not exist`);
    return job;
  }

  /**
   * Inserts a QUEUED job with its creation event, or returns the job that already holds this
   * caller's idempotency key.
   *
   * The duplicate is detected by letting the insert fail, never by checking first: a `SELECT` before
   * the `INSERT` is a race that admits both of two concurrent creates, which for this control plane
   * means two Hypit Builds and two charges. The partial unique index arbitrates instead, and the
   * loser re-reads the winner's row.
   */
  createJob(input: CreateJobInput): CreateJobResult {
    const idempotencyKey = input.idempotencyKey ?? null;
    try {
      const job = this.#transaction(() => {
        const row = this.#database.prepare(`
          INSERT INTO jobs (
            job_id, root_job_id, parent_job_id, revision_no, mode, state, request_json,
            caller_id, idempotency_key, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'QUEUED', ?, ?, ?, ?, ?)
          RETURNING *
        `).get(
          input.jobId, input.rootJobId ?? input.jobId, input.parentJobId ?? null,
          input.revisionNo ?? 1, input.mode, input.requestJson, input.callerId, idempotencyKey,
          input.now, input.now,
        ) as Row | undefined;
        assertRow(row !== undefined, `job ${input.jobId} was inserted but returned no row`);
        const created = parseJob(row);
        insertJobEvent(this.#database, {
          jobId: created.jobId, at: input.now, fromState: null, toState: created.state,
          attemptNo: created.attemptNo, reason: JOB_EVENT_REASONS.created, detailJson: null,
          hypitBuildId: null, errorCode: null, retryable: null,
        });
        return created;
      });
      return { job, replayed: false };
    } catch (error) {
      // node:sqlite raises ERR_SQLITE_ERROR for a unique-index violation. A constraint failure with
      // no matching row behind it is a different bug (a duplicate job id, a broken foreign key) and
      // is re-thrown rather than disguised as a replay.
      if (idempotencyKey !== null && isSqliteError(error)) {
        const existing = this.readJobByIdempotency(input.callerId, idempotencyKey);
        if (existing !== undefined) return { job: existing, replayed: true };
      }
      throw error;
    }
  }

  /**
   * Takes the oldest claimable job and moves it into PREPARING_WORKSPACE, or returns null when the
   * queue holds nothing claimable.
   *
   * The whole claim is one correlated `UPDATE ... RETURNING` under `BEGIN IMMEDIATE`: the row is
   * selected and written by a single statement holding the write lock, so two workers racing on one
   * file get two different jobs, or one job and one null, and never the same job twice.
   */
  claimNext(workerId: string, now: string): Job | null {
    return this.#transaction(() => {
      const row = this.#database.prepare(`
        UPDATE jobs
           SET claimed_by = ?, claimed_at = ?, heartbeat_at = ?, state = 'PREPARING_WORKSPACE',
               attempt_no = attempt_no + 1, updated_at = ?
         WHERE job_id = (
           SELECT job_id FROM jobs
            WHERE state = 'QUEUED' AND claimed_by IS NULL AND cancel_requested_at IS NULL
            ORDER BY created_at LIMIT 1)
        RETURNING *
      `).get(workerId, now, now, now) as Row | undefined;
      if (row === undefined) return null;
      const job = parseJob(row);
      insertJobEvent(this.#database, {
        jobId: job.jobId, at: now, fromState: "QUEUED", toState: job.state,
        attemptNo: job.attemptNo, reason: JOB_EVENT_REASONS.claimed, detailJson: null,
        hypitBuildId: job.hypitBuildId, errorCode: null, retryable: null,
      });
      return job;
    });
  }

  /**
   * Moves a job to `to` and records exactly one event for the move. Refuses anything the state
   * machine refuses — a backward step, a self-transition, any move out of a terminal state — and
   * refuses it before writing, so a rejected transition leaves the history untouched.
   */
  recordTransition(jobId: string, to: JobState, transition: JobTransition): Job {
    return this.#transaction(() => {
      const current = this.#requireJob(jobId);
      assertTransition(current.state, to);
      const row = this.#database.prepare(`
        UPDATE jobs
           SET state = ?, progress = ?, workspace_path = ?, hypit_build_id = ?,
               error_code = ?, error_message = ?, retryable = ?, updated_at = ?, terminal_at = ?
         WHERE job_id = ?
        RETURNING *
      `).get(
        to,
        transition.progress ?? current.progress,
        transition.workspacePath ?? current.workspacePath,
        transition.hypitBuildId ?? current.hypitBuildId,
        transition.error?.code ?? current.errorCode,
        transition.error?.message ?? current.errorMessage,
        encodeBoolean(transition.error?.retryable ?? current.retryable),
        transition.now,
        isTerminalJobState(to) ? transition.now : current.terminalAt,
        jobId,
      ) as Row | undefined;
      assertRow(row !== undefined, `job ${jobId} disappeared during its own transition`);
      const job = parseJob(row);
      insertJobEvent(this.#database, {
        jobId, at: transition.now, fromState: current.state, toState: to,
        attemptNo: job.attemptNo, reason: transition.reason ?? null,
        detailJson: transitionDetailJson(transition), hypitBuildId: job.hypitBuildId,
        errorCode: transition.error?.code ?? null, retryable: transition.error?.retryable ?? null,
      });
      return job;
    });
  }

  /**
   * Refreshes the liveness stamp. False means the job is no longer this worker's to report on —
   * another worker claimed it after a stale recovery, or it already reached a terminal state — which
   * is how a worker that was paused long enough to lose its job finds out.
   */
  heartbeat(jobId: string, workerId: string, now: string): boolean {
    const result = this.#database.prepare(`
      UPDATE jobs
         SET heartbeat_at = ?, updated_at = ?
       WHERE job_id = ? AND claimed_by = ? AND state NOT IN (${TERMINAL_PLACEHOLDERS})
    `).run(now, now, jobId, workerId, ...TERMINAL_JOB_STATES);
    return result.changes === 1;
  }

  /**
   * Records that this worker is alive, whether or not it currently holds a job.
   *
   * Job heartbeats answer "is this job still being worked on"; this answers "is anything able to
   * work at all", which is what readiness needs and what an idle worker would otherwise never say.
   */
  recordWorkerHeartbeat(workerId: string, now: string): void {
    this.#database.prepare(`
      INSERT INTO workers (worker_id, started_at, heartbeat_at) VALUES (?, ?, ?)
        ON CONFLICT(worker_id) DO UPDATE SET heartbeat_at = excluded.heartbeat_at
    `).run(workerId, now, now);
  }

  /** The most recent worker heartbeat, or null when no worker has ever reported. */
  latestWorkerHeartbeat(): string | null {
    const row = this.#database.prepare(
      "SELECT heartbeat_at AS at FROM workers ORDER BY heartbeat_at DESC LIMIT 1",
    ).get() as { at?: unknown } | undefined;
    return typeof row?.at === "string" ? row.at : null;
  }

  /**
   * Hands jobs back from workers that stopped reporting. A crashed worker must never leave a job
   * stuck forever, so every claimed, non-terminal job whose heartbeat is older than `staleAfterMs`
   * is either requeued or, once its attempts are exhausted, failed as INTERNAL.
   */
  recoverStale(options: StaleRecoveryOptions): readonly StaleRecovery[] {
    const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    assertArgument(Number.isSafeInteger(staleAfterMs) && staleAfterMs >= 0,
      "staleAfterMs must be a non-negative safe integer");
    const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    assertArgument(Number.isSafeInteger(maxAttempts) && maxAttempts > 0,
      "maxAttempts must be a positive safe integer");
    const nowMs = Date.parse(options.now);
    assertArgument(Number.isFinite(nowMs), "recoverStale now must be an ISO-8601 timestamp");
    // Both sides are `toISOString()` output, so they share one fixed-width format and compare
    // correctly as text. This is also why the schema stores timestamps as TEXT.
    const threshold = new Date(nowMs - staleAfterMs).toISOString();
    return this.#transaction(() => {
      const rows = this.#database.prepare(`
        SELECT * FROM jobs
         WHERE claimed_by IS NOT NULL
           AND state NOT IN (${TERMINAL_PLACEHOLDERS})
           AND COALESCE(heartbeat_at, claimed_at) < ?
         ORDER BY created_at ASC
      `).all(...TERMINAL_JOB_STATES, threshold) as readonly Row[];
      return rows.map((row) => {
        const job = parseJob(row);
        return job.attemptNo >= maxAttempts
          ? this.#failStale(job, options.now)
          : this.#requeueStale(job, options.now);
      });
    });
  }

  #requeueStale(job: Job, now: string): StaleRecovery {
    // The one sanctioned backward move in the whole control plane. The state machine refuses it on
    // purpose, so recovery writes the row itself and records the reason: this is not a stage
    // transition, it is a crashed worker's job being handed back to the queue.
    this.#database.prepare(`
      UPDATE jobs
         SET state = 'QUEUED', claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL,
             updated_at = ?
       WHERE job_id = ?
    `).run(now, job.jobId);
    insertJobEvent(this.#database, {
      jobId: job.jobId, at: now, fromState: job.state, toState: "QUEUED", attemptNo: job.attemptNo,
      reason: JOB_EVENT_REASONS.staleHeartbeat, detailJson: null, hypitBuildId: job.hypitBuildId,
      errorCode: null, retryable: null,
    });
    return { jobId: job.jobId, fromState: job.state, attemptNo: job.attemptNo, outcome: "requeued" };
  }

  #failStale(job: Job, now: string): StaleRecovery {
    // Deliberately says nothing about which host or worker died: this message reaches an API
    // response, and the host's layout is not the caller's business.
    const failure = jobError({
      class: "INTERNAL",
      code: "INTERNAL",
      message: "the worker holding this job stopped reporting and its attempts are exhausted",
    });
    this.#database.prepare(`
      UPDATE jobs
         SET state = 'FAILED', claimed_by = NULL, error_code = ?, error_message = ?, retryable = ?,
             updated_at = ?, terminal_at = ?
       WHERE job_id = ?
    `).run(failure.code, failure.message, encodeBoolean(failure.retryable), now, now, job.jobId);
    insertJobEvent(this.#database, {
      jobId: job.jobId, at: now, fromState: job.state, toState: "FAILED", attemptNo: job.attemptNo,
      reason: JOB_EVENT_REASONS.staleHeartbeat, detailJson: JSON.stringify({ error: failure }),
      hypitBuildId: job.hypitBuildId, errorCode: failure.code, retryable: failure.retryable,
    });
    return { jobId: job.jobId, fromState: job.state, attemptNo: job.attemptNo, outcome: "failed" };
  }

  /**
   * Records that a caller wants this job stopped, and finishes the job here when it has not started:
   * a QUEUED, unclaimed job can be cancelled outright, and doing it in the same transaction as the
   * flag closes the window where a worker claims the job a moment after the flag lands.
   *
   * A running job only gets the flag. The worker reads it between stages and while polling, asks
   * Hypit to cancel the Build and then transitions the job itself, because nothing here can promise
   * that a remote operation already in flight actually stopped.
   */
  requestCancel(jobId: string, now: string): CancelOutcome {
    return this.#transaction(() => {
      const current = this.#requireJob(jobId);
      // Terminal is immutable: a finished job is not cancelled, and its record is not rewritten.
      if (isTerminalJobState(current.state)) return { job: current, cancelled: false };
      if (current.state !== "QUEUED" || current.claimedBy !== null) {
        const flagged = this.#database.prepare(`
          UPDATE jobs
             SET cancel_requested_at = COALESCE(cancel_requested_at, ?), updated_at = ?
           WHERE job_id = ?
          RETURNING *
        `).get(now, now, jobId) as Row | undefined;
        assertRow(flagged !== undefined, `job ${jobId} disappeared while being cancelled`);
        return { job: parseJob(flagged), cancelled: false };
      }
      assertTransition(current.state, "CANCELLED");
      const failure = jobError({
        class: "CANCELLED",
        code: "CANCELLED",
        message: "cancelled before the job was claimed",
      });
      const row = this.#database.prepare(`
        UPDATE jobs
           SET cancel_requested_at = COALESCE(cancel_requested_at, ?), state = 'CANCELLED',
               error_code = ?, error_message = ?, retryable = ?, updated_at = ?, terminal_at = ?
         WHERE job_id = ?
        RETURNING *
      `).get(
        now, failure.code, failure.message, encodeBoolean(failure.retryable), now, now, jobId,
      ) as Row | undefined;
      assertRow(row !== undefined, `job ${jobId} disappeared while being cancelled`);
      const job = parseJob(row);
      insertJobEvent(this.#database, {
        jobId, at: now, fromState: current.state, toState: "CANCELLED", attemptNo: job.attemptNo,
        reason: JOB_EVENT_REASONS.cancelled, detailJson: JSON.stringify({ error: failure }),
        hypitBuildId: job.hypitBuildId, errorCode: failure.code, retryable: failure.retryable,
      });
      return { job, cancelled: true };
    });
  }

  /** The job's history, oldest first. One row per state change, with no gaps in `seq`. */
  listEvents(jobId: string): readonly JobEvent[] {
    return listJobEvents(this.#database, jobId);
  }

  startAttempt(attempt: AttemptStart): void {
    insertAttemptRecord(this.#database, attempt);
  }

  /** Returns the closed attempt, or undefined when no attempt carries that id. */
  finishAttempt(attemptId: string, end: AttemptEnd): Attempt | undefined {
    return completeAttemptRecord(this.#database, attemptId, end);
  }

  listAttempts(jobId: string): readonly Attempt[] {
    return listAttemptsRecord(this.#database, jobId);
  }

  addRevision(revision: Revision): void {
    insertRevisionRecord(this.#database, revision);
  }

  listRevisions(rootJobId: string): readonly Revision[] {
    return listRevisionsRecord(this.#database, rootJobId);
  }

  addArtifact(artifact: Artifact): void {
    insertArtifactRecord(this.#database, artifact);
  }

  listArtifacts(jobId: string): readonly Artifact[] {
    return listArtifactsRecord(this.#database, jobId);
  }
}
