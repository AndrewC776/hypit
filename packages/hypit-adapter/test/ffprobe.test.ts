import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AdapterArgumentError, evaluateQuality, probeVideo } from "../src/index.js";
import type { FfprobeContext, ProcessResult, ProcessRunner, QualityExpectation, VideoProbe } from "../src/index.js";

/** The output spec the probe fixtures are measured against: the shape the live probe produced. */
const EXPECTED: QualityExpectation = { width: 540, height: 960, fps: 30, buildComplete: true };

function goodProbe(overrides: Partial<VideoProbe> = {}): VideoProbe {
  return {
    path: "/jobs/vid/output/final.mp4",
    ok: true,
    error: null,
    bytes: 75_314,
    durationSeconds: 8,
    width: 540,
    height: 960,
    fps: 30,
    hasVideoStream: true,
    hasAudioStream: true,
    ...overrides,
  };
}

test("a good probe passes every check", () => {
  const report = evaluateQuality(goodProbe(), EXPECTED);
  assert.equal(report.ok, true);
  assert.equal(report.failed, null);
  assert.equal(report.checks.length, 7);
  assert.deepEqual(report.checks.filter((check) => !check.ok), []);
});

test("wrong dimensions fail, and the report names the check", () => {
  const report = evaluateQuality(goodProbe({ width: 1080, height: 1920 }), EXPECTED);
  assert.equal(report.ok, false);
  assert.equal(report.failed, "dimensions");
  assert.ok(report.checks.find((check) => check.name === "dimensions")?.detail.includes("540x960"));
});

test("a zero duration fails the duration check", () => {
  const report = evaluateQuality(goodProbe({ durationSeconds: 0 }), EXPECTED);
  assert.equal(report.ok, false);
  assert.equal(report.failed, "duration");
});

test("a missing video stream fails before dimensions are considered", () => {
  const report = evaluateQuality(
    goodProbe({ hasVideoStream: false, width: null, height: null, fps: null }),
    EXPECTED,
  );
  assert.equal(report.ok, false);
  assert.equal(report.failed, "video_stream");
});

test("a file below the video minimum fails first, before ffprobe is believed", () => {
  const report = evaluateQuality(goodProbe({ bytes: 1024 }), EXPECTED);
  assert.equal(report.ok, false);
  assert.equal(report.failed, "file_present");
});

test("an unparsed probe fails the probe check and keeps its reason", () => {
  const report = evaluateQuality(
    goodProbe({ ok: false, error: "ffprobe exited 1: Invalid data found", hasVideoStream: false }),
    EXPECTED,
  );
  assert.equal(report.failed, "probe_parsed");
  assert.ok(report.checks.find((check) => check.name === "probe_parsed")?.detail.includes("Invalid data"));
});

test("a frame rate outside one percent fails, and one inside it passes", () => {
  assert.equal(evaluateQuality(goodProbe({ fps: 29.97 }), EXPECTED).ok, true);
  assert.equal(evaluateQuality(goodProbe({ fps: 25 }), EXPECTED).failed, "frame_rate");
  assert.equal(evaluateQuality(goodProbe({ fps: null }), EXPECTED).failed, "frame_rate");
});

test("a Build that does not report complete fails the gate even with a perfect file", () => {
  const report = evaluateQuality(goodProbe(), { ...EXPECTED, buildComplete: false });
  assert.equal(report.ok, false);
  assert.equal(report.failed, "build_complete");
});

/** The ffprobe payload for the file the live probe produced: h264 540x960 30fps with aac. */
const FFPROBE_JSON = JSON.stringify({
  streams: [
    { index: 0, codec_type: "video", width: 540, height: 960, r_frame_rate: "30/1" },
    { index: 1, codec_type: "audio", r_frame_rate: "0/0" },
  ],
  format: { duration: "8.000000", size: "75314" },
});

type ProbeHarness = {
  readonly ctx: FfprobeContext;
  readonly calls: string[][];
  readonly dir: string;
};

async function withFfprobe(
  answer: (argv: readonly string[]) => ProcessResult,
  body: (harness: ProbeHarness) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hypit-adapter-ffprobe-"));
  try {
    const calls: string[][] = [];
    const run: ProcessRunner = (_executable, argv) => {
      calls.push([...argv]);
      return Promise.resolve(answer(argv));
    };
    const ctx: FfprobeContext = {
      executable: join(dir, "bin", "ffprobe"),
      env: {},
      allowedRoots: [dir],
      run,
    };
    await body({ ctx, calls, dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("probeVideo reads a fixed argv and reports what ffprobe measured", async () => {
  await withFfprobe(() => ({ code: 0, stdout: FFPROBE_JSON, stderr: "", truncated: false }), async ({ ctx, calls, dir }) => {
    const path = join(dir, "final.mp4");
    await writeFile(path, "x".repeat(20_480));
    const probe = await probeVideo(path, ctx);
    assert.equal(probe.ok, true);
    assert.equal(probe.width, 540);
    assert.equal(probe.height, 960);
    assert.equal(probe.fps, 30);
    assert.equal(probe.durationSeconds, 8);
    assert.equal(probe.hasVideoStream, true);
    assert.equal(probe.hasAudioStream, true);
    // The size is measured from the filesystem, not taken from the Build's own report.
    assert.equal(probe.bytes, 20_480);
    const argv = calls[0] ?? [];
    assert.deepEqual(argv.slice(0, 4), ["-v", "error", "-hide_banner", "-show_entries"]);
    assert.equal(argv.at(-1), path);
    assert.equal(evaluateQuality(probe, EXPECTED).ok, true);
  });
});

test("a missing file is reported without ffprobe being asked", async () => {
  await withFfprobe(() => ({ code: 0, stdout: FFPROBE_JSON, stderr: "", truncated: false }), async ({ ctx, calls, dir }) => {
    const probe = await probeVideo(join(dir, "absent.mp4"), ctx);
    assert.equal(probe.ok, false);
    assert.equal(probe.bytes, null);
    assert.ok(probe.error?.includes("does not exist"));
    assert.deepEqual(calls, []);
    assert.equal(evaluateQuality(probe, EXPECTED).failed, "file_present");
  });
});

test("a non-zero ffprobe exit is recorded on the probe rather than thrown", async () => {
  await withFfprobe(() => ({ code: 1, stdout: "", stderr: "Invalid data found when processing input", truncated: false }),
    async ({ ctx, dir }) => {
      const path = join(dir, "broken.mp4");
      await writeFile(path, "x".repeat(20_480));
      const probe = await probeVideo(path, ctx);
      assert.equal(probe.ok, false);
      assert.ok(probe.error?.includes("Invalid data found"));
      assert.equal(evaluateQuality(probe, EXPECTED).failed, "probe_parsed");
    });
});

test("a path outside the allowed root is rejected before ffprobe is spawned", async () => {
  await withFfprobe(() => ({ code: 0, stdout: FFPROBE_JSON, stderr: "", truncated: false }), async ({ ctx, calls }) => {
    const outside = await mkdtemp(join(tmpdir(), "hypit-adapter-outside-"));
    try {
      await assert.rejects(probeVideo(join(outside, "final.mp4"), ctx), AdapterArgumentError);
      await assert.rejects(probeVideo("final.mp4", ctx), AdapterArgumentError);
      assert.deepEqual(calls, []);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
