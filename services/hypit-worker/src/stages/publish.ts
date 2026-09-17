/**
 * PUBLISHING. Records what the job produced.
 *
 * The publisher returns metadata plus a URI and never bytes (contract 11), and the media numbers
 * come from the probe the quality gate already took rather than from a second measurement: two
 * measurements of one file are two chances to disagree about what was delivered.
 */
import { join } from "node:path";

import type { ArtifactMedia, Job } from "@hypit/job-core";
import type { VideoProbe } from "@hypit/hypit-adapter";

import { FINAL_VIDEO_NAME } from "../config.js";
import type { StageContext, StageOutcome } from "../stage.js";

/**
 * Conditional spread throughout: `exactOptionalPropertyTypes` refuses undefined for an optional
 * property, and a dimension ffprobe could not read is absent rather than zero.
 */
function mediaOf(probe: VideoProbe | null): ArtifactMedia {
  if (probe === null) return {};
  return {
    ...(probe.width === null ? {} : { width: probe.width }),
    ...(probe.height === null ? {} : { height: probe.height }),
    ...(probe.durationSeconds === null ? {} : { durationSeconds: probe.durationSeconds }),
    ...(probe.fps === null ? {} : { fps: probe.fps }),
  };
}

export async function runPublish(job: Job, ctx: StageContext): Promise<StageOutcome> {
  const path = ctx.notes.exportedPath ?? join(ctx.paths.output, FINAL_VIDEO_NAME);
  const artifact = await ctx.publisher.publish({
    jobId: job.jobId,
    localPath: path,
    kind: "video",
    name: FINAL_VIDEO_NAME,
    ...mediaOf(ctx.notes.probe),
  });
  ctx.store.addArtifact(artifact);
  return { progress: 1, detail: { artifactId: artifact.artifactId, bytes: artifact.bytes } };
}
