import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AdapterError,
  cancelBuild,
  checkSource,
  exportOutput,
  getBuildLogs,
  getBuildStatus,
  planRun,
  submitBuild,
} from "../src/index.js";
import type { HypitContext, ProcessResult, ProcessRunner } from "../src/index.js";

/**
 * The parsers are driven by the payloads captured on the production host (contract 15 and 16)
 * through an injected runner, so this file proves the classification without a CLI being present.
 *
 * The exit codes are the measured ones, and they are all wrong in the way the contract warns
 * about: a not-found status exits 1, a benign "no saved log" exits 1, and a cancelled build exits
 * 0. Every assertion below therefore has to come from the envelope.
 */
const BUILD_ID = "bld_20260917T121134939Z_1850BA006E";

/** Under `--json` the CLI prints everything to stdout and leaves stderr empty (contract 16). */
function reply(stdout: string, code = 0): ProcessResult {
  return { code, stdout, stderr: "", truncated: false };
}

async function withCli(
  answer: (argv: readonly string[]) => ProcessResult,
  body: (ctx: HypitContext, calls: string[][], dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hypit-adapter-cli-"));
  try {
    const calls: string[][] = [];
    const run: ProcessRunner = (_executable, argv) => {
      calls.push([...argv]);
      return Promise.resolve(answer(argv));
    };
    const ctx: HypitContext = {
      executable: join(dir, "bin", "hypit"),
      workspace: join(dir, "project"),
      runtimeProfile: join(dir, "hypit.runtime.json"),
      env: {},
      allowedRoots: [dir],
      run,
    };
    await body(ctx, calls, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const CHECK_OK = JSON.stringify({
  format: "hypit.cli-check@1",
  sourceKind: "markup",
  ok: true,
  source: "chat.svml",
  frontend: "svml",
  units: 3,
  assets: 2,
  modules: 1,
  outputCount: 4,
});

const ERROR_USAGE = JSON.stringify({
  format: "hypit.cli-error@1",
  ok: false,
  error: {
    code: "CLI_USAGE",
    message: "--runtime does not apply to check",
    help: "hypit check <source> [--workspace <dir>]",
  },
});

const PLAN_LOCAL = JSON.stringify({
  format: "hypit.cli-plan@1",
  requestCount: 3,
  localRequestCount: 3,
  providerRequestCount: 0,
  unresolvedRequestCount: 0,
  providers: [
    { name: "hyperframes.local", pricing: { kind: "local" } },
    { name: "media.local", pricing: { kind: "local" } },
  ],
});

const PLAN_PAID = JSON.stringify({
  format: "hypit.cli-plan@1",
  requestCount: 3,
  localRequestCount: 2,
  providerRequestCount: 1,
  unresolvedRequestCount: 0,
  providers: [{ name: "hypihub", pricing: { kind: "metered" } }],
});

const BUILD_SUBMITTED = JSON.stringify({
  format: "hypit.cli-build@1",
  build: {
    id: BUILD_ID,
    targets: ["final.video"],
    work: { state: "working", requests: { total: 3, completed: 1 } },
    result: { state: "missing" },
  },
});

const STATUS_NOT_FOUND = JSON.stringify({ format: "hypit.cli-status@1", build: null });

const STATUS_WORKING = JSON.stringify({
  format: "hypit.cli-status@1",
  build: {
    id: BUILD_ID,
    targets: ["final.video"],
    work: { state: "working", requests: { total: 4, completed: 1 } },
    result: { state: "missing" },
  },
});

const STATUS_COMPLETE = JSON.stringify({
  format: "hypit.cli-status@1",
  build: {
    id: BUILD_ID,
    targets: ["final.video"],
    work: { state: "done", outcome: "complete" },
    result: { state: "complete", outputCount: 4 },
  },
});

const STATUS_CANCELLED = JSON.stringify({
  format: "hypit.cli-status@1",
  build: {
    id: BUILD_ID,
    targets: ["final.video"],
    work: { state: "done", outcome: "cancelled" },
    result: { state: "missing", outputCount: 0 },
  },
});

const LOGS_NONE = JSON.stringify({
  format: "hypit.cli-logs@1",
  build: BUILD_ID,
  source: null,
  records: [],
  omittedRecords: 0,
});

const LOGS_RECORDS = JSON.stringify({
  format: "hypit.cli-logs@1",
  build: BUILD_ID,
  source: "result",
  records: [
    {
      endpoint: "hyperframes.local",
      kind: "phase",
      phase: "storing output",
      format: "hypit.execution-log@1",
      time: 1789643623666,
      command: "need:need:author%3A%2FUsers%2Foperator%2FDocuments%2Fgithub%2Fhypit%2Fexamples%2Fchat.svrun",
    },
    {
      endpoint: "media.local",
      kind: "diagnostic",
      level: "warning",
      message: "retrying with Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payloadpayload.signature",
      time: 1789643623999,
      command: "need:need:render",
    },
  ],
  omittedRecords: 7,
});

test("a submitted build yields its id, and the argv is a submission rather than a follow", async () => {
  await withCli(() => reply(BUILD_SUBMITTED), async (ctx, calls) => {
    const submitted = await submitBuild("chat.svrun", ctx);
    assert.equal(submitted.buildId, BUILD_ID);
    const argv = calls[0] ?? [];
    assert.equal(argv[0], "build");
    assert.ok(argv.includes("--workspace"));
    assert.ok(argv.includes("--runtime"));
    // No --follow: submission returns while the Build is still working, and no request may wait.
    assert.equal(argv.includes("--follow"), false);
  });
});

test("status with build:null is NOT_FOUND even though the process exited 1", async () => {
  await withCli(() => reply(STATUS_NOT_FOUND, 1), async (ctx) => {
    const status = await getBuildStatus(BUILD_ID, ctx);
    assert.equal(status.outcome, "not_found");
    assert.notEqual(status.outcome, "running");
    assert.equal(status.workState, null);
    assert.equal(status.progress, null);
  });
});

test("status passes both --workspace and --runtime", async () => {
  await withCli(() => reply(STATUS_WORKING), async (ctx, calls) => {
    const status = await getBuildStatus(BUILD_ID, ctx);
    assert.equal(status.outcome, "running");
    assert.equal(status.progress, 0.25);
    const argv = calls[0] ?? [];
    assert.ok(argv.includes("--workspace"), "status without --workspace answers about another project");
    assert.ok(argv.includes("--runtime"), "status without --runtime exits 1 for a healthy build");
  });
});

test("a complete build is complete only when work and result both say so", async () => {
  await withCli(() => reply(STATUS_COMPLETE), async (ctx) => {
    const status = await getBuildStatus(BUILD_ID, ctx);
    assert.equal(status.outcome, "complete");
    assert.equal(status.outputCount, 4);
  });
});

test("a cancelled build exits 0 and is still not reported as complete", async () => {
  await withCli(() => reply(STATUS_CANCELLED, 0), async (ctx) => {
    const status = await getBuildStatus(BUILD_ID, ctx);
    assert.equal(status.outcome, "cancelled");
    assert.notEqual(status.outcome, "complete");
  });
});

test("a CLI_USAGE error envelope on stdout is read as an error, not as a success", async () => {
  await withCli(() => reply(ERROR_USAGE, 1), async (ctx) => {
    await assert.rejects(checkSource("chat.svml", ctx), (error: unknown) => {
      assert.ok(error instanceof AdapterError);
      assert.equal(error.code, "CLI_USAGE");
      // Our bug, not the caller's, and never a Build failure.
      assert.equal(error.errorClass, "INTERNAL");
      assert.notEqual(error.errorClass, "HYPIT_BUILD_FAILED");
      assert.ok(error.message.includes("--runtime does not apply to check"));
      return true;
    });
  });
});

test("check parses its own envelope and never passes --runtime", async () => {
  await withCli(() => reply(CHECK_OK), async (ctx, calls) => {
    const result = await checkSource("chat.svml", ctx);
    assert.equal(result.ok, true);
    assert.equal(result.sourceKind, "markup");
    assert.equal(result.outputCount, 4);
    assert.equal((calls[0] ?? []).includes("--runtime"), false);
  });
});

test("plan is the spending gate: local-only is true only when nothing is remote or unresolved", async () => {
  await withCli(() => reply(PLAN_LOCAL), async (ctx) => {
    const plan = await planRun("chat.svrun", ctx);
    assert.equal(plan.requestCount, 3);
    assert.equal(plan.providerRequestCount, 0);
    assert.equal(plan.unresolvedRequestCount, 0);
    assert.equal(plan.localOnly, true);
    assert.deepEqual(plan.providers.map((provider) => provider.pricingKind), ["local", "local"]);
  });
  await withCli(() => reply(PLAN_PAID), async (ctx) => {
    const plan = await planRun("chat.svrun", ctx);
    assert.equal(plan.localOnly, false);
  });
});

test("no saved log exits 1 and is not a build failure", async () => {
  await withCli(() => reply(LOGS_NONE, 1), async (ctx) => {
    const logs = await getBuildLogs(BUILD_ID, 50, ctx);
    assert.deepEqual(logs.records, []);
    assert.equal(logs.source, null);
    assert.deepEqual(logs.omitted, []);
  });
});

test("log records surface their omitted counter, convert epoch millis, and are redacted", async () => {
  await withCli(() => reply(LOGS_RECORDS), async (ctx, calls) => {
    const logs = await getBuildLogs(BUILD_ID, 2, ctx);
    assert.equal(logs.records.length, 2);
    // Contract 17.9: a truncated array without its counter under-reports in silence.
    assert.deepEqual(logs.omitted, [{ field: "omittedRecords", count: 7 }]);
    assert.equal(logs.records[0]?.at, new Date(1789643623666).toISOString());
    assert.equal(logs.records[0]?.timeMs, 1789643623666);
    const message = logs.records[1]?.message ?? "";
    assert.ok(message.includes("[REDACTED:"), message);
    assert.equal(message.includes("eyJhbGciOiJIUzI1NiJ9"), false);
    assert.ok((calls[0] ?? []).includes("--lines"));
  });
});

test("cancel reports only that cancellation was requested", async () => {
  const payload = JSON.stringify({
    format: "hypit.cli-cancel@1",
    requested: true,
    build: { id: BUILD_ID, work: { state: "working" }, result: { state: "missing" } },
  });
  await withCli(() => reply(payload), async (ctx, calls) => {
    const outcome = await cancelBuild(BUILD_ID, "cancel requested by caller", ctx);
    assert.equal(outcome.requested, true);
    assert.equal(outcome.observed, true);
    assert.equal(outcome.outcome, "running");
    assert.ok((calls[0] ?? []).includes("--reason"));
  });
});

test("cancel inside the submitting window reports an unobserved build rather than a stopped one", async () => {
  const payload = JSON.stringify({ format: "hypit.cli-cancel@1", requested: false, build: null });
  await withCli(() => reply(payload, 1), async (ctx) => {
    const outcome = await cancelBuild(BUILD_ID, "cancel requested by caller", ctx);
    assert.equal(outcome.requested, false);
    assert.equal(outcome.observed, false);
    assert.equal(outcome.outcome, "not_found");
  });
});

function getPayload(kind: string, path: string): string {
  return JSON.stringify({
    format: "hypit.cli-get@1",
    build: BUILD_ID,
    output: "final.video",
    type: "video",
    kind,
    path,
  });
}

test("get returns the output kind so a composite directory is not probed as a video", async () => {
  let destination = "";
  await withCli(() => reply(getPayload("composite", destination)), async (ctx, calls, dir) => {
    destination = join(dir, "final.mp4");
    const exported = await exportOutput(BUILD_ID, "final.video", destination, ctx);
    assert.equal(exported.kind, "composite");
    assert.equal(exported.directory, true);
    const argv = calls[0] ?? [];
    // Contract 17.2 and 17.6: `get` reads the Result repository and its allow-list rejects --runtime.
    assert.equal(argv.includes("--runtime"), false);
    assert.ok(argv.includes("--to"));
    assert.ok(argv.includes("--output"));
  });
});

test("a resource output is a file, and the export names it", async () => {
  let destination = "";
  await withCli(() => reply(getPayload("resource", destination)), async (ctx, _calls, dir) => {
    destination = join(dir, "final.mp4");
    const exported = await exportOutput(BUILD_ID, "final.video", destination, ctx);
    assert.equal(exported.directory, false);
    assert.equal(exported.output, "final.video");
    assert.equal(exported.path, destination);
  });
});

test("empty or unparseable stdout is a broken distribution, not a Hypit failure", async () => {
  await withCli(() => reply("", 1), async (ctx) => {
    await assert.rejects(getBuildStatus(BUILD_ID, ctx), (error: unknown) => {
      assert.ok(error instanceof AdapterError);
      assert.equal(error.code, "ADAPTER_DISTRIBUTION_BROKEN");
      return true;
    });
  });
  await withCli(() => ({ code: 1, stdout: "Error [ERR_MODULE_NOT_FOUND]", stderr: "", truncated: false }), async (ctx) => {
    await assert.rejects(getBuildStatus(BUILD_ID, ctx), (error: unknown) => {
      assert.ok(error instanceof AdapterError);
      assert.equal(error.code, "ADAPTER_DISTRIBUTION_BROKEN");
      return true;
    });
  });
});

test("an unexpected envelope format fails loudly instead of misparsing", async () => {
  await withCli(() => reply(JSON.stringify({ format: "hypit.cli-status@2", build: null })), async (ctx) => {
    await assert.rejects(getBuildStatus(BUILD_ID, ctx), (error: unknown) => {
      assert.ok(error instanceof AdapterError);
      assert.equal(error.code, "ADAPTER_FORMAT_UNEXPECTED");
      assert.ok(error.message.includes("hypit.cli-status@1"));
      return true;
    });
  });
});
