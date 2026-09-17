/**
 * The second external executable, and the quality gate built on it.
 *
 * `probeVideo` never throws for a bad video: a missing file, a non-zero ffprobe exit and
 * unparseable JSON are all recorded on the probe itself. That is what makes `evaluateQuality` a
 * pure function of a value the tests can write by hand, and it keeps the seven checks of contract 9
 * in one readable list instead of scattered across a try/catch.
 *
 * Note the contrast with `cli.ts`: ffprobe's exit code IS meaningful and is used. The Hypit CLI's
 * is not, and is ignored there.
 */
import { stat } from "node:fs/promises";

import { redact } from "@hypit/job-core";

import { assertAbsolutePath, assertContainedPath } from "./argv.js";
import { runProcess } from "./spawn.js";
import type { ProcessRunner } from "./spawn.js";

export type FfprobeContext = {
  /** Absolute path to ffprobe. Injected: this package hard-codes no runtime path. */
  readonly executable: string;
  readonly env: Readonly<Record<string, string>>;
  /** The same containment boundary the CLI uses: a job may only probe inside its own area. */
  readonly allowedRoots: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly maxOutputBytes?: number;
  readonly run?: ProcessRunner;
};

/**
 * Fixed argv. Nothing here is derived from a job's request, so there is exactly one shape of
 * ffprobe invocation in the system and it can be read at a glance.
 */
const FFPROBE_ARGV: readonly string[] = [
  "-v", "error",
  "-hide_banner",
  "-show_entries", "format=duration,size:stream=index,codec_type,width,height,r_frame_rate",
  "-of", "json",
];

export type VideoProbe = {
  /** Redacted; the caller passed the path in and already knows it. */
  readonly path: string;
  /** Check 2: ffprobe exited 0 AND returned parseable JSON. */
  readonly ok: boolean;
  readonly error: string | null;
  /** Measured from the filesystem, not from the Build's own report. */
  readonly bytes: number | null;
  readonly durationSeconds: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly fps: number | null;
  readonly hasVideoStream: boolean;
  readonly hasAudioStream: boolean;
};

function unprobed(path: string, bytes: number | null, error: string): VideoProbe {
  return {
    path: redact(path),
    ok: false,
    error: redact(error),
    bytes,
    durationSeconds: null,
    width: null,
    height: null,
    fps: null,
    hasVideoStream: false,
    hasAudioStream: false,
  };
}

/** ffprobe reports a rate as a ratio; a still image reports `0/0`. */
function frameRate(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parts = value.split("/");
  const numerator = Number(parts[0]);
  const denominator = parts.length > 1 ? Number(parts[1]) : 1;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  const rate = numerator / denominator;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

function numberOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

type ProbeStream = {
  readonly codec_type?: unknown;
  readonly width?: unknown;
  readonly height?: unknown;
  readonly r_frame_rate?: unknown;
};

export async function probeVideo(path: string, ctx: FfprobeContext): Promise<VideoProbe> {
  assertAbsolutePath("ffprobe executable", ctx.executable);
  // Absolute and contained, which also guarantees the path can never look like an ffprobe option.
  assertContainedPath("path", path, ctx.allowedRoots);
  let bytes: number | null = null;
  try {
    const stats = await stat(path);
    if (!stats.isFile()) return unprobed(path, null, "path is not a regular file");
    bytes = stats.size;
  } catch {
    return unprobed(path, null, "file does not exist");
  }
  const run = ctx.run ?? runProcess;
  const result = await run(ctx.executable, [...FFPROBE_ARGV, path], {
    env: ctx.env,
    ...(ctx.cwd === undefined ? {} : { cwd: ctx.cwd }),
    ...(ctx.timeoutMs === undefined ? {} : { timeoutMs: ctx.timeoutMs }),
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    ...(ctx.maxOutputBytes === undefined ? {} : { maxOutputBytes: ctx.maxOutputBytes }),
  });
  if (result.code !== 0) {
    return unprobed(path, bytes, `ffprobe exited ${String(result.code)}: ${result.stderr.trim().slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    return unprobed(path, bytes, `ffprobe output was not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const payload = parsed as { readonly format?: { readonly duration?: unknown }; readonly streams?: readonly ProbeStream[] };
  const streams = Array.isArray(payload.streams) ? payload.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  return {
    path: redact(path),
    ok: true,
    error: null,
    bytes,
    durationSeconds: numberOf(payload.format?.duration),
    width: video === undefined ? null : numberOf(video.width),
    height: video === undefined ? null : numberOf(video.height),
    fps: video === undefined ? null : frameRate(video.r_frame_rate),
    hasVideoStream: video !== undefined,
    hasAudioStream: streams.some((stream) => stream.codec_type === "audio"),
  };
}

/** 10 KiB: contract 9, check 1. Below this there is no video, only a header. */
export const MIN_VIDEO_BYTES = 10 * 1024;
export const DEFAULT_FPS_TOLERANCE = 0.01;

export type QualityExpectation = {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  /**
   * Check 7. The adapter cannot see the Build's Result from a probe, so the worker passes what
   * `getBuildStatus` told it. "Build exited 0" is never sufficient to call a job COMPLETED.
   */
  readonly buildComplete: boolean;
  readonly minBytes?: number;
  readonly fpsTolerance?: number;
};

export type QualityCheckName =
  | "file_present"
  | "probe_parsed"
  | "video_stream"
  | "duration"
  | "dimensions"
  | "frame_rate"
  | "build_complete";

export type QualityCheck = {
  readonly name: QualityCheckName;
  readonly ok: boolean;
  readonly detail: string;
};

export type QualityReport = {
  readonly ok: boolean;
  /** The first check that failed, which is what the `qc_report` artifact records. */
  readonly failed: QualityCheckName | null;
  readonly checks: readonly QualityCheck[];
};

function check(name: QualityCheckName, ok: boolean, detail: string): QualityCheck {
  return { name, ok, detail: redact(detail) };
}

/**
 * The seven checks of contract 9, in order, all of them evaluated so the report shows the whole
 * picture rather than stopping at the first complaint. `failed` names the first failure because a
 * human reading a QC report wants the cause, not the list.
 */
export function evaluateQuality(probe: VideoProbe, expected: QualityExpectation): QualityReport {
  const minBytes = expected.minBytes ?? MIN_VIDEO_BYTES;
  const tolerance = expected.fpsTolerance ?? DEFAULT_FPS_TOLERANCE;
  const bytes = probe.bytes;
  const duration = probe.durationSeconds;
  const fps = probe.fps;
  const fpsDrift = fps === null || expected.fps <= 0 ? null : Math.abs(fps - expected.fps) / expected.fps;
  const checks: readonly QualityCheck[] = [
    check("file_present", bytes !== null && bytes >= minBytes,
      bytes === null ? "the file is missing" : `${bytes} bytes, minimum ${minBytes}`),
    check("probe_parsed", probe.ok, probe.error ?? "ffprobe returned parseable JSON"),
    check("video_stream", probe.hasVideoStream, probe.hasVideoStream ? "one video stream" : "no video stream"),
    check("duration", duration !== null && duration > 0,
      duration === null ? "duration is unavailable" : `duration ${duration}s`),
    check("dimensions", probe.width === expected.width && probe.height === expected.height,
      `${probe.width ?? "?"}x${probe.height ?? "?"}, expected ${expected.width}x${expected.height}`),
    check("frame_rate", fpsDrift !== null && fpsDrift <= tolerance,
      fps === null ? "frame rate is unreadable" : `${fps} fps, expected ${expected.fps} within ${tolerance * 100}%`),
    check("build_complete", expected.buildComplete,
      expected.buildComplete ? "the Build reports complete" : "the Build does not report complete"),
  ];
  const failed = checks.find((entry) => !entry.ok);
  return { ok: failed === undefined, failed: failed?.name ?? null, checks };
}
