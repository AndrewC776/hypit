import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_INSTRUCTION_LENGTH,
  OUTPUT_FPS,
  OUTPUT_HEIGHTS,
  OUTPUT_WIDTHS,
  isProjectKey,
  isRunSourceName,
  validateJobRequest,
} from "../src/index.js";
import type { RequestIssue, RequestIssueCode } from "../src/index.js";

const OUTPUT = { width: 540, height: 960, fps: 30 } as const;

function preparedRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { mode: "prepared_run", project: "semantic-composition", run: "chat.svrun", output: { ...OUTPUT }, ...overrides };
}

function clone(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: "clone",
    reference: { type: "url", url: "https://www.tiktok.com/@someone/video/123" },
    instruction: "make it shorter",
    assets: [],
    output: { ...OUTPUT },
    ...overrides,
  };
}

function issuesOf(input: unknown): readonly RequestIssue[] {
  const result = validateJobRequest(input);
  assert.equal(result.ok, false, `expected ${JSON.stringify(input)} to be rejected`);
  return result.ok ? [] : result.issues;
}

function rejects(input: unknown, path: string, code?: RequestIssueCode): void {
  const issues = issuesOf(input);
  const match = issues.find((issue) => issue.path === path && (code === undefined || issue.code === code));
  assert.ok(match !== undefined,
    `expected an issue at ${path}${code === undefined ? "" : ` (${code})`}, got ${JSON.stringify(issues)}`);
}

test("a well-formed prepared_run request is accepted verbatim", () => {
  const result = validateJobRequest(preparedRun());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value, {
    mode: "prepared_run",
    project: "semantic-composition",
    run: "chat.svrun",
    output: { width: 540, height: 960, fps: 30 },
  });
});

test("a well-formed clone request is accepted, constraints and roles included", () => {
  const result = validateJobRequest(clone({
    assets: [{ assetId: "asset-1" }, { assetId: "asset-2", role: "logo" }],
    constraints: { maxDurationSeconds: 30, language: "zh-CN", spendingAuthorized: false },
  }));
  assert.equal(result.ok, true);
  if (!result.ok || result.value.mode !== "clone") return assert.fail("expected a clone request");
  assert.equal(result.value.instruction, "make it shorter");
  assert.deepEqual([...result.value.assets], [{ assetId: "asset-1" }, { assetId: "asset-2", role: "logo" }]);
  assert.equal(result.value.constraints?.spendingAuthorized, false);
});

test("an absent optional field is absent, never present holding undefined", () => {
  const result = validateJobRequest(clone({ assets: [{ assetId: "a1" }] }));
  assert.equal(result.ok, true);
  if (!result.ok || result.value.mode !== "clone") return assert.fail("expected a clone request");
  assert.ok(!("constraints" in result.value));
  assert.ok(!("role" in (result.value.assets[0] ?? {})));
});

test("instruction is capped at twenty thousand characters", () => {
  assert.equal(MAX_INSTRUCTION_LENGTH, 20_000);
  const atLimit = validateJobRequest(clone({ instruction: "x".repeat(MAX_INSTRUCTION_LENGTH) }));
  assert.equal(atLimit.ok, true);
  rejects(clone({ instruction: "x".repeat(MAX_INSTRUCTION_LENGTH + 1) }), "instruction", "TOO_LONG");
  rejects(clone({ instruction: "   " }), "instruction", "INVALID_VALUE");
  rejects(clone({ instruction: 42 }), "instruction", "INVALID_TYPE");
});

test("an unknown top-level field is rejected rather than ignored", () => {
  rejects(preparedRun({ callback: "https://example.invalid" }), "callback", "UNKNOWN_FIELD");
  rejects(preparedRun({ workspace: "/etc" }), "workspace", "UNKNOWN_FIELD");
  rejects(clone({ webhook: 1 }), "webhook", "UNKNOWN_FIELD");
  rejects(clone({ constraints: { budget: 100 } }), "constraints.budget", "UNKNOWN_FIELD");
  rejects(preparedRun({ output: { ...OUTPUT, bitrate: 1 } }), "output.bitrate", "UNKNOWN_FIELD");
});

test("the output spec admits only the allowed width, height and fps values", () => {
  for (const width of OUTPUT_WIDTHS) {
    assert.equal(validateJobRequest(preparedRun({ output: { ...OUTPUT, width } })).ok, true);
  }
  for (const height of OUTPUT_HEIGHTS) {
    assert.equal(validateJobRequest(preparedRun({ output: { ...OUTPUT, height } })).ok, true);
  }
  for (const fps of OUTPUT_FPS) {
    assert.equal(validateJobRequest(preparedRun({ output: { ...OUTPUT, fps } })).ok, true);
  }
  for (const width of [1081, 1920, 0, -540, 540.5]) {
    rejects(preparedRun({ output: { ...OUTPUT, width } }), "output.width", "INVALID_VALUE");
  }
  for (const height of [1921, 1080, 0]) {
    rejects(preparedRun({ output: { ...OUTPUT, height } }), "output.height", "INVALID_VALUE");
  }
  for (const fps of [29, 120, 0]) {
    rejects(preparedRun({ output: { ...OUTPUT, fps } }), "output.fps", "INVALID_VALUE");
  }
  rejects(preparedRun({ output: { ...OUTPUT, fps: "30" } }), "output.fps", "INVALID_TYPE");
  rejects(preparedRun({ output: "540x960" }), "output", "INVALID_TYPE");
  rejects(preparedRun({ output: undefined }), "output", "REQUIRED");
});

test("project is a registry key, so no request can name a filesystem path", () => {
  for (const key of ["a", "semantic-composition", "x9", "0abc", "a".repeat(64)]) {
    assert.ok(isProjectKey(key), `${key} should be a key`);
  }
  for (const key of [
    "../etc",
    "/etc/passwd",
    "..",
    ".",
    "Semantic-Composition",
    "semantic_composition",
    "-leading",
    "",
    "a".repeat(65),
    "a b",
    "a/b",
    "a\\b",
    "~root",
  ]) {
    assert.ok(!isProjectKey(key), `${key} should not be a key`);
    rejects(preparedRun({ project: key }), "project");
  }
  rejects(preparedRun({ project: 7 }), "project", "INVALID_TYPE");
});

test("run is a plain .svrun file name inside the project", () => {
  assert.ok(isRunSourceName("chat.svrun"));
  assert.ok(isRunSourceName("a_b-c.2.svrun"));
  for (const run of [
    "../chat.svrun",
    "..\\chat.svrun",
    "sub/chat.svrun",
    "sub\\chat.svrun",
    "/abs/chat.svrun",
    "chat.svml",
    "chat.txt",
    "chat",
    ".svrun",
    "-chat.svrun",
    "chat.svrun.exe",
    "",
  ]) {
    assert.ok(!isRunSourceName(run), `${run} should not be a run source name`);
    rejects(preparedRun({ run }), "run");
  }
});

test("mode decides the shape, and an unknown mode is named as such", () => {
  rejects({ output: { ...OUTPUT } }, "mode", "REQUIRED");
  rejects({ mode: "PREPARED_RUN", output: { ...OUTPUT } }, "mode", "INVALID_VALUE");
  rejects({ mode: "shell", run: "x" }, "mode", "INVALID_VALUE");
  // A clone field on a prepared_run body is an unknown field, not a silently ignored one.
  rejects(preparedRun({ instruction: "hi" }), "instruction", "UNKNOWN_FIELD");
});

test("a clone reference must be an https url or an asset id", () => {
  rejects(clone({ reference: { type: "url", url: "http://www.tiktok.com/x" } }), "reference.url", "INVALID_VALUE");
  rejects(clone({ reference: { type: "url", url: "file:///etc/passwd" } }), "reference.url", "INVALID_VALUE");
  rejects(clone({ reference: { type: "url", url: "not a url" } }), "reference.url", "INVALID_VALUE");
  rejects(clone({ reference: { type: "file", path: "/etc/passwd" } }), "reference.type", "INVALID_VALUE");
  rejects(clone({ reference: { type: "asset", assetId: "../secret" } }), "reference.assetId", "INVALID_VALUE");
  rejects(clone({ reference: undefined }), "reference", "REQUIRED");
  const asset = validateJobRequest(clone({ reference: { type: "asset", assetId: "asset-1" } }));
  assert.equal(asset.ok, true);
});

test("hostile input returns issues and never throws", () => {
  for (const input of [
    undefined,
    null,
    42,
    "prepared_run",
    [],
    [{ mode: "prepared_run" }],
    () => undefined,
    JSON.parse('{"mode":"prepared_run","__proto__":{"polluted":true}}'),
    { mode: "clone", assets: [null, 1, "x"], instruction: "hi", output: { ...OUTPUT }, reference: { type: "asset", assetId: "a" } },
    { mode: "clone", assets: {}, instruction: "hi", output: { ...OUTPUT }, reference: { type: "asset", assetId: "a" } },
  ]) {
    assert.doesNotThrow(() => validateJobRequest(input));
    assert.ok(issuesOf(input).length > 0, `expected issues for ${JSON.stringify(input)}`);
  }
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("every issue carries a stable machine code and a field path", () => {
  const issues = issuesOf({ mode: "prepared_run", project: "../etc", run: "x", output: { width: 1, height: 2, fps: 3 } });
  assert.ok(issues.length >= 4);
  for (const issue of issues) {
    assert.equal(typeof issue.path, "string");
    assert.equal(typeof issue.message, "string");
    assert.ok(["INVALID_TYPE", "INVALID_VALUE", "REQUIRED", "TOO_LONG", "TOO_MANY", "UNKNOWN_FIELD"]
      .includes(issue.code), issue.code);
  }
});
