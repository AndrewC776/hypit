import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AdapterArgumentError,
  COMMAND_OPTIONS,
  buildArgv,
  cancelBuild,
  checkSource,
  exportOutput,
  getBuildLogs,
  getBuildStatus,
  planRun,
  submitBuild,
} from "../src/index.js";
import type { HypitContext, ProcessRunner } from "../src/index.js";

/**
 * Contract 6's injection table. Each payload must be rejected wherever it is passed — as an output
 * name, a run source, a reason, a Build id or a path — and the assertion that matters is not only
 * "it threw" but "no process was started": the recorder below must stay empty.
 */
const PAYLOADS: readonly string[] = [
  ";",
  "&&",
  "|",
  "$( )",
  "`id`",
  "line\nbreak",
  "rm -rf /",
  "../../../etc/passwd",
  "/etc/passwd",
  "~/.ssh/id_ed25519",
  "$(whoami)",
  "|tee /tmp/pwn",
  "--runtime=/etc/shadow",
];

const VALID_BUILD_ID = "bld_20260917T121134939Z_1850BA006E";

type Harness = {
  readonly ctx: HypitContext;
  readonly calls: string[][];
  readonly dir: string;
};

async function withAdapter(body: (harness: Harness) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hypit-adapter-argv-"));
  try {
    const calls: string[][] = [];
    const run: ProcessRunner = (_executable, argv) => {
      calls.push([...argv]);
      return Promise.reject(new Error("the adapter must not reach a process beyond this point"));
    };
    const ctx: HypitContext = {
      executable: join(dir, "bin", "hypit"),
      workspace: join(dir, "project"),
      runtimeProfile: join(dir, "hypit.runtime.json"),
      env: {},
      allowedRoots: [dir],
      run,
    };
    await body({ ctx, calls, dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("the recorder would catch a spawn, so an empty recording means something", async () => {
  await withAdapter(async ({ ctx, calls }) => {
    await assert.rejects(getBuildStatus(VALID_BUILD_ID, ctx));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.[0], "status");
  });
});

test("every entry point reaches a process when its arguments are valid", async () => {
  // The positive control for the rejection test below: without it, a context that was itself
  // invalid would make every rejection pass for the wrong reason.
  await withAdapter(async ({ ctx, calls, dir }) => {
    const attempts: readonly (() => Promise<unknown>)[] = [
      () => checkSource("chat.svml", ctx),
      () => planRun("chat.svrun", ctx),
      () => submitBuild("chat.svrun", ctx),
      () => getBuildStatus(VALID_BUILD_ID, ctx),
      () => getBuildLogs(VALID_BUILD_ID, 50, ctx),
      () => cancelBuild(VALID_BUILD_ID, "cancel requested by caller", ctx),
      () => exportOutput(VALID_BUILD_ID, "final.video", join(dir, "final.mp4"), ctx),
    ];
    for (const attempt of attempts) await assert.rejects(attempt, /must not reach a process/u);
    assert.deepEqual(calls.map((argv) => argv[0]),
      ["check", "plan", "build", "status", "logs", "cancel", "get"]);
  });
});

test("every injection payload is rejected before any process is spawned", async () => {
  await withAdapter(async ({ ctx, calls }) => {
    for (const payload of PAYLOADS) {
      const attempts: readonly (readonly [string, () => Promise<unknown>])[] = [
        ["checkSource", () => checkSource(payload, ctx)],
        ["planRun", () => planRun(payload, ctx)],
        ["submitBuild", () => submitBuild(payload, ctx)],
        ["getBuildStatus", () => getBuildStatus(payload, ctx)],
        ["getBuildLogs", () => getBuildLogs(payload, 50, ctx)],
        ["cancelBuild buildId", () => cancelBuild(payload, "cancel requested by caller", ctx)],
        ["cancelBuild reason", () => cancelBuild(VALID_BUILD_ID, payload, ctx)],
        ["exportOutput output", () => exportOutput(VALID_BUILD_ID, payload, join(ctx.workspace, "final.mp4"), ctx)],
        ["exportOutput to", () => exportOutput(VALID_BUILD_ID, "final.video", payload, ctx)],
      ];
      for (const [where, attempt] of attempts) {
        await assert.rejects(attempt, AdapterArgumentError, `${where} accepted ${JSON.stringify(payload)}`);
      }
    }
    assert.deepEqual(calls, [], "a rejected argument reached a process");
  });
});

test("a rejected argument is classified VALIDATION_FAILED and is not retryable", async () => {
  await withAdapter(async ({ ctx }) => {
    await assert.rejects(checkSource("../escape.svml", ctx), (error: unknown) => {
      assert.ok(error instanceof AdapterArgumentError);
      assert.equal(error.errorClass, "VALIDATION_FAILED");
      assert.equal(error.retryable, false);
      assert.equal(error.argument, "source");
      return true;
    });
  });
});

test("a path outside the allowed root is rejected even when absolute and normalised", async () => {
  await withAdapter(async ({ ctx, calls }) => {
    const outside = await mkdtemp(join(tmpdir(), "hypit-adapter-outside-"));
    try {
      await assert.rejects(
        exportOutput(VALID_BUILD_ID, "final.video", join(outside, "final.mp4"), ctx),
        AdapterArgumentError,
      );
      assert.deepEqual(calls, []);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("a Build id is validated with the repo's own helper, not a second regex", async () => {
  await withAdapter(async ({ ctx, calls }) => {
    // Nine nonce characters instead of ten: well-formed enough to fool a hand-written pattern.
    await assert.rejects(getBuildStatus("bld_20260917T121134939Z_1850BA006", ctx), AdapterArgumentError);
    // A timestamp that does not round-trip is not an ordered Build id either.
    await assert.rejects(getBuildStatus("bld_20261317T121134939Z_1850BA006E", ctx), AdapterArgumentError);
    assert.deepEqual(calls, []);
  });
});

test("a log line count outside 1..1000 is rejected before the spawn", async () => {
  await withAdapter(async ({ ctx, calls }) => {
    await assert.rejects(getBuildLogs(VALID_BUILD_ID, 0, ctx), AdapterArgumentError);
    await assert.rejects(getBuildLogs(VALID_BUILD_ID, 1001, ctx), AdapterArgumentError);
    await assert.rejects(getBuildLogs(VALID_BUILD_ID, 12.5, ctx), AdapterArgumentError);
    assert.deepEqual(calls, []);
  });
});

test("an existing destination is refused before the spawn, because hypit get will not overwrite", async () => {
  await withAdapter(async ({ ctx, calls, dir }) => {
    const destination = join(dir, "final.mp4");
    await writeFile(destination, "already here");
    await assert.rejects(exportOutput(VALID_BUILD_ID, "final.video", destination, ctx), (error: unknown) => {
      assert.ok(error instanceof AdapterArgumentError);
      assert.equal(error.code, "ADAPTER_DESTINATION_EXISTS");
      return true;
    });
    assert.deepEqual(calls, []);
  });
});

test("--runtime is a usage error on check and on get", () => {
  assert.equal(COMMAND_OPTIONS.get("check")?.includes("--runtime"), false);
  assert.equal(COMMAND_OPTIONS.get("get")?.includes("--runtime"), false);
  assert.equal(COMMAND_OPTIONS.get("status")?.includes("--runtime"), true);
  for (const command of ["check", "get"] as const) {
    assert.throws(
      () => buildArgv(command, [], [{ name: "--runtime", value: "/profile.json" }]),
      (error: unknown) => {
        assert.ok(error instanceof AdapterArgumentError);
        assert.equal(error.code, "ADAPTER_OPTION_NOT_ALLOWED");
        return true;
      },
    );
  }
});

test("the argv builder honours the CLI's own syntax rules", () => {
  const argv = buildArgv("status", ["bld_20260917T121134939Z_1850BA006E"], [
    { name: "--json" },
    { name: "--workspace", value: "/tmp/project" },
  ]);
  // Two elements per option: the CLI has no --opt=value form.
  assert.deepEqual(argv, ["status", "bld_20260917T121134939Z_1850BA006E", "--json", "--workspace", "/tmp/project"]);
  assert.throws(() => buildArgv("status", [], [{ name: "--workspace=/tmp" }]), AdapterArgumentError);
  assert.throws(
    () => buildArgv("status", [], [{ name: "--workspace", value: "/a" }, { name: "--workspace", value: "/b" }]),
    AdapterArgumentError,
  );
  // An option value beginning with a dash is read by the CLI as a missing value.
  assert.throws(() => buildArgv("cancel", [], [{ name: "--reason", value: "--runtime" }]), AdapterArgumentError);
  // A repeatable option may appear twice.
  assert.deepEqual(buildArgv("build", [], [{ name: "--asset-root", value: "/a" }, { name: "--asset-root", value: "/b" }]),
    ["build", "--asset-root", "/a", "--asset-root", "/b"]);
});
