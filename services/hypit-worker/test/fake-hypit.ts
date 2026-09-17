import { stat, writeFile } from "node:fs/promises";

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

import type { HypitPort, ListedBuild, ProgramsStatus } from "../src/index.js";

/**
 * A Hypit that spawns nothing. Every parser, classifier, state transition and store write in these
 * tests is the real one; only the CLI is replaced, which is the point — the rules worth testing
 * (never submit twice, never retry an unknown submission, never build a plan that spends) live in
 * the worker, not in the process it would otherwise start.
 */

/** Real shapes, taken from the live CLI capture in the contract. */
export const BUILD_ID = "bld_20260917T121134939Z_1850BA006E";
export const OTHER_BUILD_ID = "bld_20260917T121200000Z_1850BA007F";

/** Big enough to clear the quality gate's 10 KiB floor, small enough to write in a test. */
export const EXPORTED_BYTES = 75_314;

export function buildStatus(
  outcome: BuildStatus["outcome"],
  progress: number | null = null,
  buildId: string = BUILD_ID,
): BuildStatus {
  const done = outcome === "complete";
  return {
    buildId,
    outcome,
    workState: done ? "done" : "working",
    workOutcome: done ? "complete" : null,
    resultState: done ? "complete" : "missing",
    outputCount: done ? 4 : null,
    progress,
    omitted: [],
  };
}

/** Contract 16: three requests, all local, nothing unresolved — the plan the probe actually saw. */
export function localPlan(): PlanResult {
  return {
    requestCount: 3,
    localRequestCount: 3,
    providerRequestCount: 0,
    unresolvedRequestCount: 0,
    providers: [{ name: "provider-media-local", pricingKind: "local" }],
    localOnly: true,
    omitted: [],
  };
}

/** A plan that would spend money: two remote requests and a metered provider. */
export function paidPlan(): PlanResult {
  return {
    requestCount: 4,
    localRequestCount: 2,
    providerRequestCount: 2,
    unresolvedRequestCount: 0,
    providers: [
      { name: "provider-media-local", pricingKind: "local" },
      { name: "seedance", pricingKind: "metered" },
    ],
    localOnly: false,
    omitted: [],
  };
}

export function videoProbe(overrides: Partial<VideoProbe> = {}): VideoProbe {
  return {
    path: "final.mp4",
    ok: true,
    error: null,
    bytes: EXPORTED_BYTES,
    durationSeconds: 8,
    width: 540,
    height: 960,
    fps: 30,
    hasVideoStream: true,
    hasAudioStream: true,
    ...overrides,
  };
}

export type FakeCalls = {
  check: number;
  plan: number;
  submit: number;
  status: number;
  cancel: number;
  export: number;
  list: number;
  probe: number;
  programs: number;
};

export class FakeHypit implements HypitPort {
  readonly calls: FakeCalls = {
    check: 0, plan: 0, submit: 0, status: 0, cancel: 0, export: 0, list: 0, probe: 0, programs: 0,
  };

  readonly submitted: string[] = [];
  readonly cancelledBuilds: string[] = [];
  readonly observedBuilds: string[] = [];

  buildId = BUILD_ID;
  check: CheckResult = { ok: true, sourceKind: "run", source: "chat.svrun", outputCount: 4, omitted: [] };
  plan: PlanResult = localPlan();
  /** Consumed one per `getBuildStatus`; the last entry repeats once the queue runs dry. */
  statuses: BuildStatus[] = [buildStatus("running", 0.5), buildStatus("complete")];
  probe: VideoProbe = videoProbe();
  builds: readonly ListedBuild[] = [];
  programs: ProgramsStatus = { ready: true, readyCount: 2, totalCount: 2 };
  cancelResult: CancelOutcome = { buildId: BUILD_ID, requested: true, observed: true, outcome: "cancelled" };

  throwOnCheck: Error | null = null;
  throwOnPlan: Error | null = null;
  throwOnSubmit: Error | null = null;
  throwOnExport: Error | null = null;
  /** Runs after each status call, which is how a test asks for cancellation mid-poll. */
  onStatus: ((call: number) => void) | null = null;
  /** Real elapsed time inside one poll, for the one test that needs the heartbeat to fire. */
  statusDelayMs = 0;

  async checkSource(_source: string, _ctx: HypitContext): Promise<CheckResult> {
    this.calls.check += 1;
    if (this.throwOnCheck !== null) throw this.throwOnCheck;
    return this.check;
  }

  async planRun(_runSource: string, _ctx: HypitContext): Promise<PlanResult> {
    this.calls.plan += 1;
    if (this.throwOnPlan !== null) throw this.throwOnPlan;
    return this.plan;
  }

  async submitBuild(_runSource: string, _ctx: HypitContext): Promise<{ readonly buildId: string }> {
    this.calls.submit += 1;
    if (this.throwOnSubmit !== null) throw this.throwOnSubmit;
    this.submitted.push(this.buildId);
    return { buildId: this.buildId };
  }

  async getBuildStatus(buildId: string, _ctx: HypitContext): Promise<BuildStatus> {
    this.calls.status += 1;
    this.observedBuilds.push(buildId);
    const next = this.statuses.length > 1 ? this.statuses.shift() : this.statuses[0];
    this.onStatus?.(this.calls.status);
    if (this.statusDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.statusDelayMs));
    }
    return next ?? buildStatus("complete", 1, buildId);
  }

  async cancelBuild(buildId: string, _reason: string, _ctx: HypitContext): Promise<CancelOutcome> {
    this.calls.cancel += 1;
    this.cancelledBuilds.push(buildId);
    return { ...this.cancelResult, buildId };
  }

  async exportOutput(buildId: string, output: string, to: string, _ctx: HypitContext): Promise<ExportResult> {
    this.calls.export += 1;
    if (this.throwOnExport !== null) throw this.throwOnExport;
    // A real export leaves a real file, and the quality gate measures what is on disk rather than
    // what the Build claimed — so the fake has to leave one too.
    await writeFile(to, Buffer.alloc(EXPORTED_BYTES));
    return { buildId, output, kind: "resource", type: "video", path: to, directory: false, omitted: [] };
  }

  async listBuilds(_ctx: HypitContext): Promise<readonly ListedBuild[]> {
    this.calls.list += 1;
    return this.builds;
  }

  async programsStatus(_ctx: HypitContext): Promise<ProgramsStatus> {
    this.calls.programs += 1;
    return this.programs;
  }

  async probeVideo(path: string, _ctx: FfprobeContext): Promise<VideoProbe> {
    this.calls.probe += 1;
    const bytes = await stat(path).then((stats) => stats.size, () => null);
    return { ...this.probe, path, bytes };
  }
}
