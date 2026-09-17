/**
 * The `prepared_run` pipeline: which stage runs in which state, under which event reason, and how
 * an unexpected throw from it is classified.
 *
 * Declaring the pipeline as data rather than as a sequence of calls is what lets the runner treat
 * every stage identically — one transition, one attempt row, one retry rule — and what lets
 * recovery resume at the build stage without a second code path.
 *
 * `clone` is deliberately absent. v1 implements the mode that was proven end to end on the
 * production host; a clone job fails with a named code rather than running a half-built pipeline.
 */
import { JOB_EVENT_REASONS } from "@hypit/job-core";

import { WORKER_EVENT_REASONS } from "./events.js";
import type { Stage, StageName } from "./stage.js";
import { runBuild } from "./stages/build.js";
import { runExport } from "./stages/export.js";
import { runPlan } from "./stages/plan.js";
import { runPrepare } from "./stages/prepare.js";
import { runPublish } from "./stages/publish.js";
import { runQualityCheck } from "./stages/qc.js";
import { runValidate } from "./stages/validate.js";

export const PREPARED_RUN_STAGES: readonly Stage[] = [
  {
    name: "prepare",
    // The claim already moved the job here, so this stage runs without a transition of its own.
    state: "PREPARING_WORKSPACE",
    reason: JOB_EVENT_REASONS.claimed,
    fallback: "INTERNAL",
    run: runPrepare,
  },
  {
    name: "validate",
    state: "VALIDATING",
    reason: JOB_EVENT_REASONS.stageAdvanced,
    fallback: "VALIDATION_FAILED",
    run: runValidate,
  },
  {
    name: "plan",
    state: "PLANNING",
    reason: JOB_EVENT_REASONS.stageAdvanced,
    fallback: "VALIDATION_FAILED",
    run: runPlan,
  },
  {
    name: "build",
    state: "BUILDING",
    // The marker, written in the same transaction that enters BUILDING and before any spawn.
    reason: WORKER_EVENT_REASONS.buildSubmitMarker,
    fallback: "HYPIT_BUILD_FAILED",
    run: runBuild,
  },
  {
    name: "export",
    // The build stage has usually moved the job here already; entering is then a no-op.
    state: "RENDERING",
    reason: JOB_EVENT_REASONS.stageAdvanced,
    fallback: "LOCAL_RENDER_FAILED",
    run: runExport,
  },
  {
    name: "qc",
    state: "QUALITY_CHECK",
    reason: JOB_EVENT_REASONS.stageAdvanced,
    fallback: "QC_FAILED",
    run: runQualityCheck,
  },
  {
    name: "publish",
    state: "PUBLISHING",
    reason: JOB_EVENT_REASONS.stageAdvanced,
    fallback: "INTERNAL",
    run: runPublish,
  },
];

/** Where a resumed job re-enters the pipeline: it already has a Build, so it observes rather than submits. */
export function stagesFrom(name: StageName): readonly Stage[] {
  const index = PREPARED_RUN_STAGES.findIndex((stage) => stage.name === name);
  return index < 0 ? PREPARED_RUN_STAGES : PREPARED_RUN_STAGES.slice(index);
}
