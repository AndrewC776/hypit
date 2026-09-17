/**
 * The worker loop: claim a job, run it, heartbeat while it runs, and stop cleanly when asked.
 *
 * Three things happen here that do not belong to any single job. Readiness is checked once, at
 * startup: contract 17.8 makes `build` refuse to submit while a Managed Program is down, and a
 * worker that accepted jobs anyway would turn one provisioning problem into a queue of failures —
 * so it refuses to start instead, and it never provisions anything itself. Stale recovery runs
 * before each claim, because a crashed worker's job must come back to the queue rather than sit
 * claimed forever. And the heartbeat is the only thing that tells the store this job is still being
 * worked on; when the store refuses one, the job now belongs to somebody else and this run stops
 * touching it.
 */
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

import { LocalArtifactPublisher } from "@hypit/job-core";
import type { ArtifactPublisher, Job } from "@hypit/job-core";
import type { HypitContext } from "@hypit/hypit-adapter";
import type { JobStore, StaleRecovery } from "@hypit/job-store-sqlite";

import type { WorkerConfig } from "./config.js";
import { WORKER_CODES, WorkerError } from "./errors.js";
import type { HypitPort } from "./hypit-port.js";
import { runJob } from "./job-run.js";
import type { RunSignal } from "./stage.js";

export type WorkerLoopOptions = {
  readonly config: WorkerConfig;
  readonly store: JobStore;
  readonly hypit: HypitPort;
  readonly publisher?: ArtifactPublisher;
  /** ISO-8601 UTC. Injected so a test asserts exact timestamps instead of "roughly now". */
  readonly now?: () => string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly newAttemptId?: () => string;
};

/** Anything that can deliver a termination signal. `process` satisfies it; a test object also does. */
export type SignalTarget = {
  once(event: string, listener: () => void): unknown;
};

function timerSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // Deliberately not unref'd: this is the wait between Build polls, and a process that exited
    // during it would abandon a job it is in the middle of — the timer SHOULD hold the loop open.
    setTimeout(resolve, ms);
  });
}

export class WorkerLoop {
  readonly #config: WorkerConfig;
  readonly #store: JobStore;
  readonly #hypit: HypitPort;
  readonly #publisher: ArtifactPublisher;
  readonly #now: () => string;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #newAttemptId: () => string;
  #stopping = false;
  #ready = false;
  #running: RunSignal | null = null;
  #wake: (() => void) | null = null;

  constructor(options: WorkerLoopOptions) {
    this.#config = options.config;
    this.#store = options.store;
    this.#hypit = options.hypit;
    this.#publisher = options.publisher ?? new LocalArtifactPublisher();
    this.#now = options.now ?? ((): string => new Date().toISOString());
    this.#sleep = options.sleep ?? timerSleep;
    this.#newAttemptId = options.newAttemptId ?? ((): string => `att_${randomUUID()}`);
  }

  get stopping(): boolean {
    return this.#stopping;
  }

  /**
   * A context for the commands that belong to the worker rather than to a job. The workspace is the
   * profile's own directory: it is inside an allowed root, and it holds no job's content.
   */
  #serviceContext(): HypitContext {
    return {
      executable: this.#config.hypitExecutable,
      workspace: dirname(this.#config.runtimeProfile),
      runtimeProfile: this.#config.runtimeProfile,
      env: this.#config.env,
      allowedRoots: this.#config.allowedRoots,
      ...(this.#config.cliTimeoutMs === null ? {} : { timeoutMs: this.#config.cliTimeoutMs }),
    };
  }

  /** Contract 17.8. Throws rather than degrading: a worker that cannot build must not claim. */
  async assertReady(): Promise<void> {
    const status = await this.#hypit.programsStatus(this.#serviceContext());
    if (!status.ready) {
      throw new WorkerError({
        class: "INTERNAL",
        code: WORKER_CODES.programsNotReady,
        message: `${status.readyCount}/${status.totalCount} Managed Programs are ready;`
          + " this worker observes provisioning and never performs it, so it accepts no jobs",
      });
    }
  }

  /**
   * Asked once per process, not once per job: `programs status` is a CLI invocation, and contract
   * 17.8 puts the check at startup. A program that goes down later surfaces as the Build preflight
   * failing the job, which is the layer that can actually see it.
   */
  async #ensureReady(): Promise<void> {
    if (this.#ready) return;
    await this.assertReady();
    this.#ready = true;
  }

  recoverStale(): readonly StaleRecovery[] {
    return this.#store.recoverStale({
      now: this.#now(),
      staleAfterMs: this.#config.staleAfterMs,
      maxAttempts: this.#config.maxAttempts,
    });
  }

  #startHeartbeat(job: Job, signal: RunSignal): () => void {
    const timer = setInterval(() => {
      if (!this.#store.heartbeat(job.jobId, this.#config.workerId, this.#now())) signal.lost = true;
    }, this.#config.heartbeatIntervalMs);
    timer.unref();
    return (): void => {
      clearInterval(timer);
    };
  }

  /**
   * Claims and runs at most one job. Returns the job in its terminal — or, after a shutdown, its
   * last observed — state, or null when the queue held nothing claimable.
   */
  async runOnce(): Promise<Job | null> {
    await this.#ensureReady();
    this.recoverStale();
    const claimed = this.#store.claimNext(this.#config.workerId, this.#now());
    if (claimed === null) return null;
    const signal: RunSignal = { lost: false, stopping: this.#stopping };
    this.#running = signal;
    const stopHeartbeat = this.#startHeartbeat(claimed, signal);
    try {
      return await runJob(claimed, signal, {
        config: this.#config,
        store: this.#store,
        hypit: this.#hypit,
        publisher: this.#publisher,
        now: this.#now,
        sleep: this.#sleep,
        newAttemptId: this.#newAttemptId,
      });
    } finally {
      stopHeartbeat();
      this.#running = null;
    }
  }

  /**
   * Waits out an empty queue, but wakes immediately on `stop()` so shutdown is not a poll away.
   * The timer holds the event loop open on purpose: an idle worker is still a running service, and
   * an unref'd poll timer would let the process exit the first time the queue was empty.
   */
  async #idle(): Promise<void> {
    if (this.#stopping) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.#config.pollIntervalMs);
      this.#wake = (): void => {
        clearTimeout(timer);
        resolve();
      };
    });
    this.#wake = null;
  }

  async run(): Promise<void> {
    await this.#ensureReady();
    // Liveness is reported before the first claim and on every pass, including empty ones. A worker
    // that only stamped a heartbeat while holding a job would be indistinguishable from a dead one
    // whenever the queue was empty, and a freshly deployed control plane with nothing queued would
    // never report itself ready.
    this.#store.recordWorkerHeartbeat(this.#config.workerId, this.#now());
    while (!this.#stopping) {
      const job = await this.runOnce();
      this.#store.recordWorkerHeartbeat(this.#config.workerId, this.#now());
      if (job === null) await this.#idle();
    }
  }

  /**
   * Asks the loop to finish. The store's transactions are synchronous, so whatever transaction is
   * open completes before this is observed at all; the run then stops at the next stage boundary,
   * leaving the job non-terminal for stale recovery to hand back rather than failing work that is
   * still valid.
   */
  stop(): void {
    this.#stopping = true;
    if (this.#running !== null) this.#running.stopping = true;
    this.#wake?.();
  }
}

/** SIGTERM and SIGINT both mean "finish and exit"; neither is an error and neither kills a Build. */
export function installShutdownHandlers(loop: WorkerLoop, target: SignalTarget): void {
  for (const signal of ["SIGTERM", "SIGINT"]) {
    target.once(signal, () => {
      loop.stop();
    });
  }
}
