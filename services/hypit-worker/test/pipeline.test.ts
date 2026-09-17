import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { FINAL_VIDEO_NAME, QC_REPORT_NAME, jobPaths } from "../src/index.js";
import { BUILD_ID, EXPORTED_BYTES, videoProbe } from "./fake-hypit.js";
import { createHarness, eventTrace } from "./fixture.js";

test("a prepared_run job runs from QUEUED to COMPLETED and records every state change once", async () => {
  const harness = await createHarness();
  try {
    const queued = harness.queue();
    const terminal = await harness.loop.runOnce();

    assert.equal(terminal?.jobId, queued.jobId);
    assert.equal(terminal?.state, "COMPLETED");
    assert.equal(terminal?.progress, 1);
    assert.equal(terminal?.hypitBuildId, BUILD_ID);
    assert.equal(terminal?.errorCode, null);
    assert.notEqual(terminal?.terminalAt, null);

    // The whole history, in order. BUILDING is entered under the submit marker, which is written
    // before anything is spawned, and RENDERING begins when the Build first reports progress.
    assert.deepEqual(eventTrace(harness.events(queued.jobId)), [
      "-->QUEUED created",
      "QUEUED->PREPARING_WORKSPACE claimed",
      "PREPARING_WORKSPACE->VALIDATING stage_advanced",
      "VALIDATING->PLANNING stage_advanced",
      "PLANNING->BUILDING build_submit_marker",
      "BUILDING->RENDERING build_rendering",
      "RENDERING->QUALITY_CHECK stage_advanced",
      "QUALITY_CHECK->PUBLISHING stage_advanced",
      "PUBLISHING->COMPLETED completed",
    ]);

    // Exactly one Build, submitted once.
    assert.equal(harness.hypit.calls.submit, 1);
    assert.deepEqual(harness.hypit.submitted, [BUILD_ID]);

    const artifacts = harness.store.listArtifacts(queued.jobId);
    assert.deepEqual(artifacts.map((artifact) => artifact.kind), ["qc_report", "video"]);
    const video = artifacts[1];
    assert.equal(video?.name, FINAL_VIDEO_NAME);
    assert.equal(video?.bytes, EXPORTED_BYTES);
    assert.equal(video?.mediaType, "video/mp4");
    assert.equal(video?.width, 540);
    assert.equal(video?.height, 960);
    assert.equal(video?.fps, 30);
    assert.equal(video?.durationSeconds, 8);
    assert.equal(video?.checksumSha256.length, 64);
    // Metadata plus a URI, never bytes (contract 11).
    assert.equal(video?.uri.startsWith("file:"), true);

    const paths = jobPaths(harness.config.jobsRoot, queued.jobId);
    assert.equal((await stat(join(paths.output, FINAL_VIDEO_NAME))).size, EXPORTED_BYTES);
  } finally {
    await harness.close();
  }
});

test("a job whose output fails the quality gate fails with QC_FAILED and keeps the report", async () => {
  const harness = await createHarness();
  try {
    // The Build exits 0 and exports a real file; it is simply not the video that was ordered.
    harness.hypit.probe = videoProbe({ width: 1080, height: 1920 });
    const queued = harness.queue();
    const terminal = await harness.loop.runOnce();

    assert.equal(terminal?.state, "FAILED");
    assert.equal(terminal?.errorCode, "QC_FAILED");
    assert.equal(terminal?.retryable, false);
    assert.match(terminal?.errorMessage ?? "", /dimensions/u);

    const trace = eventTrace(harness.events(queued.jobId));
    assert.equal(trace.includes("PUBLISHING->COMPLETED completed"), false);
    assert.equal(trace.at(-1), "QUALITY_CHECK->FAILED failed");

    // The evidence of which check failed outlives the failure, as a qc_report artifact.
    const artifacts = harness.store.listArtifacts(queued.jobId);
    assert.deepEqual(artifacts.map((artifact) => artifact.kind), ["qc_report"]);
    const paths = jobPaths(harness.config.jobsRoot, queued.jobId);
    const report = JSON.parse(await readFile(join(paths.logs, QC_REPORT_NAME), "utf8")) as {
      readonly report: { readonly ok: boolean; readonly failed: string | null };
    };
    assert.equal(report.report.ok, false);
    assert.equal(report.report.failed, "dimensions");
  } finally {
    await harness.close();
  }
});

test("a build that reports complete without a usable file never reaches COMPLETED", async () => {
  const harness = await createHarness();
  try {
    // "Build exited 0" is never sufficient: the file on disk is what decides (contract 9).
    harness.hypit.probe = videoProbe({ ok: false, error: "ffprobe exited 1", hasVideoStream: false });
    harness.queue();
    const terminal = await harness.loop.runOnce();

    assert.equal(terminal?.state, "FAILED");
    assert.equal(terminal?.errorCode, "QC_FAILED");
  } finally {
    await harness.close();
  }
});
