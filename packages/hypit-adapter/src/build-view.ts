/**
 * The Build view that `build`, `status` and `cancel` all print, and the two readings the control
 * plane takes from it: how far along the Build is, and whether it finished.
 *
 * This lives apart from `cli.ts` because it is the one piece of Hypit's own vocabulary the adapter
 * has to interpret rather than pass through, and because the rule it encodes is the contract's
 * sharpest: the exit code decides nothing, and `complete` is reported only when the work outcome
 * and the Result state both say so. A cancelled Build exits 0 and must never pass that test.
 */
import { plainObject, readNumber, readString } from "./envelope.js";
import type { Envelope } from "./envelope.js";

/**
 * `not_found` is its own outcome rather than a flag, because contract 15 TRAP 2 is precisely the
 * mistake of folding it into "still running".
 */
export type BuildOutcome = "running" | "complete" | "failed" | "cancelled" | "not_found" | "unknown";

/**
 * `hypit build` was captured in shorthand rather than as raw JSON, so a view at the envelope root
 * is accepted as well as one under `build`: the alternative is guessing, and guessing wrong loses
 * a Build id that was already minted and submitted.
 */
export function buildView(payload: Envelope): Envelope | undefined {
  const nested = plainObject(payload.build);
  if (nested !== undefined) return nested;
  return readString(payload, "id") === null ? undefined : payload;
}

/**
 * Contract 16.5: while working the view carries `work.requests`, and once done it does not. Both
 * are optional, so progress may become unavailable rather than jumping to 1.
 */
export function progressOf(work: Envelope | undefined): number | null {
  const requests = plainObject(work?.requests);
  const total = readNumber(requests, "total");
  const completed = readNumber(requests, "completed");
  if (total === null || completed === null || total <= 0) return null;
  return Math.min(1, Math.max(0, completed / total));
}

/**
 * Work state and Result state together, never the exit code. Everything that is not unambiguously
 * complete degrades to a named non-complete outcome, so an unfamiliar string from a later CLI
 * version can be reported honestly instead of being mistaken for success.
 */
export function outcomeOf(work: Envelope | undefined, result: Envelope | undefined): BuildOutcome {
  const workState = readString(work, "state");
  const workOutcome = (readString(work, "outcome") ?? "").toLowerCase();
  const resultState = readString(result, "state");
  if (workOutcome.startsWith("cancel")) return "cancelled";
  if (workOutcome.startsWith("fail")) return "failed";
  if (workState === null) return "unknown";
  if (workState !== "done") return "running";
  if (workOutcome === "complete" && resultState === "complete") return "complete";
  return "unknown";
}
