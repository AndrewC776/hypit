/**
 * QUALITY_CHECK. The gate that decides whether a job may be called COMPLETED.
 *
 * "The Build exited 0" is never sufficient (contract 9), so this stage measures the file that was
 * actually exported and asks the Build again whether its Result is complete. The report is written
 * and published BEFORE the verdict is raised: a failed gate must leave behind the evidence of which
 * check failed, and an exception thrown first would take that evidence with it.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { evaluateQuality } from "@hypit/hypit-adapter";
import type { Job } from "@hypit/job-core";

import { FINAL_VIDEO_NAME } from "../config.js";
import { WORKER_CODES, WorkerError } from "../errors.js";
import type { StageContext, StageOutcome } from "../stage.js";

export const QC_REPORT_NAME = "qc-report.json";

export async function runQualityCheck(job: Job, ctx: StageContext): Promise<StageOutcome> {
  const buildId = ctx.currentJob().hypitBuildId;
  const status = buildId === null ? null : await ctx.hypit.getBuildStatus(buildId, ctx.hypitContext);
  const buildComplete = status?.outcome === "complete";
  ctx.notes.buildComplete = buildComplete;
  const path = ctx.notes.exportedPath ?? join(ctx.paths.output, FINAL_VIDEO_NAME);
  const probe = await ctx.hypit.probeVideo(path, ctx.ffprobeContext);
  ctx.notes.probe = probe;
  const report = evaluateQuality(probe, {
    width: ctx.request.output.width,
    height: ctx.request.output.height,
    fps: ctx.request.output.fps,
    buildComplete,
  });
  const reportPath = join(ctx.paths.logs, QC_REPORT_NAME);
  await writeFile(reportPath, `${JSON.stringify({ jobId: job.jobId, buildId, probe, report }, null, 2)}\n`, "utf8");
  ctx.store.addArtifact(await ctx.publisher.publish({
    jobId: job.jobId,
    localPath: reportPath,
    kind: "qc_report",
    name: QC_REPORT_NAME,
  }));
  if (!report.ok) {
    throw new WorkerError({
      class: "QC_FAILED",
      code: WORKER_CODES.qcFailed,
      message: `the quality gate failed at ${report.failed ?? "an unnamed check"}`,
      ...(buildId === null ? {} : { receipt: buildId }),
    });
  }
  return { detail: { qc: report.checks.map((entry) => ({ name: entry.name, ok: entry.ok })) } };
}
