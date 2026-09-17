import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import { createArtifactId } from "./ids.js";
import type { IdClock } from "./ids.js";

/**
 * What a job produced. An Artifact is metadata plus a URI — never bytes: the API and the MCP edge
 * both return this record, and a multi-hundred-megabyte MP4 must not travel through either.
 *
 * The field set is the `artifacts` table, one property per column, so a store maps a row by
 * converting each column name from snake_case to camelCase and nothing else. Columns that are
 * nullable in SQL are `| null` here rather than optional, so a row round-trips without an optional
 * property ever holding `undefined` (which `exactOptionalPropertyTypes` would reject anyway).
 */
export type ArtifactKind = "video" | "log" | "project_file" | "reference" | "qc_report";

export const ARTIFACT_KINDS: readonly ArtifactKind[] = [
  "video",
  "log",
  "project_file",
  "reference",
  "qc_report",
];

export function isArtifactKind(value: unknown): value is ArtifactKind {
  return typeof value === "string" && (ARTIFACT_KINDS as readonly string[]).includes(value);
}

export type Artifact = {
  readonly artifactId: string;
  readonly jobId: string;
  readonly kind: ArtifactKind;
  /** Caller-facing file name, e.g. `final.mp4`. Never a path. */
  readonly name: string;
  readonly uri: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly checksumSha256: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationSeconds: number | null;
  readonly fps: number | null;
  readonly createdAt: string;
};

/**
 * Media metadata a caller already measured. The publisher does not probe: ffprobe lives in the
 * adapter and the quality gate has already read these numbers, so re-reading them here would mean
 * two sources of truth for one file.
 */
export type ArtifactMedia = {
  readonly mediaType?: string;
  readonly width?: number;
  readonly height?: number;
  readonly durationSeconds?: number;
  readonly fps?: number;
};

export type ArtifactPublishInput = {
  readonly jobId: string;
  /** Absolute path inside the job's own workspace. The publisher never resolves a relative path. */
  readonly localPath: string;
  readonly kind: ArtifactKind;
  readonly name: string;
} & ArtifactMedia;

/**
 * The seam that keeps object storage out of the job contract. v1 publishes locally; an S3/R2
 * implementation satisfies the same interface later without the Job, the API or MCP changing.
 */
export interface ArtifactPublisher {
  publish(input: ArtifactPublishInput): Promise<Artifact>;
}

export class ArtifactPublishError extends Error {
  readonly code: string;
  /** The artifact name, never the path: this message reaches a log line and an API response. */
  readonly subject: string;

  constructor(code: string, subject: string, message: string) {
    super(message);
    this.name = "ArtifactPublishError";
    this.code = code;
    this.subject = subject;
  }
}

/** A Map rather than an object literal, so a name like `x.toString` cannot inherit a "type". */
const MEDIA_TYPES: ReadonlyMap<string, string> = new Map(Object.entries({
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".json": "application/json",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".svrun": "text/plain",
  ".svml": "text/plain",
} as const));

/** Extension lookup only. Sniffing content would mean reading a whole video to label it. */
export function mediaTypeForName(name: string): string {
  return MEDIA_TYPES.get(extname(name).toLowerCase()) ?? "application/octet-stream";
}

/** Streamed, because an artifact is a video: reading it into one Buffer to hash it is not viable. */
async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export type LocalArtifactPublisherOptions = {
  /** Injected so a test can assert an exact record instead of "some id, some time". */
  readonly now?: IdClock;
  readonly newArtifactId?: () => string;
};

/**
 * v1 publisher: the file stays where the worker wrote it, inside the job workspace, and the
 * artifact records where it is plus what it is. Size and digest are measured from the file on
 * disk rather than trusted from the Build's own report, because the contract's quality gate
 * exists precisely to catch a Build that claims more than it produced.
 */
export class LocalArtifactPublisher implements ArtifactPublisher {
  readonly #now: IdClock;
  readonly #newArtifactId: () => string;

  constructor(options: LocalArtifactPublisherOptions = {}) {
    this.#now = options.now ?? Date.now;
    const now = this.#now;
    this.#newArtifactId = options.newArtifactId ?? (() => createArtifactId({ now }));
  }

  async publish(input: ArtifactPublishInput): Promise<Artifact> {
    if (!isAbsolute(input.localPath)) {
      throw new ArtifactPublishError("ARTIFACT_PATH_NOT_ABSOLUTE", input.name,
        `artifact ${input.name} must be published from an absolute path`);
    }
    let bytes: number;
    try {
      const stats = await stat(input.localPath);
      if (!stats.isFile()) {
        throw new ArtifactPublishError("ARTIFACT_NOT_A_FILE", input.name,
          `artifact ${input.name} is not a regular file`);
      }
      bytes = stats.size;
    } catch (error) {
      if (error instanceof ArtifactPublishError) throw error;
      throw new ArtifactPublishError("ARTIFACT_UNREADABLE", input.name,
        `artifact ${input.name} could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    const checksumSha256 = await sha256File(input.localPath);
    return {
      artifactId: this.#newArtifactId(),
      jobId: input.jobId,
      kind: input.kind,
      name: input.name,
      // pathToFileURL, never string concatenation: it percent-encodes spaces and gets the drive
      // letter right on the Windows CI leg.
      uri: pathToFileURL(input.localPath).href,
      mediaType: input.mediaType ?? mediaTypeForName(input.name),
      bytes,
      checksumSha256,
      width: input.width ?? null,
      height: input.height ?? null,
      durationSeconds: input.durationSeconds ?? null,
      fps: input.fps ?? null,
      createdAt: new Date(this.#now()).toISOString(),
    };
  }
}
