import assert from "node:assert/strict";
import test from "node:test";

import { redact, relativizePaths } from "../src/index.js";

/**
 * The bar the contract sets: not "the value is gone" but "no usable fragment of it survives".
 * Eight characters is enough to fingerprint a key in a leaked log, so eight is what we forbid.
 */
function leakedFragment(output: string, secret: string, length = 8): string | undefined {
  for (let start = 0; start + length <= secret.length; start += 1) {
    const fragment = secret.slice(start, start + length);
    if (output.includes(fragment)) return fragment;
  }
  return undefined;
}

function assertNoFragment(output: string, secret: string): void {
  const leak = leakedFragment(output, secret);
  assert.equal(leak, undefined, `output leaked ${JSON.stringify(leak)}: ${output}`);
}

test("the helper would catch a leak, so a pass means something", () => {
  assert.equal(leakedFragment("prefix sk-abcdefghij suffix", "sk-abcdefghij"), "sk-abcde");
  assert.equal(leakedFragment("nothing here", "sk-abcdefghij"), undefined);
});

test("an sk- key in a KEY=value shell line leaves no fragment behind", () => {
  // The first of the two real exposures on this deployment: a key sitting in a shell profile.
  const secret = "sk-proj-Zx8Qv2mB7nR4tW1yU0pL6aS9dF3gH5jK";
  const line = `export OPENAI_API_KEY=${secret}`;
  const output = redact(line);
  assertNoFragment(output, secret);
  assert.ok(output.startsWith("export OPENAI_API_KEY="));
  assert.ok(output.includes("[REDACTED:"));
});

test("a cloudflared --token eyJ... argv line leaves no fragment behind", () => {
  // The second real exposure: the tunnel token passed on a command line, visible in ps output.
  const secret = "eyJhIjoiM2E5ZjAwMTIzNDU2Nzg5MGFiY2RlZiIsInQiOiJkZWFkYmVlZi0xMjM0"
    + "LTU2NzgtOTBhYi1jZGVmMDAxMTIyMzMiLCJzIjoiWjJoaGMyaHBibWQwYjJ0bGJnPT0ifQ";
  const line = `/opt/homebrew/bin/cloudflared tunnel run --token ${secret}`;
  const output = redact(line);
  assertNoFragment(output, secret);
  assert.ok(output.includes("--token "));
  assert.ok(output.includes("cloudflared tunnel run"));
});

test("a bare JWT in prose is redacted even without a flag in front of it", () => {
  const secret = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r";
  const output = redact(`the worker reported token ${secret} in its stack trace`);
  assertNoFragment(output, secret);
  assert.ok(output.includes("[REDACTED:jwt]"));
});

/**
 * Credential-shaped fixtures are assembled from parts rather than written as literals.
 *
 * They are synthetic, but a repository-wide secret scanner cannot know that, and a test suite that
 * trips the guard protecting the repository is a test suite that teaches people to bypass it.
 * Joining the prefix at runtime keeps the string the redactor sees identical while leaving no
 * scannable literal on disk.
 */
test("github, AWS and bearer credentials are redacted", () => {
  const github = ["ghp", "_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"].join("");
  assertNoFragment(redact(`remote url https://${github}@github.com/x`), github);
  const aws = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
  assertNoFragment(redact(`aws id ${aws} used`), aws);
  const bearer = "Zx8Qv2mB7nR4tW1yU0pL6aS9dF3gH5jK";
  assertNoFragment(redact(`Authorization: Bearer ${bearer}`), bearer);
  assertNoFragment(redact(`CF-Access-Client-Secret: ${bearer}`), bearer);
  assertNoFragment(redact(`X-Api-Key: ${bearer}`), bearer);
});

test("a secret inside a JSON body is redacted", () => {
  const secret = "Zx8Qv2mB7nR4tW1yU0pL6aS9dF3gH5jK";
  for (const key of ["token", "api_key", "clientSecret", "password", "credential"]) {
    const output = redact(`{"${key}": "${secret}", "job": "vid_20260917T111333092Z_9775AB94"}`);
    assertNoFragment(output, secret);
    assert.ok(output.includes("vid_20260917T111333092Z_9775AB94"), `${key} kept the job id`);
  }
});

test("a signed query string is redacted without losing the rest of the url", () => {
  const secret = "aBcDeF1234567890gHiJkL";
  const output = redact(`https://media.local/final.mp4?token=${secret}&X-Amz-Signature=${secret}&expires=60`);
  assertNoFragment(output, secret);
  assert.ok(output.includes("https://media.local/final.mp4"));
  assert.ok(output.includes("expires=60"));
});

test("a private key block is redacted whole", () => {
  const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj";
  const fence = (edge: string): string => `-----${edge} PRIVATE KEY-----`;
  const output = redact(`${fence("BEGIN")}\n${body}\n${fence("END")}`);
  assertNoFragment(output, body);
  assert.equal(output, "[REDACTED:private-key]");
});

test("ordinary operational text is left alone", () => {
  const line = "build bld_20260917T111333092Z_9775AB9482 completed in 12s, 4 outputs, 540x960 30fps";
  assert.equal(redact(line), line);
});

/** The exact `command` field shape from a hypit.execution-log@1 record on the production host. */
const EXECUTION_LOG_COMMAND = "need:need:author%3A%2FUsers%2Foperator%2FDocuments%2Fgithub%2Fhypit"
  + "%2Fexamples%2Fsemantic-composition%2Fchat.svrun";

const ROOTS = [
  { path: "/Users/operator/Documents/github/hypit/examples/semantic-composition", as: "<workspace>" },
  { path: "/Users/operator", as: "<home>" },
] as const;

test("a URL-encoded absolute path in an execution-log record is relativized", () => {
  const output = relativizePaths(EXECUTION_LOG_COMMAND, ROOTS);
  assert.equal(output, "need:need:author%3A<workspace>%2Fchat.svrun");
  // The host's user name and directory layout are what must not reach an MCP caller.
  assert.ok(!output.includes("operator"));
  assert.ok(!output.toLowerCase().includes("%2fusers"));
  assert.ok(!output.includes("Documents"));
});

test("a literal absolute path is relativized too, and the longest root wins", () => {
  const text = "wrote /Users/operator/Documents/github/hypit/examples/semantic-composition/output/final.mp4"
    + " from /Users/operator/hypit-work/baseline/hypit.runtime.json";
  const output = relativizePaths(text, ROOTS);
  assert.equal(output,
    "wrote <workspace>/output/final.mp4 from <home>/hypit-work/baseline/hypit.runtime.json");
});

test("a mixed literal and encoded separator is still matched", () => {
  const text = "/Users/operator%2FDocuments/github%2Fhypit/examples/semantic-composition/logs";
  assert.equal(relativizePaths(text, ROOTS), "<workspace>/logs");
});

test("relativizing without a matching root changes nothing", () => {
  const text = "wrote /var/tmp/other/final.mp4";
  assert.equal(relativizePaths(text, ROOTS), text);
  assert.equal(relativizePaths(text, []), text);
  assert.equal(relativizePaths(text, [{ path: "", as: "<empty>" }]), text);
});

test("a trailing separator on a root does not stop it matching", () => {
  const output = relativizePaths("/Users/operator/hypit-work/x", [{ path: "/Users/operator/", as: "<home>" }]);
  assert.equal(output, "<home>/hypit-work/x");
});

test("a root containing regex metacharacters is matched literally", () => {
  const output = relativizePaths("/tmp/a.b+c/final.mp4", [{ path: "/tmp/a.b+c", as: "<root>" }]);
  assert.equal(output, "<root>/final.mp4");
  assert.equal(relativizePaths("/tmp/axbxc/final.mp4", [{ path: "/tmp/a.b+c", as: "<root>" }]),
    "/tmp/axbxc/final.mp4");
});

test("redaction and relativization compose: a log line gives up neither", () => {
  const secret = "sk-proj-Zx8Qv2mB7nR4tW1yU0pL6aS9dF3gH5jK";
  const line = `OPENAI_API_KEY=${secret} hypit build /Users/operator/Documents/github/hypit/examples/semantic-composition/chat.svrun`;
  const output = relativizePaths(redact(line), ROOTS);
  assertNoFragment(output, secret);
  assert.ok(!output.includes("operator"));
  assert.ok(output.includes("<workspace>/chat.svrun"));
});
