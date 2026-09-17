/**
 * The per-job workspace: `<jobsRoot>/<job_id>/{input,project,output,logs}`, mode 0700.
 *
 * Two properties make job isolation real rather than aspirational (contract 16, proven on the
 * production host before this was written):
 *
 * - The project is COPIED into the job's own directory, so a Build never runs inside the repository
 *   working tree and its Results land under `<job>/project/.hypit/results/`. That per-job Result
 *   repository is also what makes orphan recovery unambiguous: one job, one project directory, one
 *   Build to adopt.
 * - The source is a registry entry, resolved from a key. Nothing in a request becomes a path, so
 *   there is no traversal to sanitise.
 *
 * The copy keeps each component's prebuilt `dist/` — Hypit loads `hypit.activation` from it — and
 * drops `.hypit`, `node_modules` and any `hypit.runtime*.json`: the first would import another
 * job's Results, the second is only needed to compile components, and the third would let a stale
 * profile override the one the worker passes on every command.
 */
import { cp, lstat, mkdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import { assertJobId } from "@hypit/job-core";

import { resolveProjectPath } from "./config.js";
import type { WorkerConfig } from "./config.js";
import { WORKER_CODES, WorkerError } from "./errors.js";

/** Owner-only. A job's workspace holds caller content and is not other users' business. */
const WORKSPACE_MODE = 0o700;

const EXCLUDED_ENTRY_NAMES: ReadonlySet<string> = new Set([".hypit", "node_modules"]);

const RUNTIME_PROFILE_NAME = /^hypit\.runtime.*\.json$/u;

export type JobPaths = {
  readonly root: string;
  /** Downloaded references and caller assets. Unused by `prepared_run`, created for both modes. */
  readonly input: string;
  /** The copied project. Every CLI command runs with this as its `--workspace`. */
  readonly project: string;
  readonly output: string;
  readonly logs: string;
};

/**
 * Pure: the same job id always names the same directories. The worker derives paths rather than
 * reading `jobs.workspace_path` so that a row written by an older version cannot redirect a copy.
 */
export function jobPaths(jobsRoot: string, jobId: string): JobPaths {
  // The id is a path segment here. It is asserted rather than sanitised: a job id that is not one
  // of ours is a bug upstream, and quietly rewriting it would hide that bug behind a wrong path.
  assertJobId(jobId);
  const root = join(jobsRoot, jobId);
  return {
    root,
    input: join(root, "input"),
    project: join(root, "project"),
    output: join(root, "output"),
    logs: join(root, "logs"),
  };
}

export async function createWorkspaceDirectories(paths: JobPaths): Promise<void> {
  for (const directory of [paths.root, paths.input, paths.project, paths.output, paths.logs]) {
    await mkdir(directory, { recursive: true, mode: WORKSPACE_MODE });
  }
}

async function includeEntry(source: string): Promise<boolean> {
  const name = basename(source);
  if (EXCLUDED_ENTRY_NAMES.has(name) || RUNTIME_PROFILE_NAME.test(name)) return false;
  const stats = await lstat(source);
  // A symlink inside a registered project would give the job a reach outside the registry entry,
  // which is the one thing the registry exists to prevent. Copy the tree, not its escape hatches.
  return !stats.isSymbolicLink();
}

async function assertProjectDirectory(path: string, key: string): Promise<void> {
  const stats = await stat(path).catch(() => undefined);
  if (stats === undefined || !stats.isDirectory()) {
    // Names the key, not the path: this message reaches an API response and the host's layout is
    // not the caller's business.
    throw new WorkerError({
      class: "VALIDATION_FAILED",
      code: WORKER_CODES.projectNotRegistered,
      message: `project ${key} is registered but its directory is not readable`,
    });
  }
}

/**
 * Creates the job's directories and, for `prepared_run`, copies the registered project into
 * `project/`. Idempotent: a retried or resumed job re-creates what is already there rather than
 * failing, and `cp` overwrites the copy in place.
 */
export async function prepareWorkspace(
  config: WorkerConfig,
  jobId: string,
  projectKey: string,
): Promise<JobPaths> {
  const source = resolveProjectPath(config, projectKey);
  await assertProjectDirectory(source, projectKey);
  const paths = jobPaths(config.jobsRoot, jobId);
  await createWorkspaceDirectories(paths);
  await cp(source, paths.project, {
    recursive: true,
    // Symlinks are refused by the filter, so nothing is dereferenced and nothing outside the
    // registry entry can be reached through one.
    dereference: false,
    filter: includeEntry,
  });
  return paths;
}
