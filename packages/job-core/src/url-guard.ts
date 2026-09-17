import { lookup } from "node:dns/promises";

/**
 * SSRF guard for caller-supplied reference URLs. Two halves, deliberately separated: a pure
 * classifier that needs no DNS and can therefore be exhaustively unit-tested, and an async checker
 * that takes the resolver as a parameter so tests never touch the network.
 *
 * The policy is deny-by-default. Anything we cannot parse is blocked, because an address we cannot
 * classify is exactly the address an attacker would pick.
 */
export type UrlGuardCode =
  | "URL_MALFORMED"
  | "URL_NOT_HTTPS"
  | "URL_HAS_CREDENTIALS"
  | "URL_PORT_NOT_ALLOWED"
  | "URL_HOST_NOT_ALLOWED"
  | "ADDRESS_UNSPECIFIED"
  | "ADDRESS_LOOPBACK"
  | "ADDRESS_PRIVATE"
  | "ADDRESS_LINK_LOCAL"
  | "ADDRESS_METADATA"
  | "ADDRESS_CARRIER_GRADE_NAT"
  | "ADDRESS_MULTICAST"
  | "ADDRESS_RESERVED"
  | "ADDRESS_UNIQUE_LOCAL"
  | "ADDRESS_UNSUPPORTED"
  | "ADDRESS_NOT_RESOLVED";

export type GuardVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: UrlGuardCode; readonly message: string };

export type UrlCheckResult =
  | { readonly ok: true; readonly hostname: string; readonly addresses: readonly string[] }
  | { readonly ok: false; readonly code: UrlGuardCode; readonly message: string };

/** Shape of `lookup(hostname, { all: true })`, injected so no test resolves a real name. */
export type AddressLookup = (hostname: string) => Promise<readonly { readonly address: string }[]>;

export type UrlGuardOptions = {
  /** Exact host names the deployment permits. Passed in, never hard-coded in this module. */
  readonly allowedHosts: readonly string[];
  readonly lookup?: AddressLookup;
};

const ALLOWED_PORTS: readonly string[] = [""];

const OK: GuardVerdict = { ok: true };

function blocked(code: UrlGuardCode, message: string): GuardVerdict {
  return { ok: false, code, message };
}

/** Strict dotted-quad only. `010.0.0.1` and `0x7f.1` are refused rather than guessed at. */
function parseIpv4(value: string): readonly number[] | undefined {
  const parts = value.split(".");
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/u.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    octets.push(octet);
  }
  return octets;
}

function parseIpv6(value: string): readonly number[] | undefined {
  let text = value.trim();
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  // A scope id (`fe80::1%en0`) addresses a local interface and never changes the classification.
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  if (!text.includes(":")) return undefined;
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const head = parseIpv6Groups(halves[0] ?? "");
  if (head === undefined) return undefined;
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const tail = parseIpv6Groups(halves[1] ?? "");
  if (tail === undefined) return undefined;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return undefined;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

function parseIpv6Groups(part: string): number[] | undefined {
  if (part === "") return [];
  const items = part.split(":");
  const groups: number[] = [];
  for (const [index, item] of items.entries()) {
    if (item.includes(".")) {
      // A trailing IPv4 literal is legal only as the last element (`::ffff:169.254.169.254`).
      if (index !== items.length - 1) return undefined;
      const octets = parseIpv4(item);
      if (octets === undefined) return undefined;
      groups.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/iu.test(item)) return undefined;
    groups.push(Number.parseInt(item, 16));
  }
  return groups;
}

function classifyIpv4(octets: readonly number[]): GuardVerdict {
  const first = octets[0]!;
  const second = octets[1]!;
  const text = octets.join(".");
  if (first === 0) return blocked("ADDRESS_UNSPECIFIED", `${text} is in 0.0.0.0/8`);
  if (first === 127) return blocked("ADDRESS_LOOPBACK", `${text} is in 127.0.0.0/8`);
  if (first === 10) return blocked("ADDRESS_PRIVATE", `${text} is in 10.0.0.0/8`);
  if (first === 172 && second >= 16 && second <= 31) return blocked("ADDRESS_PRIVATE", `${text} is in 172.16.0.0/12`);
  if (first === 192 && second === 168) return blocked("ADDRESS_PRIVATE", `${text} is in 192.168.0.0/16`);
  if (first === 169 && second === 254) {
    return text === "169.254.169.254"
      ? blocked("ADDRESS_METADATA", "169.254.169.254 is the cloud instance metadata address")
      : blocked("ADDRESS_LINK_LOCAL", `${text} is in 169.254.0.0/16`);
  }
  if (first === 100 && second >= 64 && second <= 127) {
    return blocked("ADDRESS_CARRIER_GRADE_NAT", `${text} is in 100.64.0.0/10`);
  }
  if (first >= 224 && first <= 239) return blocked("ADDRESS_MULTICAST", `${text} is in 224.0.0.0/4`);
  if (first >= 240) return blocked("ADDRESS_RESERVED", `${text} is in 240.0.0.0/4`);
  return OK;
}

function embeddedIpv4(groups: readonly number[]): readonly number[] {
  const high = groups[6]!;
  const low = groups[7]!;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

function classifyIpv6(groups: readonly number[]): GuardVerdict {
  const first = groups[0]!;
  const leadingZeros = groups.slice(0, 5).every((group) => group === 0);
  if (groups.every((group) => group === 0)) return blocked("ADDRESS_UNSPECIFIED", ":: is the unspecified address");
  if (leadingZeros && groups[5] === 0 && groups[6] === 0 && groups[7] === 1) {
    return blocked("ADDRESS_LOOPBACK", "::1 is the IPv6 loopback address");
  }
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d) and the NAT64 well-known prefix all
  // carry a v4 address in the low 32 bits. Classify what they actually reach, not their notation.
  if (leadingZeros && (groups[5] === 0xffff || groups[5] === 0)) {
    return classifyIpv4(embeddedIpv4(groups));
  }
  if (first === 0x0064 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) {
    return classifyIpv4(embeddedIpv4(groups));
  }
  if ((first & 0xfe00) === 0xfc00) return blocked("ADDRESS_UNIQUE_LOCAL", "address is in fc00::/7");
  if ((first & 0xffc0) === 0xfe80) return blocked("ADDRESS_LINK_LOCAL", "address is in fe80::/10");
  if ((first & 0xff00) === 0xff00) return blocked("ADDRESS_MULTICAST", "address is in ff00::/8");
  return OK;
}

/**
 * Classify one literal address. Pure: no DNS, no clock, no I/O — the whole range table is
 * unit-testable from a string.
 */
export function classifyAddress(value: string): GuardVerdict {
  const ipv4 = parseIpv4(value.trim());
  if (ipv4 !== undefined) return classifyIpv4(ipv4);
  const ipv6 = parseIpv6(value);
  if (ipv6 !== undefined) return classifyIpv6(ipv6);
  return blocked("ADDRESS_UNSUPPORTED", `${value} is not a literal IPv4 or IPv6 address`);
}

function normalizeHost(value: string): string {
  // A trailing dot is a legal FQDN form and would otherwise slip past an exact allow-list match.
  return value.toLowerCase().replace(/\.$/u, "");
}

/**
 * Classify the URL itself: scheme, credentials, port and host allow-list. Pure, so every rule can
 * be tested without resolving a name. The address check is a separate, later step.
 */
export function classifyReferenceUrl(value: string, allowedHosts: readonly string[]): GuardVerdict {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return blocked("URL_MALFORMED", "reference url is not an absolute URL");
  }
  if (url.protocol !== "https:") return blocked("URL_NOT_HTTPS", "reference url must use https");
  if (url.username !== "" || url.password !== "") {
    return blocked("URL_HAS_CREDENTIALS", "reference url must not carry credentials");
  }
  if (!ALLOWED_PORTS.includes(url.port)) {
    return blocked("URL_PORT_NOT_ALLOWED", "reference url must use the default https port");
  }
  const hostname = normalizeHost(url.hostname);
  const allowed = allowedHosts.map(normalizeHost);
  if (!allowed.includes(hostname)) {
    return blocked("URL_HOST_NOT_ALLOWED", "reference host is not in the allow-list");
  }
  // An allow-list entry could itself be an address literal; classify it rather than trusting it.
  const literal = classifyAddress(hostname);
  return literal.ok || literal.code === "ADDRESS_UNSUPPORTED" ? OK : literal;
}

const defaultLookup: AddressLookup = async (hostname) => lookup(hostname, { all: true });

/**
 * Full check: URL rules, then every resolved address. Call it again after each redirect — a
 * redirect is a fresh URL and inherits none of this verdict.
 */
export async function checkReferenceUrl(value: string, options: UrlGuardOptions): Promise<UrlCheckResult> {
  const verdict = classifyReferenceUrl(value, options.allowedHosts);
  if (!verdict.ok) return verdict;
  const hostname = normalizeHost(new URL(value).hostname);
  const resolve = options.lookup ?? defaultLookup;
  let records: readonly { readonly address: string }[];
  try {
    records = await resolve(hostname);
  } catch {
    return { ok: false, code: "ADDRESS_NOT_RESOLVED", message: `${hostname} did not resolve` };
  }
  if (records.length === 0) {
    return { ok: false, code: "ADDRESS_NOT_RESOLVED", message: `${hostname} resolved to no address` };
  }
  for (const record of records) {
    const address = classifyAddress(record.address);
    if (!address.ok) return address;
  }
  return { ok: true, hostname, addresses: records.map((record) => record.address) };
}
