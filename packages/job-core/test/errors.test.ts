import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MAX_ATTEMPTS,
  ERROR_CLASSES,
  classifyHypitErrorCode,
  hypitErrorCodes,
  isErrorClass,
  jobError,
  retryable,
} from "../src/index.js";
import type { ErrorClass } from "../src/index.js";

const RETRYABLE: readonly ErrorClass[] = ["RETRYABLE_TRANSPORT", "LOCAL_RENDER_FAILED"];

test("the nine error classes are exactly the contract's set", () => {
  assert.deepEqual([...ERROR_CLASSES].sort(), [
    "AUTHORING_FAILED",
    "CANCELLED",
    "HYPIT_BUILD_FAILED",
    "INTERNAL",
    "LOCAL_RENDER_FAILED",
    "PROVIDER_SUBMISSION_UNKNOWN",
    "QC_FAILED",
    "RETRYABLE_TRANSPORT",
    "VALIDATION_FAILED",
  ]);
  for (const value of ERROR_CLASSES) assert.ok(isErrorClass(value));
  assert.ok(!isErrorClass("RETRYABLE"));
  assert.ok(!isErrorClass(undefined));
});

test("only RETRYABLE_TRANSPORT and LOCAL_RENDER_FAILED are retryable", () => {
  for (const errorClass of ERROR_CLASSES) {
    assert.equal(retryable(errorClass), RETRYABLE.includes(errorClass), `${errorClass} retryability`);
  }
  assert.equal(DEFAULT_MAX_ATTEMPTS, 3);
});

test("a paid submission whose outcome is unknown is never retryable", () => {
  // Retrying may double-charge the provider, so this class fails the job for a human instead.
  assert.equal(retryable("PROVIDER_SUBMISSION_UNKNOWN"), false);
});

test("jobError takes retryability from the class, never from the caller", () => {
  const transient = jobError({ class: "RETRYABLE_TRANSPORT", code: "ETIMEDOUT", message: "timed out" });
  assert.equal(transient.retryable, true);
  const unknown = jobError({
    class: "PROVIDER_SUBMISSION_UNKNOWN",
    code: "EXECUTION_UNKNOWN",
    message: "submitted, outcome unknown",
    receipt: "bld_20260917T111333092Z_9775AB9482",
  });
  assert.equal(unknown.retryable, false);
  assert.equal(unknown.receipt, "bld_20260917T111333092Z_9775AB9482");
});

test("an error without a receipt has no receipt key at all", () => {
  // exactOptionalPropertyTypes: an optional property is absent, never present holding undefined.
  const error = jobError({ class: "QC_FAILED", code: "QC_DIMENSIONS", message: "540x960 expected" });
  assert.ok(!("receipt" in error));
  assert.equal(error.class, "QC_FAILED");
  assert.equal(error.code, "QC_DIMENSIONS");
});

test("EXECUTION_UNKNOWN and SUBMISSION_INTERRUPTED classify as an unknown paid submission", () => {
  for (const code of ["EXECUTION_UNKNOWN", "SUBMISSION_INTERRUPTED"]) {
    const errorClass = classifyHypitErrorCode(code);
    assert.equal(errorClass, "PROVIDER_SUBMISSION_UNKNOWN", code);
    assert.equal(retryable(errorClass), false, code);
  }
});

test("build failures keep their Result so a revision can reuse it", () => {
  assert.equal(classifyHypitErrorCode("EXECUTION_FAILED"), "HYPIT_BUILD_FAILED");
  assert.equal(classifyHypitErrorCode("BUILD_DEADLOCK"), "HYPIT_BUILD_FAILED");
  assert.equal(classifyHypitErrorCode("CANCELLED"), "CANCELLED");
});

test("a usage error is our bug, not the caller's", () => {
  // We build every argv ourselves, so CLI_USAGE can only mean the adapter emitted a bad command.
  assert.equal(classifyHypitErrorCode("CLI_USAGE"), "INTERNAL");
  assert.equal(classifyHypitErrorCode("CLI_ERROR"), "INTERNAL");
  assert.equal(classifyHypitErrorCode("PACKAGE_SELECTION_MISSING"), "VALIDATION_FAILED");
});

test("a transient network errno is retryable, a permission errno is not", () => {
  assert.equal(classifyHypitErrorCode("ETIMEDOUT"), "RETRYABLE_TRANSPORT");
  assert.equal(classifyHypitErrorCode("ECONNRESET"), "RETRYABLE_TRANSPORT");
  assert.equal(classifyHypitErrorCode("EAI_AGAIN"), "RETRYABLE_TRANSPORT");
  assert.equal(classifyHypitErrorCode("EACCES"), "INTERNAL");
  assert.equal(classifyHypitErrorCode("ENOENT"), "INTERNAL");
});

test("an unrecognised code falls back to the stage's own class", () => {
  assert.equal(classifyHypitErrorCode("SOMETHING_NEW"), "INTERNAL");
  assert.equal(classifyHypitErrorCode("SOMETHING_NEW", "LOCAL_RENDER_FAILED"), "LOCAL_RENDER_FAILED");
  // A prototype key must not be mistaken for a mapping.
  assert.equal(classifyHypitErrorCode("toString"), "INTERNAL");
  assert.equal(classifyHypitErrorCode("__proto__", "QC_FAILED"), "QC_FAILED");
});

test("every mapped code names a real error class", () => {
  for (const code of hypitErrorCodes()) {
    assert.ok(isErrorClass(classifyHypitErrorCode(code)), `${code} maps to a known class`);
  }
});
