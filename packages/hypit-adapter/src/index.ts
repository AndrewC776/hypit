/**
 * `@hypit/hypit-adapter` is the single owner of every external executable in the control plane:
 * the `hypit` CLI and `ffprobe`. Nothing else in the codebase may spawn a process.
 *
 * The package holds no configuration. The executable, the workspace, the runtime profile, the
 * environment, the allowed roots, the timeout and the abort signal are all injected by the worker,
 * which is what lets every test drive the parsers with captured payloads and prove that a rejected
 * argument reaches no process at all.
 */
export * from "./argv.js";
export * from "./build-view.js";
export * from "./cli.js";
export * from "./envelope.js";
export * from "./errors.js";
export * from "./ffprobe.js";
export * from "./spawn.js";
