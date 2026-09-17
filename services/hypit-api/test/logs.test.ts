import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { jobError } from "@hypit/job-core";

import { CLOCK_BASE, errorOf, postJson, preparedRunBody, withHarness } from "./harness.js";
import type { Harness } from "./harness.js";
import type { Environment } from "../src/index.js";

const PROJECT_PATH = join(tmpdir(), "hypit-api-projects", "demo");

const REGISTERED: Environment = { HYPIT_PROJECT_REGISTRY: JSON.stringify({ demo: PROJECT_PATH }) };

/** The shape of a real exposure on this host: a live key sitting in a `KEY=value` line. */
const SECRET = "sk-proj-0123456789abcdefghijklmn";

/**
 * A Hypit execution-log record embeds its command as a URL-encoded absolute path — the leak the
 * contract calls TRAP 3. Reproduced here so the test proves the encoded form is caught too, not just
 * the literal one.
 */
function failedJob(harness: Harness, jobId: string): { readonly workspace: string } {
  const workspace = join(harness.directory, "jobs", jobId);
  const runSource = join(PROJECT_PATH, "chat.svrun");
  harness.store.recordTransition(jobId, "PREPARING_WORKSPACE", {
    now: new Date(CLOCK_BASE + 1_000).toISOString(),
    reason: "claimed",
    workspacePath: workspace,
  });
  harness.store.recordTransition(jobId, "FAILED", {
    now: new Date(CLOCK_BASE + 2_000).toISOString(),
    reason: "failed",
    error: jobError({
      class: "HYPIT_BUILD_FAILED",
      code: "EXECUTION_FAILED",
      message: `build of ${runSource} failed in ${workspace}`
        + ` with OPENAI_API_KEY=${SECRET}`
        + ` command=need:need:author%3A${encodeURIComponent(runSource)}`,
    }),
  });
  return { workspace };
}

async function queueJob(harness: Harness): Promise<string> {
  const created = await harness.request("/v1/jobs", postJson(preparedRunBody()));
  assert.equal(created.status, 202);
  return String(created.body.job_id);
}

test("log lines are redacted and their absolute paths relativized", async () => {
  await withHarness({ env: REGISTERED }, async (harness) => {
    const jobId = await queueJob(harness);
    const { workspace } = failedJob(harness, jobId);
    const response = await harness.request(`/v1/jobs/${jobId}/logs`);
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body.lines), "logs answer with an array of lines");
    const text = JSON.stringify(response.body.lines);

    assert.ok(!text.includes(SECRET), "the api key must not survive");
    assert.ok(!text.includes("sk-proj-"), "not even the prefix of the key survives");
    assert.match(text, /REDACTED/u);

    assert.ok(!text.includes(PROJECT_PATH), "the registered project path must not leak");
    assert.ok(!text.includes(workspace), "the job workspace path must not leak");
    assert.ok(!text.includes(encodeURIComponent(PROJECT_PATH)),
      "the url-encoded form of the path must not leak either");
    assert.match(text, /<project:demo>/u);
    assert.match(text, /<workspace>/u);
    // The history itself is still legible: this is a sanitiser, not a shredder.
    assert.match(text, /PREPARING_WORKSPACE->FAILED/u);
    assert.match(text, /EXECUTION_FAILED/u);
  });
});

test("a job's error summary is sanitized the same way its logs are", async () => {
  await withHarness({ env: REGISTERED }, async (harness) => {
    const jobId = await queueJob(harness);
    failedJob(harness, jobId);
    const response = await harness.request(`/v1/jobs/${jobId}`);
    assert.equal(response.status, 200);
    const error = JSON.stringify(response.body.error);
    assert.equal(response.body.state, "FAILED");
    assert.ok(!error.includes(SECRET));
    assert.ok(!error.includes(PROJECT_PATH));
    assert.match(error, /EXECUTION_FAILED/u);
  });
});

test("whatever an injected log reader returns is sanitized on the way out", async () => {
  const leaky = [
    "authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.Zm9vYmFyYmF6",
    "cloudflared tunnel run --token eyJhIjoiMDEyMzQ1Njc4OWFiY2RlZiIsInQiOiJ4In0",
    "GET https://media.local/asset?token=9f8e7d6c5b4a3210 200",
  ];
  await withHarness({
    env: REGISTERED,
    dependencies: { readLogs: () => leaky },
  }, async (harness) => {
    const jobId = await queueJob(harness);
    const response = await harness.request(`/v1/jobs/${jobId}/logs`);
    assert.equal(response.status, 200);
    const text = JSON.stringify(response.body.lines);
    assert.ok(!text.includes("eyJhbGciOiJIUzI1NiJ9"), "a JWT must not survive");
    assert.ok(!text.includes("eyJhIjoiMDEyMzQ1Njc4OWFiY2RlZiI"), "a tunnel token must not survive");
    assert.ok(!text.includes("9f8e7d6c5b4a3210"), "a signed query parameter must not survive");
  });
});

test("the log tail is bounded and defaults to the last hundred lines", async () => {
  const lines = Array.from({ length: 250 }, (_, index) => `line ${index}`);
  await withHarness({
    env: REGISTERED,
    dependencies: { readLogs: (_job, tail) => lines.slice(-tail) },
  }, async (harness) => {
    const jobId = await queueJob(harness);

    const byDefault = await harness.request(`/v1/jobs/${jobId}/logs`);
    assert.equal(byDefault.body.tail, 100);
    assert.equal(JSON.parse(JSON.stringify(byDefault.body.lines)).length, 100);

    const explicit = await harness.request(`/v1/jobs/${jobId}/logs?tail=5`);
    assert.equal(explicit.body.tail, 5);

    for (const tail of ["0", "1001", "-1", "all", "1e3"]) {
      const refused = await harness.request(`/v1/jobs/${jobId}/logs?tail=${tail}`);
      assert.equal(refused.status, 400, tail);
      assert.equal(errorOf(refused).code, "TAIL_INVALID", tail);
    }
  });
});
