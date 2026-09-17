import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AdapterError, runProcess } from "../src/index.js";

/**
 * These tests drive `node` itself, never `hypit` and never `ffprobe`: the point is to prove the
 * capture, the cap and the kill paths of the process boundary, and only a real child process can
 * prove them. Every script below is inline, deterministic and offline.
 */
const NODE = process.execPath;

function script(source: string): readonly string[] {
  return ["-e", source];
}

test("stdout and stderr are captured separately, with the exit code", async () => {
  const result = await runProcess(
    NODE,
    script("process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 1;"),
    { env: {} },
  );
  assert.equal(result.stdout, "out");
  assert.equal(result.stderr, "err");
  assert.equal(result.code, 1);
  assert.equal(result.truncated, false);
});

test("output past the byte cap is dropped rather than buffered, and the result says so", async () => {
  const result = await runProcess(
    NODE,
    script("process.stdout.write('x'.repeat(200000));"),
    { env: {}, maxOutputBytes: 1024 },
  );
  assert.equal(result.stdout.length, 1024);
  assert.equal(result.truncated, true);
  assert.equal(result.code, 0);
});

test("a timeout kills the observer and raises the adapter's own timeout", async () => {
  await assert.rejects(
    runProcess(NODE, script("setTimeout(() => {}, 10000);"), { env: {}, timeoutMs: 250 }),
    (error: unknown) => {
      assert.ok(error instanceof AdapterError);
      assert.equal(error.code, "ADAPTER_TIMEOUT");
      return true;
    },
  );
});

test("an abort signal stops the process and is classified CANCELLED", async () => {
  const controller = new AbortController();
  const running = runProcess(NODE, script("setTimeout(() => {}, 10000);"), { env: {}, signal: controller.signal });
  controller.abort();
  await assert.rejects(running, (error: unknown) => {
    assert.ok(error instanceof AdapterError);
    assert.equal(error.code, "ADAPTER_ABORTED");
    assert.equal(error.errorClass, "CANCELLED");
    return true;
  });
});

test("an already aborted signal never reaches a spawn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hypit-adapter-spawn-"));
  try {
    // A path that cannot start: reaching the spawn would report a missing executable instead.
    const missing = join(dir, "not-an-executable");
    await assert.rejects(
      runProcess(missing, [], { env: {}, signal: AbortSignal.abort() }),
      (error: unknown) => {
        assert.ok(error instanceof AdapterError);
        assert.equal(error.code, "ADAPTER_ABORTED");
        return true;
      },
    );
    await assert.rejects(runProcess(missing, [], { env: {} }), (error: unknown) => {
      assert.ok(error instanceof AdapterError);
      assert.equal(error.code, "ADAPTER_EXECUTABLE_MISSING");
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
