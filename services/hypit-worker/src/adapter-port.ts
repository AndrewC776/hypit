/**
 * Binds the real `@hypit/hypit-adapter` to the worker's port.
 *
 * The two operations the adapter does not export yet — listing a project's Builds and reading the
 * Managed Programs' status — are required constructor arguments rather than a stub that returns a
 * hopeful answer. A stubbed `listBuilds` would claim "no Build exists" after a crash and submit a
 * second one, which is the single most expensive mistake this control plane can make; a stubbed
 * `programsStatus` would let the worker accept jobs that every Build would then refuse.
 */
import {
  cancelBuild,
  checkSource,
  exportOutput,
  getBuildStatus,
  planRun,
  probeVideo,
  submitBuild,
} from "@hypit/hypit-adapter";
import type { HypitContext } from "@hypit/hypit-adapter";

import type { HypitPort, ListedBuild, ProgramsStatus } from "./hypit-port.js";

export type HypitPortExtensions = {
  listBuilds(ctx: HypitContext): Promise<readonly ListedBuild[]>;
  programsStatus(ctx: HypitContext): Promise<ProgramsStatus>;
};

export function createAdapterPort(extensions: HypitPortExtensions): HypitPort {
  return {
    checkSource,
    planRun,
    submitBuild,
    getBuildStatus,
    cancelBuild,
    exportOutput,
    probeVideo,
    listBuilds: extensions.listBuilds,
    programsStatus: extensions.programsStatus,
  };
}
