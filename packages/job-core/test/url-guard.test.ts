import assert from "node:assert/strict";
import test from "node:test";

import { checkReferenceUrl, classifyAddress, classifyReferenceUrl } from "../src/index.js";
import type { AddressLookup, UrlGuardCode } from "../src/index.js";

/** The deployment's allow-list, passed in as a parameter — the guard hard-codes no host. */
const TIKTOK: readonly string[] = ["tiktok.com", "www.tiktok.com", "vt.tiktok.com", "vm.tiktok.com"];

const REFERENCE = "https://www.tiktok.com/@someone/video/123";

/** Every resolver a test uses is injected, so no test in this file can reach DNS. */
function resolvesTo(...addresses: readonly string[]): AddressLookup {
  return async () => addresses.map((address) => ({ address }));
}

function blockedAs(value: string, code: UrlGuardCode): void {
  const verdict = classifyAddress(value);
  assert.equal(verdict.ok, false, `${value} should be blocked`);
  if (verdict.ok) return;
  assert.equal(verdict.code, code, `${value}: ${verdict.message}`);
}

test("a public address passes the classifier", () => {
  for (const address of ["8.8.8.8", "1.1.1.1", "203.0.113.7", "2606:4700:4700::1111", "2a03:2880:f10c::35"]) {
    assert.equal(classifyAddress(address).ok, true, address);
  }
});

test("0.0.0.0/8 is blocked", () => {
  blockedAs("0.0.0.0", "ADDRESS_UNSPECIFIED");
  blockedAs("0.1.2.3", "ADDRESS_UNSPECIFIED");
  blockedAs("::ffff:0.0.0.0", "ADDRESS_UNSPECIFIED");
  blockedAs("::", "ADDRESS_UNSPECIFIED");
});

test("127.0.0.0/8 loopback is blocked", () => {
  blockedAs("127.0.0.1", "ADDRESS_LOOPBACK");
  blockedAs("127.1.2.3", "ADDRESS_LOOPBACK");
  blockedAs("127.255.255.255", "ADDRESS_LOOPBACK");
  blockedAs("::ffff:127.0.0.1", "ADDRESS_LOOPBACK");
  blockedAs("::ffff:7f00:1", "ADDRESS_LOOPBACK");
});

test("::1 IPv6 loopback is blocked", () => {
  blockedAs("::1", "ADDRESS_LOOPBACK");
  blockedAs("0:0:0:0:0:0:0:1", "ADDRESS_LOOPBACK");
  blockedAs("[::1]", "ADDRESS_LOOPBACK");
});

test("10.0.0.0/8 is blocked", () => {
  blockedAs("10.0.0.1", "ADDRESS_PRIVATE");
  blockedAs("10.10.0.3", "ADDRESS_PRIVATE");
  blockedAs("10.255.255.254", "ADDRESS_PRIVATE");
  blockedAs("::ffff:10.10.0.3", "ADDRESS_PRIVATE");
});

test("172.16.0.0/12 is blocked and its neighbours are not", () => {
  blockedAs("172.16.0.1", "ADDRESS_PRIVATE");
  blockedAs("172.20.1.1", "ADDRESS_PRIVATE");
  blockedAs("172.31.255.255", "ADDRESS_PRIVATE");
  blockedAs("::ffff:172.16.0.1", "ADDRESS_PRIVATE");
  assert.equal(classifyAddress("172.15.255.255").ok, true);
  assert.equal(classifyAddress("172.32.0.1").ok, true);
});

test("192.168.0.0/16 is blocked", () => {
  blockedAs("192.168.0.1", "ADDRESS_PRIVATE");
  blockedAs("192.168.255.255", "ADDRESS_PRIVATE");
  blockedAs("::ffff:192.168.1.1", "ADDRESS_PRIVATE");
  assert.equal(classifyAddress("192.169.0.1").ok, true);
});

test("169.254.0.0/16 link-local is blocked", () => {
  blockedAs("169.254.0.1", "ADDRESS_LINK_LOCAL");
  blockedAs("169.254.99.99", "ADDRESS_LINK_LOCAL");
  blockedAs("::ffff:169.254.0.1", "ADDRESS_LINK_LOCAL");
});

test("169.254.169.254 is called out as the metadata address", () => {
  // Named separately so a blocked-request log says which attack it was, not just "link local".
  blockedAs("169.254.169.254", "ADDRESS_METADATA");
  blockedAs("::ffff:169.254.169.254", "ADDRESS_METADATA");
  blockedAs("::ffff:a9fe:a9fe", "ADDRESS_METADATA");
  blockedAs("64:ff9b::169.254.169.254", "ADDRESS_METADATA");
});

test("100.64.0.0/10 carrier-grade NAT is blocked", () => {
  blockedAs("100.64.0.1", "ADDRESS_CARRIER_GRADE_NAT");
  blockedAs("100.127.255.255", "ADDRESS_CARRIER_GRADE_NAT");
  blockedAs("::ffff:100.64.0.1", "ADDRESS_CARRIER_GRADE_NAT");
  assert.equal(classifyAddress("100.63.255.255").ok, true);
  assert.equal(classifyAddress("100.128.0.1").ok, true);
});

test("multicast and reserved space is blocked in both families", () => {
  blockedAs("224.0.0.1", "ADDRESS_MULTICAST");
  blockedAs("239.255.255.250", "ADDRESS_MULTICAST");
  blockedAs("::ffff:224.0.0.1", "ADDRESS_MULTICAST");
  blockedAs("ff02::1", "ADDRESS_MULTICAST");
  blockedAs("ff00::", "ADDRESS_MULTICAST");
  blockedAs("240.0.0.1", "ADDRESS_RESERVED");
  blockedAs("255.255.255.255", "ADDRESS_RESERVED");
});

test("fc00::/7 unique-local is blocked", () => {
  blockedAs("fc00::1", "ADDRESS_UNIQUE_LOCAL");
  blockedAs("fd12:3456:789a::1", "ADDRESS_UNIQUE_LOCAL");
  blockedAs("FD00::1", "ADDRESS_UNIQUE_LOCAL");
});

test("fe80::/10 link-local is blocked, scope id included", () => {
  blockedAs("fe80::1", "ADDRESS_LINK_LOCAL");
  blockedAs("fe80::1%en0", "ADDRESS_LINK_LOCAL");
  blockedAs("febf::1", "ADDRESS_LINK_LOCAL");
  assert.equal(classifyAddress("fec0::1").ok, true);
});

test("an address the classifier cannot parse is not silently allowed", () => {
  for (const value of ["localhost", "010.0.0.1", "0x7f.0.0.1", "1.2.3", "1.2.3.4.5", "999.1.1.1", ""]) {
    const verdict = classifyAddress(value);
    assert.equal(verdict.ok, false, `${value} should not classify as a public address`);
  }
});

test("only https on the default port reaches the allow-list check", () => {
  assert.equal(classifyReferenceUrl(REFERENCE, TIKTOK).ok, true);
  const rejected: readonly (readonly [string, UrlGuardCode])[] = [
    ["http://www.tiktok.com/x", "URL_NOT_HTTPS"],
    ["ftp://www.tiktok.com/x", "URL_NOT_HTTPS"],
    ["file:///etc/passwd", "URL_NOT_HTTPS"],
    ["//www.tiktok.com/x", "URL_MALFORMED"],
    ["not a url", "URL_MALFORMED"],
    ["https://user:pass@www.tiktok.com/x", "URL_HAS_CREDENTIALS"],
    ["https://www.tiktok.com:8443/x", "URL_PORT_NOT_ALLOWED"],
  ];
  for (const [value, code] of rejected) {
    const verdict = classifyReferenceUrl(value, TIKTOK);
    assert.equal(verdict.ok, false, `${value} should be rejected`);
    if (!verdict.ok) assert.equal(verdict.code, code, `${value}: ${verdict.message}`);
  }
});

test("the host allow-list is a parameter, not a constant in the guard", () => {
  for (const host of TIKTOK) {
    assert.equal(classifyReferenceUrl(`https://${host}/x`, TIKTOK).ok, true, host);
  }
  // Same URL, empty allow-list: the guard has no opinion of its own about TikTok.
  assert.equal(classifyReferenceUrl(REFERENCE, []).ok, false);
  assert.equal(classifyReferenceUrl("https://example.invalid/x", ["example.invalid"]).ok, true);
});

test("a look-alike host does not pass the allow-list", () => {
  for (const value of [
    "https://evil.com/x",
    "https://tiktok.com.evil.com/x",
    "https://eviltiktok.com/x",
    "https://www.tiktok.com.evil.com/x",
    "https://127.0.0.1/x",
    "https://[::1]/x",
    "https://169.254.169.254/x",
  ]) {
    const verdict = classifyReferenceUrl(value, TIKTOK);
    assert.equal(verdict.ok, false, `${value} should be rejected`);
    if (!verdict.ok) assert.equal(verdict.code, "URL_HOST_NOT_ALLOWED", `${value}: ${verdict.message}`);
  }
});

test("an uppercase host and a trailing dot still match the allow-list", () => {
  assert.equal(classifyReferenceUrl("https://WWW.TikTok.com/x", TIKTOK).ok, true);
  assert.equal(classifyReferenceUrl("https://www.tiktok.com./x", TIKTOK).ok, true);
});

test("an allow-listed host that resolves publicly is accepted", async () => {
  const result = await checkReferenceUrl(REFERENCE, {
    allowedHosts: TIKTOK,
    lookup: resolvesTo("203.0.113.7", "2606:4700:4700::1111"),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.hostname, "www.tiktok.com");
  assert.deepEqual([...result.addresses], ["203.0.113.7", "2606:4700:4700::1111"]);
});

test("DNS rebinding is caught: an allow-listed host resolving inward is rejected", async () => {
  for (const address of ["127.0.0.1", "10.10.0.3", "169.254.169.254", "::1", "fd00::1", "192.168.1.1"]) {
    const result = await checkReferenceUrl(REFERENCE, { allowedHosts: TIKTOK, lookup: resolvesTo(address) });
    assert.equal(result.ok, false, `${address} should be rejected`);
  }
  // One bad address among good ones still fails: every record must be public.
  const mixed = await checkReferenceUrl(REFERENCE, {
    allowedHosts: TIKTOK,
    lookup: resolvesTo("203.0.113.7", "127.0.0.1"),
  });
  assert.equal(mixed.ok, false);
  if (!mixed.ok) assert.equal(mixed.code, "ADDRESS_LOOPBACK");
});

test("a host that does not resolve is refused rather than assumed public", async () => {
  const failing: AddressLookup = async () => { throw new Error("ENOTFOUND"); };
  const refused = await checkReferenceUrl(REFERENCE, { allowedHosts: TIKTOK, lookup: failing });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.code, "ADDRESS_NOT_RESOLVED");
  const empty = await checkReferenceUrl(REFERENCE, { allowedHosts: TIKTOK, lookup: resolvesTo() });
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.code, "ADDRESS_NOT_RESOLVED");
});

test("a URL rejected on its own terms never reaches the resolver", async () => {
  let resolved = 0;
  const counting: AddressLookup = async () => {
    resolved += 1;
    return [{ address: "203.0.113.7" }];
  };
  const result = await checkReferenceUrl("http://www.tiktok.com/x", { allowedHosts: TIKTOK, lookup: counting });
  assert.equal(result.ok, false);
  assert.equal(resolved, 0);
});
