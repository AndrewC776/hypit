/**
 * `@hypit/job-core` is the shared domain: identities, the job state machine, failure
 * classification, request validation, the SSRF guard, redaction, and the artifact contract.
 * It owns no I/O beyond reading a file to digest it, spawns nothing, and holds no configuration —
 * every clock, resolver, allow-list and path is injected by the caller, which is what lets the
 * API, the worker and the adapter share one definition of the domain without sharing a deployment.
 */
export * from "./artifact.js";
export * from "./errors.js";
export * from "./ids.js";
export * from "./job.js";
export * from "./redact.js";
export * from "./request-fields.js";
export * from "./request.js";
export * from "./state-machine.js";
export * from "./url-guard.js";
