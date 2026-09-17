import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  ARTIFACT_KINDS,
  ArtifactPublishError,
  LocalArtifactPublisher,
  isArtifactKind,
  isArtifactId,
  mediaTypeForName,
} from "../src/index.js";

const MOMENT = Date.parse("2026-09-17T12:11:34.939Z");
const fixed = { now: () => MOMENT };

/** sha256 of the empty input, so at least one digest in this file is a known vector. */
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

async function withTempDir(body: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "hypit-job-artifact-"));
  try {
    await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("the artifact kinds are the schema's five", () => {
  assert.deepEqual([...ARTIFACT_KINDS], ["video", "log", "project_file", "reference", "qc_report"]);
  for (const kind of ARTIFACT_KINDS) assert.ok(isArtifactKind(kind));
  assert.ok(!isArtifactKind("mp4"));
  assert.ok(!isArtifactKind(undefined));
});

test("media types come from the extension, with a safe default", () => {
  assert.equal(mediaTypeForName("final.mp4"), "video/mp4");
  assert.equal(mediaTypeForName("FINAL.MP4"), "video/mp4");
  assert.equal(mediaTypeForName("build.log"), "text/plain");
  assert.equal(mediaTypeForName("qc.json"), "application/json");
  assert.equal(mediaTypeForName("mystery"), "application/octet-stream");
  assert.equal(mediaTypeForName("x.toString"), "application/octet-stream");
});

test("publishing measures the file and returns a file URI, never bytes", async () => {
  await withTempDir(async (directory) => {
    const body = Buffer.from("a tiny stand-in for an exported mp4\n");
    const path = join(directory, "final.mp4");
    await writeFile(path, body);
    const publisher = new LocalArtifactPublisher(fixed);
    const artifact = await publisher.publish({
      jobId: "vid_20260917T111333092Z_9775AB94",
      localPath: path,
      kind: "video",
      name: "final.mp4",
      width: 540,
      height: 960,
      durationSeconds: 8,
      fps: 30,
    });
    assert.ok(isArtifactId(artifact.artifactId));
    assert.equal(artifact.jobId, "vid_20260917T111333092Z_9775AB94");
    assert.equal(artifact.kind, "video");
    assert.equal(artifact.name, "final.mp4");
    assert.equal(artifact.uri, pathToFileURL(path).href);
    assert.equal(artifact.mediaType, "video/mp4");
    assert.equal(artifact.bytes, body.byteLength);
    assert.equal(artifact.checksumSha256, createHash("sha256").update(body).digest("hex"));
    assert.equal(artifact.width, 540);
    assert.equal(artifact.height, 960);
    assert.equal(artifact.durationSeconds, 8);
    assert.equal(artifact.fps, 30);
    assert.equal(artifact.createdAt, "2026-09-17T12:11:34.939Z");
    // One property per `artifacts` column, so the store maps a row without inventing a field.
    assert.deepEqual(Object.keys(artifact).sort(), [
      "artifactId", "bytes", "checksumSha256", "createdAt", "durationSeconds", "fps", "height",
      "jobId", "kind", "mediaType", "name", "uri", "width",
    ]);
  });
});

test("the digest is read from the file, not from what the caller claimed", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "empty.mp4");
    await writeFile(path, "");
    const artifact = await new LocalArtifactPublisher(fixed).publish({
      jobId: "vid_20260917T111333092Z_9775AB94",
      localPath: path,
      kind: "video",
      name: "empty.mp4",
    });
    assert.equal(artifact.checksumSha256, EMPTY_SHA256);
    assert.equal(artifact.bytes, 0);
  });
});

test("absent media metadata is null, so a row maps one-to-one", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "build.log");
    await writeFile(path, "started\ncompleted\n");
    const artifact = await new LocalArtifactPublisher(fixed).publish({
      jobId: "vid_20260917T111333092Z_9775AB94",
      localPath: path,
      kind: "log",
      name: "build.log",
    });
    assert.equal(artifact.width, null);
    assert.equal(artifact.height, null);
    assert.equal(artifact.durationSeconds, null);
    assert.equal(artifact.fps, null);
    assert.equal(artifact.mediaType, "text/plain");
  });
});

test("a name with a space becomes a valid URI rather than a broken one", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "final cut.mp4");
    await writeFile(path, "x");
    const artifact = await new LocalArtifactPublisher(fixed).publish({
      jobId: "vid_20260917T111333092Z_9775AB94",
      localPath: path,
      kind: "video",
      name: "final cut.mp4",
    });
    // pathToFileURL, not concatenation: the space is encoded and the URI parses back.
    assert.ok(artifact.uri.includes("%20"));
    assert.equal(new URL(artifact.uri).protocol, "file:");
  });
});

test("each publish mints a distinct artifact id", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "final.mp4");
    await writeFile(path, "x");
    const publisher = new LocalArtifactPublisher(fixed);
    const input = {
      jobId: "vid_20260917T111333092Z_9775AB94",
      localPath: path,
      kind: "video",
      name: "final.mp4",
    } as const;
    const first = await publisher.publish(input);
    const second = await publisher.publish(input);
    assert.notEqual(first.artifactId, second.artifactId);
    assert.equal(first.checksumSha256, second.checksumSha256);
  });
});

test("an injected id generator makes a published record fully deterministic", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "final.mp4");
    await writeFile(path, "x");
    const publisher = new LocalArtifactPublisher({
      now: () => MOMENT,
      newArtifactId: () => "art_20260917T121134939Z_1850BA00",
    });
    const artifact = await publisher.publish({
      jobId: "vid_20260917T111333092Z_9775AB94",
      localPath: path,
      kind: "video",
      name: "final.mp4",
    });
    assert.equal(artifact.artifactId, "art_20260917T121134939Z_1850BA00");
    assert.equal(artifact.createdAt, "2026-09-17T12:11:34.939Z");
  });
});

test("a relative path is refused with its own code, not a filesystem error", async () => {
  await assert.rejects(
    new LocalArtifactPublisher(fixed).publish({
      jobId: "vid_20260917T111333092Z_9775AB94",
      localPath: join("relative", "final.mp4"),
      kind: "video",
      name: "final.mp4",
    }),
    (error: unknown) => error instanceof ArtifactPublishError
      && error.code === "ARTIFACT_PATH_NOT_ABSOLUTE"
      && error.subject === "final.mp4",
  );
});

test("a missing file fails as an artifact error, not an unhandled fs error", async () => {
  await withTempDir(async (directory) => {
    await assert.rejects(
      new LocalArtifactPublisher(fixed).publish({
        jobId: "vid_20260917T111333092Z_9775AB94",
        localPath: join(directory, "absent.mp4"),
        kind: "video",
        name: "absent.mp4",
      }),
      (error: unknown) => error instanceof ArtifactPublishError && error.code === "ARTIFACT_UNREADABLE",
    );
  });
});

test("a directory is not an artifact", async () => {
  await withTempDir(async (directory) => {
    // `hypit get` produces a DIRECTORY for a composite output; publishing one must say so plainly.
    const composite = join(directory, "composite");
    await mkdir(composite);
    await assert.rejects(
      new LocalArtifactPublisher(fixed).publish({
        jobId: "vid_20260917T111333092Z_9775AB94",
        localPath: composite,
        kind: "video",
        name: "composite",
      }),
      (error: unknown) => error instanceof ArtifactPublishError && error.code === "ARTIFACT_NOT_A_FILE",
    );
  });
});
