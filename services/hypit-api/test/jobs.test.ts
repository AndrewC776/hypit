import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MAX_INSTRUCTION_LENGTH } from "@hypit/job-core";

import {
  OUTPUT,
  cloneBody,
  countJobs,
  errorOf,
  postJson,
  preparedRunBody,
  recordingLookup,
  withHarness,
} from "./harness.js";
import type { Environment } from "../src/index.js";

/** Registered but never created: the API resolves no path, so the directory need not exist. */
const PROJECT_PATH = join(tmpdir(), "hypit-api-projects", "demo");

const REGISTERED: Environment = {
  HYPIT_PROJECT_REGISTRY: JSON.stringify({ demo: PROJECT_PATH }),
  HYPIT_REFERENCE_ALLOWLIST: "vt.tiktok.com,www.tiktok.com",
};

const REFERENCE = "https://vt.tiktok.com/ZS123456/";

test("creating a job answers 202 with a queued id and does not wait for a build", async () => {
  await withHarness({ env: REGISTERED }, async (harness) => {
    const startedAt = Date.now();
    const response = await harness.request("/v1/jobs", postJson(preparedRunBody()));
    const elapsedMs = Date.now() - startedAt;
    assert.equal(response.status, 202);
    assert.equal(response.body.status, "QUEUED");
    assert.equal(response.body.mode, "prepared_run");
    assert.match(String(response.body.job_id), /^vid_[0-9]{8}T[0-9]{9}Z_[0-9A-F]{8}$/u);
    assert.ok(response.requestId !== null, "every response carries x-request-id");
    // A create that waited for a Build would take minutes. This bound is loose on purpose: it is
    // asserting "did not submit anything", not measuring the server.
    assert.ok(elapsedMs < 1_000, `create took ${elapsedMs}ms`);
    const stored = harness.store.readJob(String(response.body.job_id));
    assert.equal(stored?.state, "QUEUED");
    assert.equal(stored?.claimedBy, null);
  });
});

test("the same idempotency key yields one job and one row", async () => {
  await withHarness({ env: REGISTERED }, async (harness) => {
    const headers = { "idempotency-key": "mcp-create-7f3a", "x-caller-id": "mcp-edge" };
    const first = await harness.request("/v1/jobs", postJson(preparedRunBody(), headers));
    const second = await harness.request("/v1/jobs", postJson(preparedRunBody(), headers));
    assert.equal(first.status, 202);
    // The replay created nothing, so it answers 200 rather than 202 — with the same id.
    assert.equal(second.status, 200);
    assert.equal(second.body.job_id, first.body.job_id);
    assert.equal(countJobs(harness), 1);
  });
});

test("an unknown top-level field is rejected", async () => {
  await withHarness({ env: REGISTERED }, async (harness) => {
    const body = JSON.stringify({
      mode: "prepared_run",
      project: "demo",
      run: "chat.svrun",
      output: OUTPUT,
      callback_url: "https://example.com/hook",
    });
    const response = await harness.request("/v1/jobs", postJson(body));
    assert.equal(response.status, 400);
    assert.equal(errorOf(response).code, "VALIDATION_FAILED");
    assert.match(String(errorOf(response).message), /callback_url/u);
    assert.equal(errorOf(response).request_id, response.requestId);
    assert.equal(countJobs(harness), 0);
  });
});

test("an instruction over the 20000 character cap is rejected", async () => {
  await withHarness({ env: REGISTERED }, async (harness) => {
    const instruction = "a".repeat(MAX_INSTRUCTION_LENGTH + 1);
    const response = await harness.request("/v1/jobs", postJson(cloneBody(REFERENCE, instruction)));
    assert.equal(response.status, 400);
    assert.equal(errorOf(response).code, "VALIDATION_FAILED");
    assert.match(String(errorOf(response).message), /instruction/u);
    assert.equal(countJobs(harness), 0);
    // The cap is a content rule, not a size rule: this body is far below the 256 KiB transport cap.
    assert.ok(instruction.length < harness.config.maxBodyBytes);
  });
});

test("a clone reference over plain http is refused", async () => {
  const resolver = recordingLookup(["203.0.113.7"]);
  await withHarness({ env: REGISTERED, dependencies: { lookup: resolver.lookup } }, async (harness) => {
    const response = await harness.request("/v1/jobs", postJson(cloneBody("http://vt.tiktok.com/ZS1/")));
    assert.equal(response.status, 400);
    assert.equal(errorOf(response).code, "VALIDATION_FAILED");
    assert.match(String(errorOf(response).message), /https/u);
    assert.deepEqual(resolver.calls, [], "a non-https url is refused before any name is resolved");
    assert.equal(countJobs(harness), 0);
  });
});

test("a clone reference whose host resolves to a private address is refused", async () => {
  const resolver = recordingLookup(["10.10.0.3"]);
  await withHarness({ env: REGISTERED, dependencies: { lookup: resolver.lookup } }, async (harness) => {
    const response = await harness.request("/v1/jobs", postJson(cloneBody(REFERENCE)));
    assert.equal(response.status, 400);
    assert.equal(errorOf(response).code, "REFERENCE_URL_BLOCKED");
    assert.match(String(errorOf(response).message), /10\.0\.0\.0\/8/u);
    assert.deepEqual(resolver.calls, ["vt.tiktok.com"]);
    assert.equal(countJobs(harness), 0);
  });
});

test("a clone reference host outside the allow-list is refused before any name is resolved", async () => {
  const resolver = recordingLookup(["203.0.113.7"]);
  await withHarness({ env: REGISTERED, dependencies: { lookup: resolver.lookup } }, async (harness) => {
    const response = await harness.request("/v1/jobs",
      postJson(cloneBody("https://reference.example.com/video/1")));
    assert.equal(response.status, 400);
    assert.equal(errorOf(response).code, "REFERENCE_URL_BLOCKED");
    assert.match(String(errorOf(response).message), /allow-list/u);
    assert.deepEqual(resolver.calls, [], "an unlisted host must not even be resolved");
    assert.equal(countJobs(harness), 0);
  });
});

test("an allow-listed reference that resolves publicly is accepted", async () => {
  const resolver = recordingLookup(["203.0.113.7", "2606:4700:4700::1111"]);
  await withHarness({ env: REGISTERED, dependencies: { lookup: resolver.lookup } }, async (harness) => {
    const response = await harness.request("/v1/jobs", postJson(cloneBody(REFERENCE)));
    assert.equal(response.status, 202);
    assert.equal(response.body.mode, "clone");
    assert.equal(countJobs(harness), 1);
  });
});

test("prepared_run refuses a project that is a path and a run that leaves the project", async () => {
  await withHarness({ env: REGISTERED }, async (harness) => {
    const projects = [PROJECT_PATH, "../demo", "demo/../../etc", "C:\\projects\\demo"];
    for (const project of projects) {
      const response = await harness.request("/v1/jobs", postJson(preparedRunBody(project)));
      assert.equal(response.status, 400, project);
      assert.equal(errorOf(response).code, "VALIDATION_FAILED", project);
    }
    const runs = ["../chat.svrun", "../../etc/passwd", "sub/chat.svrun", "sub\\chat.svrun", "chat.txt"];
    for (const run of runs) {
      const response = await harness.request("/v1/jobs", postJson(preparedRunBody("demo", run)));
      assert.equal(response.status, 400, run);
      assert.equal(errorOf(response).code, "VALIDATION_FAILED", run);
    }
    assert.equal(countJobs(harness), 0);
  });
});

test("a well-formed project key that nobody registered is refused", async () => {
  await withHarness({ env: REGISTERED }, async (harness) => {
    const response = await harness.request("/v1/jobs", postJson(preparedRunBody("not-registered")));
    assert.equal(response.status, 400);
    assert.equal(errorOf(response).code, "PROJECT_NOT_REGISTERED");
    assert.equal(countJobs(harness), 0);
  });
});

test("an unknown job id answers a structured 404", async () => {
  await withHarness({ env: REGISTERED }, async (harness) => {
    const missing = "vid_20260917T110000000Z_0000BEEF";
    for (const path of [`/v1/jobs/${missing}`, `/v1/jobs/${missing}/logs`, `/v1/jobs/${missing}/outputs`]) {
      const response = await harness.request(path);
      assert.equal(response.status, 404, path);
      const error = errorOf(response);
      assert.equal(error.code, "JOB_NOT_FOUND", path);
      assert.equal(error.request_id, response.requestId, path);
      assert.match(String(error.message), /does not exist/u);
    }
    // A malformed id is the caller's typo, not a missing job, and says so.
    const malformed = await harness.request("/v1/jobs/not-a-job-id");
    assert.equal(malformed.status, 400);
    assert.equal(errorOf(malformed).code, "JOB_ID_INVALID");
  });
});
