/**
 * The seam between the worker and every external executable.
 *
 * The worker never spawns anything: `@hypit/hypit-adapter` owns that, and this port is the shape
 * the worker asks for. Making it an interface rather than a direct import is what lets the whole
 * pipeline be driven by a fake in tests — with the real classification, the real state machine and
 * the real store, and nothing running on the host.
 *
 * Two operations here have no counterpart in the adapter yet, and both are load-bearing:
 *
 * - `listBuilds` is contract 17.5's orphan recovery: after a crash between submission and the id
 *   being printed, the job's own project directory is listed and the single Build in it adopted.
 * - `programsStatus` is contract 17.8: the worker refuses jobs until the Managed Programs report
 *   ready, and never provisions them itself.
 *
 * They are declared here so the worker can be written and tested against them; the deployment
 * supplies them (see `adapter-port.ts`) until the adapter exports `builds` and `programs status`.
 */
import type {
  BuildStatus,
  CancelOutcome,
  CheckResult,
  ExportResult,
  FfprobeContext,
  HypitContext,
  PlanResult,
  VideoProbe,
} from "@hypit/hypit-adapter";

/** One row of `hypit.cli-builds@1`. `run` and `createdAt` are what confirm an adoption. */
export type ListedBuild = {
  readonly id: string;
  readonly run: string | null;
  readonly createdAt: string | null;
  readonly outcome: string | null;
};

/** `hypit programs status`, reduced to the one question the worker asks: is every program ready? */
export type ProgramsStatus = {
  readonly ready: boolean;
  readonly readyCount: number;
  readonly totalCount: number;
};

export interface HypitPort {
  checkSource(source: string, ctx: HypitContext): Promise<CheckResult>;
  planRun(runSource: string, ctx: HypitContext): Promise<PlanResult>;
  submitBuild(runSource: string, ctx: HypitContext): Promise<{ readonly buildId: string }>;
  getBuildStatus(buildId: string, ctx: HypitContext): Promise<BuildStatus>;
  cancelBuild(buildId: string, reason: string, ctx: HypitContext): Promise<CancelOutcome>;
  exportOutput(buildId: string, output: string, to: string, ctx: HypitContext): Promise<ExportResult>;
  /** Every Build recorded in `ctx.workspace`'s Result repository, newest first. */
  listBuilds(ctx: HypitContext): Promise<readonly ListedBuild[]>;
  programsStatus(ctx: HypitContext): Promise<ProgramsStatus>;
  probeVideo(path: string, ctx: FfprobeContext): Promise<VideoProbe>;
}
