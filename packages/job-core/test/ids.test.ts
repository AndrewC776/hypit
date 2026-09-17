import assert from "node:assert/strict";
import test from "node:test";

import { assertBuildId as protocolAssertBuildId } from "@hypit/protocol";

import {
  IdFormatError,
  assertBuildId,
  assertControlPlaneId,
  assertJobId,
  assertWorkerId,
  controlPlaneIdCreatedAt,
  createArtifactId,
  createControlPlaneId,
  createJobId,
  createRevisionId,
  createWorkerId,
  isArtifactId,
  isControlPlaneId,
  isHypitBuildId,
  isJobId,
  isRevisionId,
  isWorkerId,
  workerHostLabel,
} from "../src/index.js";

/** The one instant every id test mints against, so an expected id can be written out in full. */
const MOMENT = Date.parse("2026-09-17T11:13:33.092Z");
const fixed = { now: () => MOMENT, nonce: () => "9775AB94" };

test("a job id embeds its UTC creation time and an eight-character hex nonce", () => {
  assert.equal(createJobId(fixed), "vid_20260917T111333092Z_9775AB94");
  assert.equal(createRevisionId(fixed), "rev_20260917T111333092Z_9775AB94");
  assert.equal(createArtifactId(fixed), "art_20260917T111333092Z_9775AB94");
});

test("control-plane ids round-trip their creation time", () => {
  assert.equal(controlPlaneIdCreatedAt(createJobId(fixed)), MOMENT);
  assert.equal(controlPlaneIdCreatedAt(createRevisionId(fixed)), MOMENT);
  assert.equal(controlPlaneIdCreatedAt(createArtifactId(fixed)), MOMENT);
  assert.equal(controlPlaneIdCreatedAt("vid_not_an_id"), undefined);
});

test("the default clock mints an id that validates", () => {
  const id = createJobId();
  assert.ok(isJobId(id));
  const createdAt = controlPlaneIdCreatedAt(id);
  assert.ok(createdAt !== undefined && Math.abs(Date.now() - createdAt) < 60_000);
});

test("each id kind only recognises its own prefix", () => {
  const job = createJobId(fixed);
  assert.ok(isJobId(job));
  assert.ok(!isRevisionId(job));
  assert.ok(!isArtifactId(job));
  assert.ok(isRevisionId(createRevisionId(fixed)));
  assert.ok(isArtifactId(createArtifactId(fixed)));
});

test("a malformed job id is rejected rather than repaired", () => {
  const rejected = [
    "",
    "vid_20260917T111333092Z_9775ab94",
    "vid_20260917T111333092Z_9775AB9",
    "vid_20260917T111333092Z_9775AB941",
    "vid_20260917T111333092_9775AB94",
    "vid_20261399T111333092Z_9775AB94",
    "bld_20260917T111333092Z_9775AB9482",
    " vid_20260917T111333092Z_9775AB94",
    "vid_20260917T111333092Z_9775AB94 ",
  ];
  for (const value of rejected) {
    assert.ok(!isJobId(value), `expected ${JSON.stringify(value)} to be rejected`);
    assert.throws(() => assertJobId(value), IdFormatError);
  }
  assert.ok(!isJobId(undefined));
  assert.ok(!isJobId(42));
});

test("a digit run that is not a real date is not a timestamp", () => {
  assert.ok(!isJobId("vid_20260231T111333092Z_9775AB94"));
  assert.equal(controlPlaneIdCreatedAt("vid_20260231T111333092Z_9775AB94"), undefined);
});

test("an out-of-range clock is refused instead of minting an expanded-year id", () => {
  assert.throws(() => createJobId({ now: () => 8.64e15, nonce: () => "9775AB94" }), IdFormatError);
  assert.throws(() => createJobId({ now: () => -1, nonce: () => "9775AB94" }), IdFormatError);
});

test("a nonce that is not eight upper-case hex characters is refused", () => {
  assert.throws(() => createJobId({ now: () => MOMENT, nonce: () => "zzzzzzzz" }), IdFormatError);
  assert.throws(() => createJobId({ now: () => MOMENT, nonce: () => "9775ab94" }), IdFormatError);
});

test("a worker id keeps a sanitised host label, its pid and a nonce", () => {
  assert.equal(createWorkerId("Mac-Studio.local", 1234, fixed), "wkr_mac-studio-local_1234_9775AB94");
  assert.ok(isWorkerId("wkr_mac-studio-local_1234_9775AB94"));
});

test("a host label never carries a path separator or an empty token into a log line", () => {
  assert.equal(workerHostLabel("../etc/passwd"), "etc-passwd");
  assert.equal(workerHostLabel("///"), "host");
  assert.equal(workerHostLabel(""), "host");
  assert.equal(workerHostLabel("HOST_1"), "host-1");
  assert.ok(isWorkerId(createWorkerId("../etc/passwd", 7, fixed)));
});

test("a worker pid must be a positive safe integer", () => {
  assert.throws(() => createWorkerId("host", 0, fixed), IdFormatError);
  assert.throws(() => createWorkerId("host", -1, fixed), IdFormatError);
  assert.throws(() => createWorkerId("host", 1.5, fixed), IdFormatError);
  assert.throws(() => assertWorkerId("wkr_host_1234"), IdFormatError);
  assert.ok(!isWorkerId("wkr_Host_1234_9775AB94"));
});

test("an id kind that is not one of ours is a miss, never an inherited member", () => {
  // The kind reaches these from an HTTP handler; an object-literal lookup of `toString` would
  // return a function and turn a validation miss into a crash or a forged id.
  const forged = "toString" as unknown as "job";
  assert.ok(!isControlPlaneId(forged, "vid_20260917T111333092Z_9775AB94"));
  assert.throws(() => createControlPlaneId(forged, fixed), IdFormatError);
  assert.throws(() => assertControlPlaneId(forged, "vid_20260917T111333092Z_9775AB94"), IdFormatError);
});

test("Build identity is Hypit's, re-exported rather than re-implemented", () => {
  // A second Build id regex in the control plane would drift the moment the CLI changed its own.
  assert.equal(assertBuildId, protocolAssertBuildId);
  assert.ok(isHypitBuildId("bld_20260917T111333092Z_9775AB9482"));
  assert.ok(!isHypitBuildId("bld_20260917T111333092Z_9775AB94"));
  assert.ok(!isHypitBuildId("vid_20260917T111333092Z_9775AB94"));
  assert.ok(!isHypitBuildId(undefined));
});
