/**
 * Everything the worker is allowed to know about its deployment, injected as one value.
 *
 * Nothing here is read from the environment or defaulted to a home directory: the production host
 * puts its jobs under `~/hypit-work/jobs` and its profile under `~/hypit-work/baseline`, but this
 * package must never say so, or its tests would depend on one machine's layout and CI's Windows leg
 * would fail on the first separator. The service entry point reads the environment; this file only
 * checks what it was handed.
 *
 * `projectRegistry` is the whole of the worker's filesystem authority. A request names a project
 * KEY; only a key present here resolves to a path, so a caller cannot reach a directory the
 * operator did not list — path traversal is not sanitised away, it is structurally impossible.
 */
import { dirname, isAbsolute, resolve } from "node:path";

import { DEFAULT_MAX_ATTEMPTS, isProjectKey } from "@hypit/job-core";

import { WORKER_CODES, WorkerError } from "./errors.js";

/** Contract 8: every 15 seconds, well inside the 120-second stale window. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
export const DEFAULT_POLL_INTERVAL_MS = 1_000;
export const DEFAULT_BUILD_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_STALE_AFTER_MS = 120_000;
export const DEFAULT_RETRY_DELAY_MS = 1_000;
/**
 * How long the worker keeps observing one Build. It bounds the OBSERVER only: a Build is durable
 * and goes on without us, which is why giving up is reported as an observation timeout rather than
 * as a build failure.
 */
export const DEFAULT_BUILD_TIMEOUT_MS = 2 * 60 * 60 * 1_000;
/** The Hypit output this pipeline exports. Proven against the real CLI in contract 16. */
export const DEFAULT_OUTPUT_NAME = "final.video";
/** The file every job publishes, inside its own `output/`. Never derived from a request. */
export const FINAL_VIDEO_NAME = "final.mp4";

export type ProjectRegistry = ReadonlyMap<string, string>;

export type WorkerConfigInput = {
  readonly workerId: string;
  /** The control-plane database file, e.g. `<state>/jobs.sqlite3`. */
  readonly statePath: string;
  /** Parent of every per-job workspace. A job writes nowhere else. */
  readonly jobsRoot: string;
  readonly projectRegistry: ProjectRegistry | Readonly<Record<string, string>>;
  readonly hypitExecutable: string;
  readonly ffprobeExecutable: string;
  /** One shared `hypit.runtime.json`; one Runtime serves every job (contract 17.11). */
  readonly runtimeProfile: string;
  /** Explicit and complete. The adapter never passes `process.env` wholesale. */
  readonly env?: Readonly<Record<string, string>>;
  readonly pollIntervalMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly buildPollIntervalMs?: number;
  readonly buildTimeoutMs?: number;
  readonly staleAfterMs?: number;
  readonly retryDelayMs?: number;
  readonly maxAttempts?: number;
  /** Bounds one CLI observation, never the Build. */
  readonly cliTimeoutMs?: number;
  readonly outputName?: string;
};

export type WorkerConfig = {
  readonly workerId: string;
  readonly statePath: string;
  readonly jobsRoot: string;
  readonly projectRegistry: ProjectRegistry;
  readonly hypitExecutable: string;
  readonly ffprobeExecutable: string;
  readonly runtimeProfile: string;
  readonly env: Readonly<Record<string, string>>;
  /**
   * The containment boundary handed to the adapter: the jobs root and the directory holding the
   * runtime profile. Registered project directories are deliberately absent — the worker reads them
   * with its own filesystem calls to make the per-job copy, and no CLI argument ever names one.
   */
  readonly allowedRoots: readonly string[];
  readonly pollIntervalMs: number;
  readonly heartbeatIntervalMs: number;
  readonly buildPollIntervalMs: number;
  readonly buildTimeoutMs: number;
  readonly staleAfterMs: number;
  readonly retryDelayMs: number;
  readonly maxAttempts: number;
  readonly cliTimeoutMs: number | null;
  readonly outputName: string;
};

function invalid(message: string): never {
  throw new WorkerError({ class: "INTERNAL", code: WORKER_CODES.configInvalid, message });
}

/**
 * Absolute AND already normalised. `resolve(value) === value` is the check rather than `isAbsolute`
 * alone: it rejects a trailing separator and a `.` segment, and on Windows it rejects a POSIX-shaped
 * path, which `isAbsolute` accepts there.
 */
function absolutePath(name: string, value: unknown): string {
  if (typeof value !== "string" || value === "") invalid(`${name} must be a non-empty string`);
  if (!isAbsolute(value) || resolve(value) !== value) {
    invalid(`${name} must be an absolute path in normalised form`);
  }
  return value;
}

function positiveInteger(name: string, value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    invalid(`${name} must be a positive safe integer`);
  }
  return resolved;
}

function nonNegativeInteger(name: string, value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    invalid(`${name} must be a non-negative safe integer`);
  }
  return resolved;
}

function readRegistry(input: WorkerConfigInput["projectRegistry"]): ProjectRegistry {
  const entries = input instanceof Map ? [...input.entries()] : Object.entries(input as Record<string, string>);
  const registry = new Map<string, string>();
  for (const [key, value] of entries) {
    // The key shape is the API's own (`isProjectKey`), so an operator cannot register a key no
    // request could ever name — a silent, undebuggable misconfiguration.
    if (!isProjectKey(key)) invalid("every project registry key must be a lower-case registry key");
    registry.set(key, absolutePath(`project registry entry ${key}`, value));
  }
  return registry;
}

/** Validates an injected configuration and fills the defaults. Throws rather than degrading. */
export function resolveWorkerConfig(input: WorkerConfigInput): WorkerConfig {
  if (typeof input.workerId !== "string" || input.workerId.trim() === "") {
    invalid("workerId must be a non-empty string");
  }
  const jobsRoot = absolutePath("jobsRoot", input.jobsRoot);
  const runtimeProfile = absolutePath("runtimeProfile", input.runtimeProfile);
  const baselineRoot = dirname(runtimeProfile);
  const cliTimeoutMs = input.cliTimeoutMs === undefined
    ? null
    : positiveInteger("cliTimeoutMs", input.cliTimeoutMs, 1);
  const outputName = input.outputName ?? DEFAULT_OUTPUT_NAME;
  if (outputName.trim() === "") invalid("outputName must be a non-empty string");
  return {
    workerId: input.workerId,
    statePath: absolutePath("statePath", input.statePath),
    jobsRoot,
    projectRegistry: readRegistry(input.projectRegistry),
    hypitExecutable: absolutePath("hypitExecutable", input.hypitExecutable),
    ffprobeExecutable: absolutePath("ffprobeExecutable", input.ffprobeExecutable),
    runtimeProfile,
    env: input.env ?? {},
    allowedRoots: jobsRoot === baselineRoot ? [jobsRoot] : [jobsRoot, baselineRoot],
    pollIntervalMs: positiveInteger("pollIntervalMs", input.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS),
    heartbeatIntervalMs: positiveInteger(
      "heartbeatIntervalMs", input.heartbeatIntervalMs, DEFAULT_HEARTBEAT_INTERVAL_MS),
    buildPollIntervalMs: positiveInteger(
      "buildPollIntervalMs", input.buildPollIntervalMs, DEFAULT_BUILD_POLL_INTERVAL_MS),
    buildTimeoutMs: positiveInteger("buildTimeoutMs", input.buildTimeoutMs, DEFAULT_BUILD_TIMEOUT_MS),
    staleAfterMs: nonNegativeInteger("staleAfterMs", input.staleAfterMs, DEFAULT_STALE_AFTER_MS),
    retryDelayMs: nonNegativeInteger("retryDelayMs", input.retryDelayMs, DEFAULT_RETRY_DELAY_MS),
    maxAttempts: positiveInteger("maxAttempts", input.maxAttempts, DEFAULT_MAX_ATTEMPTS),
    cliTimeoutMs,
    outputName,
  };
}

/**
 * The only way a project key becomes a path. An unregistered key is a caller error, not an internal
 * fault, so it fails the job with VALIDATION_FAILED and is never retried.
 */
export function resolveProjectPath(config: WorkerConfig, key: string): string {
  const path = config.projectRegistry.get(key);
  if (path === undefined) {
    // The message names the key, never the registry's contents: it reaches an API response.
    throw new WorkerError({
      class: "VALIDATION_FAILED",
      code: WORKER_CODES.projectNotRegistered,
      message: `project ${key} is not in this worker's project registry`,
    });
  }
  return path;
}
