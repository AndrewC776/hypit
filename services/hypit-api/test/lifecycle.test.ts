import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { createArtifactId } from "@hypit/job-core";
import type { Artifact } from "@hypit/job-core";

import { CLOCK_BASE, countJobs, errorOf, postJson, preparedRunBody, withHarness } from "./harness.js";
import type { Harness } from "./harness.js";
import type { Environment } from "../src/index.js";

const PROJECT_PATH = join(tmpdir(), "hypit-api-projects", "demo");

const REGISTERED: Environment = { HYPIT_PROJECT_REGISTRY: JSON.stringify({ demo: PROJECT_PATH }) };

function at(offsetMs: number): string {
  return new Date(CLOCK_BASE + offsetMs).toISOString();
}

async function queueJob(harness: Harness): Promise<string> {
  const created = await harness.request("/v1/jobs", postJson(preparedRunBody()));
  assert.equal(created.status, 202);
  return String(created.body.job_id);
}

/** Drives a job to COMPLETED through the store: forward skips are legal, so two moves suffice. */
function completeJob(harness: Harness, jobId: string): Artifact {
  harness.store.recordTransition(jobId, "PUBLISHING", { now: at(1_000), reason: "stage_advanced", progress: 0.9 });
  harness.store.recordTransition(jobId, "COMPLETED", { now: at(2_000), reason: "completed", progress: 1 });
  const artifact: Artifact = {
    artifactId: createArtifactId({ now: () => CLOCK_BASE }),
    jobId,
    kind: "video",
    name: "final.mp4",
    uri: pathToFileURL(join(harness.directory, "jobs", jobId, "output", "final.mp4")).href,
    mediaType: "video/mp4",
    bytes: 75_314,
    checksumSha256: "a".repeat(64),
    width: 540,
    height: 960,
    durationSeconds: 8,
    fps: 30,
    createdAt: at(2_000),
  };
  harness.store.addArtifact(artifact);
  return artifact;
}

test("cancelling a queued job settles it, and cancelling it again changes nothing", async () => {
  await withHarness({ env: REGISTERED }, async (harness) => {
    const jobId = await queueJob(harness);
    const first = await harness.request(`/v1/jobs/${jobId}/cancel`, { method: "POST" });
    assert.equal(first.status, 202);
    assert.equal(first.body.cancelled, true);
    assert.equal(first.body.cancellation_requested, true);
    assert.equal(harness.store.readJob(jobId)?.state, "CANCELLED");

    const second = await harness.request(`/v1/jobs/${jobId}/cancel`, { method: "POST" });
    assert.equal(second.status, 202);
    // Terminal is immutable: the second request reports the flag, not a second cancellation.
    assert.equal(second.body.cancelled, false);
  });
});

test("cancelling a claimed job only records the request", async () => {
  await withHarness({ env: REGISTERED }, async (harness) => {
    const jobId = await queueJob(harness);
    const claimed = harness.store.claimNext("wkr_probe_101_0000000A", at(500));
    assert.equal(claimed?.jobId, jobId);

    const response = await harness.request(`/v1/jobs/${jobId}/cancel`, { method: "POST" });
    assert.equal(response.status, 202);
    assert.equal(response.body.cancellation_requested, true);
    // Nothing here can promise a remote operation already in flight actually stopped.
    assert.equal(response.body.cancelled, false);
    assert.equal(harness.store.readJob(jobId)?.state, "PREPARING_WORKSPACE");
  });
});

test("outputs answer with artifact metadata and a uri, never bytes", async () => {
  await withHarness({ env: REGISTERED }, async (harness) => {
    const jobId = await queueJob(harness);
    const artifact = completeJob(harness, jobId);
    const response = await harness.request(`/v1/jobs/${jobId}/outputs`);
    assert.equal(response.status, 200);
    assert.equal(response.body.state, "COMPLETED");
    const outputs = response.body.outputs;
    assert.ok(Array.isArray(outputs) && outputs.length === 1);
    assert.deepEqual(outputs[0], {
      artifact_id: artifact.artifactId,
      kind: "video",
      name: "final.mp4",
      uri: artifact.uri,
      media_type: "video/mp4",
      bytes: 75_314,
      checksum_sha256: artifact.checksumSha256,
      width: 540,
      height: 960,
      duration_seconds: 8,
      fps: 30,
      created_at: at(2_000),
    });
  });
});

test("a revision of a finished job creates a linked child", async () => {
  await withHarness({ env: REGISTERED }, async (harness) => {
    const parentId = await queueJob(harness);
    const artifact = completeJob(harness, parentId);
    const response = await harness.request(`/v1/jobs/${parentId}/revisions`,
      postJson(JSON.stringify({ instruction: "slow the last beat down", reuse: [artifact.artifactId] })));
    assert.equal(response.status, 202);
    assert.equal(response.body.parent_job_id, parentId);
    assert.equal(response.body.revision_no, 2);
    assert.equal(response.body.status, "QUEUED");

    const child = harness.store.readJob(String(response.body.job_id));
    assert.equal(child?.rootJobId, parentId);
    assert.equal(child?.parentJobId, parentId);
    assert.equal(child?.revisionNo, 2);
    assert.equal(child?.mode, "prepared_run");

    const revisions = harness.store.listRevisions(parentId);
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0]?.instruction, "slow the last beat down");
    assert.equal(revisions[0]?.reuseJson, JSON.stringify([artifact.artifactId]));
    assert.equal(countJobs(harness), 2);
  });
});

test("a revision request is refused while the parent is still running", async () => {
  await withHarness({ env: REGISTERED }, async (harness) => {
    const parentId = await queueJob(harness);
    const response = await harness.request(`/v1/jobs/${parentId}/revisions`,
      postJson(JSON.stringify({ instruction: "change the ending" })));
    assert.equal(response.status, 409);
    assert.equal(errorOf(response).code, "JOB_NOT_REVISABLE");
    assert.equal(countJobs(harness), 1);
  });
});

test("a revision rejects unknown fields and artifacts the parent does not own", async () => {
  await withHarness({ env: REGISTERED }, async (harness) => {
    const parentId = await queueJob(harness);
    completeJob(harness, parentId);

    const unknown = await harness.request(`/v1/jobs/${parentId}/revisions`,
      postJson(JSON.stringify({ instruction: "tighten it", priority: "high" })));
    assert.equal(unknown.status, 400);
    assert.equal(errorOf(unknown).code, "VALIDATION_FAILED");

    const foreign = createArtifactId({ now: () => CLOCK_BASE + 9_000 });
    const notOurs = await harness.request(`/v1/jobs/${parentId}/revisions`,
      postJson(JSON.stringify({ instruction: "tighten it", reuse: [foreign] })));
    assert.equal(notOurs.status, 404);
    assert.equal(errorOf(notOurs).code, "ARTIFACT_NOT_FOUND");

    const path = await harness.request(`/v1/jobs/${parentId}/revisions`,
      postJson(JSON.stringify({ instruction: "tighten it", reuse: ["../../etc/passwd"] })));
    assert.equal(path.status, 400);
    assert.equal(errorOf(path).code, "VALIDATION_FAILED");

    assert.equal(countJobs(harness), 1);
  });
});

test("a retried revision with the same idempotency key creates one child and one revision row", async () => {
  await withHarness({ env: REGISTERED }, async (harness) => {
    const parentId = await queueJob(harness);
    completeJob(harness, parentId);
    const body = JSON.stringify({ instruction: "swap the opening line" });
    const headers = { "idempotency-key": "mcp-revise-0001", "x-caller-id": "mcp-edge" };
    const first = await harness.request(`/v1/jobs/${parentId}/revisions`, postJson(body, headers));
    const second = await harness.request(`/v1/jobs/${parentId}/revisions`, postJson(body, headers));
    assert.equal(first.status, 202);
    assert.equal(second.status, 200);
    assert.equal(second.body.job_id, first.body.job_id);
    assert.equal(harness.store.listRevisions(parentId).length, 1);
    assert.equal(countJobs(harness), 2);
  });
});
