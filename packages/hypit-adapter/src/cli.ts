/**
 * The `hypit` binary, and the only code allowed to ask for it.
 *
 * Each function validates its arguments, builds one argv through the per-command allow-list, runs
 * the process, and classifies the result from the JSON envelope. Two rules are repeated here often
 * enough to state once:
 *
 * - Every command passes `--workspace`. The CLI's cwd walk resolves to a DIFFERENT project when it
 *   is omitted (contract 15, TRAP 1), so an omitted workspace does not fail — it answers about
 *   somebody else's builds, which is worse.
 * - `status` and `logs` and `cancel` also pass `--runtime`; `check` and `get` must NOT, because
 *   their allow-lists reject it (contract 17.2/17.3). The allow-list in `argv.ts` enforces that
 *   rather than trusting these call sites.
 */
import { stat } from "node:fs/promises";

import { redact } from "@hypit/job-core";

import {
  assertAbsolutePath,
  assertBuildIdArgument,
  assertContainedPath,
  assertLineCount,
  assertOutputName,
  assertReason,
  buildArgv,
  sourcePath,
} from "./argv.js";
import { buildView, outcomeOf, progressOf } from "./build-view.js";
import type { BuildOutcome } from "./build-view.js";
import {
  CLI_FORMATS,
  expectFormat,
  omittedCounts,
  parseEnvelope,
  plainObject,
  readArray,
  readNumber,
  readString,
} from "./envelope.js";
import type { Envelope, OmittedCount } from "./envelope.js";
import { ADAPTER_CODES, AdapterArgumentError, AdapterError } from "./errors.js";
import { runProcess } from "./spawn.js";
import type { ProcessResult, ProcessRunner } from "./spawn.js";

export type HypitContext = {
  /** Absolute path to the CLI. Its existence is proven by the spawn, not by a stat race. */
  readonly executable: string;
  /** Absolute project directory for this job. */
  readonly workspace: string;
  /** Absolute `hypit.runtime.json`. One shared profile serves every job (contract 17.11). */
  readonly runtimeProfile: string;
  /** Explicit and complete; the adapter never passes `process.env` wholesale. */
  readonly env: Readonly<Record<string, string>>;
  /**
   * The containment boundary of contract 6 and 8. The worker passes its own roots — typically the
   * job workspace and the shared baseline directory — and every path argument must sit inside one.
   * The executable is exempt: it lives in the system prefix, outside any job's area.
   */
  readonly allowedRoots: readonly string[];
  /** Bounds the observer process only. Killing an observer never cancels a durable Build. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly maxOutputBytes?: number;
  /** Injected by tests so a parser can be driven by a captured payload with nothing spawned. */
  readonly run?: ProcessRunner;
};

export type CheckResult = {
  readonly ok: boolean;
  readonly sourceKind: string | null;
  readonly source: string | null;
  readonly outputCount: number | null;
  readonly omitted: readonly OmittedCount[];
};

export type PlanProvider = {
  readonly name: string | null;
  readonly pricingKind: string | null;
};

export type PlanResult = {
  readonly requestCount: number | null;
  readonly localRequestCount: number | null;
  readonly providerRequestCount: number | null;
  readonly unresolvedRequestCount: number | null;
  readonly providers: readonly PlanProvider[];
  /**
   * The spending gate of contract 16.4, decided here so no stage handler has to re-derive it:
   * every request resolved, none of them remote, and every provider priced locally.
   */
  readonly localOnly: boolean;
  readonly omitted: readonly OmittedCount[];
};

export type BuildStatus = {
  readonly buildId: string;
  readonly outcome: BuildOutcome;
  readonly workState: string | null;
  readonly workOutcome: string | null;
  readonly resultState: string | null;
  readonly outputCount: number | null;
  /** 0..1 from the Build's own request counts while working; null once they are gone. */
  readonly progress: number | null;
  readonly omitted: readonly OmittedCount[];
};

export type BuildLogRecord = {
  readonly endpoint: string | null;
  readonly kind: string | null;
  readonly phase: string | null;
  readonly level: string | null;
  readonly message: string | null;
  /** Converted once, here: the CLI reports epoch milliseconds, the control plane speaks ISO. */
  readonly at: string | null;
  readonly timeMs: number | null;
  /**
   * Redacted. It still carries a URL-encoded absolute host path (contract 15 TRAP 3); relativising
   * that is the API's job, because only the API knows which roots a given caller may learn about.
   */
  readonly command: string | null;
};

export type BuildLogs = {
  readonly buildId: string;
  readonly source: string | null;
  readonly records: readonly BuildLogRecord[];
  readonly omitted: readonly OmittedCount[];
};

export type CancelOutcome = {
  readonly buildId: string;
  /**
   * Only that cancellation was REQUESTED (contract 17.7). The remote-provider outcome is
   * deliberately absent from the CLI's output, so no caller may report a paid operation as stopped.
   */
  readonly requested: boolean;
  /** False when the CLI could not see the Build at all, e.g. inside the submitting window. */
  readonly observed: boolean;
  readonly outcome: BuildOutcome;
};

export type ExportResult = {
  readonly buildId: string;
  readonly output: string;
  /** `scalar | resource | composite`. A composite output is a DIRECTORY (contract 17.6). */
  readonly kind: string | null;
  readonly type: string | null;
  /** The CLI's own report of the destination, redacted. The caller already knows the `to` it chose. */
  readonly path: string;
  readonly directory: boolean;
  readonly omitted: readonly OmittedCount[];
};

function assertContext(ctx: HypitContext): void {
  assertAbsolutePath("executable", ctx.executable);
  assertContainedPath("workspace", ctx.workspace, ctx.allowedRoots);
  assertContainedPath("runtimeProfile", ctx.runtimeProfile, ctx.allowedRoots);
}

async function runCli(ctx: HypitContext, argv: readonly string[]): Promise<ProcessResult> {
  const run = ctx.run ?? runProcess;
  return run(ctx.executable, argv, {
    // Every path we pass is absolute, so cwd cannot change what the CLI resolves; it is set to the
    // workspace anyway so that a diagnostic dump lands somewhere the job owns.
    cwd: ctx.workspace,
    env: ctx.env,
    ...(ctx.timeoutMs === undefined ? {} : { timeoutMs: ctx.timeoutMs }),
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    ...(ctx.maxOutputBytes === undefined ? {} : { maxOutputBytes: ctx.maxOutputBytes }),
  });
}

async function runEnvelope(
  ctx: HypitContext,
  command: string,
  expected: string,
  argv: readonly string[],
): Promise<Envelope> {
  const result = await runCli(ctx, argv);
  return expectFormat(command, expected, parseEnvelope(command, result));
}

/** `hypit check <source> --workspace <ws> --json`. No `--runtime`: its allow-list rejects it. */
export async function checkSource(source: string, ctx: HypitContext): Promise<CheckResult> {
  assertContext(ctx);
  const resolved = sourcePath(source, ctx.workspace, ctx.allowedRoots);
  const argv = buildArgv("check", [resolved], [
    { name: "--json" },
    { name: "--workspace", value: ctx.workspace },
  ]);
  const payload = await runEnvelope(ctx, "check", CLI_FORMATS.check, argv);
  const reported = readString(payload, "source");
  return {
    ok: payload.ok === true,
    sourceKind: readString(payload, "sourceKind"),
    source: reported === null ? null : redact(reported),
    outputCount: readNumber(payload, "outputCount"),
    omitted: omittedCounts(payload),
  };
}

/** `hypit plan <run-source> --workspace <ws> --runtime <profile> --json`. The spending gate. */
export async function planRun(runSource: string, ctx: HypitContext): Promise<PlanResult> {
  assertContext(ctx);
  const resolved = sourcePath(runSource, ctx.workspace, ctx.allowedRoots, "runSource");
  const argv = buildArgv("plan", [resolved], [
    { name: "--json" },
    { name: "--workspace", value: ctx.workspace },
    { name: "--runtime", value: ctx.runtimeProfile },
  ]);
  const payload = await runEnvelope(ctx, "plan", CLI_FORMATS.plan, argv);
  const providers = readArray(payload, "providers").map((entry): PlanProvider => {
    const provider = plainObject(entry);
    const pricing = plainObject(provider?.pricing);
    return {
      name: readString(provider, "name") ?? readString(provider, "id"),
      pricingKind: readString(pricing, "kind"),
    };
  });
  const providerRequestCount = readNumber(payload, "providerRequestCount");
  const unresolvedRequestCount = readNumber(payload, "unresolvedRequestCount");
  return {
    requestCount: readNumber(payload, "requestCount"),
    localRequestCount: readNumber(payload, "localRequestCount"),
    providerRequestCount,
    unresolvedRequestCount,
    providers,
    // Unknown counts read as "not local": a plan we cannot account for must not open the wallet.
    localOnly: providerRequestCount === 0
      && unresolvedRequestCount === 0
      && providers.every((provider) => provider.pricingKind === "local"),
    omitted: omittedCounts(payload),
  };
}

/**
 * `hypit build <run-source> --workspace <ws> --runtime <profile> --json`, without `--follow`:
 * submission returns while the Build is still working (contract 16.3) and no request may wait.
 */
export async function submitBuild(runSource: string, ctx: HypitContext): Promise<{ readonly buildId: string }> {
  assertContext(ctx);
  const resolved = sourcePath(runSource, ctx.workspace, ctx.allowedRoots, "runSource");
  const argv = buildArgv("build", [resolved], [
    { name: "--json" },
    { name: "--workspace", value: ctx.workspace },
    { name: "--runtime", value: ctx.runtimeProfile },
  ]);
  const payload = await runEnvelope(ctx, "build", CLI_FORMATS.build, argv);
  const buildId = readString(buildView(payload), "id");
  if (buildId === null) {
    throw new AdapterError({
      class: "PROVIDER_SUBMISSION_UNKNOWN",
      code: ADAPTER_CODES.formatUnexpected,
      // The id is minted client-side at submission (contract 17.5), so an envelope without one may
      // still have left a real Build behind. That is the definition of an unknown submission.
      message: "hypit build returned no Build id; a Build may have been submitted without being recorded",
    });
  }
  assertBuildIdArgument(buildId, "submitted buildId");
  return { buildId };
}

/** `hypit status <id> --workspace <ws> --runtime <profile> --json`. BOTH options, per 17.3. */
export async function getBuildStatus(buildId: string, ctx: HypitContext): Promise<BuildStatus> {
  assertContext(ctx);
  assertBuildIdArgument(buildId);
  const argv = buildArgv("status", [buildId], [
    { name: "--json" },
    { name: "--workspace", value: ctx.workspace },
    { name: "--runtime", value: ctx.runtimeProfile },
  ]);
  const payload = await runEnvelope(ctx, "status", CLI_FORMATS.status, argv);
  const omitted = omittedCounts(payload);
  const view = plainObject(payload.build);
  if (view === undefined) {
    // `build: null` is NOT an error envelope and NOT "still running" (contract 15 TRAP 2, 16).
    return {
      buildId,
      outcome: "not_found",
      workState: null,
      workOutcome: null,
      resultState: null,
      outputCount: null,
      progress: null,
      omitted,
    };
  }
  const work = plainObject(view.work);
  const result = plainObject(view.result);
  return {
    buildId,
    outcome: outcomeOf(work, result),
    workState: readString(work, "state"),
    workOutcome: readString(work, "outcome"),
    resultState: readString(result, "state"),
    outputCount: readNumber(result, "outputCount"),
    progress: progressOf(work),
    omitted,
  };
}

/**
 * `hypit logs <id> --workspace <ws> --runtime <profile> --lines <n> --json`.
 *
 * Returns a value for every observable state, including the benign "no log has been saved yet",
 * which exits 1 (contract 17.1). Turning that exit code into a failure would fail jobs for the
 * crime of being asked about their logs early.
 */
export async function getBuildLogs(buildId: string, lines: number, ctx: HypitContext): Promise<BuildLogs> {
  assertContext(ctx);
  assertBuildIdArgument(buildId);
  assertLineCount(lines);
  const argv = buildArgv("logs", [buildId], [
    { name: "--json" },
    { name: "--workspace", value: ctx.workspace },
    { name: "--runtime", value: ctx.runtimeProfile },
    { name: "--lines", value: String(lines) },
  ]);
  const payload = await runEnvelope(ctx, "logs", CLI_FORMATS.logs, argv);
  const records = readArray(payload, "records").map((entry): BuildLogRecord => {
    const record = plainObject(entry);
    const timeMs = readNumber(record, "time");
    const message = readString(record, "message");
    const command = readString(record, "command");
    return {
      endpoint: readString(record, "endpoint"),
      kind: readString(record, "kind"),
      phase: readString(record, "phase"),
      level: readString(record, "level"),
      message: message === null ? null : redact(message),
      at: timeMs === null ? null : new Date(timeMs).toISOString(),
      timeMs,
      command: command === null ? null : redact(command),
    };
  });
  return {
    buildId,
    source: readString(payload, "source"),
    records,
    omitted: omittedCounts(payload),
  };
}

/** `hypit cancel <id> --workspace <ws> --runtime <profile> --reason <text> --json`. */
export async function cancelBuild(buildId: string, reason: string, ctx: HypitContext): Promise<CancelOutcome> {
  assertContext(ctx);
  assertBuildIdArgument(buildId);
  assertReason(reason);
  const argv = buildArgv("cancel", [buildId], [
    { name: "--json" },
    { name: "--workspace", value: ctx.workspace },
    { name: "--runtime", value: ctx.runtimeProfile },
    { name: "--reason", value: reason },
  ]);
  const payload = await runEnvelope(ctx, "cancel", CLI_FORMATS.cancel, argv);
  const view = plainObject(payload.build);
  return {
    buildId,
    requested: payload.requested === true,
    observed: view !== undefined,
    outcome: view === undefined ? "not_found" : outcomeOf(plainObject(view.work), plainObject(view.result)),
  };
}

/**
 * `hypit get <id> --workspace <ws> --output <name> --to <path> --json`.
 *
 * No `--runtime` (contract 17.2/17.6: `get` reads the project's Result repository and its
 * allow-list rejects the option). The destination is checked first because the CLI refuses to
 * overwrite, and failing here names the real problem instead of surfacing a generic CLI error.
 */
export async function exportOutput(
  buildId: string,
  output: string,
  to: string,
  ctx: HypitContext,
): Promise<ExportResult> {
  assertContext(ctx);
  assertBuildIdArgument(buildId);
  assertOutputName(output);
  assertContainedPath("to", to, ctx.allowedRoots);
  const present = await stat(to).then(() => true, () => false);
  if (present) {
    throw new AdapterArgumentError("to", "already exists and hypit get refuses to overwrite a destination",
      ADAPTER_CODES.destinationExists);
  }
  const argv = buildArgv("get", [buildId], [
    { name: "--json" },
    { name: "--workspace", value: ctx.workspace },
    { name: "--output", value: output },
    { name: "--to", value: to },
  ]);
  const payload = await runEnvelope(ctx, "get", CLI_FORMATS.get, argv);
  const kind = readString(payload, "kind");
  const path = readString(payload, "path");
  return {
    buildId,
    output,
    kind,
    type: readString(payload, "type"),
    path: redact(path ?? to),
    // A composite output is a directory of resources. Probing it as a video would fail obscurely.
    directory: kind === "composite",
    omitted: omittedCounts(payload),
  };
}

/** One row of `hypit.cli-builds@1`. `run` and `createdAt` are what confirm an adoption. */
export type ListedBuild = {
  readonly id: string;
  readonly run: string | null;
  readonly createdAt: string | null;
  readonly outcome: string | null;
};

export type ProgramsStatus = {
  readonly ready: boolean;
  readonly readyCount: number;
  readonly totalCount: number;
};

/**
 * `hypit builds --workspace <ws> --json`.
 *
 * Contract 17.5's orphan recovery. The Build id is minted client-side and printed only after
 * submission, so a worker killed in that window leaves a real Build it never saw. Because each job
 * owns its project directory, listing THAT directory answers the question without guesswork.
 *
 * `--limit` is passed explicitly rather than left at the CLI's default of 20: the caller decides how
 * much history it is willing to consider, and `omitted` reports whatever did not fit.
 */
export async function listBuilds(ctx: HypitContext, limit = 20): Promise<{
  readonly builds: readonly ListedBuild[];
  readonly omitted: readonly OmittedCount[];
}> {
  assertContext(ctx);
  const argv = buildArgv("builds", [], [
    { name: "--json" },
    { name: "--workspace", value: ctx.workspace },
    { name: "--limit", value: String(limit) },
  ]);
  const payload = await runEnvelope(ctx, "builds", CLI_FORMATS.builds, argv);
  const builds = readArray(payload, "builds").flatMap((entry): readonly ListedBuild[] => {
    const row = plainObject(entry);
    const id = readString(row, "id");
    // A row without an id cannot be adopted or reported, and silently keeping it would let a caller
    // count Builds that it can never act on.
    if (id === null) return [];
    return [{
      id,
      run: readString(row, "run"),
      createdAt: readString(row, "createdAt"),
      outcome: readString(row, "outcome"),
    }];
  });
  return { builds, omitted: omittedCounts(payload) };
}

/**
 * `hypit programs status --workspace <ws> --runtime <profile> --json`.
 *
 * Contract 17.8. `build` refuses to submit while a Managed Program is down, so a worker that cannot
 * answer this question must not claim work. An unreadable count is reported as not ready rather than
 * optimistically ready: the failure mode of guessing wrong is a job that dies mid-pipeline.
 */
export async function programsStatus(ctx: HypitContext): Promise<ProgramsStatus> {
  assertContext(ctx);
  const argv = buildArgv("programs status", [], [
    { name: "--json" },
    { name: "--workspace", value: ctx.workspace },
    { name: "--runtime", value: ctx.runtimeProfile },
  ]);
  const payload = await runEnvelope(ctx, "programs status", CLI_FORMATS.programs, argv);
  const readyCount = readNumber(payload, "readyCount");
  const totalCount = readNumber(payload, "programCount");
  return {
    ready: payload.ready === true && readyCount !== null && totalCount !== null && readyCount === totalCount,
    readyCount: readyCount ?? 0,
    totalCount: totalCount ?? 0,
  };
}
