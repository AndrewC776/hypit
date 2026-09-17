import assert from "node:assert/strict";
import test from "node:test";

import {
  JOB_STATES,
  JOB_STATE_ORDER,
  JobStateTransitionError,
  MODE_STATE_PATHS,
  TERMINAL_JOB_STATES,
  assertTransition,
  canTransition,
  isJobState,
  isTerminalJobState,
  jobStateOrder,
} from "../src/index.js";
import type { JobState } from "../src/index.js";

const NON_TERMINAL: readonly JobState[] = JOB_STATES.filter((state) => !isTerminalJobState(state));

test("the canonical order is the thirteen forward states, QUEUED first and COMPLETED last", () => {
  assert.equal(JOB_STATE_ORDER.length, 13);
  assert.equal(JOB_STATE_ORDER[0], "QUEUED");
  assert.equal(JOB_STATE_ORDER.at(-1), "COMPLETED");
  assert.equal(JOB_STATES.length, 15);
  assert.deepEqual([...TERMINAL_JOB_STATES], ["COMPLETED", "FAILED", "CANCELLED"]);
  assert.equal(new Set(JOB_STATES).size, JOB_STATES.length);
});

test("isJobState admits every state and nothing else", () => {
  for (const state of JOB_STATES) assert.ok(isJobState(state));
  assert.ok(!isJobState("RENDERING_"));
  assert.ok(!isJobState("rendering"));
  assert.ok(!isJobState(undefined));
});

test("FAILED and CANCELLED are off the forward path and have no order", () => {
  assert.equal(jobStateOrder("FAILED"), undefined);
  assert.equal(jobStateOrder("CANCELLED"), undefined);
  assert.equal(jobStateOrder("QUEUED"), 0);
  assert.equal(jobStateOrder("COMPLETED"), JOB_STATE_ORDER.length - 1);
});

test("every strictly forward move is legal, skipping included", () => {
  for (const [fromIndex, from] of JOB_STATE_ORDER.entries()) {
    for (const [toIndex, to] of JOB_STATE_ORDER.entries()) {
      if (toIndex <= fromIndex) continue;
      if (to === "COMPLETED" && from !== "PUBLISHING") continue;
      assert.ok(canTransition(from, to), `${from} -> ${to} should be legal`);
    }
  }
  // The skip that makes prepared_run possible without a second machine.
  assert.ok(canTransition("PREPARING_WORKSPACE", "VALIDATING"));
  assert.ok(canTransition("QUEUED", "PUBLISHING"));
});

test("every backward move is illegal", () => {
  for (const [fromIndex, from] of JOB_STATE_ORDER.entries()) {
    for (const [toIndex, to] of JOB_STATE_ORDER.entries()) {
      if (toIndex >= fromIndex) continue;
      assert.ok(!canTransition(from, to), `${from} -> ${to} should be illegal`);
    }
  }
});

test("no state may transition to itself: a stage retry opens an attempt instead", () => {
  for (const state of JOB_STATES) {
    assert.ok(!canTransition(state, state), `${state} -> ${state} should be illegal`);
    assert.throws(() => assertTransition(state, state), JobStateTransitionError);
  }
});

test("a terminal state is immutable", () => {
  for (const from of TERMINAL_JOB_STATES) {
    for (const to of JOB_STATES) {
      assert.ok(!canTransition(from, to), `${from} -> ${to} should be illegal`);
    }
  }
});

test("FAILED and CANCELLED are reachable from every non-terminal state", () => {
  for (const from of NON_TERMINAL) {
    assert.ok(canTransition(from, "FAILED"), `${from} -> FAILED should be legal`);
    assert.ok(canTransition(from, "CANCELLED"), `${from} -> CANCELLED should be legal`);
  }
});

test("COMPLETED is reachable only from PUBLISHING", () => {
  for (const from of NON_TERMINAL) {
    assert.equal(canTransition(from, "COMPLETED"), from === "PUBLISHING", `${from} -> COMPLETED`);
  }
});

test("the one sanctioned backward move, stale-worker requeue, is not a transition", () => {
  // Recovery puts a stalled job back to QUEUED. The machine refuses it on purpose: the store
  // performs it as a recorded recovery action, so it can never be mistaken for ordinary progress.
  assert.ok(!canTransition("BUILDING", "QUEUED"));
  assert.ok(!canTransition("PREPARING_WORKSPACE", "QUEUED"));
});

test("assertTransition throws a typed error naming both states", () => {
  assert.throws(() => assertTransition("RENDERING", "PLANNING"), (error: unknown) =>
    error instanceof JobStateTransitionError
    && error.code === "JOB_STATE_TRANSITION_INVALID"
    && error.from === "RENDERING"
    && error.to === "PLANNING"
    && error.message.includes("RENDERING -> PLANNING"));
  assert.doesNotThrow(() => assertTransition("RENDERING", "QUALITY_CHECK"));
});

test("both mode paths are legal chains the worker and the tests share", () => {
  for (const [mode, path] of Object.entries(MODE_STATE_PATHS)) {
    assert.equal(path[0], "QUEUED", `${mode} starts queued`);
    assert.equal(path.at(-1), "COMPLETED", `${mode} ends completed`);
    for (let index = 1; index < path.length; index += 1) {
      const from = path[index - 1]!;
      const to = path[index]!;
      assert.ok(canTransition(from, to), `${mode}: ${from} -> ${to} should be legal`);
    }
  }
});

test("prepared_run skips the reference and authoring stages", () => {
  const skipped: readonly JobState[] = [
    "DOWNLOADING_REFERENCE",
    "ANALYZING_REFERENCE",
    "AUTHORING",
    "GENERATING_ASSETS",
  ];
  for (const state of skipped) {
    assert.ok(!MODE_STATE_PATHS.prepared_run.includes(state), `prepared_run must skip ${state}`);
    assert.ok(MODE_STATE_PATHS.clone.includes(state), `clone must run ${state}`);
  }
  assert.deepEqual([...MODE_STATE_PATHS.clone], [...JOB_STATE_ORDER]);
});
