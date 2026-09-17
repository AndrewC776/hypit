/**
 * The worker service entry point.
 *
 * It wires three things the library deliberately does not decide for itself: where state lives, how
 * the Hypit CLI is reached, and what environment that CLI is allowed to see. The last one matters —
 * the adapter never inherits `process.env` wholesale, so the child environment is built explicitly
 * here and contains no credential.
 *
 * `listBuilds` and `programsStatus` are passed in rather than assumed, because both are load
 * bearing: a stubbed `listBuilds` would report "no Build exists" after a crash and submit a second,
 * possibly paid, Build; a stubbed `programsStatus` would let the worker accept jobs that every
 * Build would then refuse.
 */
import { readFileSync } from "node:fs";
import { hostname } from "node:os";

import { listBuilds, programsStatus } from "@hypit/hypit-adapter";
import { createWorkerId } from "@hypit/job-core";
import { JobStore } from "@hypit/job-store-sqlite";

import { createAdapterPort } from "./adapter-port.js";
import { resolveWorkerConfig } from "./config.js";
import { WorkerLoop, installShutdownHandlers } from "./loop.js";

const DEFAULT_PATH = "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    process.stderr.write(`hypit-worker: ${name} is required\n`);
    process.exit(1);
  }
  return value.trim();
}

/** Inline JSON or the path of a JSON file, so a launchd plist can name a file instead. */
function readRegistry(raw: string): Record<string, string> {
  const text = raw.startsWith("{") ? raw : readFileSync(raw, "utf8");
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    process.stderr.write("hypit-worker: HYPIT_PROJECT_REGISTRY must be a JSON object\n");
    process.exit(1);
  }
  const registry: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      process.stderr.write(`hypit-worker: project ${key} must map to an absolute path\n`);
      process.exit(1);
    }
    registry[key] = value;
  }
  return registry;
}

async function main(): Promise<void> {
  const config = resolveWorkerConfig({
    workerId: createWorkerId(hostname(), process.pid),
    statePath: required("HYPIT_STATE_DB"),
    jobsRoot: required("HYPIT_JOBS_ROOT"),
    projectRegistry: readRegistry(required("HYPIT_PROJECT_REGISTRY")),
    hypitExecutable: required("HYPIT_CLI_EXECUTABLE"),
    ffprobeExecutable: process.env.HYPIT_FFPROBE_EXECUTABLE?.trim() || "/opt/homebrew/bin/ffprobe",
    runtimeProfile: required("HYPIT_RUNTIME_PROFILE"),
    // Explicit and complete. HOME is present because the Hypit CLI resolves its machine package
    // home beneath it; nothing else is inherited.
    env: {
      PATH: process.env.PATH ?? DEFAULT_PATH,
      HOME: process.env.HOME ?? "",
    },
  });

  const store = new JobStore(config.statePath);
  const loop = new WorkerLoop({
    config,
    store,
    hypit: createAdapterPort({ listBuilds: async (ctx) => (await listBuilds(ctx)).builds, programsStatus }),
  });
  installShutdownHandlers(loop, process);

  process.stdout.write(`hypit-worker ${config.workerId} starting; jobs root ${config.jobsRoot}\n`);
  try {
    await loop.run();
    process.stdout.write("hypit-worker stopped\n");
  } finally {
    store.close();
  }
}

await main();
