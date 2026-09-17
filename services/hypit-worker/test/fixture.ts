import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalArtifactPublisher, createJobId } from "@hypit/job-core";
import type { Job, JobEvent, OutputSpec } from "@hypit/job-core";
import { JobStore } from "@hypit/job-store-sqlite";

import { WorkerLoop, resolveWorkerConfig } from "../src/index.js";
import type { WorkerConfig, WorkerConfigInput } from "../src/index.js";
import { FakeHypit } from "./fake-hypit.js";

/**
 * One temp directory shaped like the production host — a state database, a jobs root, a baseline
 * runtime profile and one registered project — plus a clock that only moves when the worker sleeps.
 * That last part is what makes these tests fast and exact at once: a poll interval costs nothing,
 * and the observation deadline is reached by arithmetic rather than by waiting.
 */

export const CLOCK_BASE = Date.UTC(2026, 8, 17, 12, 0, 0);
export const WORKER_ID = "wkr_probe_101_0000000A";
export const CRASHED_WORKER_ID = "wkr_probe_100_0000000B";
export const PROJECT_KEY = "demo";
export const RUN_SOURCE = "chat.svrun";

export type Clock = { ms: number };

export const OUTPUT: OutputSpec = { width: 540, height: 960, fps: 30 };

export type QueueOptions = {
  readonly project?: string;
  readonly run?: string;
  readonly output?: OutputSpec;
  readonly mode?: "prepared_run" | "clone";
};

export type Harness = {
  readonly directory: string;
  readonly projectRoot: string;
  readonly store: JobStore;
  readonly config: WorkerConfig;
  readonly hypit: FakeHypit;
  readonly loop: WorkerLoop;
  readonly clock: Clock;
  now(): string;
  queue(options?: QueueOptions): Job;
  events(jobId: string): readonly JobEvent[];
  close(): Promise<void>;
};

/**
 * A project laid out like `examples/semantic-composition` after a build: a run source, a component
 * with its prebuilt `dist/`, and the three things the copy must leave behind.
 */
async function writeProject(root: string): Promise<void> {
  await mkdir(join(root, "components", "chat", "dist"), { recursive: true });
  await mkdir(join(root, ".hypit", "results"), { recursive: true });
  await mkdir(join(root, "node_modules", "@hypit"), { recursive: true });
  await writeFile(join(root, RUN_SOURCE), "run chat\n", "utf8");
  await writeFile(join(root, "chat.svml"), "chat\n", "utf8");
  await writeFile(join(root, "components", "chat", "dist", "activation.js"), "export default {};\n", "utf8");
  await writeFile(join(root, ".hypit", "results", "stale.json"), "{}\n", "utf8");
  await writeFile(join(root, "node_modules", "@hypit", "marker.txt"), "installed\n", "utf8");
  await writeFile(join(root, "hypit.runtime.json"), "{}\n", "utf8");
  await writeFile(join(root, "hypit.runtime.local.json"), "{}\n", "utf8");
}

export async function createHarness(overrides: Partial<WorkerConfigInput> = {}): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "hypit-worker-"));
  const projectRoot = join(directory, "projects", PROJECT_KEY);
  await writeProject(projectRoot);
  await mkdir(join(directory, "baseline"), { recursive: true });
  await mkdir(join(directory, "jobs"), { recursive: true });
  await writeFile(join(directory, "baseline", "hypit.runtime.json"), "{}\n", "utf8");

  const clock: Clock = { ms: CLOCK_BASE };
  // Each reading advances a millisecond, so the event log orders itself the way a real one does.
  const now = (): string => {
    const iso = new Date(clock.ms).toISOString();
    clock.ms += 1;
    return iso;
  };
  const config = resolveWorkerConfig({
    workerId: WORKER_ID,
    statePath: join(directory, "state", "jobs.sqlite3"),
    jobsRoot: join(directory, "jobs"),
    projectRegistry: { [PROJECT_KEY]: projectRoot },
    hypitExecutable: join(directory, "bin", "hypit"),
    ffprobeExecutable: join(directory, "bin", "ffprobe"),
    runtimeProfile: join(directory, "baseline", "hypit.runtime.json"),
    pollIntervalMs: 1,
    heartbeatIntervalMs: 1_000,
    buildPollIntervalMs: 10,
    retryDelayMs: 0,
    staleAfterMs: 1_000,
    ...overrides,
  });
  const store = new JobStore(config.statePath);
  const hypit = new FakeHypit();
  const loop = new WorkerLoop({
    config,
    store,
    hypit,
    publisher: new LocalArtifactPublisher({ now: () => clock.ms }),
    now,
    // Sleeping moves the clock instead of the wall: no test waits, and a deadline is still reached.
    sleep: async (ms: number): Promise<void> => {
      clock.ms += ms;
    },
    newAttemptId: ((): (() => string) => {
      let counter = 0;
      return (): string => {
        counter += 1;
        return `att_${counter.toString().padStart(4, "0")}`;
      };
    })(),
  });

  let queued = 0;
  return {
    directory,
    projectRoot,
    store,
    config,
    hypit,
    loop,
    clock,
    now,
    queue(options: QueueOptions = {}): Job {
      queued += 1;
      const offset = queued;
      const request = options.mode === "clone"
        ? {
          mode: "clone",
          reference: { type: "url", url: "https://www.tiktok.com/@a/video/1" },
          instruction: "make it shorter",
          assets: [],
          output: options.output ?? OUTPUT,
        }
        : {
          mode: "prepared_run",
          project: options.project ?? PROJECT_KEY,
          run: options.run ?? RUN_SOURCE,
          output: options.output ?? OUTPUT,
        };
      return store.createJob({
        jobId: createJobId({
          now: () => CLOCK_BASE + offset,
          nonce: () => offset.toString(16).toUpperCase().padStart(8, "0"),
        }),
        mode: options.mode ?? "prepared_run",
        requestJson: JSON.stringify(request),
        callerId: "caller-a",
        now: new Date(CLOCK_BASE + offset).toISOString(),
      }).job;
    },
    events(jobId: string): readonly JobEvent[] {
      return store.listEvents(jobId);
    },
    async close(): Promise<void> {
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** `FROM->TO reason`, which is the shape a job's history is easiest to assert as. */
export function eventTrace(events: readonly JobEvent[]): readonly string[] {
  return events.map((event) => `${event.fromState ?? "-"}->${event.toState} ${event.reason ?? "-"}`);
}
